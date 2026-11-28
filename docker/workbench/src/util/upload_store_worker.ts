// The worker half of upload_store.ts (rw-upload-store-offthread). It owns its OWN database connection and does the
// two costly things the request thread must never do with an upload: turn its bytes into the text form
// Postgres reads, and push that text down the socket. One transaction per upload: the job row and its payload
// commit together or not at all.
import { Pool } from "postgres";

export type StoreRequest = {
  id: number;
  jobSql: string; // the caller's own INSERT of the job row, RETURNING its id (the caller keeps its columns and scoping)
  jobArgs: unknown[];
  filename: string;
  bytes: Uint8Array; // a copy owned by this message
};
export type ReadRequest = { id: number; read: string }; // a job's stored payload, by job id
export type StoreReply = {
  id: number;
  row?: Record<string, unknown>;
  payload?: { filename: string; buf: ArrayBuffer } | null; // the answer to a ReadRequest (null = no payload row)
  error?: string;
  inWorker?: boolean;
};

const DIGITS = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]); // 0-9a-f
const ASCII = new TextDecoder("latin1");

// Lower-case hex of `b`. deno-postgres' own bytea encoder does about 0.5 s per MiB; this table walk is a
// small fraction of that, and it runs on this thread, not the server's.
// Counted INSIDE the work functions, per module instance: a Worker has its own instance, so the request thread's counts
// stay at zero while the work really runs in the worker. A caller cannot fake this by setting a flag: the count is made
// by the costly code itself, and the tests assert the request thread's count did not move.
export const work = { hexOf: 0, storeOne: 0, readOne: 0 };

export function hexOf(b: Uint8Array): string {
  work.hexOf++;
  const out = new Uint8Array(b.length * 2);
  for (let i = 0, j = 0; i < b.length; i++) {
    const v = b[i];
    out[j++] = DIGITS[v >> 4];
    out[j++] = DIGITS[v & 15];
  }
  return ASCII.decode(out);
}

export type Conn = { hostname: string; port: number; database: string; user: string; password: string };
let pool: Pool | null = null;

export async function storeOne(conn: Conn, r: StoreRequest): Promise<Record<string, unknown>> {
  work.storeOne++;
  pool ??= new Pool(conn, 2);
  const hex = hexOf(r.bytes);
  const c = await pool.connect();
  try {
    await c.queryObject("BEGIN");
    try {
      const row = (await c.queryObject<Record<string, unknown>>(r.jobSql, r.jobArgs)).rows[0];
      if (!row || row.id == null) throw new Error("the job insert returned no id");
      await c.queryObject(
        `INSERT INTO public.import_job_payloads (job_id, filename, bytes) VALUES ($1, $2, decode($3, 'hex'))`,
        [row.id, r.filename, hex],
      );
      await c.queryObject("COMMIT");
      return row;
    } catch (e) {
      try { await c.queryObject("ROLLBACK"); } catch { /* connection already broken: nothing to roll back */ }
      throw e;
    }
  } finally {
    c.release();
  }
}

// Read a job's stored file back. deno-postgres turns a bytea column into bytes with a per-byte loop on the thread that
// reads it (measured: 16 MiB holds the loop ~1.6 s, a 32 MiB payload about 3 s), so the read happens here, in the worker,
// and the bytes go back by transfer.
export async function readOne(conn: Conn, jobId: string): Promise<{ filename: string; buf: ArrayBuffer } | null> {
  work.readOne++;
  pool ??= new Pool(conn, 2);
  const c = await pool.connect();
  try {
    const r = (await c.queryObject<{ filename: string; bytes: Uint8Array }>(
      `SELECT filename, bytes FROM public.import_job_payloads WHERE job_id = $1`, [jobId])).rows[0];
    if (!r) return null;
    const b = r.bytes;
    const buf = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer as ArrayBuffer : b.slice().buffer as ArrayBuffer;
    return { filename: r.filename, buf };
  } finally {
    c.release();
  }
}

// Only a real worker listens; imported on the main thread (tests use hexOf / storeOne) this is a no-op.
const WGS = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
const inWorker = !!WGS && self instanceof (WGS as unknown as { new (): unknown });
if (inWorker) {
  let conn: Conn | null = null;
  // One upload at a time: the encode is the long part and runs here either way; a queue keeps memory at one hex copy.
  let chain: Promise<unknown> = Promise.resolve();
  (self as unknown as { onmessage: (ev: MessageEvent<{ conn: Conn } | StoreRequest | ReadRequest>) => void }).onmessage = (ev) => {
    const m = ev.data;
    if ("conn" in m) { conn = m.conn; return; }
    if ("read" in m) {
      chain = chain.then(async () => {
        let reply: StoreReply;
        try {
          reply = { id: m.id, payload: await readOne(conn!, m.read), inWorker };
        } catch (e) {
          reply = { id: m.id, error: String((e as Error)?.message ?? e).slice(0, 500), inWorker };
        }
        (self as unknown as { postMessage(r: StoreReply, t: Transferable[]): void }).postMessage(reply, reply.payload ? [reply.payload.buf] : []);
      });
      return;
    }
    chain = chain.then(async () => {
      let reply: StoreReply;
      try {
        reply = { id: m.id, row: await storeOne(conn!, m), inWorker };
      } catch (e) {
        reply = { id: m.id, error: String((e as Error)?.message ?? e).slice(0, 500), inWorker };
      }
      (self as unknown as { postMessage(r: StoreReply): void }).postMessage(reply);
    });
  };
}
