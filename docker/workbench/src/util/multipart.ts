// A request's form body, read ONCE and parsed OFF the request thread (rw-upload-store-offthread, fix round 2).
//
// Why: `Request.formData()` of a 32 MiB upload holds the one server thread for ~0.7-1.0 s on deno 2.3.3. The seam
// (owner-scope) cloned and parsed the body, the route parsed it again, and the seam first decoded it as text: about 3 s
// of one held loop per upload (measured, findings "Attempt 2"), none of it in the store. Now the body is read as raw
// bytes once (streamed, so the loop is free between chunks), handed to a worker that parses it, and the text fields and
// the file's bytes come back by transfer (no copy). The seam and the route share the one result.
//
// Only the part named `file` keeps its bytes; every text field is kept in order (a repeated name is not lost).
import type { ParseReply, ParseRequest } from "./multipart_worker.ts";

export type UploadedFile = { name: string; type: string; size: number; bytes: Uint8Array<ArrayBuffer> };
export type Form = {
  entries: [string, string][]; // every text field, in body order
  fields: Record<string, string>; // the last value of each name, as Hono's parseBody gave it
  file: UploadedFile | null;
  empty: boolean; // the request carried no body at all
};

// What the tests read to know the parse really ran in a worker, and how many bodies were parsed there.
export const parseStats = { workerParses: 0, lastInWorker: false };

const NONE: Form = { entries: [], fields: {}, file: null, empty: true };
const mediaOf = (req: Request) => (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (r: ParseReply) => void; fail: (e: Error) => void }>();

function dead(why: string) {
  worker = null;
  for (const [, w] of waiting) w.fail(new Error(why));
  waiting.clear();
}
function start(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./multipart_worker.ts", import.meta.url).href, { type: "module" });
  w.onmessage = (ev: MessageEvent<ParseReply>) => {
    const p = waiting.get(ev.data.id);
    if (!p) return;
    waiting.delete(ev.data.id);
    if (ev.data.error !== undefined) p.fail(new Error(ev.data.error));
    else p.ok(ev.data);
  };
  w.onerror = (ev) => { ev.preventDefault?.(); dead(`the multipart worker failed: ${ev.message}`); };
  worker = w;
  return w;
}
function parseInWorker(ct: string, buf: ArrayBuffer): Promise<ParseReply> {
  const w = start();
  const id = ++seq;
  return new Promise<ParseReply>((ok, fail) => {
    waiting.set(id, { ok, fail });
    const req: ParseRequest = { id, ct, buf };
    try { w.postMessage(req, [buf]); } catch (e) { waiting.delete(id); fail(e as Error); }
  });
}

function build(entries: [string, string][], file: UploadedFile | null, empty = false): Form {
  const fields: Record<string, string> = Object.create(null);
  for (const [k, v] of entries) fields[k] = v;
  return { entries, fields, file, empty };
}

type Slot = { size: number; buf: ArrayBuffer };
const slots = new WeakMap<Request, Promise<Slot>>();
const forms = new WeakMap<Request, Promise<Form>>();

function slotOf(req: Request): Promise<Slot> {
  let p = slots.get(req);
  if (!p) {
    p = req.arrayBuffer().then((buf) => ({ size: buf.byteLength, buf }));
    slots.set(req, p);
  }
  return p;
}

// The body's size in bytes, reading it once (cached). Only for a multipart request: the caller knows that.
export async function multipartSizeOf(req: Request): Promise<number> {
  return (await slotOf(req)).size;
}

// The request's form body, however it is encoded: multipart is parsed off-thread, urlencoded (small) in place,
// anything else is an empty form (as Hono's parseBody returned {} for it). Cached per request: the seam and the route
// share one parse. Rejects when the body cannot be read as a form.
export function formOf(req: Request): Promise<Form> {
  let p = forms.get(req);
  if (p) return p;
  const media = mediaOf(req);
  p = (async (): Promise<Form> => {
    if (media === "multipart/form-data") {
      const slot = await slotOf(req);
      if (slot.size === 0) return NONE;
      const r = await parseInWorker(req.headers.get("content-type")!, slot.buf);
      parseStats.workerParses++;
      parseStats.lastInWorker = r.inWorker === true;
      const f = r.file ? { name: r.file.name, type: r.file.type, size: r.file.buf.byteLength, bytes: new Uint8Array(r.file.buf) } : null;
      return build(r.entries ?? [], f);
    }
    if (media === "application/x-www-form-urlencoded") {
      const entries: [string, string][] = [];
      for (const [k, v] of (await req.formData()).entries()) if (typeof v === "string") entries.push([k, v]);
      return build(entries, null);
    }
    return NONE;
  })();
  forms.set(req, p);
  return p;
}

export function closeMultipart(): void {
  if (worker) worker.terminate();
  dead("the multipart worker was closed");
}
