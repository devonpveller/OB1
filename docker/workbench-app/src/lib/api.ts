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

// true only for a path-absolute /workbench/... URL: no scheme, no host, no "//", no backslash, no
// dot-segment that could climb out of /workbench
export function isWorkbenchUrl(url: string): boolean {
  if (typeof url !== "string" || !url.startsWith("/workbench/")) return false;
  if (url.startsWith("//") || url.includes("\\")) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(url.split(/[?#]/)[0]); } catch { return false; }
  if (decoded.includes("\\")) return false;
  return decoded.startsWith("/workbench/") && !decoded.split("/").some((s) => s === ".." || s === ".");
}

function guard(url: string) {
  if (!isWorkbenchUrl(url)) throw new ApiError(0, { error: `refused: ${url} is not a same-origin /workbench/* path` });
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  guard(url);
  log.push({ method, url });
  const r = await fetcher(url, {
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
  guard(url);
  log.push({ method: "GET", url });
  return await fetcher(url, { method: "GET", credentials: "same-origin" });
}
