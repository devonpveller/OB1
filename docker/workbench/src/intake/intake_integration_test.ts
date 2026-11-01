// deno test src/intake/intake_integration_test.ts - the intake and queue panel's server (rw-p5a-intake) over a
// REAL workbench and database, two users (the identity header) and Open WebUI's service key.
//
// SKIPPED unless INTAKE_TEST_BASE is set. contract-test/run-workspace-tests.ps1 sets it to the :wt workbench on its
// DISPOSABLE internal network (the real initdb chain, fixtures.sql, a stub embedder, the stub research service -
// whose POST /intake/fetch stands in for the research service's proxy-bound fetch - a stub extractor, the stub
// search gate). Never point it at a live stack: it writes documents, jobs and queue rows.
//
// Environment: INTAKE_TEST_BASE, INTAKE_TEST_KEY (the door key), INTAKE_TEST_OWUI_KEY (Open WebUI's
// WORKSPACE_SERVICE_KEYS key), INTAKE_TEST_RESEARCH (the stub research service), INTAKE_TEST_GATE (the stub gate),
// DOCS_TEST_SUB_HEADER (default X-Test-Sub), CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("INTAKE_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("INTAKE_TEST_KEY") ?? "";
const OWUI_KEY = Deno.env.get("INTAKE_TEST_OWUI_KEY") ?? "";
const RS = (Deno.env.get("INTAKE_TEST_RESEARCH") ?? "").replace(/\/+$/, "");
const GATE = (Deno.env.get("INTAKE_TEST_GATE") ?? "").replace(/\/+$/, "");
const SUB = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `intake-ann-${rnd()}`;
const Bsub = `intake-bob-${rnd()}`;
const OPERATOR = "operator"; // the lab's default identity (no header): who owns the ownerless jobs

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "" }, 1, true);
  const c = await pool.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
    await pool.end();
  }
}

async function call(method: string, path: string, opts: { as?: string | null; body?: unknown; form?: FormData; key?: string; obo?: string } = {}) {
  const headers: Record<string, string> = { "x-brain-key": opts.key ?? KEY };
  if (opts.as) headers[SUB] = opts.as;
  if (opts.obo !== undefined) headers["x-on-behalf-of"] = opts.obo;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const r = await fetch(BASE + path, { method, headers, body });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// a user's document with an idea and its refinery started
async function refineryOf(as: string, title: string) {
  const made = await call("POST", "/workbench/documents", { as, body: { title } });
  assertEquals(made.status, 201, made.text);
  const path: string = made.json.path;
  const prop = await call("POST", "/workbench/documents/property", { as, body: { path, key: "idea", value: `idea of ${title}` } });
  assert(prop.status < 300, prop.text);
  const start = await call("POST", "/workbench/documents/refinery/start", { as, body: { path } });
  assert(start.status < 300, start.text);
  const st = await call("GET", `/workbench/documents/state?path=${encodeURIComponent(path)}`, { as });
  return { path, refinery: st.json.refinery?.id as string };
}

async function settled(as: string | null, kind: string, id: string, opts: { key?: string; obo?: string } = {}, ms = 20000) {
  const until = Date.now() + ms;
  let last: Record<string, any> = {};
  while (Date.now() < until) {
    const r = await call("GET", `/workbench/intake/jobs/${kind}/${id}`, { as, ...opts });
    last = r.json.job ?? r.json;
    if (r.status === 200 && ["held", "done", "failed", "cancelled"].includes(r.json.job?.status)) return r.json.job;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`job ${kind}/${id} did not settle: ${JSON.stringify(last)}`);
}
const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const pdfFile = (name: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% ${name}\n`)], name, { type: "application/pdf" });
const htmlFile = (name: string) => new File([new TextEncoder().encode(`<!doctype html><html><title>${name}</title><p>saved page</p></html>`)], name, { type: "text/html" });

let ctx: { a: { path: string; refinery: string }; a2: { path: string; refinery: string }; b: { path: string; refinery: string } } | null = null;
async function setup() {
  if (ctx) return ctx;
  ctx = { a: await refineryOf(A, `Ann doc ${rnd()}`), a2: await refineryOf(A, `Ann second ${rnd()}`), b: await refineryOf(Bsub, `Bob doc ${rnd()}`) };
  return ctx;
}
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: "I1 the general add asks which refinery (and lists only the user's own); it creates none", ...opts, fn: async () => {
  const c = await setup();
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  const r = await call("POST", "/workbench/intake/add", { as: A, body: { url: "https://lab.example.org/no-refinery" } });
  assertEquals(r.status, 400, r.text);
  assertEquals(r.json.needs, "refinery_id");
  const ids = (r.json.refineries as { id: string }[]).map((x) => x.id);
  assert(ids.includes(c.a.refinery) && ids.includes(c.a2.refinery) && !ids.includes(c.b.refinery), r.text);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, before);
  // another user's refinery, or a document that is not the user's, is no target
  assertEquals((await call("POST", "/workbench/intake/add", { as: A, body: { url: "https://lab.example.org/x", refinery_id: c.b.refinery } })).status, 404);
  assertEquals((await call("POST", "/workbench/intake/add", { as: A, body: { url: "https://lab.example.org/x", path: c.b.path } })).status, 404);
} });

Deno.test({ name: "I2 a general link add: one research /intake/fetch with the workspace key, nothing typed but the link, held in the named refinery - never in sources, never a proposal", ...opts, fn: async () => {
  const c = await setup();
  const url = `https://lab.example.org/article-${rnd()}`;
  const gateBefore = GATE ? (await (await fetch(`${GATE}/__log`)).json()).length : 0;
  const r = await call("POST", "/workbench/intake/add", { as: A, body: { url, refinery_id: c.a.refinery } });
  assertEquals(r.status, 202, r.text);
  assertEquals([r.json.kind, r.json.origin], ["add", "workspace"]);
  const job = await settled(A, "add", r.json.job_id);
  assertEquals(job.status, "held", JSON.stringify(job));
  const held = await sql<{ id: string; refinery_id: string; content: string; content_type: string; metadata: any }>(
    `SELECT id::text AS id, refinery_id::text AS refinery_id, content, content_type, metadata FROM public.held_sources WHERE url = $1`, [url]);
  assertEquals(held.length, 1);
  assertEquals([held[0].refinery_id, held[0].content_type, held[0].id], [c.a.refinery, "web_article", job.detail.held_source_id]);
  assert(held[0].content.includes(`the text of ${url}`));
  assertEquals(held[0].metadata.intake.fetched_by, "research-service /intake/fetch");
  assertEquals(held[0].metadata.user_provided, true);
  const rus = await sql<{ status: string }>(`SELECT status FROM public.refinery_user_sources WHERE source_id = $1::uuid AND refinery_id = $2::uuid`, [held[0].id, c.a.refinery]);
  assertEquals(rus.map((x) => x.status), ["held"]);
  assertEquals((await sql(`SELECT 1 FROM public.sources WHERE url = $1 OR id = $2::uuid`, [url, held[0].id])).length, 0, "not admitted on arrival");
  const props = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%proposal%'`);
  if (props[0].n) {
    for (const t of await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%proposal%'`)) {
      const hit = await sql(`SELECT 1 FROM public.${t.table_name} WHERE row_to_json(${t.table_name})::text LIKE $1`, [`%${url}%`]);
      assertEquals(hit.length, 0, `never a watch proposal (${t.table_name})`);
    }
  }
  if (RS) {
    const rq = (await (await fetch(`${RS}/requests`)).json()).requests as { caller: string; path?: string; body: any }[];
    const mine = rq.filter((x) => x.path === "/intake/fetch" && x.body?.url === url);
    assertEquals(mine.length, 1, "exactly one research /intake/fetch for the link");
    assertEquals([mine[0].caller, Object.keys(mine[0].body).sort()], ["workspace", ["url"]]);
  }
  if (GATE) assertEquals((await (await fetch(`${GATE}/__log`)).json()).length, gateBefore, "the add never calls the search gate (one fetch path)");
} });

Deno.test({ name: "I3 the contextual adds: from a document (its refinery) and from a refinery (its id) - a PDF link, a YouTube link, a file", ...opts, fn: async () => {
  const c = await setup();
  const pdf = `https://lab.example.org/papers/tone-${rnd()}.pdf`;
  const r1 = await call("POST", "/workbench/intake/add", { as: A, body: { url: pdf, path: c.a2.path } });
  assertEquals(r1.status, 202, r1.text);
  const j1 = await settled(A, "add", r1.json.job_id);
  assertEquals(j1.status, "held", JSON.stringify(j1));
  const h1 = await sql<{ refinery_id: string; content_type: string; content: string }>(`SELECT refinery_id::text AS refinery_id, content_type, content FROM public.held_sources WHERE url = $1`, [pdf]);
  assertEquals([h1[0].refinery_id, h1[0].content_type], [c.a2.refinery, "pdf"], "held in the document's refinery");
  assert(h1[0].content.includes("extracted text of"), "the PDF went through the extractor");
  const yt = `https://www.youtube.com/watch?v=${rnd().slice(0, 11).padEnd(11, "x")}`;
  const r2 = await call("POST", "/workbench/intake/add", { as: A, body: { url: yt, refinery_id: c.a2.refinery } });
  const j2 = await settled(A, "add", r2.json.job_id);
  assertEquals(j2.status, "held", JSON.stringify(j2));
  assertEquals((await sql<{ content_type: string }>(`SELECT content_type FROM public.held_sources WHERE url = $1`, [yt]))[0].content_type, "youtube_transcript");
  const r3 = await call("POST", "/workbench/intake/add", { as: A, form: form({ file: pdfFile(`dropped-${rnd()}.pdf`), path: c.a.path }) });
  assertEquals(r3.status, 202, r3.text);
  const j3 = await settled(A, "add", r3.json.job_id);
  assertEquals(j3.status, "held", JSON.stringify(j3));
  assertEquals((await sql(`SELECT 1 FROM public.import_job_payloads WHERE job_id = $1::uuid`, [r3.json.job_id])).length, 0, "the file's bytes go once it is held");
} });

Deno.test({ name: "I4 web page, PDF and YouTube transcript are accepted alike by the general and the contextual add; anything else is refused alike", ...opts, fn: async () => {
  const c = await setup();
  const links: Record<string, string> = {
    web_article: "https://lab.example.org/page-", pdf: "https://lab.example.org/doc-", youtube_transcript: "https://youtu.be/",
  };
  for (const [type, prefix] of Object.entries(links)) {
    for (const target of [{ refinery_id: c.a.refinery }, { path: c.a.path }] as Record<string, string>[]) {
      const tag = rnd();
      const url = type === "pdf" ? `${prefix}${tag}.pdf` : type === "youtube_transcript" ? `${prefix}${tag.slice(0, 11).padEnd(11, "y")}` : `${prefix}${tag}`;
      const r = await call("POST", "/workbench/intake/add", { as: A, body: { url, content_type: type, ...target } });
      assertEquals(r.status, 202, `${type} via ${Object.keys(target)[0]}: ${r.text}`);
      const j = await settled(A, "add", r.json.job_id);
      assertEquals(j.status, "held", `${type} via ${Object.keys(target)[0]}: ${JSON.stringify(j)}`);
    }
  }
  for (const target of [{ refinery_id: c.a.refinery }, { path: c.a.path }] as Record<string, string>[]) {
    assertEquals((await call("POST", "/workbench/intake/add", { as: A, body: { url: "https://lab.example.org/x", content_type: "docx", ...target } })).status, 415);
    const docx = new File([new Uint8Array([80, 75, 3, 4])], "notes.docx");
    assertEquals((await call("POST", "/workbench/intake/add", { as: A, form: form({ file: docx, ...target }) })).status, 415);
    const page = await call("POST", "/workbench/intake/add", { as: A, form: form({ file: htmlFile(`saved-${rnd()}.html`), ...target }) });
    assertEquals(page.status, 202, page.text);
    assertEquals((await settled(A, "add", page.json.job_id)).status, "held");
  }
  // a declared type the link is not: refused by the fetch, recorded as a fixed reason
  const mm = await call("POST", "/workbench/intake/add", { as: A, body: { url: "https://lab.example.org/not-a-video", content_type: "youtube_transcript", refinery_id: c.a.refinery } });
  const jm = await settled(A, "add", mm.json.job_id);
  assertEquals([jm.status, jm.detail.error], ["failed", "the link is not the content type chosen for it"]);
} });

Deno.test({ name: "I5 the OWUI inlet (origin owui) enters the same add: Open WebUI's key acting for the user; it lands in that user's panel", ...opts, fn: async () => {
  const c = await setup();
  if (!OWUI_KEY) throw new Error("INTAKE_TEST_OWUI_KEY is required");
  const url = `https://lab.example.org/owui-${rnd()}`;
  const r = await call("POST", "/workbench/intake/add", { key: OWUI_KEY, obo: A, body: { url, refinery_id: c.a.refinery } });
  assertEquals(r.status, 202, r.text);
  assertEquals(r.json.origin, "owui");
  const j = await settled(null, "add", r.json.job_id, { key: OWUI_KEY, obo: A });
  assertEquals(j.status, "held", JSON.stringify(j));
  const row = (await sql<{ origin: string; owner_sub: string; actor_sub: string }>(`SELECT origin, owner_sub, actor_sub FROM public.import_jobs WHERE id = $1::uuid`, [r.json.job_id]))[0];
  assertEquals([row.origin, row.owner_sub, row.actor_sub], ["owui", A, "service:owui"]);
  const list = await call("GET", "/workbench/intake/jobs?kinds=add&limit=200", { as: A });
  assert(list.json.jobs.some((x: any) => x.id === r.json.job_id && x.detail.origin === "owui"), "in A's panel");
  assert(!(await call("GET", "/workbench/intake/jobs?kinds=add&limit=200", { as: Bsub })).json.jobs.some((x: any) => x.id === r.json.job_id), "not in B's");
  // the OWUI key acting for B cannot add into A's refinery; no key but OWUI's may act for anyone; no other route
  assertEquals((await call("POST", "/workbench/intake/add", { key: OWUI_KEY, obo: Bsub, body: { url, refinery_id: c.a.refinery } })).status, 404);
  assertEquals((await call("POST", "/workbench/intake/add", { as: Bsub, obo: A, body: { url, refinery_id: c.a.refinery } })).status, 403);
  assertEquals((await call("GET", "/workbench/intake/jobs", { key: OWUI_KEY, obo: A })).status, 403);
  assertEquals((await call("POST", `/workbench/intake/jobs/add/${r.json.job_id}/cancel`, { key: OWUI_KEY, obo: A })).status, 403);
  // the same declared types, the same refusal
  assertEquals((await call("POST", "/workbench/intake/add", { key: OWUI_KEY, obo: A, body: { url, content_type: "docx", refinery_id: c.a.refinery } })).status, 415);
} });

Deno.test({ name: "I6 cancel stops an add before it holds; retry runs it again; a failure is a fixed reason (never the research service's words)", ...opts, fn: async () => {
  const c = await setup();
  const slow = `https://lab.example.org/slow/${rnd()}`;
  const r = await call("POST", "/workbench/intake/add", { as: A, body: { url: slow, refinery_id: c.a.refinery } });
  await new Promise((res) => setTimeout(res, 600));
  const cx = await call("POST", `/workbench/intake/jobs/add/${r.json.job_id}/cancel`, { as: A });
  assertEquals(cx.status, 200, cx.text);
  await new Promise((res) => setTimeout(res, 5000));
  const after = await call("GET", `/workbench/intake/jobs/add/${r.json.job_id}`, { as: A });
  assertEquals(after.json.job.status, "cancelled");
  assertEquals((await sql(`SELECT 1 FROM public.held_sources WHERE url = $1`, [slow])).length, 0, "a cancelled add holds nothing");
  const again = await call("POST", `/workbench/intake/jobs/add/${r.json.job_id}/retry`, { as: A });
  assertEquals(again.status, 202, again.text);
  assertEquals((await settled(A, "add", r.json.job_id)).status, "held");
  assertEquals((await call("POST", `/workbench/intake/jobs/add/${r.json.job_id}/cancel`, { as: A })).status, 409, "a held add has nothing to cancel");
  const boom = await call("POST", "/workbench/intake/add", { as: A, body: { url: `https://lab.example.org/boom/${rnd()}`, refinery_id: c.a.refinery } });
  const jb = await settled(A, "add", boom.json.job_id);
  assertEquals([jb.status, jb.detail.error], ["failed", "the research service could not fetch it"]);
  assert(!JSON.stringify(jb).includes("hunter2") && !JSON.stringify(jb).includes("STUB-MARKER"));
  const ref = await call("POST", "/workbench/intake/add", { as: A, body: { url: `https://lab.example.org/refuse/${rnd()}`, refinery_id: c.a.refinery } });
  assertEquals((await settled(A, "add", ref.json.job_id)).detail.error, "the link was refused: not a public web address");
} });

Deno.test({ name: "I7 an import is its user's: listed, retried and cancelled by them only; the old /workbench/jobs routes agree", ...opts, fn: async () => {
  await setup();
  const imp = await call("POST", "/workbench/import", { as: A, form: form({ file: pdfFile(`fail-extract-${rnd()}.pdf`) }) });
  assertEquals(imp.status, 202, imp.text);
  const j = await settled(A, "import", imp.json.job_id);
  assertEquals(j.status, "failed", JSON.stringify(j));
  assertEquals((await sql(`SELECT 1 FROM public.import_job_payloads WHERE job_id = $1::uuid`, [imp.json.job_id])).length, 1, "kept for a retry");
  // B: not listed, not found by id, no retry or cancel, not on the old routes nor in jobs()
  assert(!(await call("GET", "/workbench/intake/jobs?kinds=import&limit=200", { as: Bsub })).text.includes(imp.json.job_id));
  assertEquals((await call("GET", `/workbench/intake/jobs/import/${imp.json.job_id}`, { as: Bsub })).status, 404);
  assertEquals((await call("POST", `/workbench/intake/jobs/import/${imp.json.job_id}/retry`, { as: Bsub })).status, 404);
  assertEquals((await call("POST", `/workbench/intake/jobs/import/${imp.json.job_id}/cancel`, { as: Bsub })).status, 404);
  assertEquals((await call("GET", `/workbench/jobs/${imp.json.job_id}`, { as: Bsub })).status, 404);
  assert(!(await call("GET", `/workbench/jobs`, { as: Bsub })).text.includes(imp.json.job_id));
  assert(!(await call("GET", `/workbench/contract/jobs?kinds=import&limit=200`, { as: Bsub })).text.includes(imp.json.job_id));
  assert((await call("GET", `/workbench/contract/jobs?kinds=import&limit=200`, { as: A })).text.includes(imp.json.job_id));
  assertEquals((await call("GET", `/workbench/jobs/${imp.json.job_id}`, { as: A })).status, 200);
  // A retries: the same pipeline from the kept bytes (it fails again the same way: the lab extractor refuses the name)
  const rt = await call("POST", `/workbench/intake/jobs/import/${imp.json.job_id}/retry`, { as: A });
  assertEquals(rt.status, 202, rt.text);
  const j2 = await settled(A, "import", imp.json.job_id);
  assertEquals([j2.status, j2.detail.attempts], ["failed", 2]);
  // an import that works: done, its bytes gone
  const ok = await call("POST", "/workbench/import", { as: A, form: form({ file: pdfFile(`works-${rnd()}.pdf`) }) });
  assertEquals((await settled(A, "import", ok.json.job_id)).status, "done");
  assertEquals((await sql(`SELECT 1 FROM public.import_job_payloads WHERE job_id = $1::uuid`, [ok.json.job_id])).length, 0);
} });

Deno.test({ name: "I8 the worker queues: chunk, extract and entity jobs appear with their phase; retry and cancel work and are the owner's only", ...opts, fn: async () => {
  await setup();
  // A's import made a source the chunk worker has not chunked; the entity worker failed its extraction
  const content = `chunk me ${rnd()}`;
  const src = (await sql<{ id: string }>(
    `INSERT INTO public.sources (title, content, content_type, url) VALUES ($1, $2, 'web_article', $3) RETURNING id::text AS id`,
    [`Queued source ${rnd()}`, content, `https://lab.example.org/queued-${rnd()}`]))[0].id;
  await sql(`INSERT INTO public.import_jobs (status, source_id, owner_sub, actor_sub) VALUES ('done', $1::uuid, $2, $2)`, [src, A]);
  await sql(`INSERT INTO public.source_extraction_queue (source_id, status, attempt_count, last_error) VALUES ($1::uuid, 'failed', 3, 'lab: the model answered nothing')
             ON CONFLICT (source_id) DO UPDATE SET status = 'failed', attempt_count = 3`, [src]);
  const th = (await sql<{ id: string }>(`INSERT INTO public.thoughts (content) VALUES ($1) RETURNING id::text AS id`, [`a thought ${rnd()}`]))[0].id;
  await sql(`INSERT INTO public.entity_extraction_queue (thought_id, status) VALUES ($1::bigint, 'pending') ON CONFLICT (thought_id) DO UPDATE SET status = 'pending'`, [th]);
  const listA = (await call("GET", "/workbench/intake/jobs?limit=200", { as: A })).json.jobs as any[];
  const chunk = listA.find((j) => j.kind === "chunk" && j.id === src);
  const extract = listA.find((j) => j.kind === "extract" && j.id === src);
  assertEquals([chunk?.detail.phase, chunk?.detail.primary], ["pending", "cancel"]);
  assertEquals([extract?.detail.phase, extract?.detail.primary], ["failed", "retry"]);
  assert(!listA.some((j) => j.kind === "entity" && j.id === th), "a thought is not A's");
  const listOp = (await call("GET", "/workbench/intake/jobs?kinds=entity&limit=200", { as: null })).json.jobs as any[];
  assertEquals(listOp.find((j) => j.id === th)?.detail.phase, "pending", "the operator (who owns the ownerless) sees the entity queue");
  const listB = (await call("GET", "/workbench/intake/jobs?limit=200", { as: Bsub })).text;
  assert(!listB.includes(src) && !listB.includes(`"${th}"`), "B sees none of them");
  for (const [k, id] of [["chunk", src], ["extract", src], ["entity", th]]) {
    assertEquals((await call("GET", `/workbench/intake/jobs/${k}/${id}`, { as: Bsub })).status, 404, `${k} by id for B`);
    assertEquals((await call("POST", `/workbench/intake/jobs/${k}/${id}/cancel`, { as: Bsub })).status, 404);
    assertEquals((await call("POST", `/workbench/intake/jobs/${k}/${id}/retry`, { as: Bsub })).status, 404);
  }
  // chunk: cancel stamps it processed (the worker skips it); retry puts it back
  assertEquals((await call("POST", `/workbench/intake/jobs/chunk/${src}/cancel`, { as: A })).status, 200);
  const stamped = (await sql<{ ok: boolean }>(`SELECT md5(content) = metadata->>'chunked_hash' AND (metadata->>'chunk_cancelled')::boolean AS ok FROM public.sources WHERE id = $1::uuid`, [src]))[0];
  assert(stamped.ok, "cancelled: stamped so the chunk worker's scan skips it");
  assertEquals((await call("GET", `/workbench/intake/jobs/chunk/${src}`, { as: A })).json.job.detail.primary, "retry");
  assertEquals((await call("POST", `/workbench/intake/jobs/chunk/${src}/retry`, { as: A })).status, 202);
  assertEquals((await call("GET", `/workbench/intake/jobs/chunk/${src}`, { as: A })).json.job.status, "pending");
  // extract: retry -> pending with a fresh attempt count; then cancel -> cancelled (the worker claims pending only)
  assertEquals((await call("POST", `/workbench/intake/jobs/extract/${src}/retry`, { as: A })).status, 202);
  assertEquals((await sql<{ status: string; attempt_count: number }>(`SELECT status, attempt_count FROM public.source_extraction_queue WHERE source_id = $1::uuid`, [src]))[0], { status: "pending", attempt_count: 0 });
  assertEquals((await call("POST", `/workbench/intake/jobs/extract/${src}/cancel`, { as: A })).status, 200);
  assertEquals((await sql<{ status: string }>(`SELECT status FROM public.source_extraction_queue WHERE source_id = $1::uuid`, [src]))[0].status, "cancelled");
  // entity: the operator cancels and retries
  assertEquals((await call("POST", `/workbench/intake/jobs/entity/${th}/cancel`, { as: null })).status, 200);
  assertEquals((await call("POST", `/workbench/intake/jobs/entity/${th}/retry`, { as: null })).status, 202);
  assertEquals((await sql<{ status: string }>(`SELECT status FROM public.entity_extraction_queue WHERE thought_id = $1::bigint`, [th]))[0].status, "pending");
  // an action the phase does not offer is refused, never forced
  assertEquals((await call("POST", `/workbench/intake/jobs/entity/${th}/retry`, { as: null })).status, 409);
  assertEquals((await call("GET", "/workbench/intake/jobs?kinds=bogus", { as: A })).status, 400);
  void OPERATOR;
} });
