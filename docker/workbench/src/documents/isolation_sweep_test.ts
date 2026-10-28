// deno test src/documents/isolation_sweep_test.ts - the route-wide isolation sweep (rw-p2b-workspace
// round 2, tester attempt 1 F1-F6: leaks hide in routes and nested fields nobody listed by hand).
//
// User B plants unique markers in everything per-user: a document's title and body, its idea text,
// the original research prompt, its refinery id and the document's path (a listing-failure
// notification, a reference into a shared source, a held source in the refinery, a committed
// revision). Then, as user A, EVERY route the app registers (enumerated from the router itself:
// src/app.ts, no hand list) is called with B's ids and paths wherever it can take one - every path
// parameter, the usual query and body fields - directly on the workbench AND through the viewer's
// /workbench forwarder (the edge's one port). Every full response body (and its Location) is
// searched for every marker the request did not itself carry. Zero hits; shared knowledge still
// answers both users alike; B's document is unchanged afterwards.
//
// SKIPPED unless SWEEP_BASE is set. contract-test/run-workspace-tests.ps1 runs it LAST in its
// disposable lab (it calls mutating routes with B's ids). Never point it at a live stack.
// Environment: SWEEP_BASE (the workbench), SWEEP_VIEWER (the viewer), DOCS_TEST_KEY, DOCS_TEST_VAULT,
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser: the fault trigger), plus the workbench's own DB_*
// / WIKI_GIT_DIR so src/app.ts can be imported to read its route table (it is never served here).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("SWEEP_BASE") ?? "").replace(/\/+$/, "");
const VIEWER = (Deno.env.get("SWEEP_VIEWER") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !VIEWER || !HOST;
const FX_ACTIVE = "11111111-1111-4111-8111-111111111111";

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const pool = new Pool({
    hostname: HOST!, port: 5432, database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 1, true);
  const c = await pool.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
    await pool.end();
  }
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  // bounded: a stream (SSE) or a hung route must not stall the sweep; its partial body is still searched
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let r: Response;
  try {
    r = await fetch(base + path, {
    method, redirect: "manual", signal: ctl.signal,
    headers: { "content-type": "application/json", "x-brain-key": KEY, ...headers },
    body: body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  } catch {
    clearTimeout(timer);
    return { status: 0, json: {} as Record<string, any>, text: "", location: "" };
  }
  let text = "";
  if (method !== "HEAD") {
    const reader = r.body?.getReader();
    const dec = new TextDecoder();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } catch { /* aborted mid-stream: keep what arrived */ }
  }
  clearTimeout(timer);
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, location: r.headers.get("location") ?? "" };
}

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

Deno.test({ name: "isolation sweep: as user A, every route the app registers shows nothing of user B's private context", ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const B = { [SUB_HEADER]: `sweep-bee-${rnd()}` };
  const M = {
    title: `TitleSecret${rnd()}X`, body: `BodySecret${rnd()}`, idea: `IdeaSecret${rnd()}`, prompt: `PromptSecret${rnd()}`,
  };
  const wb = (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => call(BASE, m, p, b, h);
  // ── B plants ─────────────────────────────────────────────────────────────────────────────────
  const made = await wb("POST", "/workbench/documents", { title: M.title }, B);
  assertEquals(made.status, 201, made.text);
  const bPath: string = made.json.path;
  const f = await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B);
  const put = await wb("PUT", `/workbench/documents/file?path=${encodeURIComponent(bPath)}&commit=1`,
    { content: `${f.json.content}\n${M.body} cites [[source:${FX_ACTIVE}|the shared source]].\n`, if_match: f.json.hash }, B);
  assert(put.status === 200 || put.status === 207, put.text);
  const prop = await wb("POST", "/workbench/documents/property", { path: bPath, key: "idea", value: M.idea }, B);
  assert(prop.status < 300, prop.text);
  const start = await wb("POST", "/workbench/documents/refinery/start", { path: bPath }, B);
  assert(start.status < 300, start.text);
  const st = await wb("GET", `/workbench/documents/state?path=${encodeURIComponent(bPath)}`, undefined, B);
  const bRefinery: string = st.json.refinery?.id;
  assert(bRefinery, `B's refinery: ${st.text}`);
  const research = await wb("POST", "/workbench/documents/research", { path: bPath, query: M.prompt, kind: "research" }, B);
  assertEquals(research.status, 202, research.text);
  const bJob: string = research.json.job_id;
  const held = await wb("POST", "/workbench/documents/user-sources", { refinery_id: bRefinery, title: "sweep held source", content: "shared held text for the sweep" }, B);
  assert(held.status < 300, held.text);
  const bHeld: string = held.json.source_id ?? held.json.id ?? held.json.held?.id ?? "";
  // a listing that cannot be updated: B's notification (entity document:<B path>)
  await sql(`CREATE OR REPLACE FUNCTION public.p2b_sweep_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sweep fault'; END $$`);
  await sql(`CREATE TRIGGER p2b_sweep_fault BEFORE INSERT OR UPDATE ON public.user_document_listings FOR EACH ROW EXECUTE FUNCTION public.p2b_sweep_fault()`);
  try {
    const f2 = await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B);
    const faulted = await wb("PUT", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, { content: `${f2.json.content}\nmore ${M.body}\n`, if_match: f2.json.hash }, B);
    assertEquals(faulted.status, 207, faulted.text);
  } finally {
    await sql(`DROP TRIGGER IF EXISTS p2b_sweep_fault ON public.user_document_listings`);
    await sql(`DROP FUNCTION IF EXISTS public.p2b_sweep_fault()`);
  }
  // the reconcile repairs B's listing when B's workspace next connects; B's file as it now stands
  await wb("GET", `/workbench/contract/documents`, undefined, B);
  const before = await Deno.readTextFile(`${VAULT}/${bPath}`);
  const markers: Record<string, string> = { ...M, path: bPath, refinery: bRefinery };

  // ── the route table, from the router ─────────────────────────────────────────────────────────
  // a computed specifier: the build gate type-checks this file without the runtime /recipes mount
  const { app } = await import(new URL("../app.ts", import.meta.url).href);
  const seen = new Set<string>();
  const routes = (app.routes as { method: string; path: string }[])
    .filter((r) => !r.path.endsWith("*") && r.method !== "ALL")
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  assert(routes.length > 50, `the router lists ${routes.length} routes`);
  const ids = [bPath, bRefinery, bJob, bHeld].filter(Boolean);
  const fill = (path: string, v: string) =>
    path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, _n, re) => (re && re.includes(".")) ? v : encodeURIComponent(v));
  const query = (v: string) => new URLSearchParams({
    path: bPath, ref: bPath, from: bPath, id: v, idea_id: bRefinery, refinery_id: bRefinery, job_id: bJob,
    source_id: bHeld || v, kind: "user_document", holder_kind: "user_document", format: "md", limit: "500", q: "fixture",
  }).toString();
  const body = (v: string) => ({
    path: bPath, ref: bPath, from: bPath, to: bPath, id: v, refinery_id: bRefinery, idea_id: bRefinery, job_id: bJob,
    source_id: bHeld || v, holder: { kind: "user_document", ref: bPath }, holder_kind: "user_document", holder_ref: bPath,
    title: "sweep", content: "sweep",
  });
  const hits: string[] = [];
  let calls = 0;
  for (const r of routes) {
    const values = r.path.includes(":") ? ids : [bRefinery];
    for (const v of values) {
      const url = `${fill(r.path, v)}?${query(v)}`;
      const reqBody = body(v);
      const sent = url + JSON.stringify(reqBody);
      // GET-like through both doors; a mutating call once, through the viewer (the edge's door)
      const doors = ["GET", "HEAD"].includes(r.method) ? [BASE, VIEWER] : [VIEWER];
      for (const door of doors) {
        calls++;
        const res = await call(door, r.method, url, reqBody);
        const out = res.text + "\n" + res.location;
        for (const [name, m] of Object.entries(markers)) {
          if (!m || sent.includes(m) || sent.includes(encodeURIComponent(m))) continue; // its own echo is no leak
          if (out.includes(m)) hits.push(`HIT ${name} ${r.method} ${r.path} (${door === BASE ? "workbench" : "viewer"}) -> ${res.status}`);
        }
      }
    }
  }
  // and every read route BARE (no B id anywhere in the request): then B's path and refinery id are
  // markers too - a list, a stream or a count must not name another user's document or refinery
  for (const r of routes.filter((x) => ["GET", "HEAD"].includes(x.method))) {
    const url = `${fill(r.path, FX_ACTIVE)}?limit=500&q=fixture`;
    for (const door of [BASE, VIEWER]) {
      calls++;
      const res = await call(door, r.method, url);
      const out = res.text + "\n" + res.location;
      for (const [name, m] of Object.entries(markers)) {
        if (m && out.includes(m)) hits.push(`HIT ${name} ${r.method} ${r.path} bare (${door === BASE ? "workbench" : "viewer"}) -> ${res.status}`);
      }
    }
  }
  console.log(`sweep: ${routes.length} routes, ${calls} calls, ${hits.length} hits`);
  for (const h of [...new Set(hits)]) console.log(`  ${h}`);
  // shared knowledge answers both users alike
  // (the fixture source may have been changed by A's mutating calls - shared, so alike for both)
  for (const p of [`/workbench/contract/sources/${FX_ACTIVE}`, `/workbench/contract/search?q=fixture`, `/workbench/contract/sources?limit=50`]) {
    const a = await wb("GET", p);
    const b = await wb("GET", p, undefined, B);
    assertEquals(a.status, b.status, `${p}: ${a.status} ${b.status}`);
    assertEquals(a.text, b.text, `${p}: shared knowledge reads the same for both users`);
  }
  assertEquals((await wb("GET", `/workbench/contract/search?q=fixture`)).status, 200, "shared search answers");
  // B's document is B's: unchanged by A's calls, and B still reads it
  assertEquals(await Deno.readTextFile(`${VAULT}/${bPath}`), before, "user A's calls left B's document unchanged");
  assertEquals((await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B)).status, 200);
  assertEquals([...new Set(hits)], [], "no response to user A carries anything of user B's private context");
} });
