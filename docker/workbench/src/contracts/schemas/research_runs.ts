// A person's own research runs (rwr-research-runs): the list with state counts, one run's tree with its node details,
// archive / unarchive (a per-user view state, slot 640) and "open the report as a document". Every answer is for the identity
// seam's subject: no request names a person, and a run that is not the caller's is a 404 identical to a missing one.
import { z } from "../deps.ts";
import { Iso, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";
import { CardBranch } from "./sessions.ts";

// the lab run contract-test/fixtures.sql seeds for the lab subject lab-runs-0001 (the Dredd examples run against it)
export const RUN_ID = "f6100000-0000-4000-8000-000000000001";
const nullStr = z.string().nullable();

export const RunRow = z.object({
  id: uuid(RUN_ID),
  question: z.string().openapi({ description: "the run's root question (the boundary's public question for a started run)" }),
  topic: nullStr.openapi({ description: "the boundary's topic for a started run, else null" }),
  document: nullStr.openapi({ description: "the caller's own document the run was started from (its path), else null" }),
  status: z.string().openapi({ example: "running", description: "the root job's own status (the job_states registry)" }),
  group: z.string().openapi({ example: "running", description: "running | queued | done | stopped: the list's state group (open branches count as running)" }),
  branches: z.number().int().openapi({ description: "how many branches the tree has besides its root" }),
  created_at: Iso,
  finished_at: Iso.nullable(),
  archived: z.boolean(),
  archived_at: Iso.nullable(),
}).openapi("ResearchRunRow");

export const RunCounts = z.object({
  running: z.number().int(), queued: z.number().int(), done: z.number().int(), stopped: z.number().int(),
  archived: z.number().int().openapi({ description: "the caller's archived runs" }),
  total: z.number().int().openapi({ description: "the caller's runs that are not archived" }),
}).openapi("ResearchRunCounts");

export const RunList = z.object({ runs: z.array(RunRow), counts: RunCounts }).openapi("ResearchRunList");

export const RunNodeSource = z.object({ url: z.string(), title: nullStr, stages: z.array(z.string()) }).openapi("ResearchRunSource");
export const RunNodeClaim = z.object({ id: z.string(), text: z.string() }).openapi("ResearchRunClaim");
export const RunNode = z.object({
  ...CardBranch.shape,
  sources: z.array(RunNodeSource),
  claims: z.array(RunNodeClaim),
  has_report: z.boolean().openapi({ description: "this node's run finished with a report text" }),
}).openapi("ResearchRunNode");

export const RunDetail = z.object({
  run: RunRow,
  can_act: z.boolean().openapi({ description: "the caller may steer or cancel from here (the sessions rule)" }),
  running: z.boolean(),
  next_steering_point: z.object({ step_id: nullStr, phase: z.string() }).nullable(),
  nodes: z.array(RunNode),
}).openapi("ResearchRunDetail");

export const RunArchived = z.object({ id: uuid(RUN_ID), archived: z.boolean(), archived_at: Iso.nullable() }).openapi("ResearchRunArchived");

export const RunDocument = z.object({
  path: z.string().openapi({ example: "documents/alice/what-is-the-run.md", description: "the new document's path in the caller's own folder" }),
  title: z.string(),
}).openapi("ResearchRunDocument");

export const RRX = {
  row: {
    id: RUN_ID, question: "How do the two sensors compare?", topic: "sensors", document: null, status: "done", group: "done", branches: 1,
    created_at: FX.at, finished_at: FX.at, archived: false, archived_at: null,
  },
  counts: { running: 0, queued: 0, done: 1, stopped: 0, archived: 0, total: 1 },
  archived: { id: RUN_ID, archived: true, archived_at: FX.at },
  unarchived: { id: RUN_ID, archived: false, archived_at: null },
  document: { path: "documents/fixture-run-report.md", title: "How do the two sensors compare?" },
};
