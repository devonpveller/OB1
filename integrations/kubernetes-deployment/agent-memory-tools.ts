/**
 * agent-memory-tools - the zod input schemas, and the read/report operations behind the
 * five tools that were missing.
 *
 * WHY A THIRD FILE. `agent-memory.ts` owns the write and recall paths, `agent-memory-ops.ts`
 * owns review execution, and this owns the schemas plus the small read-only operations
 * (inspect, recall_trace, report_usage). PLAN §1.2 names one module,
 * `agent-memory.ts` exporting `registerAgentMemory(server, app, deps)` - and that entry
 * point is unchanged: index.ts still calls it exactly once. The split below it is a class-1
 * call, recorded in DECISIONS.md so the plan and the tree stop disagreeing.
 *
 * THE SCHEMAS ARE THE POINT OF THIS FILE. `agent_memory_writeback` shipped with
 * `inputSchema: {}` and four undiscoverable required fields - a model calling it had no way
 * to learn what it wanted except by failing. PLAN §1.2 says "validate (zod)", so that was a
 * missed gate rather than a matter of taste.
 */

import { z } from "zod";
import { REVIEW_ACTIONS } from "./agent-memory-review.ts";
import type { AgentMemoryOpsDeps } from "./agent-memory-ops.ts";

// ── shared field vocabulary ──────────────────────────────────────────────────
// Described, not just typed. A `.describe()` is what a model actually reads; a bare
// z.string() tells it the shape and nothing about the meaning.
const workspaceArg = z.string().describe(
  "Workspace this memory belongs to. 'ai-stack' for this deployment (PLAN §1).",
);
const projectArg = z.string().optional().describe(
  "Project slug: the agent-org project, 'claude-sessions' for the bridge, 'owui' for OWUI surfaces.",
);
export const memoryTypeArg = z.enum([
  "decision",
  "output",
  "lesson",
  "constraint",
  "open_question",
  "failure",
  "artifact_reference",
  "work_log",
  // U3's finding->durable-check pipeline. Added to the SQL CHECK by
  // init-agent-memory-check-type.sql; this enum is the SECOND definition of that
  // vocabulary and drifted the moment the first was widened - the tool rejected 'check'
  // before the database ever saw it. agent-memory-tools.test.ts now reads the .sql and
  // asserts the two lists match, so the next widening cannot go one-sided.
  "check",
]).describe("What kind of memory this is. Constrained by the schema CHECK.");

export const WRITEBACK_SCHEMA = {
  workspace_id: workspaceArg,
  project_id: projectArg,
  summary: z.string().describe("One-line summary. This is what a reviewer reads first."),
  content: z.string().describe(
    "The memory itself. COMPACT SUMMARIES AND SOURCE REFS ONLY - never raw transcripts, " +
      "reasoning traces, secrets or large code blocks (PLAN §1 write-back content rules). " +
      "Secret-shaped content is refused; content with PII is stored but demoted to the " +
      "personal plane.",
  ),
  memory_type: memoryTypeArg,
  channel_kind: z.string().optional().describe("Surface the memory came from, if any."),
  channel_id: z.string().optional().describe("Identifier within that surface."),
  idempotency_key: z.string().optional().describe(
    "Retry-safe key, scoped PER WORKSPACE. A repeat returns the original memory rather than " +
      "writing a second one.",
  ),
  tainted: z.boolean().optional().describe(
    "Set by the CALLING RUNTIME, not by a model: true when this context consumed Tier-2 " +
      "advisor output or a personal-plane goal. It can only ever DEMOTE the memory's " +
      "exposure (PLAN §1.1).",
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    "Free-form provenance. An `exposure` key here is ignored - exposure is stamped by the door.",
  ),
};

export const RECALL_SCHEMA = {
  workspace_id: workspaceArg,
  project_id: projectArg,
  query: z.string().describe("What to search for. Matched semantically against memory content."),
  limit: z.number().int().optional().describe("Maximum results (clamped to 25)."),
  include_unconfirmed: z.boolean().optional().describe(
    "Include memories no human has reviewed yet (review_status 'pending'). Excluded by " +
      "default: an unreviewed memory is evidence nobody has vouched for. Never includes " +
      "rejected, restricted, stale or merged memories.",
  ),
};

export const REVIEW_SCHEMA = {
  memory_id: z.string().describe("The memory to act on."),
  action: z.enum(REVIEW_ACTIONS as unknown as [string, ...string[]]).describe(
    "confirm (a human vouches) | evidence_only | edit | restrict_scope (narrows to the " +
      "personal plane) | promote_exposure (the ONLY widening path) | mark_stale | merge | " +
      "supersede | dispute | reject. Rejection is FINAL.",
  ),
  actor: z.object({ label: z.string() }).describe(
    "Who is answerable for this decision. Required - an audit row without a person records " +
      "that something happened without recording who did it.",
  ),
  note: z.string().optional().describe("Why. Stored on the review-action row."),
  superseded_by: z.string().optional().describe(
    "For merge/supersede: the memory that replaces this one.",
  ),
};

export const REVIEW_QUEUE_SCHEMA = {
  workspace_id: z.string().optional().describe("Narrow to one workspace. Omit for all."),
  review_status: z.array(z.string()).optional().describe(
    "Which states to list. Defaults to pending + evidence_only - the states meaning " +
      "'written, nobody has looked'.",
  ),
  limit: z.number().int().optional().describe("Maximum rows (clamped to 200)."),
};

export const INSPECT_SCHEMA = {
  memory_id: z.string().describe("The memory to inspect."),
};

export const RECALL_TRACE_SCHEMA = {
  trace_id: z.string().describe("A trace id returned by agent_memory_recall."),
};

export const REPORT_USAGE_SCHEMA = {
  memory_id: z.string().describe("The memory that was used or ignored."),
  used: z.boolean().describe(
    "true if this memory informed the answer, false if it was returned and set aside. " +
      "Both are worth recording: a memory that is recalled and never used is a signal the " +
      "recall is returning the wrong thing.",
  ),
  workspace_id: z.string().optional().describe("Workspace, for the audit row's scope."),
  trace_id: z.string().optional().describe("The recall that surfaced it, if known."),
  note: z.string().optional().describe("Why it was or was not used."),
};

// ── operations ───────────────────────────────────────────────────────────────


// ── THE EXPOSURE BOUNDARY, ON EVERY READ TOOL ───────────────────────────────
//
// FOUND BY AN ADVERSARIAL VERIFIER, in code that had already merged. `performRecall` forces
// the exposure plane from the door and a smoke test proves it. These three tools were added
// later, on the same allow-list, and did NOT: `agent_memory_inspect` returned a personal
// memory's full `content` by id, and `agent_memory_list_review_queue` enumerated the
// personal plane. Both with no audit row.
//
// The gateway's forced `metadata_filter` does not save them: these tools' zod schemas have
// no such field, so the MCP SDK strips it before the handler ever sees it. A filter applied
// at a door the callee ignores is not a filter.
//
// So the plane is forced HERE, server-side, from the same door value `performRecall` uses.
// The lesson is narrower than "add a filter": proving a boundary on ONE tool and describing
// the PLANE as contained is the over-claim. Every read tool is a door.
const DEFAULT_READ_EXPOSURE = ["ops"];

function readExposure(deps: AgentMemoryOpsDeps): string[] {
  const door = (deps as { doorExposure?: string }).doorExposure;
  return door ? [door] : DEFAULT_READ_EXPOSURE;
}

/** Record that an access was refused. U5: stopping without a record is indistinguishable
 *  from a request that never happened, and nobody can tell a probing agent from a quiet one. */
async function auditRefusal(
  deps: AgentMemoryOpsDeps,
  client: { queryObject: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }> },
  memoryId: string | null,
  tool: string,
  reason: string,
): Promise<void> {
  try {
    await client.queryObject(
      `INSERT INTO agent_memory_audit_events
         (memory_id, event_type, actor_kind, payload)
       VALUES ($1, 'access_refused', 'agent', $2::jsonb)`,
      [memoryId, JSON.stringify({ tool, reason })],
    );
  } catch {
    // An audit write must not turn a refusal into an error - the caller is already being
    // denied, and a throw here would leak that the row exists via a different status.
  }
}

/**
 * Record that a recalled memory was used, or deliberately not used.
 *
 * The negative case is the interesting one and it is why `used` is required rather than
 * inferred: a memory recalled repeatedly and never used means the recall is surfacing the
 * wrong thing, and nothing else in the plane can see that.
 */
export async function performReportUsage(
  deps: AgentMemoryOpsDeps,
  input: {
    memory_id?: unknown;
    used?: unknown;
    workspace_id?: unknown;
    trace_id?: unknown;
    note?: unknown;
  },
): Promise<{ ok: boolean; refused?: string; message?: string }> {
  const memoryId = typeof input.memory_id === "string" ? input.memory_id.trim() : "";
  if (!memoryId) return { ok: false, refused: "invalid_request", message: "memory_id is required" };
  if (typeof input.used !== "boolean") {
    return { ok: false, refused: "invalid_request", message: "used must be true or false" };
  }
  const client = await deps.pool.connect();
  try {
    // The memory has to exist. An audit row pointing at nothing is a record of a report
    // nobody can interpret, and the FK would take it silently as NULL on delete.
    const found = await client.queryObject(
      `SELECT workspace_id, project_id FROM agent_memories
        WHERE id = $1 AND exposure = ANY($2)`,
      [memoryId, readExposure(deps)],
    );
    const row = found.rows[0] as { workspace_id: string; project_id: string | null } | undefined;
    if (!row) return { ok: false, refused: "not_found", message: `no memory with id ${memoryId}` };

    await client.queryObject(
      `INSERT INTO agent_memory_audit_events
         (memory_id, workspace_id, project_id, trace_id, event_type, actor_kind, payload)
       VALUES ($1, $2, $3, $4, $5, 'agent', $6::jsonb)`,
      [
        memoryId,
        row.workspace_id,
        row.project_id,
        typeof input.trace_id === "string" && input.trace_id ? input.trace_id : null,
        input.used ? "memory_used" : "memory_ignored",
        JSON.stringify({ note: typeof input.note === "string" ? input.note : null }),
      ],
    );
    return { ok: true };
  } finally {
    client.release();
  }
}

/**
 * Everything known about one memory: its standing, its review history, its audit trail.
 *
 * This is what makes a review decision reviewable. Without it a reviewer sees a summary and
 * a status and has to take both on trust.
 */
export async function performInspect(
  deps: AgentMemoryOpsDeps,
  input: { memory_id?: unknown },
): Promise<{ ok: boolean; refused?: string; message?: string; memory?: unknown; review_actions?: unknown[]; audit_events?: unknown[] }> {
  const memoryId = typeof input.memory_id === "string" ? input.memory_id.trim() : "";
  if (!memoryId) return { ok: false, refused: "invalid_request", message: "memory_id is required" };
  const client = await deps.pool.connect();
  try {
    const m = await client.queryObject(
      `SELECT id, workspace_id, project_id, summary, content, memory_type, visibility,
              review_status, lifecycle_status, provenance_status, confidence,
              can_use_as_evidence, can_use_as_instruction, requires_user_confirmation,
              exposure,
              created_at, updated_at, last_confirmed_at
         FROM agent_memories
        WHERE id = $1
          AND exposure = ANY($2)`,
      [memoryId, readExposure(deps)],
    );
    if (!m.rows[0]) {
      // NOT_FOUND, not "forbidden", and deliberately: "this id exists but you may not see
      // it" is itself a disclosure - it confirms the memory to anyone who can guess an id.
      // The caller cannot tell the two apart, which is exactly why the audit row below is
      // required rather than optional.
      const exists = await client.queryObject(
        `SELECT 1 FROM agent_memories WHERE id = $1`, [memoryId]);
      if (exists.rows[0]) {
        await auditRefusal(deps, client, memoryId, "agent_memory_inspect", "off-plane");
      }
      return { ok: false, refused: "not_found", message: `no memory with id ${memoryId}` };
    }
    const actions = await client.queryObject(
      `SELECT action, actor_label, notes, before, after, created_at
         FROM agent_memory_review_actions WHERE memory_id = $1 ORDER BY created_at ASC`,
      [memoryId],
    );
    const events = await client.queryObject(
      `SELECT event_type, actor_kind, actor_label, payload, created_at
         FROM agent_memory_audit_events WHERE memory_id = $1 ORDER BY created_at ASC`,
      [memoryId],
    );
    return { ok: true, memory: m.rows[0], review_actions: actions.rows, audit_events: events.rows };
  } finally {
    client.release();
  }
}

/**
 * What a past recall returned, and under what policy.
 *
 * The trace is written at recall time; this reads it back. It answers "why did the agent
 * have that memory in front of it" after the fact, which is the question an incident asks.
 */
export async function performRecallTrace(
  deps: AgentMemoryOpsDeps,
  input: { trace_id?: unknown },
): Promise<{ ok: boolean; refused?: string; message?: string; trace?: unknown; items?: unknown[] }> {
  const traceId = typeof input.trace_id === "string" ? input.trace_id.trim() : "";
  if (!traceId) return { ok: false, refused: "invalid_request", message: "trace_id is required" };
  const client = await deps.pool.connect();
  try {
    const t = await client.queryObject(
      `SELECT id, workspace_id, project_id, query, schema_version,
              request_payload, response_policy, created_at
         FROM agent_memory_recall_traces WHERE id = $1`,
      [traceId],
    );
    if (!t.rows[0]) return { ok: false, refused: "not_found", message: `no trace with id ${traceId}` };
    const items = await client.queryObject(
      `SELECT ri.memory_id, ri.rank, ri.similarity, ri.use_policy_snapshot,
              am.summary, am.review_status
         FROM agent_memory_recall_items ri
         LEFT JOIN agent_memories am
                ON am.id = ri.memory_id
               AND am.exposure = ANY($2)
        WHERE ri.trace_id = $1 ORDER BY ri.rank ASC`,
      [traceId, readExposure(deps)],
    );
    return { ok: true, trace: t.rows[0], items: items.rows };
  } finally {
    client.release();
  }
}
