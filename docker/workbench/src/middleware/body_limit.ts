// rw-body-size-stall: the request body cap. ONE middleware, mounted on /workbench/* before the owner scope, so a write
// whose body is too big is answered 413 (a plain message) before anything parses, walks or stores it - through both
// doors (the door key and the forward-auth sign-in) and every write route, whatever the route.
//
// Why (2026-11-27, two testers): any signed-in person could stall the shared workbench with one large body; the owner
// scope's path scan took time in the square of a string's length (40 KB 4.6 s, 160 KB over 30 s, 1 MB never). The scan
// is linear now (documents/ownership.ts documentPathsIn); this cap bounds what is read at all.
//
// Two caps, by what a body legitimately is:
//   - MAX_BODY_BYTES (4 MiB): every JSON, text or form body. The largest real one is a document or note save, whose text
//     is bounded in practice by the export's own note ceiling (1,000,000 bytes: a bigger note cannot be exported). Four
//     times that leaves room for JSON escaping and the envelope. (The old portal edge allowed 2 MB here.)
//   - MAX_UPLOAD_BYTES (32 MiB): ONLY a multipart file upload on the three routes that take one (import, intake add,
//     source replace-from-upload). The file is the body; the intake add refuses a file over 25 MiB itself. The form is read
//     once and parsed in a WORKER (util/multipart.ts, rw-upload-store-offthread), and the file is stored from another worker,
//     so an upload no longer holds the one thread for its parse (measured 60-100 ms of it for 32 MiB on deno 2.3.3). The cap
//     bounds memory and time, not the thread. (The old portal edge and the viewer allow 100 MB.)
// Env: WORKBENCH_MAX_BODY_BYTES, WORKBENCH_MAX_UPLOAD_BYTES (a positive integer; anything else keeps the default).
// The cap is on the BODY bytes of a write (POST, PUT, PATCH, DELETE, anything but GET/HEAD/OPTIONS); a read has none.
import type { Context, Next } from "hono";
import { seamPath } from "./identity.ts";

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
// the most text a form body may carry in the fields the owner scope scans (a path, a url, an id: a few hundred characters);
// the file parts are not text and are not counted. Over it the owner scope answers 413 (src/middleware/owner-scope.ts).
export const FORM_TEXT_MAX_CHARS = 64 * 1024;
// the intake add's own file ceiling (src/intake/routes.ts reads it from here); a test shows the largest file plus what a
// file-bearing multipart body adds around it (boundaries, the text fields) fits under the upload cap
export const INTAKE_MAX_FILE_BYTES = 25 * 1024 * 1024;

// The routes whose body may be a multipart file upload (matched on the path the seam judged, as the router routes it).
// On these the owner scope reads a multipart body ONCE and parses it in a worker (util/multipart.ts formOf), and CONSUMES it:
// a handler here must read the form with formOf, never c.req.parseBody / arrayBuffer. Any OTHER multipart request keeps the
// owner scope's clone-and-read behaviour (the body stays whole), so a route that reads the raw body itself is not broken.
export const isUploadRoute = (route: string) => UPLOAD_ROUTES.some((r) => r.test(route));
export const UPLOAD_ROUTES: RegExp[] = [
  /^\/workbench\/import\/?$/,
  /^\/workbench\/intake\/add\/?$/,
  /^\/workbench\/sources\/[^/]+\/replace-from-upload\/?$/,
];

const MUTATING = (m: string) => !["GET", "HEAD", "OPTIONS"].includes(m);

function envBytes(name: string, dflt: number): number {
  const n = Number((Deno.env.get(name) ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : dflt;
}
export const maxBodyBytes = () => envBytes("WORKBENCH_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);
export const maxUploadBytes = () => envBytes("WORKBENCH_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);

export function capFor(route: string, contentType: string): number {
  const media = contentType.split(";")[0].trim().toLowerCase();
  return media === "multipart/form-data" && isUploadRoute(route) ? maxUploadBytes() : maxBodyBytes();
}

const tooLarge = (c: Context, cap: number) =>
  c.json({ error: `the request is too large (at most ${cap} bytes)` }, 413);

let lastWarn = 0;
function warnUnreadable(route: string, bytes: number, e: unknown) {
  const now = Date.now();
  if (now - lastWarn < 10_000) return;
  lastWarn = now;
  console.warn(`[workbench] body-limit: a request body could not be read (${route}, ${bytes} bytes counted): ${(e as Error)?.message ?? e}`);
}

export function bodyLimit() {
  return async (c: Context, next: Next) => {
    if (!MUTATING(c.req.method)) return await next();
    const cap = capFor(seamPath(c), c.req.header("content-type") ?? "");
    const declared = c.req.header("content-length");
    // A length is trusted ONLY when the body is framed by it. With a Transfer-Encoding header the server frames the body by
    // the encoding and still hands the app a Content-Length (`Content-Length: 10` + `Transfer-Encoding: chunked` let 64 MiB
    // through, tester attempt 1 D1), so then the header means nothing: the stream is counted.
    if (declared !== undefined && /^\s*\d+\s*$/.test(declared) && c.req.header("transfer-encoding") === undefined) {
      // the server frames the body by this length, so it cannot carry more than it says
      if (Number(declared) > cap) return tooLarge(c, cap);
      return await next();
    }
    // no usable length (chunked, or a length that does not frame it): count as it arrives, stop at the cap, and hand the
    // rest of the chain the bytes read
    const stream = c.req.raw.body;
    if (!stream) return await next();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (e) {
        // the body stream failed part-way: deno's own body reader (deno 2.3.3: "error reading a body from connection" on a fast
        // chunked body of about 3 MiB or more) or a dropped connection. Not a fault in this app, so not its 500; but it is logged
        // (once per 10 s: route and bytes counted so far, never the body), as the 500 was, so the signal is not lost
        warnUnreadable(seamPath(c), n, e);
        return c.json({ error: "the request body could not be read" }, 400);
      }
      const { done, value } = part;
      if (done) break;
      n += value.byteLength;
      if (n > cap) {
        await reader.cancel().catch(() => {});
        return tooLarge(c, cap);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const ch of chunks) { bytes.set(ch, at); at += ch.byteLength; }
    // the rebuilt request is framed by its bytes: the two framing headers it arrived with are dropped
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    c.req.raw = new Request(c.req.raw, { body: bytes, headers });
    return await next();
  };
}
