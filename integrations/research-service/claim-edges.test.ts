/**
 * rw-p3a-entail attempt 4 (tester finding F2): the line-tag -> edge rule has ONE source. The research
 * curator's claim-edges.ts is it; this service carries a byte-identical copy (separate Docker build
 * contexts). This test fails when the two differ. It needs the checkout (the image build has no
 * ../research-curator in its context, so it is ignored there; run-credibility-e2e.ps1 checks it too).
 * Run: deno test --allow-read claim-edges.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimEdges, edgeWeightOk } from "./claim-edges.ts";

const MINE = new URL("./claim-edges.ts", import.meta.url);
const THEIRS = new URL("../research-curator/claim-edges.ts", import.meta.url);
const readable = (() => { try { Deno.statSync(THEIRS); return true; } catch { return false; } })();
const norm = (s: string) => s.replace(/\r\n/g, "\n");

Deno.test({
  name: "attempt 4: claim-edges.ts is byte-identical to the research curator's (one tag -> edge rule)",
  ignore: !readable,
  fn() {
    assertEquals(norm(Deno.readTextFileSync(MINE)), norm(Deno.readTextFileSync(THEIRS)));
  },
});

// attempt 6 (the structural round): the claim list - the parse, its drop rules and the meta-claim
// patterns - has ONE source too (research-curator/claim-list.ts); the research service scores the
// report from its byte-identical copy, so the scored claims are the filed claims by construction.
const LIST_MINE = new URL("./claim-list.ts", import.meta.url);
const LIST_THEIRS = new URL("../research-curator/claim-list.ts", import.meta.url);
const listReadable = (() => { try { Deno.statSync(LIST_THEIRS); return true; } catch { return false; } })();
Deno.test({
  name: "attempt 6: claim-list.ts is byte-identical to the research curator's (one claim-list derivation)",
  ignore: !listReadable,
  fn() {
    assertEquals(norm(Deno.readTextFileSync(LIST_MINE)), norm(Deno.readTextFileSync(LIST_THEIRS)));
  },
});

Deno.test("attempt 4: the rule the curator files with - every tag, the omnibus downgrade, GAP", () => {
  const e = (tag: string, nums: number[]) => {
    const r = claimEdges(tag, nums);
    return r ? { tag: r.tag, edges: r.edges.map((x) => [x.sourceIndex, x.edgeType, x.weight]) } : null;
  };
  assertEquals(e("SOURCED", [1, 2]), { tag: "sourced", edges: [[1, "states", 1], [2, "corroborates", 1]] });
  assertEquals(e("INFERRED", [3]), { tag: "inferred", edges: [[3, "inferred_from", 1]] });
  assertEquals(e("UNCERTAIN", [1]), { tag: "uncertain", edges: [[1, "inferred_from", 0.5]] });
  assertEquals(e("SOURCED", [1, 2, 3, 4, 5]), { tag: "uncertain", edges: [1, 2, 3, 4, 5].map((n) => [n, "inferred_from", 0.5]) });
  assertEquals(e("SOURCED", [1, 2, 3, 4])!.edges.length, 4);
  assertEquals(e("GAP", [1]), null);
});

Deno.test("attempt 4: an edge weight is 0 or in [1e-9, 1] as the REAL it is stored as", () => {
  for (const w of [0, 1, 0.5, 2e-9, -0]) assertEquals(edgeWeightOk(w), true, String(w));
  // 1e-9 as a float4 is 9.99999971718e-10 - under 1e-9, refused (the CHECK reads the stored REAL)
  for (const w of [NaN, Infinity, -Infinity, 5, -1, 1e-45, 1e-10, 1e-9, 1.0000001, "0.5", null]) {
    assertEquals(edgeWeightOk(w), false, String(w));
  }
});

// rw-p3a-figure-filed (F4): the header named functions that no longer exist (claims.ts
// parseSynthesisClaims as the filer, credibility.ts filedLineCredibility as the scorer). The claim
// list (claim-list.ts claimList) is what both services derive from now.
Deno.test("rw-p3a-figure-filed F4: claim-edges.ts names no retired function in its comment", () => {
  const text = Deno.readTextFileSync(new URL("./claim-edges.ts", import.meta.url));
  for (const stale of ["parseSynthesisClaims", "filedLineCredibility"]) {
    assertEquals(text.includes(stale), false, `claim-edges.ts still names ${stale}`);
  }
});
