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
  corpusPlanePredicate,
  planePredicate,
  resolveCorpusRowOnPlane,
  resolveIdempotentOnPlane,
  resolveMemoryOnPlane,
  resolveTraceOnPlane,
  selectCorpusOnPlane,
  stripCorpusClaim,
  tracePlanePredicate,
  UNIFIED_SEARCH_EXPOSURES,
  updateMemoryOnPlane,
} from "./agent-memory-plane.ts";

// ════════════════════════════════════════════════════════════════════════════
// PART 1 - THE COMPLETENESS GATE, DERIVED FROM THE CODE
// ════════════════════════════════════════════════════════════════════════════

/** The chokepoint itself. Statements here ARE the guarded path. */
const CHOKEPOINT = "integrations/kubernetes-deployment/agent-memory-plane.ts";

/** The shared corpus. */
const CORPUS = "thoughts";

const HERE = new URL("./", import.meta.url);
/** The OB1 repo root. Every key below is a path relative to this. */
const REPO = new URL("../../", import.meta.url);
const SQL_DIR = new URL("docker/", REPO);
const COMPOSE = "docker/docker-compose.yml";

/**
 * NORMALISE LINE ENDINGS AT THE READ, and this is not tidiness - it is a defect this gate
 * had and shipped past its own green run.
 *
 * The PINNED entries below match MULTI-LINE statements verbatim, written with LF in a
 * TypeScript template literal. This repo is developed on Windows with git's autocrlf on, so
 * the same files come back off disk with CRLF after a commit and checkout. The gate was
 * green in the working tree, went RED the moment git touched the files, and every failure
 * read "PINNED statement no longer matches" - which is indistinguishable from someone having
 * edited a guarded statement, and is exactly the alarm a reviewer would waste an afternoon
 * on. A completeness gate whose verdict depends on how a file was checked out is not a gate.
 */
function normalise(text: string): string {
  return text.split("\r\n").join("\n");
}

/** FAIL-CLOSED. No try/catch: an unreadable file must fail a test, never skip it. */
async function readSource(name: string): Promise<string> {
  return normalise(await Deno.readTextFile(new URL(`./${name}`, HERE)));
}

/** Read a path relative to the OB1 repo root. Fail-closed, same reason. */
async function readRepo(rel: string): Promise<string> {
  return normalise(await Deno.readTextFile(new URL(rel, REPO)));
}

/**
 * Roots that ship code, DERIVED FROM THE DEPLOYMENT.
 *
 * ROUND FOUR'S GATE SCANNED ONE DIRECTORY, and that was its remaining hole. Two more
 * readers of the same content were found outside it - `docker/extensions-server/index.ts`
 * (the openbrain-ext container: read a thought by id with no plane and COPIED its content
 * into professional_contacts.notes) and `integrations/agent-memory-api/index.ts` (selected
 * from agent_memories with no plane at all). A gate scoped to one image cannot see either,
 * however well it derives inside that image.
 *
 * So the roots come from `docker/docker-compose.yml`'s own `build: context:` lines: every
 * directory this stack turns into a container. Add a service, its source is in scope the
 * same day, with nobody editing this file.
 */
const EXTRA_ROOTS: { root: string; why: string }[] = [
  {
    root: "integrations/agent-memory-api",
    why:
      "A second door onto the same memory plane, shipped in the repo and deployed by NOTHING " +
      "in this stack (it is a Supabase Edge Function; no compose context builds it). So it " +
      "cannot be derived from compose, and a verifier found it unguarded anyway. Listed " +
      "explicitly because an extra root can only ADD coverage - the risk of the list is that " +
      "it is short, never that it is wrong.",
  },
];

async function isDir(rel: string): Promise<boolean> {
  try {
    return (await Deno.stat(new URL(rel, REPO))).isDirectory;
  } catch {
    return false;
  }
}

async function scanRoots(): Promise<string[]> {
  const compose = await readRepo(COMPOSE);
  const roots = new Set<string>();
  for (const m of compose.matchAll(/^\s*context:\s*(\S+)\s*$/gm)) {
    // compose paths are relative to docker/, where the file lives.
    const raw = m[1].replace(/^\.\//, "");
    const rel = raw.startsWith("../") ? raw.slice(3) : `docker/${raw}`;
    roots.add(rel.replace(/\/$/, ""));
  }
  // FAIL-CLOSED on the derivation. A compose file this cannot parse would give an empty
  // root set, and a gate over an empty set passes over everything - the exact failure mode
  // (a check that passes while checking nothing) this whole file exists to prevent.
  if (roots.size === 0) {
    throw new Error(`no build contexts parsed from ${COMPOSE} - every scan below would be empty`);
  }
  for (const e of EXTRA_ROOTS) roots.add(e.root);
  const out = [...roots].sort();
  for (const r of out) {
    if (!await isDir(r)) throw new Error(`scan root does not exist: ${r}`);
  }
  return out;
}

/** Every `.ts` under a scan root, keyed by repo-relative path. */
async function walkTs(root: string, out: Map<string, string>): Promise<void> {
  for await (const e of Deno.readDir(new URL(`${root}/`, REPO))) {
    const rel = `${root}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walkTs(rel, out);
      continue;
    }
    if (!e.isFile) continue;
    if (!e.name.endsWith(".ts")) continue;
    // Tests do not ship (the openbrain-mcp Dockerfile deletes them; no other root has any).
    if (e.name.endsWith(".test.ts")) continue;
    out.set(rel, await readRepo(rel));  // normalised - see normalise()
  }
}

/**
 * The whole scanned set as {repo-relative path -> source}.
 *
 * A SUPERSET OF WHAT SHIPS, on purpose. Some roots' Dockerfiles copy a single file; scanning
 * a source that does not end up in an image costs a few milliseconds, while missing one that
 * does is the bug this gate is for. The direction of the error is chosen.
 */
async function shippingSources(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const root of await scanRoots()) await walkTs(root, m);
  if (m.size === 0) {
    throw new Error("no .ts files found under any scan root - every assertion would be vacuous");
  }
  return m;
}

async function shippingFiles(): Promise<string[]> {
  return [...(await shippingSources()).keys()].sort();
}

/**
 * Every table that holds or references memory content, DERIVED FROM THE SQL THAT CREATES IT.
 *
 * Eight exist: agent_memories, and the source_refs / artifacts / relations / review_actions /
 * recall_traces / recall_items / audit_events sidecars. A recall trace carries the query
 * text; a recall item carries a memory id, a rank and a use-policy snapshot.
 */
async function memoryTables(): Promise<string[]> {
  const names = new Set<string>();
  let filesRead = 0;
  for await (const e of Deno.readDir(SQL_DIR)) {
    if (!e.isFile) continue;
    if (!e.name.startsWith("init-agent-memory")) continue;
    if (!e.name.endsWith(".sql")) continue;
    filesRead++;
    const sql = normalise(await Deno.readTextFile(new URL(e.name, SQL_DIR)));
    for (
      const m of sql.matchAll(
        /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?(agent_memor[a-z_]+)/gi,
      )
    ) {
      names.add(m[1].toLowerCase());
    }
  }
  if (filesRead === 0) {
    throw new Error(`no init-agent-memory*.sql under ${SQL_DIR} - the table list would be empty`);
  }
  if (names.size === 0) {
    throw new Error("read the schema files but found no agent_memor* CREATE TABLE");
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------------
// THE CORPUS'S SQL FUNCTIONS - readers that are not a line of TypeScript
// ---------------------------------------------------------------------------------

interface SqlFn {
  name: string;
  file: string;
  /** Position in the initdb chain, from the compose mount prefix. Later definitions win. */
  order: number;
  reads: boolean;
  hasPlane: boolean;
}

/** The `NNN-` prefix each init file is mounted under, read from compose. */
async function initdbOrder(): Promise<Map<string, number>> {
  const compose = await readRepo(COMPOSE);
  const order = new Map<string, number>();
  for (
    const m of compose.matchAll(
      /-\s*\.\/([A-Za-z0-9._-]+\.sql):\/docker-entrypoint-initdb\.d\/(\d+)-/g,
    )
  ) {
    order.set(m[1], parseInt(m[2], 10));
  }
  if (order.size === 0) {
    throw new Error("parsed no initdb mounts from compose - the ordering check would be vacuous");
  }
  return order;
}

/**
 * Every SQL function whose body touches `thoughts`, with whether it READS the corpus and
 * whether its body carries an exposure predicate.
 *
 * WHY THIS EXISTS. `match_thoughts` RETURNS content and is called by things that touch no
 * TypeScript in this repo at all - `openbrain-postgrest` exposes it as `rpc/match_thoughts`,
 * and the edge functions and recipes call it directly. A file-level scan can never see it.
 * `upsert_thought` turned out to be a reader too: its dedup lookup is a SELECT and the
 * function `RETURNS public.thoughts`, so a caller that knows a thought's exact content gets
 * the whole row back and the UPDATE branch merges its own metadata into it.
 */
async function corpusFunctions(): Promise<SqlFn[]> {
  const order = await initdbOrder();
  const out: SqlFn[] = [];
  let filesRead = 0;
  for await (const e of Deno.readDir(SQL_DIR)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    filesRead++;
    const sql = normalise(await Deno.readTextFile(new URL(e.name, SQL_DIR)));
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
    for (const m of [...sql.matchAll(re)]) {
      const start = m.index!;
      const end = sql.indexOf("\n$$;", start);
      const body = end === -1 ? sql.slice(start) : sql.slice(start, end);
      if (!/\bthoughts\b/i.test(body)) continue;
      out.push({
        name: m[1].toLowerCase(),
        file: e.name,
        order: order.get(e.name) ?? -1,
        reads: /(FROM|JOIN)\s+(?:public\.)?thoughts\b/i.test(body),
        hasPlane: /metadata->>'exposure'/.test(body),
      });
    }
  }
  if (filesRead === 0) throw new Error(`no .sql under ${SQL_DIR}`);
  if (out.length === 0) throw new Error("found no SQL function touching thoughts - vacuous");
  return out;
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
 * Does this occurrence of a table name look like SQL, or like prose?
 *
 * THE RECONCILIATION NEEDS THIS OR IT CRIES WOLF. The bare-name count exists to catch a
 * statement in a shape none of the three matchers knows - the "still fails" property. But
 * these are MCP servers: `thoughts` appears in nine tool DESCRIPTIONS and in user-facing
 * strings ("No thoughts found."), none of which is a statement. A gate that reports those is
 * a gate whose output gets skimmed, and a skimmed gate is the one that stayed green while an
 * unguarded resolver shipped.
 *
 * The discriminator is that SQL KEYWORDS IN THIS CODEBASE ARE UPPERCASE and prose is not.
 * An occurrence counts when the string it sits in contains an uppercase SQL verb, when the
 * next character is `(` (a PostgREST embedded resource - `agent_memories(*)`), or when it is
 * not inside a string literal at all. All three err toward reporting: a false positive costs
 * a pin with a written reason, a false negative costs the boundary.
 */
function looksLikeSql(body: string, idx: number, table: string): boolean {
  const end = idx + table.length;
  if (body[end] === "(") return true;
  const before = body.slice(0, idx);
  const open = Math.max(before.lastIndexOf("`"), before.lastIndexOf('"'), before.lastIndexOf("'"));
  const after = body.slice(end);
  let close = after.length;
  for (const ch of ["`", '"', "'"]) {
    const i = after.indexOf(ch);
    if (i !== -1 && i < close) close = i;
  }
  // No quote before it, or an implausibly long "string": treat it as bare code.
  if (open === -1 || idx - open > 400) return true;
  const frag = body.slice(open + 1, end + close);
  // A quoted string that is EXACTLY the table name is a query-builder reference
  // (`.from("agent_memories")`), never prose. Counting it is what keeps the reconciliation
  // able to see ORM-shaped blindness: if the builder verb is one the matcher does not know,
  // the bare count still exceeds the matched count and the gate reports it.
  if (frag.trim() === table) return true;
  return /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO|TRUNCATE|VALUES|WHERE)\b/.test(frag);
}

/** supabase-js verb -> the SQL keyword it means. */
const ORM_VERB: Record<string, string> = {
  select: "FROM",
  insert: "INTO",
  upsert: "INTO",
  update: "UPDATE",
  delete: "DELETE",
};

/**
 * Every reference to a named table or corpus function, with the keyword that introduced it.
 *
 * THREE SHAPES, because the code uses three. Raw SQL (`FROM x`), the supabase-js query
 * builder (`.from("x").select(...)`), and an RPC call to a function that reads the corpus
 * (`.rpc("match_thoughts", ...)`). The ORM shape was invisible to the previous matcher
 * except as an "unrecognised" discrepancy, and the RPC shape was invisible entirely -
 * `match_thoughts` does not match `\bthoughts\b`, because `_` is a word character.
 *
 * The caller cross-checks the keyword-matched count against the raw count of the name, so a
 * statement in a shape none of these know still fails rather than passing.
 */
function tableRefs(
  src: string,
  tables: readonly string[],
  rpcs: readonly { name: string; reads: boolean }[] = [],
): { refs: TableRef[]; unrecognised: string[] } {
  const body = stripComments(src);
  const refs: TableRef[] = [];
  const unrecognised: string[] = [];
  for (const table of tables) {
    const bare = [...body.matchAll(new RegExp(`\\b${table}\\b`, "g"))]
      .filter((m) => looksLikeSql(body, m.index!, table)).length;
    const matched: TableRef[] = [];
    for (
      const m of body.matchAll(
        new RegExp(`(FROM|JOIN|UPDATE|INTO|TABLE)\\s+(?:public\\.)?${table}\\b`, "gi"),
      )
    ) {
      matched.push({ table, keyword: m[1].toUpperCase(), text: m[0] });
    }
    for (
      const m of body.matchAll(
        new RegExp(
          `\\.from\\(["']${table}["']\\)[\\s\\S]{0,120}?\\.(select|insert|upsert|update|delete)\\b`,
          "g",
        ),
      )
    ) {
      matched.push({
        table,
        keyword: ORM_VERB[m[1]],
        text: `.from("${table}").${m[1]}`,
      });
    }
    refs.push(...matched);
    if (bare > matched.length) {
      unrecognised.push(
        `${table} appears ${bare}x but only ${matched.length}x in a shape the matcher knows`,
      );
    }
  }
  // DEDUPED BY NAME: a function is defined more than once across the initdb chain
  // (match_thoughts exists in init.sql and again, guarded, in the corpus-plane file), and
  // scanning per definition would report one call site as many findings.
  const seenRpc = new Set<string>();
  for (const fn of rpcs) {
    if (seenRpc.has(fn.name)) continue;
    seenRpc.add(fn.name);
    for (const m of body.matchAll(new RegExp(`\\brpc\\(["']${fn.name}["']`, "g"))) {
      refs.push({
        table: CORPUS,
        // A corpus function that READS is a corpus read however it is invoked.
        keyword: fn.reads ? "FROM" : "INTO",
        text: m[0],
      });
    }
  }
  return { refs, unrecognised };
}

/**
 * THE ALLOW-LIST. One entry per memory- or corpus-table statement that deliberately carries
 * NO plane, with the reason it is safe anyway.
 *
 * `sql` must appear verbatim in the named file, comments stripped, and is REMOVED from the
 * body before the scan. `reason` is what a reviewer reads instead of taking the exemption on
 * trust. An entry that stops matching anything is itself a failure - a stale exemption
 * silently exempts a statement that has moved.
 *
 * THE LIST GREW THIS ROUND, from two to six, and that is a decision rather than a drift:
 * the scan went from one directory to every build context in the deployment, so two files
 * that were never scanned before are scanned now and their deliberate no-plane statements
 * have to be named. Every new entry is an EXISTENCE PROBE whose answer never reaches the
 * caller, or a WRITE. Neither can disclose a row.
 */
interface Exemption {
  file: string;
  sql: string;
  reason: string;
}

const EXEMPT: Exemption[] = [
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `await supabase.rpc("match_thoughts", {`,
    reason:
      "The corpus vector search, and the one statement here whose plane is not in the " +
      "TypeScript at all: it is INSIDE THE FUNCTION. docker/init-agent-memory-corpus-plane.sql " +
      "replaces match_thoughts with a body carrying the same predicate, and a test above " +
      "asserts that the LAST definition in the initdb chain is the guarded one. Pinning it " +
      "here would be a lie - there is no marker in this statement to pin - so it is an " +
      "exemption that names where the guard actually lives.",
  },
  {
    file: "integrations/kubernetes-deployment/agent-memory.ts",
    sql: "INSERT INTO agent_memories (",
    reason:
      "The WRITE. Exposure is stamped by buildWritebackRow from the DOOR (stampExposure, " +
      "which has no widening path) and written into metadata.exposure - the column every " +
      "plane predicate reads. A write cannot disclose an existing row, so there is nothing " +
      "for a read predicate to bound; the invariant here is 'the stamp comes from the door', " +
      "and agent-memory-policy.test.ts owns it.",
  },
  {
    file: "integrations/kubernetes-deployment/agent-memory.ts",
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
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `await supabase.from("agent_memories").select("id").eq("id", id).maybeSingle();`,
    reason:
      "auditIfOffPlane's EXISTENCE PROBE, and it is plane-free on purpose: its whole job is " +
      "to ask whether a refused id exists at all, so that a typo does not file a refusal " +
      "record while a real probe does. The answer never reaches the caller - it decides only " +
      "whether an audit row is written - which is what keeps it from being an oracle. Same " +
      "shape and same reasoning as auditIfOffPlane in the chokepoint.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql:
      `.from("agent_memories").select("id").eq("idempotency_key", idempotency_key).maybeSingle();`,
    reason:
      "The idempotency EXISTENCE PROBE. Plane-free deliberately: the key is unique per " +
      "workspace regardless of plane, so an off-plane hit must become a refusal rather than " +
      "a duplicate insert that violates the index. It selects `id` and never returns it - " +
      "the route answers 409 with no identifier, which is precisely the disclosure the " +
      "openbrain-mcp version of this bug was handing over.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `const { data: memory, error: memoryError } = await supabase.from("agent_memories").insert({`,
    reason:
      "The WRITE, same reasoning as agent-memory.ts's INSERT above: a write cannot disclose " +
      "an existing row. This one now stamps `exposure: DOOR_EXPOSURE` into the row's " +
      "metadata from the door value, which it did not before - every memory this door wrote " +
      "was unlabelled, and unlabelled reads as 'personal', so the door could not read back " +
      "its own writes and anything that could was reading the restricted plane.",
  },
];

/**
 * PINNED STATEMENTS - guarded IN PLACE, because their file cannot import the chokepoint.
 *
 * A DIFFERENT THING FROM AN EXEMPTION, and kept in a different list so the difference stays
 * visible. An exemption says "this statement carries no plane and that is safe". A pin says
 * "this statement carries the plane INSIDE ITSELF, and here is the text that proves it".
 *
 * Two files need this and neither can be routed. `docker/extensions-server/index.ts` is a
 * different image whose build context is its own directory - there is no import path to
 * `integrations/kubernetes-deployment/agent-memory-plane.ts` that survives `docker build`,
 * and widening the context to the repo root to get one would put every OB1 source file into
 * an image that needs a single module. `integrations/agent-memory-api/index.ts` is a
 * Supabase Edge Function talking to PostgREST through supabase-js, which has no queryObject
 * and cannot execute the chokepoint's SQL at all.
 *
 * WHAT MAKES A PIN TWO-SIDED. `sql` must match verbatim AND must contain `marker`. Edit the
 * statement to drop its predicate and the pin stops matching, which is itself a failure
 * ("allow-list entry no longer matches"); the statement then falls through to the ordinary
 * scan and is reported. There is no edit that removes the plane and leaves the gate green.
 */
interface Pin {
  file: string;
  sql: string;
  marker: string;
  reason: string;
}

const PINNED: Pin[] = [
  {
    file: "integrations/entity-extraction-worker/index.ts",
    sql: `.from("thoughts")
      .select("id, content, metadata")
      .eq("id", item.thought_id)
      .or(CORPUS_PLANE_OR)
      .maybeSingle();`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "openbrain-entity-worker's read of a queued thought's content. FOUND BY THIS GATE, not " +
      "by a person: there is no SQL in that file, so no grep for `FROM thoughts` could see " +
      "it, and it only appeared once the matcher learned the supabase-js shape. It matters " +
      "because the worker turns content into ENTITIES and EDGES - a further store, read by " +
      "the wiki and the graph tools, with no label to carry.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql:
      `await memoriesOnPlane("*, agent_memory_source_refs(*), agent_memory_artifacts(*)").eq("id", id).maybeSingle();`,
    marker: "memoriesOnPlane",
    reason:
      "The by-id route's embedded read of two sidecars. PostgREST resolves `x(*)` through the " +
      "parent row, so the plane on the parent bounds them - but that is exactly the ordering " +
      "assumption the chokepoint refused to rest on elsewhere, which is why it is pinned to " +
      "the call that carries the plane rather than waved through as 'the parent was checked'.",
  },
  {
    file: "docker/extensions-server/index.ts",
    sql: "`SELECT * FROM thoughts WHERE id = $2 AND ${corpusPlanePredicate(1)}`",
    marker: "corpusPlanePredicate(1)",
    reason:
      "link_thought_to_contact's by-id read. This is the statement a verifier found returning " +
      "any thought's full content to the openbrain-ext door AND copying it into " +
      "professional_contacts.notes - a third home for the same text, in a table with no " +
      "exposure label and no way to grow one.",
  },
  {
    file: "docker/extensions-server/index.ts",
    sql: "`SELECT 1 FROM thoughts WHERE id = $2 AND NOT ${corpusPlanePredicate(1)}`",
    marker: "corpusPlanePredicate(1)",
    reason:
      "The existence probe behind that refusal, plane-NEGATED so it fires only for a row " +
      "that really is off-plane. Pinned rather than exempted because the predicate is IN it: " +
      "a probe that lost its NOT would audit every miss.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `const q = supabase.from("agent_memories").select((columns ?? "*") as Q);
  if (DOOR_PLANE.includes("personal")) {
    return q.or(
      \`metadata->>exposure.in.(\${DOOR_PLANE.join(",")}),metadata->>exposure.is.null\`,
    );
  }
  return q.filter("metadata->>exposure", "in", \`(\${DOOR_PLANE.join(",")})\`);`,
    marker: "DOOR_PLANE",
    reason:
      "memoriesOnPlane - the ONLY way this file selects from agent_memories, and the whole " +
      "body is pinned rather than the first line, so the predicate cannot be separated from " +
      "the statement it bounds. PostgREST has no COALESCE, so the chokepoint's " +
      "COALESCE(...,'personal') is written as its two halves.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `.from("agent_memories").update(updates).eq("id", id)
    .filter("metadata->>exposure", "in", \`(\${DOOR_PLANE.join(",")})\`)`,
    marker: "DOOR_PLANE",
    reason:
      "The review UPDATE. The plane is on the write as well as on the read that preceded it - " +
      "both, not either, because the read is what refuses and this is what keeps the refusal " +
      "true if a later edit reorders them. An unbounded review endpoint is how the " +
      "openbrain-mcp escalation worked.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `if (mirrors && thoughtId) await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);`,
    marker: "mirrors",
    reason:
      "The corpus mirror's embedding write. `mirrors` is UNIFIED_SEARCH_EXPOSURES membership " +
      "for the door's exposure, so off the unified-search plane no corpus row is created and " +
      "none is updated. Written redundantly into the statement (thoughtId is already null) " +
      "so the thing that makes it safe is IN the text this pin matches.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `const mirrors = UNIFIED_SEARCH_EXPOSURES.includes(DOOR_EXPOSURE);
    const { data: upsertResult, error: upsertError } = !mirrors
      ? { data: null, error: null }
      : await supabase.rpc("upsert_thought", {`,
    marker: "mirrors",
    reason:
      "The corpus mirror itself, gated by the same `const mirrors = ...` ternary whose false " +
      "branch is `{ data: null, error: null }`. Off the unified-search plane the memory's " +
      "content never enters `thoughts` - not a redacted stub either, because a stub carrying " +
      "the real embedding is still an oracle.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `await supabase.from("agent_memory_recall_traces").select("*")
    .eq("request_id", request_id)
    .containedBy("request_payload->enforced_exposure", DOOR_PLANE as string[])
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!trace) return c.json({ error: "not found" }, 404, corsHeaders);

  for (const memory_id of parsed.data.used_memory_ids) {
    await supabase.from("agent_memory_recall_items").update({ used: true }).eq("trace_id", trace.id).eq("memory_id", memory_id);`,
    marker: "DOOR_PLANE",
    reason:
      "The usage route's trace read, pinned together with the recall_items UPDATE that " +
      "follows it - the update is scoped to `trace.id` and inherits this bound, so pinning " +
      "them as one block is what makes 'it inherits the bound' a fact about the text rather " +
      "than a claim about the control flow. Containment rather than equality because " +
      "enforced_exposure is a LIST.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `await supabase.from("agent_memory_recall_items").update({ used: false, ignored_reason: ignored.reason ?? null }).eq("trace_id", trace.id).eq("memory_id", ignored.memory_id);`,
    marker: "trace.id",
    reason:
      "The other half of the same loop, scoped to the same plane-bounded `trace.id`. It " +
      "returns no rows (no .select()), so it cannot disclose one; what it must not be able " +
      "to do is write into a trace on another plane, and `trace` came from the pinned read " +
      "above.",
  },
  {
    file: "integrations/agent-memory-api/index.ts",
    sql: `await supabase.from("agent_memory_recall_traces").select("*")
    .eq("request_id", request_id)
    .containedBy("request_payload->enforced_exposure", DOOR_PLANE as string[])
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500, corsHeaders);
  if (!trace) return c.json({ error: "not found" }, 404, corsHeaders);
  const { data: items, error: itemError } = await supabase.from("agent_memory_recall_items").select("*, agent_memories(*)").eq("trace_id", trace.id).order("rank");
  if (itemError) return c.json({ error: itemError.message }, 500, corsHeaders);`,
    marker: "DOOR_PLANE",
    reason:
      "The trace GET. The ENVELOPE is the disclosure here - it carries the recall's query " +
      "text, which names what an agent went looking for even when every item is dropped - so " +
      "the trace read and the item read are pinned as one block. The embedded " +
      "`agent_memories(*)` join is NOT the boundary: an item carries memory_id, rank and the " +
      "use-policy snapshot in its own columns, so the whole item is dropped and audited in " +
      "the loop below, not merely blanked.",
  },
];

/**
 * THE AUDIT, as a pure function over {file -> source}.
 *
 * Pure on purpose. The real gate feeds it the scanned set read from disk; the red-proofs
 * below feed it the same set plus one synthetic file with an arbitrary NAME IN AN ARBITRARY
 * ROOT, so "a new unguarded resolver is caught wherever it lives" is proven by the same code
 * path that does the real check - not by a second, friendlier one.
 */
function auditSources(
  sources: Map<string, string>,
  tables: readonly string[],
  corpusFns: readonly { name: string; reads: boolean }[],
  exempt: readonly Exemption[],
  pinned: readonly Pin[],
): string[] {
  const offenders: string[] = [];
  for (const ex of exempt) {
    if (!sources.has(ex.file)) offenders.push(`EXEMPT names a file that is not scanned: ${ex.file}`);
  }
  for (const pin of pinned) {
    if (!sources.has(pin.file)) offenders.push(`PINNED names a file that is not scanned: ${pin.file}`);
    if (!pin.sql.includes(pin.marker)) {
      offenders.push(`PINNED entry for ${pin.file} does not contain its own marker "${pin.marker}"`);
    }
  }
  for (const [file, src] of sources) {
    if (file === CHOKEPOINT) continue; // statements here ARE the guarded path
    let body = stripComments(src);
    for (const pin of pinned.filter((p) => p.file === file)) {
      const before = body;
      body = body.replace(pin.sql, "");
      if (body === before) {
        offenders.push(
          `${file}: PINNED statement no longer matches - "${pin.sql.slice(0, 60)}..."`,
        );
      }
    }
    for (const ex of exempt.filter((e) => e.file === file)) {
      const before = body;
      body = body.replace(ex.sql, "");
      if (body === before) {
        offenders.push(
          `${file}: allow-list entry no longer matches any statement - "${ex.sql.slice(0, 60)}..."`,
        );
      }
    }
    const { refs, unrecognised } = tableRefs(body, [...tables, CORPUS], corpusFns);
    for (const u of unrecognised) offenders.push(`${file}: ${u}`);
    const corpusWrites = refs.filter(
      (r) => r.table === CORPUS && (r.keyword === "INTO" || r.keyword === "UPDATE"),
    ).length;
    const strips = [...body.matchAll(/stripCorpusClaim\(/g)].length;
    for (const ref of refs) {
      if (ref.table === CORPUS) {
        // THE CORPUS'S RULE IS ABOUT ITS LABEL. A row with no `metadata.exposure` is
        // unclaimed general corpus and readable everywhere, so a hand-written corpus WRITE
        // is safe exactly when it cannot mint a claim - which is what stripCorpusClaim
        // guarantees, and why `capture_thought`'s caller-supplied metadata_extra goes
        // through it. A corpus READ, by contrast, must be plane-bound like any other.
        if (ref.keyword === "INTO" || ref.keyword === "UPDATE") {
          if (strips >= corpusWrites) continue;
          offenders.push(
            `${file}: "${ref.text}" writes the shared corpus without stripCorpusClaim - a ` +
              `caller-supplied metadata.exposure would mint a plane claim.`,
          );
          continue;
        }
        offenders.push(
          `${file}: "${ref.text}" reads the shared corpus with no exposure plane. Route it ` +
            `through ${CHOKEPOINT}, or PIN the statement with the predicate inside it.`,
        );
        continue;
      }
      // AN APPEND TO A SIDECAR CANNOT DISCLOSE AN EXISTING ROW. `INSERT INTO
      // agent_memory_audit_events` / `_recall_traces` / `_recall_items` writes new rows from
      // values the caller already has; there is no result set for a plane predicate to
      // bound. `INSERT INTO agent_memories` is NOT covered by this - that one stamps the
      // exposure that every later read depends on, so it carries an explicit exemption.
      if (ref.keyword === "INTO" && ref.table !== "agent_memories") continue;
      offenders.push(
        `${file}: "${ref.text}" is neither routed through ${CHOKEPOINT} nor on the ` +
          `allow-list. Route it through the chokepoint, or add an EXEMPT/PINNED entry ` +
          `with a reason.`,
      );
    }
  }
  return offenders;
}

Deno.test("the scan roots are derived from the DEPLOYMENT, not from a list", async () => {
  const roots = await scanRoots();
  // The two roots the last round's gate could not see, and the one it could.
  for (
    const r of [
      "integrations/kubernetes-deployment",
      "docker/extensions-server",
      "integrations/agent-memory-api",
    ]
  ) {
    assertEquals(roots.includes(r), true, `scan roots are missing ${r}: ${roots}`);
  }
  // A floor, so a compose file that parses to one context does not silently shrink the gate.
  assertEquals(roots.length >= 10, true, `expected 10+ scan roots, derived ${roots.length}`);
  const files = await shippingFiles();
  assertEquals(files.includes(CHOKEPOINT), true);
  assertEquals(files.includes("docker/extensions-server/index.ts"), true);
  assertEquals(files.includes("integrations/agent-memory-api/index.ts"), true);
  assertEquals(files.some((f) => f.endsWith(".test.ts")), false, "a test file must not be scanned");
});

Deno.test("the openbrain-mcp set still matches the Dockerfile's OWN rule", async () => {
  // The derivation is only as true as the Dockerfile it reproduces. If the image stops being
  // "*.ts minus *.test.ts", the file-level assertions are scanning the wrong set - quietly,
  // and in the direction that passes.
  const df = await readSource("Dockerfile");
  assertEquals(df.includes("COPY *.ts ./"), true, "Dockerfile no longer globs *.ts");
  assertEquals(df.includes("rm -f *.test.ts"), true, "Dockerfile no longer drops the tests");
  const files = await shippingFiles();
  assertEquals(files.includes("integrations/kubernetes-deployment/index.ts"), true);
});

Deno.test("the memory-table list is derived from the SQL that creates the tables", async () => {
  const tables = await memoryTables();
  for (const t of ["agent_memories", "agent_memory_recall_traces", "agent_memory_recall_items"]) {
    assertEquals(tables.includes(t), true, `derived table list is missing ${t}: ${tables}`);
  }
  assertEquals(tables.length >= 8, true, `expected at least 8 memory tables, derived ${tables.length}`);
});

Deno.test("EVERY memory- or corpus-table statement is routed, pinned or allow-listed", async () => {
  // THE TEST THIS FILE EXISTS FOR - over the derived root set, the derived file set, the
  // derived table set and the derived corpus-function set, rather than over lists somebody
  // typed.
  const offenders = auditSources(
    await shippingSources(),
    await memoryTables(),
    await corpusFunctions(),
    EXEMPT,
    PINNED,
  );
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("ops and tools resolve NOTHING by hand - zero read statements", async () => {
  const tables = await memoryTables();
  for (
    const file of [
      "integrations/kubernetes-deployment/agent-memory-ops.ts",
      "integrations/kubernetes-deployment/agent-memory-tools.ts",
    ]
  ) {
    const { refs } = tableRefs(await readRepo(file), tables);
    const reads = refs.filter((r) => r.keyword !== "INTO");
    assertEquals(reads, [], `${file} still resolves memory rows by hand: ${JSON.stringify(reads)}`);
  }
});

Deno.test("index.ts resolves NO corpus row by hand - every read is the chokepoint's", async () => {
  // The six `FROM thoughts` statements that leaked. There must be none left.
  const src = await readRepo("integrations/kubernetes-deployment/index.ts");
  const { refs } = tableRefs(src, [CORPUS]);
  const reads = refs.filter((r) => r.keyword === "FROM" || r.keyword === "JOIN");
  assertEquals(reads, [], `index.ts still reads the corpus by hand: ${JSON.stringify(reads)}`);
  // ...and it really does read the corpus, so this is not passing over an empty file. The
  // call sites are generic (`selectCorpusOnPlane<ThoughtMatch>(`), so the name is matched
  // without the paren - the first version of this assertion looked for "name(" and was
  // false for the right code, which is the direction that at least fails loudly.
  assertEquals([...src.matchAll(/selectCorpusOnPlane</g)].length, 5, "five corpus SELECTs");
  assertEquals([...src.matchAll(/resolveCorpusRowOnPlane</g)].length, 1, "one by-id resolve");
});

Deno.test("every allow-list and pin carries a real reason, and the lists stay SHORT", async () => {
  const sources = await shippingSources();
  for (const ex of [...EXEMPT, ...PINNED]) {
    assertEquals(sources.has(ex.file), true, `names a file that is not scanned: ${ex.file}`);
    assertEquals(ex.reason.length > 120, true, `reason too thin for ${ex.file}: ${ex.reason}`);
  }
  for (const pin of PINNED) {
    assertEquals(
      pin.sql.includes(pin.marker),
      true,
      `PINNED ${pin.file}: sql does not contain marker "${pin.marker}"`,
    );
  }
  // Growing these is how a chokepoint dissolves one reasonable-looking exception at a time;
  // raising a number should feel like a decision, because it is one.
  assertEquals(EXEMPT.length <= 6, true, `the allow-list has grown to ${EXEMPT.length}`);
  assertEquals(PINNED.length <= 12, true, `the pin list has grown to ${PINNED.length}`);
});

// ---------------------------------------------------------------------------------
// THE CORPUS'S OTHER READERS - SQL functions, and the copy in another image
// ---------------------------------------------------------------------------------

Deno.test("every corpus-READING SQL function's LAST definition carries the plane", async () => {
  // `match_thoughts` RETURNS content and `upsert_thought` RETURNS public.thoughts, and both
  // are reachable without touching a line of this repo's TypeScript - PostgREST exposes them
  // as `rpc/*`. A boundary that stops at the application layer has a documented way round it.
  //
  // LAST definition, because init.sql defines match_thoughts unguarded and
  // init-agent-memory-corpus-plane.sql replaces it later in the chain. The mount ORDER comes
  // from compose's own `NNN-` prefixes, so adding an unguarded redefinition at a higher
  // number is red.
  const fns = await corpusFunctions();
  const readers = fns.filter((f) => f.reads);
  assertEquals(readers.length >= 2, true, `expected match_thoughts and upsert_thought: ${JSON.stringify(fns)}`);
  const byName = new Map<string, SqlFn>();
  for (const f of readers) {
    const prev = byName.get(f.name);
    if (!prev || f.order > prev.order) byName.set(f.name, f);
  }
  const bad = [...byName.values()].filter((f) => !f.hasPlane);
  assertEquals(
    bad,
    [],
    `corpus-reading functions whose final definition has no exposure predicate: ` +
      JSON.stringify(bad),
  );
  for (const n of ["match_thoughts", "upsert_thought"]) {
    assertEquals(byName.has(n), true, `${n} was not derived as a corpus reader: ${[...byName.keys()]}`);
  }
});

Deno.test("the SQL predicate and the TypeScript predicate say the same thing", async () => {
  // Two languages, one rule. The SQL cannot call corpusPlanePredicate, so the parts are
  // asserted: the IS NULL half, the membership half, and the plane it hard-codes - which
  // must be exactly UNIFIED_SEARCH_EXPOSURES, or the database would serve a plane the mirror
  // refuses to write to (or worse, the other way round).
  const sql = await readRepo("docker/init-agent-memory-corpus-plane.sql");
  const ts = corpusPlanePredicate(1);
  assertEquals(ts, `(metadata->>'exposure' IS NULL OR metadata->>'exposure' = ANY($1))`);
  assertEquals(sql.includes("metadata->>'exposure' IS NULL"), true);
  // Comments stripped first: the file's own header quotes the predicate, and counting the
  // prose alongside the code is how a check starts passing for the wrong reason.
  const sqlCode = sql.replace(/^[ 	]*--.*$/gm, "");
  assertEquals([...sqlCode.matchAll(/= ANY\(ARRAY\['ops'\]\)/g)].length, 2, "both functions");
  assertEquals([...UNIFIED_SEARCH_EXPOSURES], ["ops"], "the SQL hard-codes ['ops']");
  // Mounted in BOTH compose files, or a fresh preview volume gets the unguarded function.
  for (const f of ["docker/docker-compose.yml", "docker/docker-compose.preview.yml"]) {
    assertEquals(
      (await readRepo(f)).includes("init-agent-memory-corpus-plane.sql"),
      true,
      `${f} does not mount the corpus-plane SQL`,
    );
  }
});

Deno.test("extensions-server's COPY of the predicate is character-identical", async () => {
  // The openbrain-ext image cannot import the chokepoint (different build context, and its
  // Dockerfile copies one file), so it carries its own copy. Copying is what failed three
  // rounds of this work, so the copy is pinned HERE: divergence is red, in either direction.
  const ext = await readRepo("docker/extensions-server/index.ts");
  const copied = ext.match(
    /function corpusPlanePredicate\(paramIndex: number, alias = ""\): string \{([\s\S]*?)\n\}/,
  );
  assertEquals(!!copied, true, "extensions-server no longer defines corpusPlanePredicate");
  const chokepoint = (await readSource("agent-memory-plane.ts")).match(
    /export function corpusPlanePredicate\(paramIndex: number, alias = ""\): string \{([\s\S]*?)\n\}/,
  );
  assertEquals(!!chokepoint, true, "the chokepoint no longer defines corpusPlanePredicate");
  assertEquals(copied![1].trim(), chokepoint![1].trim(), "the two predicates have diverged");
  // ...and the copy is really the one the statements use.
  assertEquals(ext.includes("${corpusPlanePredicate(1)}"), true);
  // The door value is server-side and defaults to the narrow plane, exactly as doorPlane does.
  assertEquals(ext.includes(`Deno.env.get("DOOR_EXPOSURE") || "ops"`), true);
  assertEquals(ext.includes("Object.freeze([DOOR_EXPOSURE])"), true, "an unfrozen plane can be widened");
});

// ---------------------------------------------------------------------------------
// RED-PROOFS - one per property, each demonstrated failing
// ---------------------------------------------------------------------------------

/** The real set plus one synthetic file, fed to the real audit function. */
async function withInjected(name: string, src: string): Promise<string[]> {
  const sources = await shippingSources();
  assertEquals(sources.has(name), false, `${name} already exists - pick another probe name`);
  sources.set(name, src);
  return auditSources(sources, await memoryTables(), await corpusFunctions(), EXEMPT, PINNED);
}

Deno.test("RED: a new unguarded resolver is caught WHATEVER IT IS NAMED", async () => {
  // THE VERIFIER'S EXACT DEFEAT, as a permanent test. This is the file and the statement that
  // produced `deno check` exit 0 and 154 passed | 0 failed under the gate two rounds ago, and
  // it is named nothing like the others on purpose.
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/corpus-index.ts",
    "export async function lookup(c: { queryObject: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }, id: string) {\n" +
      "  return await c.queryObject(`SELECT id, summary, content, metadata FROM agent_memories WHERE id = $1`, [id]);\n" +
      "}\n",
  );
  assertEquals(offenders.length, 1, `expected exactly one finding, got: ${offenders.join(" | ")}`);
  assertEquals(offenders[0].includes("corpus-index.ts"), true, offenders[0]);
});

Deno.test("RED: caught in ANOTHER IMAGE's directory, not just this one", async () => {
  // THE HOLE THIS ROUND CLOSED. Two real unguarded readers lived outside
  // integrations/kubernetes-deployment and the gate could not see either of them. Same
  // statement, planted in the openbrain-ext image under a name that belongs there.
  const offenders = await withInjected(
    "docker/extensions-server/contacts-util.ts",
    "export const byId = `SELECT id, content, metadata FROM thoughts WHERE id = $1`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("contacts-util.ts"), true, offenders[0]);
  assertEquals(offenders[0].includes("reads the shared corpus"), true, offenders[0]);
});

Deno.test("RED: caught in the supabase-js SHAPE, not just raw SQL", async () => {
  // agent-memory-api does not write SQL strings at all. A gate that only knows `FROM x` sees
  // nothing in it - which is how a whole door stayed unguarded through four rounds.
  const offenders = await withInjected(
    "integrations/agent-memory-api/helpers.ts",
    'export const load = (s: { from: (t: string) => { select: (c: string) => unknown } }, id: string) =>\n' +
      '  s.from("agent_memories").select("*");\n',
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes('.from("agent_memories").select'), true, offenders[0]);
});

Deno.test("RED: caught when it goes through an RPC instead of a table", async () => {
  // `match_thoughts` RETURNS content and does not match \bthoughts\b, because `_` is a word
  // character. Before the corpus-function derivation this was a completely silent way in.
  const offenders = await withInjected(
    "integrations/research-service/lookup.ts",
    'export const search = (s: { rpc: (f: string, a: unknown) => unknown }, e: number[]) =>\n' +
      '  s.rpc("match_thoughts", { query_embedding: e });\n',
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("match_thoughts"), true, offenders[0]);
});

Deno.test("RED: caught whatever MEMORY TABLE it reads, not just agent_memories", async () => {
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/trace-helpers.ts",
    "const a = `SELECT query FROM agent_memory_recall_traces WHERE id = $1`;\n" +
      "const b = `SELECT memory_id, rank FROM agent_memory_recall_items WHERE trace_id = $1`;\n" +
      "const c = `SELECT action FROM agent_memory_review_actions WHERE memory_id = $1`;\n" +
      "export const q = [a, b, c];\n",
  );
  assertEquals(offenders.length, 3, offenders.join(" | "));
  assertEquals(offenders.every((o) => o.includes("trace-helpers.ts")), true, offenders.join(" | "));
});

Deno.test("RED: caught whatever VERB it uses - an UPDATE is not a read", async () => {
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/fixups.ts",
    "export const widen = `UPDATE agent_memories SET metadata = metadata || '{\"exposure\":\"ops\"}' WHERE id = $1`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("UPDATE agent_memories"), true, offenders[0]);
});

Deno.test("RED: an INSERT into agent_memories is NOT waved through as an append", async () => {
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/importer.ts",
    "export const q = `INSERT INTO agent_memories (id, content, metadata) VALUES ($1,$2,$3)`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
});

Deno.test("RED: a hand-written corpus write that can MINT A CLAIM is caught", async () => {
  // The label is a capability: whoever writes `metadata.exposure` decides which door sees the
  // row. capture_thought merges caller-supplied metadata_extra verbatim, so without
  // stripCorpusClaim a caller could mint one.
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/inlet.ts",
    "export const q = `INSERT INTO thoughts (content, embedding, metadata) VALUES ($1,$2,$3)`;\n",
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("stripCorpusClaim"), true, offenders[0]);
});

Deno.test("a corpus write THROUGH stripCorpusClaim is deliberately not a finding", async () => {
  // The other direction: the rule is "you may not mint a claim", not "nobody may write the
  // corpus". capture_thought and the idea inlet are ordinary, legitimate corpus writers.
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/inlet2.ts",
    'import { stripCorpusClaim } from "./agent-memory-plane.ts";\n' +
      "export const q = `INSERT INTO thoughts (content, embedding, metadata) VALUES ($1,$2,$3)`;\n" +
      "export const m = (x: Record<string, unknown>) => stripCorpusClaim(x);\n",
  );
  assertEquals(offenders, []);
});

Deno.test("an append to a SIDECAR is deliberately not a finding", async () => {
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/eventlog.ts",
    "export const q = `INSERT INTO agent_memory_audit_events (memory_id, event_type) VALUES ($1,$2)`;\n",
  );
  assertEquals(offenders, []);
});

Deno.test("a comment mentioning a table is NOT a finding", async () => {
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/notes.ts",
    "// see agent_memories for the schema\n/* agent_memory_recall_traces again */\nexport const x = 1;\n",
  );
  assertEquals(offenders, []);
});

Deno.test("a table name in a shape the matcher does not know still FAILS", async () => {
  // The safe direction, asserted rather than assumed. If a statement uses a form none of the
  // three matchers knows, the bare-name count exceeds the matched count and that discrepancy
  // is reported - the gate does not get to be silently blind.
  const offenders = await withInjected(
    "integrations/kubernetes-deployment/weird.ts",
    'export const q = "SELECT * FROM " + "public." + `agent_memories WHERE id = $1`;\n',
  );
  assertEquals(offenders.length >= 1, true, "an unrecognised reference must not pass");
  assertEquals(offenders[0].includes("agent_memories appears"), true, offenders[0]);
});

Deno.test("the runner passes --allow-read, or this whole file proves nothing", async () => {
  // Guards the trap named in the header. `deno test` without --allow-read cannot read a
  // sibling file; a test that swallows that error passes while comparing nothing, which is
  // what the memory_type cross-reader test did.
  const self = await readSource("agent-memory-plane.ts");
  assertEquals(self.length > 1000, true, "could not read the chokepoint's own source");
  const tables = await memoryTables();
  assertEquals(tables.length > 0, true, "could not read the schema directory");
  const roots = await scanRoots();
  assertEquals(roots.length > 0, true, "could not read the compose file");
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

// ---------------------------------------------------------------------------------
// THE CORPUS DOOR - the read half of the second home
// ---------------------------------------------------------------------------------

Deno.test("the corpus predicate is PARENTHESISED, because it contains an OR", () => {
  // Without the outer parentheses `x AND a OR b` reads as `(x AND a) OR b`, and the second
  // branch has no plane in it. That precedence defeat was EXECUTED against this subsystem's
  // other query builder, against real Postgres, and returned both personal fixtures with
  // content. planePredicate is one equality and needs none; this one cannot go without.
  const p = corpusPlanePredicate(1);
  assertEquals(p.startsWith("("), true, p);
  assertEquals(p.endsWith(")"), true, p);
  assertEquals(p, `(metadata->>'exposure' IS NULL OR metadata->>'exposure' = ANY($1))`);
  assertEquals(
    corpusPlanePredicate(3, "t"),
    `(t.metadata->>'exposure' IS NULL OR t.metadata->>'exposure' = ANY($3))`,
  );
});

Deno.test("an UNCLAIMED corpus row is visible, a row claimed by another plane is not", () => {
  // The semantic difference from planePredicate, stated as a test rather than a comment.
  // `thoughts` predates the label: 12,989 of 12,993 production rows have none, and they are
  // the user's own Open Brain. COALESCEing them to 'personal' would not contain anything -
  // there is no agent-memory content among them - it would blank search_thoughts,
  // list_thoughts, thought_stats and Open WebUI's bridge.
  assertEquals(planePredicate(1).includes("COALESCE"), true, "memories default to personal");
  assertEquals(corpusPlanePredicate(1).includes("COALESCE"), false, "the corpus does not");
  assertEquals(corpusPlanePredicate(1).includes("IS NULL"), true, "unclaimed stays visible");
});

Deno.test("selectCorpusOnPlane starts the WHERE with the plane, before anything else", async () => {
  const r = recorder(() => []);
  await selectCorpusOnPlane(r.client, doorPlane({ doorExposure: "ops" }), (q) => {
    q.and(`metadata->>'type' = ${q.param("idea")}`);
    return { columns: "content", orderBy: "created_at DESC", limit: 10 };
  });
  const [sql, args] = r.seen[0];
  const where = sql.slice(sql.indexOf("WHERE"));
  assertEquals(
    where.startsWith(`WHERE ${corpusPlanePredicate(1)}`),
    true,
    `the plane must be the FIRST clause: ${where}`,
  );
  assertEquals(args[0], ["ops"], "the plane binds $1");
  assertEquals(args[1], "idea");
  assertEquals(args[2], 10, "the limit is bound, never interpolated");
});

Deno.test("every selectCorpusOnPlane fragment is PARENTHESISED - one OR must not escape", async () => {
  const r = recorder(() => []);
  await selectCorpusOnPlane(r.client, doorPlane({}), (q) => {
    // The exact shape that defeated the memory-side builder: an ordinary-looking OR.
    q.and(`a = ${q.param(1)} OR b = ${q.param(2)}`);
    q.and(`c = ${q.param(3)}`);
    return { columns: "content" };
  });
  const [sql] = r.seen[0];
  assertEquals(sql.includes("AND (a = $2 OR b = $3)"), true, sql);
  assertEquals(sql.includes("AND (c = $4)"), true, sql);
});

Deno.test("selectCorpusOnPlane with no fragments at all is still plane-bounded", async () => {
  // thought_stats' COUNT. A count is a disclosure too: "Total thoughts: 12,994" after a
  // personal memory is written tells a caller that something it may not read exists.
  const r = recorder(() => [{ count: 3 }]);
  await selectCorpusOnPlane(r.client, doorPlane({}), () => ({ columns: "COUNT(*)::int AS count" }));
  const [sql, args] = r.seen[0];
  assertEquals(sql.includes(corpusPlanePredicate(1)), true, sql);
  assertEquals(sql.includes("ORDER BY"), false, "no ORDER BY was asked for");
  assertEquals(sql.includes("LIMIT"), false, "no LIMIT was asked for");
  assertEquals(args, [["ops"]]);
});

Deno.test("resolveCorpusRowOnPlane returns an ON-plane row and writes NO audit row", async () => {
  const r = recorder((sql) => (sql.includes("SELECT id, content") ? [{ id: 7 }] : []));
  const out = await resolveCorpusRowOnPlane<{ id: number }>(
    r.ctx,
    doorPlane({ doorExposure: "ops" }),
    "7",
    { columns: "id, content", tool: "fetch" },
  );
  assertEquals(out, { ok: true, row: { id: 7 } });
  assertEquals(r.seen.length, 1, "a hit must not run the existence probe");
});

Deno.test("an OFF-PLANE corpus row is not_found AND leaves an audit row naming the tool", async () => {
  // The refusal shape U5 requires: mechanically stopped AND visible in an audit record.
  const r = recorder((sql) => (sql.includes("NOT (metadata") ? [{ "?column?": 1 }] : []));
  const out = await resolveCorpusRowOnPlane(r.ctx, doorPlane({}), "42", {
    columns: "id, content",
    tool: "fetch",
  });
  assertEquals(out, { ok: false, refused: "not_found" });
  const audit = r.seen.find(([s]) => s.includes("agent_memory_audit_events"));
  assertEquals(!!audit, true, "a refused corpus read must leave a record");
  const payload = JSON.parse(audit![1][1] as string);
  assertEquals(payload.tool, "fetch");
  assertEquals(payload.reason, "off-plane-corpus-row:42");
  // memory_id NULL: a corpus row is not a memory, and that column is a FK into agent_memories.
  assertEquals(audit![1][0], null);
});

Deno.test("a genuinely ABSENT corpus id writes no audit row", async () => {
  // Otherwise every typo becomes a refusal record and the rows that mean "somebody reached
  // for the personal plane" are buried in them.
  const r = recorder(() => []);
  const out = await resolveCorpusRowOnPlane(r.ctx, doorPlane({}), "nope", {
    columns: "id",
    tool: "fetch",
  });
  assertEquals(out, { ok: false, refused: "not_found" });
  assertEquals(r.seen.some(([s]) => s.includes("agent_memory_audit_events")), false);
});

Deno.test("the existence probe is plane-NEGATED, so a caller's own filter is not a refusal", async () => {
  // The difference from resolveMemoryOnPlane. A corpus read carries the caller's
  // metadata_filter, so a miss has three causes and only one of them is a refusal. A
  // plane-FREE probe would file an ordinary filtered lookup as a probe.
  const r = recorder(() => []);
  await resolveCorpusRowOnPlane(r.ctx, doorPlane({}), "9", {
    columns: "id",
    tool: "fetch",
    build: (q) => q.and(`metadata @> ${q.param('{"type":"idea"}')}::jsonb`),
  });
  const probe = r.seen[1][0];
  assertEquals(probe.includes(`NOT ${corpusPlanePredicate(1)}`), true, probe);
  assertEquals(probe.includes("metadata @>"), false, "the probe must not carry the caller's filter");
  assertEquals(r.seen[0][0].includes("AND (metadata @> $3::jsonb)"), true, "...but the read must");
});

Deno.test("stripCorpusClaim removes an exposure a caller tried to mint", () => {
  // capture_thought merges caller-supplied metadata_extra verbatim. The label decides which
  // door sees a row, so writing it is a capability and it belongs to the chokepoint.
  assertEquals(stripCorpusClaim({ type: "idea", exposure: "personal" }), { type: "idea" });
  assertEquals(stripCorpusClaim({ exposure: "ops" }), {});
  assertEquals(stripCorpusClaim({ a: 1 }), { a: 1 }, "it must not eat anything else");
});
