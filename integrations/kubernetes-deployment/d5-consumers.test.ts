/** D5 stage 1 in openbrain-mcp's SQL consumers that have no database test here (rw-p0-contract
 * attempt 2, tester finding F3): the suggestion / hidden triage listing must filter suppressed
 * sources like every other consumer (the workbench's own triage list, notebooks.ts
 * listSuggestions, already does).
 *
 * Run: deno test --allow-read d5-consumers.test.ts
 *
 * A static read of index.ts: the body of registerSuggestionList, its one query over sources.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function body(fn: string): string {
  const start = src.indexOf(`function ${fn}(`);
  assert(start >= 0, `${fn} not found in index.ts`);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

Deno.test("the suggestion / hidden triage listing omits suppressed sources (D5 stage 1)", () => {
  const b = body("registerSuggestionList");
  assert(/JOIN sources s ON s\.id = ts\.source_id/.test(b), "the listing no longer joins sources as s - re-read this test");
  const sql = b.slice(b.indexOf("SELECT"), b.indexOf("ORDER BY"));
  assert(/s\.retraction_committed_at IS NULL/.test(sql), "registerSuggestionList lists suppressed sources (no s.retraction_committed_at IS NULL)");
});
