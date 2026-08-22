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
- Drop the [SOURCED]/[INFERRED]/[UNCERTAIN] tags; convey that nuance in prose ("directly reports…", "the evidence suggests…", "weakly supported…").
- The [GAP] items are honest unknowns: render them in the report's open-questions section as questions, without citations, and NEVER fill them from your own knowledge.
- No preamble ("Here is the report…") — start with the report itself. Output is Markdown.`;

export const TEMPLATES: ReportTemplate[] = [
  {
    id: "scientific-paper",
    name: "Scientific paper",
    audience: "researchers and technically fluent readers",
    hints: "scientific questions, studies, experiments, biology/physics/chemistry/medicine, 'what does the research say', literature-review style questions",
    structure: `Render as a short scientific-paper-style report:
# <Title — specific and factual>
## Abstract — 3-5 sentences: question, what the evidence shows, the headline conclusion.
## Background — why the question matters, established context (cited).
## Findings — the substantive results, grouped thematically; every finding cited. Use subsections if natural.
## Discussion — what the findings mean together; note confidence levels honestly.
## Limitations & open questions — the [GAP] items plus any weakly supported points.
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
## Open questions — the [GAP] items.
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
## Open questions — the [GAP] items.
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
## Open questions — the [GAP] items.
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
## Open questions — the [GAP] items.
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
## Open questions — the [GAP] items (e.g. unverified pricing, missing benchmarks).
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
## Open questions — the [GAP] items.
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
## Open questions — the [GAP] items.
Clear and persuasive but never beyond the evidence — this is grounded analysis, not marketing copy.`,
  },
  {
    id: "general-report",
    name: "General research report",
    audience: "any reader",
    hints: "DEFAULT — anything that does not clearly fit another template",
    structure: `Render as a clear general research report:
# <Title>
Open with a direct answer to the question, then supporting detail under ## section headers with short paragraphs or bullet lists where natural.
## Open questions — end with the [GAP] items (omit the section if there are none).
Faithful and complete — cover every claim — but readable.`,
  },
];

export const DEFAULT_TEMPLATE_ID = "general-report";

const CLASSIFY_SYS =
  `You choose the best REPORT TEMPLATE for a completed research run. You are given the research QUESTION and a sample of the FINDINGS. Pick the single template whose purpose best matches what a reader would want this delivered as.

Return ONLY JSON: {"template": "<id>"} — one id from the TEMPLATES list. When nothing clearly fits, choose "${DEFAULT_TEMPLATE_ID}".`;

export function templateById(id: string | null | undefined): ReportTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID)!;
}

/** Classify the run into a template. Fails CLOSED to the general report — a
 *  model blip must never block the render. */
export async function classifyTemplate(deps: Deps, query: string, synthesis: string): Promise<ReportTemplate> {
  const list = TEMPLATES.map((t) => `- ${t.id}: ${t.name} — for ${t.audience}. Fits: ${t.hints}`).join("\n");
  try {
    const raw = await deps.chat(
      CLASSIFY_SYS,
      `TEMPLATES:\n${list}\n\nQUESTION: ${query}\n\nFINDINGS (sample):\n${synthesis.slice(0, 2400)}`,
      { json: true, nothink: true },
    );
    const parsed = JSON.parse(raw) as { template?: string };
    return templateById(parsed.template);
  } catch {
    return templateById(DEFAULT_TEMPLATE_ID);
  }
}

/** Full system prompt for rendering the grounded answer in a template. */
export function renderSys(t: ReportTemplate): string {
  return `You are Open Brain's research writer. You are given a QUESTION and a GROUNDED ANSWER — verified assertions tagged [SOURCED]/[INFERRED]/[UNCERTAIN], each ending with its citation [Source N], plus [GAP] lines for points no source covered.

Write the "${t.name}" report (audience: ${t.audience}).

${t.structure}

${GROUNDING_RULES}`;
}
