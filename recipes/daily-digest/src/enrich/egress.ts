/**
 * External-fetch egress through the stack's Tor boundary (privacy).
 *
 * The stack already runs a `tor` container exposing a SOCKS5 proxy at
 * `tor:9050` on the internal `search-net` (SearXNG uses it for private search).
 * Page fetches historically went DIRECT — this module routes the link stage's
 * outbound article / robots / redirect fetches through that same Tor proxy so
 * following newsletter links doesn't reveal the home IP to publishers.
 *
 * Privacy-by-default + fail-closed: `FETCH_PROXY_URL` defaults to the Tor SOCKS
 * proxy. If it's unreachable (e.g. the container isn't on search-net), the
 * fetch fails and the caller marks the link `email-only` — it never silently
 * falls back to a direct request. Set `FETCH_PROXY_URL=""` to opt OUT (direct).
 *
 * NOTE: `Deno.createHttpClient({ proxy })` needs the `--unstable-net` flag.
 * ONLY external article fetches use this — internal calls (llama-cpp, curator,
 * postgrest) stay on plain `fetch`.
 */

const DEFAULT_PROXY = "socks5://tor:9050";

let client: Deno.HttpClient | null | undefined; // undefined=uninit, null=direct

function getClient(): Deno.HttpClient | null {
  if (client !== undefined) return client;
  const url = Deno.env.get("FETCH_PROXY_URL") ?? DEFAULT_PROXY;
  client = url.trim() ? Deno.createHttpClient({ proxy: { url: url.trim() } }) : null;
  return client;
}

/** Is the egress proxied (true) or direct (false)? For logging. */
export function egressMode(): string {
  return getClient() ? (Deno.env.get("FETCH_PROXY_URL") ?? DEFAULT_PROXY) : "direct";
}

/** fetch() that routes through the configured Tor proxy when one is set. */
export function proxiedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const c = getClient();
  return c ? fetch(input, { ...init, client: c }) : fetch(input, init);
}

/** Release the shared client (call once at process end). */
export function closeEgress(): void {
  if (client) client.close();
  client = undefined;
}
