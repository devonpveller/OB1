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
