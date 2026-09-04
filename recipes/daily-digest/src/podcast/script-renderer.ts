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
/**
 * A ChatFn that remembers WHY its last call returned null.
 *
 * `null` on its own tells a caller that it has to degrade, but not what to say
 * about it. Every degrading call site would otherwise have to log "the LLM
 * returned null", which is exactly the uninformative line that let the podcast
 * ship a raw material dump for two weeks. `makeScriptChat` fills this in; a
 * hand-rolled stub simply does not, and `failureReason` stays safe either way.
 */
export interface ChatFnWithReason extends ChatFn {
  lastFailure?: () => string;
}
/** The reason a ChatFn last returned null, in a form safe to put in a log line. */
export function failureReason(chat: ChatFn): string {
  const r = (chat as ChatFnWithReason).lastFailure?.();
  return r && r.trim() ? r : "reason not recorded by this chat function";
}
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

export function makeScriptChat(cfg: ScriptChatConfig): ChatFnWithReason {
  // The key is resolved ONCE, here, so every call site gets it whether or not it
  // remembered to pass one. link-enrich.ts historically passed nothing, which sent
  // `Bearer not-needed` and 401'd on every call from 2026-08-21 onward - the script
  // stage silently fell back to dumping raw grounded material for days.
  const apiKey = cfg.apiKey || Deno.env.get("CHAT_API_KEY") || "";
  const attempts = Math.max(1, cfg.attempts ?? 3);
  const label = cfg.label ?? "script chat";
  // The last give-up reason, so a caller that DEGRADES on null can name the
  // cause in its own log line. Cleared by a success, so a recovered call can
  // never make a healthy run look broken.
  let lastFailure = "";
  /** Log the give-up and remember it. Returns null so call sites read as one line. */
  const giveUp = (reason: string): null => {
    lastFailure = reason;
    console.warn(`[${label}] ${reason}`);
    return null;
  };
  const chat: ChatFnWithReason = async (system, user) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const last = attempt === attempts;
      try {
        const res = await fetch(`${cfg.chatApiBase}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: `${cfg.chatModel}${cfg.nothinkSuffix ?? ""}`,
            temperature: cfg.temperature ?? 0.5, // a touch of warmth for dialogue; 0 for triage
            max_tokens: cfg.maxTokens ?? 2200,
            messages: [{ role: "system", content: system }, {
              role: "user",
              content: user,
            }],
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 200_000),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          if (!isTransientStatus(res.status) || last) {
            return giveUp(
              `HTTP ${res.status} (giving up after ${attempt}): ${detail}`,
            );
          }
          console.warn(
            `[${label}] HTTP ${res.status} - retrying (${attempt}/${attempts}): ${detail}`,
          );
        } else {
          const d = await res.json();
          const content =
            (d.choices?.[0]?.message?.content as string | undefined)?.trim();
          if (content) {
            lastFailure = ""; // a good answer retires the previous complaint
            return content;
          }
          if (last) {
            return giveUp(`empty completion (giving up after ${attempt})`);
          }
          console.warn(
            `[${label}] empty completion - re-sampling (${attempt}/${attempts})`,
          );
        }
      } catch (err) {
        if (last) return giveUp(`failed (giving up after ${attempt}): ${err}`);
        console.warn(
          `[${label}] failed - retrying (${attempt}/${attempts}): ${err}`,
        );
      }
      await new Promise((r) =>
        setTimeout(r, (cfg.retryDelayMs ?? 2000) * attempt)
      );
    }
    return giveUp(`exhausted ${attempts} attempt(s) with no answer`);
  };
  chat.lastFailure = () => lastFailure || "no failure recorded";
  return chat;
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
  const m = item.synthesis.match(
    /^\[SOURCED\]\s*(.+?)(?:\s*\[Source[^\]]*\])?\s*$/im,
  );
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
    lines.push(
      `### ${it.title || headlineOf(it)}${
        incomplete ? "  (EMAIL-ONLY / incomplete)" : ""
      }`,
    );
    if (it.threadName) lines.push(`(ongoing thread: ${it.threadName})`);
    if (it.synthesis.trim()) lines.push(it.synthesis.trim());
    if (it.dive && it.dive.trim()) {
      lines.push(
        `DEEPER DIVE (our own overnight research — the newsletter only mentioned this):`,
      );
      lines.push(trimTagged(it.dive));
    }
  }
  return lines.join("\n");
}

// ── primary topic (for the [###]-daily-[topic] name) ─────────────────────────
export async function primaryTopic(
  input: EpisodeInput,
  chat: ChatFn,
): Promise<string> {
  const headlines = input.segments
    .flatMap((s) => s.items.map((it) => `- ${headlineOf(it)}`))
    .slice(0, 12)
    .join("\n");
  if (headlines) {
    const t = await chat(TOPIC_SYS, `HEADLINES:\n${headlines}`);
    if (t) return slugify(t.split("\n")[0]);
    // Not fatal - but the heuristic slug is a whole [SOURCED] sentence, which is
    // what makes a degraded episode's FILENAME read like prose. Say so, or the
    // only symptom is a filename nobody reads as a symptom.
    console.warn(
      `[script] topic naming fell back to the first headline (the slug will read ` +
        `like a sentence) - ${failureReason(chat)}`,
    );
  }
  // heuristic fallback: the headline of the first item.
  const first = input.segments[0]?.items[0];
  return slugify(first ? headlineOf(first) : "daily-digest");
}

// ── render ───────────────────────────────────────────────────────────────────
export async function renderEpisode(
  input: EpisodeInput,
  chat: ChatFn,
): Promise<Episode> {
  const topicSlug = await primaryTopic(input, chat);
  const name = `${pad3(input.episodeNumber)}-daily-${topicSlug}`;
  const title = `Daily #${pad3(input.episodeNumber)} — ${
    topicSlug.replace(/-/g, " ")
  }`;

  const segmentsBlock = input.segments.map(renderSegmentForPrompt).join("\n\n");
  const user =
    `DATE: ${input.date}\nEPISODE: ${title}\n\nSEGMENTS (one per label):\n\n${segmentsBlock}`;
  let script = await chat(SCRIPT_SYS, user);
  if (!script) {
    // The degraded episode still ships - that is deliberate, a raw material dump
    // is better than no episode. What was NOT deliberate is that it shipped in
    // SILENCE: episodes 076-089 carried this marker and nothing in the log said
    // an episode had degraded, so it went unnoticed for two weeks. Downstream this
    // block becomes the transcript prompt, which is how episode 083's 47,296-char
    // script reached podcast_creator's 5,000-token cap on 2026-08-29.
    script =
      `(script generation unavailable — grounded material follows)\n\n${segmentsBlock}`;
    console.warn(
      `[script] DEGRADED: episode ${
        pad3(input.episodeNumber)
      } "${title}" is shipping ` +
        `raw grounded material instead of a written script (${segmentsBlock.length} chars, ` +
        `which becomes the transcript prompt downstream). Stage: script generation ` +
        `(renderEpisode/S4a). Cause: ${failureReason(chat)}`,
    );
  }

  return { number: input.episodeNumber, topicSlug, name, title, script };
}
