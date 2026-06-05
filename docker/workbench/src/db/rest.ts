// Read-path PostgREST client (G8: reads may use PostgREST). Mirrors the
// recipe/compiler convention of hitting the OB1 Caddy /rest/v1 proxy, which
// strips auth and runs PostgREST as anon=service_role. Writes do NOT go here —
// they go through withTransaction (pool.ts) so they stay atomic.
import { config } from "../config.ts";

async function request(
  method: string,
  resource: string,
  opts: { query?: string; body?: unknown; prefer?: string } = {},
): Promise<unknown> {
  const url = `${config.restBase}/rest/v1/${resource}` +
    (opts.query ? (resource.includes("?") ? "&" : "?") + opts.query : "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Caddy strips auth; PostgREST uses anon=service_role. Non-empty apikey
    // just satisfies clients that expect it.
    apikey: "local-trust",
  };
  if (opts.prefer) headers["prefer"] = opts.prefer;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    throw new Error(`REST ${method} ${resource} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const rest = {
  get: <T = unknown>(resource: string, query?: string) =>
    request("GET", resource, { query }) as Promise<T>,
  restHealthy: async (): Promise<boolean> => {
    try {
      await fetch(`${config.restBase}/healthz`);
      return true;
    } catch {
      return false;
    }
  },
};
