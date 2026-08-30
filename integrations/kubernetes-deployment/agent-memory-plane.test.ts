/** Tests for the exposure-plane CHOKEPOINT, and - the point of this file - for its
 * COMPLETENESS.
 *
 * Run: deno test --allow-read agent-memory-plane.test.ts
 *
 * ------------------------------------------------------------------------------------
 * WHY A COMPLETENESS TEST AND NOT MORE UNIT TESTS
 * ------------------------------------------------------------------------------------
 * The personal-plane boundary has been closed three times, each time on the tools a
 * verifier happened to call, and each time a verifier walked through the next door:
 * recall was proved, then inspect/queue/recall_trace leaked; those were proved, then
 * `agent_memory_review` turned out to resolve a memory by id with no plane predicate and
 * `promote_exposure` could move a PERSONAL memory onto the ops plane, after which every
 * closed tool returned it legitimately.
 *
 * Unit tests cannot end that, because each round's tests were all green: they test the
 * statements that EXIST, and the defect is always a statement nobody wrote a test for.
 * So this file tests the SET of statements instead. It reads the source of every file in
 * the subsystem, finds every SQL reference to `agent_memories`, and requires each one to
 * be either inside the chokepoint or on an explicit allow-list with a written reason.
 *
 * A NEW UNGUARDED QUERY TURNS THIS RED. That is the property "the plane is contained"
 * actually needs, and it is the one no amount of per-tool patching gives you.
 *
 * It is the house pattern - two things that must agree, tested against each other:
 * harness.config.json's two readers, ScopeNode's columns vs models.py, the zod enum vs
 * the SQL CHECK, the anchor schema's three readers. Here the two things are the SOURCE
 * and the REGISTRY below.
 *
 * ------------------------------------------------------------------------------------
 * THE PERMISSION TRAP THIS FILE REFUSES TO REPEAT
 * ------------------------------------------------------------------------------------
 * `deno test` without `--allow-read` cannot read a sibling file. The existing
 * "memory_type enum matches the SQL CHECK exactly" test caught the resulting
 * NotCapable error in a `try/catch` and returned early, so it PASSED while comparing
 * nothing - and the repo's only runner (scripts/checks/test-quartz4-offline.ps1) did not
 * pass the flag. Verified 2026-08-30 by running it both ways. So every read below is
 * FAIL-CLOSED: an unreadable source file fails the test, it never skips it.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  auditRefusal,
  DEFAULT_DOOR_PLANE,
  doorPlane,
  listMemoriesOnPlane,
  listTraceItemsOnPlane,
  planePredicate,
  resolveIdempotentOnPlane,
  resolveMemoryOnPlane,
  updateMemoryOnPlane,
} from "./agent-memory-plane.ts";

// ════════════════════════════════════════════════════════════════════════════
// PART 1 - THE COMPLETENESS GATE
// ════════════════════════════════════════════════════════════════════════════

/** The chokepoint itself. Statements here ARE the guarded path. */
const CHOKEPOINT = "agent-memory-plane.ts";

/**
 * Every file in the subsystem that may talk to `agent_memories`.
 *
 * LISTED, and the list is itself checked below against what is on disk, because a file
 * list that has to be edited to stay true eventually stops being true - the same failure
 * the initdb chain and the deno test glob both paid for in this repo.
 */
const SCANNED = [
  "agent-memory.ts",
  "agent-memory-ops.ts",
  "agent-memory-tools.ts",
  "agent-memory-policy.ts",
  "agent-memory-review.ts",
  CHOKEPOINT,
];

/**
 * THE ALLOW-LIST. One entry per `agent_memories` statement that is NOT routed through the
 * chokepoint, with the reason it is safe. Short on purpose: a long allow-list is a
 * chokepoint that has stopped being one.
 *
 * `sql` must appear verbatim in the named file, comments stripped. `reason` is what a
 * reviewer reads instead of taking the exemption on trust.
 */
interface Exemption {
  file: string;
  sql: string;
  reason: string;
}

const EXEMPT: Exemption[] = [
  {
    file: "agent-memory.ts",
    sql: "INSERT INTO agent_memories (",
    reason:
      "The WRITE. Exposure is stamped by buildWritebackRow from the DOOR (stampExposure, " +
      "which has no widening path) and written into metadata.exposure - the column every " +
      "plane predicate reads. A write cannot disclose an existing row, so there is nothing " +
      "for a read predicate to bound; the invariant here is 'the stamp comes from the door', " +
      "and agent-memory-policy.test.ts owns it.",
  },
  {
    file: "agent-memory.ts",
    sql: "FROM agent_memories am\n         JOIN thoughts t ON t.id = am.thought_id",
    reason:
      "performRecall. Its plane predicate comes from buildRecallScopeFilter, whose exposure " +
      "list is forced by decideRecallExposure from deps.doorExposure and cannot be widened " +
      "by the caller. That is a SECOND chokepoint, older than this one and with its own " +
      "invariant tests (agent-memory-policy.test.ts) plus a live drill lane; folding it in " +
      "here would mean reimplementing the scope filter's lifecycle/review/visibility " +
      "clauses, which are the clauses that are dangerous to forget.",
  },
];

/** Strip line and block comments, so prose mentioning the table is not a finding. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

/**
 * Every SQL reference to the table, as (statement-ish) snippets.
 *
 * Matches the table name preceded by any of the SQL keywords that can introduce it.
 * Deliberately broad: `FROM`, `JOIN`, `UPDATE`, `INTO`, `DELETE FROM` and a bare
 * qualified reference all count, so a new statement cannot slip past by using a form
 * this test did not think of. If a future statement uses a shape not matched here, the
 * `NO KEYWORD` assertion below catches it: the count of keyword-matched occurrences must
 * equal the total count of the table name.
 */
function tableRefs(src: string): { total: number; matched: string[] } {
  const body = stripComments(src);
  const total = (body.match(/agent_memories/g) ?? []).length;
  const matched = [...body.matchAll(/(FROM|JOIN|UPDATE|INTO|TABLE)\s+agent_memories/g)]
    .map((m) => m[0]);
  return { total, matched };
}

async function readSource(name: string): Promise<string> {
  // FAIL-CLOSED. No try/catch: an unreadable file must fail this test, never skip it.
  // That is the exact bug the memory_type cross-reader test shipped with.
  return await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
}

Deno.test("the scanned list matches the files actually on disk", async () => {
  // The list above is one of the two things that must agree. This is the other one: a new
  // agent-memory-*.ts that nobody added to SCANNED would otherwise be invisible to every
  // assertion below, which is precisely how a new file becomes the next unguarded door.
  const dir = new URL("./", import.meta.url);
  const onDisk: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile) continue;
    if (!e.name.startsWith("agent-memory")) continue;
    if (e.name.endsWith(".test.ts")) continue;
    onDisk.push(e.name);
  }
  assertEquals(
    onDisk.sort(),
    [...SCANNED].sort(),
    "a subsystem source file is missing from SCANNED (or SCANNED names one that is gone)",
  );
});

Deno.test("EVERY agent_memories statement is in the chokepoint or on the allow-list", async () => {
  // THE TEST THIS FILE EXISTS FOR.
  const offenders: string[] = [];
  for (const file of SCANNED) {
    if (file === CHOKEPOINT) continue; // statements here ARE the guarded path
    const body = stripComments(await readSource(file));
    const refs = tableRefs(await readSource(file));
    // Remove each allow-listed statement's text, then require nothing to be left.
    let remaining = body;
    for (const ex of EXEMPT.filter((e) => e.file === file)) {
      const before = remaining;
      remaining = remaining.replace(ex.sql, "");
      if (remaining === before) {
        offenders.push(
          `${file}: allow-list entry no longer matches any statement - "${ex.sql.slice(0, 60)}..."`,
        );
      }
    }
    const left = tableRefs(remaining);
    if (left.total > 0) {
      offenders.push(
        `${file}: ${left.total} agent_memories reference(s) neither routed through ` +
          `${CHOKEPOINT} nor on the allow-list (${left.matched.join(", ") || "no SQL keyword"}). ` +
          `Route it through agent-memory-plane.ts, or add an EXEMPT entry with a reason.`,
      );
    }
    // Sanity on the matcher itself: every occurrence the file has must be one this test
    // can see as SQL. A statement in a shape the regex misses would otherwise be counted
    // in `total` and reported, which is the safe direction - assert it explicitly.
    if (refs.total > 0 && refs.matched.length === 0) {
      offenders.push(`${file}: has agent_memories but no recognised SQL keyword before it`);
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("ops and tools resolve NOTHING by hand - zero raw statements", async () => {
  // The two files the escalation lived in. Stated separately from the gate above so the
  // property is visible on its own: after the refactor they contain no SQL against this
  // table at all, exempt or otherwise.
  for (const file of ["agent-memory-ops.ts", "agent-memory-tools.ts"]) {
    const refs = tableRefs(await readSource(file));
    assertEquals(refs.total, 0, `${file} still names agent_memories in SQL`);
  }
});

Deno.test("every allow-list entry carries a real reason", async () => {
  // An exemption with an empty or throwaway reason is an exemption nobody reviewed. The
  // length floor is crude and deliberate: it is not possible to satisfy it by accident.
  for (const ex of EXEMPT) {
    assertEquals(SCANNED.includes(ex.file), true, `EXEMPT names an unscanned file: ${ex.file}`);
    assertEquals(ex.reason.length > 120, true, `EXEMPT reason too thin for ${ex.file}: ${ex.reason}`);
  }
  // And the allow-list stays SHORT. Growing it is how a chokepoint dissolves one
  // reasonable-looking exception at a time; raising this number should feel like a
  // decision, because it is one.
  assertEquals(EXEMPT.length <= 3, true, `the allow-list has grown to ${EXEMPT.length}`);
});

Deno.test("the completeness gate can actually fail", async () => {
  // RED-PROOF FOR THE GATE ITSELF. A check nobody has watched fail is not known to check
  // anything - and this whole round exists because eight such checks were found in a day.
  // Injects a new unguarded statement into a COPY of the source text and requires the same
  // matcher to report it.
  const ops = await readSource("agent-memory-ops.ts");
  const clean = tableRefs(ops);
  assertEquals(clean.total, 0, "precondition: ops.ts is currently clean");

  const sabotaged = ops +
    "\nasync function leak(c: PlaneClient) {\n" +
    "  return await c.queryObject(`SELECT content FROM agent_memories WHERE id = $1`, []);\n}\n";
  const dirty = tableRefs(sabotaged);
  assertEquals(dirty.total, 1, "the matcher did not see an injected raw statement");
  assertEquals(dirty.matched, ["FROM agent_memories"]);
});

Deno.test("a comment mentioning the table is NOT a finding", () => {
  // The other direction: the gate must not be so loud that maintainers route around it.
  const src = "// see agent_memories for the schema\n/* agent_memories again */\nconst x = 1;";
  assertEquals(tableRefs(src).total, 0);
});

Deno.test("the runner passes --allow-read, or this whole file proves nothing", async () => {
  // Guards the trap named in the header. `deno test` without --allow-read cannot read a
  // sibling file; a test that swallows that error passes while comparing nothing, which is
  // what the memory_type cross-reader test did. This assertion exists so the failure mode
  // is loud rather than silent.
  const self = await readSource(CHOKEPOINT);
  assertEquals(self.length > 1000, true, "could not read the chokepoint's own source");
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 - THE CHOKEPOINT'S OWN BEHAVIOUR
// ════════════════════════════════════════════════════════════════════════════

/**
 * A recorder that is BOTH the caller's connection and the pool behind it.
 *
 * One `seen` log for both, on purpose: the refusal audit runs on its own connection now
 * (so a caller's ROLLBACK cannot erase it - see PlaneCtx), and a test that watched only the
 * caller's connection would stop seeing the audit row and would go green for the wrong
 * reason. Everything that touches the database lands in one ordered list.
 */
function recorder(rows: (sql: string, args: unknown[]) => unknown[]) {
  const seen: [string, unknown[]][] = [];
  let released = 0;
  const client = {
    queryObject: (sql: string, args?: unknown[]) => {
      seen.push([sql, args ?? []]);
      return Promise.resolve({ rows: rows(sql, args ?? []) });
    },
  };
  const pool = {
    connect: () => Promise.resolve({ ...client, release: () => { released++; } }),
  };
  return { seen, client, pool, ctx: { client, pool }, releases: () => released };
}

Deno.test("doorPlane is the only constructor, and it defaults to ops", () => {
  assertEquals(doorPlane({ doorExposure: "ops" }).exposures, ["ops"]);
  assertEquals(doorPlane({ doorExposure: "personal" }).exposures, ["personal"]);
  // A missing door meaning "no filter" is how this hole reopens the next time a surface is
  // wired up. It means 'ops', the end of the axis with nothing personal on it.
  assertEquals(doorPlane({}).exposures, [...DEFAULT_DOOR_PLANE]);
  assertEquals(doorPlane(undefined).exposures, ["ops"]);
  assertEquals(doorPlane(null).exposures, ["ops"]);
});

Deno.test("the plane predicate is one string, used by every statement", () => {
  assertEquals(planePredicate(2), "COALESCE(metadata->>'exposure', 'personal') = ANY($2)");
  assertEquals(planePredicate(2, "am"), "COALESCE(am.metadata->>'exposure', 'personal') = ANY($2)");
});

Deno.test("resolveMemoryOnPlane binds the plane as a parameter, never inline", async () => {
  const r = recorder(() => [{ id: "m-1" }]);
  const out = await resolveMemoryOnPlane(r.ctx, doorPlane({ doorExposure: "ops" }), "m-1", {
    columns: "id",
    tool: "t",
  });
  assertEquals(out.ok, true);
  assertEquals(r.seen[0][0].includes("COALESCE(metadata->>'exposure'"), true);
  assertEquals(r.seen[0][1], ["m-1", ["ops"]]);
});

Deno.test("resolveMemoryOnPlane: FOR UPDATE only when asked", async () => {
  const a = recorder(() => [{ id: "m" }]);
  await resolveMemoryOnPlane(a.ctx, doorPlane({}), "m", { columns: "id", tool: "t" });
  assertEquals(a.seen[0][0].includes("FOR UPDATE"), false);
  const b = recorder(() => [{ id: "m" }]);
  await resolveMemoryOnPlane(b.ctx, doorPlane({}), "m", {
    columns: "id",
    tool: "t",
    forUpdate: true,
  });
  assertEquals(b.seen[0][0].includes("FOR UPDATE"), true);
});

Deno.test("an OFF-PLANE hit is not_found AND leaves an audit row naming the tool", async () => {
  const r = recorder((sql) => {
    if (sql.includes("COALESCE(metadata->>'exposure'")) return []; // off plane
    if (sql.includes("SELECT 1 FROM agent_memories")) return [{ "?column?": 1 }]; // exists
    return [];
  });
  const out = await resolveMemoryOnPlane(r.ctx, doorPlane({}), "m-1", {
    columns: "id",
    tool: "agent_memory_review",
  });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "not_found");
  const audit = r.seen.find(([s]) => s.includes("access_refused"));
  assertEquals(Boolean(audit), true, "a refused access must leave an audit row (U5)");
  assertEquals(JSON.parse(String((audit![1] as unknown[])[1])).tool, "agent_memory_review");
});

Deno.test("a genuinely ABSENT memory writes no audit row", async () => {
  const r = recorder(() => []);
  await resolveMemoryOnPlane(r.ctx, doorPlane({}), "nope", { columns: "id", tool: "t" });
  assertEquals(r.seen.some(([s]) => s.includes("access_refused")), false);
});

Deno.test("the audit row cannot turn a refusal into an error", async () => {
  // A throw here would leak that the row exists via a different status code.
  const client = {
    queryObject: (sql: string) => {
      if (sql.includes("access_refused")) return Promise.reject(new Error("db down"));
      if (sql.includes("SELECT 1 FROM agent_memories")) {
        return Promise.resolve({ rows: [{ x: 1 }] as unknown[] });
      }
      return Promise.resolve({ rows: [] as unknown[] });
    },
  };
  const pool = { connect: () => Promise.resolve({ ...client, release: () => {} }) };
  const out = await resolveMemoryOnPlane({ client, pool }, doorPlane({}), "m-1", {
    columns: "id",
    tool: "t",
  });
  assertEquals(out.ok, false);
  await auditRefusal(pool, "m-1", "t", "off-plane"); // must not throw
});

Deno.test("a failing POOL cannot turn a refusal into an error either", async () => {
  // The audit's own connection is the new failure surface, so it gets its own case.
  const client = {
    queryObject: (sql: string) => {
      if (sql.includes("SELECT 1 FROM agent_memories")) {
        return Promise.resolve({ rows: [{ x: 1 }] as unknown[] });
      }
      return Promise.resolve({ rows: [] as unknown[] });
    },
  };
  const pool = { connect: () => Promise.reject(new Error("pool exhausted")) };
  const out = await resolveMemoryOnPlane(
    { client, pool } as unknown as Parameters<typeof resolveMemoryOnPlane>[0],
    doorPlane({}),
    "m-1",
    { columns: "id", tool: "t" },
  );
  assertEquals(out.ok, false);
});

Deno.test("the refusal audit takes its OWN connection and releases it", async () => {
  // THE DEFECT THE LIVE DRILL FOUND, as a unit test. performReview runs inside a
  // transaction and answers a refusal with ROLLBACK; when the audit row was written on the
  // caller's connection, the caller's own error path erased it, and ATTACK 8 reported
  // "stopped, but invisible" with an access_refused count of 0.
  const r = recorder((sql) => {
    if (sql.includes("COALESCE(metadata->>'exposure'")) return [];
    if (sql.includes("SELECT 1 FROM agent_memories")) return [{ x: 1 }];
    return [];
  });
  await resolveMemoryOnPlane(r.ctx, doorPlane({}), "m-1", { columns: "id", tool: "t" });
  assertEquals(r.seen.some(([s2]) => s2.includes("access_refused")), true);
  assertEquals(r.releases(), 1, "the audit connection must be returned to the pool");
});

Deno.test("updateMemoryOnPlane puts the plane in the WHERE, after the caller's args", async () => {
  const r = recorder(() => [{ id: "m-1" }]);
  await updateMemoryOnPlane(
    r.client,
    doorPlane({ doorExposure: "ops" }),
    ["updated_at = now()", "review_status = $2"],
    ["m-1", "confirmed"],
    "id",
  );
  const [sql, args] = r.seen[0];
  assertEquals(sql.startsWith("UPDATE agent_memories"), true);
  assertEquals(sql.includes("WHERE id = $1 AND COALESCE(metadata->>'exposure', 'personal') = ANY($3)"), true);
  assertEquals(args, ["m-1", "confirmed", ["ops"]]);
});

Deno.test("listMemoriesOnPlane starts the WHERE with the plane, before anything else", async () => {
  const r = recorder(() => [{ id: "m-1" }]);
  await listMemoriesOnPlane(r.client, doorPlane({ doorExposure: "ops" }), {
    columns: "id",
    orderBy: "created_at ASC",
    limit: 50,
    build: (q) => {
      q.and(`review_status = ANY(${q.param(["pending"])})`);
      q.and(`workspace_id = ${q.param("ws-1")}`);
    },
  });
  const [sql, args] = r.seen[0];
  assertEquals(
    sql.includes("WHERE COALESCE(metadata->>'exposure', 'personal') = ANY($1)"),
    true,
    "the plane must be the FIRST clause - there is no arrangement of build() that removes it",
  );
  assertEquals(args, [["ops"], ["pending"], "ws-1", 50]);
});

Deno.test("listMemoriesOnPlane with no extra predicates is still plane-bounded", async () => {
  const r = recorder(() => []);
  await listMemoriesOnPlane(r.client, doorPlane({}), {
    columns: "id",
    orderBy: "created_at ASC",
    limit: 10,
  });
  assertEquals(r.seen[0][0].includes("COALESCE(metadata->>'exposure'"), true);
  assertEquals(r.seen[0][1], [["ops"], 10]);
});

Deno.test("listTraceItemsOnPlane DROPS an off-plane item, id and all", async () => {
  const rows = [
    { memory_id: "m-0", rank: 1, similarity: 0.9, use_policy_snapshot: {}, summary: "v", review_status: "pending", on_plane: true },
    { memory_id: "m-1", rank: 2, similarity: 0.8, use_policy_snapshot: {}, summary: null, review_status: null, on_plane: false },
  ];
  const r = recorder((sql) => (sql.includes("agent_memory_recall_items") ? rows : []));
  const visible = await listTraceItemsOnPlane(r.ctx, doorPlane({}), "t-1", "agent_memory_recall_trace");
  assertEquals(visible.length, 1);
  assertEquals(visible.map((v) => v.memory_id), ["m-0"]);
  assertEquals(Object.hasOwn(visible[0], "on_plane"), false, "on_plane must never reach a caller");
  const audit = r.seen.find(([s]) => s.includes("access_refused"));
  assertEquals((audit![1] as unknown[])[0], "m-1");
});

Deno.test("resolveIdempotentOnPlane refuses an off-plane key WITHOUT naming the memory", async () => {
  // The id oracle the completeness gate found in the WRITE path. The refusal says the key
  // is taken - which the unique index would say anyway - and nothing else.
  const r = recorder((sql) => {
    if (sql.includes("COALESCE(metadata->>'exposure'")) return []; // not on this plane
    if (sql.includes("SELECT 1 FROM agent_memories")) return [{ x: 1 }]; // but the key is taken
    return [];
  });
  const out = await resolveIdempotentOnPlane(r.ctx, doorPlane({ doorExposure: "ops" }), "ws", "k", {
    columns: "id, thought_id",
    tool: "agent_memory_writeback",
  });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "off_plane");
  const audit = r.seen.find(([s]) => s.includes("access_refused"))!;
  assertEquals((audit[1] as unknown[])[0], null, "the audit row must not carry the off-plane id");
  assertEquals(JSON.parse(String((audit[1] as unknown[])[1])).reason, "off-plane-idempotency-key");
});

Deno.test("resolveIdempotentOnPlane returns an ON-plane hit unchanged", async () => {
  const r = recorder((sql) =>
    sql.includes("COALESCE(metadata->>'exposure'") ? [{ id: "m-1", thought_id: 7 }] : []
  );
  const out = await resolveIdempotentOnPlane<{ id: string; thought_id: number }>(
    r.ctx,
    doorPlane({ doorExposure: "ops" }),
    "ws",
    "k",
    { columns: "id, thought_id", tool: "agent_memory_writeback" },
  );
  assertEquals(out.ok, true);
  if (out.ok) assertEquals(out.row?.id, "m-1");
  assertEquals(r.seen.some(([s]) => s.includes("access_refused")), false);
});

Deno.test("a free key is neither a hit nor a refusal", async () => {
  const r = recorder(() => []);
  const out = await resolveIdempotentOnPlane(r.ctx, doorPlane({}), "ws", "k", {
    columns: "id",
    tool: "agent_memory_writeback",
  });
  assertEquals(out.ok, true);
  if (out.ok) assertEquals(out.row, undefined);
  assertEquals(r.seen.some(([s]) => s.includes("access_refused")), false);
});
