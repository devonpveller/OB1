/**
 * PodcastScriptRenderer (S4a / P3).
 *
 * Plan: documentation/daily-digests-autonomous-podcasts/PLAN-digest-podcast-services.md (S4)
 *
 * Turns the day's GROUNDED research (one article-mode synthesis per newsletter
 * link, grouped into segments per `brain/*` label) into a short two-host (D2)
 * conversational morning-show SCRIPT, one segment per label (D3). The script is
 * the dry-run artifact; audio (ON) is the separate S4b step.
 *
 * Grounding discipline carried into the audio (per D5/D11):
 *  - narrate ONLY what the grounded synthesis supports,
 *  - [UNCERTAIN] lines are spoken as PRELIMINARY ("preliminary research suggests…"),
 *  - [GAP] lines are spoken as open points of interest,
 *  - email-only / incomplete segments say so out loud.
 *
 * This currently lives in the recipe for the standalone dry-run; it moves into
 * the `openbrain-podcast` service at P5 (the renderer is backend-agnostic).
 */

// ── input/output shapes ──────────────────────────────────────────────────────
export interface SegmentItem {
  title: string;
  url: string;
  threadName?: string;
  /** Article-mode synthesis: tagged [SOURCED]/[INFERRED]/[UNCERTAIN]/[GAP] lines. */
  synthesis: string;
  emailOnly?: boolean; // link couldn't be enriched → narrate the caveat
  /**
   * Same-night GAP DIVE result: a full research synthesis that filled context the
   * email source lacked (tagged claim lines). Present ONLY when a dive returned
   * grounded material — an empty/absent dive leaves the item narrated as unfilled
   * (PLAN D0, honest-by-default). Narrated as "we dug deeper on this overnight".
   */
  dive?: string;
}
export interface Segment {
  label: string; // gmail label, e.g. "brain/ai/nate b jones"
  items: SegmentItem[];
}
export interface EpisodeInput {
  date: string; // ISO date for the cold open
  episodeNumber: number; // the [###]
  segments: Segment[];
}
export interface Episode {
  number: number;
  topicSlug: string;
  /** Filename stem: `[###]-daily-[primary-poi-topic]`. */
  name: string;
  /** Human title line. */
  title: string;
  script: string;
}

// ── LLM chat (system+user) ───────────────────────────────────────────────────
export type ChatFn = (system: string, user: string) => Promise<string | null>;
export interface ScriptChatConfig {
  chatApiBase: string;
  chatModel: string;
  nothinkSuffix?: string;
  /** LiteLLM virtual key. Falls back to CHAT_API_KEY from the environment.
   *  The gateway has REQUIRED an sk- key since the J.1 flip (2026-08-21), so a
   *  missing key is a guaranteed 401 - never a soft default. */
  apiKey?: string;
  /** Attempts for a TRANSIENT failure (network/timeout, 429, 5xx, empty 200).
   *  Default 3. A 4xx that is not 429 is a config fault and is NOT retried. */
  attempts?: number;
  /** Base backoff between attempts (ms), multiplied by the attempt number.
   *  Default 2000. Tests set 0. */
  retryDelayMs?: number;
  /** Name for this caller in the runner log, so a retry line says which stage. */
  label?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Hard ceiling for the budget escalation that a truncated completion triggers.
   *  Default 2x maxTokens - deliberately modest, because the CLOCK is the binding
   *  constraint, not the context window: measured throughput is 28.9-60.4 tok/s,
   *  so a 4x ceiling produced requests that could not finish inside any sane
   *  timeout. This bounds cost and latency, NOT context: the 27b lane
   *  is 98,304 tokens (LLAMA_SWAP_QWEN36_27B_CTX_SIZE 196,608 / N_PARALLEL 2), so
   *  even a 22k-token prompt leaves ample room. */
  maxTokensCeiling?: number;
  /** Sampling temperature. Default 0.5 (dialogue). Use 0 for deterministic
   *  classification/triage — temperature 0.5 makes gap triage flaky (can drop to
   *  zero dives on a given input). */
  temperature?: number;
}
/** Transient = worth re-sampling: network/timeout, 429, 5xx, or an empty 200.
 *  A 401/403/400 is a CONFIGURATION fault; retrying it just burns the clock. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function makeScriptChat(cfg: ScriptChatConfig): ChatFn {
  // The key is resolved ONCE, here, so every call site gets it whether or not it
  // remembered to pass one. link-enrich.ts historically passed nothing, which sent
  // `Bearer not-needed` and 401'd on every call from 2026-08-21 onward - the script
  // stage silently fell back to dumping raw grounded material for days.
  const apiKey = cfg.apiKey || Deno.env.get("CHAT_API_KEY") || "";
  const attempts = Math.max(1, cfg.attempts ?? 3);
  const label = cfg.label ?? "script chat";
  // The budget ESCALATES on truncation (see the finish_reason branch below), so
  // it is per-call state, not a constant.
  const baseTokens = cfg.maxTokens ?? 2200;
  const ceiling = Math.max(baseTokens, cfg.maxTokensCeiling ?? baseTokens * 2);
  let budget = baseTokens;
  // Best truncated text seen so far. Escalation must never be WORSE than not
  // escalating: a bigger budget takes proportionally longer, so a later attempt
  // can time out (a throw) after we already had usable-but-cut-off text - and
  // returning null there degrades the episode to a raw grounded-material dump.
  // Measured 2026-09-04 with a control: escalate -> null, don't escalate ->
  // usable text. So the text is KEPT and returned instead of null.
  let bestTruncated: string | null = null;
  // Cut-off text becomes the ON transcript prompt downstream, and an unterminated
  // segment is what aborted the 2026-08-29 episode. Trimming back to the last
  // sentence that actually ends removes that hazard for free; if nothing ends
  // cleanly the original is returned rather than emptying the script.
  // NB: matched with a regex rather than lastIndexOf on an escape sequence - the
  // escaped form of that literal did not survive the edit that introduced it,
  // which is the same backslash-in-transit failure this repo keeps paying for.
  const toLastCompleteSentence = (t: string): string => {
    const m = t.match(/^[\s\S]*[.!?](?=\s|$)/);
    const trimmed = m ? m[0].trimEnd() : "";
    return trimmed.length > 0 ? trimmed : t;
  };
  const giveUp = (why: string): string | null => {
    if (bestTruncated) {
      console.warn(
        `[${label}] ${why} - returning the earlier TRUNCATED text rather than nothing; ` +
          `this episode is INCOMPLETE`,
      );
      return toLastCompleteSentence(bestTruncated);
    }
    return null;
  };
  // A doubled budget needs a doubled clock. The timeout is stated for the BASE
  // budget and scales with it; leaving it fixed meant escalated attempts could
  // not physically finish (measured throughput 28.9-60.4 tok/s against a fixed
  // 200s: 12k tokens overran in every sample), so escalation burned its attempts
  // on requests that were never going to complete.
  const baseTimeout = cfg.timeoutMs ?? 200_000;
  const timeoutFor = (b: number) => Math.round(baseTimeout * (b / baseTokens));
  return async (system, user) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const last = attempt === attempts;
      try {
        const res = await fetch(`${cfg.chatApiBase}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `${cfg.chatModel}${cfg.nothinkSuffix ?? ""}`,
            temperature: cfg.temperature ?? 0.5, // a touch of warmth for dialogue; 0 for triage
            max_tokens: budget,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(timeoutFor(budget)),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          if (!isTransientStatus(res.status) || last) {
            console.warn(`[${label}] HTTP ${res.status} (giving up after ${attempt}): ${detail}`);
            return giveUp(`HTTP ${res.status} after ${attempt} attempt(s)`);
          }
          console.warn(`[${label}] HTTP ${res.status} - retrying (${attempt}/${attempts}): ${detail}`);
        } else {
          const d = await res.json();
          const choice = d.choices?.[0];
          const content = (choice?.message?.content as string | undefined)?.trim();
          // TRUNCATION. finish_reason "length" = the model hit the budget and
          // stopped mid-sentence. The text READS fine, so nothing downstream can
          // tell it apart from a finished script - which is how a cut-off episode
          // shipped: measured 2026-09-04, completion_tokens == max_tokens == 2200
          // exactly, ending "...It also supports", 4 of 7 segments, no sign-off
          // (SCRIPT_SYS mandates one). Re-sampling at the SAME budget just
          // truncates again, so the budget doubles instead.
          if (content && choice?.finish_reason === "length") {
            bestTruncated = content; // keep it: a later timeout must not cost us this
            if (budget < ceiling && !last) {
              const next = Math.min(ceiling, budget * 2);
              console.warn(
                `[${label}] TRUNCATED at max_tokens=${budget} - re-running with ${next} (${attempt}/${attempts})`,
              );
              budget = next;
              continue; // not a transient fault; no backoff to serve
            }
            // Ceiling reached. Returning the cut-off text is the LEAST-BAD option -
            // null degrades to dumping raw grounded material, which is worse - but
            // it must never be silent again.
            console.warn(
              `[${label}] TRUNCATED at max_tokens=${budget} with the ceiling (${ceiling}) reached - ` +
                `returning CUT-OFF text: this episode is INCOMPLETE (raise SCRIPT_MAX_TOKENS)`,
            );
            return toLastCompleteSentence(content);
          }
          if (content) return content;
          if (last) {
            console.warn(`[${label}] empty completion (giving up after ${attempt})`);
            return giveUp(`empty completion after ${attempt} attempt(s)`);
          }
          console.warn(`[${label}] empty completion - re-sampling (${attempt}/${attempts})`);
        }
      } catch (err) {
        if (last) {
          console.warn(`[${label}] failed (giving up after ${attempt}): ${err}`);
          return giveUp(`failed after ${attempt} attempt(s): ${err}`);
        }
        console.warn(`[${label}] failed - retrying (${attempt}/${attempts}): ${err}`);
      }
      await new Promise((r) => setTimeout(r, (cfg.retryDelayMs ?? 2000) * attempt));
    }
    return giveUp("attempts exhausted");
  };
}
/** One attempt's outcome: `done` ends the loop (even with a null value - the
 *  step decided), `done:false` means "failed, try again". */
export type RetryOutcome<T> = { done: true; value: T | null } | { done: false };

/** Run `step` until it reports done or `attempts` is exhausted; a throw counts as
 *  a failed attempt and is passed to `onError`.
 *
 *  WHY THIS IS EXPORTED AND NOT INLINE: the Open Notebook audio retry lives in
 *  generateAudio() inside link-enrich.ts, which is a top-level script with
 *  import-time side effects and therefore has NO test harness - so the anchor's
 *  "a failed ON job is retried once" criterion was UNVERIFIABLE in test
 *  (2026-09-04). The POLICY lives here where it can be proven; generateAudio
 *  supplies the ON-specific body. The done/not-done split keeps that body's
 *  original semantics exactly: a completed job returns its episode even when the
 *  lookup yields null, and only a NON-completed job or a throw re-submits (a
 *  blind "retry while null" would re-run a minutes-long audio job whenever ON's
 *  listing merely lagged). */
export async function retryUntil<T>(
  attempts: number,
  step: (attempt: number, isLast: boolean) => Promise<RetryOutcome<T>>,
  onError?: (err: unknown, attempt: number, isLast: boolean) => void,
): Promise<T | null> {
  const total = Math.max(1, attempts);
  for (let attempt = 1; attempt <= total; attempt++) {
    const isLast = attempt === total;
    try {
      const outcome = await step(attempt, isLast);
      if (outcome.done) return outcome.value;
    } catch (err) {
      onError?.(err, attempt, isLast);
    }
  }
  return null;
}

// ── prompts ──────────────────────────────────────────────────────────────────
/** Special segment label: carried-over dives that resolved overnight. */
export const FOLLOWUPS_LABEL = "follow-ups from yesterday";

const SCRIPT_SYS =
  `You are the writer for a short, daily, TWO-HOST morning podcast that reviews the listener's newsletter feeds. The hosts are HOST A and HOST B in a natural, friendly back-and-forth.

You are given SEGMENTS, one per newsletter label, each holding GROUNDED, already-fact-checked material. Lines are tagged:
  [SOURCED]/[INFERRED] — grounded to the article; this is the substance, narrate it confidently.
  [UNCERTAIN]          — PRELIMINARY follow-up research; narrate it tentatively ("preliminary research suggests… though it isn't settled").
  [GAP]                — an open question the article left unanswered; raise it as an open point of interest.

Some items ALSO carry a "DEEPER DIVE" block — our own overnight web research into context the newsletter itself didn't give. Weave it in as exactly that: "the newsletter just mentioned this, so we went and looked it up — here's what we found." It follows the same tag rules.

A segment titled "${FOLLOWUPS_LABEL}" holds questions we flagged as unanswered on a PREVIOUS day and have now researched. Narrate it as a callback: "yesterday we flagged X — here's what we dug up." Same tag rules.

HARD RULES:
- Narrate ONLY what the material supports. NEVER add a fact, number, name, quote, or claim that is not in the material. If you're tempted to add color you can't ground, don't.
- Keep [UNCERTAIN] explicitly preliminary, and [GAP] explicitly open.
- If an item is marked email-only / incomplete AND has no DEEPER DIVE block, SAY so ("we only had the newsletter blurb on this one"). If it has a DEEPER DIVE, say the newsletter only mentioned it but our own research filled it in.
- Do NOT claim a gap was answered when it wasn't: an item with an open [GAP] and no DEEPER DIVE stays an open question.
- One segment per label, in the order given, with smooth host-to-host and segment-to-segment transitions.
- Cold open: the date + a one-line hello. Sign-off: a short, warm close.
- Tight and listenable — no padding, no invented banter about facts.

Output ONLY the spoken script, using "HOST A:" and "HOST B:" speaker labels.`;

const TOPIC_SYS =
  `You name the single PRIMARY topic of a daily news podcast from its segment headlines. Reply with ONLY a short topic phrase of 2-5 words, lowercase, no punctuation (it becomes a filename slug). Pick the most prominent/important theme of the day.`;

// ── helpers ──────────────────────────────────────────────────────────────────
export function slugify(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "daily-digest";
}
export function pad3(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(3, "0");
}

/** First [SOURCED] line of an item's synthesis — its headline thesis. */
function headlineOf(item: SegmentItem): string {
  const m = item.synthesis.match(/^\[SOURCED\]\s*(.+?)(?:\s*\[Source[^\]]*\])?\s*$/im);
  return (m?.[1] ?? item.title ?? "").trim();
}

/** Keep only the first N tagged claim lines of a synthesis (prompt proportion). */
function trimTagged(synthesis: string, max = 6): string {
  const kept: string[] = [];
  for (const raw of String(synthesis || "").split("\n")) {
    const line = raw.trim();
    if (/^\[(SOURCED|INFERRED|UNCERTAIN|GAP)\]/i.test(line)) {
      kept.push(line);
      if (kept.length >= max) break;
    }
  }
  return kept.join("\n");
}

/** Compact, tagged view of a segment for the script prompt. */
function renderSegmentForPrompt(seg: Segment): string {
  const lines: string[] = [`## SEGMENT: ${seg.label}`];
  for (const it of seg.items) {
    // An email-only item WITH a dive is no longer just a blurb — mark it so the
    // hosts say "the newsletter only mentioned it, but our own digging filled it in".
    const incomplete = it.emailOnly && !it.dive;
    lines.push(`### ${it.title || headlineOf(it)}${incomplete ? "  (EMAIL-ONLY / incomplete)" : ""}`);
    if (it.threadName) lines.push(`(ongoing thread: ${it.threadName})`);
    if (it.synthesis.trim()) lines.push(it.synthesis.trim());
    if (it.dive && it.dive.trim()) {
      lines.push(`DEEPER DIVE (our own overnight research — the newsletter only mentioned this):`);
      lines.push(trimTagged(it.dive));
    }
  }
  return lines.join("\n");
}

// ── primary topic (for the [###]-daily-[topic] name) ─────────────────────────
export async function primaryTopic(input: EpisodeInput, chat: ChatFn): Promise<string> {
  const headlines = input.segments
    .flatMap((s) => s.items.map((it) => `- ${headlineOf(it)}`))
    .slice(0, 12)
    .join("\n");
  if (headlines) {
    const t = await chat(TOPIC_SYS, `HEADLINES:\n${headlines}`);
    if (t) return slugify(t.split("\n")[0]);
  }
  // heuristic fallback: the headline of the first item.
  const first = input.segments[0]?.items[0];
  return slugify(first ? headlineOf(first) : "daily-digest");
}

// ── render ───────────────────────────────────────────────────────────────────
export async function renderEpisode(input: EpisodeInput, chat: ChatFn): Promise<Episode> {
  const topicSlug = await primaryTopic(input, chat);
  const name = `${pad3(input.episodeNumber)}-daily-${topicSlug}`;
  const title = `Daily #${pad3(input.episodeNumber)} — ${topicSlug.replace(/-/g, " ")}`;

  const segmentsBlock = input.segments.map(renderSegmentForPrompt).join("\n\n");
  const user =
    `DATE: ${input.date}\nEPISODE: ${title}\n\nSEGMENTS (one per label):\n\n${segmentsBlock}`;
  const script = (await chat(SCRIPT_SYS, user)) ??
    `(script generation unavailable — grounded material follows)\n\n${segmentsBlock}`;

  return { number: input.episodeNumber, topicSlug, name, title, script };
}
