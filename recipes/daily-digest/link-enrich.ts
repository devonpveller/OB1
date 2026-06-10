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
import { JobRecord, ResearchClient } from "./src/enrich/research-client.ts";
import { DayReport, DayReportEntry, LinkCandidate } from "./src/enrich/types.ts";
import {
  Episode,
  EpisodeInput,
  makeScriptChat,
  pad3,
  renderEpisode,
  Segment,
  SegmentItem,
} from "./src/podcast/script-renderer.ts";
import { OnClient, OnEpisode } from "./src/podcast/on-client.ts";
import { EmailEnrichment, EnrichedSegment, parseSynthesisForEmail } from "./src/podcast/enrichment.ts";

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

const brain = new BrainClient({ baseUrl: env("BRAIN_REST_URL", "http://openbrain-rest") });
const research = new ResearchClient({
  baseUrl: env("RESEARCH_URL", "http://openbrain-research:8000"),
  brainKey: env("MCP_ACCESS_KEY"),
});
// S4a — the two-host script pass runs on llama-cpp directly (think model for
// better dialogue). Requires the runner to also join `ai-stack_llm-net`.
const scriptChat = makeScriptChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
  nothinkSuffix: env("SCRIPT_NOTHINK_SUFFIX", ":nothink"), // nothink = fast + reliable; set "" for think-model dialogue
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

  const news = await new AiNewsSection(brain, { windowHours: WINDOW_HOURS, limit: 500 }).produce();
  if (!news) { console.log("[link-enrich] no emails in window."); await writeReport(); return; }
  const payload = news.payload as import("./src/sections/ai-news.ts").AiNewsPayload;

  const emails = payload.emails
    .filter((e) =>
      ONLY_LABEL ? e.gmailLabels.includes(ONLY_LABEL) : e.gmailLabels.some((l) => l.startsWith(LABEL_PREFIX))
    )
    .slice(0, MAX_EMAILS);
  console.log(`[link-enrich] ${emails.length} target email(s) of ${payload.emails.length} in window.`);

  // ── Gather work items: the EMAIL BODY (the newsletter's curated content — news,
  //    tools, summaries) is the primary source; PLUS genuinely-external content
  //    links for depth. The newsletter's own substack posts are dropped (the body
  //    already covers them, and the web posts are often paywalled). ─────────────
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
    let selected: LinkCandidate[] = [];
    if (external.length) {
      const keepIdx = await selectPOI(poiChat, subject, external, MAX_LINKS_PER_EMAIL);
      selected = keepIdx.map((i) => external[i]);
    }
    // The email body is a FALLBACK source ONLY when there are no external content
    // links (single-post / promo emails). For news editions the per-source links
    // carry the content and the curator can place each on a thread; a multi-topic
    // roundup body can't be placed on one thread (→ 0 claims) and just adds noise.
    const bodyItem: WorkItem | null = (bodyText.trim().length > 400 && selected.length === 0)
      ? {
        email, label, subject, title: subject, preContent: bodyText,
        link: { rawUrl: gmailUrl, url: gmailUrl, domain: "newsletter", text: subject },
      }
      : null;
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

  // ── Process links through the research channel at bounded concurrency.
  //    Awaiting mapLimit IS the wait-gate: every job reaches a terminal state
  //    before the podcast is built. A job that times out → email-only. ────────
  if (items.length) {
    console.log(`[link-enrich] researching ${items.length} link(s) — concurrency=${RESEARCH_CONCURRENCY}, ≤${Math.round(RESEARCH_WAIT_MS / 1000)}s/job…`);
    await mapLimit(items, RESEARCH_CONCURRENCY, processLink);
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
    addSegmentItem(label, { title: link.text || subject || link.domain, url: link.url, synthesis: "", emailOnly: true });
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

  // dry-run: no canonical write; report the previewed synthesis.
  if (!COMMIT) {
    record({
      ...p.base, status: "enriched",
      preview: { claim: (synthesis.split("\n")[0] ?? "").slice(0, 120), synthesisChars: synthesis.length, taggedClaimLines: taggedLines },
      note: `dry-run preview; reuse=${result.reuse_claims?.length ?? 0} gaps=${result.gaps?.length ?? 0}`,
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
    segs.push({
      label,
      items: items.map((it) => {
        const p = parseSynthesisForEmail(it.synthesis);
        followUps.push(...p.gaps);
        return {
          title: it.title, url: it.url,
          keyPoints: p.keyPoints.slice(0, KP),
          preliminary: p.preliminary.slice(0, PRE),
          gaps: p.gaps.slice(0, GAP),
          emailOnly: !!it.emailOnly,
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
async function generateAudio(ep: Episode): Promise<OnEpisode | null> {
  console.log(`[link-enrich] 🔊 generating audio via ON (profile=${ON_EPISODE_PROFILE}/${ON_SPEAKER_PROFILE}, episode ${ep.name})… this takes minutes.`);
  try {
    const jobId = await onClient.generate({
      episodeProfile: ON_EPISODE_PROFILE,
      speakerProfile: ON_SPEAKER_PROFILE,
      episodeName: ep.name,
      content: ep.script,
      briefingSuffix: ON_BRIEFING,
    });
    const status = await onClient.waitForJob(jobId);
    if (status !== "completed") { console.log(`[link-enrich] ON job ended '${status}' — no audio.`); return null; }
    const episode = await onClient.episodeByName(ep.name);
    console.log(`[link-enrich] 🎧 episode audio ready (id ${episode?.id ?? "?"}).`);
    return episode;
  } catch (err) {
    console.warn(`[link-enrich] audio generation failed (best-effort): ${err}`);
    return null;
  }
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
