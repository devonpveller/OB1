/** The offline "network" for the scholarly resolver: fixtures/scholarly/responses.json behind a
 *  stub fetch that answers ONLY when the call carries the egress proxy client (rw-p3a-entail). */
import { createScholarlyResolver, proxiedFetch } from "../scholarly.ts";

const RESPONSES: Record<string, { status: number; body: unknown }> =
  JSON.parse(Deno.readTextFileSync(new URL("./scholarly/responses.json", import.meta.url)));
export const PROXY_CLIENT = { sentinel: "the FETCH_PROXY_URL client" };

/** A stub of the network that only answers through the proxy client, and logs every call. */
export function fixtureNetwork() {
  const calls: Array<{ url: string; client: unknown }> = [];
  const raw = (url: string, init: RequestInit & { client?: unknown } = {}): Promise<Response> => {
    calls.push({ url, client: init.client });
    if (init.client !== PROXY_CLIENT) return Promise.reject(new Error(`EGRESS BYPASS: ${url} without the proxy client`));
    const u = new URL(url);
    const service = u.hostname === "api.openalex.org" ? "openalex" : u.hostname === "api.crossref.org" ? "crossref" : u.hostname;
    const [, coll, ...rest] = decodeURIComponent(u.pathname).split("/");
    const key = coll === "authors"
      ? `${service} authors ${decodeURIComponent(u.searchParams.get("filter") ?? "")}`
      : `${service} ${coll} ${rest.join("/")}`;
    if (service === "openalex" && !u.searchParams.get("api_key")) return Promise.resolve(new Response("{}", { status: 403 }));
    const r = RESPONSES[key];
    if (!r) return Promise.resolve(new Response(JSON.stringify({ error: "no fixture", key }), { status: 404 }));
    return Promise.resolve(new Response(r.body === null ? "" : JSON.stringify(r.body), { status: r.status }));
  };
  return { raw, calls, fetch: proxiedFetch(raw, PROXY_CLIENT) };
}
export function fixtureResolver(net = fixtureNetwork()) {
  return createScholarlyResolver({ fetch: net.fetch, openalexKey: "test-key", mailto: "research@example.invalid",
    now: () => new Date("2026-10-17T00:00:00Z") });
}

