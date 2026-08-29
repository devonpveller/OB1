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
  detectUnsafeContent,
  type ReviewStatus,
  type UnsafeReason,
  type Visibility,
  WRITEBACK_DEFAULTS,
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
  lifecycle_status: string;
  provenance_status: string;
  can_use_as_evidence: boolean;
  requires_user_confirmation: boolean;
  idempotency_key: string | null;
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
): WritebackRow {
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
    visibility: input.visibility ?? WRITEBACK_DEFAULTS.visibility,
    review_status: overrides.review_status ?? WRITEBACK_DEFAULTS.review_status,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
    provenance_status: WRITEBACK_DEFAULTS.provenance_status,
    can_use_as_evidence: WRITEBACK_DEFAULTS.can_use_as_evidence,
    requires_user_confirmation: WRITEBACK_DEFAULTS.requires_user_confirmation,
    idempotency_key: input.idempotency_key ?? null,
    metadata: input.metadata ?? {},
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
    row = buildWritebackRow(input);
  } catch (e) {
    return { ok: false, refused: "invalid", message: (e as Error).message };
  }

  const unsafe = detectUnsafeContent(row.content);
  if (unsafe !== null) {
    return { ok: false, refused: unsafe, message: refusalMessage(unsafe) };
  }

  const client = await deps.pool.connect();
  try {
    // Idempotency first: a retry must not produce a second memory. The partial unique
    // index on idempotency_key makes this safe under concurrency too, but checking first
    // avoids burning an embedding call on a duplicate.
    if (row.idempotency_key) {
      const existing = await client.queryObject(
        `SELECT id, thought_id FROM agent_memories WHERE idempotency_key = $1 LIMIT 1`,
        [row.idempotency_key],
      );
      const hit = existing.rows[0] as { id: string; thought_id: number | null } | undefined;
      if (hit) {
        return { ok: true, memory_id: hit.id, thought_id: hit.thought_id, duplicate: true };
      }
    }

    // The durable content stays in `thoughts` - the sidecar tables hold metadata, not a
    // second copy of the corpus.
    const embedding = await deps.getEmbedding(row.content);
    const thought = await client.queryObject(
      `INSERT INTO thoughts (content, embedding, metadata)
       VALUES ($1, $2::vector, $3::jsonb) RETURNING id`,
      [
        row.content,
        `[${embedding.join(",")}]`,
        JSON.stringify({ source: "agent-memory", workspace_id: row.workspace_id }),
      ],
    );
    const thoughtId = (thought.rows[0] as { id: number }).id;

    const inserted = await client.queryObject(
      `INSERT INTO agent_memories (
         thought_id, workspace_id, project_id, channel_kind, channel_id,
         summary, content, memory_type, visibility, review_status,
         lifecycle_status, provenance_status, can_use_as_evidence,
         requires_user_confirmation, idempotency_key, content_hash, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         agent_memory_hash_text($7), $16::jsonb
       ) RETURNING id`,
      [
        thoughtId, row.workspace_id, row.project_id, row.channel_kind, row.channel_id,
        row.summary, row.content, row.memory_type, row.visibility, row.review_status,
        row.lifecycle_status, row.provenance_status, row.can_use_as_evidence,
        row.requires_user_confirmation, row.idempotency_key, JSON.stringify(row.metadata),
      ],
    );
    const memoryId = (inserted.rows[0] as { id: string }).id;

    await client.queryObject(
      `INSERT INTO agent_memory_audit_events (memory_id, workspace_id, event_type, detail)
       VALUES ($1, $2, 'memory_written', $3::jsonb)`,
      [memoryId, row.workspace_id, JSON.stringify({ via: "agent_memory_writeback" })],
    );

    return { ok: true, memory_id: memoryId, thought_id: thoughtId, duplicate: false };
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
      inputSchema: {},
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
