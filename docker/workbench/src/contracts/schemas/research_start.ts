// Starting research from anywhere (rwr-research-start-api): POST /workbench/research and POST /workbench/research/preview.
// No enum, no union (the contract's rule): attach.kind and depth are strings the route validates and the descriptions
// name; the examples are hand-written and the conformance test validates each against its schema.
import { z } from "../deps.ts";
import { uuid } from "./common.ts";

export const StartAttach = z.object({
  kind: z.string().openapi({ example: "document", description: "none (attach to nothing), document or idea" }),
  path: z.string().optional().openapi({ example: "documents/lab-user/notes.md", description: "kind document: the caller's own document" }),
  id: z.string().optional().openapi({ example: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f", description: "kind idea: the caller's own idea" }),
}).strict().openapi("ResearchStartAttach");

export const StartRequestBody = z.object({
  attach: StartAttach.optional().openapi({ description: "what the run is about; omitted = attach to nothing" }),
  question: z.string().min(1).max(2000).openapi({ example: "Should I buy a heat pump?", description: "what the person wants to know - private; only the boundary's de-personalised question leaves" }),
  depth: z.string().optional().openapi({ example: "standard", description: "quick, standard (default) or deep: a preset of today's research limits, never above the admin ceilings" }),
  passages: z.array(z.string().max(4000)).max(20).optional().openapi({ description: "selected passages of the attached document or idea - private, like the question" }),
  approved_question: z.string().max(300).optional().openapi({ description: "start only: the question the preview showed; the start refuses (409) rather than send a different one" }),
}).strict().openapi("ResearchStartRequest");

export const StartDepth = z.object({
  name: z.string().openapi({ example: "standard" }),
  rounds: z.number().int(),
  max_fetch: z.number().int(),
  wall_ms: z.number().int(),
}).openapi("ResearchStartDepth", { description: "the limits the run will use: min(preset, admin ceiling) per limit" });

export const StartShown = z.object({
  question: z.string().nullable().openapi({ description: "the de-personalised question that would leave (null when the boundary refused)" }),
  topic: z.string().nullable(),
  links: z.array(z.string()).openapi({ description: "the public links the research service will fetch itself" }),
  depth: StartDepth.nullable(),
  refusal: z.string().nullable().openapi({ example: null, description: "why the boundary refused to form a public question, or null; a refusal starts nothing" }),
});

export const StartPreview = StartShown.extend({
  ok: z.boolean().openapi({ description: "true when a request was formed; the preview created no job and no row" }),
}).openapi("ResearchStartPreview");

export const StartStarted = StartShown.extend({
  started: z.boolean().openapi({ description: "true when a run was queued; false (200) when the boundary refused" }),
  job_id: uuid("d0d0d0d0-0000-4000-8000-000000000001", "the queued run").nullable(),
}).openapi("ResearchStarted");

const SHOWN_EX = {
  question: "What is known about heat pumps and winter heating bills?", topic: "heat pumps winter bills",
  links: ["https://news.example.org/heat-pumps"], depth: { name: "standard", rounds: 2, max_fetch: 40, wall_ms: 600000 }, refusal: null,
};
export const RSX = {
  request: { attach: { kind: "document", path: "documents/lab-user/notes.md" }, question: "Should I buy a heat pump?", depth: "standard", passages: [] },
  preview: { ok: true, ...SHOWN_EX },
  started: { started: true, job_id: "d0d0d0d0-0000-4000-8000-000000000001", ...SHOWN_EX },
};
