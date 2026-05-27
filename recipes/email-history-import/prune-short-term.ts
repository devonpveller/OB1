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

// 2-pass approach. Pass 1: SELECT all gmail rows past the cutoff —
// PostgREST can express source/date filters cleanly but JSONB array
// "any element starts with X" needs to be done in script (the cs.
// containment operator only matches exact label strings, which would
// miss sub-labels like `brain/keep-short-term/Y-12`). Pass 2: filter
// in JS by prefix match on metadata.gmail_labels, then DELETE by IDs.
//
// Matcher mirrors pull-gmail.ts pre-filter: a label is "short-term" if
// it equals args.label OR starts with args.label + "/".
function isShortTermLabel(labels: string[] | undefined, stl: string): boolean {
  if (!labels) return false;
  return labels.some((l) => l === stl || l.startsWith(stl + "/"));
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
  const cutoff = new Date(Date.now() - args.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const cutoffEnc = encodeURIComponent(cutoff);
  // Pre-filter at the DB side: only gmail rows with email_date past
  // the cutoff. The label prefix-match runs client-side below.
  const url =
    `${SUPABASE_URL}/rest/v1/thoughts?select=id,metadata,content` +
    `&metadata->>source=eq.gmail` +
    `&metadata->>email_date=lt.${cutoffEnc}` +
    `&order=metadata->>email_date.asc&limit=10000`;
  const res = await fetch(url, { headers: pgrHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Preview query failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const rows = (await res.json()) as Candidate[];
  return rows.filter((r) => isShortTermLabel(r.metadata?.gmail_labels, args.label));
}

async function deleteByIds(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  // PostgREST `in.(1,2,3)` filter; batched to keep URL length sane.
  let deleted = 0;
  const batchSize = 200;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const url =
      `${SUPABASE_URL}/rest/v1/thoughts?id=in.(${batch.join(",")})&select=id`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: pgrHeaders("return=representation"),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DELETE batch failed: HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const rows = await res.json();
    deleted += Array.isArray(rows) ? rows.length : 0;
  }
  return deleted;
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

async function main(argsOverride?: Partial<PruneArgs>) {
  const args: PruneArgs = { ...parseArgs() };
  if (argsOverride) {
    for (const [k, v] of Object.entries(argsOverride)) {
      if (v !== undefined) (args as unknown as Record<string, unknown>)[k] = v;
    }
  }

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
    const deleted = await deleteByIds(candidates.map((c) => c.id));
    console.log(`\nDeleted ${deleted} row(s).`);
  }

  if (args.triggerWiki) {
    await triggerWikiRecompile();
  }
}

// ─── Run mode: CLI one-shot vs HTTP server ──────────────────────────────────

const HAS_CLI_ARGS = Deno.args.some((a) => a.startsWith("--") && a !== "--server");
const FORCE_SERVER = Deno.args.includes("--server");
const NEXT_TRIGGER_URL = Deno.env.get("NEXT_TRIGGER_URL") || "";

async function chainTrigger(opts: { skip?: boolean } = {}): Promise<void> {
  if (opts.skip) return;
  if (!NEXT_TRIGGER_URL) return;
  try {
    const res = await fetch(NEXT_TRIGGER_URL, { method: "POST" });
    console.log(`Chain trigger ${NEXT_TRIGGER_URL} → ${res.status}`);
  } catch (err) {
    console.warn(`Chain trigger failed for ${NEXT_TRIGGER_URL}: ${err}`);
  }
}

function isNoopInvocation(override?: Partial<PruneArgs>): boolean {
  if (override?.dryRun) return true;
  if (Deno.args.includes("--dry-run")) return true;
  return false;
}

if (HAS_CLI_ARGS && !FORCE_SERVER) {
  // One-shot mode (legacy / ad-hoc).
  mainCli();
} else {
  // HTTP-server mode (default for the always-on container).
  startServer();
}

function mainCli() {
  const noChain = Deno.args.includes("--no-chain");
  main()
    .then(() => chainTrigger({ skip: noChain || isNoopInvocation() }))
    .catch((err) => {
      console.error("Fatal error:", err);
      Deno.exit(1);
    });
}

function startServer() {
  const PORT = parseInt(Deno.env.get("PRUNE_PORT") || "8080", 10);
  let running = false;
  let lastRunAt: string | null = null;
  let lastError: string | null = null;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        service: "openbrain-gmail-prune",
        running,
        last_run_at: lastRunAt,
        last_error: lastError,
      });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (running) {
        return jsonResponse({ started: false, reason: "run already in progress" }, 409);
      }
      let bodyOverride: (Partial<PruneArgs> & { chain?: boolean }) | undefined;
      try {
        const text = await req.text();
        if (text.trim().length > 0) bodyOverride = JSON.parse(text);
      } catch (err) {
        return jsonResponse({ started: false, reason: `bad JSON body: ${err}` }, 400);
      }
      const skipChain =
        bodyOverride?.chain === false || isNoopInvocation(bodyOverride);
      const cliOverride = bodyOverride
        ? Object.fromEntries(
            Object.entries(bodyOverride).filter(([k]) => k !== "chain"),
          ) as Partial<PruneArgs>
        : undefined;
      running = true;
      lastError = null;
      (async () => {
        try {
          await main(cliOverride);
          await chainTrigger({ skip: skipChain });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          console.error(`Prune run failed: ${lastError}`);
        } finally {
          running = false;
          lastRunAt = new Date().toISOString();
        }
      })();
      return jsonResponse({ started: true, chain_will_fire: !skipChain }, 202);
    }

    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  });

  console.log(`openbrain-gmail-prune listening on :${PORT}`);
}

