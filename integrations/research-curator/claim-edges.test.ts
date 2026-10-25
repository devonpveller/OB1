/**
 * rw-p3a-entail attempt 4 (tester finding F2): claim-edges.ts here is the ONE source of the line-tag ->
 * edge rule; the research service scores lines with a byte-identical copy. This fails when they differ
 * (the research service's claim-edges.test.ts is the mirror check). And parseSynthesisClaims files
 * exactly what claimEdges says, for every tag and the omnibus line.
 * Run: deno test --allow-read claim-edges.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimEdges } from "./claim-edges.ts";
import { parseSynthesisClaims } from "./claims.ts";

const MINE = new URL("./claim-edges.ts", import.meta.url);
const THEIRS = new URL("../research-service/claim-edges.ts", import.meta.url);
const readable = (() => { try { Deno.statSync(THEIRS); return true; } catch { return false; } })();
const norm = (s: string) => s.replace(/\r\n/g, "\n");

Deno.test({
  name: "attempt 4: claim-edges.ts is byte-identical to the research service's copy",
  ignore: !readable,
  fn() {
    assertEquals(norm(Deno.readTextFileSync(MINE)), norm(Deno.readTextFileSync(THEIRS)));
  },
});

// attempt 6 (the structural round): the claim list - the parse, its drop rules and the meta-claim
// patterns - has ONE source too (research-curator/claim-list.ts); the research service scores the
// report from its byte-identical copy, so the scored claims are the filed claims by construction.
const LIST_MINE = new URL("./claim-list.ts", import.meta.url);
const LIST_THEIRS = new URL("../research-service/claim-list.ts", import.meta.url);
const listReadable = (() => { try { Deno.statSync(LIST_THEIRS); return true; } catch { return false; } })();
Deno.test({
  name: "attempt 6: claim-list.ts is byte-identical to the research service's (one claim-list derivation)",
  ignore: !listReadable,
  fn() {
    assertEquals(norm(Deno.readTextFileSync(LIST_MINE)), norm(Deno.readTextFileSync(LIST_THEIRS)));
  },
});

Deno.test("attempt 4: parseSynthesisClaims files each line with claimEdges' tag and edges", () => {
  const lines: Array<[string, number[]]> = [
    ["SOURCED", [1]], ["SOURCED", [1, 2, 3]], ["INFERRED", [2]], ["UNCERTAIN", [1, 3]], ["SOURCED", [1, 2, 3, 4, 5]], ["INFERRED", [1, 2, 3, 4, 5, 6]],
  ];
  const synthesis = lines.map(([tag, nums], i) => `[${tag}] The widget W${i} ships in size ${i + 3}. [Source ${nums.join(", ")}]`).join("\n");
  const parsed = parseSynthesisClaims(synthesis).claims;
  assertEquals(parsed.length, lines.length);
  parsed.forEach((c, i) => {
    const want = claimEdges(lines[i][0], lines[i][1])!;
    assertEquals({ tag: c.tag, edges: c.edges }, { tag: want.tag, edges: want.edges }, `line ${i}`);
  });
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
