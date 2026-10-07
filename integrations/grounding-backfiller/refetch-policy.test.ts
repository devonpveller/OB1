/** Run: deno test refetch-policy.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { refetchAllowDirect, wantsDirectFallback } from "./refetch-policy.ts";

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
