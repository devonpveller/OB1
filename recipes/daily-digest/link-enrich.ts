/**
 * link-enrich.ts — S3 Digest Link Processor, standalone runner (P1).
 *
 * Plan:  documentation/daily-digests-autonomous-podcasts/PLAN-digest-podcast-services.md (S3)
 * Tasks: …/TASKS-digest-podcast-services.md (P1)
 *
 * For each label-email in the window: reconstruct the full body → gather +
 * unwrap + hygiene-filter its links → fetch + extract each article THROUGH TOR →
 * submit it to the proper research channel (openbrain-research, ARTICLE mode:
 * the article is the seed/subject, corroboration from existing OB claims, plus
 * bounded PRELIMINARY research on the gaps it leaves open). Then the WAIT-GATE:
 * poll every research job to a terminal `done` state before building the report.
 * Nothing feeds a podcast until research is genuinely complete.
 *
 * Two modes:
 *   DRY-RUN (default) — submits jobs with dry_run=true: the harness runs the
 *     article synthesis + preliminary gaps but writes NOTHING canonical (no
 *     sources, claims, or thread). You can eyeball the synthesis it returns.
 *   --commit          — full write: grounded claims + thread resolution via the
 *     curator, plus the gmail-id stamp on the written sources.
 *
 * Best-effort throughout: a dead link / paywall / robots block / submit failure /
 * research timeout → `email-only`, logged, never fatal.
 *
 * Output: a link-enrichment report (JSON+MD) AND the day's episode SCRIPT
 * `[###]-daily-[primary-poi-topic].md` (S4a) — both in /reports. Audio (S4b, --audio) is
 * voiced by the P7a renderer: the script's HOST lines -> the configured team's presenters ->
 * Kokoro through LiteLLM -> the podcast archive (src/podcast/episode-audio.ts).
 *
 * Egress: external article fetches go through Tor (socks5h://tor:9050,
 * privacy-by-default + fail-closed). The research service does its own Tor-routed
 * fetching for the preliminary-gap step. The runner joins three networks:
 *   open-brain_obnet  (openbrain-rest + openbrain-research)
 *   ai-stack_search-net (tor egress)
 *   ai-stack_llm-net  (llama-cpp, for the S4a two-host script pass)
 * Tor proxying needs `--unstable-net`.
 *
 *   docker create --rm --network open-brain_obnet \
 *     -e MCP_ACCESS_KEY=$KEY \
 *     -v "<ai-stack checkout>/OB1/recipes/daily-digest:/app:ro" \
 *     denoland/deno:2.3.3 deno run --unstable-net -A /app/link-enrich.ts --window=168 --limit=2
 *   # then: docker network connect ai-stack_search-net <id>
 *   #       docker network connect ai-stack_llm-net <id>
 */

import { BrainClient } from "./src/clients/postgrest.ts";
import { GoogleOAuth } from "./src/clients/google-oauth.ts";
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { reconstructEmailBody } from "./src/enrich/email-body.ts";
import { extractUrls, gatherAnchors, gatherLinks, isResearchable } from "./src/enrich/links.ts";
import { extractAnchors, GmailReader } from "./src/enrich/gmail-fetch.ts";
import { selectPOI } from "./src/enrich/poi.ts";
import { extractTextFromHtml, fetchAndExtract } from "./src/enrich/extract.ts";
import { closeEgress, egressMode } from "./src/enrich/egress.ts";
import { isModelDown, JobRecord, ResearchClient, ResearchDeadlineError, waitForAll } from "./src/enrich/research-client.ts";
import { realClock } from "./src/routine/clock.ts";
import { probeModel, waitForModel } from "./src/routine/model-gate.ts";
import { RoutineStore } from "./src/routine/store.ts";
import { filterCandidates, isPromoBody, loadBlocklist, saveBlocklist } from "./src/enrich/promo-filter.ts";
import { DayReport, DayReportEntry, LinkCandidate } from "./src/enrich/types.ts";
import {
  Episode,
  EpisodeInput,
  FOLLOWUPS_LABEL,
  makeScriptChat,
  pad3,
  renderEpisode,
  retryUntil,
  Segment,
  SegmentItem,
} from "./src/podcast/script-renderer.ts";
import { castBlock, turnsFromHostScript, type Team } from "./src/podcast/presenters.ts";
import { PresenterStore } from "./src/podcast/presenter-store.ts";
import { SegmentCache } from "./src/podcast/segment-cache.ts";
import { gatewaySpeech } from "./src/podcast/tts-client.ts";
import { ArchiveWriter, storeDestination } from "./src/podcast/archive.ts";
import { voiceAndArchive, type Voiced } from "./src/podcast/episode-audio.ts";
import { EmailEnrichment, EnrichedSegment, parseSynthesisForEmail, ResolvedFollowUp } from "./src/podcast/enrichment.ts";
import {
  GapCandidate,
  LedgerEntry,
  LedgerResolution,
  loadLedger,
  planDives,
  resolveLedger,
  saveLedger,
} from "./src/enrich/gap-dive.ts";

// ── config ───────────────────────────────────────────────────────────────────
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const num = (k: string, d: number) => Number(env(k, String(d))) || d;

const args = new Set(Deno.args);
const argVal = (name: string): string | undefined => {
  const pre = `--${name}=`;
  const hit = Deno.args.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : undefined;
};

const COMMIT = args.has("--commit");
const WINDOW_HOURS = Number(argVal("window") ?? num("WINDOW_HOURS", 24));
const MAX_EMAILS = Number(argVal("limit") ?? num("MAX_EMAILS", 1000));
const ONLY_LABEL = argVal("label");
const LABEL_PREFIX = env("TARGET_LABEL_PREFIX", "brain/");
const MAX_LINKS_PER_EMAIL = num("MAX_LINKS_PER_EMAIL", 10);
const LINK_TIMEOUT_MS = num("LINK_TIMEOUT_MS", 60_000);
const RESEARCH_WAIT_MS = num("RESEARCH_WAIT_MS", 600_000); // per-job deadline; bumped — concurrent jobs share GPU
const RESEARCH_POLL_MS = num("RESEARCH_POLL_MS", 3_000);
// Bound how many research jobs are in flight at once (each = an LLM synthesis +
// preliminary-gap search on llama-cpp). Throttles GPU contention; the "all
// research done before the podcast" gate still holds (we await every item).
const RESEARCH_CONCURRENCY = num("RESEARCH_CONCURRENCY", 2);
const REPORTS_DIR = env("REPORTS_DIR", "/reports");
// Persisted promo blocklist (operator-editable JSON). Promos reuse the same
// domains → dropped instantly; the nothink classifier grows this over time.
const BLOCKLIST_PATH = env("PROMO_BLOCKLIST_PATH", `${REPORTS_DIR}/promo-blocklist.json`);

// ── gap dives ────────────────────────────────────────────────────────────────
// When the email source lacked context (open [GAP]s, thin syntheses, email-only
// items), triage the day's gaps into FULL research sessions. The THROTTLE is
// relevance-to-the-source-email (planDives), NOT a fixed count: every gap central
// to its newsletter's topic is researched, tangential ones are dropped. The
// CEILING below is only a runaway safety valve; overflow + unfinished dives carry
// in a freshness-bounded ledger. See implementation-guide/digest-gap-deep-research/.
const GAP_DIVE_ENABLED = env("GAP_DIVE_ENABLED", "1") === "1";
const GAP_DIVE_CEILING = num("GAP_DIVE_CEILING", 12); // runaway safety, NOT the throttle
const GAP_DIVE_MIN_TAGGED = num("GAP_DIVE_MIN_TAGGED", 2); // < this tagged lines = "thin"
const GAP_DIVE_WAIT_MS = num("GAP_DIVE_WAIT_MS", 7_200_000); // same-night budget (2h)
const GAP_DIVE_MAX_ATTEMPTS = num("GAP_DIVE_MAX_ATTEMPTS", 2); // resubmits before drop
const GAP_DIVE_MAX_AGE_DAYS = num("GAP_DIVE_MAX_AGE_DAYS", 3); // freshness: never dive staler
const GAP_MAX_PER_ITEM = num("GAP_DIVE_MAX_PER_ITEM", 3); // cap gaps taken per article
// Durable carryover ledger (deferred + unfinished dives; freshness-bounded).
const LEDGER_PATH = `${REPORTS_DIR}/gap-dives-pending${COMMIT ? "" : "-dryrun"}.json`;

const brain = new BrainClient({ baseUrl: env("BRAIN_REST_URL", "http://openbrain-rest") });
const research = new ResearchClient({
  baseUrl: env("RESEARCH_URL", "http://openbrain-research:8000"),
  brainKey: env("MCP_ACCESS_KEY"),
});
// LiteLLM virtual key for every direct chat call this runner makes. The gateway
// has REQUIRED an sk- key since J.1 (2026-08-21); before this was wired the calls
// sent `Bearer not-needed`, 401'd, and the script stage silently degraded to
// dumping raw grounded material. CHAT_API_KEY was already in the container env.
const CHAT_API_KEY = env("CHAT_API_KEY");

// S4a — the two-host script pass runs on llama-cpp directly (think model for
// better dialogue). Requires the runner to also join `ai-stack_llm-net`.
const scriptChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "local-large"),
  nothinkSuffix: env("SCRIPT_NOTHINK_SUFFIX", ":nothink"), // nothink = fast + reliable; set "" for think-model dialogue
  apiKey: CHAT_API_KEY,
  label: "script",
  // A whole two-host episode, not a classification answer. The shared 2200
  // default cut episode 089 off mid-sentence after 4 of 7 segments (measured
  // 2026-09-04: completion_tokens == max_tokens exactly). ~550 tokens/segment
  // observed, so 6000 covers a 7-segment day with the sign-off; makeScriptChat
  // still doubles up to the ceiling if a day runs long.
  maxTokens: num("SCRIPT_MAX_TOKENS", 6000),
  // The ONLY prose caller. Every other ChatFn below classifies, and for those a
  // null is a reasoned safe default that must not be replaced with cut-off text.
  salvageTruncated: true,
});
// Gap-dive triage — a CLASSIFICATION task, so temperature 0 (deterministic).
// Reusing the default 0.5 chat made triage flaky: same gaps yielded 7-10 dives
// one call and 0 the next. Verified temp 0 → stable ([6,6,6,6] across runs).
const gapTriageChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "local-large"),
  nothinkSuffix: ":nothink",
  temperature: 0,
  apiKey: CHAT_API_KEY,
  label: "gap-triage",
});

// S4b — audio (research-workbench P7a). Opt-in with --audio. The script's HOST lines are voiced
// by the team PODCAST_TEAM (a team id or name of PODCAST_OWNER_SUB in the presenter model,
// init-podcasts.sql) through LiteLLM's /v1/audio/speech (route = each presenter's voice link,
// key = PODCAST_TTS_KEY, this service's own virtual key) and archived on generation where the
// configuration store's podcast.archive_destination says (read on every render from the
// workbench). Nothing here talks to Open Notebook.
const AUDIO = args.has("--audio");
const PODCAST_OWNER_SUB = env("PODCAST_OWNER_SUB", "").trim() || "operator"; // = WORKSPACE_DEFAULT_SUB (the workbench's fallback when blank)
const PODCAST_TEAM = env("PODCAST_TEAM", "").trim();
const presenterStore = new PresenterStore(env("BRAIN_REST_URL", "http://openbrain-rest"));
const segmentCache = new SegmentCache(
  env("PODCAST_SEGMENT_CACHE_DIR", `${REPORTS_DIR}/podcast-segment-cache`),
  gatewaySpeech({ apiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"), apiKey: env("PODCAST_TTS_KEY") }),
);
const archiveWriter = new ArchiveWriter(storeDestination({
  workbenchUrl: env("WORKBENCH_URL", "http://openbrain-workbench:8000"),
  key: env("MCP_ACCESS_KEY"),
}));
const TTS_CONCURRENCY = num("PODCAST_TTS_CONCURRENCY", 2);
const FFMPEG_BIN = env("FFMPEG_BIN", "ffmpeg");
// Raw-Gmail reader (readonly token) — re-fetch original HTML so every link
// survives (the stored body lost hrefs), then POI-select the interesting ones.
const gmailReader = new GmailReader(new GoogleOAuth({
  credentialsPath: env("GMAIL_READ_CREDENTIALS", "/app/gmail-read-credentials.json"),
  tokenPath: env("GMAIL_READ_TOKEN", "/app/gmail-read-token.json"),
}));
const poiChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "local-large"),
  nothinkSuffix: ":nothink",
  apiKey: CHAT_API_KEY,
  label: "poi-select",
});
// Body-fallback classifier — THINK model (no :nothink) for precision: a legit
// single-post essay (e.g. an Anthropic-research story) must NOT be dropped as an
// ad. Costlier than nothink, but the body decision is false-positive-prone.
// Set BODY_CLASSIFY_NOTHINK=:nothink to trade precision for speed.
const bodyClassifyChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "local-large"),
  nothinkSuffix: env("BODY_CLASSIFY_NOTHINK", ""),
  apiKey: CHAT_API_KEY,
  label: "body-classify",
});

// ── model gate (mr-routine-outage) ───────────────────────────────────────────
// Before each stage that does model work, check the model is reachable through
// the gateway (/health/liveliness + one max_tokens:1 probe; never LiteLLM
// /health). While it is down: WAIT with bounded backoff - no degraded run (on
// 2026-10-13 every stage ran against a dead model and fell back). The bound is
// MODEL_WAIT_UNTIL_MS (podcast-server passes the routine's follow-up cutoff);
// past it the run stops with exit 3 and writes no brief. Without the routine
// (a manual run) the bound is now + MODEL_WAIT_MAX_MS (2 h).
const ROUTINE_DATE = env("ROUTINE_DATE"); // local date of the routine day; "" = manual run
const ROUTINE_STATE_DIR = env("ROUTINE_STATE_DIR", `${REPORTS_DIR}/routine`);
const MODEL_WAIT_UNTIL_MS = Number(env("MODEL_WAIT_UNTIL_MS")) || Date.now() + num("MODEL_WAIT_MAX_MS", 7_200_000);
const MODEL_GATE_INITIAL_MS = num("MODEL_GATE_INITIAL_MS", 30_000);
const MODEL_GATE_MAX_MS = num("MODEL_GATE_MAX_MS", 300_000);
// A research job the model went down under is resubmitted after the model is
// back, at most this many times, instead of becoming email-only.
const RESEARCH_MODEL_DOWN_RESUBMITS = num("RESEARCH_MODEL_DOWN_RESUBMITS", 3);
const EXIT_MODEL_DOWN = 3;

class ModelDownExit extends Error {
  constructor(readonly stage: string, readonly reason: string) {
    super(`model down at stage "${stage}" until the wait bound (${reason})`);
  }
}

async function gateModel(stage: string): Promise<void> {
  const w = await waitForModel({
    probe: () =>
      probeModel({
        chatBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
        // never "<model>:nothink:nothink" (an unknown model the gateway rejects)
        model: env("CHAT_MODEL", "local-large").replace(/:nothink$/, "") + ":nothink",
        apiKey: CHAT_API_KEY,
      }),
    clock: realClock,
    until: MODEL_WAIT_UNTIL_MS,
    initialMs: MODEL_GATE_INITIAL_MS,
    maxMs: MODEL_GATE_MAX_MS,
    label: `link-enrich ${stage}`,
  });
  if (!w.up) throw new ModelDownExit(stage, w.lastReason);
}

async function writeResult(outcome: "produced" | "nothing-to-do" | "model-down" | "error", detail?: string) {
  if (!ROUTINE_DATE) return;
  try {
    await new RoutineStore(ROUTINE_STATE_DIR).saveResult({ date: ROUTINE_DATE, at: new Date().toISOString(), outcome, detail });
  } catch (err) {
    console.warn(`[link-enrich] routine result write failed (non-fatal): ${err}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pickTopicHint(labels: string[]): string | undefined {
  return labels.find((l) => l.startsWith(LABEL_PREFIX)) ?? labels[0];
}
function buildQuery(title: string, subject: string, text: string): string {
  const base = (title || subject || "").trim();
  if (base) return base.slice(0, 200);
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "(untitled article)";
}
function countTaggedClaimLines(s: string): number {
  let n = 0;
  for (const line of String(s || "").split("\n")) {
    if (/^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]/i.test(line) && /\[Source\s*\d/i.test(line)) n++;
  }
  return n;
}

const report: DayReport = {
  generatedAt: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  committed: COMMIT,
  totals: { emailsScanned: 0, emailsWithNoLinks: 0, linksConsidered: 0, enriched: 0, emailOnly: 0, previouslySeen: 0 },
  entries: [],
};
function record(entry: DayReportEntry) {
  report.entries.push(entry);
  report.totals.linksConsidered++;
  if (entry.status === "enriched") report.totals.enriched++;
  else if (entry.status === "email-only") report.totals.emailOnly++;
  else if (entry.status === "previously-seen") report.totals.previouslySeen++;
}

interface Pending {
  base: DayReportEntry;
  jobId: string;
  email: { gmailId: string; gmailThreadId: string; emailDate: string; gmailLabels: string[] };
  title: string;
  subject: string;
}

// S4a — per-label segment material (grounded syntheses) collected for the episode.
const segments = new Map<string, SegmentItem[]>();
function addSegmentItem(label: string, item: SegmentItem) {
  const arr = segments.get(label) ?? [];
  arr.push(item);
  segments.set(label, arr);
}
// Threads the day's research resolved to (commit only) — for loop-close.
const threadIds = new Set<string>();

// ── gap-dive state ───────────────────────────────────────────────────────────
// "Source lacked context" signals collected across the day's items.
const gapCandidates: GapCandidate[] = [];
// Carried-over dives that resolved (yesterday's / this run's retries) — email.
const resolvedFollowUps: ResolvedFollowUp[] = [];
// Dives still running at email time — "digging deeper overnight".
const pendingFollowUpQuestions: string[] = [];

/** Attach a same-night dive synthesis to its owning item's segment. */
function attachDiveToItem(label: string, url: string, dive: string): boolean {
  const arr = segments.get(label);
  const it = arr?.find((x) => x.url === url);
  if (!it) return false;
  it.dive = dive;
  return true;
}

interface WorkItem {
  email: { gmailId: string; gmailThreadId: string; emailDate: string; gmailLabels: string[] };
  label: string;
  subject: string;
  link: LinkCandidate;
  /** Pre-supplied content (the email body itself) — skip the fetch when set. */
  preContent?: string;
  /** Source title for a body item (the newsletter subject). */
  title?: string;
}

/** Bounded-concurrency map — caps in-flight research jobs (GPU throttle). */
async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.min(Math.max(1, limit), items.length) || 1;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[link-enrich] mode=${COMMIT ? "COMMIT" : "DRY-RUN"} window=${WINDOW_HOURS}h ` +
      `maxEmails=${MAX_EMAILS} label=${ONLY_LABEL ?? "(all " + LABEL_PREFIX + "*)"} egress=${egressMode()}`,
  );
  if (!env("MCP_ACCESS_KEY")) {
    console.error("[link-enrich] MCP_ACCESS_KEY required (research API is authenticated); aborting.");
    Deno.exit(2);
  }

  // Resolve yesterday's carried-over gap dives (durable server-side jobs) before
  // today's run — so a poll happens once, and results feed today's follow-ups.
  const ledgerRes: LedgerResolution = GAP_DIVE_ENABLED
    ? await resolveLedger((id) => research.poll(id), await loadLedger(LEDGER_PATH), {
      maxAttempts: GAP_DIVE_MAX_ATTEMPTS,
      maxAgeDays: GAP_DIVE_MAX_AGE_DAYS,
      nowMs: Date.now(),
    })
    : { resolved: [], stillRunning: [], retry: [], deferred: [], dropped: [] };
  if (GAP_DIVE_ENABLED && (ledgerRes.resolved.length || ledgerRes.retry.length || ledgerRes.stillRunning.length || ledgerRes.deferred.length || ledgerRes.dropped.length)) {
    console.log(
      `[gap-dive] carryover: resolved=${ledgerRes.resolved.length} deferred=${ledgerRes.deferred.length} ` +
        `retry=${ledgerRes.retry.length} running=${ledgerRes.stillRunning.length} dropped=${ledgerRes.dropped.length}`,
    );
  }

  const news = await new AiNewsSection(brain, { windowHours: WINDOW_HOURS, limit: 500 }).produce();
  // No emails is NOT a hard stop: yesterday's carried-over gap dives may still
  // have resolved and belong in today's episode. Continue with an empty set.
  const payload = news?.payload as import("./src/sections/ai-news.ts").AiNewsPayload | undefined;
  const emails = payload
    ? payload.emails
      .filter((e) =>
        ONLY_LABEL ? e.gmailLabels.includes(ONLY_LABEL) : e.gmailLabels.some((l) => l.startsWith(LABEL_PREFIX))
      )
      .slice(0, MAX_EMAILS)
    : [];
  console.log(`[link-enrich] ${emails.length} target email(s) of ${payload?.emails.length ?? 0} in window.`);

  // First model work (promo filter / POI / body classifier) is in this loop.
  if (emails.length) await gateModel("links");

  // ── Gather work items: the EMAIL BODY (the newsletter's curated content — news,
  //    tools, summaries) is the primary source; PLUS genuinely-external content
  //    links for depth. The newsletter's own substack posts are dropped (the body
  //    already covers them, and the web posts are often paywalled). ─────────────
  const blocklist = await loadBlocklist(BLOCKLIST_PATH);
  let promoDropped = 0;
  const items: WorkItem[] = [];
  for (const email of emails) {
    report.totals.emailsScanned++;
    const label = pickTopicHint(email.gmailLabels) ?? "(unlabeled)";
    const subject = email.header?.subject ?? "";
    const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${email.gmailThreadId}`;

    // Original HTML (for links + body); fall back to the lossy stored body.
    let html = "";
    let bodyText = "";
    try {
      html = await gmailReader.fetchHtml(email.gmailId);
      bodyText = extractTextFromHtml(html);
    } catch (err) {
      console.warn(`    (raw-gmail fetch failed for ${email.gmailId}: ${err} — using stored body)`);
      bodyText = await reconstructEmailBody(brain, email.gmailId);
    }

    // EXTERNAL content links (arxiv, anthropic, …). Drop substack self/meta.
    let external: LinkCandidate[] = [];
    if (html) {
      const anchored = extractAnchors(html);
      let raw = anchored;
      if (anchored.length < 3) {
        const seen = new Set(anchored.map((a) => a.url));
        raw = [...anchored, ...extractUrls(html).filter((u) => !seen.has(u)).map((u) => ({ url: u, text: "" }))];
      }
      const gathered = await gatherAnchors(raw, { maxRaw: 80 });
      // A wrapper we could not resolve is NOT the same thing as a newsletter
      // self-link, and until 2026-09-09 both vanished through the same
      // `endsWith("substack.com")` drop. When Substack swapped its 302 for a
      // JS interstitial, that silence cost three days of external research with
      // every log line green. Say it out loud.
      //
      // SAY, DO NOT DROP (corrected 2026-09-09 after a tester measured it). The
      // first version of this also filtered the marked candidates out, which
      // LOST links the old code researched: `isRedirectWrapper` matches bare
      // substrings ("click.", "links.", "email.", "trk.") against the whole URL,
      // so a genuine article at e.g. `one-click.example/post` enters the unwrap
      // branch, does not move because it is a real page, gets marked, and would
      // then be dropped. A real wrapper whose unwrap merely TIMED OUT would go
      // the same way, where before the wrapper URL survived and extract.ts
      // followed the redirect itself at fetch time.
      //
      // Measured incidence over 95 historical link reports was zero, and that is
      // NOT why this is safe: the population moves once wrappers start resolving
      // again, so a count taken before the fix does not predict behaviour after
      // it. Keeping is what makes it safe - it restores the old behaviour
      // exactly, and the log line still ends the silence, which was the point.
      for (const c of gathered) {
        if (c.unresolvedWrapper) {
          console.log(
            `      ⚠ unresolved redirect wrapper [${c.domain || "?"}] ${c.url.slice(0, 80)} — destination unknown, passing it through unresolved`,
          );
        }
      }
      // isResearchable lives in links.ts so a test can pin the REAL rule. The
      // expression used to be inline here, where nothing could import it, and
      // the test that "guarded" it asserted a hand-typed copy - a tester put the
      // regression back and the whole suite stayed green.
      external = gathered.filter(isResearchable);
    }
    // Promo filter (blocklist → nothink): drop ad/sponsor links before POI so
    // they never become sources/claims. Domains judged promo are remembered.
    if (external.length) {
      const { kept, dropped } = await filterCandidates(poiChat, blocklist, external);
      for (const d of dropped) {
        console.log(`      ⊘ promo (${d.reason}) [${d.domain ?? "?"}] ${(d.text || d.url).slice(0, 60)}`);
      }
      promoDropped += dropped.length;
      external = kept;
    }
    let selected: LinkCandidate[] = [];
    if (external.length) {
      const keepIdx = await selectPOI(poiChat, subject, external, MAX_LINKS_PER_EMAIL);
      selected = keepIdx.map((i) => external[i]);
    }
    // The email body is a FALLBACK source ONLY when there are no external content
    // links (single-post / promo emails). For news editions the per-source links
    // carry the content and the curator can place each on a thread; a multi-topic
    // roundup body can't be placed on one thread (→ 0 claims) and just adds noise.
    let bodyItem: WorkItem | null = null;
    if (bodyText.trim().length > 400 && selected.length === 0) {
      // Drop ONLY a primarily-promotional body (e.g. "20% off every plan"); keep
      // a body with substantive content even if it carries some promo (the ad is
      // filtered downstream). Conservative think-model call — defaults to KEEP.
      if (await isPromoBody(bodyClassifyChat, subject, bodyText)) {
        promoDropped++;
        console.log(`  · ${label} | "${subject.slice(0, 55)}" → body is PROMO, dropped (no source)`);
      } else {
        bodyItem = {
          email, label, subject, title: subject, preContent: bodyText,
          link: { rawUrl: gmailUrl, url: gmailUrl, domain: "newsletter", text: subject },
        };
      }
    }
    console.log(`  · ${label} | "${subject.slice(0, 55)}" → ${external.length} ext link(s), ${selected.length} selected${bodyItem ? " + body-fallback" : ""}`);
    if (args.has("--dump-links")) {
      const keep = new Set(selected.map((s) => s.url));
      console.log(`      BODY ${bodyText.length} chars${bodyItem ? " (fallback)" : " (skipped — has ext links)"}`);
      external.forEach((c) => console.log(`      ${keep.has(c.url) ? "KEEP" : "drop"} [${c.domain}] ${(c.text || "(no text)").slice(0, 60)} — ${c.url.slice(0, 80)}`));
      continue; // inspect only; no research
    }
    if (bodyItem) items.push(bodyItem);
    for (const link of selected) items.push({ email, label, subject, link });
  }
  await saveBlocklist(BLOCKLIST_PATH, blocklist);
  if (promoDropped) {
    console.log(`[link-enrich] 🛡  dropped ${promoDropped} promo item(s); blocklist now ${blocklist.domains.size} domain(s).`);
  }

  // ── Process links through the research channel at bounded concurrency.
  //    Awaiting mapLimit IS the wait-gate: every job reaches a terminal state
  //    before the podcast is built. A job that times out → email-only. ────────
  if (items.length) {
    await gateModel("research");
    console.log(`[link-enrich] researching ${items.length} link(s) — concurrency=${RESEARCH_CONCURRENCY}, ≤${Math.round(RESEARCH_WAIT_MS / 1000)}s/job…`);
    await mapLimit(items, RESEARCH_CONCURRENCY, processLink);
  }

  // ── Gap dives: turn the day's "source lacked context" signals + yesterday's
  //    carryover into full research sessions. Best-effort; never blocks the chain.
  if (GAP_DIVE_ENABLED) {
    await gateModel("gap-dives");
    try { await runGapDives(ledgerRes); }
    catch (err) { console.warn(`[gap-dive] stage failed (non-fatal): ${err}`); }
  }

  await writeReport();
  if (segments.size) await gateModel("script");
  const team = await loadTeam();
  const ep = await maybeRenderEpisode(team);
  let voiced: Voiced | null = null;
  if (ep && AUDIO) voiced = await generateAudio(ep, team);
  // The new system's library (P7b) is not built yet: no listener-facing link exists to put in the
  // email. The episode is in the archive (voiced.dir); the email says so without a link.
  const urls = { viewUrl: null, downloadUrl: null };
  if (voiced) console.log(`[link-enrich] 🎧 episode archived at ${voiced.dir}`);
  if (COMMIT && ep && threadIds.size) await closeLoop(ep, urls.downloadUrl);
  if (ep) await writeEnrichment(ep, urls);
  await writeResult(ep ? "produced" : "nothing-to-do", ep ? undefined : "no segments");
  const t = report.totals;
  console.log(
    `[link-enrich] done. emails=${t.emailsScanned} no-links=${t.emailsWithNoLinks} ` +
      `links=${t.linksConsidered} enriched=${t.enriched} email-only=${t.emailOnly}`,
  );
}

/** Fetch (already resolved) → submit research (article mode) → wait → record. */
async function processLink(item: WorkItem) {
  const { email, label, subject, link } = item;
  const base: DayReportEntry = {
    gmailId: email.gmailId, label, rawUrl: link.rawUrl, url: link.url, domain: link.domain, status: "email-only",
  };
  const fallback = (note: string) => {
    record({ ...base, note });
    const itemTitle = link.text || subject || link.domain;
    addSegmentItem(label, { title: itemTitle, url: link.url, synthesis: "", emailOnly: true });
    // Email-only = the source lacked context entirely → a gap-dive candidate.
    if (GAP_DIVE_ENABLED) {
      gapCandidates.push({
        kind: "email-only",
        text: itemTitle,
        label,
        gmailId: email.gmailId,
        title: itemTitle,
        emailSubject: subject || itemTitle || label,
        url: link.url,
      });
    }
    console.log(`      ✗ ${link.domain} — email-only (${note})`);
  };

  // Body item → use the supplied content; link item → fetch the article.
  let title: string, content: string;
  if (item.preContent) {
    title = item.title || subject;
    content = item.preContent;
  } else {
    const ex = await fetchAndExtract(link.url, { timeoutMs: LINK_TIMEOUT_MS });
    if (!ex.ok) return fallback(`extract: ${ex.reason}`);
    title = ex.title;
    content = ex.text;
  }

  let jobId = "";
  let job: JobRecord | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      jobId = await research.submit({
        query: buildQuery(title, subject, content),
        seedSources: [{ url: link.url, title, content }],
        mode: "article", gapResearch: "preliminary", dryRun: !COMMIT, origin: "notebook",
        // The engine never starts this job after we stop waiting for it.
        deadlineAt: Date.now() + RESEARCH_WAIT_MS,
      });
    } catch (err) { return fallback(`research-submit: ${err}`); }
    console.log(`      → ${item.preContent ? "newsletter-body" : link.domain} researching (job ${jobId.slice(0, 8)})${attempt > 1 ? ` [attempt ${attempt}]` : ""}…`);

    // At the deadline waitForDone CANCELS the job (it would otherwise keep its
    // queue place and run for nobody); the note says when the model was down.
    let modelDown = false;
    let note = "";
    try {
      job = await research.waitForDone(jobId, { timeoutMs: RESEARCH_WAIT_MS, intervalMs: RESEARCH_POLL_MS });
      if (job.status === "done") break;
      // isModelDown(job) is the contract; the note prefix mirrors it for the report.
      modelDown = isModelDown(job);
      note = `research: ${modelDown ? "model_down: " : ""}${job.status}: ${job.error ?? ""}`;
    } catch (err) {
      modelDown = err instanceof ResearchDeadlineError && err.modelDown;
      note = modelDown ? `research: model_down: ${(err as Error).message}` : `research: ${err}`;
    }
    // mr-routine-outage: a job the MODEL failed is not an email-only verdict on
    // the article - wait for the model and run it again (bounded).
    if (!modelDown || attempt > RESEARCH_MODEL_DOWN_RESUBMITS) return fallback(note);
    console.log(`      ⏸ ${link.domain} — the model went down under job ${jobId.slice(0, 8)}; waiting for it, then resubmitting.`);
    await gateModel(`research ${link.domain}`); // throws ModelDownExit past the wait bound
  }

  await recordDoneJob({ base, jobId, email, title, subject }, job!);
}

async function recordDoneJob(p: Pending, job: JobRecord) {
  const result = job.result ?? {};
  const synthesis = result.synthesis ?? "";
  const taggedLines = countTaggedClaimLines(synthesis);
  // The [GAP] lines are emitted INTO the synthesis (article mode leaves
  // result.gaps empty), so parse them from there — this is the authoritative list.
  const synthGaps = parseSynthesisForEmail(synthesis).gaps;
  if (Deno.env.get("DUMP_SYNTHESIS") && synthesis) {
    console.log(`\n----- synthesis for ${p.base.url} -----\n${synthesis}\n----- end -----\n`);
  }
  const curator = result.curator ?? null;

  // Collect the grounded synthesis as this label's segment material (both modes).
  addSegmentItem(p.base.label, {
    title: p.title || p.subject || p.base.domain,
    url: p.base.url,
    threadName: curator?.thread_name,
    synthesis,
    emailOnly: false,
  });

  // Gap-dive candidates: what the source left under-covered. (a) each remaining
  // [GAP] line, (b) a thin synthesis = the item mentioned a story but grounded
  // almost nothing behind it. The owning item carries the label/thread so a dive
  // compounds the same thread and can narrate inline.
  if (GAP_DIVE_ENABLED) {
    const owner = {
      label: p.base.label,
      gmailId: p.email.gmailId,
      title: p.title || p.subject || p.base.domain,
      emailSubject: p.subject || p.title || p.base.label,
      url: p.base.url,
      threadId: curator?.thread_id ?? result.thread_id,
    };
    for (const g of synthGaps.slice(0, GAP_MAX_PER_ITEM)) {
      if (g && g.trim()) gapCandidates.push({ kind: "gap", text: g.trim(), ...owner });
    }
    if (taggedLines < GAP_DIVE_MIN_TAGGED) {
      const firstLine = synthesis.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
      gapCandidates.push({ kind: "thin", text: firstLine || owner.title, ...owner });
    }
  }

  // dry-run: no canonical write; report the previewed synthesis.
  if (!COMMIT) {
    record({
      ...p.base, status: "enriched",
      preview: { claim: (synthesis.split("\n")[0] ?? "").slice(0, 120), synthesisChars: synthesis.length, taggedClaimLines: taggedLines },
      note: `dry-run preview; reuse=${result.reuse_claims?.length ?? 0} gaps=${synthGaps.length}`,
    });
    console.log(`      ✓ ${p.base.domain} — would enrich (${taggedLines} tagged claims, ${result.reuse_claims?.length ?? 0} OB reuse)`);
    return;
  }

  // commit: claims + thread written by the curator; stamp gmail metadata on the sources.
  const stamped = await stampGmailMetadata(curator?.persist?.source_ids ?? [], p.email);
  if (curator?.thread_id) threadIds.add(curator.thread_id); // for loop-close
  record({
    ...p.base, status: "enriched",
    threadId: curator?.thread_id ?? result.thread_id,
    threadName: curator?.thread_name,
    threadDecision: curator?.thread_decision,
    claimsWritten: curator?.claims?.claimsWritten,
    claimsDeduped: curator?.claims?.claimsDeduped,
    ungroundedSkipped: curator?.claims?.ungroundedSkipped,
    note: stamped ? undefined : "gmail-stamp: skipped/failed",
  });
  console.log(
    `      ✓ ${p.base.domain} → thread "${curator?.thread_name ?? "?"}" (${curator?.thread_decision ?? "?"}) ` +
      `claims=${curator?.claims?.claimsWritten ?? 0}/+${curator?.claims?.claimsDeduped ?? 0}`,
  );
}

/** Submit a full topic-mode research job (a gap dive). Returns the job id or null. */
async function submitDive(question: string, threadId?: string): Promise<string | null> {
  try {
    // No seeds, no article mode → the default full-research path (web search ON,
    // iterative deepening). origin "notebook" → the ob-research queue lane.
    return await research.submit({ query: question, origin: "notebook", threadId, dryRun: !COMMIT });
  } catch (err) {
    console.warn(`      (gap-dive submit failed: ${err})`);
    return null;
  }
}

/** Build the email-side resolved-follow-up record from a dive synthesis. */
function toResolvedFollowUp(question: string, title: string, url: string, synthesis: string): ResolvedFollowUp {
  return { question, title, url, keyPoints: parseSynthesisForEmail(synthesis).keyPoints.slice(0, 3) };
}

/** Narrate a resolved dive as a follow-up (podcast segment + email). */
function recordResolvedFollowUp(r: { question: string; title: string; url: string; synthesis: string; threadName?: string }) {
  addSegmentItem(FOLLOWUPS_LABEL, { title: r.title, url: r.url, threadName: r.threadName, synthesis: r.synthesis, emailOnly: false });
  resolvedFollowUps.push(toResolvedFollowUp(r.question, r.title, r.url, r.synthesis));
}

/** A dive queued for submission (from carried ledger entries or today's plan). */
interface QueuedDive {
  origin: "today" | "carry"; // today's fresh → inline attach; carried → follow-up
  question: string;
  label: string;
  title: string;
  url: string;
  threadId?: string;
  attempts: number;
  firstSeen: string; // ISO — drives the freshness gate
}
interface DiveSub extends QueuedDive {
  jobId: string;
}

function deferredEntry(q: QueuedDive, submittedAt: string): LedgerEntry {
  return { jobId: "", question: q.question, label: q.label, title: q.title, url: q.url, threadId: q.threadId, attempts: q.attempts, firstSeen: q.firstSeen, submittedAt };
}

/**
 * Gap-dive stage. (1) Narrate prior runs' resolved dives. (2) Triage today's
 * candidates by RELEVANCE to their source email — every relevant gap is kept
 * (no fixed count), tangential ones dropped. (3) Build a submission queue: carried
 * (already-vetted deferred + retries) first, then today's relevant gaps ranked by
 * triage. (4) Submit up to the runaway CEILING; defer the overflow (fresh, vetted)
 * to tomorrow. (5) Wait the same-night budget; attach finished results (today →
 * inline on the item; carried → follow-up) and carry the unfinished. Honest-by-
 * default: a dive with no grounded material is dropped, item stays unfilled (D0).
 */
async function runGapDives(ledgerRes: LedgerResolution) {
  const nowIso = new Date().toISOString();

  // (1) Prior runs' resolved dives → follow-ups.
  for (const r of ledgerRes.resolved) recordResolvedFollowUp(r);

  // (2) Relevance triage — the throttle. Told what's already in flight/deferred.
  const inFlight = [...ledgerRes.stillRunning, ...ledgerRes.retry, ...ledgerRes.deferred].map((e) => e.question);
  const planned = await planDives(gapTriageChat, gapCandidates, { inFlight });
  console.log(`[gap-dive] ${gapCandidates.length} candidate(s) collected; triage kept ${planned.length} relevant; carryover deferred=${ledgerRes.deferred.length} retry=${ledgerRes.retry.length}.`);

  if (args.has("--dump-dives")) {
    console.log(`\n[gap-dive] ${gapCandidates.length} candidate(s) → triage kept ${planned.length} relevant (submitting nothing):`);
    for (const p of planned) console.log(`   KEEP [${p.label}] ${p.question}`);
    const keptUrls = new Set(planned.map((p) => p.url));
    for (const c of gapCandidates) {
      if (!keptUrls.has(c.url)) console.log(`   drop (${c.kind}) [${c.label}] ${c.text.slice(0, 80)}`);
    }
    const carry = ledgerRes.deferred.length + ledgerRes.retry.length;
    if (carry) console.log(`   (+${carry} carried dive(s) would also (re)submit)`);
    if (planned.length + carry > GAP_DIVE_CEILING) {
      console.log(`   ⚠ ${planned.length + carry} relevant > ceiling ${GAP_DIVE_CEILING} → overflow defers to tomorrow`);
    }
    console.log("");
    return;
  }

  // (3) Submission queue: carried (already vetted) first, then today's ranked.
  const queue: QueuedDive[] = [];
  const seenQ = new Set<string>();
  const pushQ = (q: QueuedDive) => {
    const key = q.question.trim().toLowerCase();
    if (!key || seenQ.has(key)) return;
    seenQ.add(key);
    queue.push(q);
  };
  for (const e of ledgerRes.deferred) pushQ({ origin: "carry", question: e.question, label: e.label, title: e.title, url: e.url, threadId: e.threadId, attempts: e.attempts, firstSeen: e.firstSeen || nowIso });
  for (const e of ledgerRes.retry) pushQ({ origin: "carry", question: e.question, label: e.label, title: e.title, url: e.url, threadId: e.threadId, attempts: e.attempts, firstSeen: e.firstSeen || nowIso });
  for (const p of planned) pushQ({ origin: "today", question: p.question, label: p.label, title: p.title, url: p.url, threadId: p.threadId, attempts: 0, firstSeen: nowIso });

  // (4) Runaway safety: submit up to the ceiling; DEFER the overflow (still fresh,
  //     still vetted) to tomorrow instead of dropping relevant work.
  const toSubmit = queue.slice(0, GAP_DIVE_CEILING);
  const overflow = queue.slice(GAP_DIVE_CEILING);
  if (overflow.length) {
    console.log(`[gap-dive] ⚠ ${queue.length} relevant dives exceed ceiling ${GAP_DIVE_CEILING}; deferring ${overflow.length} to tomorrow (freshness-bounded).`);
  }

  const newEntries: LedgerEntry[] = [...ledgerRes.stillRunning];
  for (const q of overflow) newEntries.push(deferredEntry(q, nowIso));

  if (toSubmit.length === 0) {
    await saveLedger(LEDGER_PATH, { entries: newEntries });
    if (newEntries.length) console.log(`[gap-dive] no new dives; ledger carries ${newEntries.length}.`);
    return;
  }

  // (5) Submit.
  const subs: DiveSub[] = [];
  for (const q of toSubmit) {
    const jobId = await submitDive(q.question, q.threadId);
    if (jobId) subs.push({ ...q, jobId });
    else if (q.origin === "carry") newEntries.push(deferredEntry(q, nowIso)); // keep for next run
  }
  console.log(`[gap-dive] submitted ${subs.length} dive(s); waiting ≤${Math.round(GAP_DIVE_WAIT_MS / 1000)}s…`);

  // (6) Bounded same-night wait — never cancels; unfinished jobs keep draining.
  const results = subs.length
    ? await waitForAll(research, subs.map((s) => s.jobId), { timeoutMs: GAP_DIVE_WAIT_MS, intervalMs: RESEARCH_POLL_MS, cancelOnTimeout: false })
    : new Map();

  // (7) Classify + persist.
  for (const s of subs) {
    const out = results.get(s.jobId);
    const job = out && out.ok ? out.job : null;
    const synthesis = job?.result?.synthesis ?? "";
    if (job && countTaggedClaimLines(synthesis) > 0) {
      if (s.origin === "today" && attachDiveToItem(s.label, s.url, synthesis)) {
        console.log(`      ✓ gap dive filled "${s.title.slice(0, 50)}" inline.`);
      } else {
        // carried (a prior-day gap), or owning item vanished → standalone follow-up.
        recordResolvedFollowUp({ question: s.question, title: s.title, url: s.url, synthesis, threadName: job?.result?.curator?.thread_name });
      }
    } else if (job) {
      // done but no grounded material → dropped (honest floor; item stays unfilled).
    } else {
      // still running / errored / timed out → carry over (freshness-bounded).
      newEntries.push({ jobId: s.jobId, question: s.question, label: s.label, title: s.title, url: s.url, threadId: s.threadId, attempts: s.attempts, firstSeen: s.firstSeen, submittedAt: nowIso });
      pendingFollowUpQuestions.push(s.question);
    }
  }
  await saveLedger(LEDGER_PATH, { entries: newEntries });
  console.log(`[gap-dive] done. resolved=${resolvedFollowUps.length} pending=${pendingFollowUpQuestions.length} ledger=${newEntries.length}.`);
}

/** Stamp gmail_id/labels/email_date onto the curator-written sources (commit only). */
async function stampGmailMetadata(
  sourceIds: Array<string | null>,
  email: { gmailId: string; gmailThreadId: string; emailDate: string; gmailLabels: string[] },
): Promise<boolean> {
  const ids = sourceIds.filter((x): x is string => !!x);
  if (ids.length === 0) return false;
  const patch = {
    gmail_id: email.gmailId, gmail_thread_id: email.gmailThreadId,
    gmail_labels: email.gmailLabels, email_date: email.emailDate, enriched_via: "daily-digest-link-enrich",
  };
  let ok = true;
  for (const id of ids) {
    try { if (!(await brain.mergeSourceMetadata(id, patch))) ok = false; }
    catch (err) { console.warn(`      (gmail-stamp failed for source ${id}: ${err})`); ok = false; }
  }
  return ok;
}

/** Write the email-enrichment artifact for the digest. The email is SHORT (a
 *  scannable few points per article + episode link + tight follow-ups); the
 *  podcast keeps the full richness. So we cap here. */
async function writeEnrichment(ep: Episode, urls: { viewUrl: string | null; downloadUrl: string | null }) {
  const KP = num("EMAIL_KEYPOINTS", 3), PRE = num("EMAIL_PRELIM", 1), GAP = num("EMAIL_GAPS", 2);
  const segs: EnrichedSegment[] = [];
  const followUps: string[] = [];
  for (const [label, items] of segments) {
    // The follow-ups pseudo-segment is surfaced via resolvedFollowUps, not here.
    if (label === FOLLOWUPS_LABEL) continue;
    segs.push({
      label,
      items: items.map((it) => {
        const p = parseSynthesisForEmail(it.synthesis);
        // A same-night dive filled this item's context — fold its findings in and
        // treat the item's own gaps as addressed (no longer "open").
        const dv = it.dive ? parseSynthesisForEmail(it.dive) : null;
        if (!dv) followUps.push(...p.gaps);
        return {
          title: it.title, url: it.url,
          keyPoints: [...p.keyPoints, ...(dv?.keyPoints ?? [])].slice(0, KP),
          preliminary: [...p.preliminary, ...(dv?.preliminary ?? [])].slice(0, PRE),
          gaps: (dv ? [] : p.gaps).slice(0, GAP),
          emailOnly: !!it.emailOnly && !it.dive,
        };
      }),
    });
  }
  const enrichment: EmailEnrichment = {
    generatedAt: report.generatedAt,
    date: report.generatedAt.slice(0, 10),
    ...(ROUTINE_DATE ? { routineDate: ROUTINE_DATE } : {}),
    episode: { name: ep.name, title: ep.title, viewUrl: urls.viewUrl, downloadUrl: urls.downloadUrl },
    segments: segs,
    followUps: [...new Set(followUps.map((g) => g.trim()).filter(Boolean))].slice(0, 6),
    resolvedFollowUps: resolvedFollowUps.length ? resolvedFollowUps : undefined,
    pendingFollowUps: pendingFollowUpQuestions.length
      ? [...new Set(pendingFollowUpQuestions.map((q) => q.trim()).filter(Boolean))].slice(0, 6)
      : undefined,
  };
  // Dry-run writes a separate file so it never clobbers the digest's production
  // artifact (the digest only reads podcast-brief-latest.json).
  const path = `${REPORTS_DIR}/podcast-brief-latest${COMMIT ? "" : "-dryrun"}.json`;
  try {
    await Deno.mkdir(REPORTS_DIR, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(enrichment, null, 2));
    console.log(`[link-enrich] 📧 wrote concise email enrichment ${path}`);
  } catch (err) {
    console.warn(`[link-enrich] enrichment write failed (non-fatal): ${err}`);
  }
}

/** Next daily episode number. Peeks in dry-run; persists+increments on commit. */
async function nextEpisodeNumber(): Promise<number> {
  const path = `${REPORTS_DIR}/.episode-seq`;
  let n = 0;
  try { n = parseInt(await Deno.readTextFile(path), 10) || 0; } catch { n = 0; }
  const next = n + 1;
  if (COMMIT) {
    try { await Deno.mkdir(REPORTS_DIR, { recursive: true }); await Deno.writeTextFile(path, String(next)); } catch { /* */ }
  }
  return next;
}

/** S4a — render the day's episode SCRIPT from the collected grounded segments. */
async function maybeRenderEpisode(team: Team | null): Promise<Episode | null> {
  if (segments.size === 0) { console.log("[link-enrich] no segments → no episode."); return null; }
  const epNum = await nextEpisodeNumber();
  const input: EpisodeInput = {
    date: report.generatedAt.slice(0, 10),
    episodeNumber: epNum,
    segments: [...segments.entries()].map(([label, items]): Segment => ({ label, items })),
  };
  console.log(`[link-enrich] rendering episode #${pad3(epNum)} from ${segments.size} segment(s)…`);
  const ep = await renderEpisode(input, scriptChat, team ? castBlock(team) : "");
  const stem = `${ep.name}${COMMIT ? "" : "-dryrun"}`;
  const md = `# ${ep.title}\n\n> Episode \`${ep.name}\` · ${input.date} · ${COMMIT ? "COMMIT" : "DRY-RUN"}\n\n${ep.script}\n`;
  const path = `${REPORTS_DIR}/${stem}.md`;
  try {
    await Deno.mkdir(REPORTS_DIR, { recursive: true });
    await Deno.writeTextFile(path, md);
    console.log(`[link-enrich] 🎙  wrote episode ${path}`);
  } catch (err) {
    await Deno.writeTextFile(`./${stem}.md`, md);
    console.log(`[link-enrich] ${REPORTS_DIR} unwritable (${err}); wrote ./${stem}.md`);
  }
  return ep;
}

/** The team that voices the daily episode (PODCAST_TEAM of PODCAST_OWNER_SUB), or null. */
async function loadTeam(): Promise<Team | null> {
  if (!PODCAST_TEAM) {
    if (AUDIO) console.warn("[link-enrich] PODCAST_TEAM is not set: the script is written for unnamed hosts and no audio is voiced.");
    return null;
  }
  try {
    const t = await presenterStore.team(PODCAST_OWNER_SUB, PODCAST_TEAM);
    if (!t) console.warn(`[link-enrich] no team "${PODCAST_TEAM}" in the presenter model: no audio is voiced.`);
    return t;
  } catch (err) {
    console.warn(`[link-enrich] the presenter model is unreachable (${err}): no audio is voiced.`);
    return null;
  }
}

/** S4b (P7a) — voice the script's HOST lines with the team and archive the episode. A failed
 *  voice step is retried once (retryUntil); the cache keeps every turn already voiced. */
const AUDIO_ATTEMPTS = num("PODCAST_AUDIO_ATTEMPTS", 2);

async function generateAudio(ep: Episode, team: Team | null): Promise<Voiced | null> {
  if (!team) return null;
  let transcript;
  try {
    transcript = turnsFromHostScript(ep.title, ep.script, team);
  } catch (err) {
    console.warn(`[link-enrich] the script cannot be voiced by team "${team.name}": ${err}`);
    return null;
  }
  return await retryUntil<Voiced>(
    AUDIO_ATTEMPTS,
    async (attempt) => {
      const suffix = attempt > 1 ? ` (attempt ${attempt}/${AUDIO_ATTEMPTS})` : "";
      console.log(`[link-enrich] 🔊 voicing ${transcript.turns.length} turn(s) with team "${team.name}" (episode ${ep.name})${suffix}…`);
      const v = await voiceAndArchive(transcript, team, {
        ownerSub: PODCAST_OWNER_SUB, requesterSub: PODCAST_OWNER_SUB, shared: false, slug: ep.name,
        meta: { source: "daily-digest", episode: ep.name, episode_number: ep.number, commit: COMMIT },
      }, { cache: segmentCache, concurrency: TTS_CONCURRENCY, ffmpeg: { bin: FFMPEG_BIN }, archive: archiveWriter, store: presenterStore });
      return { done: true, value: v };
    },
    (err, _attempt, last) => {
      console.warn(`[link-enrich] audio failed${last ? " (best-effort)" : " - retrying"}: ${err}`);
    },
  );
}

/** Loop-close (commit only) — ingest the episode as a `podcast_transcript`
 *  source and link it to every thread the day's research resolved to. Closes
 *  the research loop back into the brain (P4.2/4.3). Best-effort. */
async function closeLoop(ep: Episode, audioUrl: string | null) {
  const tids = [...threadIds];
  console.log(`[link-enrich] 🔗 loop-close: ingesting episode + linking to ${tids.length} thread(s)…`);
  try {
    const rows = await brain.rpc<Array<{ id: string; was_duplicate: boolean }>>("find_or_create_source", {
      p_url: audioUrl ?? `podcast://episode/${ep.name}`,
      p_content: ep.script,
      p_title: ep.title,
      p_content_type: "podcast_transcript",
      p_metadata: {
        source: "daily-digest-podcast",
        episode: ep.name,
        episode_number: ep.number,
        audio_url: audioUrl,
        date: report.generatedAt.slice(0, 10),
      },
    });
    const sourceId = rows?.[0]?.id;
    if (!sourceId) { console.warn("[link-enrich] loop-close: find_or_create_source returned no id"); return; }
    let linked = 0;
    for (const tid of tids) {
      try {
        await brain.rpc("link_source_to_thread", {
          p_thread_id: tid, p_source_id: sourceId,
          p_link_type: "deliberate", p_reason: `daily podcast ${ep.name}`, p_status: "confirmed",
        });
        linked++;
      } catch (e) { console.warn(`[link-enrich]   link thread ${tid.slice(0, 8)} failed: ${e}`); }
    }
    console.log(`[link-enrich] 🔗 episode source ${sourceId.slice(0, 8)} linked into ${linked}/${tids.length} thread(s).`);
  } catch (err) {
    console.warn(`[link-enrich] loop-close failed (best-effort): ${err}`);
  }
}

async function writeReport() {
  const date = report.generatedAt.slice(0, 10);
  const stem = `podcast-link-report-${date}${COMMIT ? "" : "-dryrun"}`;
  for (const [name, content] of [[`${stem}.json`, JSON.stringify(report, null, 2)], [`${stem}.md`, renderMarkdown(report)]] as const) {
    const path = `${REPORTS_DIR}/${name}`;
    try {
      await Deno.mkdir(REPORTS_DIR, { recursive: true });
      await Deno.writeTextFile(path, content);
      console.log(`[link-enrich] wrote ${path}`);
    } catch (err) {
      await Deno.writeTextFile(`./${name}`, content);
      console.log(`[link-enrich] ${REPORTS_DIR} unwritable (${err}); wrote ./${name}`);
    }
  }
}

function renderMarkdown(r: DayReport): string {
  const t = r.totals;
  const lines: string[] = [
    `# Daily digest — link enrichment report`, ``,
    `- **Generated:** ${r.generatedAt}`,
    `- **Mode:** ${r.committed ? "COMMIT (written to brain)" : "DRY-RUN (nothing written)"}`,
    `- **Window:** ${r.windowHours}h`, ``,
    `| metric | count |`, `|---|---|`,
    `| emails scanned | ${t.emailsScanned} |`,
    `| emails with no extractable links | ${t.emailsWithNoLinks} |`,
    `| links considered | ${t.linksConsidered} |`,
    `| enriched | ${t.enriched} |`,
    `| email-only (fallback) | ${t.emailOnly} |`,
    `| previously seen | ${t.previouslySeen} |`, ``,
    `## Links`, ``,
    `| label | domain | status | thread / note |`, `|---|---|---|---|`,
  ];
  for (const e of r.entries) {
    const detail = e.threadName
      ? `${e.threadName} (${e.threadDecision}, claims=${e.claimsWritten ?? 0})`
      : e.preview ? `would-enrich: ${e.preview.taggedClaimLines} claims` : (e.note ?? "");
    lines.push(`| ${e.label} | ${e.domain} | ${e.status} | ${detail.replace(/\|/g, "/")} |`);
  }
  return lines.join("\n") + "\n";
}

try {
  await main();
} catch (err) {
  if (err instanceof ModelDownExit) {
    console.error(`[link-enrich] STOPPED: ${err.message} - no degraded run, no brief written.`);
    await writeResult("model-down", err.stage);
    closeEgress();
    Deno.exit(EXIT_MODEL_DOWN);
  }
  await writeResult("error", (err as Error)?.name ?? "error");
  throw err;
} finally {
  closeEgress();
}
