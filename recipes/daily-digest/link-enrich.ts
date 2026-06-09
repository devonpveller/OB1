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
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { reconstructEmailBody } from "./src/enrich/email-body.ts";
import { gatherLinks } from "./src/enrich/links.ts";
import { fetchAndExtract } from "./src/enrich/extract.ts";
import { closeEgress, egressMode } from "./src/enrich/egress.ts";
import { JobRecord, ResearchClient, waitForAll } from "./src/enrich/research-client.ts";
import { DayReport, DayReportEntry } from "./src/enrich/types.ts";
import {
  Episode,
  EpisodeInput,
  makeScriptChat,
  pad3,
  renderEpisode,
  Segment,
  SegmentItem,
} from "./src/podcast/script-renderer.ts";
import { OnClient } from "./src/podcast/on-client.ts";

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
const MAX_LINKS_PER_EMAIL = num("MAX_LINKS_PER_EMAIL", 5);
const LINK_TIMEOUT_MS = num("LINK_TIMEOUT_MS", 60_000);
const RESEARCH_WAIT_MS = num("RESEARCH_WAIT_MS", 300_000);
const RESEARCH_POLL_MS = num("RESEARCH_POLL_MS", 3_000);
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
const onClient = new OnClient({ baseUrl: env("ON_BASE", "http://open_notebook:5055") });
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

  // ── Phase 1: extract + submit a research job per link ──────────────────────
  const pending: Pending[] = [];
  for (const email of emails) {
    report.totals.emailsScanned++;
    const topicHint = pickTopicHint(email.gmailLabels);
    const label = topicHint ?? "(unlabeled)";
    const subject = email.header?.subject ?? "";

    const body = await reconstructEmailBody(brain, email.gmailId);
    const links = await gatherLinks(body, { maxLinks: MAX_LINKS_PER_EMAIL });
    if (links.length === 0) {
      report.totals.emailsWithNoLinks++;
      console.log(`  · ${label} | "${subject.slice(0, 60)}" → 0 links (likely HTML-only / no inline URLs)`);
      continue;
    }
    console.log(`  · ${label} | "${subject.slice(0, 60)}" → ${links.length} link(s)`);

    for (const link of links) {
      const base: DayReportEntry = {
        gmailId: email.gmailId, label, rawUrl: link.rawUrl, url: link.url, domain: link.domain, status: "email-only",
      };
      const ex = await fetchAndExtract(link.url, { timeoutMs: LINK_TIMEOUT_MS });
      if (!ex.ok) {
        record({ ...base, note: `extract: ${ex.reason}` });
        addSegmentItem(label, { title: subject || link.domain, url: link.url, synthesis: "", emailOnly: true });
        console.log(`      ✗ ${link.domain} — email-only (${ex.reason})`);
        continue;
      }
      try {
        const jobId = await research.submit({
          query: buildQuery(ex.title, subject, ex.text),
          seedSources: [{ url: link.url, title: ex.title, content: ex.text }],
          mode: "article",
          gapResearch: "preliminary",
          dryRun: !COMMIT,
          origin: "notebook",
        });
        pending.push({ base, jobId, email, title: ex.title, subject });
        console.log(`      → ${link.domain} submitted (job ${jobId.slice(0, 8)})`);
      } catch (err) {
        record({ ...base, note: `research-submit: ${err}` });
        addSegmentItem(label, { title: subject || link.domain, url: link.url, synthesis: "", emailOnly: true });
        console.log(`      ✗ ${link.domain} — email-only (submit failed: ${err})`);
      }
    }
  }

  // ── WAIT-GATE: every research job must reach a terminal `done` before we read
  //    any result. Bounded; a job that doesn't finish in time → email-only. ────
  if (pending.length) {
    console.log(`[link-enrich] wait-gate: awaiting ${pending.length} research job(s) to complete…`);
    const outcomes = await waitForAll(research, pending.map((p) => p.jobId), {
      timeoutMs: RESEARCH_WAIT_MS, intervalMs: RESEARCH_POLL_MS,
    });

    // ── Phase 2: build report from completed jobs ────────────────────────────
    for (const p of pending) {
      const outcome = outcomes.get(p.jobId);
      if (!outcome || !outcome.ok) {
        const why = outcome && !outcome.ok ? outcome.error : "no outcome";
        record({ ...p.base, note: `research: ${why}` });
        addSegmentItem(p.base.label, { title: p.title || p.subject || p.base.domain, url: p.base.url, synthesis: "", emailOnly: true });
        console.log(`      ✗ ${p.base.domain} — email-only (${why})`);
        continue;
      }
      await recordDoneJob(p, outcome.job);
    }
  }

  await writeReport();
  const ep = await maybeRenderEpisode();
  if (ep && AUDIO) await generateAudio(ep);
  const t = report.totals;
  console.log(
    `[link-enrich] done. emails=${t.emailsScanned} no-links=${t.emailsWithNoLinks} ` +
      `links=${t.linksConsidered} enriched=${t.enriched} email-only=${t.emailOnly}`,
  );
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

/** S4b — hand the grounded script to Open Notebook for transcript + audio. */
async function generateAudio(ep: Episode) {
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
    if (status !== "completed") { console.log(`[link-enrich] ON job ended '${status}' — no audio.`); return; }
    const episode = await onClient.episodeByName(ep.name);
    const url = episode ? onClient.audioUrlFor(episode) : null;
    console.log(`[link-enrich] 🎧 episode audio ready: ${url ?? "(produced; url unavailable)"}`);
  } catch (err) {
    console.warn(`[link-enrich] audio generation failed (best-effort): ${err}`);
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
