/**
 * rw-p3a-entail attempt 6 (the structural round): writeClaims files EXACTLY claimList(synthesis).claims -
 * the list the research service scores its report from (its byte-identical claim-list.ts) - in order,
 * with the same text, tag and edges, and every drop rule lives in claimList, not in the writer.
 * Run: deno test --allow-read claim-list.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimList, LINK_EDGE_SQL, writeClaims } from "./claims.ts";

// every drop rule claimList knows, plus the shapes that split a line (two tags, a continuation line)
const SYNTH = [
  "[SOURCED] Doctors say the widget is common among travellers. [Source 1]",
  "[SOURCED] Doctors say the widget is common among travellers. [Source 2, 3]",
  "[INFERRED] Clinicians report the widget in commuters. [Source 2]",
  "[SOURCED] CLINICIANS REPORT THE WIDGET IN COMMUTERS. [Source 1]",
  "[SOURCED] [Source 2]",
  "[SOURCED] -- [Source 1]",
  "[SOURCED] The provided sources contain no information about the widget in children. [Source 1]",
  "[INFERRED] No study has tested the widget in astronauts. [Source 3]",
  "[SOURCED] The widget has no citation here.",
  "[GAP] Nothing on the long-term course of the widget.",
  "[SOURCED] The widget is in the news. [Source 1, 2, 3, 4, 5]",
  "[SOURCED] The widget worsens at sea. [Source 1] [INFERRED] The widget eases on land. [Source 2]",
  "[Sourced] The widget follows screen motion.",
  "as the study shows [Source 3]",
].join("\n");

Deno.test("attempt 6: claimList names every drop rule, in synthesis order", () => {
  const l = claimList(SYNTH);
  assertEquals(l.claims.map((c) => c.text), [
    "Doctors say the widget is common among travellers.",
    "Clinicians report the widget in commuters.",
    "The widget is in the news.",
    "The widget worsens at sea.",
    "The widget eases on land.",
    "The widget follows screen motion. as the study shows",
  ]);
  assertEquals(l.claims.map((c) => c.tag), ["sourced", "inferred", "uncertain", "sourced", "inferred", "sourced"]);
  assertEquals(l.dropped.map((d) => d.reason), [
    "duplicate_text", "duplicate_text", "empty_text", "empty_text", "meta_pattern", "meta_pattern", "no_edges",
  ]);
  assertEquals(l.metaSkipped.length, 2);
  assertEquals(l.gaps, ["Nothing on the long-term course of the widget."]);
  // every claim's offset is the offset of its own tag marker
  for (const c of l.claims) assertEquals(/^\[(SOURCED|INFERRED|UNCERTAIN)\]/i.test(SYNTH.slice(c.start)), true, c.text);
});

Deno.test("attempt 6: writeClaims files exactly claimList(synthesis).claims - same order, text, tag and edges; the pattern-refused meta-claims are reported, never filed", async () => {
  const filed: Array<{ text: string; tag: string; edges: string[] }> = [];
  const client = {
    queryObject<T>(sql: string, args: unknown[] = []): Promise<{ rows: T[] }> {
      if (sql.includes("find_or_create_claim")) {
        filed.push({ text: String(args[0]), tag: String(args[3]), edges: [] });
        return Promise.resolve({ rows: [{ id: `c${filed.length}`, was_duplicate: false } as unknown as T] });
      }
      if (sql === LINK_EDGE_SQL) {
        filed[filed.length - 1].edges.push(`${args[1]}|${args[2]}|${args[3]}`);
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  const meta: string[] = [];
  const res = await writeClaims(client, SYNTH, {
    threadId: null, synthesisId: null, sourceIds: ["s1", "s2", "s3", "s4", "s5"],
    onMetaSkip: (t) => meta.push(t),
  });
  const want = claimList(SYNTH).claims.map((c) => ({
    text: c.text, tag: c.tag, edges: c.edges.map((e) => `s${e.sourceIndex}|${e.edgeType}|${e.weight}`),
  }));
  assertEquals(filed, want);
  assertEquals(res.claimIds.length, want.length);
  assertEquals(res.metaSkipped, 2);
  assertEquals(meta, claimList(SYNTH).metaSkipped.map((c) => c.text));
});
