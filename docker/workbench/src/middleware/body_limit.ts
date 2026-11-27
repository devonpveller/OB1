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
//   - MAX_UPLOAD_BYTES (100 MiB): ONLY a multipart file upload on the three routes that take one (import, intake add,
//     source replace-from-upload). The file is the body; the intake add refuses a file over 25 MiB itself, import and
//     replace never had a limit but the edge's 100 MB. (The old portal edge allowed 100 MB on those routes.)
// Env: WORKBENCH_MAX_BODY_BYTES, WORKBENCH_MAX_UPLOAD_BYTES (a positive integer; anything else keeps the default).
// The cap is on the BODY bytes of a write (POST, PUT, PATCH, DELETE, anything but GET/HEAD/OPTIONS); a read has none.
import type { Context, Next } from "hono";
import { seamPath } from "./identity.ts";

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// the intake add's own file ceiling (src/intake/routes.ts reads it from here), and what a file-bearing multipart body
// adds around the file (boundaries, the text fields): a test shows the largest file plus this fits under the upload cap
export const INTAKE_MAX_FILE_BYTES = 25 * 1024 * 1024;

// the routes whose body may be a multipart file upload (matched on the path the seam judged, as the router routes it)
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
  return media === "multipart/form-data" && UPLOAD_ROUTES.some((r) => r.test(route)) ? maxUploadBytes() : maxBodyBytes();
}

const tooLarge = (c: Context, cap: number) =>
  c.json({ error: `the request is too large (at most ${cap} bytes)` }, 413);

export function bodyLimit() {
  return async (c: Context, next: Next) => {
    if (!MUTATING(c.req.method)) return await next();
    const cap = capFor(seamPath(c), c.req.header("content-type") ?? "");
    const declared = c.req.header("content-length");
    if (declared !== undefined && /^\s*\d+\s*$/.test(declared)) {
      // the server frames the body by this length, so it cannot carry more than it says
      return Number(declared) > cap ? tooLarge(c, cap) : await next();
    }
    // no usable length (chunked): count as it arrives, stop at the cap, and hand the rest of the chain the bytes read
    const stream = c.req.raw.body;
    if (!stream) return await next();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
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
    c.req.raw = new Request(c.req.raw, { body: bytes });
    return await next();
  };
}
