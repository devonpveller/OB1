// deno test src/util/upload_store_lab_test.ts - saving an upload does not freeze the workbench (rw-upload-store-offthread),
// over a REAL workbench and database. SKIPPED unless INTAKE_TEST_BASE and CONTRACT_TEST_DB_HOST are set (the lab runner's [5u]
// step sets them, with the same environment as the intake integration test). Never point it at a live stack: it writes jobs.
//
// A file whose name carries "fail-extract" is refused by the lab's stub extractor, so its job FAILS and keeps its bytes
// (a failed job keeps its payload for retry): that is what lets the stored bytes be compared with the uploaded ones.
// Environment: INTAKE_TEST_BASE, INTAKE_TEST_KEY, DOCS_TEST_SUB_HEADER (default X-Test-Sub), CONTRACT_TEST_DB_HOST/_USER/_PASSWORD.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("INTAKE_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("INTAKE_TEST_KEY") ?? "";
const SUB = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const MiB = 1024 * 1024;
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `upstore-ann-${rnd()}`;
const B = `upstore-bystander-${rnd()}`;

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "" }, 1, true);
  const c = await pool.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); await pool.end(); }
}
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
function pattern(n: number, head = ""): Uint8Array {
  const b = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
  b.set(new TextEncoder().encode(head), 0);
  return b;
}
// one fresh connection per request: a bystander must not share one with the upload
const client = Deno.createHttpClient({ poolMaxIdlePerHost: 0 });
async function call(method: string, path: string, as: string, body?: BodyInit, ct?: string) {
  const headers: Record<string, string> = { "x-brain-key": KEY, [SUB]: as };
  if (ct) headers["content-type"] = ct;
  const t = performance.now();
  const r = await fetch(BASE + path, { method, headers, body, client });
  const text = await r.text();
  return { status: r.status, text, ms: performance.now() - t };
}
const json = (o: unknown) => JSON.stringify(o);
// the encoded multipart body, made once outside any clock
async function multipart(fields: Record<string, string>, file: { name: string; bytes: Uint8Array }) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("file", new Blob([file.bytes as BlobPart]), file.name);
  const req = new Request("http://x/", { method: "POST", body: f });
  return { ct: req.headers.get("content-type")!, body: new Uint8Array(await req.arrayBuffer()) };
}
// the worst wait of a bystander (another user's cheap read) while `work` runs
async function withBystander<T>(work: () => Promise<T>) {
  let worst = 0, up = true;
  const poll = (async () => {
    while (up) { const r = await call("GET", "/workbench/intake/content-types", B); worst = Math.max(worst, r.ms); await new Promise((res) => setTimeout(res, 20)); }
  })();
  await new Promise((res) => setTimeout(res, 200));
  worst = 0;
  const out = await work();
  up = false;
  await poll;
  return { out, worst };
}
async function refineryOfA(title: string): Promise<string> {
  const made = JSON.parse((await call("POST", "/workbench/documents", A, json({ title }), "application/json")).text);
  await call("POST", "/workbench/documents/property", A, json({ path: made.path, key: "idea", value: "upload store" }), "application/json");
  await call("POST", "/workbench/documents/refinery/start", A, json({ path: made.path }), "application/json");
  return JSON.parse((await call("GET", `/workbench/documents/state?path=${encodeURIComponent(made.path)}`, A)).text).refinery.id;
}
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: "U1 a 32 MiB file import: a bystander is answered within 1 s, and the stored bytes are the uploaded bytes", ...opts, fn: async () => {
  const bytes = pattern(32 * MiB, "%PDF-1.4\n");
  const want = await sha(bytes);
  const { ct, body } = await multipart({}, { name: "fail-extract-32mib.pdf", bytes });
  const r = await withBystander(() => call("POST", "/workbench/import", A, body, ct));
  console.log(`upload-store U1: 32 MiB import -> ${r.out.status} in ${r.out.ms.toFixed(0)} ms; bystander worst ${r.worst.toFixed(0)} ms`);
  assertEquals(r.out.status, 202, r.out.text);
  assert(r.worst < 1000, `a bystander waited ${r.worst.toFixed(0)} ms`);
  const id = JSON.parse(r.out.text).job_id as string;
  const row = (await sql<{ len: number; h: string; filename: string; owner: string }>(
    `SELECT length(p.bytes) AS len, encode(sha256(p.bytes), 'hex') AS h, p.filename, j.owner_sub AS owner FROM public.import_job_payloads p JOIN public.import_jobs j ON j.id = p.job_id WHERE p.job_id = $1::uuid`, [id]))[0];
  assertEquals([Number(row.len), row.h, row.filename, row.owner], [32 * MiB, want, "fail-extract-32mib.pdf", A]);
} });

Deno.test({ name: "U2 a 25 MiB intake add of a file: a bystander is answered within 1 s, the bytes are identical, the job is the caller's", ...opts, fn: async () => {
  const refinery = await refineryOfA(`upstore ${rnd()}`);
  const bytes = pattern(25 * MiB, "%PDF-1.4\n");
  const want = await sha(bytes);
  const { ct, body } = await multipart({ refinery_id: refinery }, { name: "fail-extract-25mib.pdf", bytes });
  const r = await withBystander(() => call("POST", "/workbench/intake/add", A, body, ct));
  console.log(`upload-store U2: 25 MiB intake add -> ${r.out.status} in ${r.out.ms.toFixed(0)} ms; bystander worst ${r.worst.toFixed(0)} ms`);
  assertEquals(r.out.status, 202, r.out.text);
  assert(r.worst < 1000, `a bystander waited ${r.worst.toFixed(0)} ms`);
  const id = JSON.parse(r.out.text).job_id as string;
  const row = (await sql<{ len: number; h: string; owner: string }>(
    `SELECT length(p.bytes) AS len, encode(sha256(p.bytes), 'hex') AS h, j.owner_sub AS owner FROM public.import_job_payloads p JOIN public.import_jobs j ON j.id = p.job_id WHERE p.job_id = $1::uuid`, [id]))[0];
  assertEquals([Number(row.len), row.h, row.owner], [25 * MiB, want, A]);
  assertEquals((await call("GET", `/workbench/intake/jobs/add/${id}`, B)).status, 404, "another user does not see it");
} });

Deno.test({ name: "U3 replace-from-upload of 32 MiB: a bystander is answered within 1 s (it stores no bytes: the file goes to the extractor)", ...opts, fn: async () => {
  const { ct, body } = await multipart({}, { name: "replace-32mib.pdf", bytes: pattern(32 * MiB, "%PDF-1.4\n") });
  const r = await withBystander(() => call("POST", `/workbench/sources/${crypto.randomUUID()}/replace-from-upload`, A, body, ct));
  console.log(`upload-store U3: 32 MiB replace-from-upload -> ${r.out.status} in ${r.out.ms.toFixed(0)} ms; bystander worst ${r.worst.toFixed(0)} ms`);
  assert(r.worst < 1000, `a bystander waited ${r.worst.toFixed(0)} ms`);
} });

Deno.test({ name: "U4 the 25 MiB intake cap is unchanged: a file over it is 413 and nothing is stored", ...opts, fn: async () => {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_job_payloads`))[0].n;
  const refinery = await refineryOfA(`upstore cap ${rnd()}`);
  const { ct, body } = await multipart({ refinery_id: refinery }, { name: "too-big.pdf", bytes: pattern(25 * MiB + 1, "%PDF-1.4\n") });
  const r = await call("POST", "/workbench/intake/add", A, body, ct);
  assertEquals(r.status, 413, r.text);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_job_payloads`))[0].n, before);
} });
