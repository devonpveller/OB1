/**
 * agent-memory - the memory plane's write path (memory-plane Phase 1.2).
 *
 * Registered once from index.ts via `registerAgentMemory`. All the SQL and all the
 * decisions live here rather than in the 2063-line monolith: this is the start of the
 * modular split that file needs, done as new surface rather than as a risky refactor.
 *
 * The POLICY - what a default write looks like, and what a default read admits - is NOT
 * defined here. It lives in agent-memory-policy.ts and is imported. That indirection is
 * the whole point: the policy module proves a default writeback is recallable, and this
 * module can only keep that promise if it derives its row from the same constants instead
 * of restating them. A second set of similar-looking literals here is precisely how the
 * invariant would leak after being proved.
 */
import {
  INSPECT_SCHEMA,
  performInspect,
  performRecallTrace,
  performReportUsage,
  RECALL_SCHEMA,
  RECALL_TRACE_SCHEMA,
  REPORT_USAGE_SCHEMA,
  REVIEW_QUEUE_SCHEMA,
  REVIEW_SCHEMA,
  WRITEBACK_SCHEMA,
} from "./agent-memory-tools.ts";
import { listForReview, performReview } from "./agent-memory-ops.ts";
import {
  DEFAULT_RECALL_TUNING,
  overfetchLimit,
  readRecallTuning,
  type RecallTuning,
  rerankByBlend,
} from "./agent-memory-ranking.ts";
import {
  DEFAULT_RECALL_EXPOSURES,
  stampExposure,
  detectPii,
  buildRecallScopeFilter,
  detectUnsafeContent,
  type RecallScope,
  type ReviewStatus,
  type UnsafeReason,
  type Visibility,
  WRITEBACK_DEFAULTS,
  type Exposure,
} from "./agent-memory-policy.ts";

export interface WritebackInput {
  workspace_id: string;
  summary: string;
  content: string;
  memory_type: string;
  project_id?: string | null;
  channel_kind?: string | null;
  channel_id?: string | null;
  visibility?: Visibility;
  idempotency_key?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * §1.1 taint signal, supplied by the CALLING RUNTIME (the orchestrator knows whether the
   * effort consumed advisor output or a personal-plane goal). It can only ever demote -
   * `stampExposure` has no path that widens - so a caller lying about it makes its own
   * memory narrower, never wider.
   */
  tainted?: boolean;
}

/** The row this path inserts into agent_memories. */
export interface WritebackRow {
  workspace_id: string;
  project_id: string | null;
  channel_kind: string | null;
  channel_id: string | null;
  summary: string;
  content: string;
  memory_type: string;
  visibility: Visibility;
  review_status: ReviewStatus;
  confidence: number;
  lifecycle_status: string;
  provenance_status: string;
  can_use_as_evidence: boolean;
  requires_user_confirmation: boolean;
  idempotency_key: string | null;
  /** §1.1. Also written into metadata.exposure, which is what SQL filters on. */
  exposure: Exposure;
  metadata: Record<string, unknown>;
}

/**
 * Build the row, deriving every policy field from WRITEBACK_DEFAULTS.
 *
 * Pure, and exported, so the seam between "the policy we proved" and "the row we insert"
 * is itself testable. `overrides` exists ONLY so a test can force the row into the broken
 * state (review_status='pending', the column default) and prove the invariant assertion
 * can fail - it is not part of the tool's input.
 *
 * `can_use_as_instruction` is deliberately absent from this type and this function. There
 * is no code path here that can set it, so instruction-grade cannot be minted by an agent
 * writing a memory; the schema CHECK is the backstop, not the gate.
 */
export function buildWritebackRow(
  input: WritebackInput,
  overrides: Partial<Pick<WritebackRow, "review_status">> = {},
  door: { exposure?: Exposure; tainted?: boolean } = {},
): WritebackRow {
  // §1.1 - stamped HERE, from the door, never taken from the caller. PII in the content
  // demotes as well: the rule is that detection narrows the plane, it does not refuse.
  const exposure = stampExposure(door.exposure ?? WRITEBACK_DEFAULTS.exposure, {
    tainted: door.tainted,
    piiDetected: detectPii(input.content ?? ""),
  });
  if (!input.workspace_id?.trim()) throw new Error("workspace_id is required");
  if (!input.summary?.trim()) throw new Error("summary is required");
  if (!input.content?.trim()) throw new Error("content is required");
  if (!input.memory_type?.trim()) throw new Error("memory_type is required");

  return {
    workspace_id: input.workspace_id,
    project_id: input.project_id ?? null,
    channel_kind: input.channel_kind ?? null,
    channel_id: input.channel_id ?? null,
    summary: input.summary,
    content: input.content,
    memory_type: input.memory_type,
    // Every one of these comes FROM the policy module. If you find yourself typing a
    // string literal into this block, the invariant test upstream has just stopped
    // meaning anything.
    // A row cannot be PROJECT-visible without naming a project. The defaults say
    // visibility 'project', but a writeback with no project_id then produced a row that a
    // project-scoped recall (`am.project_id = $n`) could never match - written fine,
    // never returned, nothing logged. So an unscoped write is workspace-visible, which is
    // what it actually is. An explicit caller visibility still wins.
    visibility: input.visibility ??
      (input.project_id ? WRITEBACK_DEFAULTS.visibility : "workspace"),
    review_status: overrides.review_status ?? WRITEBACK_DEFAULTS.review_status,
    confidence: WRITEBACK_DEFAULTS.confidence,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
    provenance_status: WRITEBACK_DEFAULTS.provenance_status,
    can_use_as_evidence: WRITEBACK_DEFAULTS.can_use_as_evidence,
    requires_user_confirmation: WRITEBACK_DEFAULTS.requires_user_confirmation,
    idempotency_key: input.idempotency_key ?? null,
    exposure,
    // metadata.exposure is now only a MIRROR: the recall filter reads the exposure
    // COLUMN (DFU C.9 H3). It is still written, in step with the column, so readers that
    // already parse it keep working. Written from the STAMPED
    // value, never from `input.metadata`, so a caller cannot smuggle one in by supplying
    // its own metadata blob - the spread happens first and is then overwritten.
    metadata: { ...(input.metadata ?? {}), exposure },
  };
}

export type WritebackOutcome =
  | { ok: true; memory_id: string; thought_id: number | null; duplicate: boolean }
  | { ok: false; refused: UnsafeReason | "invalid"; message: string };

/** Human-facing reasons, so a refused agent can fix the input rather than retry blindly. */
export function refusalMessage(reason: UnsafeReason | "invalid"): string {
  switch (reason) {
    case "empty":
      return "content is empty";
    case "too_large":
      return "content exceeds the maximum size for a durable memory; summarise it first";
    case "secret_shaped":
      return "content looks like it contains a credential; memories are durable and recallable, so secrets must never be written into one";
    default:
      return "the writeback input was not valid";
  }
}

export interface AgentMemoryDeps {
  /**
   * §1.1: the exposure this DOOR forces on everything written through it.
   *
   * A property of the door, not of the request - the internal lane stamps per the taint
   * rule, the ops door forces 'ops', and an OWUI-facing surface forces 'personal'.
   * Defaults to 'personal' when a door does not say, because the safe end of the axis is
   * the one you get by forgetting.
   */
  doorExposure?: Exposure;
  /** Anything with the ResilientPool `connect()`/`release()` contract from index.ts. */
  pool: {
    connect: () => Promise<{
      queryObject: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
  };
  getEmbedding: (text: string) => Promise<number[]>;
  /** Same auth predicate the rest of the server uses (x-brain-key). */
  authed: (c: unknown) => boolean;
  /**
   * Similarity floor + recency blend for recall. Omitted in production, where it is read
   * from the environment per call so calibration is a config change and not a redeploy;
   * injected in tests, which must not depend on the ambient environment.
   */
  recallTuning?: RecallTuning;
}

/**
 * Perform a writeback. Refuses unsafe content BEFORE touching the embedding lane or the
 * database - an embedding call is the expensive part, and a secret must not reach
 * `thoughts` even transiently.
 */
export async function performWriteback(
  deps: AgentMemoryDeps,
  input: WritebackInput,
): Promise<WritebackOutcome> {
  let row: WritebackRow;
  try {
    // The DOOR is threaded here - this is the only place the write path learns which plane
    // it is on. An earlier edit targeted `const row = ...`, which is not what this line
    // says, so the replacement silently did nothing and every memory was stamped with the
    // default 'personal' while the door said 'ops'. The smoke script caught it because it
    // asserts the stamped value in the DATABASE, not the code that computes it.
    row = buildWritebackRow(input, {}, {
      exposure: deps.doorExposure,
      tainted: input.tainted === true,
    });
  } catch (e) {
    return { ok: false, refused: "invalid", message: (e as Error).message };
  }

  const unsafe = detectUnsafeContent(row.content);
  if (unsafe !== null) {
    return { ok: false, refused: unsafe, message: refusalMessage(unsafe) };
  }

  const client = await deps.pool.connect();
  try {
    // Idempotency first: a retry must not produce a second memory. Checking before the
    // embedding call also avoids burning a GPU cycle on a duplicate.
    //
    // SCOPED BY WORKSPACE, and that is not cosmetic. The lookup used to match on
    // idempotency_key alone, so workspace B asking about its own key "daily-summary-…"
    // was handed workspace A's memory id and thought id, and told duplicate:true while
    // its own memory was never written. Two tenants sharing an obvious key string is the
    // ordinary case, not an attack. Fixed together with the index, which was globally
    // unique and would otherwise reject B's insert outright.
    if (row.idempotency_key) {
      const existing = await client.queryObject(
        `SELECT id, thought_id FROM agent_memories
          WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [row.workspace_id, row.idempotency_key],
      );
      const hit = existing.rows[0] as { id: string; thought_id: number | null } | undefined;
      if (hit) {
        return { ok: true, memory_id: hit.id, thought_id: hit.thought_id, duplicate: true };
      }
    }

    // The durable content stays in `thoughts` - the sidecar tables hold metadata, not a
    // second copy of the corpus.
    const embedding = await deps.getEmbedding(row.content);

    // ALL THREE WRITES ARE ONE TRANSACTION. They were not, and it mattered: when the
    // audit insert failed, the thought and the memory row had already committed. The
    // caller was told the write failed while the memory sat in the corpus unaudited -
    // and an idempotent retry then reported success for a memory that no audit event
    // ever covered. A partial memory is worse than no memory, because nothing downstream
    // can tell the difference.
    await client.queryObject("BEGIN");
    const thought = await client.queryObject(
      // `exposure` is a COLUMN and it is NOT NULL with no default (DFU C.9 H3, operator
      // 2026-08-31). Omitting it here does not produce an unlabelled row that quietly
      // vanishes from its plane - it produces a not_null_violation, which is the point.
      `INSERT INTO thoughts (content, embedding, metadata, exposure)
       VALUES ($1, $2::vector, $3::jsonb, $4::text) RETURNING id`,
      [
        row.content,
        `[${embedding.join(",")}]`,
        // §1.1: the exposure label is MIRRORED onto the thought, so the generic
        // search_thoughts lane enforces the same boundary as the agent-memory recall. A
        // memory whose thought was readable through another lane would make the whole
        // gate decorative. No `share:'cloud'` label, per §1 - the cloud gateway's forced
        // share=cloud read filter therefore excludes these automatically.
        JSON.stringify({
          source: "agent-memory",
          workspace_id: row.workspace_id,
          exposure: row.exposure,
        }),
        row.exposure,
      ],
    );
    const thoughtId = (thought.rows[0] as { id: number }).id;

    const inserted = await client.queryObject(
      // Same as the thought above: `exposure` is a NOT NULL column with no default, and
      // `row.exposure` is the value stampExposure() forced from the door - not something
      // the caller supplied. The mirror inside `row.metadata` is written from the same
      // stamped value (agent-memory-policy.ts), so the two cannot disagree.
      `INSERT INTO agent_memories (
         thought_id, workspace_id, project_id, channel_kind, channel_id,
         summary, content, memory_type, visibility, review_status,
         lifecycle_status, provenance_status, can_use_as_evidence,
         requires_user_confirmation, idempotency_key, content_hash, metadata, exposure
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         agent_memory_hash_text($7), $16::jsonb, $17::text
       ) RETURNING id`,
      [
        thoughtId, row.workspace_id, row.project_id, row.channel_kind, row.channel_id,
        row.summary, row.content, row.memory_type, row.visibility, row.review_status,
        row.lifecycle_status, row.provenance_status, row.can_use_as_evidence,
        row.requires_user_confirmation, row.idempotency_key, JSON.stringify(row.metadata),
        row.exposure,
      ],
    );
    const memoryId = (inserted.rows[0] as { id: string }).id;

    // `payload`, not `detail`. There is no `detail` column - the first version of this
    // named one, so EVERY writeback failed here after committing two rows. A stubbed
    // pool cannot catch that: the test asserted the statement contained
    // "INSERT INTO agent_memory_audit_events", which is true of a statement Postgres
    // rejects. It is now covered by running this SQL against the real schema.
    await client.queryObject(
      `INSERT INTO agent_memory_audit_events (memory_id, workspace_id, event_type, payload)
       VALUES ($1, $2, 'memory_written', $3::jsonb)`,
      [memoryId, row.workspace_id, JSON.stringify({ via: "agent_memory_writeback" })],
    );

    await client.queryObject("COMMIT");
    return { ok: true, memory_id: memoryId, thought_id: thoughtId, duplicate: false };
  } catch (e) {
    try { await client.queryObject("ROLLBACK"); } catch { /* the connection is already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export interface RecallInput extends RecallScope {
  query: string;
  limit?: number;
  /**
   * WIRE SPELLING. RecallScope names this `includeUnconfirmed`, but the tool schema, the
   * REST twin and the plan all say `include_unconfirmed` - so a caller sending the
   * documented parameter set a field nothing read, and the opt-in was UNREACHABLE through
   * either door. The tool's own "pass include_unconfirmed to see them" message described a
   * parameter that did nothing. Both spellings are accepted at the boundary now.
   */
  include_unconfirmed?: boolean;
}

export interface RecalledMemory {
  memory_id: string;
  summary: string;
  content: string;
  memory_type: string;
  visibility: Visibility;
  review_status: ReviewStatus;
  /** Use-policy, returned EXPLICITLY so a caller never has to infer what it may do. */
  can_use_as_evidence: boolean;
  can_use_as_instruction: boolean;
  requires_user_confirmation: boolean;
  similarity: number;
  /** §1.1 plane this memory was written on. */
  exposure: string;
}

export interface RecallOutcome {
  trace_id: string;
  items: RecalledMemory[];
}

/** Hard ceiling on how many memories one recall may return. */
export const RECALL_MAX_LIMIT = 25;

/**
 * Recall memories for a scope.
 *
 * WHY THIS EXISTS AT ALL, beyond the obvious: until it did, the write path was deployed
 * and the read path it was proved compatible with had NO CALLERS. The plane-agreement
 * invariant was demonstrated between the live writer and a reader nobody ran - which is
 * an invariant about nothing. `buildRecallScopeFilter` is the same function the invariant
 * tests use; this is what makes the proof bind.
 *
 * The scope filter is not optional and not reimplemented here. It owns the clauses that
 * are dangerous to forget - lifecycle_status='active', the review whitelist, and a
 * visibility default that excludes the personal plane - and it returns parameters rather
 * than interpolated SQL.
 */
export async function performRecall(
  deps: AgentMemoryDeps,
  input: RecallInput,
): Promise<RecallOutcome> {
  // NORMALISE THE WIRE SPELLING, and FORCE THE EXPOSURE PLANE FROM THE DOOR.
  //
  // §1.1: reads are forced by the door, exactly as writes are stamped by it. A caller that
  // could pass `exposure: ['personal']` would read across the boundary the write side is
  // built to maintain, which would make the whole invariant decorative. The caller's value
  // is dropped rather than merged - merging would let it widen.
  const scope: RecallScope = {
    ...input,
    exposure: deps.doorExposure ? [deps.doorExposure] : DEFAULT_RECALL_EXPOSURES,
    includeUnconfirmed: input.includeUnconfirmed ?? input.include_unconfirmed ?? false,
  };

  if (!input.query?.trim()) throw new Error("recall requires a query");
  const limit = Math.min(Math.max(1, input.limit ?? 8), RECALL_MAX_LIMIT);

  // TUNING PER CALL, from the environment, so calibrating the floor or the recency weight
  // is a config change rather than a redeploy. Tests inject it instead of reaching for the
  // ambient environment.
  const tuning: RecallTuning = deps.recallTuning ??
    (typeof Deno !== "undefined"
      ? readRecallTuning((k) => Deno.env.get(k))
      : DEFAULT_RECALL_TUNING);

  // $1 is the query embedding, so the scope filter's placeholders start at $2.
  const filter = buildRecallScopeFilter(scope, 2);
  const embedding = await deps.getEmbedding(input.query);

  // TWO PHASE, and the phases are not interchangeable (PLAN §3, §6 `recency-boosted-match-
  // thoughts`: "ADAPT - rewrite two-phase"). Phase 1 orders by the raw distance OPERATOR and
  // nothing else, which is the only ordering an HNSW index can serve - the upstream function
  // puts the blended score in its ORDER BY and therefore can never use the index at all.
  // Phase 2 re-ranks the bounded candidate set in memory, where the blend is free.
  //
  // INDEX-SERVABLE, not "index scan": measured live 2026-08-30 this statement plans as a
  // Nested Loop + Sort on a 4-row corpus, and as `Index Scan using idx_thoughts_embedding
  // ... Order By: (embedding <=> $1)` once the planner is forced off the sort. The shape is
  // what this code owns; the plan is the planner's, and it changes with the statistics.
  //
  // The FLOOR is applied here, in the SQL, on the raw cosine - not in phase 2 and not in any
  // client. A floor a caller applies is a floor a second door can skip.
  const candidates = overfetchLimit(limit, RECALL_MAX_LIMIT);
  const floorParam = 2 + filter.params.length;
  const floorSql = tuning.minSimilarity === null ? "" : `\n     WHERE s.similarity >= $${floorParam}`;
  const floorArgs = tuning.minSimilarity === null ? [] : [tuning.minSimilarity];

  const client = await deps.pool.connect();
  try {
    const found = await client.queryObject(
      `SELECT * FROM (
        SELECT am.id, am.summary, am.content, am.memory_type, am.visibility,
              am.review_status, am.can_use_as_evidence, am.can_use_as_instruction,
              am.exposure,
              am.requires_user_confirmation, am.created_at,
              1 - (t.embedding <=> $1::vector) AS similarity
         FROM agent_memories am
         JOIN thoughts t ON t.id = am.thought_id
        WHERE ${filter.sql}
        ORDER BY t.embedding <=> $1::vector
        LIMIT ${candidates}
      ) s${floorSql}`,
      [`[${embedding.join(",")}]`, ...filter.params, ...floorArgs],
    );

    const examined = (found.rows as Array<Record<string, unknown>>);
    const rows = rerankByBlend(examined, tuning, Date.now()).slice(0, limit);

    // The trace is written even when nothing matched. An empty recall is the single most
    // useful thing to have a record of - it is what "the plane is silently empty" looks
    // like from the outside, and without a trace there is nothing to notice it by.
    const trace = await client.queryObject(
      `INSERT INTO agent_memory_recall_traces
         (workspace_id, project_id, query, schema_version, request_payload, response_policy)
       VALUES ($1, $2, $3, 'openbrain.agent_memory.recall.v1', $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        input.workspace_id,
        input.project_id ?? null,
        input.query,
        // THE TUNING IS PART OF THE REQUEST RECORD. Without it "why did that recall return
        // that" becomes unanswerable after a config change - the trace would hold the query
        // and the rows and omit the thing that ranked them.
        JSON.stringify({
          limit,
          include_unconfirmed: !!scope.includeUnconfirmed,
          candidates,
          min_similarity: tuning.minSimilarity,
          recency_weight: tuning.recencyWeight,
          half_life_days: tuning.halfLifeDays,
        }),
        JSON.stringify({ returned: rows.length, examined: examined.length }),
      ],
    );
    const traceId = (trace.rows[0] as { id: string }).id;

    const items: RecalledMemory[] = [];
    let rank = 0;
    for (const r of rows) {
      rank++;
      await client.queryObject(
        `INSERT INTO agent_memory_recall_items
           (trace_id, memory_id, rank, similarity, use_policy_snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          traceId, r.id, rank, r.similarity,
          JSON.stringify({
            can_use_as_evidence: r.can_use_as_evidence,
            can_use_as_instruction: r.can_use_as_instruction,
            requires_user_confirmation: r.requires_user_confirmation,
          }),
        ],
      );
      items.push({
        memory_id: String(r.id),
        summary: String(r.summary),
        content: String(r.content),
        memory_type: String(r.memory_type),
        visibility: r.visibility as Visibility,
        review_status: r.review_status as ReviewStatus,
        exposure: String(r.exposure ?? "personal"),
        can_use_as_evidence: Boolean(r.can_use_as_evidence),
        can_use_as_instruction: Boolean(r.can_use_as_instruction),
        requires_user_confirmation: Boolean(r.requires_user_confirmation),
        similarity: Number(r.similarity),
      });
    }
    return { trace_id: traceId, items };
  } finally {
    client.release();
  }
}

/**
 * Register the writeback tool and its REST twin.
 *
 * The REST route exists for first-party Python callers (precedent: /research/persist) and
 * carries the SAME wire shape and the same x-brain-key guard as the MCP tool, so the two
 * doors cannot drift into different behaviour.
 */
// deno-lint-ignore no-explicit-any
export function registerAgentMemory(server: any, app: any, deps: AgentMemoryDeps): void {
  server.registerTool(
    "agent_memory_writeback",
    {
      title: "Write a governed memory",
      description:
        "Store a durable, recallable memory for this workspace. Written as EVIDENCE, never as an instruction: it can be cited, and it cannot direct future behaviour until a human confirms it.",
      inputSchema: WRITEBACK_SCHEMA,
    },
    async (args: WritebackInput) => {
      const out = await performWriteback(deps, args);
      if (!out.ok) {
        return { isError: true, content: [{ type: "text", text: `Refused: ${out.message}` }] };
      }
      return {
        content: [{
          type: "text",
          text: out.duplicate
            ? `Already stored (idempotency_key matched): ${out.memory_id}`
            : `Stored memory ${out.memory_id}`,
        }],
      };
    },
  );

  server.registerTool(
    "agent_memory_recall",
    {
      title: "Recall governed memories",
      description:
        "Retrieve memories for a workspace, ranked by relevance to a query. Returns only ACTIVE memories that have passed review; each result states explicitly whether it may be used as evidence, whether it may direct behaviour, and whether it still needs human confirmation.",
      inputSchema: RECALL_SCHEMA,
    },
    async (args: RecallInput) => {
      const out = await performRecall(deps, args);
      if (!out.items.length) {
        return {
          content: [{
            type: "text",
            text: "No memories matched that scope. (Unconfirmed memories are excluded by default - pass include_unconfirmed to see them.)",
          }],
        };
      }
      const lines = out.items.map((m, i) =>
        `${i + 1}. [${m.memory_type}] ${m.summary}\n   ${m.content}\n   ` +
        `use: evidence=${m.can_use_as_evidence} instruction=${m.can_use_as_instruction} ` +
        `needs_confirmation=${m.requires_user_confirmation} (${m.review_status})`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  );

  // ── the five tools PLAN §1.2 names that did not exist ─────────────────────────────
  // Seven tools total, mirroring the upstream OpenClaw set. Two of them (review, queue) are
  // reviewer operations: they live on this server because the OPS DOOR is a gateway in
  // front of it, not a second server. That is what §1.4 specifies, and building a bespoke
  // second server instead was the mistake that got reverted.

  server.registerTool(
    "agent_memory_review",
    {
      title: "Act on a memory's standing",
      description:
        "Confirm, restrict, promote, dispute, supersede or reject a memory. Records who decided and what the memory looked like before. Rejection is FINAL - the recall gate returns rejected memories on no path.",
      inputSchema: REVIEW_SCHEMA,
    },
    async (args: Record<string, unknown>) => {
      const out = await performReview(deps, args);
      if (!out.ok) {
        return { isError: true, content: [{ type: "text", text: `Refused (${out.refused}): ${out.message}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `${out.action}: ${out.memory_id} ${out.from} -> ${out.review_status} (lifecycle ${out.lifecycle_status}, exposure ${out.exposure})`,
        }],
      };
    },
  );

  server.registerTool(
    "agent_memory_list_review_queue",
    {
      title: "What is waiting for review",
      description:
        "List memories nobody has acted on yet. Defaults to pending and evidence_only - deliberately NOT everything, because a queue that includes rejected and superseded memories is a list nobody reads.",
      inputSchema: REVIEW_QUEUE_SCHEMA,
    },
    async (args: Record<string, unknown>) => {
      const out = await listForReview(deps, args);
      if (!out.items.length) {
        return { content: [{ type: "text", text: "Nothing is waiting for review." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(out.items, null, 2) }] };
    },
  );

  server.registerTool(
    "agent_memory_inspect",
    {
      title: "Everything known about one memory",
      description:
        "Its standing, its full review history with before/after, and its audit trail. This is what makes a review decision reviewable rather than something to take on trust.",
      inputSchema: INSPECT_SCHEMA,
    },
    async (args: Record<string, unknown>) => {
      const out = await performInspect(deps, args);
      if (!out.ok) {
        return { isError: true, content: [{ type: "text", text: `Refused (${out.refused}): ${out.message}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "agent_memory_recall_trace",
    {
      title: "What a past recall returned",
      description:
        "Read back a recall trace and the memories it surfaced, with the use-policy each carried at the time. Answers 'why did the agent have that in front of it' after the fact.",
      inputSchema: RECALL_TRACE_SCHEMA,
    },
    async (args: Record<string, unknown>) => {
      const out = await performRecallTrace(deps, args);
      if (!out.ok) {
        return { isError: true, content: [{ type: "text", text: `Refused (${out.refused}): ${out.message}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "agent_memory_report_usage",
    {
      title: "Report that a memory was used, or was not",
      description:
        "Record that a recalled memory informed the answer, or was returned and set aside. The negative case matters: a memory recalled repeatedly and never used means the recall is surfacing the wrong thing, and nothing else can see that.",
      inputSchema: REPORT_USAGE_SCHEMA,
    },
    async (args: Record<string, unknown>) => {
      const out = await performReportUsage(deps, args);
      if (!out.ok) {
        return { isError: true, content: [{ type: "text", text: `Refused (${out.refused}): ${out.message}` }] };
      }
      return { content: [{ type: "text", text: "Recorded." }] };
    },
  );

  // The THIRD REST twin (PLAN §1.2). The other two are below.
  // deno-lint-ignore no-explicit-any
  app.post("/agent-memory/usage", async (c: any) => {
    if (!deps.authed(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const out = await performReportUsage(deps, body);
    return out.ok ? c.json(out) : c.json(out, out.refused === "not_found" ? 404 : 400);
  });

  // deno-lint-ignore no-explicit-any
  app.post("/agent-memory/recall", async (c: any) => {
    if (!deps.authed(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid json" }, 400);
    return c.json(await performRecall(deps, body as RecallInput));
  });

  // deno-lint-ignore no-explicit-any
  app.post("/agent-memory/writeback", async (c: any) => {
    if (!deps.authed(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid json" }, 400);
    const out = await performWriteback(deps, body as WritebackInput);
    // 422 for a refusal, matching the staging behaviour the upstream contract uses: the
    // request was well-formed, the CONTENT was not acceptable.
    return out.ok ? c.json(out) : c.json(out, 422);
  });
}
