// The workspace's one door to the back end: same-origin /workbench/* (Caddy injects the key, the
// browser never holds it). Every request goes through here, so a test can see exactly what a
// screen fetched (D12: a document opens without a page-route, render-module or contract page call;
// opening fetches no reference text until one is opened).
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

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
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

// A GET whose answer may be a FILE (research-workbench P6b: the export): the raw response, through the
// same door and the same request log.
export async function raw(url: string): Promise<Response> {
  log.push({ method: "GET", url });
  return await fetcher(url, { method: "GET", credentials: "same-origin" });
}

export const get = <T = any>(url: string) => api<T>("GET", url).then((r) => r.data);
export const post = <T = any>(url: string, body?: unknown) => api<T>("POST", url, body ?? {}).then((r) => r.data);
export const q = encodeURIComponent;

export const C = "/workbench/contract";
export const D = "/workbench/documents";
export const W = "/workbench/workspace";
