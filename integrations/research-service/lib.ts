/**
 * Pure helpers for the research service (no DB, no network) — the testable core
 * of the harness: HTML→text extraction, the OD-5 reuse decision, the OD-6
 * backstop, citation parsing, and the reuse metric.
 *
 * Governing spec: documentation/implementation-guide/research-engine-for-OB/
 *   GROUNDING-MODEL.md + PLAN-research-engine.md §6 + decisions OD-5/OD-6.
 */

// ── HTML → text (per-source extraction; single pages, not whole sites) ──────
const _ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => _ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip a fetched HTML document down to readable body text. */
export function extractTextFromHtml(html: string): string {
  let s = String(html || "");
  // Drop non-content elements wholesale.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(nav|header|footer|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block elements → newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");           // remaining tags
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ── Freshness (OD-5; windows fast 7 / medium 180 / slow 1095) ───────────────
export function revalidateWindow(volatility?: string | null, revalidateDays?: number | null): number {
  if (revalidateDays != null && Number.isFinite(revalidateDays)) return revalidateDays;
  switch (volatility) {
    case "fast": return 7;
    case "medium": return 180;
    case "slow": return 1095;
    default: return 180;
  }
}

export function isStale(researchedOn: string | Date | null | undefined,
                        volatility: string | null | undefined,
                        revalidateDays: number | null | undefined,
                        now: Date): boolean {
  if (!researchedOn) return true;
  const ro = researchedOn instanceof Date ? researchedOn : new Date(researchedOn);
  if (isNaN(ro.getTime())) return true;
  const due = ro.getTime() + revalidateWindow(volatility, revalidateDays) * 86400000;
  return now.getTime() > due;
}

// ── OD-5 reuse decision ─────────────────────────────────────────────────────
export interface ClaimReuseInput {
  confidence: number;
  contradicted: boolean;
  hasStrongEdge: boolean;   // states OR corroborates present
  grounded: boolean;        // terminates in a primary source
  researchedOn: string | Date | null;
  volatility: string | null;
  revalidateDays: number | null;
}
export type ReuseVerdict = "reuse" | "revalidate" | "research";

/**
 * OD-5 "strict + stale":
 *  - reuse as-is:  grounded, strong edge (states/corroborated), fresh, >= floor
 *  - revalidate:   grounded but inferred-only OR stale (cheap re-confirm)
 *  - research:     ungrounded / contradicted / below floor (full gather)
 */
export function decideReuse(c: ClaimReuseInput, floor: number, now: Date): ReuseVerdict {
  if (!c.grounded || c.contradicted || c.confidence < floor) return "research";
  const stale = isStale(c.researchedOn, c.volatility, c.revalidateDays, now);
  if (c.hasStrongEdge && !stale) return "reuse";
  return "revalidate";
}

// ── OD-6 adaptive backstop (cannot hallucinate; degrades to honest gaps) ─────
// `sources` and `timeouts` are tracked SEPARATELY and capped by DIFFERENT
// variables: `maxSources` (MAX_FETCH) is the source-YIELD budget — how many
// pages we actually retrieved — while `maxTimeouts` (MAX_FETCH_TIMEOUTS) bounds
// WASTED attempts that timed out (a flaky Tor circuit). Conflating the two (the
// old single `fetches` counter) meant a run that timed out 40 times reported the
// same "max_fetch" as one that fetched 40 real sources. They are different
// signals and now stop for different, nameable reasons.
export interface BackstopState {
  elapsedMs: number;
  maxMs: number;
  sources: number;       // successfully fetched pages (the yield)
  maxSources: number;    // MAX_FETCH
  timeouts: number;      // fetch attempts that timed out (wasted)
  maxTimeouts: number;   // MAX_FETCH_TIMEOUTS (0 disables this ceiling)
  openGaps: number;
}
export interface BackstopDecision { stop: boolean; reason: "complete" | "wall_time" | "max_fetch" | "max_timeouts" | "continue"; }

export function backstopDecision(s: BackstopState): BackstopDecision {
  if (s.openGaps <= 0) return { stop: true, reason: "complete" };
  if (s.elapsedMs >= s.maxMs) return { stop: true, reason: "wall_time" };
  if (s.sources >= s.maxSources) return { stop: true, reason: "max_fetch" };
  if (s.maxTimeouts > 0 && s.timeouts >= s.maxTimeouts) return { stop: true, reason: "max_timeouts" };
  return { stop: false, reason: "continue" };
}

// ── Reuse metric (P4.5) ─────────────────────────────────────────────────────
export interface ReuseMetric {
  claims_reused: number;
  claims_freshly_gathered: number;
  gap_ratio: number;        // open gaps / total needs (0 = fully covered)
}
export function reuseMetric(reused: number, freshlyGathered: number, openGaps: number): ReuseMetric {
  const total = reused + freshlyGathered + openGaps;
  return {
    claims_reused: reused,
    claims_freshly_gathered: freshlyGathered,
    gap_ratio: total > 0 ? openGaps / total : 0,
  };
}

// ── Citation parsing ([Source N]) — cited-only subset (GROUNDING-MODEL §6.3) ─
// Tolerant of every shape the model emits: [Source 1], [Source 1, 2],
// [Sources 1 and 2], [Source 1, Source 2, Source 4] — extract every number
// inside any [Source...] bracket.
const CITE_BRACKET_RE = /\[Sources?\b[^\]]*\]/gi;
export function citedNumbers(synthesis: string): number[] {
  const nums = new Set<number>();
  for (const bracket of String(synthesis || "").match(CITE_BRACKET_RE) || []) {
    for (const d of bracket.match(/\d+/g) || []) {
      const n = parseInt(d, 10);
      if (n > 0) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/** Keep only the sources the synthesis actually cited ([Source N] → sources[N-1]). */
export function citedSubset<T>(synthesis: string, sources: T[]): T[] {
  return citedNumbers(synthesis)
    .map((n) => sources[n - 1])
    .filter((x): x is T => x != null);
}

/**
 * Build the cited-only source subset AND renumber the synthesis's `[Source N]`
 * citations to match it, so the curator (which resolves `[Source N]` →
 * source_ids[N-1]) stays aligned. Citations indexing the FULL staged list would
 * otherwise point past the end of the compacted cited list and drop edges.
 *
 * Mechanical renumber only — claim TEXT is untouched, so the synthesis is still
 * stored "verbatim" in the sense that matters (no re-synthesis/truncation); the
 * citation indices simply reference the sources that are actually stored.
 * Unresolvable citations (a number with no staged source) are dropped.
 */
export function buildCitedAndRenumber<T>(synthesis: string, sources: T[]): { synthesis: string; cited: T[] } {
  const oldNums = citedNumbers(synthesis).filter((n) => sources[n - 1] != null);
  const map = new Map<number, number>();
  oldNums.forEach((n, i) => map.set(n, i + 1));
  const cited = oldNums.map((n) => sources[n - 1]);
  const renum = String(synthesis || "").replace(CITE_BRACKET_RE, (bracket) => {
    const mapped = (bracket.match(/\d+/g) || [])
      .map((d) => map.get(parseInt(d, 10)))
      .filter((x): x is number => x != null);
    return mapped.length ? `[Source ${mapped.join(", ")}]` : "";
  });
  return { synthesis: renum, cited };
}

// ── Repo source selection (REPO-SOURCES-WIRING §4) ──────────────────────────
/**
 * Deterministic, bounded selection of a repo's KNOWLEDGE files for source
 * ingestion — docs + structural manifests only, never wholesale code. Priority
 * buckets (highest first) keep the most probative files inside `maxFiles`:
 * root README* → .gitmodules → root build manifests (*.sln,
 * Directory.Build.props, *.csproj) → docs/**\/*.md → other root *.md (LICENSE
 * excluded) → depth-1 README* → shallow *.csproj (≤2 deep). Candidates beyond
 * the cap are returned as `skipped` — logged by the caller, never silent.
 */
export interface RepoFileSelection { selected: string[]; skipped: string[] }

export function selectRepoFiles(paths: string[], maxFiles = 40): RepoFileSelection {
  const depth = (p: string) => p.split("/").length - 1;
  const base = (p: string) => p.split("/").pop() || p;
  const lb = (p: string) => base(p).toLowerCase();
  const lp = (p: string) => p.toLowerCase();
  const buckets: Array<(p: string) => boolean> = [
    (p) => depth(p) === 0 && lb(p).startsWith("readme"),
    (p) => depth(p) === 0 && base(p) === ".gitmodules",
    (p) => depth(p) === 0 && (lp(p).endsWith(".sln") || base(p) === "Directory.Build.props"
                              || lp(p).endsWith(".csproj")),
    (p) => lp(p).startsWith("docs/") && lp(p).endsWith(".md"),
    (p) => depth(p) === 0 && lp(p).endsWith(".md")
           && !lb(p).startsWith("license") && !lb(p).startsWith("readme"),
    (p) => depth(p) === 1 && lb(p).startsWith("readme"),
    (p) => depth(p) >= 1 && depth(p) <= 2 && lp(p).endsWith(".csproj"),
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of buckets) {
    for (const p of paths) {
      if (!seen.has(p) && match(p)) { seen.add(p); candidates.push(p); }
    }
  }
  return { selected: candidates.slice(0, maxFiles), skipped: candidates.slice(maxFiles) };
}

// ---------------------------------------------------------------------------
// Result rendering (single source of truth).
//
// The chat-facing markdown is rendered HERE, server-side, and stored on the job
// as `result.rendered`. Both consumers use it verbatim: the OWUI async callback
// posts it into the chat, and the thin OWUI tool returns it on the synchronous
// path. Rendering used to live in the tool (deep_research.py `_render`); with an
// async callback the tool is long gone by the time a job finishes, so a second
// renderer would have had to exist in the service anyway — and two renderers
// drift. The Python `_render` survives only as a fallback for jobs cached before
// this field existed.
// ---------------------------------------------------------------------------

export interface RenderableResult {
  synthesis?: string | null;
  /** Templated human-facing report (templates.ts, 2026-08-22). When present it
   *  is the chat-facing body; the tagged synthesis remains the machine-truth
   *  and the fallback. Same [Source N] numbers as the synthesis. */
  prose?: string | null;
  /** templates.ts id of the report template that rendered `prose`. */
  report_type?: string | null;
  cited_sources?: Array<{ title?: string | null; url?: string | null }> | null;
  gaps?: string[] | null;
  backstop?: string | null;
  reuse_ratio?: number | null;
}

export function renderResult(result: RenderableResult): string {
  // The templated report is the human-facing body (operator request 2026-08-22:
  // the raw tagged claim list was unusable as a deliverable). Citations use the
  // same numbers, so the Sources list below still resolves. The tagged
  // synthesis remains the fallback for pre-template jobs / render failures.
  const body = (result.prose || "").trim() || (result.synthesis || "").trim() || "(no synthesis produced)";
  const parts: string[] = [body];

  const cited = result.cited_sources ?? [];
  if (cited.length) {
    const lines = ["\n\n---\n\n**Sources** (only those the synthesis cited):"];
    cited.forEach((s, i) => {
      const title = s?.title || s?.url || `Source ${i + 1}`;
      lines.push(s?.url ? `${i + 1}. [${title}](${s.url})` : `${i + 1}. ${title}`);
    });
    parts.push(lines.join("\n"));
  }

  const gaps = result.gaps ?? [];
  const backstop = result.backstop;
  const incomplete = gaps.length > 0 || Boolean(backstop && backstop !== "complete");

  if (gaps.length) {
    parts.push(
      "\n\n**Open gaps** (NOT grounded — recorded for a future run):\n" +
        gaps.map((g) => `- ${g}`).join("\n"),
    );
  }

  // Directive to the reading model — keeps it from "finishing" with fabricated
  // content. On the async path this text is what lands in the chat transcript,
  // so it is still in context on the user's next turn (it is not addressed to a
  // model that is mid-turn). The engine is the only grounded path; gaps are
  // pursued by calling it again, never filled from the model's own knowledge.
  if (incomplete) {
    const reason = backstop && backstop !== "complete" ? `stopped early (${backstop})` : "left gaps open";
    parts.push(
      `\n\n> \u26a0 This research is grounded but INCOMPLETE — it ${reason}. The open ` +
        `gaps above are not answered by any source. Do NOT fill them from your own ` +
        `knowledge or other web/fetch tools (that fabricates). To pursue a gap, call ` +
        `deep_research again with a query targeting it; otherwise present the gaps as ` +
        `open unknowns.`,
    );
  }

  const foot: string[] = [];
  if (result.reuse_ratio !== null && result.reuse_ratio !== undefined) {
    foot.push(`coverage ${Math.round(Number(result.reuse_ratio) * 100)}%`);
  }
  if (backstop && backstop !== "complete") foot.push(`stopped early: ${backstop}`);
  if (foot.length) parts.push(`\n\n_— ${foot.join(" \u00b7 ")}_`);

  return parts.join("\n");
}

// ── Curator outcome (incident 2026-08-31) ───────────────────────────────────
// runResearch never throws when the curator dies; it records the failure inside
// its `curator` result. The job row was then written status='done', error=NULL —
// indistinguishable from a run that landed — which is how 244 runs lost their
// entire output unnoticed between 2026-06-19 and 2026-08-31. This is the single
// decision that turns the curator's report into the two columns a reader of
// research_jobs actually looks at, kept pure so it is tested rather than
// inspected.
export type CuratorState = "filed" | "FAILED" | "partial" | "skipped";
export interface CuratorOutcome {
  /** research_jobs.status. 'error' when the output was NOT filed at all. */
  status: "done" | "error";
  /** research_jobs.error. NULL ONLY when nothing was lost. */
  error: string | null;
  /** The raw cause, for the "Not saved to Open Brain" banner. */
  reason: string | null;
  /** Label for progress.message — 'backstop=complete' never meant 'it landed'. */
  state: CuratorState;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function classifyCuratorOutcome(
  curator: Record<string, unknown> | null | undefined,
): CuratorOutcome {
  const failure = nonEmpty(curator?.error);
  if (failure) {
    return {
      status: "error",
      error: `curator: the research completed but was NOT filed into Open Brain - ${failure}`,
      reason: failure,
      state: "FAILED",
    };
  }
  const partial = nonEmpty(curator?.claims_error);
  if (partial) {
    // The sources DID land, so the run is done — but "done, error NULL" would
    // again hide a real loss: this research is searchable and not reasoned over.
    return {
      status: "done",
      error: `curator PARTIAL: sources filed, grounded claims NOT written - ${partial}`,
      reason: partial,
      state: "partial",
    };
  }
  // No curator report at all = there was nothing to promote (dry run, or a run
  // with no cited sources and no reuse). Honest, but not a success either.
  if (!curator) return { status: "done", error: null, reason: null, state: "skipped" };
  return { status: "done", error: null, reason: null, state: "filed" };
}

// ---------------------------------------------------------------------------
// Fetch-egress policy (pure; wired in index.ts fetchClient).
//
// Until 2026-09-05, a configured proxy whose client could not be built (in
// practice: the --unstable-net flag missing from the run command) logged ONE
// warning line and silently fell back to DIRECT egress for every page fetch —
// research traffic left the VPN with nothing but a log line to say so. That is
// a deploy-config bug wearing a runtime coat, and the fix is to refuse: a
// non-empty FETCH_PROXY_URL is a privacy promise, and this service degrades to
// honest gaps rather than break promises. "direct" is reachable ONLY by the
// operator explicitly setting FETCH_PROXY_URL="".
// (Per-request proxy downtime is not this: a built client whose upstream is
// down fails per-fetch and the harness already degrades honestly.)
// ---------------------------------------------------------------------------

export type ProxyPolicy = "proxy" | "direct" | "refuse";

export function proxyPolicy(url: string, clientBuilt: boolean): ProxyPolicy {
  if (!url.trim()) return "direct";
  return clientBuilt ? "proxy" : "refuse";
}

// ---------------------------------------------------------------------------
// Curator call policy (pure; wired in index.ts delegateToCurator).
//
// Until 2026-09-06 the curator delegation was the ONE fetch in this service
// with no signal and no retry: fetchPage and ghJson both carry
// FETCH_TIMEOUT_MS, delegateToCurator carried nothing. With
// RESEARCH_MAX_CONCURRENCY=1 a curator that accepted the socket and never
// answered held the single research slot forever, and a curator that was
// restarting (one ECONNREFUSED) failed the whole run after the research had
// already been done. This section is the policy, kept pure so it can be
// tested with an injected fetch and no network:
//
//   shouldRetryCuratorError  - RETRY only CONNECT-PHASE failures: Deno's
//                              `client error (Connect)` family (refused,
//                              reset/closed during connect, host/network
//                              unreachable) and the Node-style codes that can
//                              only mean "never connected" (ECONNREFUSED,
//                              EHOSTUNREACH, ENETUNREACH, EAI_AGAIN). Those
//                              are the only failures where the package
//                              certainly never reached a curator. NOT a
//                              failure after the request was sent
//                              (`(SendRequest)`, "connection closed before
//                              message completed", a body-read error): the
//                              curator may have received - and persisted -
//                              the package, so that fails ONCE, loudly,
//                              saying so. NOT our own per-attempt timeout
//                              (AbortError / TimeoutError): same reason.
//                              NOT an HTTP answer of any status: that is the
//                              curator's VERDICT (a 4xx/5xx JSON body is a
//                              decision, not a transport failure).
//   The body read is INSIDE the same per-attempt budget: a 2xx whose body
//                              stalls past CURATOR_TIMEOUT_MS is a timeout
//                              (CuratorTimeoutError), never a success. A
//                              2xx whose body is not a JSON object (empty,
//                              truncated, HTML) is NOT filed either: "filed"
//                              means the curator said so, in JSON. A
//                              non-JSON 4xx/5xx keeps the old
//                              `curator <status>: {}` shape.
//   curatorBackoffMs         - deterministic doubling, base 2 s, cap 10 s. No
//                              jitter: one caller (MAX_CONCURRENCY=1), and a
//                              bound you can state beats a bound you can
//                              only estimate.
//   curatorRefusedWorstCaseMs- the refused-curator bound: attempts x the time
//                              a connect takes to fail + the backoffs between
//                              them. A refused connect fails in milliseconds
//                              (measured 4-5 ms on the bridge), so with the
//                              defaults (CURATOR_RETRIES=3) that is ~6 s.
//   curatorTimeoutWorstCaseMs- the paused/hung-curator bound: EXACTLY ONE
//                              CURATOR_TIMEOUT_MS (default 180 000 ms - an
//                              ingest awaits an embedding, an LLM thread
//                              decision, a persist and a claims pass, so the
//                              default is generous on purpose: the goal is
//                              "cannot hang forever", not "fail fast").
//                              Hard ceiling for any mix of the two: the
//                              backoffs + (attempts-1) connect-fails + one
//                              CURATOR_TIMEOUT_MS, because a timeout ends
//                              the loop.
//   curatorTimeoutMsFromEnv  - CURATOR_TIMEOUT_MS <= 0, non-numeric or unset
//                              falls back to the default (a `-1` reached
//                              AbortSignal.timeout once and threw on every
//                              attempt); curatorRetriesFromEnv floors at 1.
//   delegateCuratorWithRetry - the wrapper. `retries` is the TOTAL number of
//                              attempts (3 = one call + two retries).
// ---------------------------------------------------------------------------

export const CURATOR_DEFAULT_TIMEOUT_MS = 180_000;
export const CURATOR_DEFAULT_RETRIES = 3;

/** CURATOR_TIMEOUT_MS from the environment: a positive finite integer, else the default. */
export function curatorTimeoutMsFromEnv(raw: string | undefined | null, dflt = CURATOR_DEFAULT_TIMEOUT_MS): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** CURATOR_RETRIES from the environment: TOTAL attempts, at least 1, else the default. */
export function curatorRetriesFromEnv(raw: string | undefined | null, dflt = CURATOR_DEFAULT_RETRIES): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.max(1, n) : dflt;
}

/** An HTTP answer from the curator: the curator SPOKE. Carries the status so the retry policy can refuse it. */
export class CuratorHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`curator ${status}: ${body}`);
    this.name = "CuratorHttpError";
    this.status = status;
  }
}

/** Our own per-attempt deadline fired - in the connect, header or BODY phase. Never retried: the curator may still be working on the package. */
export class CuratorTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  constructor(elapsedMs: number, timeoutMs: number, attempt: number, attempts: number, phase: "request" | "body") {
    super(
      `curator timed out after ${elapsedMs} ms${phase === "body" ? " while reading its answer" : ""} ` +
        `(CURATOR_TIMEOUT_MS=${timeoutMs}, attempt ${attempt}/${attempts}, not retried - the curator may still be working on the package)`,
    );
    this.name = "CuratorTimeoutError";
    this.elapsedMs = elapsedMs;
    this.timeoutMs = timeoutMs;
  }
}

/** The connection failed AFTER the request was sent (or while reading the answer). Never retried: the package may have been received. */
export class CuratorAfterSendError extends Error {
  constructor(cause: string, attempt: number, attempts: number) {
    super(
      `curator connection failed after the request was sent (attempt ${attempt}/${attempts}, not retried - ` +
        `the package may have been received): ${cause}`,
    );
    this.name = "CuratorAfterSendError";
  }
}

/** A 2xx whose body is not a JSON object: the curator did not SAY it filed anything. Never retried. */
export class CuratorNoVerdictError extends Error {
  readonly status: number;
  constructor(status: number, bytes: number) {
    super(`curator answered ${status} with no JSON verdict (${bytes} bytes)`);
    this.name = "CuratorNoVerdictError";
    this.status = status;
  }
}

// Deno/hyper prefixes EVERY transport failure with "error sending request for
// url (...)": `client error (Connect): ...` means the socket never connected;
// `client error (SendRequest): connection closed before message completed`
// means it connected, the request went out, and the peer closed before any
// response byte - the package may have been received. Only the first is
// retried. Node-style codes listed are connect-phase by definition.
const CONNECT_PHASE_RE =
  /client error \(Connect\)|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|getaddrinfo/i;

export function shouldRetryCuratorError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { name?: unknown; message?: unknown; status?: unknown };
  // Anything carrying an HTTP status is an answer, however unhappy. Not ours to retry.
  if (typeof e.status === "number") return false;
  // Our deadline, any abort, or a failure after the send: the package may have reached the curator. Never resend.
  if (
    e.name === "AbortError" || e.name === "TimeoutError" || e.name === "CuratorTimeoutError" ||
    e.name === "CuratorAfterSendError" || e.name === "CuratorNoVerdictError"
  ) return false;
  const msg = typeof e.message === "string" ? e.message : String(err);
  if (/^curator \d{3}\b/.test(msg)) return false; // a verdict rendered as a plain Error
  return CONNECT_PHASE_RE.test(msg);
}

export const CURATOR_BACKOFF_BASE_MS = 2_000;
export const CURATOR_BACKOFF_CAP_MS = 10_000;

/** Delay before the next attempt once `failedAttempts` (>= 1) have failed: base * 2^(n-1), capped. */
export function curatorBackoffMs(
  failedAttempts: number,
  base = CURATOR_BACKOFF_BASE_MS,
  cap = CURATOR_BACKOFF_CAP_MS,
): number {
  const n = Math.max(1, Math.floor(failedAttempts) || 1);
  return Math.min(cap, base * Math.pow(2, n - 1));
}

/** Refused-curator worst case: every attempt's connect fails (in `connectFailMs`) and every backoff is slept. */
export function curatorRefusedWorstCaseMs(
  retries: number,
  connectFailMs: number,
  base = CURATOR_BACKOFF_BASE_MS,
  cap = CURATOR_BACKOFF_CAP_MS,
): number {
  const attempts = Math.max(1, Math.floor(retries) || 1);
  let total = attempts * connectFailMs;
  for (let failed = 1; failed < attempts; failed++) total += curatorBackoffMs(failed, base, cap);
  return total;
}

/** Paused/hung-curator worst case: exactly one CURATOR_TIMEOUT_MS - a timeout is never retried. */
export function curatorTimeoutWorstCaseMs(timeoutMs: number): number {
  return timeoutMs;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CuratorRetryOptions {
  /** TOTAL attempts, >= 1 (CURATOR_RETRIES). 3 = one call + two retries. Applies to connect-phase failures only. */
  retries: number;
  /** Per-attempt AbortSignal.timeout (CURATOR_TIMEOUT_MS), covering connect, headers AND body. <= 0 falls back to the default. */
  timeoutMs: number;
  /** Injectable for tests; default is a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** One line per failed attempt that will be retried; default silent. */
  log?: (line: string) => void;
  /** Injectable clock for the elapsed-ms figure; default Date.now. */
  now?: () => number;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function isTimeoutLike(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * POST the package to the curator with a per-attempt timeout that covers the
 * connect, the headers and the body, and a bounded retry on CONNECT-PHASE
 * failures only. Resolves with the curator's JSON object on a 2xx. Throws,
 * none of them retried: CuratorHttpError on any non-2xx answer (its body
 * parsed best-effort, `{}` when it is not JSON - the old shape);
 * CuratorTimeoutError when the deadline fires in any phase, naming the elapsed
 * time; CuratorAfterSendError when the connection fails after the request was
 * sent or while the answer is being read; CuratorNoVerdictError when a 2xx
 * body is not a JSON object; the original error on anything else. After the
 * last failed connect-phase attempt: an Error naming the attempt count, the
 * elapsed time and the last cause.
 */
export async function delegateCuratorWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: CuratorRetryOptions,
): Promise<Record<string, unknown>> {
  const attempts = Math.max(1, Math.floor(opts.retries) || 1);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : CURATOR_DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const started = now();
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStarted = now();
    let phase: "request" | "body" = "request";
    try {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // The answer is read under the SAME signal: a body that stalls is a timeout, not a success.
      phase = "body";
      const text = await r.text();
      if (!r.ok) {
        let json: unknown = {};
        try { json = JSON.parse(text); } catch { json = {}; }
        throw new CuratorHttpError(r.status, JSON.stringify(json).slice(0, 300));
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      if (!isJsonObject(json)) throw new CuratorNoVerdictError(r.status, text.length);
      return json;
    } catch (e) {
      if (isTimeoutLike(e)) {
        // Fails once, loudly, in whichever phase. The curator may still be working: never resend.
        throw new CuratorTimeoutError(now() - attemptStarted, timeoutMs, attempt, attempts, phase);
      }
      if (phase === "body" && !(e instanceof CuratorHttpError) && !(e instanceof CuratorNoVerdictError)) {
        // Headers arrived, then the read failed: the package was received.
        throw new CuratorAfterSendError(describeError(e), attempt, attempts);
      }
      if (!shouldRetryCuratorError(e)) {
        // A transport failure that is not connect-phase (SendRequest, closed before the response): the request went out.
        if (/error sending request|connection closed|ECONNRESET|EPIPE/i.test(String((e as Error)?.message ?? e))) {
          throw new CuratorAfterSendError(describeError(e), attempt, attempts);
        }
        throw e;
      }
      last = e;
      if (attempt >= attempts) break;
      const wait = curatorBackoffMs(attempt, opts.backoffBaseMs, opts.backoffCapMs);
      log(`curator attempt ${attempt}/${attempts} failed: ${describeError(e)}; retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
  throw new Error(
    `curator unreachable after ${attempts} attempt(s) in ${now() - started} ms (connect-phase failures only, ` +
      `timeout ${timeoutMs} ms per attempt): ${describeError(last)}`,
  );
}
