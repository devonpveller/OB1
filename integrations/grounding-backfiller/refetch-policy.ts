/**
 * refetch-policy.ts - when may POST /refetch fall back to a DIRECT fetch?
 * (egress-hardening item eh-ingest, 2026-10-07)
 *
 * Until this file, REFETCH_ALLOW_DIRECT defaulted to TRUE: any value but the literal
 * "false" (unset included) let refetchOne() retry a thin proxied fetch DIRECTLY,
 * from the operator's IP. The posture is "direct fallback = leak", so the default is
 * now FALSE and only the literal "true" opts in - a typo or an empty value stays on
 * the proxy. A source whose proxied fetch comes back thin stays thin (and is counted
 * toward refetch_failed as before); it is never "healed" by leaving the tunnel.
 */
export function refetchAllowDirect(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/** The fallback decision refetchOne() makes after the proxied attempt. */
export function wantsDirectFallback(proxiedText: string | null, minRecovered: number, allowDirect: boolean): boolean {
  return allowDirect && (!proxiedText || proxiedText.length < minRecovered);
}

// ---------------------------------------------------------------------------
// Proxy policy (round 2, tester attempt 1): research-service lib.ts proxyPolicy,
// verbatim, as openbrain-mcp's ingest-egress.ts uses it. Before this, getClient()
// caught a createHttpClient failure on a CONFIGURED proxy (e.g. a malformed
// FETCH_PROXY_URL) and set the client to null - and null meant DIRECT for every
// later fetch, Wikipedia and refetch alike. Now a configured-but-unbuildable
// proxy is REFUSE: no fetch at all, logged once at start. Direct only when
// FETCH_PROXY_URL is explicitly empty.
// ---------------------------------------------------------------------------

export type ProxyPolicy = "proxy" | "direct" | "refuse";

export function proxyPolicy(url: string, clientBuilt: boolean): ProxyPolicy {
  if (!url.trim()) return "direct";
  return clientBuilt ? "proxy" : "refuse";
}

export interface EgressState {
  mode: ProxyPolicy;
  proxyUrl: string;
  client: Deno.HttpClient | null;
  error: string;
}

export function buildEgress(
  envValue: string | undefined,
  defaultUrl: string,
  build: (url: string) => Deno.HttpClient = (url) => Deno.createHttpClient({ proxy: { url } }),
): EgressState {
  const proxyUrl = (envValue ?? defaultUrl).trim();
  let client: Deno.HttpClient | null = null;
  let error = "";
  if (proxyUrl) {
    try {
      client = build(proxyUrl);
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
  }
  return { mode: proxyPolicy(proxyUrl, client !== null), proxyUrl, client, error };
}

/** How ONE fetch goes out. `viaProxy` = the caller wants the proxy (every fetch but the
 *  opt-in refetch fallback). REFUSE in refuse mode, whatever was asked - including the
 *  REFETCH_ALLOW_DIRECT fallback: a broken proxy config is not an invitation to go direct. */
export function routeFor(mode: ProxyPolicy, viaProxy: boolean): "proxy" | "direct" | "refuse" {
  if (mode === "refuse") return "refuse";
  if (mode === "direct") return "direct";
  return viaProxy ? "proxy" : "direct";
}
