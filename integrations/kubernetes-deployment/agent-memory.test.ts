/** Tests for the agent-memory write path.
 *
 * Run: deno test agent-memory.test.ts
 *
 * The first group is the one that matters: it closes the seam the policy slice flagged.
 * Proving "a default writeback is recallable" in the policy module is worth nothing if the
 * code that actually inserts the row carries its own literals.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildWritebackRow,
  performRecall,
  performWriteback,
  RECALL_MAX_LIMIT,
  refusalMessage,
  type AgentMemoryDeps,
} from "./agent-memory.ts";
import {
  buildRecallScopeFilter,
  DEFAULT_RECALL_EXPOSURES,
  type Exposure,
  DEFAULT_RECALL_STATUSES,
  defaultWritebackIsRecallable,
  isRowRecallableBy,
  WRITEBACK_DEFAULTS,
} from "./agent-memory-policy.ts";

const INPUT = {
  workspace_id: "ws-1",
  summary: "the drain stalls when the planner churns",
  content: "A long-enough lesson worth keeping in the corpus.",
  memory_type: "lesson",
};

// ── THE SEAM: the row we INSERT is the row the policy DESCRIBES ───────────────
Deno.test("SEAM: the built row derives its policy fields from WRITEBACK_DEFAULTS", () => {
  const row = buildWritebackRow(INPUT);
  // Compared against the CONSTANTS, never against string literals - a literal here would
  // pass while the two drifted apart, which is the exact failure this guards.
  assertEquals(row.review_status, WRITEBACK_DEFAULTS.review_status);
  // Visibility comes from the defaults when the write NAMES a project. Without one the
  // row is workspace-visible instead: it cannot honestly claim project scope with no
  // project, and claiming it made the row unreachable to a project-scoped recall.
  assertEquals(
    buildWritebackRow({ ...INPUT, project_id: "p1" }).visibility,
    WRITEBACK_DEFAULTS.visibility,
  );
  assertEquals(row.visibility, "workspace");
  assertEquals(row.lifecycle_status, WRITEBACK_DEFAULTS.lifecycle_status);
  assertEquals(row.provenance_status, WRITEBACK_DEFAULTS.provenance_status);
  assertEquals(row.can_use_as_evidence, WRITEBACK_DEFAULTS.can_use_as_evidence);
  assertEquals(row.requires_user_confirmation, WRITEBACK_DEFAULTS.requires_user_confirmation);
});

Deno.test("SEAM: the built row's EXPOSURE is one a default recall returns", () => {
  // PLAN §1.3 states the invariant over visibility/exposure, and this is its end-to-end
  // form: the row the writer actually builds, through an ops door, lands on a plane the
  // default recall reads. (Its review_status deliberately does NOT - see below.)
  const row = buildWritebackRow(INPUT, {}, { exposure: "ops" });
  assertEquals(row.exposure, "ops");
  assertEquals(DEFAULT_RECALL_EXPOSURES.includes(row.exposure), true);
});

Deno.test("SEAM test can FAIL - a tainted write lands off the default recall plane", () => {
  // RED proof for the invariant above, and the Hermes shape the plan names: the write side
  // puts the memory on the personal plane while the default recall scope drops it. Writes
  // succeed, recall returns nothing, nothing errors.
  const tainted = buildWritebackRow(INPUT, {}, { exposure: "ops", tainted: true });
  assertEquals(tainted.exposure, "personal");
  assertEquals(DEFAULT_RECALL_EXPOSURES.includes(tainted.exposure), false);
});

Deno.test("SEAM: the built row is review-gated, and that is deliberate", () => {
  // §1 locks review_status='pending'. An earlier version of this file asserted the
  // opposite - that a fresh write is immediately recallable - and the write default had
  // been changed to 'evidence_only' to make it true. That removed the review door.
  const row = buildWritebackRow(INPUT);
  assertEquals(row.review_status, "pending");
  assertEquals(defaultWritebackIsRecallable(row, DEFAULT_RECALL_STATUSES), false);
});

Deno.test("instruction-grade is not reachable from the write path", () => {
  const row = buildWritebackRow({ ...INPUT, memory_type: "decision" });
  assertEquals("can_use_as_instruction" in row, false);
  // Even a caller who tries to smuggle it in gets nothing: the builder copies named
  // fields only.
  const sneaky = buildWritebackRow(
    { ...INPUT, can_use_as_instruction: true } as unknown as typeof INPUT,
  );
  assertEquals("can_use_as_instruction" in sneaky, false);
});

// ── validation ───────────────────────────────────────────────────────────────
Deno.test("required fields are enforced by the builder", () => {
  for (const missing of ["workspace_id", "summary", "content", "memory_type"] as const) {
    const bad = { ...INPUT, [missing]: "  " };
    let threw = false;
    try { buildWritebackRow(bad); } catch { threw = true; }
    assertEquals(threw, true, `${missing} must be required`);
  }
});

Deno.test("summary is required - the column is NOT NULL", () => {
  // Found by probing the live schema: an insert without summary violates a NOT NULL
  // constraint, so summary cannot be an optional enrichment added later.
  let threw = false;
  try { buildWritebackRow({ ...INPUT, summary: "" }); } catch { threw = true; }
  assertEquals(threw, true);
});

// ── refusals happen BEFORE the expensive work ────────────────────────────────
function stubDeps(): AgentMemoryDeps & { embedCalls: number; connects: number } {
  const state = { embedCalls: 0, connects: 0 };
  return {
    embedCalls: 0,
    connects: 0,
    get pool() {
      return {
        connect: () => {
          state.connects++;
          return Promise.resolve({
            queryObject: () => Promise.resolve({ rows: [{ id: "m-1", thought_id: 1 }] }),
            release: () => {},
          });
        },
      };
    },
    getEmbedding: () => {
      state.embedCalls++;
      return Promise.resolve([0.1, 0.2]);
    },
    authed: () => true,
    // expose the counters
    get _state() { return state; },
  } as unknown as AgentMemoryDeps & { embedCalls: number; connects: number };
}

Deno.test("secret-shaped content is refused before embedding or the database", async () => {
  const deps = stubDeps();
  // Assembled, never a literal - a credential-shaped literal in a test file is what a
  // secret scanner is for, and GitHub push protection rejects it (it already did once).
  const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const out = await performWriteback(deps, { ...INPUT, content: `key ${secret}` });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "secret_shaped");
  // deno-lint-ignore no-explicit-any
  const state = (deps as any)._state;
  assertEquals(state.embedCalls, 0, "must not embed refused content");
  assertEquals(state.connects, 0, "must not touch the database for refused content");
});

Deno.test("oversized content is refused, with a reason the agent can act on", async () => {
  const deps = stubDeps();
  const out = await performWriteback(deps, { ...INPUT, content: "x".repeat(20001) });
  assertEquals(out.ok, false);
  if (!out.ok) {
    assertEquals(out.refused, "too_large");
    assertEquals(out.message.includes("summarise"), true);
  }
});

Deno.test("refusal messages are specific, not generic", () => {
  assertEquals(refusalMessage("secret_shaped").includes("credential"), true);
  assertEquals(refusalMessage("too_large").includes("summarise"), true);
  assertEquals(refusalMessage("empty").includes("empty"), true);
});

// ── idempotency ──────────────────────────────────────────────────────────────
Deno.test("an idempotency_key hit returns the existing memory and does not re-embed", async () => {
  let embedCalls = 0;
  const deps = {
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string) => {
            if (sql.includes("SELECT id, thought_id FROM agent_memories")) {
              return Promise.resolve({ rows: [{ id: "existing-1", thought_id: 42 }] });
            }
            throw new Error("must not insert on an idempotency hit");
          },
          release: () => {},
        }),
    },
    getEmbedding: () => { embedCalls++; return Promise.resolve([0.1]); },
    authed: () => true,
  } as unknown as AgentMemoryDeps;

  const out = await performWriteback(deps, { ...INPUT, idempotency_key: "k-1" });
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.duplicate, true);
    assertEquals(out.memory_id, "existing-1");
  }
  assertEquals(embedCalls, 0, "a duplicate must not burn an embedding call");
});

Deno.test("a fresh write inserts and reports not-duplicate", async () => {
  const seen: string[] = [];
  const deps = {
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string) => {
            seen.push(sql.trim().split("\n")[0]);
            if (sql.includes("INSERT INTO thoughts")) {
              return Promise.resolve({ rows: [{ id: 7 }] });
            }
            return Promise.resolve({ rows: [{ id: "mem-9" }] });
          },
          release: () => {},
        }),
    },
    getEmbedding: () => Promise.resolve([0.1, 0.2]),
    authed: () => true,
  } as unknown as AgentMemoryDeps;

  const out = await performWriteback(deps, INPUT);
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.duplicate, false);
    assertEquals(out.thought_id, 7);
    assertEquals(out.memory_id, "mem-9");
  }
  // The durable content goes to `thoughts`; the sidecar holds metadata, and the write is
  // audited.
  assertEquals(seen.some((s) => s.includes("INSERT INTO thoughts")), true);
  assertEquals(seen.some((s) => s.includes("INSERT INTO agent_memories")), true);
  assertEquals(seen.some((s) => s.includes("INSERT INTO agent_memory_audit_events")), true);
});

// ── RECALL: the reader the invariant is proved against must be the one that ships ──
// Before this existed, buildRecallScopeFilter had ZERO consumers: the write path was
// deployed and the read path it was proved compatible with was called by nothing. An
// invariant between a live writer and a reader nobody runs is an invariant about nothing.

function recallDeps(rows: Array<Record<string, unknown>>) {
  const seen: string[] = [];
  const params: unknown[][] = [];
  const deps = {
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string, args?: unknown[]) => {
            seen.push(sql);
            params.push(args ?? []);
            if (sql.includes("FROM agent_memories am")) return Promise.resolve({ rows });
            if (sql.includes("agent_memory_recall_traces")) {
              return Promise.resolve({ rows: [{ id: "trace-1" }] });
            }
            return Promise.resolve({ rows: [] });
          },
          release: () => {},
        }),
    },
    getEmbedding: () => Promise.resolve([0.1, 0.2]),
    authed: () => true,
  } as unknown as AgentMemoryDeps;
  return { deps, seen, params };
}

const ROW = {
  id: "m-1", summary: "s", content: "c", memory_type: "lesson",
  visibility: "workspace", review_status: "evidence_only",
  can_use_as_evidence: true, can_use_as_instruction: false,
  requires_user_confirmation: true, similarity: 0.9,
};

Deno.test("SEAM: performWriteback THREADS THE DOOR - not just buildWritebackRow", async () => {
  // The gap this closes cost a full smoke run. The door was wired into buildWritebackRow
  // and the unit tests passed, because they call that function directly and pass the door
  // themselves. The CALL SITE inside performWriteback was never updated - an edit targeted
  // `const row = ...` where the line reads `row = ...` - so every memory shipped stamped
  // 'personal' while the door said 'ops'. Testing the function a caller uses is not the
  // same as testing the caller.
  const seen: unknown[][] = [];
  const deps = {
    doorExposure: "ops" as Exposure,
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string, args?: unknown[]) => {
            seen.push([sql, ...(args ?? [])]);
            if (sql.includes("INSERT INTO thoughts")) return Promise.resolve({ rows: [{ id: 1 }] });
            return Promise.resolve({ rows: [{ id: "m-1", thought_id: 1 }] });
          },
          release: () => {},
        }),
    },
    getEmbedding: () => Promise.resolve([0.1]),
  } as unknown as AgentMemoryDeps;

  await performWriteback(deps, { ...INPUT, project_id: "p1" });

  const insert = seen.find((r) => String(r[0]).includes("INSERT INTO agent_memories"))!;
  const metadata = JSON.parse(String(insert[insert.length - 1]));
  assertEquals(metadata.exposure, "ops", "the door's plane must reach the inserted row");

  // And the thought carries the mirror, or another lane could read what this one hides.
  const thought = seen.find((r) => String(r[0]).includes("INSERT INTO thoughts"))!;
  assertEquals(JSON.parse(String(thought[3])).exposure, "ops");
});

Deno.test("SEAM: a tainted write is demoted at the call site too", async () => {
  const seen: unknown[][] = [];
  const deps = {
    doorExposure: "ops" as Exposure,
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string, args?: unknown[]) => {
            seen.push([sql, ...(args ?? [])]);
            if (sql.includes("INSERT INTO thoughts")) return Promise.resolve({ rows: [{ id: 1 }] });
            return Promise.resolve({ rows: [{ id: "m-1", thought_id: 1 }] });
          },
          release: () => {},
        }),
    },
    getEmbedding: () => Promise.resolve([0.1]),
  } as unknown as AgentMemoryDeps;

  await performWriteback(deps, { ...INPUT, project_id: "p1", tainted: true });
  const insert = seen.find((r) => String(r[0]).includes("INSERT INTO agent_memories"))!;
  assertEquals(JSON.parse(String(insert[insert.length - 1])).exposure, "personal");
});

Deno.test("SEAM: recall USES buildRecallScopeFilter, it does not restate it", async () => {
  const { deps, seen } = recallDeps([ROW]);
  await performRecall(deps, { workspace_id: "ws1", query: "anything" });
  const select = seen.find((s) => s.includes("FROM agent_memories am"))!;
  // The clauses the shared builder owns - the ones that are dangerous to forget.
  const expected = buildRecallScopeFilter({ workspace_id: "ws1" }, 2);
  assertEquals(select.includes(expected.sql), true, "recall must embed the shared filter verbatim");
  assertEquals(select.includes("lifecycle_status = 'active'"), true);
});

Deno.test("SEAM: a reviewed writeback is recalled by a default recall, end to end", async () => {
  // Compose the two live paths rather than two constants: build the row the writer would
  // insert, promote it the way the review door does, then assert the reader's own filter
  // admits it. Every discriminating column is carried across, exposure included - the
  // column the earlier version of this test could not see.
  const row = buildWritebackRow(INPUT, {}, { exposure: "ops" });
  assertEquals(
    isRowRecallableBy(
      {
        workspace_id: row.workspace_id,
        project_id: row.project_id,
        visibility: row.visibility,
        review_status: "confirmed",
        lifecycle_status: row.lifecycle_status,
        exposure: row.exposure as Exposure,
      },
      { workspace_id: row.workspace_id },
    ),
    true,
  );
});

Deno.test("recall writes a trace EVEN WHEN nothing matched", async () => {
  const { deps, seen } = recallDeps([]);
  const out = await performRecall(deps, { workspace_id: "ws1", query: "nothing here" });
  assertEquals(out.items.length, 0);
  assertEquals(seen.some((s) => s.includes("agent_memory_recall_traces")), true);
  // An empty recall is exactly what "the plane is silently empty" looks like from outside.
  // Without a trace there is nothing to notice it by.
});

Deno.test("recall returns the use-policy explicitly, never left to inference", async () => {
  const { deps } = recallDeps([ROW]);
  const out = await performRecall(deps, { workspace_id: "ws1", query: "q" });
  assertEquals(out.items[0].can_use_as_evidence, true);
  assertEquals(out.items[0].can_use_as_instruction, false);
  assertEquals(out.items[0].requires_user_confirmation, true);
});

Deno.test("recall parameterises the query embedding and every scope value", async () => {
  const { deps, params } = recallDeps([ROW]);
  await performRecall(deps, { workspace_id: "ws'; DROP TABLE agent_memories; --", query: "q" });
  const selectParams = params.find((p) => p.length > 1)!;
  assertEquals(String(selectParams[1]).includes("DROP TABLE"), true, "value is a PARAM…");
  const { seen } = recallDeps([ROW]);
  await performRecall(deps, { workspace_id: "ws1", query: "q" });
  assertEquals(seen.every((s) => !s.includes("DROP TABLE")), true, "…never in the SQL text");
});

Deno.test("recall limit is clamped, so one call cannot drain the corpus", async () => {
  const { deps, seen } = recallDeps([ROW]);
  await performRecall(deps, { workspace_id: "ws1", query: "q", limit: 9999 });
  const select = seen.find((s) => s.includes("FROM agent_memories am"))!;
  assertEquals(select.includes(`LIMIT ${RECALL_MAX_LIMIT}`), true);
});

Deno.test("a recall without a query is refused", async () => {
  const { deps } = recallDeps([ROW]);
  await assertRejects(() => performRecall(deps, { workspace_id: "ws1", query: "  " }));
});

Deno.test("a pool failure propagates rather than reporting success", async () => {
  const deps = {
    pool: { connect: () => Promise.reject(new Error("pool down")) },
    getEmbedding: () => Promise.resolve([0.1]),
    authed: () => true,
  } as unknown as AgentMemoryDeps;
  await assertRejects(() => performWriteback(deps, INPUT), Error, "pool down");
});
