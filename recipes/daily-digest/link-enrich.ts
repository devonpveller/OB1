/**
 * link-enrich.ts — S3 Digest Link Processor, standalone runner (P1).
 *
 * Plan:  documentation/daily-digests-autonomous-podcasts/PLAN-digest-podcast-services.md (S3)
 * Tasks: …/TASKS-digest-podcast-services.md (P1)
 *
 * For each label-email in the window: reconstruct the full body → gather +
 * unwrap + hygiene-filter its links → fetch + extract each article → run the
 * D6 tagged-claim synthesis pass → hand a research package to the curator
 * (which resolves the thread and writes grounded claims). Emits a day report
 * (one row per link, with resolved thread + audible enrichment status) — the
 * required input to S4 (the podcast step).
 *
 * DEFAULT = DRY-RUN: does everything EXCEPT the curator POST and the source
 * metadata stamp, and prints the package that WOULD be sent. Pass `--commit`
 * to actually write to the live brain (operator-gated). Best-effort throughout:
 * a dead link / paywall / robots block / LLM failure → `email-only`, logged,
 * never fatal.
 *
 * External article fetches egress through Tor (socks5://tor:9050, privacy-by-
 * default + fail-closed) — so the container must join `ai-stack_search-net`
 * (where `tor` lives), plus `obnet`/`llm-net` for the internal services. Tor
 * proxying needs `--unstable-net`.
 *
 * Dry-run eyeball (writes nothing to the brain):
 *   docker run --rm \
 *     --network open-brain_obnet \
 *     -e CHAT_API_BASE=http://llama-cpp:8080/v1 \
 *     -v "D:\Open WebUI\ai-stack\OB1\recipes\daily-digest:/app:ro" \
 *     denoland/deno:2.3.3 sh -c \
 *     'deno run --unstable-net -A /app/link-enrich.ts --limit 3'
 *   # then `docker network connect ai-stack_search-net <id>` + ai-stack_llm-net,
 *   # or use a compose service that declares all three networks (see P5).
 */

import { BrainClient } from "./src/clients/postgrest.ts";
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { reconstructEmailBody } from "./src/enrich/email-body.ts";
import { gatherLinks } from "./src/enrich/links.ts";
import { fetchAndExtract } from "./src/enrich/extract.ts";
import {
  countTaggedClaimLines,
  makeSynthChat,
  synthesizeArticle,
} from "./src/enrich/synthesize.ts";
import { CuratorClient, ResearchPackage } from "./src/enrich/curator.ts";
import { closeEgress, egressMode } from "./src/enrich/egress.ts";
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
const ONLY_LABEL = argVal("label"); // restrict to one gmail label
const LABEL_PREFIX = env("TARGET_LABEL_PREFIX", "brain/"); // only emails carrying a label under this prefix
const MAX_LINKS_PER_EMAIL = num("MAX_LINKS_PER_EMAIL", 5);
const LINK_TIMEOUT_MS = num("LINK_TIMEOUT_MS", 60_000);
const REPORTS_DIR = env("REPORTS_DIR", "/reports");

const brain = new BrainClient({ baseUrl: env("BRAIN_REST_URL", "http://openbrain-rest") });
const curator = COMMIT
  ? new CuratorClient({
    baseUrl: env("CURATOR_URL", "http://openbrain-curator:8000"),
    brainKey: env("MCP_ACCESS_KEY"),
  })
  : null;
const synthChat = makeSynthChat({
  chatApiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("CHAT_MODEL", "qwen36-27b"),
  nothinkSuffix: env("NOTHINK_SUFFIX", ":nothink"),
});

// ── helpers ──────────────────────────────────────────────────────────────────
function pickTopicHint(labels: string[]): string | undefined {
  return labels.find((l) => l.startsWith(LABEL_PREFIX)) ?? labels[0];
}

function buildClaim(title: string, subject: string, text: string): string {
  const base = (title || subject || "").trim();
  if (base) return base.slice(0, 200);
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || "(untitled article)";
}

const report: DayReport = {
  generatedAt: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  committed: COMMIT,
  totals: {
    emailsScanned: 0,
    emailsWithNoLinks: 0,
    linksConsidered: 0,
    enriched: 0,
    emailOnly: 0,
    previouslySeen: 0,
  },
  entries: [],
};

function record(entry: DayReportEntry) {
  report.entries.push(entry);
  report.totals.linksConsidered++;
  if (entry.status === "enriched") report.totals.enriched++;
  else if (entry.status === "email-only") report.totals.emailOnly++;
  else if (entry.status === "previously-seen") report.totals.previouslySeen++;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[link-enrich] mode=${COMMIT ? "COMMIT" : "DRY-RUN"} window=${WINDOW_HOURS}h ` +
      `maxEmails=${MAX_EMAILS} label=${ONLY_LABEL ?? "(all " + LABEL_PREFIX + "*)"} ` +
      `egress=${egressMode()}`,
  );
  if (COMMIT && !env("MCP_ACCESS_KEY")) {
    console.error("[link-enrich] --commit requires MCP_ACCESS_KEY; aborting.");
    Deno.exit(2);
  }

  const news = await new AiNewsSection(brain, { windowHours: WINDOW_HOURS, limit: 500 }).produce();
  if (!news) {
    console.log("[link-enrich] no emails in window — nothing to do.");
    await writeReport();
    return;
  }
  const payload = news.payload as import("./src/sections/ai-news.ts").AiNewsPayload;

  // Unique emails carrying a target label (an email under N labels is processed once).
  const emails = payload.emails
    .filter((e) =>
      ONLY_LABEL
        ? e.gmailLabels.includes(ONLY_LABEL)
        : e.gmailLabels.some((l) => l.startsWith(LABEL_PREFIX))
    )
    .slice(0, MAX_EMAILS);

  console.log(`[link-enrich] ${emails.length} target email(s) of ${payload.emails.length} in window.`);

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
        gmailId: email.gmailId,
        label,
        rawUrl: link.rawUrl,
        url: link.url,
        domain: link.domain,
        status: "email-only",
      };

      // P1.3 fetch + extract
      const ex = await fetchAndExtract(link.url, { timeoutMs: LINK_TIMEOUT_MS });
      if (!ex.ok) {
        record({ ...base, note: `extract: ${ex.reason}` });
        console.log(`      ✗ ${link.domain} — email-only (${ex.reason})`);
        continue;
      }

      // P1.4 (D6) synthesis pass → tagged grounded claims
      const synthesis = await synthesizeArticle(synthChat, {
        title: ex.title,
        url: link.url,
        text: ex.text,
      });
      const taggedLines = synthesis ? countTaggedClaimLines(synthesis) : 0;
      if (synthesis && Deno.env.get("DUMP_SYNTHESIS")) {
        console.log(`\n----- synthesis for ${link.url} -----\n${synthesis}\n----- end -----\n`);
      }
      if (!synthesis || taggedLines === 0) {
        record({ ...base, note: synthesis ? "synthesis: 0 tagged claims" : "synthesis: llm-failed" });
        console.log(`      ✗ ${link.domain} — email-only (${synthesis ? "0 tagged claims" : "llm-failed"})`);
        continue;
      }

      const claim = buildClaim(ex.title, subject, ex.text);
      const pkg: ResearchPackage = {
        claim,
        synthesis,
        query: subject || claim,
        kind: "newsletter-link",
        volatility: "medium",
        topic_hint: topicHint,
        sources: [{ url: link.url, title: ex.title, content: ex.text, domain: link.domain }],
      };

      if (!COMMIT) {
        record({
          ...base,
          status: "enriched",
          preview: { claim, synthesisChars: synthesis.length, taggedClaimLines: taggedLines },
        });
        console.log(`      ✓ ${link.domain} — would enrich (${taggedLines} tagged claims)`);
        continue;
      }

      // COMMIT: post to curator (S1), then best-effort gmail-id stamp (P1.5)
      try {
        const resp = await curator!.ingest(pkg);
        const stamped = await stampGmailMetadata(resp.persist?.source_ids ?? [], email);
        record({
          ...base,
          status: "enriched",
          threadId: resp.thread_id,
          threadName: resp.thread_name,
          threadDecision: resp.thread_decision,
          claimsWritten: resp.claims?.claimsWritten,
          claimsDeduped: resp.claims?.claimsDeduped,
          ungroundedSkipped: resp.claims?.ungroundedSkipped,
          note: stamped ? undefined : "gmail-stamp: skipped/failed",
        });
        console.log(
          `      ✓ ${link.domain} → thread "${resp.thread_name}" (${resp.thread_decision}) ` +
            `claims=${resp.claims?.claimsWritten ?? 0}/+${resp.claims?.claimsDeduped ?? 0} ` +
            `ungrounded=${resp.claims?.ungroundedSkipped ?? 0}`,
        );
      } catch (err) {
        record({ ...base, note: `curator: ${err}` });
        console.log(`      ✗ ${link.domain} — email-only (curator failed: ${err})`);
      }
    }
  }

  await writeReport();
  const t = report.totals;
  console.log(
    `[link-enrich] done. emails=${t.emailsScanned} no-links=${t.emailsWithNoLinks} ` +
      `links=${t.linksConsidered} enriched=${t.enriched} email-only=${t.emailOnly}`,
  );
}

/**
 * P1.5 — stamp gmail_id/labels/email_date onto the ingested source rows so the
 * podcast can join sources back to the originating email. The curator package
 * has no metadata passthrough, so we PATCH the source rows here (commit only).
 * Best-effort: any failure is logged and ignored (never blocks ingestion).
 *
 * ⚠️ Assumes a writable `sources` table with a `metadata` jsonb column reachable
 * via the openbrain-rest proxy. VERIFY against the live schema before relying on
 * the join; if the table/column differ, this no-ops and logs.
 */
async function stampGmailMetadata(
  sourceIds: Array<string | null>,
  email: { gmailId: string; gmailThreadId: string; emailDate: string; gmailLabels: string[] },
): Promise<boolean> {
  const ids = sourceIds.filter((x): x is string => !!x);
  if (ids.length === 0) return false;
  const patch = {
    gmail_id: email.gmailId,
    gmail_thread_id: email.gmailThreadId,
    gmail_labels: email.gmailLabels,
    email_date: email.emailDate,
    enriched_via: "daily-digest-link-enrich",
  };
  let ok = true;
  for (const id of ids) {
    try {
      const merged = await brain.mergeSourceMetadata(id, patch);
      if (!merged) ok = false;
    } catch (err) {
      console.warn(`      (gmail-stamp failed for source ${id}: ${err})`);
      ok = false;
    }
  }
  return ok;
}

async function writeReport() {
  const date = report.generatedAt.slice(0, 10);
  const stem = `podcast-link-report-${date}${COMMIT ? "" : "-dryrun"}`;
  const json = JSON.stringify(report, null, 2);
  const md = renderMarkdown(report);
  for (const [name, content] of [[`${stem}.json`, json], [`${stem}.md`, md]] as const) {
    const path = `${REPORTS_DIR}/${name}`;
    try {
      await Deno.mkdir(REPORTS_DIR, { recursive: true });
      await Deno.writeTextFile(path, content);
      console.log(`[link-enrich] wrote ${path}`);
    } catch (err) {
      // /reports not mounted (host run) → fall back to cwd.
      const fallback = `./${name}`;
      await Deno.writeTextFile(fallback, content);
      console.log(`[link-enrich] ${REPORTS_DIR} unwritable (${err}); wrote ${fallback}`);
    }
  }
}

function renderMarkdown(r: DayReport): string {
  const t = r.totals;
  const lines: string[] = [
    `# Daily digest — link enrichment report`,
    ``,
    `- **Generated:** ${r.generatedAt}`,
    `- **Mode:** ${r.committed ? "COMMIT (written to brain)" : "DRY-RUN (nothing written)"}`,
    `- **Window:** ${r.windowHours}h`,
    ``,
    `| metric | count |`,
    `|---|---|`,
    `| emails scanned | ${t.emailsScanned} |`,
    `| emails with no extractable links | ${t.emailsWithNoLinks} |`,
    `| links considered | ${t.linksConsidered} |`,
    `| enriched | ${t.enriched} |`,
    `| email-only (fallback) | ${t.emailOnly} |`,
    `| previously seen | ${t.previouslySeen} |`,
    ``,
    `## Links`,
    ``,
    `| label | domain | status | thread / note |`,
    `|---|---|---|---|`,
  ];
  for (const e of r.entries) {
    const detail = e.threadName
      ? `${e.threadName} (${e.threadDecision}, claims=${e.claimsWritten ?? 0})`
      : e.preview
      ? `would-enrich: ${e.preview.taggedClaimLines} claims`
      : (e.note ?? "");
    lines.push(`| ${e.label} | ${e.domain} | ${e.status} | ${detail.replace(/\|/g, "/")} |`);
  }
  return lines.join("\n") + "\n";
}

try {
  await main();
} finally {
  closeEgress();
}
