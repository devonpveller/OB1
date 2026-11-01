// A stand-in for the research service's POST /research, for the disposable workspace test network
// only (rw-p2b-workspace). Like the real service it decides the origin from the CALLER'S KEY
// (STUB_CALLERS="name=origin:key;..."), never the body, and stores the job in research_jobs - so the
// workbench's "queue research from the document" is tested end to end against the database.
// GET /requests answers what it received (headers named, the key never echoed).
import { Pool } from "postgres";

const callers = (Deno.env.get("STUB_CALLERS") ?? "").split(";").filter(Boolean).map((e) => {
  const m = /^([^=]+)=([^:]+):(.+)$/.exec(e)!;
  return { name: m[1], origin: m[2], key: m[3] };
});
const pool = new Pool({
  hostname: Deno.env.get("DB_HOST")!, port: 5432, database: "openbrain",
  user: Deno.env.get("DB_USER") ?? "postgres", password: Deno.env.get("DB_PASSWORD") ?? "",
}, 2, true);
const received: unknown[] = [];

Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/requests") return Response.json({ requests: received });
  // rw-p8a2-cleanup: the D15 pre-ingestion score the admission gate asks for (RESEARCH_SCORER_URL), so a
  // tombstoned URL's return can clear (or miss) its floor in the lab. A URL holding "score=high" clears
  // the 0.5 floor at 0.9; any other scores 0.2. Only a configured caller key is answered.
  if (req.method === "POST" && url.pathname === "/research/credibility/score") {
    if (!callers.some((c) => c.key === req.headers.get("x-brain-key"))) return Response.json({ error: "unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({})) as { url?: string };
    const high = String(b.url ?? "").includes("score=high");
    return Response.json({ available: true, value: high ? 0.9 : 0.2, floor: 0.5, version: "stub-score-v2", reason: "lab stub scorer" });
  }
  if (req.method !== "POST" || url.pathname !== "/research") return new Response("not found", { status: 404 });
  const caller = callers.find((c) => c.key === req.headers.get("x-brain-key"));
  if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  received.push({ caller: caller.name, body });
  const c = await pool.connect();
  try {
    const r = await c.queryObject<{ id: string }>(
      `INSERT INTO public.research_jobs (status, origin, query, options, caller, origin_claimed, inlet_ref)
       VALUES ('queued', $1, $2, $3::jsonb, $4, $5, $6::jsonb) RETURNING id::text AS id`,
      [caller.origin, String(body.query), JSON.stringify(body.gap_research ? { gap_research: body.gap_research } : {}), caller.name,
        body.origin && body.origin !== caller.origin ? String(body.origin) : null, body.inlet_ref ? JSON.stringify(body.inlet_ref) : null],
    );
    return Response.json({ job_id: r.rows[0].id, status: "queued" }, { status: 202 });
  } finally {
    c.release();
  }
});
