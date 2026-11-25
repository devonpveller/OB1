// Document gaps (research-workbench redesign, rwr-doc-gaps-api): a person's list of what a document still needs,
// and "research these" (ONE run for the ticked gaps). Every enumerated kind is a registry (gap_origins, gap_states),
// never a closed list here. No request body has a user field: whose gap it is comes from the identity seam, and an
// unknown field is refused (strict schemas).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, uuid } from "./common.ts";

const GAP = "9a900000-0000-4000-8000-000000000001";
const JOB = "9a900000-0000-4000-8000-0000000000a1";
// a C0 control character (bar tab, newline, carriage return) or DEL is refused here: a NUL would otherwise reach Postgres (22021)
const CLEAN = (s: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const CLEAN_MSG = { message: "must not contain control characters" };
// 2000 CHARACTERS (code points, as the database CHECK counts them), not UTF-16 units: 2000 four-byte emoji are 2000 characters
const TEXT = z.string().min(1).refine((s) => Array.from(s).length <= 2000, { message: "must be at most 2000 characters" })
  .refine(CLEAN, CLEAN_MSG).refine((s) => s.trim() !== "", { message: "must not be blank" });
// a document path is at most 1024 BYTES (the database's CHECK; its owner index cannot hold more)
const PATH = z.string().min(1).refine((s) => new TextEncoder().encode(s).length <= 1024, { message: "must be at most 1024 bytes" }).refine(CLEAN, CLEAN_MSG);

export const Gap = z.object({
  id: uuid(GAP, "gap id"),
  path: PATH.openapi({ example: "documents/lab-user/notes.md", description: "the caller's own document this gap belongs to" }),
  text: TEXT.openapi({ description: "what the document still needs; shown to its owner only" }),
  origin: registryValue(REGISTRY.gapOrigins, "user"),
  state: registryValue(REGISTRY.gapStates, "open"),
  job_id: uuid(JOB, "the research run the gap was queued in").nullable(),
  covered_at: Iso.nullable(),
  created_at: Iso,
  updated_at: Iso,
}).openapi("Gap");

export const Gaps = z.object({
  gaps: z.array(Gap),
  total: z.number().int().openapi({ description: "the caller's gaps matching the filter, not only this page" }),
  counts: z.object({
    open: z.number().int(), researching: z.number().int(), covered: z.number().int(), dismissed: z.number().int(),
  }).strict().openapi({ description: "the caller's own gaps per state (for the document asked, or all of theirs)" }),
}).openapi("Gaps");

export const GapCreate = z.object({
  path: PATH.openapi({ example: "documents/lab-user/notes.md", description: "the caller's own document" }),
  text: TEXT,
  origin: registryValue(REGISTRY.gapOrigins, "user").optional(),
}).strict().openapi("GapCreate");

export const GapUpdate = z.object({
  text: TEXT.optional(),
  state: registryValue(REGISTRY.gapStates, "dismissed").optional().openapi({
    description: "open, covered or dismissed (the person's own marks); researching is only reached by researching the gap",
  }),
}).strict().openapi("GapUpdate");

export const GapResearch = z.object({
  ids: z.array(uuid(GAP, "a ticked gap id")).min(1).max(50).openapi({ description: "the ticked gaps, all open, all of one document" }),
}).strict().openapi("GapResearch");

export const GapResearchStarted = z.object({
  job_id: uuid(JOB, "the ONE research run queued for the ticked gaps"),
  gaps: z.array(Gap),
}).openapi("GapResearchStarted");

const T = "2026-10-17T12:00:00.000Z";
export const GPX = {
  gap: {
    id: GAP, path: "documents/lab-user/notes.md", text: "How does the pump hold pressure at altitude?", origin: "user", state: "open",
    job_id: null, covered_at: null, created_at: T, updated_at: T,
  },
  gaps: { gaps: [] as unknown[], total: 1, counts: { open: 1, researching: 0, covered: 0, dismissed: 0 } },
  create: { path: "documents/lab-user/notes.md", text: "How does the pump hold pressure at altitude?" },
  update: { state: "dismissed" },
  research: { ids: [GAP] },
  started: { job_id: JOB, gaps: [] as unknown[] },
};
GPX.gaps.gaps.push(GPX.gap);
GPX.started.gaps.push({ ...GPX.gap, state: "researching", job_id: JOB });
