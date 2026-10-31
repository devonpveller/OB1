// deno test src/contracts/trust_test.ts - the pure half of the trust reads (research-workbench P3b): the
// roll-up statement always names the claim kind and the weights (never a bare number), the export's
// section sits at the head of the report, needs are counted (never a percent), and the new contract
// operations are in the document with their schemas.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { countByStatus, needsOf, ROLLUP_HEADING, rollupMarkdown, shapeRollup, withRollupSection } from "./repo/trust.ts";
import { buildDocument } from "./gen.ts";
import { Claim } from "./schemas/knowledge.ts";
import { EX } from "./schemas/examples.ts";

const REC = {
  value: 0.6234, claims: 4, below_floor: 1, judged_lines: 5, judged_not_filed: 1, kind: "general_theory",
  model_version: "d15 weights v1 paper p1", weights: { general: 0.4, scholarly: 1 }, filed: true, basis: "filing",
};

Deno.test("the roll-up names its claim kind and weights - never a bare number", () => {
  const r = shapeRollup(REC, "r", "j");
  assertEquals(r.weights, [{ family: "scholarly", weight: 1 }, { family: "general", weight: 0.4 }]);
  assertStringIncludes(r.statement, "Report credibility 0.62");
  assertStringIncludes(r.statement, "claim kind general_theory");
  assertStringIncludes(r.statement, "weights scholarly 1.00, general 0.40");
  assertStringIncludes(r.statement, "1 below the claim floor");
  for (const s of [shapeRollup(null, null, null), shapeRollup({ ...REC, value: null }, "r", "j"), shapeRollup({ ...REC, value: null, not_filed: "dry_run" }, "r", "j")]) {
    assert(!/^\s*[\d.]+\s*$/.test(s.statement), `a bare number: ${s.statement}`);
    assert(/Report credibility/.test(s.statement));
  }
  assertEquals(shapeRollup(null, null, null).recorded, false);
  assertStringIncludes(shapeRollup({ ...REC, value: null, not_filed: "dry_run" }, "r", "j").statement, "not filed");
});

Deno.test("a malformed record is read defensively: no free-text kind, no non-number weight", () => {
  const r = shapeRollup({ ...REC, kind: "<script>", weights: { general: "x", "bad key": 1, scholarly: 0.9 } }, null, null);
  assertEquals(r.claim_kind, null);
  assertEquals(r.weights, [{ family: "scholarly", weight: 0.9 }]);
});

Deno.test("the export section sits at the head: after the frontmatter and the title, before the body", () => {
  const md = "---\ntitle: R\n---\n\n# The report\n\nBody text.\n";
  const out = withRollupSection(md, rollupMarkdown(shapeRollup(REC, "r", "j")));
  assert(out.startsWith("---\ntitle: R\n---\n"));
  const h = out.indexOf(`## ${ROLLUP_HEADING}`);
  assert(h > out.indexOf("# The report") && h < out.indexOf("Body text."), out);
  assertStringIncludes(out, "| scholarly | 1.00 |");
  assertStringIncludes(out, "| general | 0.40 |");
  const bare = withRollupSection("Just a body.\n", "## X\n");
  assert(bare.startsWith("## X\n"), bare);
});

Deno.test("needs are counted by status, every status present; nothing is a percent", () => {
  const needs = needsOf([{ need: "a", status: "answered" }, { need: "b", status: "partial" }, { need: "c", status: "answered" }, { bad: 1 }, "x"]);
  assertEquals(needs.length, 3);
  assertEquals(countByStatus(needs), { answered: 2, partial: 1, open: 0, search_failed: 0 });
  assertEquals(countByStatus([]), { answered: 0, partial: 0, open: 0, search_failed: 0 });
});

Deno.test("the trust operations are in the contract document; claims carry the ledger's columns", () => {
  const doc = buildDocument() as { paths: Record<string, Record<string, { operationId: string; "x-mcp-tool"?: string }>> };
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
  for (const id of ["reportCredibility", "coverage", "documentCoverage"]) {
    const o = ops.find((x) => x.operationId === id);
    assert(o, `${id} is in the document`);
    assertEquals(o["x-mcp-tool"], undefined, `${id} is not an MCP tool (a user's own view / D14)`);
  }
  for (const k of ["verdict", "corroborations", "contradicted_by_newer"]) assert(k in Claim.shape, `Claim.${k}`);
  assert(Claim.safeParse(EX.claims.claims[0]).success);
  const { verdict: _v, ...without } = EX.claims.claims[0] as Record<string, unknown>;
  assertEquals(Claim.safeParse(without).success, false, "a claim without its verdict column does not validate");
});
