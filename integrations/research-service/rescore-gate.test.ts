/**
 * The re-score gate's findings-sink half (research-workbench P3a acceptance: "the trigger is
 * re-scored only after the operator's confirmation is recorded in the findings sink (D15); a
 * re-score without that record FAILS"). The database half (OBC03) is in credibility.e2e.test.ts.
 * Run: deno test --allow-read rescore-gate.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { confirmationFor, confirmations } from "./rescore-gate.ts";

const D = "0123456789abcdef0123456789abcdef";
const M = "d15 weights v1 paper p1";
const line = `D15-RESCORE-CONFIRMED digest=${D} model="${M}" by=operator date=2026-10-20`;

Deno.test("no confirmation line in the findings sink: refused", () => {
  const r = confirmationFor("# Findings\n\nThe before/after view is in journal/evidence.\n", D, M);
  assert(!r.ok);
  assert(/has not confirmed/.test(r.reason));
});

Deno.test("a confirmation of ANOTHER view (stale digest) or another model version: refused", () => {
  const stale = confirmationFor(line.replace(D, "f".repeat(32)), D, M);
  assert(!stale.ok && /re-read the view/.test(stale.reason));
  const other = confirmationFor(line, D, "d15 weights v2 paper p1");
  assert(!other.ok && /the database is at/.test(other.reason));
});

Deno.test("the exact confirmation is found, verbatim, in a list item or code span", () => {
  for (const text of [line, `- ${line}`, `\`${line}\``]) {
    const r = confirmationFor(`# Findings\n\n${text}\n`, D, M);
    assert(r.ok, text);
    if (r.ok) { assertEquals(r.c.by, "operator"); assertEquals(r.c.line, line); }
  }
  assertEquals(confirmations(`${line}\n${line.replace("operator", "op2")}`).length, 2);
});

Deno.test("a near-miss line is not a confirmation (no fuzzy match)", () => {
  assertEquals(confirmations(`D15 rescore confirmed digest=${D}`).length, 0);
  assertEquals(confirmations(line.replace("date=2026-10-20", "")).length, 0);
});
