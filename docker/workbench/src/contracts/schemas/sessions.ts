// Research sessions (research_jobs), their stream, steer (a P4a stub) and the jobs queue view.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const Session = z.object({
  id: uuid(FX.job),
  state: recordState("current"),
  state_detail: StateDetail,
  status: registryValue(REGISTRY.jobStates, "done"),
  origin: registryValue(REGISTRY.origins, "owui"),
  origin_claimed: z.string().nullable().openapi({ description: "what the request body claimed, when it disagreed with the key (D17 item 1)" }),
  caller: z.string().nullable(),
  inlet_ref: Json.nullable().openapi({ description: "OWUI chat id, Mattermost permalink, notebook run id or idea id" }),
  refinery_id: uuid(FX.idea).nullable(),
  query: z.string(),
  progress: Json,
  session_id: uuid(FX.session).nullable(),
  thread_id: uuid(FX.thread).nullable(),
  created_at: Iso,
  started_at: Iso.nullable(),
  finished_at: Iso.nullable(),
  result_summary: z.object({
    claims: z.number().int(),
    cited_sources: z.number().int(),
    gaps: z.array(z.string()),
  }),
}).openapi("Session");

// One `data:` payload of the session stream. `event` is the SSE event name (snapshot, end).
export const StreamEvent = z.object({
  event: z.string().openapi({ example: "snapshot" }),
  session: Session,
}).openapi("StreamEvent");

export const SteerRequest = z.object({
  step_id: z.string().min(1),
  text: z.string().min(1),
  context_snapshot: Json.optional(),
}).openapi("SteerRequest");

export const Job = z.object({
  kind: registryValue(REGISTRY.jobKinds, "import"),
  id: uuid(FX.importJob),
  status: registryValue(REGISTRY.jobStates, "done"),
  state: recordState("current"),
  created_at: Iso,
  updated_at: Iso,
  detail: Json,
}).openapi("Job");

export const Jobs = z.object({
  jobs: z.array(Job),
}).openapi("Jobs");
