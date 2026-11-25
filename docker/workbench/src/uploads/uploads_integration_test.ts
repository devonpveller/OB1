// deno test src/uploads/uploads_integration_test.ts - upload sessions (rwr-upload-sessions) over a REAL workbench and
// database, several identities (the identity header) and a service key.
//
// SKIPPED unless UPLOADS_TEST_BASE is set. contract-test/run-uploads-tests.ps1 sets it to the :wt workbench on its DISPOSABLE
// internal network (the real initdb chain with slot 610, fixtures.sql, a stub embedder, the stub research service, the stub
// extractor - which records the length and sha256 of every file it is handed - and the workbench's upload volume, mounted
// into this test's container too at UPLOADS_TEST_DIR so the pieces on disk can be measured and damaged). The workbench runs
// with UPLOAD_SWEEP_MS=2000. Never point it at a live stack: it writes uploads, documents, jobs and held sources.
//
// Environment: UPLOADS_TEST_BASE, UPLOADS_TEST_KEY (the door key), UPLOADS_TEST_SERVICE_KEY, UPLOADS_TEST_EXTRACT (the stub
// extractor), UPLOADS_TEST_DIR (the upload volume), UPLOADS_TEST_BIG_MB (default 200), DOCS_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser).
//   U1 a 200 MB file in 8 MB pieces survives a connection cut mid-piece, resumes from the status, becomes ONE held source whose
//      bytes (as the extractor received them) match the sha256; its pieces are gone afterwards
//   U2 a wrong sha256 / U3 a missing piece / U4 overlapping, out-of-range and over-limit pieces, a size that does not match the
//      file either way, a piece damaged in storage / U5 a file the intake refuses: never a job, and the session says why
//   U6 two identities: B cannot read, resume, finish, cancel, list, count or time A's upload apart from a missing one
//   U7 quotas: over 500 MB one file; over 1 GB unfinished per person; another person's uploads do not count
//   U8 the sweep removes an abandoned upload's pieces and an orphan folder, and frees the space (measured); a fresh one stays
//   U9 a finish sent twice (and two at once) makes one job; a service key gets 403; no route serves a piece's bytes
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { Sha256 } from "./sha256.ts";

const BASE = (Deno.env.get("UPLOADS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("UPLOADS_TEST_KEY") ?? "";
const SVC_KEY = Deno.env.get("UPLOADS_TEST_SERVICE_KEY") ?? "";
const EXTRACT = (Deno.env.get("UPLOADS_TEST_EXTRACT") ?? "").replace(/\/+$/, "");
const DIR = (Deno.env.get("UPLOADS_TEST_DIR") ?? "").replace(/\/+$/, "");
const BIG_MB = Number(Deno.env.get("UPLOADS_TEST_BIG_MB") ?? "200");
const SUB = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST || !DIR;
const MB = 1024 * 1024;
const PIECE = 8 * MB;
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `upl-ann-${rnd()}`;
const B = `upl-bob-${rnd()}`;
const opts = { sanitizeOps: false, sanitizeResources: false, ignore };

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

type Res = { status: number; json: Record<string, any>; text: string; ms: number };
async function call(method: string, path: string, o: { as?: string | null; body?: unknown; bytes?: Uint8Array; key?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { "x-brain-key": o.key ?? KEY };
  if (o.as) headers[SUB] = o.as;
  let body: BodyInit | undefined;
  if (o.bytes) { headers["content-type"] = "application/octet-stream"; body = o.bytes as unknown as BodyInit; }
  else if (o.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.body); }
  const t0 = performance.now();
  const r = await fetch(BASE + path, { method, headers, body });
  const text = await r.text();
  const ms = performance.now() - t0;
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, ms };
}
const U = "/workbench/contract/uploads";
const shaOf = (b: Uint8Array) => new Sha256().update(b).hex();
const start = (as: string, filename: string, size: number, sha256: string) => call("POST", U, { as, body: { filename, size, sha256 } });
const put = (as: string, id: string, offset: number | string, bytes: Uint8Array) => call("PUT", `${U}/${id}/pieces?offset=${offset}`, { as, bytes });
// a PDF-shaped file of n bytes (the intake takes a PDF), its content seeded so each file differs
function pdf(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  b.set(new TextEncoder().encode("%PDF-1.4\n"), 0);
  return b;
}
async function dirBytes(d: string): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir(d)) {
      if (e.isFile) n += (await Deno.stat(`${d}/${e.name}`)).size;
      else if (e.isDirectory) n += await dirBytes(`${d}/${e.name}`);
    }
  } catch { /* gone */ }
  return n;
}
const exists = async (p: string) => { try { await Deno.stat(p); return true; } catch { return false; } };
const jobsOf = async (owner: string) => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_jobs WHERE owner_sub = $1`, [owner]))[0].n;
const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now() + ms; while (Date.now() < t) { if (await f()) return true; await new Promise((r) => setTimeout(r, 300)); } return false; };

// an idea refinery of the subject's (the add joins an existing one)
async function refineryOf(as: string, title: string): Promise<string> {
  const made = await call("POST", "/workbench/documents", { as, body: { title } });
  assertEquals(made.status, 201, made.text);
  const path: string = made.json.path;
  const prop = await call("POST", "/workbench/documents/property", { as, body: { path, key: "idea", value: `idea of ${title}` } });
  assert(prop.status < 300, prop.text);
  const st = await call("POST", "/workbench/documents/refinery/start", { as, body: { path } });
  assert(st.status < 300, st.text);
  const s = await call("GET", `/workbench/documents/state?path=${encodeURIComponent(path)}`, { as });
  assert(s.json.refinery?.id, s.text);
  return s.json.refinery.id as string;
}
async function settled(as: string, jobId: string, ms = 120_000) {
  let last: any = {};
  const ok = await until(async () => {
    const r = await call("GET", `/workbench/intake/jobs/add/${jobId}`, { as });
    last = r.json.job ?? r.json;
    return r.status === 200 && ["held", "done", "failed", "cancelled"].includes(r.json.job?.status);
  }, ms);
  if (!ok) throw new Error(`job ${jobId} did not settle: ${JSON.stringify(last)}`);
  return last;
}

// send the head of a piece over a raw connection and cut it: the forced disconnect
async function cutPiece(as: string, id: string, offset: number, length: number, sendBytes: Uint8Array) {
  const u = new URL(BASE);
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 80) });
  const head = `PUT ${U}/${id}/pieces?offset=${offset} HTTP/1.1\r\nHost: ${u.host}\r\nx-brain-key: ${KEY}\r\n${SUB}: ${as}\r\n` +
    `content-type: application/octet-stream\r\ncontent-length: ${length}\r\nconnection: close\r\n\r\n`;
  await conn.write(new TextEncoder().encode(head));
  let off = 0;
  while (off < sendBytes.length) off += await conn.write(sendBytes.subarray(off));
  await new Promise((r) => setTimeout(r, 300));
  conn.close();
}

let refA = "";
Deno.test({ ...opts, name: "U1: a 200 MB file in pieces survives a cut connection, resumes from the status, becomes ONE source with the file's sha256", fn: async () => {
  refA = await refineryOf(A, `uploads ${rnd()}`);
  const size = BIG_MB * MB + 12345; // not a multiple of the piece size: the last piece is short
  const file = pdf(size, 1);
  const sha = shaOf(file);
  const name = `big-${rnd()}.pdf`;
  const jobsBefore = await jobsOf(A);
  const s = await start(A, name, size, sha);
  assertEquals(s.status, 201, s.text);
  const id: string = s.json.id;
  assertEquals([s.json.state, s.json.received, s.json.next_offset], ["open", 0, 0]);
  const cutAt = 10 * PIECE;
  for (let off = 0; off < cutAt; off += PIECE) assertEquals((await put(A, id, off, file.subarray(off, off + PIECE))).status, 200);
  // the forced disconnect: half of the 11th piece, then the connection is cut
  await cutPiece(A, id, cutAt, PIECE, file.subarray(cutAt, cutAt + PIECE / 2));
  const after = await until(async () => {
    const names: string[] = [];
    for await (const e of Deno.readDir(`${DIR}/${id}`)) names.push(e.name);
    return !names.some((n) => n.startsWith("t-"));
  }, 10_000);
  assert(after, "the cut piece left no partial file behind");
  // resume FROM THE STATUS, as the app does
  const st = await call("GET", `${U}/${id}`, { as: A });
  assertEquals(st.status, 200, st.text);
  assertEquals([st.json.received, st.json.next_offset, st.json.pieces], [cutAt, cutAt, 10], "the cut piece was not kept");
  assertEquals(await dirBytes(`${DIR}/${id}`), cutAt, "on disk: exactly the ten whole pieces");
  for (let off = st.json.next_offset; off < size; off += PIECE) {
    const r = await put(A, id, off, file.subarray(off, Math.min(size, off + PIECE)));
    assertEquals(r.status, 200, r.text);
  }
  const done = await call("GET", `${U}/${id}`, { as: A });
  assertEquals([done.json.received, done.json.next_offset, done.json.missing_ranges], [size, size, 0]);
  const fin = await call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(fin.status, 202, fin.text);
  const job = await settled(A, fin.json.job_id, 180_000);
  assertEquals(job.status, "held", JSON.stringify(job));
  assertEquals(await jobsOf(A), jobsBefore + 1, "exactly one add job");
  const held = await sql<{ id: string; metadata: any }>(`SELECT id::text AS id, metadata FROM public.held_sources WHERE metadata->'intake'->>'job_id' = $1`, [fin.json.job_id]);
  assertEquals(held.length, 1, "exactly one source");
  assertEquals(held[0].id, job.detail.held_source_id);
  assertEquals(held[0].metadata.intake.upload, { id, size, sha256: sha }, "the source names the upload and the verified sha256");
  const got = ((await (await fetch(`${EXTRACT}/received`)).json()).files as { name: string; size: number; sha256: string }[]).filter((f) => f.name === name);
  assertEquals(got, [{ name, size, sha256: sha }], "the bytes the intake handed on are the file, byte for byte");
  assert(await until(async () => !(await exists(`${DIR}/${id}`)), 10_000), "the upload's file is removed once its source is held");
  const final = await call("GET", `${U}/${id}`, { as: A });
  assertEquals([final.json.state, final.json.job_id], ["done", fin.json.job_id]);
}});

Deno.test({ ...opts, name: "U2: a wrong sha256 never creates a source; the upload fails with the reason and its pieces are removed", fn: async () => {
  const file = pdf(3 * MB, 2);
  const s = await start(A, `wrongsha-${rnd()}.pdf`, file.length, shaOf(pdf(3 * MB, 99)));
  const id = s.json.id;
  for (let off = 0; off < file.length; off += 2 * MB) assertEquals((await put(A, id, off, file.subarray(off, off + 2 * MB))).status, 200);
  const before = await jobsOf(A);
  const f = await call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(f.status, 422, f.text);
  assert(/sha256 is [0-9a-f]{64}, not the [0-9a-f]{64} declared/.test(f.json.error), f.text);
  const st = await call("GET", `${U}/${id}`, { as: A });
  assertEquals(st.json.state, "failed");
  assertEquals(st.json.reason, f.json.error, "the session reports why");
  assertEquals(await jobsOf(A), before, "no job");
  assert(!(await exists(`${DIR}/${id}`)), "the pieces are removed");
  assertEquals((await put(A, id, 0, file.subarray(0, 10))).status, 409, "a failed upload takes no more pieces");
}});

Deno.test({ ...opts, name: "U3: a missing piece: the finish is refused with the first missing byte, the upload stays open, and completes once sent", fn: async () => {
  const file = pdf(3 * MB, 3);
  const s = await start(A, `missing-${rnd()}.pdf`, file.length, shaOf(file));
  const id = s.json.id;
  assertEquals((await put(A, id, 0, file.subarray(0, MB))).status, 200);
  assertEquals((await put(A, id, 2 * MB, file.subarray(2 * MB))).status, 200);
  const before = await jobsOf(A);
  const f = await call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(f.status, 409, f.text);
  assert(f.json.error.includes(`the first from byte ${MB}, ${MB} bytes`), f.text);
  assertEquals(f.json.detail.missing, [{ offset: MB, length: MB }]);
  const st = await call("GET", `${U}/${id}`, { as: A });
  assertEquals([st.json.state, st.json.next_offset, st.json.reason], ["open", MB, f.json.error], "open, resumable, and it says why");
  assertEquals(await jobsOf(A), before, "no job");
  assertEquals((await put(A, id, MB, file.subarray(MB, 2 * MB))).status, 200);
  const ok = await call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(ok.status, 202, ok.text);
  assertEquals((await settled(A, ok.json.job_id)).status, "held");
}});

Deno.test({ ...opts, name: "U4: overlapping, out-of-range and over-limit pieces, a size that does not match the file, a damaged piece: never a job, always a reason", fn: async () => {
  const before = await jobsOf(A);
  const file = pdf(3000, 4);
  const s = await start(A, `ranges-${rnd()}.pdf`, file.length, shaOf(file));
  const id = s.json.id;
  assertEquals((await put(A, id, 0, file.subarray(0, 1000))).status, 200);
  const ov = await put(A, id, 500, file.subarray(500, 1500));
  assertEquals(ov.status, 409, ov.text);
  assert(/overlaps the piece already received at offset 0 \(1000 bytes\)/.test(ov.json.error), ov.text);
  assertEquals((await put(A, id, 0, file.subarray(0, 600))).status, 409, "the same offset with another length overlaps");
  const resend = await put(A, id, 0, file.subarray(0, 1000));
  assertEquals([resend.status, resend.json.pieces, resend.json.received], [200, 1, 1000], "the same piece again replaces it (a resend)");
  const past = await put(A, id, 2500, file.subarray(0, 1000));
  assertEquals(past.status, 416, past.text);
  assert(/runs past the end of the file/.test(past.json.error));
  const outside = await put(A, id, 3000, file.subarray(0, 10));
  assertEquals(outside.status, 416, outside.text);
  for (const bad of ["-1", "abc", "1.5", ""]) assertEquals((await put(A, id, bad, file.subarray(0, 10))).status, 400, `offset '${bad}'`);
  assertEquals((await put(A, id, 1000, new Uint8Array())).status, 400, "an empty piece");
  const st = await call("GET", `${U}/${id}`, { as: A });
  assertEquals([st.json.received, st.json.pieces, st.json.state], [1000, 1, "open"], "none of the refused pieces was kept");
  // one piece over the piece limit (16 MB), in a file large enough to hold it
  const bigS = await start(A, `bigpiece-${rnd()}.pdf`, 20 * MB, "ab".repeat(32));
  const over = await put(A, bigS.json.id, 0, pdf(16 * MB + 1, 5));
  assertEquals(over.status, 413, over.text);
  assert(/a piece is at most 16777216 bytes/.test(over.json.error));
  // the declared size is LARGER than the file: every byte sent, the finish says what is missing
  const f2 = pdf(2000, 6);
  const big = await start(A, `sizebig-${rnd()}.pdf`, f2.length + 10, shaOf(f2));
  assertEquals((await put(A, big.json.id, 0, f2)).status, 200);
  const fb = await call("POST", `${U}/${big.json.id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(fb.status, 409, fb.text);
  assert(fb.json.error.includes(`10 of its ${f2.length + 10} bytes have not arrived`), fb.text);
  // the declared size is SMALLER than the file: the last piece is refused
  const small = await start(A, `sizesmall-${rnd()}.pdf`, f2.length - 10, shaOf(f2));
  const fs = await put(A, small.json.id, 0, f2);
  assertEquals(fs.status, 416, fs.text);
  // a piece damaged in storage after it arrived (truncated on the volume): the finish fails the upload with the reason
  const f3 = pdf(4000, 7);
  const dmg = await start(A, `damaged-${rnd()}.pdf`, f3.length, shaOf(f3));
  assertEquals((await put(A, dmg.json.id, 0, f3.subarray(0, 2000))).status, 200);
  assertEquals((await put(A, dmg.json.id, 2000, f3.subarray(2000))).status, 200);
  await Deno.writeFile(`${DIR}/${dmg.json.id}/p-2000`, f3.subarray(2000, 2500));
  const fd = await call("POST", `${U}/${dmg.json.id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(fd.status, 422, fd.text);
  assert(/the piece at offset 2000 is 500 bytes in storage, not the 2000 received/.test(fd.json.error), fd.text);
  assertEquals((await call("GET", `${U}/${dmg.json.id}`, { as: A })).json.state, "failed");
  assertEquals(await jobsOf(A), before, "not one of them made a job");
  for (const x of [id, bigS.json.id, big.json.id, small.json.id]) await call("DELETE", `${U}/${x}`, { as: A });
}});

Deno.test({ ...opts, name: "U5: a file the intake would refuse (an image) is refused at its first piece, with the intake's reason", fn: async () => {
  const png = new Uint8Array(4000); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const s = await start(A, `photo-${rnd()}.png`, png.length, shaOf(png));
  const r = await put(A, s.json.id, 0, png.subarray(0, 2000));
  assertEquals(r.status, 415, r.text);
  assert(/a file add is a PDF or a saved web page/.test(r.json.error), r.text);
  const st = await call("GET", `${U}/${s.json.id}`, { as: A });
  assertEquals([st.json.state, st.json.reason], ["failed", r.json.error]);
  assert(!(await exists(`${DIR}/${s.json.id}`)));
}});

Deno.test({ ...opts, name: "U6: B cannot read, resume, finish, cancel, list, count or time A's upload apart from a missing one", fn: async () => {
  const file = pdf(2 * MB, 8);
  const s = await start(A, `private-${rnd()}.pdf`, file.length, shaOf(file));
  const id = s.json.id;
  assertEquals((await put(A, id, 0, file.subarray(0, MB))).status, 200);
  const missing = crypto.randomUUID();
  const pairs: [string, (x: string) => Promise<Res>][] = [
    ["status", (x) => call("GET", `${U}/${x}`, { as: B })],
    ["piece", (x) => put(B, x, MB, file.subarray(MB))],
    ["finish", (x) => call("POST", `${U}/${x}/finish`, { as: B, body: { refinery_id: refA } })],
    ["cancel", (x) => call("DELETE", `${U}/${x}`, { as: B })],
  ];
  for (const [what, f] of pairs) {
    const a = await f(id), m = await f(missing);
    assertEquals([a.status, a.text], [404, JSON.stringify({ error: "no such upload" })], `${what} of A's upload`);
    assertEquals([a.status, a.text], [m.status, m.text], `${what}: A's upload answers exactly as a missing one`);
  }
  const mine = await call("GET", U, { as: B });
  assertEquals(mine.status, 200);
  assert(!mine.text.includes(id) && !mine.text.includes("private-"), "B's list carries nothing of A's");
  assertEquals(mine.json.unfinished_bytes, 0, "B's count does not include A's");
  // timing: B's answers for A's id and for a missing id are the same class (the same one query)
  const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const ta: number[] = [], tm: number[] = [];
  for (let i = 0; i < 30; i++) {
    ta.push((await call("GET", `${U}/${id}`, { as: B })).ms);
    tm.push((await call("GET", `${U}/${crypto.randomUUID()}`, { as: B })).ms);
  }
  const [ma, mm] = [median(ta), median(tm)];
  console.log(`U6 timing: B on A's id median ${ma.toFixed(2)} ms, on a missing id ${mm.toFixed(2)} ms`);
  assert(Math.abs(ma - mm) <= Math.max(10, 0.5 * Math.max(ma, mm)), `the same timing class (${ma} vs ${mm})`);
  // A's upload is untouched by everything B sent
  const st = await call("GET", `${U}/${id}`, { as: A });
  assertEquals([st.json.state, st.json.received, st.json.pieces], ["open", MB, 1]);
  await call("DELETE", `${U}/${id}`, { as: A });
}});

Deno.test({ ...opts, name: "U7: quotas: one file over 500 MB, and unfinished uploads over 1 GB per person, are refused with a reason", fn: async () => {
  const Q = `upl-quota-${rnd()}`;
  const sha = "cd".repeat(32);
  const over = await start(Q, "huge.pdf", 500 * MB + 1, sha);
  assertEquals(over.status, 413, over.text);
  assert(/the file is 524288001 bytes; one upload is at most 524288000 bytes/.test(over.json.error), over.text);
  const s1 = await start(Q, "one.pdf", 500 * MB, sha), s2 = await start(Q, "two.pdf", 500 * MB, sha);
  assertEquals([s1.status, s2.status], [201, 201], "1000 MB unfinished is within 1 GB");
  const s3 = await start(Q, "three.pdf", 100 * MB, sha);
  assertEquals(s3.status, 409, s3.text);
  assert(/your unfinished uploads already come to 1048576000 bytes; with this one they would pass your limit of 1073741824 bytes/.test(s3.json.error), s3.text);
  assertEquals(s3.json.detail, { unfinished_bytes: 1048576000, limit: 1073741824 });
  assertEquals((await call("GET", U, { as: Q })).json.unfinished_bytes, 1000 * MB);
  // another person's unfinished uploads count only against them
  const other = await start(B, "bobs.pdf", 500 * MB, sha);
  assertEquals(other.status, 201, "Q's uploads do not count against B");
  // cancelling frees the quota
  assertEquals((await call("DELETE", `${U}/${s1.json.id}`, { as: Q })).status, 200);
  assertEquals((await start(Q, "three.pdf", 100 * MB, sha)).status, 201);
  for (const r of (await call("GET", U, { as: Q })).json.uploads) await call("DELETE", `${U}/${r.id}`, { as: Q });
  await call("DELETE", `${U}/${other.json.id}`, { as: B });
  // two starts sent together cannot both pass the quota
  const R = `upl-race-${rnd()}`;
  const race = await Promise.all([start(R, "r1.pdf", 600 * MB, sha), start(R, "r2.pdf", 600 * MB, sha)]);
  assertEquals(race.map((r) => r.status).sort(), [201, 409], race.map((r) => r.text).join(" | "));
  for (const r of (await call("GET", U, { as: R })).json.uploads) await call("DELETE", `${U}/${r.id}`, { as: R });
}});

Deno.test({ ...opts, name: "U8: the sweep removes an abandoned upload and an orphan folder, and frees the space (measured); a fresh upload stays", fn: async () => {
  const file = pdf(4 * MB, 9);
  const old = await start(A, `abandoned-${rnd()}.pdf`, file.length, shaOf(file));
  const fresh = await start(A, `fresh-${rnd()}.pdf`, file.length, shaOf(file));
  for (const s of [old, fresh]) for (let off = 0; off < 3 * MB; off += MB) assertEquals((await put(A, s.json.id, off, file.subarray(off, off + MB))).status, 200);
  const orphan = crypto.randomUUID();
  await Deno.mkdir(`${DIR}/${orphan}`);
  await Deno.writeFile(`${DIR}/${orphan}/p-0`, new Uint8Array(MB));
  const before = { old: await dirBytes(`${DIR}/${old.json.id}`), orphan: await dirBytes(`${DIR}/${orphan}`), total: await dirBytes(DIR) };
  assertEquals([before.old, before.orphan], [3 * MB, MB]);
  await sql(`UPDATE public.upload_sessions SET updated_at = now() - interval '25 hours' WHERE id = $1::uuid`, [old.json.id]);
  const gone = await until(async () => !(await exists(`${DIR}/${old.json.id}`)) && !(await exists(`${DIR}/${orphan}`)), 20_000);
  assert(gone, "the sweep removed the abandoned upload's pieces and the orphan folder");
  const after = await dirBytes(DIR);
  console.log(`U8 measured: upload volume ${before.total} bytes before the sweep, ${after} after (freed ${before.total - after}; the abandoned upload held ${before.old}, the orphan ${before.orphan})`);
  assert(before.total - after >= before.old + before.orphan, `freed ${before.total - after} >= ${before.old + before.orphan}`);
  assertEquals((await sql(`SELECT 1 FROM public.upload_sessions WHERE id = $1::uuid`, [old.json.id])).length, 0, "the row is gone");
  assertEquals((await call("GET", `${U}/${old.json.id}`, { as: A })).status, 404);
  const f = await call("GET", `${U}/${fresh.json.id}`, { as: A });
  assertEquals([f.status, f.json.received], [200, 3 * MB], "a fresh upload is untouched");
  assertEquals(await dirBytes(`${DIR}/${fresh.json.id}`), 3 * MB);
  await call("DELETE", `${U}/${fresh.json.id}`, { as: A });
  assert(!(await exists(`${DIR}/${fresh.json.id}`)), "cancel removes the pieces");
}});

Deno.test({ ...opts, name: "U9: one job however often finish is sent; a service key has no uploads; no route serves a piece's bytes", fn: async () => {
  const marker = `PieceMarker${rnd()}`;
  const file = pdf(200_000, 10);
  file.set(new TextEncoder().encode(marker), 100);
  const s = await start(A, `twice-${rnd()}.pdf`, file.length, shaOf(file));
  const id = s.json.id;
  assertEquals((await put(A, id, 0, file)).status, 200);
  // no route answers the piece's bytes, before or after the finish
  const probe = async () => {
    for (const p of [`${U}`, `${U}/${id}`, `${U}/${id}/pieces`, `${U}/${id}/pieces?offset=0`, `${U}/${id}/finish`, `/workbench/uploads/${id}`,
      `/workbench/uploads/${id}/p-0`, `/workbench/import/${id}`, `/workbench/intake/jobs?kinds=add`, `/workbench/contract/uploads/${id}/assembled`]) {
      for (const m of ["GET", "HEAD"]) {
        const r = await call(m, p, { as: A });
        assert(!r.text.includes(marker), `${m} ${p} served the piece`);
      }
    }
  };
  await probe();
  const before = await jobsOf(A);
  const both = await Promise.all([1, 2].map(() => call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } })));
  const ok = both.filter((r) => r.status === 202);
  assert(ok.length >= 1 && both.every((r) => r.status === 202 || r.status === 409), both.map((r) => `${r.status} ${r.text}`).join(" | "));
  const again = await call("POST", `${U}/${id}/finish`, { as: A, body: { refinery_id: refA } });
  assertEquals(again.status, 202, again.text);
  assert(ok.every((r) => r.json.job_id === again.json.job_id), "every finish answers the same job");
  assertEquals(await jobsOf(A), before + 1, "one job");
  await settled(A, again.json.job_id);
  await probe();
  const svc = await call("GET", U, { key: SVC_KEY });
  assertEquals(svc.status, 403, svc.text);
  assertEquals((await call("POST", U, { key: SVC_KEY, body: { filename: "x.pdf", size: 10, sha256: "ab".repeat(32) } })).status, 403);
}});
