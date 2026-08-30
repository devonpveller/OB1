/**
 * agent-memory-plane - THE CHOKEPOINT. Every statement that resolves a memory row goes
 * through this file, and none of them can be reached without the door's exposure plane.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS - THREE ROUNDS OF THE SAME BUG
 * ------------------------------------------------------------------------------------
 * The personal-plane boundary has now been closed three times by patching the tool a
 * verifier happened to call, and each time a verifier walked through the tool next door:
 *
 *   1. `performRecall` forced the plane from the door. Proven by a smoke test. The claim
 *      made was "the plane is contained".
 *   2. `agent_memory_inspect`, `agent_memory_list_review_queue` and
 *      `agent_memory_recall_trace` were added later on the SAME allow-list and did not
 *      force anything. inspect returned a personal memory's full `content` by id.
 *   3. Those three were closed - filter, refusal, audit row, all verified live. Then
 *      `agent_memory_review` (a WRITE tool on the same door) turned out to resolve a
 *      memory by id with no plane predicate at all, and `promote_exposure` is the one
 *      action in the system that WIDENS exposure. An ops-door caller could take a
 *      personal memory's id, promote it onto the ops plane, and afterwards read it
 *      through every closed tool entirely legitimately. The containment was never
 *      defeated; the memory was moved to the other side of it.
 *
 * Enumerate-and-patch loses, because omission is always available: the next tool, the
 * next spelling, the next door. So the decision moved HERE. A caller does not choose to
 * apply the plane - there is no statement it can reach that has not already applied it.
 *
 * ------------------------------------------------------------------------------------
 * WHAT MAKES IT A CHOKEPOINT RATHER THAN A CONVENTION
 * ------------------------------------------------------------------------------------
 * 1. `DoorPlane` is NOMINAL. Its brand symbol is module-private, so `doorPlane()` is the
 *    only way to obtain one; a caller cannot write `{ exposures: ["ops","personal"] }`
 *    and have it type-check. Every function below takes one as a REQUIRED positional
 *    argument, so omitting it is a compile error, not an oversight.
 * 2. The plane predicate is emitted by this file, never by a caller. `listMemoriesOnPlane`
 *    hands the caller a builder whose WHERE clause ALREADY STARTS with the predicate;
 *    there is no path that produces an args array without the plane in it.
 * 3. The refusal AUDIT is emitted here too. U5's contract is "mechanically stopped AND
 *    visible in an audit record", and the second half was previously the caller's job -
 *    which is to say, forgettable. `performReportUsage` had forgotten it.
 * 4. COMPLETENESS IS TESTED, not asserted. `agent-memory-plane.test.ts` reads the source
 *    of every file in this subsystem, finds every `agent_memories` occurrence, and
 *    requires each one to be either in THIS file or on a short allow-list with a written
 *    reason. A new unguarded query turns that test red. That test is the deliverable as
 *    much as this module is.
 *
 * DELETING THIS MODULE: it has no dependencies beyond a type import. Everything that
 * imports it would then have to re-embed a plane predicate per statement, which is the
 * arrangement that failed three times.
 */

import type { Exposure } from "./agent-memory-policy.ts";

/**
 * The plane a DOOR reads on, as a value.
 *
 * NOMINAL ON PURPOSE. `PLANE_BRAND` is not exported, so this interface cannot be
 * satisfied by an object literal written anywhere else - `doorPlane()` is the only
 * constructor. That is what makes "you cannot call a lookup without a plane" a type
 * error rather than a rule in a comment, and rules in comments are what the last three
 * rounds were made of.
 */
declare const PLANE_BRAND: unique symbol;
export interface DoorPlane {
  readonly exposures: readonly string[];
  /** The raw door value, for audit payloads. null = the door did not say. */
  readonly door: string | null;
  readonly [PLANE_BRAND]: true;
}

/**
 * What a door with no configured exposure reads.
 *
 * 'ops' and never "everything": a missing `doorExposure` meaning "no filter" is exactly
 * how this hole reopens the next time a surface is wired up. ONE definition, because two
 * copies of a default are two things that can disagree - which is the bug class this
 * whole file is about.
 */
export const DEFAULT_DOOR_PLANE: readonly string[] = Object.freeze(["ops"]);

/** The one constructor. */
export function doorPlane(deps: { doorExposure?: string } | undefined | null): DoorPlane {
  const door = deps?.doorExposure ?? null;
  return { exposures: door ? [door] : [...DEFAULT_DOOR_PLANE], door } as unknown as DoorPlane;
}

/** Anything with the pool client's `queryObject` contract. */
export interface PlaneClient {
  queryObject: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/** Anything with the ResilientPool `connect()`/`release()` contract from index.ts. */
export interface PlanePool {
  connect: () => Promise<PlaneClient & { release: () => void }>;
}

/**
 * What a plane lookup needs: the caller's connection for the QUERY, and the pool for the
 * AUDIT.
 *
 * THE TWO ARE SEPARATE BECAUSE THE DRILL PROVED THEY HAVE TO BE. The first version of this
 * module wrote the refusal row on the caller's connection, which is right for every read
 * tool and WRONG for `performReview` - that one runs inside a transaction and answers a
 * refusal with `ROLLBACK`, so the audit row was written and then erased by the caller's own
 * error path. ATTACK 8 caught it live: the promotion was refused, the plane held, and the
 * count of access_refused rows was 0. "Stopped, but invisible" is exactly half of U5's
 * contract, and it is the half that is easy to believe you already have.
 *
 * So the refusal audit takes its OWN connection and commits independently. A record the
 * caller can undo by rolling back is not a record.
 */
export interface PlaneCtx {
  /** The connection the caller's statements run on - possibly inside a transaction. */
  client: PlaneClient;
  /** The pool. The refusal audit gets a fresh connection from it, outside any transaction. */
  pool: PlanePool;
}

/** The predicate itself, in ONE place. `$n` binds the plane's exposures array. */
export function planePredicate(paramIndex: number, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(${prefix}metadata->>'exposure', 'personal') = ANY($${paramIndex})`;
}

/**
 * Record that an access was refused.
 *
 * Emitted BY THE CHOKEPOINT, so no lookup can be stopped invisibly. Stopping without a
 * record is indistinguishable from a request that never happened, and nobody can tell a
 * probing agent from a quiet one.
 */
export async function auditRefusal(
  pool: PlanePool,
  memoryId: string | null,
  tool: string,
  reason: string,
): Promise<void> {
  let conn: (PlaneClient & { release: () => void }) | null = null;
  try {
    // ITS OWN CONNECTION, so the row commits whatever the caller's transaction does next.
    conn = await pool.connect();
    await conn.queryObject(
      `INSERT INTO agent_memory_audit_events
         (memory_id, event_type, actor_kind, payload)
       VALUES ($1, 'access_refused', 'agent', $2::jsonb)`,
      [memoryId, JSON.stringify({ tool, reason })],
    );
  } catch {
    // An audit write must not turn a refusal into an error - the caller is already being
    // denied, and a throw here would leak that the row exists via a different status.
  } finally {
    try {
      conn?.release();
    } catch { /* the connection is already gone */ }
  }
}

export type PlaneLookup<T> =
  | { ok: true; row: T }
  | { ok: false; refused: "not_found" };

/**
 * Resolve ONE memory by id, on the door's plane. THE function this module exists for.
 *
 * `not_found` and never "forbidden", deliberately: "this id exists but you may not see
 * it" is itself a disclosure - it confirms the memory to anyone who can guess an id. The
 * caller cannot tell an off-plane memory from an absent one, which is exactly why the
 * audit row is written here rather than left to the caller.
 *
 * A genuinely absent id writes NO row. Otherwise every typo becomes a refusal record and
 * the rows that mean "somebody reached for the personal plane" are buried in them.
 */
export async function resolveMemoryOnPlane<T>(
  ctx: PlaneCtx,
  plane: DoorPlane,
  memoryId: string,
  opts: { columns: string; tool: string; forUpdate?: boolean },
): Promise<PlaneLookup<T>> {
  const found = await ctx.client.queryObject(
    `SELECT ${opts.columns}
         FROM agent_memories
        WHERE id = $1
          AND ${planePredicate(2)}${opts.forUpdate ? "\n        FOR UPDATE" : ""}`,
    [memoryId, plane.exposures],
  );
  const row = found.rows[0] as T | undefined;
  if (row) return { ok: true, row };
  await auditIfOffPlane(ctx, memoryId, opts.tool);
  return { ok: false, refused: "not_found" };
}

/**
 * Resolve a memory by its retry key, on the door's plane.
 *
 * FOUND BY THE COMPLETENESS TEST, not by a verifier: enumerating every `agent_memories`
 * statement in the subsystem turned up the writeback's idempotency lookup, which matched
 * on (workspace_id, idempotency_key) with no plane predicate and returned the row's `id`
 * and `thought_id` to the caller as `duplicate: true`. An id is precisely what
 * `agent_memory_inspect` consumes, so the WRITE path was handing personal-plane
 * identifiers to an ops-door caller that guessed a key - and "daily-summary-2026-08-29"
 * is not a hard guess.
 *
 * The key is UNIQUE per workspace regardless of plane
 * (idx_agent_memories_ws_idempotency_key), so an off-plane hit cannot become "write your
 * own copy" - the insert would violate the index. It becomes a refusal that names no id.
 * That still tells the caller the key is taken, which the unique index would tell it
 * anyway; what it no longer tells it is WHICH memory took it.
 */
export async function resolveIdempotentOnPlane<T>(
  ctx: PlaneCtx,
  plane: DoorPlane,
  workspaceId: string,
  idempotencyKey: string,
  opts: { columns: string; tool: string },
): Promise<{ ok: true; row: T | undefined } | { ok: false; refused: "off_plane" }> {
  const found = await ctx.client.queryObject(
    `SELECT ${opts.columns}
         FROM agent_memories
        WHERE workspace_id = $1 AND idempotency_key = $2
          AND ${planePredicate(3)}
        LIMIT 1`,
    [workspaceId, idempotencyKey, plane.exposures],
  );
  const row = found.rows[0] as T | undefined;
  if (row) return { ok: true, row };

  // Nothing on THIS plane. Is the key taken on another one? If it is, the insert this
  // caller is about to attempt would fail on the unique index anyway, so refusing here is
  // the same outcome without the 500 - and without disclosing the id that a bare
  // "duplicate" response used to carry.
  const taken = await ctx.client.queryObject(
    `SELECT 1 FROM agent_memories WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [workspaceId, idempotencyKey],
  );
  if (taken.rows[0]) {
    await auditRefusal(ctx.pool, null, opts.tool, "off-plane-idempotency-key");
    return { ok: false, refused: "off_plane" };
  }
  return { ok: true, row: undefined };
}

/**
 * Update ONE memory by id, on the door's plane.
 *
 * The plane predicate is on the UPDATE as well as on the read that preceded it. Both, not
 * either: the read is what refuses, and the WHERE is what makes the refusal true even if
 * some future edit reorders the two or drops one. `sets` and `args` are the caller's -
 * `args[0]` is the memory id by convention, exactly as before - and the plane parameter is
 * appended here, where it cannot be left off.
 */
export async function updateMemoryOnPlane<T>(
  client: PlaneClient,
  plane: DoorPlane,
  sets: string[],
  args: unknown[],
  returning: string,
): Promise<T | undefined> {
  // The caller's connection, deliberately: an UPDATE belongs in the caller's transaction,
  // unlike the refusal audit above, which must outlive it.
  const res = await client.queryObject(
    `UPDATE agent_memories SET ${sets.join(", ")}
       WHERE id = $1 AND ${planePredicate(args.length + 1)}
       RETURNING ${returning}`,
    [...args, plane.exposures],
  );
  return res.rows[0] as T | undefined;
}

/**
 * A WHERE builder whose first clause is ALREADY the plane predicate.
 *
 * This is the shape that makes a SET query safe by construction. `listForReview` used to
 * assemble its own `where` string and push the plane parameter into it by hand; that
 * worked, and it was the only one of six statements in the subsystem that did.
 */
export interface PlaneQuery {
  /** Bind a value, get its placeholder. */
  param(value: unknown): string;
  /** AND another predicate onto the plane predicate. */
  and(sql: string): void;
}

/**
 * List memories on the door's plane.
 *
 * NO audit row, and that is deliberate: this FILTERS, it does not REFUSE. The caller asked
 * for "the queue" and got the queue for its own plane - there is no denied request to
 * record, and a row per listing would file ordinary use as a probe. U5's "the attempt is
 * visible" attaches to a TARGETED access that was denied, which is what the by-id
 * resolvers above emit.
 */
export async function listMemoriesOnPlane<T>(
  client: PlaneClient,
  plane: DoorPlane,
  spec: {
    columns: string;
    orderBy: string;
    limit: number;
    build?: (q: PlaneQuery) => void;
  },
): Promise<T[]> {
  const args: unknown[] = [plane.exposures];
  let where = planePredicate(1);
  const q: PlaneQuery = {
    param(value: unknown) {
      args.push(value);
      return `$${args.length}`;
    },
    and(sql: string) {
      where += `\n          AND ${sql}`;
    },
  };
  spec.build?.(q);
  const limitPlaceholder = q.param(spec.limit);
  const res = await client.queryObject(
    `SELECT ${spec.columns}
         FROM agent_memories
        WHERE ${where}
        ORDER BY ${spec.orderBy}
        LIMIT ${limitPlaceholder}`,
    args,
  );
  return res.rows as T[];
}

export interface PlaneTraceItem {
  memory_id: string;
  on_plane: boolean;
  [k: string]: unknown;
}

/**
 * The items a recall trace named, bounded by the plane.
 *
 * THE JOIN IS NOT THE BOUNDARY - IT ONLY BLANKS THE COLUMNS IT SELECTS. Found by the U5
 * drill after the plane had already been bound to every read tool: the LEFT JOIN withheld
 * an off-plane memory's `summary` and `review_status` and returned its `memory_id`, `rank`,
 * `similarity` and `use_policy_snapshot` anyway, because those come from
 * `agent_memory_recall_items`, not from the joined side. So the DROP happens here, in the
 * chokepoint, rather than in a caller that can forget it - and `on_plane` never leaves
 * this function.
 *
 * The LEFT JOIN stays (an INNER JOIN would fold the plane predicate into the row set
 * silently, and a test pins the join kind). recall_items.memory_id is NOT NULL and cascades
 * on delete, so a row that failed the join is never "the memory is gone" - it is always
 * "the memory is on another plane", which is what makes it unambiguous enough to audit.
 */
export async function listTraceItemsOnPlane(
  ctx: PlaneCtx,
  plane: DoorPlane,
  traceId: string,
  tool: string,
): Promise<Record<string, unknown>[]> {
  const items = await ctx.client.queryObject(
    `SELECT ri.memory_id, ri.rank, ri.similarity, ri.use_policy_snapshot,
              am.summary, am.review_status,
              (am.id IS NOT NULL) AS on_plane
         FROM agent_memory_recall_items ri
         LEFT JOIN agent_memories am
                ON am.id = ri.memory_id
               AND ${planePredicate(2, "am")}
        WHERE ri.trace_id = $1 ORDER BY ri.rank ASC`,
    [traceId, plane.exposures],
  );
  const visible: Record<string, unknown>[] = [];
  for (const raw of items.rows as PlaneTraceItem[]) {
    if (raw.on_plane) {
      const { on_plane: _onPlane, ...rest } = raw;
      visible.push(rest);
      continue;
    }
    await auditRefusal(ctx.pool, raw.memory_id, tool, "off-plane");
  }
  // The COUNT of what was withheld is never returned. Saying "3 items you may not see"
  // confirms their existence, which is the disclosure `not_found` exists to avoid; the
  // audit row is where that fact belongs.
  return visible;
}

/**
 * Did that id exist at all? Used ONLY to decide whether a miss was a refusal or a typo -
 * the answer never reaches the caller, which is what keeps it from being an oracle.
 */
async function auditIfOffPlane(
  ctx: PlaneCtx,
  memoryId: string,
  tool: string,
): Promise<void> {
  const exists = await ctx.client.queryObject(
    `SELECT 1 FROM agent_memories WHERE id = $1`,
    [memoryId],
  );
  if (exists.rows[0]) await auditRefusal(ctx.pool, memoryId, tool, "off-plane");
}

/** Re-exported so a caller that needs the type does not reach past this module. */
export type { Exposure };
