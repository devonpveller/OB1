/** templates.test.ts — report-template registry + classifier behavior. */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TEMPLATES, DEFAULT_TEMPLATE_ID, templateById, classifyTemplate, renderSys, GROUNDING_RULES } from "./templates.ts";
import type { Deps } from "./harness.ts";

function fakeDeps(chatImpl: (sys: string, user: string) => Promise<string>): Deps {
  return { chat: chatImpl } as unknown as Deps;
}

Deno.test("registry: ids unique, default present, every template complete", () => {
  const ids = TEMPLATES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length, "duplicate template id");
  assert(ids.includes(DEFAULT_TEMPLATE_ID), "default template missing");
  for (const t of TEMPLATES) {
    assert(t.name && t.audience && t.hints && t.structure, `incomplete template: ${t.id}`);
  }
});

Deno.test("renderSys: every template carries the grounding contract", () => {
  for (const t of TEMPLATES) {
    const sys = renderSys(t);
    assert(sys.includes(GROUNDING_RULES), `grounding rules missing in ${t.id}`);
    assert(sys.includes("[Source N]"), `citation-preservation rule missing in ${t.id}`);
    assert(sys.includes(t.structure), `structure missing in ${t.id}`);
  }
});

Deno.test("templateById: unknown/null ids resolve to the default", () => {
  assertEquals(templateById("no-such-template").id, DEFAULT_TEMPLATE_ID);
  assertEquals(templateById(null).id, DEFAULT_TEMPLATE_ID);
  assertEquals(templateById("scientific-paper").id, "scientific-paper");
});

Deno.test("classifyTemplate: valid pick honored", async () => {
  const deps = fakeDeps(() => Promise.resolve('{"template": "product-comparison"}'));
  const t = await classifyTemplate(deps, "best SaaS api tools compared", "[SOURCED] A. [Source 1]");
  assertEquals(t.id, "product-comparison");
});

Deno.test("classifyTemplate: garbage / unknown / chat failure all fall back to default", async () => {
  const garbage = await classifyTemplate(fakeDeps(() => Promise.resolve("not json")), "q", "s");
  assertEquals(garbage.id, DEFAULT_TEMPLATE_ID);
  const unknown = await classifyTemplate(fakeDeps(() => Promise.resolve('{"template": "haiku"}')), "q", "s");
  assertEquals(unknown.id, DEFAULT_TEMPLATE_ID);
  const thrown = await classifyTemplate(fakeDeps(() => Promise.reject(new Error("down"))), "q", "s");
  assertEquals(thrown.id, DEFAULT_TEMPLATE_ID);
});
