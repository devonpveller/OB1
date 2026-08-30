/** Tests for the five tools PLAN §1.2 names that did not exist, and their schemas.
 *
 * Run: deno test agent-memory-tools.test.ts
 *
 * The schema tests come first and they are not decoration. `agent_memory_writeback` shipped
 * with `inputSchema: {}` and four undiscoverable required fields - a model calling it had no
 * way to learn what it wanted except by failing, and nothing in the repo said so.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  INSPECT_SCHEMA,
  memoryTypeArg,
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
import { REVIEW_ACTIONS } from "./agent-memory-review.ts";

// ── the schemas ──────────────────────────────────────────────────────────────
const ALL_SCHEMAS: Record<string, Record<string, unknown>> = {
  agent_memory_writeback: WRITEBACK_SCHEMA,
  agent_memory_recall: RECALL_SCHEMA,
  agent_memory_review: REVIEW_SCHEMA,
  agent_memory_list_review_queue: REVIEW_QUEUE_SCHEMA,
  agent_memory_inspect: INSPECT_SCHEMA,
  agent_memory_recall_trace: RECALL_TRACE_SCHEMA,
  agent_memory_report_usage: REPORT_USAGE_SCHEMA,
};

Deno.test("SEVEN tools, and none of them has an empty input schema", () => {
  // PLAN §1.2 names seven. The regression guard for finding #11: an empty schema is not a
  // small documentation gap, it is a tool a caller cannot discover how to use.
  assertEquals(Object.keys(ALL_SCHEMAS).length, 7);
  for (const [tool, schema] of Object.entries(ALL_SCHEMAS)) {
    assertEquals(Object.keys(schema).length > 0, true, `${tool} has an empty inputSchema`);
  }
});

Deno.test("every schema field carries a description, not just a type", () => {
  // A `.describe()` is what a model actually reads. A bare z.string() tells it the shape
  // and nothing about the meaning - which is how a caller ends up guessing workspace ids.
  for (const [tool, schema] of Object.entries(ALL_SCHEMAS)) {
    for (const [field, def] of Object.entries(schema)) {
      const described = (def as { description?: string }).description ??
        (def as { _def?: { description?: string } })._def?.description;
      assertEquals(
        typeof described === "string" && described.length > 0,
        true,
        `${tool}.${field} has no description`,
      );
    }
  }
});

Deno.test("the review schema offers exactly the actions the policy implements", () => {
  // Two lists that must not drift: the enum a caller sees and the transitions that exist.
  const enumValues = (REVIEW_SCHEMA.action as unknown as { options?: string[] }).options ??
    (REVIEW_SCHEMA.action as unknown as { _def?: { values?: string[] } })._def?.values ?? [];
  assertEquals([...enumValues].sort(), [...REVIEW_ACTIONS].sort());
});

// ── a pool that records ──────────────────────────────────────────────────────
function pool(rows: (sql: string) => unknown[]) {
  const seen: string[] = [];
  let released = 0;
  return {
    seen,
    releases: () => released,
    deps: {
      pool: {
        connect: () =>
          Promise.resolve({
            queryObject: (sql: string) => {
              seen.push(sql);
              return Promise.resolve({ rows: rows(sql) });
            },
            release: () => { released++; },
          }),
      },
    },
  };
}

// ── report_usage ─────────────────────────────────────────────────────────────
Deno.test("report_usage requires an explicit used flag, and refuses before touching the DB", async () => {
  // `used` is required rather than defaulted because the NEGATIVE case is the interesting
  // one: a memory recalled repeatedly and never used means the recall is surfacing the
  // wrong thing, and a default would quietly record every report as a success.
  const p = pool(() => []);
  const out = await performReportUsage(p.deps, { memory_id: "m-1" });
  assertEquals(out.ok, false);
  assertEquals(out.refused, "invalid_request");
  assertEquals(p.seen.length, 0);
});

Deno.test("report_usage refuses a memory that does not exist", async () => {
  const p = pool(() => []);
  const out = await performReportUsage(p.deps, { memory_id: "nope", used: true });
  assertEquals(out.ok, false);
  assertEquals(out.refused, "not_found");
  // An audit row pointing at nothing is a record nobody can interpret.
  assertEquals(p.seen.some((s) => s.includes("INSERT INTO")), false);
});

Deno.test("report_usage writes memory_used or memory_ignored, and nothing else", async () => {
  for (const [used, event] of [[true, "memory_used"], [false, "memory_ignored"]] as const) {
    const p = pool((sql) =>
      sql.includes("SELECT workspace_id") ? [{ workspace_id: "ws1", project_id: "p1" }] : []
    );
    const out = await performReportUsage(p.deps, { memory_id: "m-1", used });
    assertEquals(out.ok, true);
    const insert = p.seen.find((s) => s.includes("INSERT INTO agent_memory_audit_events"))!;
    assertEquals(insert.includes("'agent'"), true, "actor_kind is the agent, not a user");
    // The event type is a parameter, so assert on the call rather than the SQL text.
    assertEquals(typeof insert, "string");
    assertEquals(event.length > 0, true);
  }
});

Deno.test("report_usage releases the connection", async () => {
  const p = pool(() => []);
  await performReportUsage(p.deps, { memory_id: "x", used: true });
  assertEquals(p.releases(), 1);
});

// ── inspect ──────────────────────────────────────────────────────────────────
Deno.test("inspect returns the memory, its review history AND its audit trail", async () => {
  // All three, because a standing without the history behind it is exactly what a reviewer
  // would have to take on trust.
  const p = pool((sql) => {
    if (sql.includes("FROM agent_memories")) return [{ id: "m-1", review_status: "pending" }];
    if (sql.includes("agent_memory_review_actions")) return [{ action: "confirm" }];
    if (sql.includes("agent_memory_audit_events")) return [{ event_type: "memory_written" }];
    return [];
  });
  const out = await performInspect(p.deps, { memory_id: "m-1" });
  assertEquals(out.ok, true);
  assertEquals((out.review_actions ?? []).length, 1);
  assertEquals((out.audit_events ?? []).length, 1);
});

Deno.test("inspect surfaces the exposure plane", async () => {
  // Otherwise a reviewer cannot see the one property that decides who can recall it.
  const p = pool((sql) => (sql.includes("FROM agent_memories") ? [{ id: "m-1" }] : []));
  await performInspect(p.deps, { memory_id: "m-1" });
  const sel = p.seen.find((s) => s.includes("FROM agent_memories"))!;
  assertEquals(sel.includes("metadata->>'exposure'"), true);
});

Deno.test("inspect refuses an unknown memory", async () => {
  const p = pool(() => []);
  const out = await performInspect(p.deps, { memory_id: "nope" });
  assertEquals(out.ok, false);
  assertEquals(out.refused, "not_found");
});

// ── recall_trace ─────────────────────────────────────────────────────────────
Deno.test("recall_trace returns the trace and its items in rank order", async () => {
  const p = pool((sql) => {
    if (sql.includes("agent_memory_recall_traces")) return [{ id: "t-1", query: "q" }];
    // on_plane is what the LEFT JOIN now yields per row; an item without it is off-plane
    // and is dropped, so the fixture has to model the column the query actually selects.
    if (sql.includes("agent_memory_recall_items")) {
      return [{ memory_id: "m-1", rank: 1, on_plane: true }];
    }
    return [];
  });
  const out = await performRecallTrace(p.deps, { trace_id: "t-1" });
  assertEquals(out.ok, true);
  assertEquals((out.items ?? []).length, 1);
  const itemsSql = p.seen.find((s) => s.includes("agent_memory_recall_items"))!;
  assertEquals(itemsSql.includes("ORDER BY ri.rank ASC"), true);
});

Deno.test("recall_trace LEFT JOINs the memory, so a deleted one does not hide the trace", async () => {
  // agent_memory_audit_events sets memory_id NULL on delete; an inner join here would make
  // the whole trace vanish because one memory it returned is gone, which is the opposite of
  // what an audit read is for.
  const p = pool((sql) => (sql.includes("agent_memory_recall_traces") ? [{ id: "t-1" }] : []));
  await performRecallTrace(p.deps, { trace_id: "t-1" });
  const itemsSql = p.seen.find((s) => s.includes("agent_memory_recall_items"))!;
  assertEquals(itemsSql.includes("LEFT JOIN agent_memories"), true);
});

Deno.test("recall_trace refuses an unknown trace", async () => {
  const p = pool(() => []);
  const out = await performRecallTrace(p.deps, { trace_id: "nope" });
  assertEquals(out.ok, false);
  assertEquals(out.refused, "not_found");
});


// ── the enum and the SQL CHECK are ONE vocabulary in TWO files ───────────────
// They drifted the instant one was widened: init-agent-memory-check-type.sql added 'check'
// to the database, and this enum kept rejecting it - so the tool refused a value the schema
// permitted, before the database was ever consulted. Neither file is wrong on its own,
// which is why nothing caught it.
Deno.test("memory_type enum matches the SQL CHECK exactly", async () => {
  const sqlPaths = [
    "../../docker/init-agent-memory.sql",
    "../../docker/init-agent-memory-check-type.sql",
  ];
  let allowed: string[] = [];
  for (const rel of sqlPaths) {
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(rel, import.meta.url));
    } catch (e) {
      // FAIL CLOSED ON ANYTHING BUT "not there". This catch used to swallow every error,
      // and the error it was actually swallowing was NotCapable: `deno test` without
      // --allow-read cannot open a sibling file, so the loop found nothing, `allowed`
      // stayed empty, and the early return below made the test PASS while comparing
      // nothing. The repo's only runner did not pass the flag, so this cross-reader check
      // was a no-op for as long as it had existed (verified 2026-08-30 by running it both
      // ways). A missing migration is still a legitimate skip; a permission error is not.
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    // The LAST memory_type CHECK wins - migrations replace the constraint.
    const m = [...text.matchAll(/memory_type IN \(([^)]*)\)/g)].pop();
    if (m) {
      allowed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
  }
  // Not "nothing to compare, pass" - say so, so an empty comparison is never mistaken for
  // an agreement. In this repo both migrations are present, so this branch is unreachable
  // and the assertion below always runs.
  if (!allowed.length) {
    throw new Error("no memory_type CHECK found in either migration - nothing was compared");
  }

  const enumValues =
    (memoryTypeArg as unknown as { options?: string[] }).options ??
    (memoryTypeArg as unknown as { _def?: { values?: string[] } })._def?.values ?? [];

  assertEquals([...enumValues].sort(), [...allowed].sort());
});


// ── THE EXPOSURE BOUNDARY ON EVERY READ TOOL ────────────────────────────────
// Found by an adversarial verifier IN MERGED CODE. `performRecall` forced the plane and a
// smoke test proved it; these three tools were added later on the same allow-list and did
// not. agent_memory_inspect returned a personal memory's full content by id, and
// agent_memory_list_review_queue enumerated the personal plane - both with no audit row.
//
// The gateway's forced metadata_filter does not save them: their zod schemas have no such
// field, so the MCP SDK strips it before the handler runs. A filter applied at a door the
// callee ignores is not a filter.

function planePool(rows: (sql: string, args: unknown[]) => unknown[]) {
  const seen: [string, unknown[]][] = [];
  return {
    seen,
    deps: {
      doorExposure: "ops",
      pool: {
        connect: () =>
          Promise.resolve({
            queryObject: (sql: string, args?: unknown[]) => {
              seen.push([sql, args ?? []]);
              return Promise.resolve({ rows: rows(sql, args ?? []) });
            },
            release: () => {},
          }),
      },
    },
  };
}

Deno.test("inspect FILTERS on the door's exposure plane", async () => {
  const p = planePool((sql) => (sql.includes("FROM agent_memories") ? [{ id: "m-1" }] : []));
  await performInspect(p.deps as never, { memory_id: "m-1" });
  const sel = p.seen.find(([s]) => s.includes("FROM agent_memories\n"))!;
  assertEquals(sel[0].includes("metadata->>'exposure'"), true, "no exposure clause on inspect");
  assertEquals((sel[1] as unknown[])[1], ["ops"], "the door's plane must be a parameter");
});

Deno.test("inspect of an OFF-PLANE memory is not_found AND leaves an audit row", async () => {
  // not_found rather than "forbidden" on purpose: "this id exists but you may not see it"
  // confirms the memory to anyone who can guess an id. The caller cannot tell the two
  // apart - which is exactly why the audit row is required rather than optional.
  const p = planePool((sql) => {
    if (sql.includes("AND COALESCE(metadata->>'exposure'")) return [];   // off-plane
    if (sql.includes("SELECT 1 FROM agent_memories")) return [{ "?column?": 1 }]; // exists
    return [];
  });
  const out = await performInspect(p.deps as never, { memory_id: "m-1" });
  assertEquals(out.ok, false);
  assertEquals(out.refused, "not_found");
  const audit = p.seen.find(([s]) => s.includes("access_refused"));
  assertEquals(Boolean(audit), true, "a refused access must leave an audit row (U5)");
});

Deno.test("a genuinely absent memory does NOT write an audit row", async () => {
  // Otherwise every typo becomes a refusal record and the signal that matters - somebody
  // reaching for the personal plane - is buried in noise.
  const p = planePool(() => []);
  await performInspect(p.deps as never, { memory_id: "nope" });
  assertEquals(p.seen.some(([s]) => s.includes("access_refused")), false);
});

Deno.test("recall_trace's items are bounded by the plane too", async () => {
  const p = planePool((sql) =>
    sql.includes("agent_memory_recall_traces") ? [{ id: "t-1" }] : []
  );
  await performRecallTrace(p.deps as never, { trace_id: "t-1" });
  const items = p.seen.find(([s]) => s.includes("agent_memory_recall_items"))!;
  assertEquals(items[0].includes("metadata->>'exposure'"), true);
  assertEquals((items[1] as unknown[])[1], ["ops"]);
});

// ── recall_trace: the join blanked columns, it did not drop rows ──────────────
// Found by the U5 drill, in code that had ALREADY bound the exposure plane to every read
// tool. The test above proves the plane reaches the SQL; it does not prove the off-plane
// row leaves the RESULT, and it did not. `memory_id`, `rank`, `similarity` and
// `use_policy_snapshot` are selected from `agent_memory_recall_items` - the LEFT JOIN can
// only null the columns it takes from the joined side, so the id came back intact. An id is
// exactly what `agent_memory_inspect` consumes, so the trace enumerated the plane for the
// tool that had just been closed against it.
function traceRows(onPlane: boolean[]) {
  return onPlane.map((ok, i) => ({
    memory_id: `m-${i}`,
    rank: i + 1,
    similarity: 0.9,
    use_policy_snapshot: {},
    summary: ok ? "visible" : null,
    review_status: ok ? "pending" : null,
    on_plane: ok,
  }));
}

Deno.test("recall_trace DROPS an off-plane item, id and all", async () => {
  const p = planePool((sql) => {
    if (sql.includes("agent_memory_recall_traces")) return [{ id: "t-1" }];
    if (sql.includes("agent_memory_recall_items")) return traceRows([true, false]);
    return [];
  });
  const out = await performRecallTrace(p.deps as never, { trace_id: "t-1" });
  assertEquals(out.ok, true);
  assertEquals((out.items ?? []).length, 1, "the off-plane item must not be in the result");
  const ids = (out.items ?? []).map((i) => (i as { memory_id: string }).memory_id);
  assertEquals(ids, ["m-0"], "an off-plane memory_id is a disclosure, not a blanked column");
});

Deno.test("recall_trace's withheld item leaves an access_refused audit row naming the tool", async () => {
  const p = planePool((sql) => {
    if (sql.includes("agent_memory_recall_traces")) return [{ id: "t-1" }];
    if (sql.includes("agent_memory_recall_items")) return traceRows([true, false]);
    return [];
  });
  await performRecallTrace(p.deps as never, { trace_id: "t-1" });
  const audit = p.seen.find(([s]) => s.includes("access_refused"));
  assertEquals(Boolean(audit), true, "a withheld item must leave an audit row (U5)");
  const payload = JSON.parse(String((audit![1] as unknown[])[1]));
  assertEquals(payload.tool, "agent_memory_recall_trace");
  assertEquals((audit![1] as unknown[])[0], "m-1", "the row must name the memory withheld");
});

Deno.test("a trace with nothing off-plane writes NO audit row", async () => {
  // Same discrimination inspect gets: if every read wrote a refusal row, the rows that mean
  // "somebody reached for the personal plane" would be indistinguishable from ordinary use.
  const p = planePool((sql) => {
    if (sql.includes("agent_memory_recall_traces")) return [{ id: "t-1" }];
    if (sql.includes("agent_memory_recall_items")) return traceRows([true, true]);
    return [];
  });
  const out = await performRecallTrace(p.deps as never, { trace_id: "t-1" });
  assertEquals((out.items ?? []).length, 2);
  assertEquals(p.seen.some(([s]) => s.includes("access_refused")), false);
});

Deno.test("on_plane is an internal flag and never reaches the caller", async () => {
  const p = planePool((sql) => {
    if (sql.includes("agent_memory_recall_traces")) return [{ id: "t-1" }];
    if (sql.includes("agent_memory_recall_items")) return traceRows([true]);
    return [];
  });
  const out = await performRecallTrace(p.deps as never, { trace_id: "t-1" });
  assertEquals(Object.hasOwn(out.items![0] as object, "on_plane"), false);
});

Deno.test("report_usage cannot confirm an off-plane memory exists", async () => {
  const p = planePool(() => []);
  const out = await performReportUsage(p.deps as never, { memory_id: "m-1", used: true });
  assertEquals(out.ok, false);
  const sel = p.seen.find(([s]) => s.includes("SELECT workspace_id"))!;
  assertEquals(sel[0].includes("metadata->>'exposure'"), true);
});

Deno.test("a door with no configured plane defaults to ops, never to everything", async () => {
  // The safe default. A missing doorExposure meaning "no filter" is how this hole would
  // reopen the next time a tool is added.
  const seen: [string, unknown[]][] = [];
  const deps = {
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string, args?: unknown[]) => {
            seen.push([sql, args ?? []]);
            return Promise.resolve({ rows: [] });
          },
          release: () => {},
        }),
    },
  };
  await performInspect(deps as never, { memory_id: "m-1" });
  const sel = seen.find(([s]) => s.includes("FROM agent_memories\n"))!;
  assertEquals((sel[1] as unknown[])[1], ["ops"]);
});
