// Research sessions (research_jobs), their stream, steer (P4b: the P4a door) and the jobs queue view.
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

// ── research-workbench P4b: the running-session card (one shape for every origin, D17) ───────────
const nullStr = z.string().nullable();
export const CardBranch = z.object({
  id: uuid(FX.job),
  parent_job_id: uuid(FX.job).nullable(),
  branch_kind: z.string().openapi({ example: "root", description: "root | steer | gap | interhub | idea (P4a)" }),
  status: registryValue(REGISTRY.jobStates, "running"),
  open: z.boolean().openapi({ description: "queued or running" }),
  pending: z.boolean().openapi({ description: "a branch (not the root) that has not started yet - a steer just accepted" }),
  rooted_step_id: nullStr.openapi({ description: "the step it was steered at; only for a viewer who may act" }),
  query: z.string().openapi({ description: "the branch's question; empty on another user's session" }),
  created_at: Iso,
}).openapi("CardBranch");

export const SessionCard = z.object({
  id: uuid(FX.job),
  status: registryValue(REGISTRY.jobStates, "running"),
  state: recordState("loading"),
  origin: registryValue(REGISTRY.origins, "mattermost"),
  badge: z.object({ key: z.string(), label: z.string() }).openapi({ description: "the origin badge (an idea's job: idea_refinery)" }),
  link: z.object({
    kind: z.string().openapi({ description: "external (href) or panel (panel + params)" }),
    href: nullStr,
    panel: nullStr,
    params: z.record(z.string(), z.string()),
  }).nullable().openapi({ description: "the link back to the inlet; null when the job carries no reference to one" }),
  caller: nullStr,
  query: z.string().openapi({ description: "the session's question; empty on another user's session (07-MULTI-USER)" }),
  phase: z.string(),
  current_artifact: z.object({ kind: z.string(), label: z.string() }),
  waiting_on: z.object({ kind: z.string(), detail: z.string() }),
  next_steering_point: z.object({ step_id: nullStr, phase: z.string() }).nullable()
    .openapi({ description: "where a steer sent now lands: the latest steering stage (step id for a viewer who may act)" }),
  tree: z.array(CardBranch),
  can_act: z.boolean().openapi({ description: "the viewer may steer and cancel from the card" }),
  created_at: Iso,
  started_at: Iso.nullable(),
  finished_at: Iso.nullable(),
}).openapi("SessionCard");

export const Sessions = z.object({ sessions: z.array(SessionCard) }).openapi("Sessions");

// One event of the session's tree (P4a research_job_events) as the viewer may read it.
export const SessionEvent = z.object({
  id: z.number().int(),
  job_id: uuid(FX.job),
  step_id: nullStr,
  type: z.string().openapi({ example: "stage" }),
  kind: z.string().openapi({ example: "steering", description: "steering | due_process: a due-process event carries no steer affordance" }),
  payload: Json.nullable(),
  trail: Json.nullable().openapi({ description: "a source event's admission trail entry" }),
  created_at: Iso,
}).openapi("SessionEvent");

// One `data:` payload of the session stream. `event` is the SSE event name: snapshot, end, and (P4b)
// card - sent while the session or one of its branches is open, with the events since the last one.
export const StreamEvent = z.object({
  event: z.string().openapi({ example: "snapshot" }),
  session: Session,
  card: SessionCard.optional(),
  events: z.array(SessionEvent).optional(),
}).openapi("StreamEvent");

export const SteerRequest = z.object({
  step_id: z.string().min(1),
  text: z.string().min(1),
  context_snapshot: Json.optional(),
  // P4b: narrow (a contract that can only narrow the parent's: P4a narrowContract) and add-source
  contract: Json.optional(),
  add_source: z.object({ url: z.string().min(1), title: z.string().optional(), content: z.string().optional() }).optional()
    .openapi({ description: "add a source: its text, or (blank) fetched through the egress proxy" }),
}).openapi("SteerRequest");

export const SteerResult = z.object({
  steer: z.object({
    steer_id: uuid(FX.job), child_job_id: uuid(FX.job), root_job_id: uuid(FX.job), parent_job_id: uuid(FX.job),
    step_id: z.string(), steer_kind: z.string(),
  }),
  card: SessionCard,
}).openapi("SteerResult");

export const CancelRequest = z.object({ reason: z.string().max(200).optional() }).openapi("CancelRequest");
export const CancelResult = z.object({ job_id: uuid(FX.job), status: z.string(), note: z.string().optional() }).openapi("CancelResult");

export const Flow = z.object({
  session_id: uuid(FX.job),
  running: z.boolean(),
  withheld: z.boolean().openapi({ description: "another user's session: its per-source flow is theirs" }),
  sources: z.array(z.object({
    url: z.string(),
    job_id: uuid(FX.job),
    stages: z.array(z.object({ kind: z.string(), at: Iso, trail: Json })),
  })),
}).openapi("Flow");

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
