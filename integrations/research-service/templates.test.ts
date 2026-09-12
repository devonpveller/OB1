/** templates.test.ts — report-template registry + classifier behavior. */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TEMPLATES, DEFAULT_TEMPLATE_ID, templateById, classifyTemplate, renderSys, GROUNDING_RULES,
  SECTION_NAMES, SKELETON_SECTIONS,
} from "./templates.ts";
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

// ── research-trust 2026-09-11 ───────────────────────────────────────────────
// The audited run (job 8c9b4f1d) was rendered through scientific-paper and
// titled "Absence of Evidence for 100 Hz Auditory Tones…" over a pool the
// engine never retrieved. These pin the CONTRACT the prompts must carry; a
// model can still disobey a prompt, which is why report.ts renders the
// zero-finding case itself rather than asking a model to.
Deno.test("every template forbids a title that asserts absence", () => {
  for (const t of TEMPLATES) {
    const sys = renderSys(t);
    assertEquals(sys.includes("TITLE RULE"), true, `${t.id} lost the title rule`);
    assertEquals(/may never assert that something does not exist/.test(sys), true, t.id);
  }
});

// REWRITTEN, research-trust-template. The case pinned `**Answer.**` in two
// templates. The shared skeleton replaces that bold lead-in with a named
// section - `## Executive summary` - and gives it to ALL TEN rather than two,
// which is what the operator approved in the 64ac38cf buyer's guide. The
// property the case protects, "answer first, before background", is unchanged
// and is now asserted everywhere instead of in two places.
Deno.test("every template answers FIRST, in a named executive summary", () => {
  for (const t of TEMPLATES) {
    const sys = renderSys(t);
    assertEquals(sys.includes("## Executive summary"), true, `${t.id} has no executive summary`);
    // …and it comes before the template's own action/findings section.
    const iSummary = sys.indexOf("## Executive summary");
    const iAction = sys.indexOf(`## ${SECTION_NAMES[t.id].action}`);
    assert(iSummary < iAction, `${t.id}: the summary does not come first`);
    assert(/A reader must be able to stop here/.test(sys), t.id);
  }
});

Deno.test("no template asks for a heading that promises coverage it may not have", () => {
  for (const t of TEMPLATES) {
    assertEquals(/what the sources actually cover/i.test(t.structure), false, t.id);
  }
});

// ── The shared skeleton (research-trust-template) ──────────────────────────

Deno.test("ACCEPTANCE 1: every template carries the skeleton sections IN ORDER", () => {
  // The operator approved the 64ac38cf buyer's guide and asked for it as the
  // house shape. A template that quietly loses a section is the thing this
  // walks TEMPLATES to catch.
  assertEquals(TEMPLATES.length, 10, "a template was added or deleted");
  for (const t of TEMPLATES) {
    const names = SECTION_NAMES[t.id];
    assert(names, `${t.id} has no recorded section names`);
    const want = SKELETON_SECTIONS.map((s) =>
      s === "<action>" ? names.action : s === "<table>" ? names.table : s);
    let at = -1;
    for (const section of want) {
      const i = t.structure.indexOf(`## ${section}`);
      assert(i > at, `${t.id}: "${section}" is missing or out of order`);
      at = i;
    }
    // The title line comes before every section, and states a FINDING.
    const title = t.structure.indexOf("# <Title stating the FINDING");
    assert(title >= 0 && title < t.structure.indexOf("## Executive summary"), t.id);
    // The table is a table, its first column is the area column, and every row
    // has to cite.
    assert(t.structure.includes(`| ${names.area} |`), `${t.id}: no ${names.area} column`);
    assert(t.structure.includes("| Source |"), `${t.id}: the table has no Source column`);
    assert(t.structure.includes("Every row carries its [Source N]"), t.id);
  }
});

Deno.test("ACCEPTANCE 1: the ten templates are all still here, and distinct", () => {
  // "we should have about 4-5 now if not more" - and none was merged away when
  // they were put on one skeleton.
  const ids = TEMPLATES.map((t) => t.id).sort();
  assertEquals(ids, [
    "buyers-guide", "engineering-doc", "general-report", "market-analysis",
    "nontechnical-proposal", "product-comparison", "programming-doc",
    "scientific-paper", "technical-proposal", "value-proposition",
  ]);
  // Distinct where it matters: no two share an action heading AND a table.
  const shapes = TEMPLATES.map((t) => `${SECTION_NAMES[t.id].action}|${SECTION_NAMES[t.id].table}`);
  assertEquals(new Set(shapes).size, shapes.length, "two templates render the same shape");
  // Each keeps its own audience and hints.
  assertEquals(new Set(TEMPLATES.map((t) => t.audience)).size, TEMPLATES.length);
  assertEquals(new Set(TEMPLATES.map((t) => t.hints)).size, TEMPLATES.length);
});

Deno.test("ACCEPTANCE 1: the buyer's guide keeps the approved section names exactly", () => {
  // It is the exemplar; its headings are the ones in the approved document.
  assertEquals(SECTION_NAMES["buyers-guide"], {
    action: "What to check in person",
    table: "Failure modes by subsystem",
    area: "Subsystem",
  });
  const sys = renderSys(templateById("buyers-guide"));
  assert(sys.includes("| Subsystem | What goes wrong | What it looks like | Source |"), sys);
});

Deno.test("ACCEPTANCE 1: the classifier can only land on a template that exists", async () => {
  const ids = new Set(TEMPLATES.map((t) => t.id));
  const replies = [
    '{"purpose":"buy","template":"buyers-guide"}',
    '{"purpose":"compare","template":"nonesuch"}',
    '{"purpose":"vibes","template":"nonesuch"}',
    '{"template":"../../etc/passwd"}',
    "not json at all",
    "",
  ];
  for (const reply of replies) {
    const deps = { chat: () => Promise.resolve(reply) } as unknown as Deps;
    const t = await classifyTemplate(deps, "q", "s");
    assert(ids.has(t.id), `classifier returned ${t.id} for ${reply}`);
  }
});
