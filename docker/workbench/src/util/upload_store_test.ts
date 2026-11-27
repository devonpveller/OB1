// deno test src/util/upload_store_test.ts - the upload store (rw-upload-store-offthread).
//
// The hex encoder is pure and always runs. The rest needs a DISPOSABLE Postgres that has public.import_jobs
// (id uuid, status text, filename text, ...) and public.import_job_payloads (the real initdb chain gives both):
// set UPLOAD_STORE_TEST_DB=1 together with DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD (the workbench's own
// variables, read when config.ts loads). It writes rows tagged `upload-store-test`: never point it at a live stack.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { insertJobWithPayload, closeUploadStore } from "./upload_store.ts";
import { hexOf } from "./upload_store_worker.ts";

const live = Deno.env.get("UPLOAD_STORE_TEST_DB") === "1";
const MiB = 1024 * 1024;
const TAG = "upload-store-test";
const JOB_SQL = `INSERT INTO public.import_jobs (status, filename) VALUES ('queued', $1) RETURNING id::text AS id, status`;

const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
function pattern(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}

Deno.test("hexOf: every byte value, lower case, no separators", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assertEquals(hexOf(all), [...all].map((v) => v.toString(16).padStart(2, "0")).join(""));
  assertEquals(hexOf(new Uint8Array()), "");
  assertEquals(hexOf(Uint8Array.of(0, 255, 16)), "00ff10");
});

Deno.test("hexOf: 32 MiB is a small fraction of deno-postgres' own encoder (under 3 s)", () => {
  const t = performance.now();
  const h = hexOf(pattern(32 * MiB));
  assertEquals(h.length, 64 * MiB);
  assert(performance.now() - t < 3000, `32 MiB took ${(performance.now() - t).toFixed(0)} ms`);
});

function dbPool() {
  return new Pool({
    hostname: Deno.env.get("DB_HOST") ?? "127.0.0.1", port: Number(Deno.env.get("DB_PORT") ?? 5432), database: Deno.env.get("DB_NAME") ?? "postgres",
    user: Deno.env.get("DB_USER") ?? "postgres", password: Deno.env.get("DB_PASSWORD") ?? "",
  }, 1, true);
}
async function sql<T>(text: string, args: unknown[] = []): Promise<T[]> {
  const p = dbPool();
  const c = await p.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); await p.end(); }
}

// How long the event loop was held in one piece while `work` ran (a timer that should fire every 10 ms).
async function worstStall<T>(work: () => Promise<T>): Promise<{ out: T; worst: number; ms: number }> {
  let worst = 0, stop = false;
  const tick = (async () => {
    while (!stop) { const t = performance.now(); await new Promise((r) => setTimeout(r, 10)); worst = Math.max(worst, performance.now() - t - 10); }
  })();
  await new Promise((r) => setTimeout(r, 30));
  worst = 0;
  const t0 = performance.now();
  const out = await work();
  const ms = performance.now() - t0;
  stop = true;
  await tick;
  return { out, worst, ms };
}

Deno.test({ name: "stored bytes equal the uploaded bytes (hash compared in the database), 0 B to 5 MiB", ignore: !live, sanitizeResources: false, sanitizeOps: false, async fn() {
  for (const n of [0, 1, 255, 256, 65537, 5 * MiB]) {
    const bytes = n === 256 ? Uint8Array.from({ length: 256 }, (_, i) => i) : pattern(n, n + 1);
    const before = await sha(bytes);
    const row = await insertJobWithPayload<{ id: string; status: string }>(JOB_SQL, [`${TAG}-${n}`], `f${n}.bin`, bytes);
    assertEquals(row.status, "queued");
    assertEquals(await sha(bytes), before, "the caller's own bytes are untouched (the worker got a copy)");
    const got = (await sql<{ len: number; h: string; filename: string }>(
      `SELECT length(bytes) AS len, encode(sha256(bytes), 'hex') AS h, filename FROM public.import_job_payloads WHERE job_id = $1::uuid`, [row.id]))[0];
    assertEquals(Number(got.len), n);
    assertEquals(got.h, before, `size ${n}`);
    assertEquals(got.filename, `f${n}.bin`);
  }
  closeUploadStore();
}});

Deno.test({ name: "a 32 MiB save does not hold the event loop (the bystander is answered within 1 s)", ignore: !live, sanitizeResources: false, sanitizeOps: false, async fn() {
  const bytes = pattern(32 * MiB, 99);
  const want = await sha(bytes);
  const r = await worstStall(() => insertJobWithPayload<{ id: string }>(JOB_SQL, [`${TAG}-32`], "big.bin", bytes));
  console.log(`32 MiB saved in ${r.ms.toFixed(0)} ms; worst event-loop stall ${r.worst.toFixed(0)} ms`);
  assert(r.worst < 1000, `the event loop was held ${r.worst.toFixed(0)} ms`);
  const h = (await sql<{ h: string }>(`SELECT encode(sha256(bytes), 'hex') AS h FROM public.import_job_payloads WHERE job_id = $1::uuid`, [r.out.id]))[0].h;
  assertEquals(h, want);
  closeUploadStore();
}});

Deno.test({ name: "CONTROL (UPLOAD_STORE_CONTROL=1): the old way, deno-postgres' own encode on this thread, holds the loop", ignore: !live || Deno.env.get("UPLOAD_STORE_CONTROL") !== "1", sanitizeResources: false, sanitizeOps: false, async fn() {
  const bytes = pattern(8 * MiB, 5);
  const p = dbPool();
  const c = await p.connect();
  try {
    const id = (await c.queryObject<{ id: string }>(JOB_SQL, [`${TAG}-old`])).rows[0].id;
    const r = await worstStall(() => c.queryObject(`INSERT INTO public.import_job_payloads (job_id, filename, bytes) VALUES ($1::uuid, 'old.bin', $2)`, [id, bytes]));
    console.log(`CONTROL 8 MiB the old way: ${r.ms.toFixed(0)} ms, worst event-loop stall ${r.worst.toFixed(0)} ms`);
    assert(r.worst > 1000, `the old way stalled only ${r.worst.toFixed(0)} ms`);
  } finally { c.release(); await p.end(); }
}});

Deno.test({ name: "a failed save leaves no row: the job insert is rolled back with the payload", ignore: !live, sanitizeResources: false, sanitizeOps: false, async fn() {
  const marker = `${TAG}-fail-${crypto.randomUUID()}`;
  // a null filename breaks the payload's NOT NULL AFTER the job row was inserted
  await assertRejects(() => insertJobWithPayload(JOB_SQL, [marker], null as unknown as string, pattern(1000)));
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_jobs WHERE filename = $1`, [marker]))[0].n, 0);
  // and the store still works afterwards (the failed transaction did not poison the connection)
  const ok = await insertJobWithPayload<{ id: string }>(JOB_SQL, [`${TAG}-after`], "a.bin", pattern(10));
  assert(ok.id);
  closeUploadStore();
}});

Deno.test({ name: "a bad job insert rejects and writes nothing", ignore: !live, sanitizeResources: false, sanitizeOps: false, async fn() {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_job_payloads`))[0].n;
  await assertRejects(() => insertJobWithPayload(`INSERT INTO public.import_jobs (no_such_column) VALUES ($1) RETURNING id::text AS id`, ["x"], "a.bin", pattern(10)));
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.import_job_payloads`))[0].n, before);
  closeUploadStore();
}});
