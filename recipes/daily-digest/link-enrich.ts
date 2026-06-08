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
 * Egress: external article fetches go through Tor (socks5h://tor:9050,
 * privacy-by-default + fail-closed). The research service does its own Tor-routed
 * fetching for the preliminary-gap step. The runner must join
 * `ai-stack_search-net` (tor) + `open-brain_obnet` (rest + research). Tor needs
 * `--unstable-net`.
 *
 *   docker create --rm --network open-brain_obnet \
 *     -e MCP_ACCESS_KEY=$KEY \
 *     -v "D:\Open WebUI\ai-stack\OB1\recipes\daily-digest:/app:ro" \
 *     denoland/deno:2.3.3 deno run --unstable-net -A /app/link-enrich.ts --window=168 --limit=2
 *   # then: docker network connect ai-stack_search-net <id>
 */

import { BrainClient } from "./src/clients/postgrest.ts";
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { reconstructEmailBody } from "./src/enrich/email-body.ts";
import { gatherLinks } from "./src/enrich/links.ts";
import { fetchAndExtract } from "./src/enrich/extract.ts";
import { closeEgress, egressMode } from "./src/enrich/egress.ts";
import { JobRecord, ResearchClient, waitForAll } from "./src/enrich/research-client.ts";
import { DayReport, DayReportEntry } from "./src/enrich/types.ts";

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
        pending.push({ base, jobId, email });
        console.log(`      → ${link.domain} submitted (job ${jobId.slice(0, 8)})`);
      } catch (err) {
        record({ ...base, note: `research-submit: ${err}` });
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
        record({ ...p.base, note: `research: ${outcome && !outcome.ok ? outcome.error : "no outcome"}` });
        console.log(`      ✗ ${p.base.domain} — email-only (${outcome && !outcome.ok ? outcome.error : "no outcome"})`);
        continue;
      }
      await recordDoneJob(p, outcome.job);
    }
  }

  await writeReport();
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
