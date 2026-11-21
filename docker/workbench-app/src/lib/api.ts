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
// is /admin on the wire). So: any control character (C0, DEL), space or backslash is refused outright,
// raw or percent-encoded; a dot-segment is refused outright; and what is judged and logged is the RESOLVED
// URL: same origin, pathname under /workbench/. Returns pathname + search of that resolved URL.
const BAD_CHAR = /[\u0000-\u0020\u007f\\]/;
export function resolveWorkbenchUrl(url: string): string | null {
  if (typeof url !== "string" || !url.startsWith("/workbench/") || url.startsWith("//") || BAD_CHAR.test(url)) return null;
  const [pathPart] = url.split(/[?#]/);
  let decoded: string;
  try { decoded = decodeURIComponent(pathPart); } catch { return null; }
  if (BAD_CHAR.test(decoded) || !decoded.startsWith("/workbench/") || decoded.split("/").some((s) => s === ".." || s === ".")) return null;
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
  return await fetcher(target, { method: "GET", credentials: "same-origin" });
}
