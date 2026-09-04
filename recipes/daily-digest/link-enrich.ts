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
 * `[###]-daily-[primary-poi-topic].md` (S4a) — both in /reports. Audio (S4b via
 * Open Notebook) is a separate step gated on the one-time voice-profile setup.
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
 *     -v "D:\Open WebUI\ai-stack\OB1\recipes\daily-digest:/app:ro" \
 *     denoland/deno:2.3.3 deno run --unstable-net -A /app/link-enrich.ts --window=168 --limit=2
 *   # then: docker network connect ai-stack_search-net <id>
 *   #       docker network connect ai-stack_llm-net <id>
 */

import { BrainClient } from "./src/clients/postgrest.ts";
import { GoogleOAuth } from "./src/clients/google-oauth.ts";
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { reconstructEmailBody } from "./src/enrich/email-body.ts";
import { extractUrls, gatherAnchors, gatherLinks } from "./src/enrich/links.ts";
import { extractAnchors, GmailReader } from "./src/enrich/gmail-fetch.ts";
import { selectPOI } from "./src/enrich/poi.ts";
import { extractTextFromHtml, fetchAndExtract } from "./src/enrich/extract.ts";
import { closeEgress, egressMode } from "./src/enrich/egress.ts";
import { JobRecord, ResearchClient, waitForAll } from "./src/enrich/research-client.ts";
import { filterCandidates, isPromoBody, loadBlocklist, saveBlocklist } from "./src/enrich/promo-filter.ts";
import { DayReport, DayReportEntry, LinkCandidate } from "./src/enrich/types.ts";
import {
  Episode,
  EpisodeInput,
  FOLLOWUPS_LABEL,
  makeScriptChat,
  pad3,
  renderEpisode,
  Segment,
  SegmentItem,
} from "./src/podcast/script-renderer.ts";
import { OnClient, OnEpisode } from "./src/podcast/on-client.ts";
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
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
  nothinkSuffix: env("SCRIPT_NOTHINK_SUFFIX", ":nothink"), // nothink = fast + reliable; set "" for think-model dialogue
  apiKey: CHAT_API_KEY,
  label: "script",
  // A whole two-host episode, not a classification answer. The shared 2200
  // default cut episode 089 off mid-sentence after 4 of 7 segments (measured
  // 2026-09-04: completion_tokens == max_tokens exactly). ~550 tokens/segment
  // observed, so 6000 covers a 7-segment day with the sign-off; makeScriptChat
  // still doubles up to the ceiling if a day runs long.
  maxTokens: num("SCRIPT_MAX_TOKENS", 6000),
});
// Gap-dive triage — a CLASSIFICATION task, so temperature 0 (deterministic).
// Reusing the default 0.5 chat made triage flaky: same gaps yielded 7-10 dives
// one call and 0 the next. Verified temp 0 → stable ([6,6,6,6] across runs).
const gapTriageChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
  nothinkSuffix: ":nothink",
  temperature: 0,
  apiKey: CHAT_API_KEY,
  label: "gap-triage",
});

// S4b — audio via Open Notebook (D5: content-only renderer; D12: accept ON's
// style). Opt-in with --audio; works in dry-run too (audio is an ON artifact,
// not a brain write). ON reachable via open-brain_obnet.
const AUDIO = args.has("--audio");
const ON_BASE = env("ON_BASE", "http://open_notebook:5055"); // internal — used to GENERATE audio
// User-facing base for the EMAIL links — external + Authelia-gated (NOT tailnet,
// NOT the internal docker host). On notebook.<domain>: everything → Next.js UI,
// /api/* → FastAPI. So /podcasts opens the episode in ON; /api/podcasts/episodes/
// {id}/audio downloads it. Both behind Authelia (user signs in once).
const ON_PUBLIC_BASE = env("ON_PUBLIC_BASE", "https://notebook.devinveller.ai").replace(/\/$/, "");
const onClient = new OnClient({ baseUrl: ON_BASE });
// ON TTS terminal-wait deadline. Generous (default 2h) so a slow-but-working
// render is never cut off as an "early timeout" — the email waits for ON's
// genuine terminal state. A real 'failed' returns immediately regardless.
const ON_JOB_WAIT_MS = num("ON_JOB_WAIT_MS", 7_200_000);
// Raw-Gmail reader (readonly token) — re-fetch original HTML so every link
// survives (the stored body lost hrefs), then POI-select the interesting ones.
const gmailReader = new GmailReader(new GoogleOAuth({
  credentialsPath: env("GMAIL_READ_CREDENTIALS", "/app/gmail-read-credentials.json"),
  tokenPath: env("GMAIL_READ_TOKEN", "/app/gmail-read-token.json"),
}));
const poiChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
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
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
  nothinkSuffix: env("BODY_CLASSIFY_NOTHINK", ""),
  apiKey: CHAT_API_KEY,
  label: "body-classify",
});
const ON_EPISODE_PROFILE = env("ON_EPISODE_PROFILE", "tech_discussion");
const ON_SPEAKER_PROFILE = env("ON_SPEAKER_PROFILE", "tech_experts");
const ON_BRIEFING = env(
  "ON_BRIEFING",
  "Base the discussion STRICTLY on the provided grounded material. Do NOT introduce any fact, number, company, name, or claim that is not present in it. Keep anything marked 'preliminary' explicitly tentative, and present any open question as unresolved. Cover one segment per labeled topic.",
);

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
      external = (await gatherAnchors(raw, { maxRaw: 80 }))
        .filter((c) => c.domain && !c.domain.endsWith("substack.com"));
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
    console.log(`[link-enrich] researching ${items.length} link(s) — concurrency=${RESEARCH_CONCURRENCY}, ≤${Math.round(RESEARCH_WAIT_MS / 1000)}s/job…`);
    await mapLimit(items, RESEARCH_CONCURRENCY, processLink);
  }

  // ── Gap dives: turn the day's "source lacked context" signals + yesterday's
  //    carryover into full research sessions. Best-effort; never blocks the chain.
  if (GAP_DIVE_ENABLED) {
    try { await runGapDives(ledgerRes); }
    catch (err) { console.warn(`[gap-dive] stage failed (non-fatal): ${err}`); }
  }

  await writeReport();
  const ep = await maybeRenderEpisode();
  let onEp: OnEpisode | null = null;
  if (ep && AUDIO) onEp = await generateAudio(ep);
  const urls = buildEpisodeUrls(onEp);
  if (COMMIT && ep && threadIds.size) await closeLoop(ep, urls.downloadUrl);
  if (ep) await writeEnrichment(ep, urls);
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

  let jobId: string;
  try {
    jobId = await research.submit({
      query: buildQuery(title, subject, content),
      seedSources: [{ url: link.url, title, content }],
      mode: "article", gapResearch: "preliminary", dryRun: !COMMIT, origin: "notebook",
    });
  } catch (err) { return fallback(`research-submit: ${err}`); }
  console.log(`      → ${item.preContent ? "newsletter-body" : link.domain} researching (job ${jobId.slice(0, 8)})…`);

  let job: JobRecord;
  try { job = await research.waitForDone(jobId, { timeoutMs: RESEARCH_WAIT_MS, intervalMs: RESEARCH_POLL_MS }); }
  catch (err) { return fallback(`research: ${err}`); }
  if (job.status !== "done") return fallback(`research: ${job.status}: ${job.error ?? ""}`);

  await recordDoneJob({ base, jobId, email, title, subject }, job);
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
    ? await waitForAll(research, subs.map((s) => s.jobId), { timeoutMs: GAP_DIVE_WAIT_MS, intervalMs: RESEARCH_POLL_MS })
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
async function maybeRenderEpisode(): Promise<Episode | null> {
  if (segments.size === 0) { console.log("[link-enrich] no segments → no episode."); return null; }
  const epNum = await nextEpisodeNumber();
  const input: EpisodeInput = {
    date: report.generatedAt.slice(0, 10),
    episodeNumber: epNum,
    segments: [...segments.entries()].map(([label, items]): Segment => ({ label, items })),
  };
  console.log(`[link-enrich] rendering episode #${pad3(epNum)} from ${segments.size} segment(s)…`);
  const ep = await renderEpisode(input, scriptChat);
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

/** S4b — hand the grounded script to Open Notebook for transcript + audio.
 *  Returns the absolute audio URL, or null. */
// ON transcript generation re-samples an LLM per segment, so a failure is often
// a one-off rather than a property of the material - on 2026-08-29 a single
// segment overran its token cap, ON returned "failed", and the day shipped with
// no podcast even though an immediate resubmit succeeded first try. Try again
// before accepting silence.
const ON_AUDIO_ATTEMPTS = num("ON_AUDIO_ATTEMPTS", 2);

// The loop body is unchanged; the retry POLICY moved to retryUntil() in
// script-renderer.ts so it can be unit-tested - generateAudio is not exported and
// this module runs work at import, so the "retried once" criterion had no way to
// be proven (found in test 2026-09-04). Semantics are identical: a COMPLETED job
// returns its episode (even if the lookup yields null), and only a non-completed
// status or a throw re-submits.
async function generateAudio(ep: Episode): Promise<OnEpisode | null> {
  return await retryUntil<OnEpisode>(
    ON_AUDIO_ATTEMPTS,
    async (attempt, last) => {
      const suffix = attempt > 1 ? ` (attempt ${attempt}/${ON_AUDIO_ATTEMPTS})` : "";
      console.log(`[link-enrich] 🔊 generating audio via ON (profile=${ON_EPISODE_PROFILE}/${ON_SPEAKER_PROFILE}, episode ${ep.name})${suffix}… this takes minutes.`);
      const jobId = await onClient.generate({
        episodeProfile: ON_EPISODE_PROFILE,
        speakerProfile: ON_SPEAKER_PROFILE,
        episodeName: ep.name,
        content: ep.script,
        briefingSuffix: ON_BRIEFING,
      });
      const status = await onClient.waitForJob(jobId, { timeoutMs: ON_JOB_WAIT_MS });
      if (status === "completed") {
        const episode = await onClient.episodeByName(ep.name);
        console.log(`[link-enrich] 🎧 episode audio ready (id ${episode?.id ?? "?"}).`);
        return { done: true, value: episode };
      }
      console.log(`[link-enrich] ON job ended '${status}'${last ? " — no audio." : " — resubmitting."}`);
      return { done: false };
    },
    (err, _attempt, last) => {
      console.warn(`[link-enrich] audio generation failed${last ? " (best-effort)" : " - resubmitting"}: ${err}`);
    },
  );
}

/** User-facing email links — external + Authelia-gated (notebook.<domain>):
 *  view opens the episode in ON's UI, download streams the mp3. */
function buildEpisodeUrls(onEp: OnEpisode | null): { viewUrl: string | null; downloadUrl: string | null } {
  if (!onEp) return { viewUrl: null, downloadUrl: null };
  if (ON_PUBLIC_BASE) {
    return {
      viewUrl: `${ON_PUBLIC_BASE}/podcasts`,
      downloadUrl: `${ON_PUBLIC_BASE}/api/podcasts/episodes/${encodeURIComponent(onEp.id)}/audio`,
    };
  }
  // No public base → internal audio only (dev/testing); no UI link.
  return { viewUrl: null, downloadUrl: onEp.audioUrl ? `${ON_BASE}${onEp.audioUrl}` : null };
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

try { await main(); } finally { closeEgress(); }
