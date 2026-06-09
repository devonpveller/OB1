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
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
}
export function makeScriptChat(cfg: ScriptChatConfig): ChatFn {
  return async (system, user) => {
    try {
      const res = await fetch(`${cfg.chatApiBase}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey ?? "not-needed"}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `${cfg.chatModel}${cfg.nothinkSuffix ?? ""}`,
          temperature: 0.5, // a touch of warmth for dialogue
          max_tokens: cfg.maxTokens ?? 2200,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 200_000),
      });
      if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
      const d = await res.json();
      return (d.choices?.[0]?.message?.content as string | undefined)?.trim() || null;
    } catch (err) {
      console.warn(`script chat failed: ${err}`);
      return null;
    }
  };
}

// ── prompts ──────────────────────────────────────────────────────────────────
const SCRIPT_SYS =
  `You are the writer for a short, daily, TWO-HOST morning podcast that reviews the listener's newsletter feeds. The hosts are HOST A and HOST B in a natural, friendly back-and-forth.

You are given SEGMENTS, one per newsletter label, each holding GROUNDED, already-fact-checked material. Lines are tagged:
  [SOURCED]/[INFERRED] — grounded to the article; this is the substance, narrate it confidently.
  [UNCERTAIN]          — PRELIMINARY follow-up research; narrate it tentatively ("preliminary research suggests… though it isn't settled").
  [GAP]                — an open question the article left unanswered; raise it as an open point of interest.

HARD RULES:
- Narrate ONLY what the material supports. NEVER add a fact, number, name, quote, or claim that is not in the material. If you're tempted to add color you can't ground, don't.
- Keep [UNCERTAIN] explicitly preliminary, and [GAP] explicitly open.
- If an item is marked email-only / incomplete, SAY so ("we only had the newsletter blurb on this one").
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

/** Compact, tagged view of a segment for the script prompt. */
function renderSegmentForPrompt(seg: Segment): string {
  const lines: string[] = [`## SEGMENT: ${seg.label}`];
  for (const it of seg.items) {
    lines.push(`### ${it.title || headlineOf(it)}${it.emailOnly ? "  (EMAIL-ONLY / incomplete)" : ""}`);
    if (it.threadName) lines.push(`(ongoing thread: ${it.threadName})`);
    lines.push(it.synthesis.trim());
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
