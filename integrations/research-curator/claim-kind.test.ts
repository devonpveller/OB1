/**
 * research-workbench P3a attempt 2 (rw-p3a-entail; tester t-rw-p3a near-miss): a research package
 * filed after P3a without its claim kind is a LOUD failure (D15 item 9), not a claim filed under
 * the fallback kind with the basis "filed before P3a". The database half (the cutover marker,
 * credibility_trigger_state.kind_required_from) is in research-service/credibility.e2e.test.ts.
 * Run: deno test claim-kind.test.ts
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ClaimKindMissingError, claimMetadataFor } from "./claims.ts";

Deno.test("a package without a claim kind files no claim: ClaimKindMissingError, never the fallback", () => {
  for (const pkg of [{}, { claim_kind: "" }, { claim_kind: null }, { claim_kind: 7 }, { claim_kind: "Not A Key" }, { credibility_model: "d15 weights v1 paper p1" }]) {
    assertThrows(() => claimMetadataFor(pkg as never), ClaimKindMissingError, "no valid claim_kind", JSON.stringify(pkg));
  }
});

Deno.test("a package with its claim kind files claims stamped with the kind and the model version", () => {
  assertEquals(claimMetadataFor({ claim_kind: "general_theory", credibility_model: "d15 weights v1 paper p1" }),
    { claim_kind: "general_theory", credibility_model: "d15 weights v1 paper p1" });
  assertEquals(claimMetadataFor({ claim_kind: "practical" }), { claim_kind: "practical" });
});

Deno.test("the ingest path calls it before any claim is written (the caller reports the loss)", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const fn = src.slice(src.indexOf("async function writeGroundedClaims("), src.indexOf("async function writeGroundedClaims(") + 1500);
  const at = fn.indexOf("claimMetadataFor(pkg)");
  if (at < 0) throw new Error("writeGroundedClaims does not call claimMetadataFor");
  if (!(at < fn.indexOf("pool.connect()"))) throw new Error("the kind is checked only after a connection / transaction is opened");
  if (/pkg\.claim_kind\s*\?/.test(fn)) throw new Error("a conditional (fallback) claim_kind path is still there");
});
