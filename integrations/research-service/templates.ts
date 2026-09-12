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

export const TEMPLATES: ReportTemplate[] = [
  {
    id: "buyers-guide",
    name: "Buyer's guide",
    audience: "someone deciding whether to buy a specific thing, and what to check before they do",
    hints: "should-I-buy questions about a specific product or model, used-purchase questions, what-to-look-for, common faults and red flags, inspection before purchase, reliability of a particular machine",
    structure: `Render as a buyer's guide the reader could take with them to the inspection:
# <Title stating the FINDING - what the evidence says about buying this thing. Never a topic label, never an assertion of absence.>
## Executive summary
3-5 sentences: what the evidence says about this purchase, the failure modes that matter most, and what the buyer should do about them. A reader must be able to stop here.
## What to check in person
A checklist of concrete, physical checks the buyer can perform, most decisive first, each one tied to the failure it detects and cited: "- [ ] <check> - <what it would show> [Source N]". Only checks the evidence supports; never invent a procedure.
## Failure modes by subsystem
A Markdown table, one row per subsystem the evidence covers (for example PSU, motherboard/capacitors, CPU socket, RAM, BIOS, thermal/fans - use the subsystems the evidence actually names):
| Subsystem | What goes wrong | What it looks like | Source |
Every row carries its [Source N] in the Source column. A subsystem with no evidence does not get a row - it goes in Limitations.
## What the evidence does not settle
Anything the sources disagree on or leave weakly supported, in prose, cited.
${LIMITATIONS_SECTION}
Practical, specific, no marketing. Prices and part numbers exactly as sourced.`,
  },
  {
    id: "scientific-paper",
    name: "Scientific paper",
    audience: "researchers and technically fluent readers",
    hints: "scientific questions, studies, experiments, biology/physics/chemistry/medicine, 'what does the research say', literature-review style questions",
    structure: `Render as a short scientific-paper-style report:
# <Title — specific and factual, and never an assertion of absence>
**Answer.** 2-4 sentences answering the question directly, before anything else. A reader must be able to stop here and know what the evidence showed.
## Abstract — 3-5 sentences: question, what the evidence shows, the headline conclusion.
## Background — why the question matters, established context (cited).
## Findings — the substantive results, grouped thematically; every finding cited. Use subsections if natural.
## Discussion — what the findings mean together; note confidence levels honestly.
${LIMITATIONS_SECTION}
Formal, precise tone; no marketing language; numbers stated exactly as sourced.`,
  },
  {
    id: "technical-proposal",
    name: "Technical proposal",
    audience: "engineers and technical decision-makers",
    hints: "should-we-build/adopt questions with technical depth, architecture or tooling choices, migration/implementation feasibility",
    structure: `Render as a technical proposal:
# <Title>
## Executive summary — the recommendation in 3-4 sentences.
## Problem statement — what needs solving and why now (cited).
## Proposed approach — the approach the evidence best supports, with technical specifics.
## Technical detail — the load-bearing facts: interfaces, constraints, performance numbers, compatibility (all cited).
## Risks & mitigations — evidenced risks; honest about unknowns.
## Alternatives considered — other options the sources surfaced and why they rank lower.
${LIMITATIONS_SECTION}
Precise, implementation-ready tone; a competent engineer should be able to act on it.`,
  },
  {
    id: "nontechnical-proposal",
    name: "Non-technical proposal",
    audience: "mixed technical and non-technical stakeholders",
    hints: "should-we questions framed around business value, budget, adoption, plain-language decisions",
    structure: `Render as a proposal for a mixed audience:
# <Title>
## Executive summary — plain language, 3-4 sentences, the recommendation up front.
## Why this matters — the problem and stakes, no jargon (cited).
## What we propose — the approach in plain terms; technical terms briefly explained in parentheses.
## What it takes — effort, dependencies, prerequisites as evidenced.
## Risks, plainly — what could go wrong and how likely, per the sources.
${LIMITATIONS_SECTION}
Readable by a non-technical stakeholder, yet specific enough that a technical reader can act on it.`,
  },
  {
    id: "programming-doc",
    name: "Programming technical document",
    audience: "software developers",
    hints: "programming languages, frameworks, libraries, APIs, SDKs, code tooling, software how-it-works questions",
    structure: `Render as a developer-facing technical document:
# <Title>
## Overview — what it is and what problem it solves (2-4 sentences).
## How it works — the mechanics, cited.
## Usage & integration — how to adopt/use it, as evidenced (setup, key interfaces/APIs, configuration).
## Pitfalls & caveats — sourced gotchas, limitations, version issues.
## Compatibility & ecosystem — versions, platforms, related tooling as evidenced.
${LIMITATIONS_SECTION}
Concise, exact, code-literate tone. Inline-code formatting for identifiers. Never invent an API name or version.`,
  },
  {
    id: "engineering-doc",
    name: "Engineering technical document",
    audience: "engineers (physical or systems)",
    hints: "physical engineering, mechanical/electrical/civil, hardware, materials, manufacturing, systems engineering, specifications and standards",
    structure: `Render as an engineering technical document:
# <Title>
## Overview — the system/component/process and its purpose.
## Description — how it is designed/built/operates, cited.
## Specifications & constraints — the hard numbers: dimensions, tolerances, ratings, capacities, exactly as sourced.
## Analysis — trade-offs, comparisons, performance implications the evidence supports.
## Standards & compliance — any codes, standards, certifications the sources mention.
${LIMITATIONS_SECTION}
Precise engineering register; units always stated; no rounded or invented figures.`,
  },
  {
    id: "product-comparison",
    name: "Product comparison",
    audience: "buyers and evaluators",
    hints: "X vs Y, best-tool-for, alternatives-to, feature and pricing comparisons across products or services",
    structure: `Render as a product comparison:
# <Title>
## Verdict — 2-3 sentences: which option leads for whom, per the evidence.
## Comparison at a glance — a Markdown table of the options against the decisive criteria (cite inside cells where a number/claim needs it).
## Per-option detail — a short cited section per option: strengths, weaknesses, pricing/terms as evidenced.
## Decision factors — which criteria should drive the choice, and how the options split on them.
${LIMITATIONS_SECTION}
Even-handed; differences stated concretely; never pad a row with an uncited spec.`,
  },
  {
    id: "market-analysis",
    name: "Market analysis",
    audience: "strategy and business readers",
    hints: "market size/landscape, competitors, industry trends, growth, segments, investment context",
    structure: `Render as a market analysis:
# <Title>
## Executive summary — the state of the market in 3-4 sentences.
## Market overview — size, structure, segments as evidenced.
## Key players — who matters and why, cited.
## Trends & drivers — what is changing and what is pushing it.
## Risks & headwinds — evidenced counter-forces.
## Outlook — only what the sources support; label projections as the sources' own.
${LIMITATIONS_SECTION}
Analytical tone; every figure cited; clearly attribute forecasts to their sources.`,
  },
  {
    id: "value-proposition",
    name: "Value proposition",
    audience: "product and business stakeholders",
    hints: "why-would-anyone-buy/use questions, positioning, differentiation, benefit articulation",
    structure: `Render as a value-proposition document:
# <Title>
## Summary — the core value in 2-3 sentences.
## The problem — the pain being addressed, cited.
## The value offered — the concrete benefits, each evidenced.
## Evidence & differentiators — what sets it apart, per the sources; honest where evidence is thin.
## Target fit — who it serves best, as evidenced.
${LIMITATIONS_SECTION}
Clear and persuasive but never beyond the evidence — this is grounded analysis, not marketing copy.`,
  },
  {
    id: "general-report",
    name: "General research report",
    audience: "any reader",
    hints: "DEFAULT — anything that does not clearly fit another template",
    structure: `Render as a SHORT, answer-first research report. Target 700 words or fewer; never pad.

# <Title that states the ANSWER, not the topic>
**Answer.** 2-4 sentences answering the question directly, from the evidence. Lead with the answer, not with background. If the evidence does not settle the question, say what it DOES establish and what remains open - in those same 2-4 sentences.

## What the evidence supports
One cited bullet per claim, at most 12, most decisive first. No bullet without its [Source N]. Group them under bold sub-labels when the findings fall into obvious groups.

${LIMITATIONS_SECTION}

Nothing else. No "Overview", no "Background", no "Conclusion" restating the summary.`,
  },
];

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
