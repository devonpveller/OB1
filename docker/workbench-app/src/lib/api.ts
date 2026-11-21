// The app's ONE door to the back end: same-origin /workbench/* only (the server in front of it,
// serve.mjs, injects the door key; the browser never holds one). Every screen fetches through here,
// so a test can read exactly what the app asked for (requestLog), and a URL that is not a same-origin
// /workbench/* path is refused before any request is made.
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (u, i) => fetch(u, i);
const log: { method: string; url: string }[] = [];

export function setFetcher(f: Fetcher) {
  fetcher = f;
}
export function requestLog() {
  return log;
}
export function clearRequestLog() {
  log.length = 0;
}

export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body?.error ?? `HTTP ${status}`));
  }
}

// The URL that will actually leave, or null. fetch() strips ASCII tab / CR / LF from a URL BEFORE it
// resolves dot-segments, so a guard that reads the raw string can be walked past ("/workbench/.<TAB>./admin"
// is /admin on the wire). So: any control character (C0, DEL) or backslash is refused outright, raw or
// percent-encoded, in any decoding; a dot-segment is refused outright, in any decoding; and what is judged
// and logged is the RESOLVED URL: same origin, pathname under /workbench/. A space is NOT a hazard: ids and
// note paths hold them (sent as %20), and a literal "%" is sent as %25 - so a later decode pass that meets
// such a bare "%" ends the decoding instead of refusing (only the FIRST decode must succeed). A raw
// (unencoded) space in the URL is still refused: callers encode. Returns pathname + search of the resolved URL.
const BAD_CHAR = /[\u0000-\u001f\u007f\\]/;
const RAW_BAD = /[\u0000-\u0020\u007f\\]/;
const dotSegment = (p: string) => p.split("/").some((s) => s === ".." || s === ".");
export function resolveWorkbenchUrl(url: string): string | null {
  if (typeof url !== "string" || !url.startsWith("/workbench/") || url.startsWith("//") || RAW_BAD.test(url)) return null;
  const [pathPart] = url.split(/[?#]/);
  let p = pathPart;
  let settled = false;
  for (let i = 0; i < 6; i++) {
    if (BAD_CHAR.test(p) || !p.startsWith("/workbench/") || dotSegment(p)) return null;
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      if (i === 0) return null;
      // a later pass met a literal "%": decode the well-formed %XX escapes one by one, so a traversal behind it is still seen
      d = p.replace(/%[0-9a-f]{2}/gi, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
    }
    if (d === p) { settled = true; break; }
    p = d;
  }
  if (!settled) return null; // still changing after the passes: too deeply encoded, refused like the forwarder does
  let u: URL;
  try { u = new URL(url, location.origin); } catch { return null; }
  if (u.origin !== location.origin || !u.pathname.startsWith("/workbench/")) return null;
  return u.pathname + u.search;
}
export function isWorkbenchUrl(url: string): boolean {
  return resolveWorkbenchUrl(url) !== null;
}

function guard(url: string): string {
  const r = resolveWorkbenchUrl(url);
  if (r === null) throw new ApiError(0, { error: `refused: ${JSON.stringify(url)} is not a same-origin /workbench/* path` });
  return r;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const target = guard(url);
  log.push({ method, url: target });
  const r = await fetcher(target, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store", // the answers are one person's data: the browser must not keep them in its HTTP cache
  });
  const text = await r.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!r.ok && r.status !== 207) throw new ApiError(r.status, data);
  return { status: r.status, data };
}

// A GET whose answer may be a FILE: the raw response, through the same door and the same log.
export async function raw(url: string): Promise<Response> {
  const target = guard(url);
  log.push({ method: "GET", url: target });
  return await fetcher(target, { method: "GET", credentials: "same-origin", cache: "no-store" });
}
