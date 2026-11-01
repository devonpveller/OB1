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

// rw-p5a-intake: POST /intake/fetch, the research service's proxy-bound fetch of a user's add, as the real
// service answers it (intake-fetch.ts) - the workspace's caller key only - for links on the lab's pretend web:
//   *.pdf -> a PDF's bytes; youtube.com / youtu.be -> a transcript; /slow/ -> a web page after 4 s;
//   /refuse/ -> refused_target; /boom/ -> a 500 whose body is a marker (the workbench must not repeat it);
//   anything else -> a web page whose text names the link. A declared type the link is not = type_mismatch.
// Nothing is fetched: this stub stands in for the fetch, and records what it was asked (GET /requests).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function intakeFetch(body: { url?: string; content_type?: string }) {
  const link = String(body.url ?? "");
  let u: URL;
  try { u = new URL(link); } catch { return Response.json({ error: "refused_target", detail: "not a URL" }, { status: 422 }); }
  const yt = /(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname);
  const type = yt ? "youtube_transcript" : u.pathname.endsWith(".pdf") ? "pdf" : "web_article";
  if (u.pathname.startsWith("/refuse/")) return Response.json({ error: "refused_target", detail: "refused: a private address" }, { status: 422 });
  if (u.pathname.startsWith("/boom/")) return Response.json({ error: "STUB-MARKER /var/lib/stub password=hunter2" }, { status: 500 });
  if (body.content_type && body.content_type !== type) return Response.json({ error: "type_mismatch", detail: `this link is a ${type}` }, { status: 422 });
  if (u.pathname.startsWith("/slow/")) await sleep(4000);
  const base = { ok: true, url: link, final_url: link, redirects: [], egress: "proxy (lab stub)" };
  if (type === "pdf") {
    return Response.json({ ...base, content_type: "pdf", mime: "application/pdf", title: u.pathname.split("/").pop(), bytes_b64: btoa(`%PDF-1.4\n% lab pdf for ${link}\n`) });
  }
  if (type === "youtube_transcript") {
    return Response.json({ ...base, content_type: type, mime: "text/plain", title: `Video ${u.searchParams.get("v") ?? u.pathname}`, text: `transcript of ${link}: a one minute tone at 100 Hz` });
  }
  return Response.json({ ...base, content_type: type, mime: "text/html", title: `Page ${u.pathname}`, text: `the text of ${link}, as the research service extracted it` });
}

Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/requests") return Response.json({ requests: received });
  if (req.method === "POST" && url.pathname === "/intake/fetch") {
    const caller = callers.find((c) => c.key === req.headers.get("x-brain-key"));
    if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (caller.origin !== "workspace") return Response.json({ error: "the intake fetch is the workspace's (its caller key)" }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    received.push({ caller: caller.name, path: "/intake/fetch", body });
    return await intakeFetch(body);
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
