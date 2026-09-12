/**
 * templates.ts — professional report templates for the final synthesis
 * (operator request 2026-08-22).
 *
 * The grounded tagged synthesis stays the machine-truth. What changed is the
 * HUMAN-FACING rendering: instead of one generic prose pass, the engine now
 * classifies the research into a report TYPE and renders the synthesis into
 * that template — clean and comprehensive enough to hand to other agents or
 * humans. Grounding is non-negotiable: every template shares the same
 * GROUNDING_RULES (preserve [Source N] citations verbatim, introduce no new
 * facts, honest gaps section).
 *
 * Adding a template = one entry in TEMPLATES (id + hints for the classifier +
 * the structure prompt). Nothing else to wire.
 */
import type { Deps } from "./harness.ts";

export interface ReportTemplate {
  id: string;
  name: string;
  /** Who the report reads for — surfaces in the classifier prompt. */
  audience: string;
  /** Selection hints the classifier matches the query/findings against. */
  hints: string;
  /** The report-structure half of the system prompt (sections + tone). */
  structure: string;
}

/** Shared grounding contract — identical for every template. */
export const GROUNDING_RULES =
  `GROUNDING RULES — ABSOLUTE, regardless of report style:
- PRESERVE every citation: keep each fact's [Source N] marker inline, using the SAME numbers. Never renumber, merge, or drop a citation.
- Introduce NO fact, number, name, URL, or quote that is not in the GROUNDED ANSWER. If it is not supported there, do not write it.
- This covers ACRONYMS, part numbers, standards and model names: if the grounded answer spells something out, write it out - do not abbreviate it into an acronym the answer never uses - and never name a standard, connector or component the answer does not name.
- It also covers QUANTITIES IN INSTRUCTIONS. A checklist step may say what to do and what it would show; it may not invent a duration, a count or a repetition ("wait 30 seconds", "repeat three times") unless a source gives that figure. Write the step without the number.
- NEVER STRENGTHEN A HEDGE. Whatever force the grounded answer gives a claim, your sentence gives it the same force and no more: "makes it difficult" may NOT become "is impossible" or "none is available"; "some"/"one reported"/"a user reported" may NOT become "all"/"always"/"every unit"; "may"/"can" may NOT become "does"/"will"; "reported" may NOT become "known". If the answer hedges, you hedge, in the same place, and you may use its own words to do it. Ranking, counting or ordering claims the answer does not make ("the three highest-risk items") is the same offence.
- NEVER NAME a standard, specification, product, model or organisation that the GROUNDED ANSWER does not name. If the answer says a connector is "proprietary", you may not say which standard it is not; if it describes a symptom, you may not name the part that causes it. The reader cannot tell your knowledge from the sources' - and this is measured on every run, so it is found either way.
- Drop the [SOURCED]/[INFERRED]/[UNCERTAIN] tags; convey that nuance in prose ("directly reports…", "the evidence suggests…", "weakly supported…").
- The [GAP] items are honest unknowns: render them in the report's open-questions section as questions, without citations, and NEVER fill them from your own knowledge.
- No preamble ("Here is the report…") — start with the report itself. Output is Markdown.

TITLE RULE — ABSOLUTE. The title states what the evidence SHOWS. It may never assert that something does not exist, is unsupported, or is absent from the literature ("Absence of Evidence for…", "No Evidence That…", "Lack of Research on…"). A report is written from what was retrieved, and what was retrieved is never proof of what exists: a run that found little found little, which is a fact about the run. If the evidence is too thin to state a finding, title the report by its SUBJECT and say so in the Answer block.

NEVER write a heading that claims to describe what the sources cover and then lists what they do not. If the sources do not address the question, that belongs in the Answer block, in one sentence, not under a heading that promises coverage.`;

/**
 * The limitations section, spelled the same way in every template.
 *
 * Before this, a report said what it did not know in TWO places: the template's
 * own "What was not found" section and a second "Open gaps (NOT grounded)"
 * block the renderer appended underneath it - the same lines twice, the second
 * copy labelled "not grounded" even for needs the report had answered in part.
 * A reader cannot tell which of two lists of unknowns is the real one, so there
 * is now exactly one, it is written by the template, and the renderer appends
 * nothing.
 *
 * The closing sentence is the operator's request: when something is still open
 * after the engine's own gap-closing pass, the report should ASK for the next
 * run rather than leaving the reader to work out that one is needed - in their
 * terms ("a run focused on X"), never in the engine's.
 */
export const LIMITATIONS_SECTION =
  `## Limitations and open questions
One section, once. List every [GAP] item as a plain question, with no citation, and say in one line what the evidence is thin on. Do not repeat a question that the report answered above.
- If anything is still open, END this section with ONE sentence recommending a further run aimed at it, in the reader's own terms: "A further run focused on <the open thing> would close this." Name the thing, not the machinery.
- If nothing is open, END with one sentence saying the question is answered by the evidence above, and write no recommendation.`;

/**
 * The SHARED SKELETON every report is built on (research-trust-template).
 *
 * The operator read the OptiPlex buyer's guide job 64ac38cf delivered and said
 * "this looks good... set this as a template for future use". What made it good
 * is not the subject: it is that the document answers, then tells the reader
 * what to DO, then lays the evidence out by area with a citation on every row,
 * then says what it could not settle, then stops - once. Every template now has
 * that shape, and each keeps its own audience, tone, hints and section NAMES,
 * because a checklist for a buyer and a findings table for a scientist are the
 * same section doing different work.
 *
 * None was deleted or merged: the operator's other instruction was that we
 * should have "about 4-5 now if not more", and there are ten.
 *
 * | template | action / findings section | table | area column |
 * |---|---|---|---|
 * | buyers-guide          | What to check in person       | Failure modes by subsystem   | Subsystem |
 * | scientific-paper      | Findings                      | Findings by theme            | Theme |
 * | technical-proposal    | Recommendation                | Technical factors by area    | Area |
 * | nontechnical-proposal | Recommendation                | Factors by area              | Area |
 * | programming-doc       | How to use it                 | Behaviour by area            | Area |
 * | engineering-doc       | Specifications and constraints| Specifications by subsystem  | Subsystem |
 * | product-comparison    | Comparison at a glance        | Options by criterion         | Criterion |
 * | market-analysis       | Key players and trends        | Market factors by area       | Area |
 * | value-proposition     | The value offered             | Benefits by area             | Area |
 * | general-report        | What the evidence supports    | Findings by area             | Area |
 *
 * A template is one entry in SHAPES. `buildStructure` puts the sections in
 * order, so a template cannot quietly lose one, and `templates.test.ts` walks
 * TEMPLATES asserting the order and the count.
 */
interface TemplateShape {
  id: string;
  name: string;
  audience: string;
  hints: string;
  /** One line of framing at the top of the prompt. */
  lead: string;
  /** What the title must state, in this template's terms. */
  title: string;
  /** What the executive summary must contain. */
  summary: string;
  /** The purpose-specific action/findings section. */
  action: { heading: string; body: string };
  /** The findings-by-area table. `columns[0]` is the area column. */
  table: { heading: string; columns: string[]; body: string };
  /** Register and any per-template prohibitions, last line of the prompt. */
  tone: string;
}

/** The section headings every report carries, in order. */
export const SKELETON_SECTIONS = [
  "Executive summary",
  "<action>",
  "<table>",
  "What the evidence does not settle",
  "Limitations and open questions",
];

function buildStructure(s: TemplateShape): string {
  return `${s.lead}
# <Title stating the FINDING - ${s.title} Never a topic label, never an assertion of absence.>
## Executive summary
${s.summary} A reader must be able to stop here.
## ${s.action.heading}
${s.action.body}
## ${s.table.heading}
${s.table.body}
| ${s.table.columns.join(" | ")} |
Every row carries its [Source N] in the Source column. An area with no evidence does not get a row - it goes in Limitations.
## What the evidence does not settle
Anything the sources disagree on, leave weakly supported, or answer only in part, in prose, cited.
${LIMITATIONS_SECTION}
Write EVERY section above, in this order, with these exact headings - including the table. A section the evidence barely reaches is written thin; it is never dropped, and the reader is never left to wonder whether it was omitted or had nothing in it. Add a sub-heading inside a section only when the evidence genuinely divides.
${s.tone}`;
}

const SHAPES: TemplateShape[] = [
  {
    id: "buyers-guide",
    name: "Buyer's guide",
    audience: "someone deciding whether to buy a specific thing, and what to check before they do",
    hints: "should-I-buy questions about a specific product or model, used-purchase questions, what-to-look-for, common faults and red flags, inspection before purchase, reliability of a particular machine",
    lead: "Render as a buyer's guide the reader could take with them to the inspection:",
    title: "what the evidence says about buying this thing.",
    summary: "3-5 sentences: what the evidence says about this purchase, the failure modes that matter most, and what the buyer should do about them.",
    action: {
      heading: "What to check in person",
      body: `A checklist of concrete, physical checks the buyer can perform, most decisive first, each one tied to the failure it detects and cited: "- [ ] <check> - <what it would show> [Source N]". Only checks the evidence supports; never invent a procedure.`,
    },
    table: {
      heading: "Failure modes by subsystem",
      columns: ["Subsystem", "What goes wrong", "What it looks like", "Source"],
      body: "A Markdown table, one row per subsystem the evidence covers (for example PSU, motherboard/capacitors, CPU socket, RAM, BIOS, thermal/fans - use the subsystems the evidence actually names):",
    },
    tone: "Practical, specific, no marketing. Prices and part numbers exactly as sourced.",
  },
  {
    id: "scientific-paper",
    name: "Scientific paper",
    audience: "researchers and technically fluent readers",
    hints: "scientific questions, studies, experiments, biology/physics/chemistry/medicine, 'what does the research say', literature-review style questions",
    lead: "Render as a short scientific-paper-style report:",
    title: "what the evidence shows about the question asked.",
    summary: "3-5 sentences: the question, what the evidence shows, and the headline conclusion with its confidence.",
    action: {
      heading: "Findings",
      body: "The substantive results, grouped thematically, most load-bearing first; every finding cited. State effect sizes, populations and methods exactly as sourced, and say plainly where support is weak.",
    },
    table: {
      heading: "Findings by theme",
      columns: ["Theme", "What the evidence shows", "Strength of support", "Source"],
      body: "A Markdown table, one row per theme the evidence covers:",
    },
    tone: "Formal, precise tone; no marketing language; numbers stated exactly as sourced.",
  },
  {
    id: "technical-proposal",
    name: "Technical proposal",
    audience: "engineers and technical decision-makers",
    hints: "should-we-build/adopt questions with technical depth, architecture or tooling choices, migration/implementation feasibility",
    lead: "Render as a technical proposal:",
    title: "what the evidence supports doing, and why.",
    summary: "3-4 sentences: the recommendation, the evidence behind it, and the main risk.",
    action: {
      heading: "Recommendation",
      body: "The approach the evidence best supports, with the technical specifics a competent engineer could act on - interfaces, constraints, performance numbers, compatibility - each cited. Name the alternatives the sources surfaced and why they rank lower.",
    },
    table: {
      heading: "Technical factors by area",
      columns: ["Area", "What the evidence shows", "What it means for the build", "Source"],
      body: "A Markdown table, one row per area the evidence covers (performance, compatibility, operational cost, migration, support):",
    },
    tone: "Precise, implementation-ready tone; a competent engineer should be able to act on it.",
  },
  {
    id: "nontechnical-proposal",
    name: "Non-technical proposal",
    audience: "mixed technical and non-technical stakeholders",
    hints: "should-we questions framed around business value, budget, adoption, plain-language decisions",
    lead: "Render as a proposal for a mixed audience:",
    title: "what the evidence supports doing, in plain terms.",
    summary: "3-4 sentences in plain language: the recommendation, what it takes, and the main risk.",
    action: {
      heading: "Recommendation",
      body: "What to do and what it takes, in plain terms - effort, dependencies, prerequisites, and the evidenced risks - each cited. Technical terms explained in parentheses the first time.",
    },
    table: {
      heading: "Factors by area",
      columns: ["Area", "What the evidence shows", "What it means in practice", "Source"],
      body: "A Markdown table, one row per area the evidence covers (cost, effort, risk, adoption, timing):",
    },
    tone: "Readable by a non-technical stakeholder, yet specific enough that a technical reader can act on it.",
  },
  {
    id: "programming-doc",
    name: "Programming technical document",
    audience: "software developers",
    hints: "programming languages, frameworks, libraries, APIs, SDKs, code tooling, software how-it-works questions",
    lead: "Render as a developer-facing technical document:",
    title: "what it does and how it behaves.",
    summary: "3-4 sentences: what it is, what problem it solves, and the one thing a developer most needs to know.",
    action: {
      heading: "How to use it",
      body: "How to adopt or use it as evidenced: setup, the key interfaces or APIs, configuration, and the pitfalls that bite first. Inline-code formatting for identifiers. Never invent an API name or a version.",
    },
    table: {
      heading: "Behaviour by area",
      columns: ["Area", "How it behaves", "Pitfall or caveat", "Source"],
      body: "A Markdown table, one row per area the evidence covers (installation, configuration, API surface, performance, versions, ecosystem):",
    },
    tone: "Concise, exact, code-literate tone.",
  },
  {
    id: "engineering-doc",
    name: "Engineering technical document",
    audience: "engineers (physical or systems)",
    hints: "physical engineering, mechanical/electrical/civil, hardware, materials, manufacturing, systems engineering, specifications and standards",
    lead: "Render as an engineering technical document:",
    title: "what the system is and what it is bounded by.",
    summary: "3-4 sentences: the system or component, its purpose, and the constraint that matters most.",
    action: {
      heading: "Specifications and constraints",
      body: "The hard numbers as sourced - dimensions, tolerances, ratings, capacities, standards - with the trade-offs they force. Units always stated; no rounded or invented figures.",
    },
    table: {
      heading: "Specifications by subsystem",
      columns: ["Subsystem", "Specification", "Constraint or tolerance", "Source"],
      body: "A Markdown table, one row per subsystem the evidence covers:",
    },
    tone: "Precise engineering register; units always stated.",
  },
  {
    id: "product-comparison",
    name: "Product comparison",
    audience: "buyers and evaluators",
    hints: "X vs Y, best-tool-for, alternatives-to, feature and pricing comparisons across products or services",
    lead: "Render as a product comparison:",
    title: "which option the evidence favours, and for whom.",
    summary: "3-4 sentences: which option leads, for which reader, and what would change the answer.",
    action: {
      heading: "Comparison at a glance",
      body: "Two to four sentences per option: its strengths, its weaknesses and its pricing or terms as evidenced, each cited. Never pad an option with an uncited spec.",
    },
    table: {
      heading: "Options by criterion",
      columns: ["Criterion", "<Option A>", "<Option B>", "Source"],
      body: "A Markdown table that IS the comparison grid: one row per decisive criterion, one column per option, using the options' real names in the header. Cite inside a cell where a number or claim needs it, and put the row's citations in the Source column:",
    },
    tone: "Even-handed; differences stated concretely.",
  },
  {
    id: "market-analysis",
    name: "Market analysis",
    audience: "strategy and business readers",
    hints: "market size/landscape, competitors, industry trends, growth, segments, investment context",
    lead: "Render as a market analysis:",
    title: "what the evidence says the market is doing.",
    summary: "3-4 sentences: the state of the market, the direction of travel, and the strongest counter-force.",
    action: {
      heading: "Key players and trends",
      body: "Who matters and what is changing, each cited, with the drivers behind it. Attribute every forecast to the source that made it; never state a projection as fact.",
    },
    table: {
      heading: "Market factors by area",
      columns: ["Area", "What the evidence shows", "Direction of travel", "Source"],
      body: "A Markdown table, one row per area the evidence covers (size, segments, players, pricing, regulation, headwinds):",
    },
    tone: "Analytical tone; every figure cited; forecasts clearly attributed.",
  },
  {
    id: "value-proposition",
    name: "Value proposition",
    audience: "product and business stakeholders",
    hints: "why-would-anyone-buy/use questions, positioning, differentiation, benefit articulation",
    lead: "Render as a value-proposition document:",
    title: "what value the evidence actually supports claiming.",
    summary: "3-4 sentences: the core value, who it serves, and where the evidence is thin.",
    action: {
      heading: "The value offered",
      body: "The concrete benefits, each evidenced and tied to the pain it addresses, with the differentiators the sources support. Be honest where the evidence is thin - this is grounded analysis, not marketing copy.",
    },
    table: {
      heading: "Benefits by area",
      columns: ["Area", "Benefit", "Strength of evidence", "Source"],
      body: "A Markdown table, one row per area the evidence covers:",
    },
    tone: "Clear and persuasive but never beyond the evidence.",
  },
  {
    id: "general-report",
    name: "General research report",
    audience: "any reader",
    hints: "DEFAULT - anything that does not clearly fit another template",
    lead: "Render as a short, answer-first research report. Target 900 words or fewer; never pad.",
    title: "what the evidence establishes about the question asked.",
    summary: "2-4 sentences answering the question directly. If the evidence does not settle it, say what it DOES establish and what remains open, in those same sentences.",
    action: {
      heading: "What the evidence supports",
      body: "One cited bullet per claim, at most 12, most decisive first. No bullet without its [Source N]. Group them under bold sub-labels when the findings fall into obvious groups.",
    },
    table: {
      heading: "Findings by area",
      columns: ["Area", "What the evidence shows", "Why it matters", "Source"],
      body: "A Markdown table, one row per area the evidence covers:",
    },
    tone: `Nothing else. No "Overview", no "Background", no "Conclusion" restating the summary.`,
  },
];

export const TEMPLATES: ReportTemplate[] = SHAPES.map((s) => ({
  id: s.id,
  name: s.name,
  audience: s.audience,
  hints: s.hints,
  structure: buildStructure(s),
}));

/** The per-template section names, for tests and for the docblock table. */
export const SECTION_NAMES: Record<string, { action: string; table: string; area: string }> =
  Object.fromEntries(SHAPES.map((s) => [s.id, {
    action: s.action.heading,
    table: s.table.heading,
    area: s.table.columns[0],
  }]));

export const DEFAULT_TEMPLATE_ID = "general-report";

/**
 * The reader's PURPOSE, which is what decides the shape of a report - the same
 * facts about a machine belong in a checklist for a buyer and in a spec sheet
 * for someone building with it.
 *
 * The classifier states the purpose and then picks a template FOR that purpose,
 * in one call, and the purpose is recorded on the run. It is deliberately NOT
 * derived from cue words in the question: four items in this workstream have
 * now failed on a hand-written list of surface strings, and a list of buying
 * words would be the fifth. The model reads the question; the mapping below is
 * only the fallback for when it returns a template id that does not exist.
 */
export type ReportPurpose = "buy" | "build" | "learn" | "compare" | "decide";
export const PURPOSES: ReportPurpose[] = ["buy", "build", "learn", "compare", "decide"];

/** Which template serves a purpose when the classifier names no usable one. */
const PURPOSE_FALLBACK: Record<ReportPurpose, string> = {
  buy: "buyers-guide",
  build: "programming-doc",
  learn: "general-report",
  compare: "product-comparison",
  decide: "nontechnical-proposal",
};

const CLASSIFY_SYS =
  `You choose the best REPORT TEMPLATE for a completed research run. You are given the research QUESTION and a sample of the FINDINGS.

Work in two steps.
1. PURPOSE - why would the person who asked this want it? One of: buy (they are deciding whether to acquire or which to acquire, and what to check first), build (they will implement, integrate or operate something), learn (they want to understand a subject), compare (they are weighing named options against each other), decide (they are choosing a course of action that is not itself a purchase).
2. TEMPLATE - the single template whose shape serves THAT purpose for THIS evidence.

Return ONLY JSON: {"purpose": "<purpose>", "template": "<id>"} - the id must be one from the TEMPLATES list. Choose "${DEFAULT_TEMPLATE_ID}" only when no other template fits the purpose.`;

export function templateById(id: string | null | undefined): ReportTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID)!;
}

export interface TemplateChoice {
  template: ReportTemplate;
  /** What the classifier said the reader wants, or "" when it did not say. */
  purpose: ReportPurpose | "";
}

/** Classify the run into a template. Fails CLOSED to the general report — a
 *  model blip must never block the render. */
export async function classifyTemplate(deps: Deps, query: string, synthesis: string): Promise<ReportTemplate> {
  return (await classifyReport(deps, query, synthesis)).template;
}

/** The same call, keeping the PURPOSE the classifier decided. */
export async function classifyReport(
  deps: Deps, query: string, synthesis: string,
): Promise<TemplateChoice> {
  const list = TEMPLATES.map((t) => `- ${t.id}: ${t.name} — for ${t.audience}. Fits: ${t.hints}`).join("\n");
  try {
    const raw = await deps.chat(
      CLASSIFY_SYS,
      `TEMPLATES:\n${list}\n\nQUESTION: ${query}\n\nFINDINGS (sample):\n${synthesis.slice(0, 2400)}`,
      { json: true, nothink: true },
    );
    const parsed = JSON.parse(raw) as { template?: string; purpose?: string };
    const purpose = (PURPOSES as string[]).includes(String(parsed.purpose))
      ? parsed.purpose as ReportPurpose
      : "";
    const named = TEMPLATES.find((t) => t.id === parsed.template);
    // A purpose with no usable template id still decides the shape: falling to
    // the general report when the model named "buyers guide" instead of
    // "buyers-guide" would throw away the half of the answer it got right.
    if (!named && purpose) return { template: templateById(PURPOSE_FALLBACK[purpose]), purpose };
    return { template: templateById(parsed.template), purpose };
  } catch {
    return { template: templateById(DEFAULT_TEMPLATE_ID), purpose: "" };
  }
}

/** Full system prompt for rendering the grounded answer in a template. */
export function renderSys(t: ReportTemplate): string {
  return `You are Open Brain's research writer. You are given a QUESTION and a GROUNDED ANSWER — verified assertions tagged [SOURCED]/[INFERRED]/[UNCERTAIN], each ending with its citation [Source N], plus [GAP] lines for points no source covered.

Write the "${t.name}" report (audience: ${t.audience}).

${t.structure}

${GROUNDING_RULES}`;
}
