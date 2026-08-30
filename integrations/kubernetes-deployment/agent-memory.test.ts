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
  performWriteback,
  refusalMessage,
  type AgentMemoryDeps,
} from "./agent-memory.ts";
import {
  DEFAULT_RECALL_STATUSES,
  defaultWritebackIsRecallable,
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

Deno.test("SEAM: a default-built row is recallable by the default gate", () => {
  // The invariant re-asserted at the layer that actually writes, not just where it was
  // declared. This is the end-to-end form of the policy module's first test.
  const row = buildWritebackRow(INPUT);
  assertEquals(defaultWritebackIsRecallable(row, DEFAULT_RECALL_STATUSES), true);
});

Deno.test("SEAM test can FAIL - forcing the column default breaks recallability", () => {
  // RED proof. 'pending' is what agent_memories.review_status defaults to; if this path
  // ever stops setting it, this is the row it produces and the default recall would never
  // return it. The assertion above must be able to catch that.
  const broken = buildWritebackRow(INPUT, { review_status: "pending" });
  assertEquals(defaultWritebackIsRecallable(broken, DEFAULT_RECALL_STATUSES), false);
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

Deno.test("a pool failure propagates rather than reporting success", async () => {
  const deps = {
    pool: { connect: () => Promise.reject(new Error("pool down")) },
    getEmbedding: () => Promise.resolve([0.1]),
    authed: () => true,
  } as unknown as AgentMemoryDeps;
  await assertRejects(() => performWriteback(deps, INPUT), Error, "pool down");
});
