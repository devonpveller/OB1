// deno test src/fetch-gate/fetch_gate_integration_test.ts - rw-workbench-fetch-posture over REAL
// workbenches and a database: the URL import, the source re-fetch and the held-link replace each make
// ONE call to the (stub) search gate's POST /v1/fetch and never contact the target themselves.
//
// SKIPPED unless FETCH_GATE_TEST_BASE is set. contract-test/run-fetch-gate-tests.ps1 sets it on a
// DISPOSABLE internal network: the real initdb chain + fixtures.sql, a stub embedder, the lab target
// (contract-test/stub-target.ts, logs every caller) and the stub gate (contract-test/stub-gate.ts).
// Never point it at a live stack.
//
// Environment: FETCH_GATE_TEST_BASE (the configured workbench), FETCH_GATE_TEST_NOKEY_BASE (gate URL set,
// WORKBENCH_GATE_KEY blank), FETCH_GATE_TEST_NOGATE_BASE (key set, the gate name resolves nowhere),
// FETCH_GATE_TEST_KEY (the X-Brain-Key), FETCH_GATE_TEST_TARGET (http://stub-target:8080),
// FETCH_GATE_TEST_GATE (http://stub-gate:8080), FETCH_GATE_TEST_GATE_IP, FETCH_GATE_TEST_WB_IPS (comma),
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("FETCH_GATE_TEST_BASE") ?? "").replace(/\/+$/, "");
const NOKEY = (Deno.env.get("FETCH_GATE_TEST_NOKEY_BASE") ?? "").replace(/\/+$/, "");
const NOGATE = (Deno.env.get("FETCH_GATE_TEST_NOGATE_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("FETCH_GATE_TEST_KEY") ?? "";
const TARGET = (Deno.env.get("FETCH_GATE_TEST_TARGET") ?? "http://stub-target:8080").replace(/\/+$/, "");
const GATE = (Deno.env.get("FETCH_GATE_TEST_GATE") ?? "http://stub-gate:8080").replace(/\/+$/, "");
const GATE_IP = Deno.env.get("FETCH_GATE_TEST_GATE_IP") ?? "";
const WB_IPS = (Deno.env.get("FETCH_GATE_TEST_WB_IPS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;

// the gate's own texts (search/gateway/src/gateway/egress/guard.py REASONS, routes/gate.py)
const REFUSED_TARGET = "refused: the URL is not an allowed target (scheme, credentials, port, internal name or non-public address)";
const REFUSED_REDIRECT = "refused: a redirect led to a target that is not allowed";
const WITHHELD = "withheld: intake did not label this page clean";
const ERROR_HTTP = "error: the site answered with an HTTP error status";

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
const uid = () => crypto.randomUUID().slice(0, 8);

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function importUrl(base: string, url: string) {
  const fd = new FormData();
  fd.append("url", url);
  const r = await fetch(base + "/workbench/import", { method: "POST", headers: { "x-brain-key": KEY }, body: fd });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function waitJob(id: string) {
  for (let i = 0; i < 120; i++) {
    const j = await call(BASE, "GET", `/workbench/jobs/${id}`);
    if (j.json.job?.status === "done" || j.json.job?.status === "failed") return j.json.job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} never finished`);
}

type TargetHit = { path: string; from: string };
type GateHit = { from: string; auth_ok: boolean; body: { url?: string } | null };
const targetLog = async () => (await (await fetch(`${TARGET}/__log`)).json()) as TargetHit[];
const gateLog = async () => (await (await fetch(`${GATE}/__log`)).json()) as GateHit[];

// What happened at the target and the gate while `fn` ran (the logs only grow).
async function observe(fn: () => Promise<void>) {
  const [t0, g0] = [(await targetLog()).length, (await gateLog()).length];
  await fn();
  return { target: (await targetLog()).slice(t0), gate: (await gateLog()).slice(g0) };
}

// acceptance 1: the target saw no request from a workbench; every gate call is POST /v1/fetch {url} with the key
function assertOnlyGate(seen: { target: TargetHit[]; gate: GateHit[] }, url: string, gateCalls = 1) {
  const fromWb = seen.target.filter((h) => h.from !== GATE_IP || WB_IPS.includes(h.from));
  assertEquals(fromWb, [], `the target was contacted by a workbench: ${JSON.stringify(fromWb)}`);
  assertEquals(seen.gate.length, gateCalls, `gate calls: ${JSON.stringify(seen.gate)}`);
  for (const g of seen.gate) {
    assert(WB_IPS.includes(g.from), `a gate call from ${g.from}, not a workbench`);
    assertEquals(g.auth_ok, true, "the call carries the workbench's Bearer key");
    assertEquals(g.body, { url });
  }
}

async function sourceByUrl(url: string) {
  return (await sql<{ id: string; title: string; content: string; metadata: any }>(
    `SELECT id::text AS id, title, content, metadata FROM public.sources WHERE url = $1`, [url]))[0] ?? null;
}

// ── 1 + 5: the URL import ──────────────────────────────────────────────────────────────────────
t("A1/A5: a URL import is ONE /v1/fetch call with the key; the target sees only the gate; the source is the gate's text", async () => {
  assert(GATE_IP && WB_IPS.length === 3, "the runner passes the gate and workbench addresses");
  const url = `${TARGET}/page/${uid()}`;
  let job: any;
  const seen = await observe(async () => {
    const r = await importUrl(BASE, url);
    assertEquals(r.status, 202, r.text);
    job = await waitJob(r.json.job_id);
  });
  assertOnlyGate(seen, url);
  assert(seen.target.length >= 1 && seen.target.every((h) => h.from === GATE_IP), "the gate fetched it");
  assertEquals(job.status, "done", JSON.stringify(job));
  const s = (await sourceByUrl(url))!;
  assertEquals(s.id, job.source_id);
  assert(s.content.startsWith("screened: "), `the gate's text: ${s.content}`);
  assert(!/[<>]/.test(s.content) && !s.content.includes("window.evil"), `raw HTML stored: ${s.content}`);
  assertEquals(s.title, url, "the import's title is the URL, as before");
  assertEquals(s.metadata.media_type, "text/html");
  assertEquals(s.metadata.fetch, { via: "search-gate", origin_url: url, final_url: url, redirects: [], http_status: 200, label: "clean" });
});

t("A5: dedupe still holds - the same URL again is a duplicate of the one source (one more gate call, no new row)", async () => {
  const url = `${TARGET}/plain/${uid()}`;
  const a = await importUrl(BASE, url);
  const ja = await waitJob(a.json.job_id);
  const seen = await observe(async () => {
    const b = await importUrl(BASE, url);
    assertEquals(b.status, 202, b.text);
    const jb = await waitJob(b.json.job_id);
    assertEquals([jb.status, jb.duplicate, jb.source_id], ["done", true, ja.source_id]);
  });
  assertOnlyGate(seen, url);
  assertEquals((await sql(`SELECT 1 FROM public.sources WHERE url = $1`, [url])).length, 1);
  assertEquals((await sourceByUrl(url))!.content, `plain ${url.split("/plain/")[1]}`, "a text/plain page is the gate's text as is");
  assertEquals((await sourceByUrl(url))!.metadata.media_type, "text/plain");
});

// ── 2: a 3xx is the gate's business ────────────────────────────────────────────────────────────
t("A2: a 3xx chain at the target: one /v1/fetch call; the hops and final URL are on the source; the workbench follows nothing", async () => {
  const x = uid();
  const url = `${TARGET}/chain/${x}`;
  let job: any;
  const seen = await observe(async () => {
    const r = await importUrl(BASE, url);
    assertEquals(r.status, 202, r.text);
    job = await waitJob(r.json.job_id);
  });
  assertOnlyGate(seen, url);
  assertEquals(seen.target.map((h) => h.path), [`/chain/${x}`, `/redirect/${x}`, `/page/${x}`], "the gate walked the hops");
  const s = (await sourceByUrl(url))!;
  assertEquals(s.id, job.source_id);
  assertEquals(s.metadata.fetch.redirects, [`${TARGET}/redirect/${x}`, `${TARGET}/page/${x}`]);
  assertEquals(s.metadata.fetch.final_url, `${TARGET}/page/${x}`);
  assertEquals(s.metadata.fetch.origin_url, url);
  assert(s.content.includes(`raw page ${x}`) && s.content.startsWith("screened: "));
});

t("A2/A3: a redirect the gate refuses: the refusal, unchanged; nothing stored; no second fetch", async () => {
  const url = `${TARGET}/redirect-out/${uid()}`;
  const seen = await observe(async () => {
    const r = await importUrl(BASE, url);
    assertEquals(r.status, 422, r.text);
    assertEquals(r.json.error, REFUSED_REDIRECT);
    assertEquals(r.json.gate, { status: "refused", reason: REFUSED_REDIRECT, http_status: null });
    assertEquals(r.json.job_id, undefined, "no job");
  });
  assertOnlyGate(seen, url);
  assertEquals(seen.target.length, 1, "the gate's one request; nobody followed the Location");
  assertEquals(await sourceByUrl(url), null);
});

// ── 3: refused / withheld / error ──────────────────────────────────────────────────────────────
for (const [kind, reason, code] of [["refuse", REFUSED_TARGET, 422], ["withheld", WITHHELD, 422], ["error", ERROR_HTTP, 502]] as const) {
  t(`A3: ${kind} - the import answers ${code} with the gate's reason unchanged; no job, no source`, async () => {
    const url = `${TARGET}/${kind}/${uid()}`;
    const jobs0 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_jobs`))[0].n;
    const seen = await observe(async () => {
      const r = await importUrl(BASE, url);
      assertEquals(r.status, code, r.text);
      assertEquals(r.json.error, reason);
      assertEquals(r.json.gate.reason, reason);
    });
    assertOnlyGate(seen, url);
    assertEquals(await sourceByUrl(url), null, "nothing stored");
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_jobs`))[0].n, jobs0, "no job row");
  });

  t(`A3: ${kind} - the re-fetch answers ${code} with the gate's reason unchanged; the source is not touched`, async () => {
    const url = `${TARGET}/${kind}/${uid()}`;
    const id = crypto.randomUUID();
    await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, 'kept', 'keep me', 'web_article')`, [id, url]);
    const seen = await observe(async () => {
      const r = await call(BASE, "POST", `/workbench/sources/${id}/refetch`);
      assertEquals(r.status, code, r.text);
      assertEquals(r.json.error, reason);
    });
    assertOnlyGate(seen, url);
    const s = (await sql<{ content: string; last_edited_at: Date | null; metadata: any }>(
      `SELECT content, last_edited_at, metadata FROM public.sources WHERE id = $1`, [id]))[0];
    assertEquals([s.content, s.last_edited_at, s.metadata?.fetch], ["keep me", null, undefined], "not overwritten");
    assertEquals((await sql(`SELECT 1 FROM public.source_revisions WHERE source_id = $1`, [id])).length, 0, "no revision");
  });
}

// ── 5: the re-fetch, clean ─────────────────────────────────────────────────────────────────────
t("A1/A5: a re-fetch is ONE /v1/fetch call; the head becomes the gate's new text; the revision commits as before", async () => {
  const x = uid();
  const url = `${TARGET}/live/${x}`;
  const a = await importUrl(BASE, url);
  const ja = await waitJob(a.json.job_id);
  assertEquals(ja.status, "done", JSON.stringify(ja));
  assert((await sourceByUrl(url))!.content.includes(`version 1 of ${x}`));
  const seen = await observe(async () => {
    const r = await call(BASE, "POST", `/workbench/sources/${ja.source_id}/refetch`);
    assertEquals(r.status, 200, r.text);
    assert(r.json.source.content.includes(`version 2 of ${x}`), r.text);
  });
  assertOnlyGate(seen, url);
  const s = (await sourceByUrl(url))!;
  assert(s.content.startsWith("screened: ") && !/[<>]/.test(s.content), s.content);
  assertEquals(s.metadata.media_type, "text/html");
  assertEquals(s.metadata.fetch.origin_url, url);
  // the compile-time commit (P4.7): the refetched head becomes revision 2, stamped 'refetch'
  const c = await call(BASE, "POST", `/workbench/source-commit`);
  assertEquals(c.status, 200, c.text);
  assert(c.json.committed >= 1, c.text);
  const revs = (await call(BASE, "GET", `/workbench/sources/${ja.source_id}/revisions`)).json.revisions as any[];
  const byRev = revs.map((r) => [r.revision, r.edited_by]).sort((p, q) => p[0] - q[0]);
  assertEquals(byRev, [[1, "original"], [2, "refetch"]], JSON.stringify(revs));
});

// ── 4: fail closed ─────────────────────────────────────────────────────────────────────────────
t("A4: WORKBENCH_GATE_KEY blank - the import and the re-fetch answer the stated 503 and fetch nothing", async () => {
  const url = `${TARGET}/page/${uid()}`;
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, 'kept', 'keep me', 'web_article')`, [id, url]);
  const seen = await observe(async () => {
    const r = await importUrl(NOKEY, url);
    assertEquals(r.status, 503, r.text);
    assert(String(r.json.error).startsWith("fetch gate not configured"), r.text);
    const f = await call(NOKEY, "POST", `/workbench/sources/${id}/refetch`);
    assertEquals(f.status, 503, f.text);
    assert(String(f.json.error).startsWith("fetch gate not configured"), f.text);
  });
  assertEquals([seen.target, seen.gate], [[], []], "no fetch at all");
  assertEquals((await sql<{ content: string }>(`SELECT content FROM public.sources WHERE id = $1`, [id]))[0].content, "keep me");
});

t("A4: the gate unreachable - the stated 503, no direct fallback", async () => {
  const url = `${TARGET}/page/${uid()}`;
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, 'kept', 'keep me', 'web_article')`, [id, url]);
  const seen = await observe(async () => {
    const r = await importUrl(NOGATE, url);
    assertEquals(r.status, 503, r.text);
    assert(String(r.json.error).startsWith("fetch gate unavailable"), r.text);
    const f = await call(NOGATE, "POST", `/workbench/sources/${id}/refetch`);
    assertEquals(f.status, 503, f.text);
    assert(String(f.json.error).startsWith("fetch gate unavailable"), f.text);
  });
  assertEquals(seen.target, [], "no direct fallback");
  assertEquals(await sourceByUrl(url).then((s) => s?.content), "keep me");
});

t("A2/A4: the gate answering a 3xx itself, or a 500 - one call, the stated 503, the Location never requested", async () => {
  for (const kind of ["gate-redirect", "gate-500"]) {
    const url = `${TARGET}/${kind}/${uid()}`;
    const seen = await observe(async () => {
      const r = await importUrl(BASE, url);
      assertEquals(r.status, 503, r.text);
      assert(String(r.json.error).startsWith("fetch gate unavailable"), r.text);
    });
    assertOnlyGate(seen, url);
    assertEquals(seen.target, [], `${kind}: the target was never contacted`);
    assertEquals(await sourceByUrl(url), null);
  }
});

// ── 8: the held-link replace (P2b) ─────────────────────────────────────────────────────────────
const D = "/workbench/documents";
async function heldLink(base: string, url: string) {
  const d = await call(base, "POST", D, { title: `Fetch gate ${uid()}`, body: "", idea: `fetch gate idea ${uid()}` });
  assertEquals(d.status, 201, d.text);
  const path = d.json.path as string;
  const st = await call(base, "POST", `${D}/refinery/start`, { path });
  assertEquals(st.status, 200, st.text);
  const add = await call(base, "POST", `${D}/user-sources`, { path, title: "Linked held", content: "version one", url });
  assertEquals(add.status, 201, add.text);
  return { path, hid: add.json.source.source_id as string };
}
const heldState = async (id: string) =>
  (await sql<{ revision: number; content_hash: string }>(`SELECT revision, content_hash FROM public.held_sources WHERE id = $1`, [id]))[0];

t("A8: a held link's replace is ONE /v1/fetch call; the gate's clean text is the new revision", async () => {
  const url = `${TARGET}/page/${uid()}`;
  const { path, hid } = await heldLink(BASE, url);
  const seen = await observe(async () => {
    const r = await call(BASE, "POST", `${D}/user-sources/${hid}/replace`, { path });
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json.kind, r.json.changed, r.json.revision], ["link", true, 2]);
  });
  assertOnlyGate(seen, url);
  const md5 = (await sql<{ h: string }>(`SELECT md5($1) AS h`, [`screened: raw page ${url.split("/page/")[1]}`]))[0].h;
  assertEquals((await heldState(hid)).content_hash, md5, "the held source's contents are the gate's text");
});

t("A8: a held link the gate refuses - its reason unchanged, nothing overwritten; no key / no gate = the stated 503", async () => {
  const url = `${TARGET}/refuse/${uid()}`;
  const { path, hid } = await heldLink(BASE, url);
  const before = await heldState(hid);
  const seen = await observe(async () => {
    const r = await call(BASE, "POST", `${D}/user-sources/${hid}/replace`, { path });
    assertEquals(r.status, 422, r.text);
    assertEquals(r.json.error, REFUSED_TARGET);
  });
  assertOnlyGate(seen, url);
  assertEquals(await heldState(hid), before, "not overwritten");
  const url2 = `${TARGET}/page/${uid()}`;
  for (const [base, stated] of [[NOKEY, "fetch gate not configured"], [NOGATE, "fetch gate unavailable"]] as const) {
    const h = await heldLink(base, url2);
    const b2 = await heldState(h.hid);
    const s2 = await observe(async () => {
      const r = await call(base, "POST", `${D}/user-sources/${h.hid}/replace`, { path: h.path });
      assertEquals(r.status, 503, r.text);
      assert(String(r.json.error).startsWith(stated), r.text);
    });
    assertEquals(s2.target, [], "no fetch");
    assertEquals(await heldState(h.hid), b2, "not overwritten");
  }
});
