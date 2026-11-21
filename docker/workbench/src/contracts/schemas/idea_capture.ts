// Capturing an idea in the workbench (rwr-idea-capture-api): POST /workbench/ideas.
// No enum, no union (the contract's rule): research.mode is a string the description names. The request is strict -
// it has no owner, user or domain field, and any field it does not name is refused (400): the owner is the identity
// seam's subject, never the request's.
import { z } from "../deps.ts";
import { uuid } from "./common.ts";

export const IdeaCaptureRequest = z.object({
  summary: z.string().openapi({ example: "A pantry tracker that suggests meals from what is about to expire.", description: "the idea's text (private to its owner); at most 20000 characters" }),
  title: z.string().nullable().optional().openapi({ example: "Pantry meal suggestions", description: "optional; at most 120 characters kept; omitted = the text's first line" }),
}).strict().openapi("IdeaCaptureRequest");

export const IdeaCaptureResearch = z.object({
  mode: z.string().openapi({ example: "immediate", description: "the owner's research schedule: immediate (the default), daily or weekly" }),
  queued: z.boolean().openapi({ description: "true when research was queued at capture; false when it waits for the owner's scheduled start" }),
  job_id: uuid("d0d0d0d0-0000-4000-8000-000000000002", "the queued research job (the caller's own), or null").nullable(),
  next_start: z.string().nullable().openapi({ example: null, description: "when the waiting research starts (ISO-8601), or null when queued" }),
}).openapi("IdeaCaptureResearch");

export const IdeaCaptured = z.object({
  idea_id: uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", "the new idea, private to the caller"),
  title: z.string(),
  status: z.string().openapi({ example: "new" }),
  research: IdeaCaptureResearch,
}).openapi("IdeaCaptured");

export const ICX = {
  request: { summary: "A pantry tracker that suggests meals from what is about to expire.", title: "Pantry meal suggestions" },
  captured: {
    idea_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", title: "Pantry meal suggestions", status: "new",
    research: { mode: "immediate", queued: true, job_id: "d0d0d0d0-0000-4000-8000-000000000002", next_start: null },
  },
};
