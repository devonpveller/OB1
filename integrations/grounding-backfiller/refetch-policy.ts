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
