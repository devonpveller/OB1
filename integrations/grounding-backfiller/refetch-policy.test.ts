/** Run: deno test refetch-policy.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEgress, refetchAllowDirect, routeFor, wantsDirectFallback } from "./refetch-policy.ts";

Deno.test("REFETCH_ALLOW_DIRECT defaults to false; only the literal true opts in", () => {
  assertEquals(refetchAllowDirect(undefined), false);
  assertEquals(refetchAllowDirect(""), false);
  assertEquals(refetchAllowDirect("false"), false);
  assertEquals(refetchAllowDirect("1"), false);
  assertEquals(refetchAllowDirect("yes"), false);
  assertEquals(refetchAllowDirect("true"), true);
  assertEquals(refetchAllowDirect(" TRUE "), true);
});

Deno.test("thin proxied text stays thin unless direct was explicitly allowed", () => {
  assertEquals(wantsDirectFallback("short", 500, false), false);
  assertEquals(wantsDirectFallback(null, 500, false), false);
  assertEquals(wantsDirectFallback("short", 500, true), true);
  assertEquals(wantsDirectFallback("x".repeat(600), 500, true), false);
});

// ── round 2: a configured proxy that cannot be built refuses, never goes direct ──
const FAKE = { close() {} } as unknown as Deno.HttpClient;

Deno.test("buildEgress: unbuildable configured proxy is REFUSE (was: null = direct)", () => {
  const s = buildEgress("bogus://::nope", "http://vpn:8888", () => { throw new Error("empty host"); });
  assertEquals(s.mode, "refuse");
  assertEquals(s.client, null);
  assertEquals(routeFor(s.mode, true), "refuse");
  assertEquals(routeFor(s.mode, false), "refuse"); // the opt-in fallback is refused too
});

Deno.test("buildEgress: real behaviour on a malformed URL (Deno.createHttpClient) is REFUSE", () => {
  assertEquals(buildEgress("bogus://::nope", "http://vpn:8888").mode, "refuse");
});

Deno.test("buildEgress: unset = the default proxy; explicit empty = direct", () => {
  assertEquals(buildEgress(undefined, "http://vpn:8888", () => FAKE).mode, "proxy");
  assertEquals(buildEgress(undefined, "http://vpn:8888", () => FAKE).proxyUrl, "http://vpn:8888");
  assertEquals(buildEgress("", "http://vpn:8888", () => FAKE).mode, "direct");
  assertEquals(routeFor("direct", true), "direct");
  assertEquals(routeFor("proxy", true), "proxy");
  assertEquals(routeFor("proxy", false), "direct");
});
