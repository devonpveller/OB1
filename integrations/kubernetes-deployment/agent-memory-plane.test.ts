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
 *   THE ROOTS  - every `build: context:` in `docker/docker-compose.yml`, PLUS every repo
 *                directory a compose service BIND-MOUNTS into a container. The mount half
 *                was round five's hole: `../recipes:/recipes:ro` is built by nothing, so no
 *                `context:` names it, while wiki-service EXECUTES two of its scripts on a
 *                schedule.
 *   THE FILES  - every file under those roots that is not classified NON_CODE, read from
 *                disk. NOT ".ts": see the walk below for the measurement that made that a
 *                defect. A root that contributes ZERO scanned files is an ERROR, because
 *                that is the shape the defect took.
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

/** A repo directory a compose service mounts into a container, with where it lands. */
interface MountedRoot {
  root: string;
  mountPoint: string;
}

/**
 * Repo directories BIND-MOUNTED into containers as executable code.
 *
 * ROUND FIVE'S GATE DERIVED ITS ROOTS FROM `build: context:` AND THAT WAS ITS NEXT HOLE.
 * `../recipes:/recipes:ro` is mounted into openbrain-wiki and openbrain-workbench (compose
 * lines 733 and 851). Nothing BUILDS it, so no `context:` names it, and it was in no root
 * at all - while `wiki-service.mjs` executes `/recipes/entity-wiki/generate-wiki.mjs` on a
 * schedule and the workbench imports `/recipes/_shared/slug.mjs` at runtime. Code that runs
 * in a container is in scope whether the image contains it or the host hands it over.
 *
 * DERIVED, not listed: every `- <relative path>:<container path>` volume entry whose repo
 * side resolves to a DIRECTORY. The initdb `.sql` mounts and the Caddyfile resolve to FILES
 * and fall out on their own (and the `.sql` chain has its own reader below).
 */
async function mountedRoots(): Promise<MountedRoot[]> {
  const compose = await readRepo(COMPOSE);
  const out: MountedRoot[] = [];
  const seen = new Set<string>();
  for (
    const m of compose.matchAll(/^\s*-\s*(\.\.?\/[A-Za-z0-9._\/-]+):(\/[A-Za-z0-9._\/-]+)/gm)
  ) {
    const raw = m[1].replace(/^\.\//, "");
    const rel = (raw.startsWith("../") ? raw.slice(3) : `docker/${raw}`).replace(/\/$/, "");
    if (seen.has(rel)) continue;
    if (!await isDir(rel)) continue; // a FILE mount is not a code root
    seen.add(rel);
    out.push({ root: rel, mountPoint: m[2].replace(/\/$/, "") });
  }
  return out;
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
  const mounts = await mountedRoots();
  if (mounts.length === 0) {
    throw new Error(`no directory bind-mounts parsed from ${COMPOSE} - ../recipes would be unscanned`);
  }
  for (const m of mounts) roots.add(m.root);
  for (const e of EXTRA_ROOTS) roots.add(e.root);
  const out = [...roots].sort();
  for (const r of out) {
    if (!await isDir(r)) throw new Error(`scan root does not exist: ${r}`);
  }
  return out;
}

/**
 * WHAT COUNTS AS CODE - and the answer being ".ts" is the defect round five shipped.
 *
 * The walk was `if (!e.name.endsWith(".ts")) continue`. Measured per root, that scanned
 * NOTHING in five of fourteen: `docker/wiki-service` is 5 `.mjs` and 0 `.ts`;
 * `docker/backup` is 3 `.sh`; `docker/extract` is 1 `.py`; `docker/wiki-viewer` is 2 `.ts`
 * beside 13 `.mjs`/`.js`; `integrations/agent-memory-api` is 1 `.ts` beside 3 `.mjs`. A
 * verifier put an unguarded reader of `thoughts`, `agent_memories`,
 * `agent_memory_recall_items` and `agent_memory_review_actions` into `docker/wiki-service`,
 * shipped by that image, and this suite stayed 213 passed / 0 failed - purely because the
 * file was named `.mjs`. The identical bytes named `.ts` failed 13 tests.
 *
 * SO THE EXTENSION SET IS DERIVED THE WAY EVERYTHING ELSE HERE IS: it is whatever the roots
 * CONTAIN, minus a written list of what is not code. The direction of the default is the
 * whole point - a language nobody thought of is SCANNED, and the only way to stop scanning
 * one is to name it below with a reason. Round five had the list the other way round, and a
 * list of what to INCLUDE is a list you can be short of.
 */
interface NonCode {
  ext: string;
  why: string;
}

const NON_CODE: NonCode[] = [
  { ext: ".json", why: "configuration and manifests - a key is not a statement" },
  { ext: ".md", why: "prose. A comment naming a table is explicitly not a finding here" },
  { ext: ".txt", why: "prose (requirements.txt, notes)" },
  { ext: ".lock", why: "dependency lockfiles - machine-written, no statements" },
  { ext: ".example", why: "`.env.example` templates - variable names, never a query" },
  {
    ext: ".yml",
    why:
      "compose and CI configuration. compose is READ by this file as the derivation source " +
      "for roots, mounts and the initdb chain; it is not scanned as a reader",
  },
  { ext: ".css", why: "stylesheets - declarations, with no way to reach a database" },
  { ext: ".svg", why: "vector image markup - shipped as an asset, executed by nothing" },
  {
    ext: ".pyc",
    why: "compiled Python BYTECODE - binary, and reading it as text is a decode error, not a scan",
  },
];

/**
 * Files with NO EXTENSION, or whose suffix is not one (`Dockerfile.postgres`, `.env`).
 *
 * `extensionOf(".env")` is "" - a dotfile's leading dot is not an extension separator - so
 * these cannot be classified by the list above and would fall through it. Anything here is
 * matched by NAME.
 */
const NON_CODE_NAMES: NonCode[] = [
  {
    ext: ".env",
    why:
      "GITIGNORED secret VALUES. Not present in a fresh clone, so a gate that read them " +
      "would give different verdicts in different checkouts - and it is credentials, not " +
      "code. `.env.example` is excluded separately, by extension.",
  },
  {
    ext: ".gitignore",
    why:
      "path patterns for git. Not executed by anything, and the only table name it could " +
      "contain would be part of a filename.",
  },
  {
    ext: "Dockerfile",
    why:
      "build instructions, not a running reader - and NOT waved through: a test below " +
      "asserts that no Dockerfile under a scan root names a memory or corpus table, so a " +
      "RUN line that shelled out to psql would still be caught.",
  },
];

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i);
}

function isNonCodeName(name: string): boolean {
  return NON_CODE_NAMES.some((n) => name === n.ext || name.startsWith(`${n.ext}.`));
}

/** A test file - inventoried, never scanned as a shipping reader. */
function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[a-z]+$/.test(name);
}

/**
 * WHICH MOUNTED FILES THE DEPLOYMENT ACTUALLY RUNS - derived, never listed.
 *
 * `../recipes` is 300+ files. Two of them are executed by a service on a schedule
 * (`RECIPE_PATH`, `SYNTH_PATH`), a handful more are imported by those two and by the
 * workbench, and the rest are one-off import scripts a person runs by hand with their own
 * credentials. Both classes read the corpus. They are NOT the same risk and this gate says
 * so rather than averaging them:
 *
 *   INVOKED  - reached from compose or from an image's own source through the mount point,
 *              plus everything those files import, transitively. These must be CLEAN: zero
 *              findings, exactly like a built image's source.
 *   RESIDUAL - mounted and readable inside two containers, but nothing in the deployment
 *              starts them. These are INVENTORIED below with their finding counts. Not
 *              waved through: the count is pinned, so a new unguarded reader anywhere under
 *              a mounted root moves a number and the suite goes red.
 *
 * The seeds come from string literals naming the CONTAINER path (`/recipes/...`), which is
 * how a mounted file is named by whatever runs it - `RECIPE_PATH: /recipes/entity-wiki/
 * generate-wiki.mjs` in compose, `file:///recipes/_shared/slug.mjs` in wiki-service.mjs,
 * `"file:///recipes/_shared/slug.mjs"` in the workbench's import map.
 */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/from\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of stripComments(src).matchAll(/import\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of stripComments(src).matchAll(/require\(\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

async function invokedMountedFiles(sources: Map<string, string>): Promise<Set<string>> {
  const mounts = await mountedRoots();
  const invoked = new Set<string>();
  if (mounts.length === 0) return invoked;

  // Every text the deployment is made of: compose itself, plus every scanned source that
  // is NOT under a mounted root (i.e. every built image's code).
  const mountedRootNames = mounts.map((m) => m.root);
  const isMounted = (f: string) => mountedRootNames.some((r) => f === r || f.startsWith(`${r}/`));
  const haystacks: string[] = [await readRepo(COMPOSE)];
  for (const [f, src] of sources) if (!isMounted(f)) haystacks.push(src);

  const queue: string[] = [];
  for (const mnt of mounts) {
    const re = new RegExp(`${mnt.mountPoint}/([A-Za-z0-9._/-]+)`, "g");
    for (const hay of haystacks) {
      for (const m of hay.matchAll(re)) {
        const rel = `${mnt.root}/${m[1]}`;
        if (sources.has(rel) && !invoked.has(rel)) {
          invoked.add(rel);
          queue.push(rel);
        }
      }
    }
  }
  // FAIL-CLOSED: a mount whose entry points cannot be found means the seeds stopped
  // matching, and an empty INVOKED set would silently move every compiler statement into
  // the residual inventory - a gate that passes by reclassifying its subject.
  if (invoked.size === 0) {
    throw new Error(
      `no invoked file found under any bind-mount (${mountedRootNames.join(", ")}) - the ` +
        `entry-point seeds no longer match, so nothing would be held to the clean standard`,
    );
  }
  // Transitive closure over relative and mount-absolute imports.
  while (queue.length) {
    const file = queue.pop()!;
    for (const spec of importSpecifiers(sources.get(file) ?? "")) {
      let target: string | null = null;
      const rel = resolveRelative(file, spec);
      if (rel) target = rel;
      else {
        for (const mnt of mounts) {
          const i = spec.indexOf(`${mnt.mountPoint}/`);
          if (i !== -1) target = `${mnt.root}/${spec.slice(i + mnt.mountPoint.length + 1)}`;
        }
      }
      if (target && sources.has(target) && !invoked.has(target)) {
        invoked.add(target);
        queue.push(target);
      }
    }
  }
  return invoked;
}

/** The files held to the CLEAN standard: every built image's source, plus invoked mounts. */
async function guardedFiles(sources: Map<string, string>): Promise<Set<string>> {
  const mounts = await mountedRoots();
  const isMounted = (f: string) => mounts.some((m) => f === m.root || f.startsWith(`${m.root}/`));
  const invoked = await invokedMountedFiles(sources);
  const out = new Set<string>();
  for (const f of sources.keys()) if (!isMounted(f) || invoked.has(f)) out.add(f);
  return out;
}

/** Is this file code, by the derived rule? Everything is, unless NON_CODE says otherwise. */
function isCodeFile(name: string): boolean {
  if (isNonCodeName(name)) return false;
  const ext = extensionOf(name);
  if (ext === "") return false; // no extension and not a known name
  return !NON_CODE.some((n) => n.ext === ext);
}

/** Every non-test code file under a scan root, keyed by repo-relative path. */
async function walkCode(root: string, out: Map<string, string>): Promise<void> {
  for await (const e of Deno.readDir(new URL(`${root}/`, REPO))) {
    const rel = `${root}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walkCode(rel, out);
      continue;
    }
    if (!e.isFile) continue;
    if (isTestFile(e.name)) continue;
    if (!isCodeFile(e.name)) continue;
    out.set(rel, await readRepo(rel)); // normalised - see normalise()
  }
}

/** Every file under a scan root, code or not - for the classification tests below. */
async function walkAll(root: string, out: Set<string>): Promise<void> {
  for await (const e of Deno.readDir(new URL(`${root}/`, REPO))) {
    const rel = `${root}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      await walkAll(rel, out);
      continue;
    }
    if (e.isFile) out.add(rel);
  }
}

async function allFilesUnderRoots(): Promise<string[]> {
  const out = new Set<string>();
  for (const root of await scanRoots()) await walkAll(root, out);
  if (out.size === 0) throw new Error("no files under any scan root");
  return [...out].sort();
}

/**
 * The whole scanned set as {repo-relative path -> source}.
 *
 * INTENDED AS A SUPERSET OF WHAT SHIPS - and round five's version WAS NOT ONE, which is the
 * correction this round exists to make. That docblock said "a superset of what ships, on
 * purpose ... missing one that does is the bug this gate is for", and the walk it described
 * was `.ts`-only, so for five of fourteen roots it was a strict SUBSET containing nothing:
 * `docker/wiki-service` 0 of 5 files, `docker/backup` 0 of 3, `docker/extract` 0 of 1,
 * `docker/wiki-viewer` 2 of 15, `integrations/agent-memory-api` 1 of 4. A claim in a
 * docblock is not a property of the code; this one is now asserted by
 * "EVERY scan root contributes at least one scanned file" and by the membership test that
 * names real `.mjs`, `.sh`, `.py` and `.sql` files in the scanned set.
 *
 * Scanning a source that does not end up in an image costs a few milliseconds; missing one
 * that does is the bug this gate is for. The direction of the error is still chosen - it is
 * now also checked.
 */
async function shippingSources(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const root of await scanRoots()) {
    const before = m.size;
    await walkCode(root, m);
    // A ROOT THAT CONTRIBUTES NOTHING IS THE SIGNATURE OF THIS BUG, so it is an error and
    // not a quiet zero. Five roots were in exactly that state under the `.ts`-only walk
    // while the suite was green; the count that would have said so was never taken.
    if (m.size === before) {
      throw new Error(
        `scan root "${root}" contributed ZERO scanned files - either it is not a root, or ` +
          `one of the NON_CODE classifications below is wrong. This is the shape of the ` +
          `.ts-only defect.`,
      );
    }
  }
  if (m.size === 0) {
    throw new Error("no code files found under any scan root - every assertion would be vacuous");
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
  // A POSTGREST EMBEDDED RESOURCE WITH A JOIN HINT: `thoughts!inner(id,content,...)`. The
  // `(` is no longer the next character, and the whole thing lives inside a `select=`
  // string with no SQL keyword near it - so the compiler's ONE read that actually joins
  // the corpus was invisible to every matcher above until this line existed.
  if (body.slice(end).startsWith("!inner(") || body.slice(end).startsWith("!left(")) return true;
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
  // A POSTGREST RESOURCE: `thoughts?select=id&...`. The whole query is inside the string
  // literal, so there is no SQL keyword anywhere near it - which is exactly why every
  // statement in wiki-service.mjs and generate-wiki.mjs was invisible to the previous
  // matcher. `thoughts` is not the corpus here by coincidence of naming; it is the REST
  // resource for that table, and reading it is reading the table.
  if (new RegExp(`^${table}\\?`).test(frag.trim())) return true;
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
 * HTTP method -> the SQL keyword PostgREST turns it into.
 *
 * THE FOURTH SHAPE, and the one the wiki plane is written in. `wiki-service.mjs` and the
 * entity-wiki recipe do not use supabase-js and contain no SQL: they hand PostgREST a
 * RESOURCE STRING (`thoughts?select=id&metadata->>note_path=eq.x`) through a small `sb`
 * or `obFetch` helper. Every one of those statements reads or writes the shared corpus and
 * NONE of them matched anything above - which is how a scheduled service materialised
 * corpus content into a published wiki with no plane anywhere in the path.
 */
const REST_VERB: Record<string, string> = {
  get: "FROM",
  post: "INTO",
  patch: "UPDATE",
  put: "UPDATE",
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
    // SHAPE 5 - DDL. `CREATE TABLE thoughts (...)` / `CREATE INDEX ... ON thoughts` define
    // the relation; they select no row and can disclose none. Matched rather than ignored
    // so the bare-name reconciliation still balances - an unmatched name is what makes this
    // gate report a shape it does not know, and schema files are full of them.
    for (
      const m of body.matchAll(
        new RegExp(
          `CREATE\\s+(?:UNIQUE\\s+)?(?:TABLE|INDEX|TRIGGER)[\\s\\S]{0,90}?\\b(?:public\\.)?${table}\\b`,
          "gi",
        ),
      )
    ) {
      // A `CREATE TABLE x AS SELECT ... FROM thoughts` still matches FROM above, so a
      // materialisation is not swallowed by this.
      matched.push({ table, keyword: "DDL", text: m[0].replace(/\s+/g, " ").slice(0, 40) });
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
    // SHAPE 4a - a helper method named after the HTTP verb: sb.get("thoughts", "..."),
    // sb.patch(`thoughts?id=eq.${id}`, {...}).
    for (
      const m of body.matchAll(
        new RegExp(
          `\\.(get|post|patch|put|delete)\\(\\s*["'\`]${table}(\\?[^"'\`]*)?["'\`]`,
          "g",
        ),
      )
    ) {
      matched.push({
        table,
        keyword: REST_VERB[m[1]],
        text: `.${m[1]}("${table}${m[2] ? "?..." : ""}")`,
      });
    }
    // SHAPE 4b - the method as an ARGUMENT: obFetch("GET", `thoughts?select=id&...`).
    for (
      const m of body.matchAll(
        new RegExp(
          `["'](GET|POST|PATCH|PUT|DELETE)["']\\s*,\\s*["'\`]${table}(\\?[^"'\`]*)?["'\`]`,
          "g",
        ),
      )
    ) {
      matched.push({
        table,
        keyword: REST_VERB[m[1].toLowerCase()],
        text: `("${m[1]}", "${table}${m[2] ? "?..." : ""}")`,
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
  {
    file: "docker/wiki-service/wiki-service.mjs",
    sql: `await drainQueue("", "thoughts", deadline);`,
    reason:
      "NOT A STATEMENT. `\"thoughts\"` here is the LOG LABEL for one of the two worker " +
      "queues this service drains before a compile (the other call passes \"sources\"); the " +
      "drain itself is an HTTP POST to the entity worker and touches no table. Named " +
      "explicitly rather than made invisible by a cleverer matcher, because the matcher " +
      "erring toward reporting is what caught the real statements in this same file.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `      await sb.rpc("match_thoughts", {
        query_embedding: dummy,
        match_threshold: 0.99,
        match_count: 1,
        filter: {},
      });`,
    reason:
      "preflightEmbeddingDim's SIGNATURE PROBE. It calls the RPC with an all-zeros vector " +
      "and a 0.99 threshold purely to find out whether the 4-argument function exists, and " +
      "DISCARDS the result - there is no assignment. It cannot disclose a row because no " +
      "row it might return is ever read; what it can do is fail early with an actionable " +
      "message instead of 25 per-entity 404s, which is why it exists.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: "await sb.patch(`thoughts?id=eq.${thoughtId}`, { embedding });",
    reason:
      "The dossier's embedding write, onto the row `upsert_thought` returned one line " +
      "earlier in the same function - this run's own row, by the id that call handed back. " +
      "It writes ONLY `embedding`: no content, and no metadata, so there is no key through " +
      "which a plane claim could be minted, and no result set for a predicate to bound.",
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
  // ────────────────────────────────────────────────────────────────────────────────────
  // THE PUBLISHED WIKI - the reader round five did not have in any scan root.
  //
  // `wiki-service.mjs` runs `generate-wiki.mjs` on a schedule with `--batch` / `--ids` and
  // NEVER with `--semantic-expand`, so the published compile does not call `match_thoughts`
  // at all - the one corpus reader the SQL floor covers. It reads the TABLE, through
  // PostgREST, and writes what comes back into markdown pages and `wiki_pages` rows that
  // the viewer serves. These files are `.mjs` bind-mounted at runtime: they cannot import
  // the TypeScript chokepoint, so the predicate is IN the statement, from the one shared
  // module they CAN import (`_shared/corpus-plane.mjs`).
  // ────────────────────────────────────────────────────────────────────────────────────
  {
    file: "docker/wiki-service/wiki-service.mjs",
    sql: `const existing = await obFetch(
        "GET",
        \`thoughts?select=id&metadata->>note_path=eq.\${enc}&\${CORPUS_PLANE_OR}&limit=1\`,
      );`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "The note-tree ingest's by-path lookup. Its answer decides which row the PATCH below " +
      "OVERWRITES, so an unbounded lookup here is a write into another plane's row reached " +
      "through a read nobody thought of as a read - the same shape as the dossier lookup in " +
      "the recipe, and as `agent_memory_review` two rounds ago.",
  },
  {
    file: "docker/wiki-service/wiki-service.mjs",
    sql: `if (Array.isArray(existing) && existing[0]) {
        await obFetch("PATCH", \`thoughts?id=eq.\${existing[0].id}&\${CORPUS_PLANE_OR}\`, { content, metadata: stripCorpusClaim(meta) });
      } else {
        await obFetch("POST", "thoughts", { content, metadata: stripCorpusClaim(meta) });
      }`,
    marker: "stripCorpusClaim",
    reason:
      "The note upsert, pinned as ONE block because the PATCH and the POST are the two " +
      "halves of one decision and pinning either alone would let the other drift. The plane " +
      "is on the PATCH's target as well as on the lookup that chose it, and both branches " +
      "run their metadata through stripCorpusClaim so a note's frontmatter cannot mint an " +
      "`exposure` and make its row invisible to every read above.",
  },
  {
    file: "docker/wiki-service/wiki-service.mjs",
    sql:
      "await obFetch(\"DELETE\", `thoughts?metadata->>note_path=eq.${enc}&${CORPUS_PLANE_OR}`);",
    marker: "CORPUS_PLANE_OR",
    reason:
      "The note delete. Bounded for the mirror-image reason to the reads: an unbounded " +
      "DELETE by a path attribute would let a deleted vault file remove a row on another " +
      "plane, which is a write across the boundary rather than a read across it - and this " +
      "boundary is supposed to hold in both directions.",
  },
  {
    file: "docker/wiki-service/wiki-service.mjs",
    sql: `for (const tbl of ["sources", "thoughts"]) {
      const plane = tbl === "thoughts" ? \`&\${CORPUS_PLANE_OR}\` : "";
      const rows = await obFetch("GET", \`\${tbl}?select=id&\${orF}\${plane}&limit=200\`);`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "The change-watch poll. The table name is a LOOP VARIABLE, so no matcher can read the " +
      "resource out of the template - which is exactly why it is pinned with the ternary " +
      "that supplies the plane INSIDE the pinned text. It selects only ids and publishes " +
      "nothing, but it is what decides that a compile should run, and a compile is the " +
      "thing that publishes.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `const query = [
    \`entity_id=eq.\${entityId}\`,
    \`select=thought_id,mention_role,confidence,source,evidence,created_at,thoughts!inner(id,content,metadata,created_at)\`,
    embeddedCorpusPlaneOr("thoughts"),
    \`order=created_at.desc\`,
    \`limit=\${limit}\`,
  ].join("&");`,
    marker: "embeddedCorpusPlaneOr",
    reason:
      "fetchLinkedThoughts - THE READ THE WHOLE PUBLISHED PAGE IS BUILT FROM. Every linked " +
      "thought's full content goes into the synthesis payload and, for the cited ones, into " +
      "a leaf page. `!inner` is load-bearing: without it PostgREST nulls the embedded child " +
      "and KEEPS the parent, which still carries thought_id - an id is a disclosure.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `const rows = await sb.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: 0.35,
    match_count: 30,
    filter: {},
  });
  return keepOnCorpusPlane(rows || []).map((r) => ({`,
    marker: "keepOnCorpusPlane",
    reason:
      "semanticExpand, pinned TOGETHER WITH the filter that bounds it. The function's own " +
      "body carries the plane (docker/init-agent-memory-corpus-plane.sql), but that file " +
      "lands on a FRESH volume or by the promotion runbook - so on a database it has not " +
      "been applied to the RPC returns everything. A compiler must not depend on a deploy " +
      "step it does not perform to decide what it publishes.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `const rows = keepOnCorpusPlane(
        (await sb.get(
          "thoughts",
          \`select=id,content,metadata,created_at&id=in.(\${list})&\${CORPUS_PLANE_OR}\`,
        )) || [],
      );`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "emitLeafPages - the statement that renders a thought's RAW content into " +
      "`content/thought/<id>.md` and into a `wiki_pages` row. This is the shortest path " +
      "from the corpus to something a browser renders, and it was reached by id from a set " +
      "the model cited, with no predicate anywhere between the table and the file.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `(await sb.get(
        "thoughts",
        \`select=id&metadata->>type=eq.dossier&metadata->>wiki_entity_id=eq.\${entity.id}\` +
          \`&\${CORPUS_PLANE_OR}&limit=1\`,
      )) || [];`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "The dossier idempotency lookup. It selects only `id`, and that id is what the PATCH " +
      "below overwrites - so unbounded it is a write into another plane's row through a " +
      "lookup nobody would call a disclosure. Pinned with the predicate rather than " +
      "exempted as an existence probe, because unlike a true probe its answer DOES reach " +
      "the caller.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql:
      "await sb.patch(`thoughts?id=eq.${existingId}`, { content, metadata: corpusMetadata, embedding });",
    marker: "corpusMetadata",
    reason:
      "The dossier refresh. `corpusMetadata` is `stripCorpusClaim(metadata)`: the compiler " +
      "spreads no caller metadata today, and this is what keeps that true when someone " +
      "later folds an entity's own metadata into the dossier - a write that can carry an " +
      "`exposure` can mint a claim, which is the one way to make a row invisible to every " +
      "read predicate above.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `const rpcRes = await sb.rpc("upsert_thought", {
      p_content: content,
      p_payload: { metadata: corpusMetadata },
    });`,
    marker: "corpusMetadata",
    reason:
      "The dossier insert through the dedup RPC. `upsert_thought` RETURNS public.thoughts, " +
      "so it is a reader as well as a writer - its plane is inside its body, replaced by " +
      "docker/init-agent-memory-corpus-plane.sql - and the payload is claim-stripped here " +
      "for the same reason as the PATCH above.",
  },
  {
    file: "recipes/entity-wiki/generate-wiki.mjs",
    sql: `const inserted = await sb.post(
      "thoughts",
      { content, metadata: corpusMetadata, embedding },
      { prefer: "return=representation" },
    );`,
    marker: "corpusMetadata",
    reason:
      "The dossier's direct-insert FALLBACK, taken when the RPC is missing - the path that " +
      "bypasses `upsert_thought` and therefore bypasses the plane the database holds inside " +
      "it. Claim-stripped in the statement, so the fallback is not the way a claim gets in.",
  },
  {
    file: "recipes/wiki-synthesis/scripts/synthesize-notebooks.mjs",
    sql: `for (const tbl of ["sources", "thoughts"]) {
    const plane = tbl === "thoughts" ? \`&\${CORPUS_PLANE_OR}\` : "";
    const raw = await sb.get(\`\${tbl}?select=metadata,notebook&limit=20000\${plane}\`).catch(() => null) || [];
    const rows = tbl === "thoughts" ? keepOnCorpusPlane(raw) : raw;`,
    marker: "CORPUS_PLANE_OR",
    reason:
      "backfillNotebooks' enumeration, the OTHER script wiki-service executes (SYNTH_PATH). " +
      "It reads only `metadata,notebook` - but a notebook name is the personal plane's own " +
      "vocabulary, and every distinct string it finds becomes a THREAD, which becomes a " +
      "published hub page. Per-table plane rather than one shared string, so a third table " +
      "added to this loop cannot inherit 'no filter'.",
  },
  {
    file: "integrations/kubernetes-deployment/k8s/init.sql",
    sql: `    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
      -- U5 exposure plane. THE SECOND DEFINITION OF match_thoughts IN THIS REPO: the
      -- docker deployment's copy is guarded by docker/init-agent-memory-corpus-plane.sql,
      -- and this k8s copy was not - found by the completeness gate once it learned to scan
      -- a build context's .sql, not only its .ts. Same predicate, same meaning: an ABSENT
      -- label is unclaimed general corpus and stays visible; a PRESENT label was minted by
      -- the agent-memory mirror, and only the ops plane's rows are served. No parameter,
      -- deliberately - a caller that may name its own plane is not bounded by one.
      AND (t.metadata->>'exposure' IS NULL OR t.metadata->>'exposure' = ANY(ARRAY['ops']))`,
    marker: "metadata->>'exposure'",
    reason:
      "The SECOND `match_thoughts` in this repo. `corpusFunctions()` below reads " +
      "`docker/*.sql`, which is the initdb chain compose mounts - it cannot see this one, " +
      "and neither could any previous scan, because a build context's `.sql` was not a file " +
      "type this gate read. The k8s manifests are not what this stack deploys, but a second " +
      "unguarded definition of the guarded function is precisely the thing a promotion " +
      "runbook picks up by accident.",
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
      // DDL DEFINES THE RELATION AND READS NOTHING. Kept as an explicit skip beside the
      // other verbs, not filtered out earlier, so the reason is where a reviewer looks.
      if (ref.keyword === "DDL") continue;
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

/**
 * THE RESIDUAL - mounted, readable inside two containers, and started by nothing.
 *
 * `../recipes` is bind-mounted read-only into openbrain-wiki and openbrain-workbench. Two
 * of its scripts are RUN by the deployment (RECIPE_PATH, SYNTH_PATH) and a few more are
 * imported by those; those are held to the clean standard by the test above this one. The
 * rest are one-off import and backfill scripts that a person runs by hand with their own
 * credentials - `import-chatgpt.py`, `enrich-thoughts.mjs`, the vercel/neon sample app, a
 * second `match_thoughts` in a recipe's own SQL.
 *
 * THEY READ THE CORPUS WITH NO PLANE. That is a true finding and it is written down here
 * rather than fixed, because fixing forty scripts nothing in this deployment executes is a
 * different piece of work from closing the reader that does. What this register buys is
 * that the set cannot grow quietly: the COUNT PER FILE is pinned, so a new unguarded reader
 * anywhere under a mounted root - in a new file or an existing one - moves a number and
 * this suite goes red. An inventory with a pinned count is not an exemption; it is the
 * "here is precisely what remains" that the lift depends on.
 *
 * SO: DO NOT ADD A FILE HERE TO MAKE A FAILURE GO AWAY. A file belongs here only if the
 * deployment does not start it. If it does, it goes in the guarded set above.
 */
const RESIDUAL: { file: string; findings: number }[] = [
  { file: "recipes/adaptive-capture-classification/capture-with-gating.ts", findings: 1 },
  { file: "recipes/brain-backup/backup-brain.mjs", findings: 1 },
  { file: "recipes/chatgpt-conversation-import/chatgpt_parser.py", findings: 1 },
  { file: "recipes/chatgpt-conversation-import/import-chatgpt.py", findings: 4 },
  { file: "recipes/chatgpt-conversation-import/schema.sql", findings: 1 },
  { file: "recipes/daily-digest/src/sections/ai-news.ts", findings: 1 },
  { file: "recipes/email-history-import/rollback-chunking-columns.sql", findings: 4 },
  { file: "recipes/google-activity-import/import-google-activity.mjs", findings: 1 },
  { file: "recipes/grok-export-import/import-grok.mjs", findings: 1 },
  { file: "recipes/instagram-import/import-instagram.mjs", findings: 1 },
  { file: "recipes/journals-blogger-import/import-blogger.mjs", findings: 1 },
  { file: "recipes/local-ollama-embeddings/embed-local.py", findings: 1 },
  { file: "recipes/ob-graph/schema.sql", findings: 1 },
  { file: "recipes/obsidian-vault-import/import-obsidian.py", findings: 3 },
  { file: "recipes/perplexity-conversation-import/import-perplexity.py", findings: 4 },
  { file: "recipes/repo-learning-coach/server/brain.ts", findings: 4 },
  { file: "recipes/repo-learning-coach/src/App.tsx", findings: 1 },
  { file: "recipes/schema-aware-routing/index.ts", findings: 2 },
  { file: "recipes/thought-enrichment/enrich-thoughts.mjs", findings: 1 },
  { file: "recipes/typed-edge-classifier/classify-edges.mjs", findings: 2 },
  { file: "recipes/vercel-neon-telegram/sql/001-create-thoughts.sql", findings: 1 },
  { file: "recipes/vercel-neon-telegram/sql/002-match-thoughts.sql", findings: 1 },
  { file: "recipes/vercel-neon-telegram/src/lib/db.ts", findings: 2 },
  { file: "recipes/wiki-compiler/compile-wiki.mjs", findings: 2 },
  { file: "recipes/wiki-synthesis/scripts/backfill-gmail-wikis.mjs", findings: 5 },
  { file: "recipes/wiki-synthesis/scripts/synthesize-wiki.mjs", findings: 1 },
  { file: "recipes/world-model-diagnostic-activation/schema-v2-draft.sql", findings: 1 },
  { file: "recipes/x-twitter-import/import-x-twitter.mjs", findings: 1 },
];

Deno.test("EVERY memory- or corpus-table statement is routed, pinned or allow-listed", async () => {
  // THE TEST THIS FILE EXISTS FOR - over the derived root set, the derived file set, the
  // derived table set and the derived corpus-function set, rather than over lists somebody
  // typed.
  //
  // SCOPED TO THE GUARDED SET: every built image's source, plus the mounted files the
  // deployment actually starts (derived - see invokedMountedFiles). The mounted-but-not-
  // started remainder is inventoried by the next test, with counts, not waved through.
  const sources = await shippingSources();
  const guarded = await guardedFiles(sources);
  const scoped = new Map([...sources].filter(([f]) => guarded.has(f)));
  const offenders = auditSources(
    scoped,
    await memoryTables(),
    await corpusFunctions(),
    EXEMPT.filter((e) => guarded.has(e.file)),
    PINNED.filter((pin) => guarded.has(pin.file)),
  );
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("the guarded set CONTAINS the wiki compiler, and it is not empty", async () => {
  // The previous test can only be as good as the set it runs over, and the cheapest way to
  // make it green would be to shrink that set. So the membership is asserted, not assumed:
  // these are the files a verifier proved reach corpus content, in the order they were
  // found.
  const guarded = await guardedFiles(await shippingSources());
  for (
    const f of [
      "integrations/kubernetes-deployment/index.ts",
      "docker/extensions-server/index.ts",
      "integrations/agent-memory-api/index.ts",
      "integrations/entity-extraction-worker/index.ts",
      // The three the deployment RUNS off the bind-mount, and the service that runs them.
      "docker/wiki-service/wiki-service.mjs",
      "recipes/entity-wiki/generate-wiki.mjs",
      "recipes/wiki-synthesis/scripts/synthesize-notebooks.mjs",
      "recipes/_shared/wiki-pages.mjs",
    ]
  ) {
    assertEquals(guarded.has(f), true, `the guarded set no longer contains ${f}`);
  }
  assertEquals(guarded.size > 100, true, `the guarded set collapsed to ${guarded.size} files`);
});

Deno.test("the RESIDUAL is an inventory with pinned counts, not an exemption", async () => {
  const sources = await shippingSources();
  const guarded = await guardedFiles(sources);
  const rest = new Map([...sources].filter(([f]) => !guarded.has(f)));
  assertEquals(rest.size > 0, true, "no mounted-but-unstarted files at all - derivation broke");
  const offenders = auditSources(
    rest,
    await memoryTables(),
    await corpusFunctions(),
    EXEMPT.filter((e) => rest.has(e.file)),
    PINNED.filter((pin) => rest.has(pin.file)),
  );
  const counts = new Map<string, number>();
  for (const o of offenders) {
    const file = o.slice(0, o.indexOf(":"));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const actual = [...counts].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, findings]) => `  { file: "${file}", findings: ${findings} },`).join("\n");
  const expected = [...RESIDUAL].sort((a, b) => a.file.localeCompare(b.file))
    .map((r) => `  { file: "${r.file}", findings: ${r.findings} },`).join("\n");
  assertEquals(
    actual,
    expected,
    "the mounted-but-unstarted inventory moved. If a file gained a finding, a new " +
      "unguarded corpus reader was added to code that is mounted into two running " +
      "containers. If one lost a finding, say so in the register. Current actual:\n" + actual,
  );
});

Deno.test("no Dockerfile under a scan root names a memory or corpus table", async () => {
  // NON_CODE_NAMES excludes Dockerfiles from the statement scan because they are build
  // instructions. That exclusion is only honest if nothing is hiding in one - a RUN line
  // that shells out to psql is a reader with no file extension.
  const tables = [...await memoryTables(), CORPUS];
  let read = 0;
  for (const f of await allFilesUnderRoots()) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    // DOCKERFILES ONLY. The other NON_CODE_NAMES entries are `.env` and `.gitignore`, and
    // `.env` is the one file class this gate must NOT open: it is gitignored credentials,
    // absent from a fresh clone, and reading it would make the verdict depend on whose
    // checkout ran the suite. (It also, in this repo, contains the word `thoughts` - in a
    // connection URL.)
    if (!(name === "Dockerfile" || name.startsWith("Dockerfile."))) continue;
    read++;
    const src = await readRepo(f);
    for (const t of tables) {
      assertEquals(
        new RegExp(`\\b${t}\\b`).test(src),
        false,
        `${f} names ${t} - a Dockerfile is excluded from the statement scan, so it must not ` +
          `contain one`,
      );
    }
  }
  assertEquals(read > 0, true, "read no Dockerfiles at all - this test proved nothing");
});

Deno.test("every NON_CODE classification matches something real, and carries a reason", async () => {
  // The same discipline the allow-list has: a classification that matches nothing is a
  // stale opinion, and a stale opinion is how ".ts only" survived four rounds.
  const files = await allFilesUnderRoots();
  const names = files.map((f) => f.slice(f.lastIndexOf("/") + 1));
  for (const n of [...NON_CODE, ...NON_CODE_NAMES]) {
    assertEquals(n.why.length > 20, true, `NON_CODE ${n.ext} has no real reason: ${n.why}`);
  }
  for (const n of NON_CODE) {
    assertEquals(
      names.some((name) => extensionOf(name) === n.ext),
      true,
      `NON_CODE excludes "${n.ext}" but no file under any scan root has that extension - a ` +
        `stale exclusion. Remove it, or find out why the files went away.`,
    );
  }
  for (const n of NON_CODE_NAMES) {
    assertEquals(
      names.some((name) => name === n.ext || name.startsWith(`${n.ext}.`)),
      true,
      `NON_CODE_NAMES excludes "${n.ext}" but no file under any scan root is named that`,
    );
  }
});

Deno.test("EVERY file under a scan root is classified - code, non-code, or a test", async () => {
  // The derivation is "scan everything, minus a written list". This is the test that says
  // the minus-list is the ONLY thing keeping a file out: a file that is neither scanned nor
  // named by a classification is the bug this round fixed, appearing again.
  const files = await allFilesUnderRoots();
  const scanned = new Set((await shippingSources()).keys());
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    if (scanned.has(f)) continue;
    // NO BLANKET ESCAPE FOR "no extension". A file called `Makefile` or `run` is code that
    // this walk would skip, so it has to be NAMED in NON_CODE_NAMES to be skipped.
    const classified = isTestFile(name) || isNonCodeName(name) ||
      NON_CODE.some((n) => n.ext === extensionOf(name));
    assertEquals(classified, true, `${f} is neither scanned nor classified as non-code`);
  }
  assertEquals(files.length > scanned.size, true, "every file is scanned - suspicious");
});

Deno.test("EVERY scan root contributes at least one scanned file", async () => {
  // The .ts-only walk scanned NOTHING in five of fourteen roots and the suite was green.
  // shippingSources() now throws on the first empty root; this asserts the per-root count
  // out loud, so the number is visible rather than merely non-zero somewhere.
  const roots = await scanRoots();
  const sources = await shippingSources();
  for (const r of roots) {
    const n = [...sources.keys()].filter((f) => f.startsWith(`${r}/`)).length;
    assertEquals(n > 0, true, `scan root ${r} contributed ZERO scanned files`);
  }
  assertEquals(roots.length >= 14, true, `only ${roots.length} scan roots - a root went missing`);
});

Deno.test("the BIND-MOUNTED roots are in the scan, derived from compose volumes", async () => {
  const mounts = await mountedRoots();
  assertEquals(
    mounts.map((m) => `${m.root}:${m.mountPoint}`),
    ["recipes:/recipes"],
    "the directory bind-mounts changed - a new one is IN SCOPE the same day",
  );
  const roots = await scanRoots();
  for (const m of mounts) assertEquals(roots.includes(m.root), true, `${m.root} is not a root`);
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
  //
  // RAISED THIS ROUND, 6->9 and 12->25, and the reason is the same one that made the round
  // legitimate: the scan went from `.ts` in fourteen build contexts to every code file in
  // fourteen build contexts PLUS the `../recipes` bind-mount, and the published wiki
  // compiler turned out to live in there. Twelve of the thirteen new pins are one statement
  // each in `wiki-service.mjs`, `generate-wiki.mjs` and `synthesize-notebooks.mjs` - files
  // that CANNOT import the TypeScript chokepoint because they are `.mjs` handed to a
  // container by a bind-mount - and the thirteenth is a second `match_thoughts` definition
  // in the k8s manifests. Each carries its predicate in its own text. A cap that forced
  // those statements to stay unpinned would be a cap that preferred a short list to a
  // closed boundary.
  assertEquals(EXEMPT.length <= 9, true, `the allow-list has grown to ${EXEMPT.length}`);
  assertEquals(PINNED.length <= 25, true, `the pin list has grown to ${PINNED.length}`);
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

/**
 * The real GUARDED set plus one synthetic file, fed to the real audit function.
 *
 * Scoped exactly as the gate above is scoped, and that matters: a red-proof run over a
 * wider set than the gate would be proving a property of code the gate does not enforce,
 * and a red-proof run over a NARROWER one would be the easiest way to fake this whole file.
 * The injected name is asserted to land inside the guarded set, so an injection that
 * happened to fall into the residual inventory fails loudly instead of quietly passing.
 */
async function withInjected(name: string, src: string): Promise<string[]> {
  const sources = await shippingSources();
  assertEquals(sources.has(name), false, `${name} already exists - pick another probe name`);
  const guarded = await guardedFiles(sources);
  sources.set(name, src);
  const scoped = new Map([...sources].filter(([f]) => guarded.has(f) || f === name));
  return auditSources(
    scoped,
    await memoryTables(),
    await corpusFunctions(),
    EXEMPT.filter((e) => scoped.has(e.file)),
    PINNED.filter((pin) => scoped.has(pin.file)),
  );
}

/**
 * Same, but the synthetic file goes into a MOUNTED-BUT-UNSTARTED path, and it is checked
 * against the residual inventory instead. This is the proof that the inventory is a gate
 * and not a waiver: a new unguarded reader dropped into `../recipes` moves a count.
 */
async function withInjectedResidual(name: string, src: string): Promise<number> {
  const sources = await shippingSources();
  assertEquals(sources.has(name), false, `${name} already exists - pick another probe name`);
  const guarded = await guardedFiles(sources);
  assertEquals(guarded.has(name), false, `${name} is in the guarded set - wrong probe`);
  sources.set(name, src);
  const rest = new Map([...sources].filter(([f]) => !guarded.has(f)));
  const offenders = auditSources(
    rest,
    await memoryTables(),
    await corpusFunctions(),
    EXEMPT.filter((e) => rest.has(e.file)),
    PINNED.filter((pin) => rest.has(pin.file)),
  );
  return offenders.filter((o) => o.startsWith(`${name}:`)).length;
}

/**
 * THE EXECUTED DEFEAT OF ROUND FIVE, verbatim, as a permanent test.
 *
 * These four statements, in this file, in this directory, left the suite at 213 passed /
 * 0 failed. The identical bytes named `u5-probe.ts` failed 13 tests. `docker/wiki-service`
 * has FIVE `.mjs` files and ZERO `.ts` files, so the gate scanned none of the openbrain-wiki
 * image - and openbrain-wiki is the container that publishes the corpus to a browser.
 */
const MJS_DEFEAT = 'export async function leak(client, id) {\n' +
  '  const a = await client.query(`SELECT id, content, metadata FROM thoughts WHERE id = $1`, [id]);\n' +
  '  const b = await client.query(`SELECT id, summary, content FROM agent_memories WHERE id = $1`, [id]);\n' +
  '  const c = await client.query(`SELECT * FROM agent_memory_recall_items WHERE trace_id = $1`, [id]);\n' +
  '  const d = await client.query(`SELECT * FROM agent_memory_review_actions WHERE memory_id = $1`, [id]);\n' +
  '  return { a, b, c, d };\n' +
  '}\n';

Deno.test("RED: the .mjs defeat - the SAME statements, in the image that publishes", async () => {
  const offenders = await withInjected("docker/wiki-service/u5-probe.mjs", MJS_DEFEAT);
  assertEquals(offenders.length, 4, `expected four findings, got: ${offenders.join(" | ")}`);
  for (const o of offenders) assertEquals(o.includes("u5-probe.mjs"), true, o);
});

Deno.test("RED: extension is not the property - .mjs and .ts fail IDENTICALLY", async () => {
  // The contrast that was measured on 2026-08-30: 0 findings vs 13 failing tests, for the
  // same bytes. If these two ever diverge again, the walk has grown an extension rule.
  const asMjs = await withInjected("docker/wiki-service/u5-probe.mjs", MJS_DEFEAT);
  const asTs = await withInjected("docker/wiki-service/u5-probe.ts", MJS_DEFEAT);
  assertEquals(
    asMjs.map((o) => o.replace("u5-probe.mjs", "X")),
    asTs.map((o) => o.replace("u5-probe.ts", "X")),
    "the same statements are judged differently depending on the file extension",
  );
});

Deno.test("RED: caught in a SHELL script - docker/backup ships three and no .ts", async () => {
  const offenders = await withInjected(
    "docker/backup/u5-probe.sh",
    '#!/bin/sh\npsql -c "SELECT id, content FROM thoughts LIMIT 100" > /backup/dump.txt\n',
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
  assertEquals(offenders[0].includes("reads the shared corpus"), true, offenders[0]);
});

Deno.test("RED: caught in PYTHON - docker/extract ships one .py and no .ts", async () => {
  const offenders = await withInjected(
    "docker/extract/u5_probe.py",
    'rows = cur.execute("SELECT id, summary, content FROM agent_memories WHERE id = %s", (i,))\n',
  );
  assertEquals(offenders.length, 1, offenders.join(" | "));
});

Deno.test("RED: caught in a BIND-MOUNTED recipe the deployment RUNS", async () => {
  // `../recipes` is in no build context, so round five's root derivation could not see it -
  // while wiki-service executes two of its scripts on a schedule. A file imported by one of
  // those is INVOKED, so it is held to the clean standard, not inventoried.
  const sources = await shippingSources();
  const guarded = await guardedFiles(sources);
  assertEquals(
    guarded.has("recipes/_shared/corpus-plane.mjs"),
    true,
    "the module the compiler imports for its predicate is not in the guarded set",
  );
  const offenders = await withInjected(
    "recipes/_shared/citations.mjs.bak.mjs",
    'export const q = (sb, id) => sb.get("thoughts", `select=id,content&id=eq.${id}`);\n',
  );
  assertEquals(offenders.length >= 1, true, "an unguarded corpus read in a mounted root passed");
});

Deno.test("RED: a new unguarded reader in the MOUNTED remainder moves the inventory", async () => {
  // The residual register is a gate, not a waiver: a file nothing starts is still mounted
  // read-only inside two running containers, and a new unguarded reader there changes a
  // pinned number. Proven by injecting one and requiring the count to be non-zero - the
  // inventory test compares the whole map, so a non-zero count for a file that is not in
  // RESIDUAL is a failure there.
  const n = await withInjectedResidual(
    "recipes/x-twitter-import/u5-probe.mjs",
    'export const q = (sb) => sb.get("thoughts", "select=id,content&limit=1000");\n',
  );
  assertEquals(n, 1, `expected one finding for the injected residual reader, got ${n}`);
});

Deno.test("the scanned set really CONTAINS non-.ts files, per root", async () => {
  // The assertion that would have caught round five's defect the day it landed, stated as
  // membership rather than as a count: these files exist, ship, and are not TypeScript.
  const sources = await shippingSources();
  for (
    const f of [
      "docker/wiki-service/wiki-service.mjs",
      "docker/wiki-service/lib/entity-links.mjs",
      "docker/backup/openbrain-db-backup.sh",
      "recipes/entity-wiki/generate-wiki.mjs",
      "recipes/_shared/corpus-plane.mjs",
      "integrations/kubernetes-deployment/k8s/init.sql",
    ]
  ) {
    assertEquals(sources.has(f), true, `${f} is not in the scanned set`);
  }
  const exts = new Set([...sources.keys()].map((f) => extensionOf(f.slice(f.lastIndexOf("/") + 1))));
  for (const want of [".ts", ".mjs", ".sh", ".py", ".sql", ".tsx"]) {
    assertEquals(exts.has(want), true, `no ${want} file is scanned anywhere`);
  }
});

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
