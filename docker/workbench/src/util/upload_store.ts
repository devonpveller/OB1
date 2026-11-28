// An upload's bytes go to Postgres from a WORKER, never from the request thread (rw-upload-store-offthread).
//
// Why: deno-postgres turns a Uint8Array parameter into bytea text synchronously, about 0.5 s per MiB, on the one
// server thread. A 25 MiB import therefore froze every other request for about 15 s. The worker holds its own
// connection, encodes there (and faster), and writes the job row and its payload in ONE transaction: a failed save
// leaves no row at all, and the job is never visible without its bytes.
//
// The stored form is unchanged (import_job_payloads.bytes, bytea): no migration, and every reader is untouched.
import { config } from "../config.ts";
import type { StoreReply, StoreRequest } from "./upload_store_worker.ts";

// What the tests read to know a save really ran in a Worker (the reply carries the worker's own thread marker).
export const storeStats = { workerSaves: 0, lastInWorker: false };

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (r: Record<string, unknown>) => void; fail: (e: Error) => void }>();

function dead(why: string) {
  worker = null;
  for (const [, w] of waiting) w.fail(new Error(why));
  waiting.clear();
}

function start(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./upload_store_worker.ts", import.meta.url).href, { type: "module" });
  w.onmessage = (ev: MessageEvent<StoreReply>) => {
    const p = waiting.get(ev.data.id);
    if (!p) return;
    waiting.delete(ev.data.id);
    if (ev.data.error !== undefined) p.fail(new Error(ev.data.error));
    else {
      storeStats.workerSaves++;
      storeStats.lastInWorker = ev.data.inWorker === true;
      p.ok(ev.data.row ?? {});
    }
  };
  w.onerror = (ev) => { ev.preventDefault?.(); dead(`the upload store worker failed: ${ev.message}`); };
  w.postMessage({ conn: { hostname: config.db.host, port: config.db.port, database: config.db.database, user: config.db.user, password: config.db.password } });
  worker = w;
  return w;
}

// Insert the caller's job row (`jobSql`, which must RETURN a column `id`) and the file's payload in one
// transaction, off the request thread. Resolves to the job row.
export function insertJobWithPayload<T extends { id: string }>(
  jobSql: string,
  jobArgs: unknown[],
  filename: string,
  bytes: Uint8Array,
): Promise<T> {
  const w = start();
  const id = ++seq;
  return new Promise<T>((ok, fail) => {
    waiting.set(id, { ok: ok as (r: Record<string, unknown>) => void, fail });
    // a COPY of the bytes: the caller still needs its own (the pipeline reads them after the save)
    const copy = bytes.slice();
    const req: StoreRequest = { id, jobSql, jobArgs, filename, bytes: copy };
    try {
      w.postMessage(req, [copy.buffer]);
    } catch (e) {
      waiting.delete(id);
      fail(e as Error);
    }
  });
}

export function closeUploadStore(): void {
  if (worker) worker.terminate();
  dead("the upload store was closed");
}
