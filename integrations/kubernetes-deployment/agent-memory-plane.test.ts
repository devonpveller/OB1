/** Tests for the exposure-plane CHOKEPOINT, and - the point of this file - for its
 * COMPLETENESS.
 *
 * Run: deno test --allow-read agent-memory-plane.test.ts
 *
 * ------------------------------------------------------------------------------------
 * WHY A COMPLETENESS TEST AND NOT MORE UNIT TESTS
 * ------------------------------------------------------------------------------------
 * The personal-plane boundary has been closed four times, each time on the tools a
 * verifier happened to call, and each time a verifier walked through the next door:
 * recall was proved, then inspect/queue/recall_trace leaked; those were proved, then
 * `agent_memory_review` resolved a memory by id with no plane predicate and
 * `promote_exposure` moved a PERSONAL memory onto the ops plane; that was closed, and then
 * the memory turned out to have a SECOND HOME - `performWriteback` mirrored its full
 * content into `thoughts`, which six unguarded statements in index.ts read.
 *
 * Unit tests cannot end that, because each round's tests were all green: they test the
 * statements that EXIST, and the defect is always a statement nobody wrote a test for.
 *
 * ------------------------------------------------------------------------------------
 * AND THE FIRST VERSION OF THIS GATE WAS VACUOUS IN EXACTLY THE WAY IT WARNED ABOUT
 * ------------------------------------------------------------------------------------
 * It scanned a HAND-WRITTEN six-entry list of files. A verifier put an unguarded
 * `SELECT id, summary, content, metadata FROM agent_memories WHERE id = $1` in a new file
 * called `memory-lookup.ts`, imported it into a SCANNED file, called it from a new
 * exported function - and got `deno check` exit 0 and 154 passed | 0 failed, byte-identical
 * to baseline. Renaming the same file `agent-memory-lookup.ts` went red. The gate caught a
 * new door named after the subsystem and missed an identical one named anything else,
 * because the "scanned list matches disk" test cross-checked the list against
 * `name.startsWith("agent-memory")` in one directory. That is not a scan of the code; it is
 * a list with a spell-checker. `Dockerfile:19` is `COPY *.ts ./`, so the file shipped.
 *
 * It also had a ONE-WORD VOCABULARY: it looked for `agent_memories` and nothing else, so
 * unguarded reads of `agent_memory_recall_traces` and `agent_memory_recall_items` injected
 * into a scanned file left it green. One of those was real - `performRecallTrace` read the
 * trace envelope, carrying the recall's query text, with no plane predicate at all.
 *
 * ------------------------------------------------------------------------------------
 * SO EVERYTHING THIS GATE ENUMERATES IS NOW DERIVED FROM THE CODE
 * ------------------------------------------------------------------------------------
 *   THE FILES  - every `.ts` in this directory that is not a `.test.ts`, read from disk.
 *                That is exactly what the image contains: `COPY *.ts ./` then
 *                `rm -f *.test.ts`. A test below reads the Dockerfile and asserts those
 *                two lines still say that, so the derivation cannot quietly stop matching
 *                what ships.
 *   THE TABLES - every `agent_memor*` table CREATEd by `../../docker/init-agent-memory*.sql`.
 *                Eight of them today. A ninth arrives already in scope.
 *
 * Neither is a list anyone maintains, so neither can go stale. A new unguarded resolver
 * goes RED wherever it lives, whatever it is named, whichever memory table it touches and
 * whichever verb it uses - four properties, each with its own red-proof below that injects
 * the offending statement into a synthetic source map and requires the same audit function
 * to report it.
 *
 * ------------------------------------------------------------------------------------
 * THE SECOND HOME, AND WHY THE CORPUS RULE LOOKS DIFFERENT
 * ------------------------------------------------------------------------------------
 * `thoughts` gets the opposite treatment, and deliberately. It is the SHARED CORPUS: this
 * server's general tools read it, and so do extensions-server, open-brain-rest,
 * agent-memory-api, the `match_thoughts` SQL function and a wholesale PostgREST
 * projection. Guarding its readers is not the slow option, it is an unavailable one - a
 * REST projection of a table has nowhere to put a predicate.
 *
 * So the rule for `thoughts` is about WHAT ENTERS IT, not who reads it: no plane-aware
 * file may write the corpus by hand. "Plane-aware" is derived too - a shipping file that
 * names a memory table in SQL or imports the chokepoint. index.ts is neither (it has zero
 * memory-table statements and does not import this module), so its three ordinary
 * capture/idea inserts stay out of scope, and the moment it learns about memories they
 * come into scope.
 *
 * ------------------------------------------------------------------------------------
 * THE PERMISSION TRAP THIS FILE REFUSES TO REPEAT
 * ------------------------------------------------------------------------------------
 * `deno test` without `--allow-read` cannot read a sibling file. The existing
 * "memory_type enum matches the SQL CHECK exactly" test caught the resulting
 * NotCapable error in a `try/catch` and returned early, so it PASSED while comparing
 * nothing - and the repo's only runner (scripts/checks/test-quartz4-offline.ps1) did not
 * pass the flag. Verified 2026-08-30 by running it both ways. So every read below is
 * FAIL-CLOSED: an unreadable source file fails the test, it never skips it, and an
 * enumeration that comes back EMPTY throws rather than passing over nothing.
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  auditRefusal,
  DEFAULT_DOOR_PLANE,
  doorPlane,
  listMemoriesOnPlane,
  listSidecarOnPlane,
  listTraceItemsOnPlane,
  mirrorsToUnifiedSearch,
  mirrorToUnifiedSearch,
  planePredicate,
  resolveIdempotentOnPlane,
  resolveMemoryOnPlane,
  resolveTraceOnPlane,
  tracePlanePredicate,
  UNIFIED_SEARCH_EXPOSURES,
  updateMemoryOnPlane,
} from "./agent-memory-plane.ts";

// ════════════════════════════════════════════════════════════════════════════
// PART 1 - THE COMPLETENESS GATE, DERIVED FROM THE CODE
// ════════════════════════════════════════════════════════════════════════════

/** The chokepoint itself. Statements here ARE the guarded path. */
const CHOKEPOINT = "agent-memory-plane.ts";

/** The shared corpus. Not a memory table - see the header for why its rule is inverted. */
const CORPUS = "thoughts";

const HERE = new URL("./", import.meta.url);
const SQL_DIR = new URL("../../docker/", import.meta.url);

/** FAIL-CLOSED. No try/catch: an unreadable file must fail a test, never skip it. */
async function readSource(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`./${name}`, HERE));
}

/**
 * Every `.ts` that ships in the image.
 *
 * DERIVED FROM DISK, which is the whole correction this round is about. The Dockerfile
 * globs `COPY *.ts ./` and then deletes `*.test.ts`; this reproduces that rule instead of
 * restating a list of names, so a file called anything at all is in scope from the moment
 * it exists.
 */
async function shippingFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(HERE)) {
    if (!e.isFile) continue;
    if (!e.name.endsWith(".ts")) continue;
    if (e.name.endsWith(".test.ts")) continue;
    out.push(e.name);
  }
  if (out.length === 0) {
    throw new Error("no shipping .ts files found - every assertion below would be vacuous");
  }
  return out.sort();
}

/** The shipping set as {name -> source}, which is what the audit function consumes. */
async function shippingSources(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of await shippingFiles()) m.set(f, await readSource(f));
  return m;
}

/**
 * Every table that holds or references memory content, DERIVED FROM THE SQL THAT CREATES
 * IT.
 *
 * The previous gate knew one table name because someone typed one table name. Eight exist:
 * agent_memories, and the source_refs / artifacts / relations / review_actions /
 * recall_traces / recall_items / audit_events sidecars. A recall trace carries the query
 * text; a recall item carries a memory id, a rank and a use-policy snapshot. Both were
 * outside the gate's vocabulary, and one of them was genuinely unguarded.
 */
async function memoryTables(): Promise<string[]> {
  const names = new Set<string>();
  let filesRead = 0;
  for await (const e of Deno.readDir(SQL_DIR)) {
    if (!e.isFile) continue;
    if (!e.name.startsWith("init-agent-memory")) continue;
    if (!e.name.endsWith(".sql")) continue;
    filesRead++;
    const sql = await Deno.readTextFile(new URL(e.name, SQL_DIR));
    for (
      const m of sql.matchAll(
        /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?(agent_memor[a-z_]+)/gi,
      )
    ) {
      names.add(m[1].toLowerCase());
    }
  }
  // FAIL-CLOSED on the enumeration itself. If the mount or the path is wrong this returns
  // nothing, and a gate over an empty table list passes over everything - which is the
  // exact failure mode (a check that passes while checking nothing) this round exists for.
  if (filesRead === 0) {
    throw new Error(`no init-agent-memory*.sql under ${SQL_DIR} - the table list would be empty`);
  }
  if (names.size === 0) {
    throw new Error("read the schema files but found no agent_memor* CREATE TABLE");
  }
  return [...names].sort();
}

/** Strip line and block comments, so prose mentioning a table is not a finding. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

interface TableRef {
  table: string;
  keyword: string;
  text: string;
}

/**
 * Every SQL reference to a named table, with the keyword that introduced it.
 *
 * Deliberately broad - FROM, JOIN, UPDATE, INTO, TABLE and DELETE FROM all count - and the
 * caller cross-checks the keyword-matched count against the raw count of the table name,
 * so a statement in a shape this regex does not know still fails rather than passing.
 */
function tableRefs(src: string, tables: readonly string[]): {
  refs: TableRef[];
  unrecognised: string[];
} {
  const body = stripComments(src);
  const refs: TableRef[] = [];
  const unrecognised: string[] = [];
  for (const table of tables) {
    const bare = [...body.matchAll(new RegExp(`\\b${table}\\b`, "g"))].length;
    const matched = [
      ...body.matchAll(new RegExp(`(FROM|JOIN|UPDATE|INTO|TABLE)\\s+${table}\\b`, "gi")),
    ];
    for (const m of matched) refs.push({ table, keyword: m[1].toUpperCase(), text: m[0] });
    if (bare > matched.length) {
      unrecognised.push(`${table} appears ${bare}x but only ${matched.length}x after a SQL keyword`);
    }
  }
  return { refs, unrecognised };
}

/**
 * THE ALLOW-LIST. One entry per memory-table statement that is NOT routed through the
 * chokepoint, with the reason it is safe. Short on purpose: a long allow-list is a
 * chokepoint that has stopped being one.
 *
 * `sql` must appear verbatim in the named file, comments stripped. `reason` is what a
 * reviewer reads instead of taking the exemption on trust. An entry that stops matching
 * anything is itself a failure - a stale exemption silently exempts a statement that has
 * moved.
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
    sql: "FROM agent_memories am\n        WHERE am.embedding IS NOT NULL AND (${filter.sql})",
    reason:
      "performRecall. Its plane predicate comes from buildRecallScopeFilter, whose exposure " +
      "list is forced by decideRecallExposure from deps.doorExposure and cannot be widened " +
      "by the caller. That is a SECOND chokepoint, older than this one and with its own " +
      "invariant tests (agent-memory-policy.test.ts) plus a live drill lane; folding it in " +
      "here would mean reimplementing the scope filter's lifecycle/review/visibility " +
      "clauses, which are the clauses that are dangerous to forget. The whole filter is " +
      "PARENTHESISED here for the same reason PlaneQuery.and parenthesises: an OR inside a " +
      "concatenated fragment must not be able to escape the clauses around it.",
  },
];

/**
 * THE AUDIT, as a pure function over {file -> source}.
 *
 * Pure on purpose. The real gate feeds it the shipping set read from disk; the red-proofs
 * below feed it the same set plus one synthetic file with an arbitrary NAME, so "a new
 * unguarded resolver is caught whatever it is called" is proven by the same code path that
 * does the real check - not by a second, friendlier one. It needs no write permission and
 * works against the read-only mount the runner uses.
 */
function auditSources(
  sources: Map<string, string>,
  tables: readonly string[],
  exempt: readonly Exemption[],
): string[] {
  const offenders: string[] = [];
  for (const ex of exempt) {
    if (!sources.has(ex.file)) offenders.push(`EXEMPT names a file that does not ship: ${ex.file}`);
  }
  for (const [file, src] of sources) {
    if (file === CHOKEPOINT) continue; // statements here ARE the guarded path
    let body = stripComments(src);
    for (const ex of exempt.filter((e) => e.file === file)) {
      const before = body;
      body = body.replace(ex.sql, "");
      if (body === before) {
        offenders.push(
          `${file}: allow-list entry no longer matches any statement - "${ex.sql.slice(0, 60)}..."`,
        );
      }
    }
    const { refs, unrecognised } = tableRefs(body, tables);
    for (const u of unrecognised) offenders.push(`${file}: ${u}`);
    for (const ref of refs) {
      // AN APPEND TO A SIDECAR CANNOT DISCLOSE AN EXISTING ROW. `INSERT INTO
      // agent_memory_audit_events` / `_recall_traces` / `_recall_items` writes new rows
      // from values the caller already has; there is no result set for a plane predicate
      // to bound. `INSERT INTO agent_memories` is NOT covered by this - that one stamps
      // the exposure that every later read depends on, so it carries an explicit
      // exemption naming the test that owns the stamp.
      if (ref.keyword === "INTO" && ref.table !== "agent_memories") continue;
      offenders.push(
        `${file}: "${ref.text}" is neither routed through ${CHOKEPOINT} nor on the ` +
          `allow-list. Route it through agent-memory-plane.ts, or add an EXEMPT entry ` +
          `with a reason.`,
      );
    }
  }
  return offenders;
}

Deno.test("the shipping set is derived from the Dockerfile's OWN rule", async () => {
  // The derivation above is only as true as the Dockerfile it reproduces. If the image
  // stops being "*.ts minus *.test.ts", every file-level assertion below is scanning the
  // wrong set - quietly, and in the direction that passes.
  const df = await readSource("Dockerfile");
  assertEquals(df.includes("COPY *.ts ./"), true, "Dockerfile no longer globs *.ts");
  assertEquals(df.includes("rm -f *.test.ts"), true, "Dockerfile no longer drops the tests");
  const files = await shippingFiles();
  assertEquals(files.includes("index.ts"), true, "index.ts must be in the derived set");
  assertEquals(files.includes(CHOKEPOINT), true);
  assertEquals(files.some((f) => f.endsWith(".test.ts")), false, "a test file must not ship");
});

Deno.test("the memory-table list is derived from the SQL that creates the tables", async () => {
  const tables = await memoryTables();
  // Not an equality assertion against a typed list - that would be the hand-written
  // registry again. These three are asserted because the gate is meaningless without them,
  // and the count floor catches a derivation that silently found only one file.
  for (const t of ["agent_memories", "agent_memory_recall_traces", "agent_memory_recall_items"]) {
    assertEquals(tables.includes(t), true, `derived table list is missing ${t}: ${tables}`);
  }
  assertEquals(tables.length >= 8, true, `expected at least 8 memory tables, derived ${tables.length}`);
});

Deno.test("EVERY memory-table statement is in the chokepoint or on the allow-list", async () => {
  // THE TEST THIS FILE EXISTS FOR - now over the derived file set and the derived table
  // set rather than over two lists somebody typed.
  const offenders = auditSources(await shippingSources(), await memoryTables(), EXEMPT);
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("ops and tools resolve NOTHING by hand - zero read statements", async () => {
  // The two files the escalation lived in. Stated separately so the property is visible on
  // its own: after the refactor their only memory-table SQL is an append to an audit
  // sidecar.
  const tables = await memoryTables();
  for (const file of ["agent-memory-ops.ts", "agent-memory-tools.ts"]) {
    const { refs } = tableRefs(await readSource(file), tables);
    const reads = refs.filter((r) => r.keyword !== "INTO");
    assertEquals(reads, [], `${file} still resolves memory rows by hand: ${JSON.stringify(reads)}`);
  }
});

Deno.test("every allow-list entry carries a real reason, and the list stays SHORT", async () => {
  const sources = await shippingSources();
  for (const ex of EXEMPT) {
    assertEquals(sources.has(ex.file), true, `EXEMPT names a file that does not ship: ${ex.file}`);
    assertEquals(ex.reason.length > 120, true, `EXEMPT reason too thin for ${ex.file}: ${ex.reason}`);
  }
  // Growing this is how a chokepoint dissolves one reasonable-looking exception at a time;
  // raising the number should feel like a decision, because it is one.
  assertEquals(EXEMPT.length <= 3, true, `the allow-list has grown to ${EXEMPT.length}`);
});

// ---------------------------------------------------------------------------------
// THE CORPUS RULE - what may ENTER `thoughts`, since who reads it cannot be bounded
// ---------------------------------------------------------------------------------

/**
 * The shipping files that know about the memory plane.
 *
 * DERIVED: a file is plane-aware if it names a memory table in SQL or imports the
 * chokepoint. index.ts is neither, so its ordinary capture/idea inserts into `thoughts`
 * are out of scope - and would come INTO scope the moment it grew a memory statement,
 * which is the direction that keeps this honest.
 */
async function planeAwareFiles(tables: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const [file, src] of await shippingSources()) {
    const body = stripComments(src);
    const namesATable = tableRefs(body, tables).refs.length > 0;
    const importsChokepoint = body.includes(`"./${CHOKEPOINT}"`);
    if (namesATable || importsChokepoint) out.push(file);
  }
  return out;
}

Deno.test("no plane-aware file writes the SHARED CORPUS by hand", async () => {
  // THE SECOND HOME, as a gate. `performWriteback` used to `INSERT INTO thoughts` itself,
  // with a metadata.exposure label and a comment claiming search_thoughts enforced the
  // same boundary. Nothing read the label. The write now goes through
  // mirrorToUnifiedSearch, which writes nothing at all off the unified-search plane, and
  // this asserts no plane-aware file can reintroduce a hand-written corpus row.
  const tables = await memoryTables();
  const aware = await planeAwareFiles(tables);
  assertEquals(
    aware.includes("agent-memory.ts"),
    true,
    "the plane-aware derivation found nothing it should have - it is testing nobody",
  );
  const offenders: string[] = [];
  for (const file of aware) {
    if (file === CHOKEPOINT) continue;
    const { refs } = tableRefs(await readSource(file), [CORPUS]);
    for (const r of refs) {
      if (r.keyword === "INTO" || r.keyword === "UPDATE") {
        offenders.push(
          `${file}: "${r.text}" - a plane-aware file must reach the corpus only through ` +
            `mirrorToUnifiedSearch, which writes nothing for a non-unified exposure.`,
        );
      }
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("the corpus mirror is the chokepoint's, and it is the ONLY one", async () => {
  // Belt to the braces above: the chokepoint really does contain the insert, so the rule
  // is "route it here", not "nobody may write the corpus".
  const self = await readSource(CHOKEPOINT);
  assertEquals(tableRefs(self, [CORPUS]).refs.length, 1, "expected exactly one corpus statement");
  assertEquals(self.includes("INSERT INTO thoughts (content, embedding, metadata)"), true);
});

// ---------------------------------------------------------------------------------
// RED-PROOFS - four properties, each demonstrated failing
// ---------------------------------------------------------------------------------

/** The real set plus one synthetic file, fed to the real audit function. */
async function withInjected(name: string, src: string): Promise<string[]> {
  const sources = await shippingSources();
  assertEquals(sources.has(name), false, `${name} already exists - pick another probe name`);
  sources.set(name, src);
  return auditSources(sources, await memoryTables(), EXEMPT);
}

Deno.test("RED: a new unguarded resolver is caught WHATEVER IT IS NAMED", async () => {
  // THE VERIFIER'S EXACT DEFEAT, as a permanent test. This is the file and the statement
  // that produced `deno check` exit 0 and 154 passed | 0 failed under the old gate, and it
  // is named nothing like the others on purpose - the old gate only looked at files whose
  // name started with "agent-memory".
  const offenders = await withInjected(
    "corpus-index.ts",
    "export async function lookup(c: { queryObject: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }, id: string) {\n" +
      "  return await c.queryObject(`SELECT id, summary, content, metadata FROM agent_memories WHERE id = $1`, [id]);\n" +
      "}\n",
  );
  assertEquals(offenders.length, 1, `expected exactly one finding, got: ${offenders.join(" | ")}`);
  assertEquals(offenders[0].startsWith("corpus-index.ts:"), true, offenders[0]);
});

Deno.test("RED: caught whatever MEMORY TABLE it reads, not just agent_memories", async () => {
  // The gate's one-word vocabulary, as a test. Each of these left the old gate green when
  // injected into a file it WAS scanning.
  const offenders = await withInjected(
    "trace-helpers.ts",
    "const a = `SELECT query FROM agent_memory_recall_traces WHERE id = $1`;\n" +
      "const b = `SELECT memory_id, rank FROM agent_memory_recall_items WHERE trace_id = $1`;\n" +
      "const c = `SELECT action FROM agent_memory_review_actions WHERE memory_id = $1`;\n" +
      "export const q = [a, b, c];\n",
  );
  assertEquals(offenders.length, 3, offenders.join(" | "));
  assertEquals(offenders.every((o) => o.startsWith("trace-helpers.ts:")), true, offenders.join(" | "));
});

Deno.test("RED: caught whatever VERB it uses - an UPDATE is not a read", async () => {
  // The escalation's shape. `promote_exposure` WIDENS exposure; a bare UPDATE with no plane
  // in its WHERE moves a memory across the boundary without ever reading it.
  const offenders = await withInjected(
    "fixups.ts",
    "export const widen = `UPDATE agent_memories SET metadata = metadata || '{\"exposure\":\"ops\"}' WHERE id = $1`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("UPDATE agent_memories"), true, offenders[0]);
});

Deno.test("RED: an INSERT into agent_memories is NOT waved through as an append", async () => {
  // The append exemption is narrow on purpose. A second write path would stamp its own
  // exposure, and "the stamp comes from the door" is the invariant the read side rests on.
  const offenders = await withInjected(
    "importer.ts",
    "export const q = `INSERT INTO agent_memories (id, content, metadata) VALUES ($1,$2,$3)`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
});

Deno.test("RED: a plane-aware file that writes the CORPUS by hand is caught", async () => {
  // The second home, injected. Same shape as the statement that was really there.
  const src = 'import { doorPlane } from "./agent-memory-plane.ts";\n' +
    "export const q = `INSERT INTO thoughts (content, embedding, metadata) VALUES ($1,$2,$3)`;\n" +
    "export const p = doorPlane({});\n";
  const body = stripComments(src);
  assertEquals(body.includes(`"./${CHOKEPOINT}"`), true, "precondition: the probe is plane-aware");
  const refs = tableRefs(body, [CORPUS]).refs;
  assertEquals(refs.length, 1);
  assertEquals(refs[0].keyword, "INTO", "the corpus rule must see this as a write");
});

Deno.test("an append to a SIDECAR is deliberately not a finding", async () => {
  // The other direction. A gate that reports every audit-event insert is a gate people
  // route around, and an append genuinely cannot disclose a row that already exists.
  const offenders = await withInjected(
    "eventlog.ts",
    "export const q = `INSERT INTO agent_memory_audit_events (memory_id, event_type) VALUES ($1,$2)`;\n",
  );
  assertEquals(offenders, []);
});

Deno.test("a comment mentioning a table is NOT a finding", async () => {
  const offenders = await withInjected(
    "notes.ts",
    "// see agent_memories for the schema\n/* agent_memory_recall_traces again */\nexport const x = 1;\n",
  );
  assertEquals(offenders, []);
});

Deno.test("a table name in a shape the matcher does not know still FAILS", async () => {
  // The safe direction, asserted rather than assumed. If a statement uses a form the regex
  // misses, the bare-name count exceeds the keyword count and that discrepancy is reported
  // - the gate does not get to be silently blind.
  const offenders = await withInjected(
    "weird.ts",
    'export const q = "SELECT * FROM " + "public." + `agent_memories WHERE id = $1`;\n',
  );
  assertEquals(offenders.length >= 1, true, "an unrecognised reference must not pass");
  assertEquals(offenders[0].includes("agent_memories appears"), true, offenders[0]);
});

Deno.test("the runner passes --allow-read, or this whole file proves nothing", async () => {
  // Guards the trap named in the header. `deno test` without --allow-read cannot read a
  // sibling file; a test that swallows that error passes while comparing nothing, which is
  // what the memory_type cross-reader test did.
  const self = await readSource(CHOKEPOINT);
  assertEquals(self.length > 1000, true, "could not read the chokepoint's own source");
  const tables = await memoryTables();
  assertEquals(tables.length > 0, true, "could not read the schema directory");
});

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

// ════════════════════════════════════════════════════════════════════════════
// PART 3 - THE FOUR DEFEATS A VERIFIER DEMONSTRATED, AS TESTS
// ════════════════════════════════════════════════════════════════════════════

Deno.test("a DoorPlane cannot be WIDENED - forging was blocked, widening was not", () => {
  // `doorPlane()` returned a plain mutable array, so this line type-checked, ran, and
  // re-bound every statement in the module to ['ops','personal']. The brand symbol stopped
  // a caller from WRITING a plane; nothing stopped it from editing the one it was given.
  const p = doorPlane({ doorExposure: "ops" });
  assertThrows(() => (p.exposures as string[]).push("personal"), TypeError);
  assertEquals(p.exposures, ["ops"]);
  // And the array cannot be swapped out past the freeze either.
  assertThrows(
    () => ((p as unknown as { exposures: string[] }).exposures = ["ops", "personal"]),
    TypeError,
  );
  assertEquals(p.exposures, ["ops"]);
});

Deno.test("the DEFAULT plane constant is frozen too - one shared array, no shared edits", () => {
  assertThrows(() => (DEFAULT_DOOR_PLANE as string[]).push("personal"), TypeError);
  // doorPlane copies it, so a per-call freeze cannot be defeated by mutating the source.
  assertEquals(doorPlane({}).exposures, ["ops"]);
});

Deno.test("PlaneQuery.and PARENTHESISES - one OR must not escape the plane", async () => {
  // F3, proven against real Postgres before it was fixed: `plane AND a OR b` parses as
  // `(plane AND a) OR b`, and the ops door returned BOTH personal fixtures WITH content and
  // wrote zero audit rows. The predicate was there and it bounded nothing.
  const r = recorder(() => []);
  await listMemoriesOnPlane(r.client, doorPlane({ doorExposure: "ops" }), {
    columns: "id",
    orderBy: "created_at ASC",
    limit: 5,
    build: (q) => {
      q.and(`review_status = ${q.param("pending")} OR 1=1`);
    },
  });
  const sql = r.seen[0][0];
  assertEquals(
    sql.includes("AND (review_status = $2 OR 1=1)"),
    true,
    `the caller's fragment must be parenthesised; got:\n${sql}`,
  );
  // The property that actually matters, stated positively: nothing the caller appends can
  // sit at the same precedence level as the plane predicate.
  assertEquals(sql.includes("AND review_status"), false, "an unwrapped fragment survived");
});

Deno.test("every and() fragment is wrapped, not just one", async () => {
  const r = recorder(() => []);
  await listMemoriesOnPlane(r.client, doorPlane({}), {
    columns: "id",
    orderBy: "created_at ASC",
    limit: 5,
    build: (q) => {
      q.and(`a = ${q.param(1)}`);
      q.and(`b = ${q.param(2)} OR c = ${q.param(3)}`);
    },
  });
  const sql = r.seen[0][0];
  assertEquals(sql.includes("AND (a = $2)"), true, sql);
  assertEquals(sql.includes("AND (b = $3 OR c = $4)"), true, sql);
});

// ---------------------------------------------------------------------------------
// THE SECOND HOME - the corpus mirror
// ---------------------------------------------------------------------------------

Deno.test("the unified-search plane is a WHITELIST, and personal is not on it", () => {
  assertEquals([...UNIFIED_SEARCH_EXPOSURES], ["ops"]);
  assertEquals(mirrorsToUnifiedSearch("ops"), true);
  assertEquals(mirrorsToUnifiedSearch("personal"), false);
  // Default-deny on the argument. A missing exposure meaning "mirror it" is how this hole
  // reopens, so undefined/null read as the narrow end.
  assertEquals(mirrorsToUnifiedSearch(undefined), false);
  assertEquals(mirrorsToUnifiedSearch(null), false);
  assertEquals(mirrorsToUnifiedSearch("something-new"), false);
  assertThrows(() => (UNIFIED_SEARCH_EXPOSURES as string[]).push("personal"), TypeError);
});

Deno.test("a PERSONAL memory writes NO corpus row at all - not a stub, nothing", async () => {
  // The whole F1 fix in one assertion. Not "a redacted row", not "a stub with the real
  // vector": a stub carrying the real embedding is still an oracle, because a semantic
  // search for the secret ranks it first and the caller learns the memory exists.
  const r = recorder(() => [{ id: 1 }]);
  const id = await mirrorToUnifiedSearch(r.client, "personal", {
    content: "SECRET personal payload",
    embedding: [0.1, 0.2],
    metadata: { source: "agent-memory", workspace_id: "ws" },
  });
  assertEquals(id, null, "a personal memory must not get a thought id");
  assertEquals(r.seen, [], "a personal memory must issue NO statement against the corpus");
});

Deno.test("an OPS memory is mirrored, with the label and without share:cloud", async () => {
  const r = recorder(() => [{ id: 42 }]);
  const id = await mirrorToUnifiedSearch(r.client, "ops", {
    content: "ops payload",
    embedding: [0.5, 0.25],
    metadata: { source: "agent-memory", workspace_id: "ws" },
  });
  assertEquals(id, 42);
  const [sql, args] = r.seen[0];
  assertEquals(sql.includes("INSERT INTO thoughts"), true);
  assertEquals(args[0], "ops payload");
  assertEquals(args[1], "[0.5,0.25]");
  const meta = JSON.parse(String(args[2]));
  assertEquals(meta.exposure, "ops");
  assertEquals(meta.source, "agent-memory");
  // The cloud door's forced read filter is share=cloud, and the absence of this key is
  // what keeps even an ops memory off that lane. Asserted here because the claim used to
  // live only in a comment.
  assertEquals(Object.hasOwn(meta, "share"), false, "the mirror must carry no share label");
});

Deno.test("the caller cannot smuggle an exposure through the metadata", async () => {
  // `exposure` is applied AFTER the caller's metadata is spread, so a caller that puts its
  // own exposure key in cannot end up labelling an ops row 'personal' or vice versa.
  const r = recorder(() => [{ id: 7 }]);
  await mirrorToUnifiedSearch(r.client, "ops", {
    content: "x",
    embedding: [1],
    metadata: { exposure: "personal", source: "agent-memory" },
  });
  assertEquals(JSON.parse(String(r.seen[0][1][2])).exposure, "ops");
});

// ---------------------------------------------------------------------------------
// THE TRACE ENVELOPE - read by id with no predicate at all, until now
// ---------------------------------------------------------------------------------

Deno.test("the trace predicate is CONTAINMENT, because enforced_exposure is a list", () => {
  assertEquals(
    tracePlanePredicate(2),
    `COALESCE(request_payload->'enforced_exposure', '["personal"]'::jsonb) <@ to_jsonb($2::text[])`,
  );
  // COALESCE to personal: a trace written before the field existed is invisible to the ops
  // door rather than visible to it.
  assertEquals(tracePlanePredicate(2).includes(`'["personal"]'::jsonb`), true);
});

Deno.test("an OFF-PLANE trace is not_found, and leaves an audit row naming NO id", async () => {
  const r = recorder((sql) => {
    if (sql.includes("enforced_exposure")) return []; // off plane
    if (sql.includes("SELECT 1 FROM agent_memory_recall_traces")) return [{ x: 1 }]; // exists
    return [];
  });
  const out = await resolveTraceOnPlane(r.ctx, doorPlane({ doorExposure: "ops" }), "t-1", {
    columns: "id, query",
    tool: "agent_memory_recall_trace",
  });
  assertEquals(out.ok, false);
  const audit = r.seen.find(([s]) => s.includes("access_refused"))!;
  assertEquals(
    (audit[1] as unknown[])[0],
    null,
    "a trace refusal must not carry a memory id it does not own",
  );
  assertEquals(JSON.parse(String((audit[1] as unknown[])[1])).reason, "off-plane-trace");
});

Deno.test("an ABSENT trace writes no audit row, and an ON-PLANE one is returned", async () => {
  const absent = recorder(() => []);
  await resolveTraceOnPlane(absent.ctx, doorPlane({}), "nope", { columns: "id", tool: "t" });
  assertEquals(absent.seen.some(([s]) => s.includes("access_refused")), false);

  const hit = recorder((sql) => (sql.includes("enforced_exposure") ? [{ id: "t-1" }] : []));
  const out = await resolveTraceOnPlane<{ id: string }>(hit.ctx, doorPlane({}), "t-1", {
    columns: "id",
    tool: "t",
  });
  assertEquals(out.ok, true);
  assertEquals(hit.seen[0][1], ["t-1", ["ops"]]);
});

// ---------------------------------------------------------------------------------
// THE SIDECARS - plane-bound in the statement, not by the order of two calls
// ---------------------------------------------------------------------------------

Deno.test("listSidecarOnPlane re-applies the plane in its OWN statement", async () => {
  // These reads follow a successful resolveMemoryOnPlane, so they were already unreachable
  // off-plane. "The caller checked first" is an ordering assumption, and every round of
  // this bug has been an ordering assumption that stopped being true.
  const r = recorder(() => [{ action: "confirm" }]);
  await listSidecarOnPlane(
    r.client,
    doorPlane({ doorExposure: "ops" }),
    "review_actions",
    "sc.action",
    "m-1",
  );
  const [sql, args] = r.seen[0];
  assertEquals(sql.includes("FROM agent_memory_review_actions sc"), true);
  assertEquals(sql.includes("EXISTS ("), true, "the plane must be re-applied, not assumed");
  assertEquals(sql.includes(planePredicate(2, "am")), true);
  assertEquals(args, ["m-1", ["ops"]]);
});
