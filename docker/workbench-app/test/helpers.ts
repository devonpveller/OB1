// Test helpers: a fake back end behind the workspace's one fetch door (lib/api.ts), recording every
// request, so a test can assert what a screen fetched - and what it did not.
import { clearRequestLog, requestLog, setFetcher } from "../src/lib/api";

export type Route = [method: string, prefix: string | RegExp, reply: (url: string, body: any) => unknown, status?: number];

export function fakeApi(routes: Route[]) {
  clearRequestLog();
  const bodies: { method: string; url: string; body: any }[] = [];
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ method, url, body });
    for (const [m, p, reply, status] of routes) {
      if (m !== method) continue;
      if (typeof p === "string" ? url.startsWith(p) : p.test(url)) {
        return new Response(JSON.stringify(reply(url, body)), { status: status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: `no fake for ${method} ${url}` }), { status: 404 });
  });
  return { log: requestLog(), bodies };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
export async function settle(n = 5) {
  for (let i = 0; i < n; i++) await flush();
}

export const R1 = "a1000000-0000-4000-8000-000000000001";
export const R2 = "a1000000-0000-4000-8000-000000000002";
export const S1 = "b1000000-0000-4000-8000-000000000001";
export const S2 = "b1000000-0000-4000-8000-000000000002";
