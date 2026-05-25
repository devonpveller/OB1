#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Open Brain — Gmail Short-Term Retention Prune
 *
 * Deletes brain rows where:
 *   metadata.source = 'gmail'
 *   metadata.gmail_labels contains the short-term label
 *   metadata.email_date older than retention cutoff
 *
 * After deletion, POSTs to the wiki service's /recompile endpoint so the
 * wiki's orphan sweep runs in the same daily cycle. Designed to be run
 * by Windows Task Scheduler immediately after the daily pull.
 *
 * Env:
 *   SUPABASE_URL              PostgREST proxy base (Caddy openbrain-rest)
 *   SUPABASE_SERVICE_ROLE_KEY non-secret placeholder, stripped by Caddy
 *   BRAIN_SHORT_TERM_RETENTION_DAYS  retention cutoff (default 90)
 *   BRAIN_SHORT_TERM_LABEL    holding-pen label (default brain/keep-short-term)
 *   WIKI_RECOMPILE_URL        default http://openbrain-wiki:8000/recompile
 *   MCP_ACCESS_KEY            auth header for /recompile
 *
 * CLI flags:
 *   --dry-run                 list what would be deleted, change nothing
 *   --retention-days=N        override env BRAIN_SHORT_TERM_RETENTION_DAYS
 *   --label=brain/keep-short-term  override env BRAIN_SHORT_TERM_LABEL
 *   --no-wiki-recompile       skip the POST /recompile (testing/debug only)
 */

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "local-trust";
const WIKI_URL = Deno.env.get("WIKI_RECOMPILE_URL") || "http://openbrain-wiki:8000/recompile";
const MCP_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";

interface PruneArgs {
  dryRun: boolean;
  retentionDays: number;
  label: string;
  triggerWiki: boolean;
}

function parseArgs(): PruneArgs {
  const envR = parseInt(Deno.env.get("BRAIN_SHORT_TERM_RETENTION_DAYS") || "90", 10);
  const args: PruneArgs = {
    dryRun: false,
    retentionDays: Number.isFinite(envR) && envR > 0 ? envR : 90,
    label: Deno.env.get("BRAIN_SHORT_TERM_LABEL") || "brain/keep-short-term",
    triggerWiki: true,
  };
  for (const a of Deno.args) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--retention-days=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0) args.retentionDays = n;
    } else if (a.startsWith("--label=")) {
      args.label = a.split("=")[1];
    } else if (a === "--no-wiki-recompile") {
      args.triggerWiki = false;
    }
  }
  return args;
}

// PostgREST headers — mirror pull-gmail.ts. The `apikey` value is a
// non-secret placeholder; Caddy (openbrain-rest) strips Authorization
// and PostgREST runs as the service role internally.
function pgrHeaders(prefer?: string): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
  if (prefer) h.Prefer = prefer;
  return h;
}

// Build the filter URL once and reuse it for the preview SELECT and the
// DELETE. JSONB array containment uses PostgREST's cs. operator with a
// JSON-encoded array value; the `metadata->>email_date` cast to text
// works for ISO-8601 lexicographic comparison.
function buildFilterQuery(args: PruneArgs): string {
  const cutoff = new Date(Date.now() - args.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const labelArr = encodeURIComponent(JSON.stringify([args.label]));
  const cutoffEnc = encodeURIComponent(cutoff);
  return [
    `metadata->>source=eq.gmail`,
    `metadata->gmail_labels=cs.${labelArr}`,
    `metadata->>email_date=lt.${cutoffEnc}`,
  ].join("&");
}

interface Candidate {
  id: number;
  metadata: {
    gmail_id?: string;
    email_date?: string;
    gmail_labels?: string[];
    [k: string]: unknown;
  };
  content: string;
}

async function previewCandidates(args: PruneArgs): Promise<Candidate[]> {
  const q = buildFilterQuery(args);
  const url =
    `${SUPABASE_URL}/rest/v1/thoughts?select=id,metadata,content&${q}` +
    `&order=metadata->>email_date.asc&limit=5000`;
  const res = await fetch(url, { headers: pgrHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Preview query failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}

async function deleteExpired(args: PruneArgs): Promise<number> {
  const q = buildFilterQuery(args);
  // return=representation so we get back exactly what was deleted —
  // gives us a deterministic count regardless of how many rows matched.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/thoughts?${q}&select=id`,
    { method: "DELETE", headers: pgrHeaders("return=representation") },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DELETE failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function triggerWikiRecompile(): Promise<void> {
  if (!MCP_KEY) {
    console.warn(
      "[prune] MCP_ACCESS_KEY not set; skipping wiki /recompile " +
        "(set it in .env or the scheduled task env-file).",
    );
    return;
  }
  try {
    const res = await fetch(WIKI_URL, {
      method: "POST",
      headers: { "x-brain-key": MCP_KEY, "Content-Type": "application/json" },
    });
    const body = await res.text();
    if (res.status === 202) {
      console.log(`[prune] wiki /recompile accepted: ${body}`);
    } else if (res.status === 409) {
      // A compile is already running (boot/daily/change-watch). The
      // entity-touch trigger already bumped entities.updated_at, so
      // that in-flight compile (or the next one) will pick the deletes
      // up — no need to retry.
      console.log(`[prune] wiki /recompile busy (409); in-flight compile will see the deletes.`);
    } else {
      console.error(`[prune] wiki /recompile HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`[prune] wiki /recompile call failed:`, (e as Error).message);
  }
}

async function main() {
  const args = parseArgs();

  if (!SUPABASE_URL) {
    console.error("SUPABASE_URL is required (set via env or .env file).");
    Deno.exit(1);
  }

  const cutoff = new Date(Date.now() - args.retentionDays * 24 * 60 * 60 * 1000);
  console.log(`\nGmail short-term prune`);
  console.log(`  Label:           ${args.label}`);
  console.log(`  Retention days:  ${args.retentionDays}`);
  console.log(`  Cutoff (UTC):    ${cutoff.toISOString()}`);
  console.log(`  Mode:            ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Wiki trigger:    ${args.triggerWiki && !args.dryRun ? "yes" : "no"}\n`);

  const candidates = await previewCandidates(args);
  console.log(`Found ${candidates.length} expired short-term row(s).`);

  // Sample preview so the morning log shows what got swept.
  const sample = candidates.slice(0, 10);
  for (const c of sample) {
    const subj = (c.content.match(/Subject:\s*([^|]+?)\s*\|/) || [])[1] || "(no subject)";
    const date = c.metadata?.email_date || "(no email_date)";
    const id = c.metadata?.gmail_id || "(no gmail_id)";
    console.log(`  - #${c.id}  ${date}  ${id}  ${subj.trim().slice(0, 80)}`);
  }
  if (candidates.length > sample.length) {
    console.log(`  ... and ${candidates.length - sample.length} more`);
  }

  if (args.dryRun) {
    console.log(`\nDry-run: nothing deleted. Rerun without --dry-run to apply.`);
    return;
  }

  if (candidates.length === 0) {
    console.log(`\nNothing to prune. Triggering wiki anyway (entity-touch may have queued work).`);
  } else {
    const deleted = await deleteExpired(args);
    console.log(`\nDeleted ${deleted} row(s).`);
  }

  if (args.triggerWiki) {
    await triggerWikiRecompile();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
