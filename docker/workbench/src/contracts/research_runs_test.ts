// deno test src/contracts/research_runs_test.ts - rwr-research-runs, no database: the grouping and counts, the one ownership
// query, the archive going through slot 640's functions only (never the table), the report-as-document seam, the contract
// document, the user-only rule and the slot's files. The database half (two identities, planted markers, the round trip) is
// the lab's: research_runs_integration_test.ts via contract-test/run-research-runs-tests.ps1.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import type { Identity } from "../middleware/identity.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import { countsOf, groupOf, listRuns, OWN_RUNS_SQL, reportAsDocument, reportOf, type RunRow, setArchived } from "./repo/research_runs.ts";
import { Conflict, NotFound } from "./repo/lifecycle.ts";

const WHO: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const src = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const docker = new URL("../../../", import.meta.url);
const haveRepo = (() => { try { Deno.statSync(new URL("init-research-run-views.sql", docker)); return true; } catch { return false; } })();
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, docker)).split("\r").join("");

const row = (over: Partial<RunRow> = {}): RunRow => ({
  id: "r", question: "q", topic: null, document: null, status: "done", group: "done", branches: 0,
  created_at: "t", finished_at: null, archived: false, archived_at: null, ...over,
});

Deno.test("a run's group: queued, running (or an open branch), done, stopped", () => {
  assertEquals(groupOf("queued", 0), "queued");
  assertEquals(groupOf("running", 0), "running");
  assertEquals(groupOf("done", 2), "running", "a finished root with an open branch is still running");
  assertEquals(groupOf("done", 0), "done");
  assertEquals(groupOf("error", 0), "stopped");
  assertEquals(groupOf("cancelled", 0), "stopped");
});

Deno.test("counts: archived runs are counted apart and never in a state or in the total", () => {
  const c = countsOf([row({ group: "running" }), row({ group: "done" }), row({ group: "done", archived: true }), row({ group: "stopped" }), row({ group: "queued" })]);
  assertEquals(c, { running: 1, queued: 1, done: 1, stopped: 1, archived: 1, total: 4 });
});

Deno.test("the list asks the database for the identity seam's subject only, through one ownership query", async () => {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      return Promise.resolve([
        { id: "a", status: "done", query: "A one", topic: "t", created_at: new Date("2026-11-01T10:00:00Z"), finished_at: null, branches: 0, open_branches: 0, document: null, archived_at: null },
        { id: "b", status: "running", query: "B", topic: null, created_at: new Date("2026-11-02T10:00:00Z"), finished_at: null, branches: 1, open_branches: 1, document: "documents/x.md", archived_at: new Date("2026-11-03T10:00:00Z") },
      ] as T[]);
    },
    tx: (fn) => fn(db),
  };
  const all = await listRuns(db, WHO, "all", 200);
  assertEquals(seen.length, 1, "one read, no per-run follow-up");
  assertEquals(seen[0].args[0], "user-a");
  assertEquals(all.counts, { running: 0, queued: 0, done: 1, stopped: 0, archived: 1, total: 1 }, "an archived running run is archived, not running");
  assertEquals((await listRuns(db, WHO, "active", 200)).runs.map((r) => r.id), ["a"]);
  assertEquals((await listRuns(db, WHO, "archived", 200)).runs.map((r) => r.id), ["b"]);
  // the ownership rule: prompt owner, the hand-back owner, or the ownerless default subject - and nothing else
  assert(/p\.owner_sub = \$1/.test(OWN_RUNS_SQL) && /run_handbacks_of\(\$1\)/.test(OWN_RUNS_SQL) && /\$2::text = \$1/.test(OWN_RUNS_SQL));
  assert(/request_kind <> 'derived'/.test(OWN_RUNS_SQL), "an ownerless claim never takes a derived run");
  assert(!/FROM public\.research_run_views/.test(OWN_RUNS_SQL + src("repo/research_runs.ts")), "the table is reached through slot 640's functions only");
});

Deno.test("archive and unarchive: a run that is not the caller's is NotFound and nothing is written; a repeat is a Conflict", async () => {
  const writes: string[] = [];
  const mk = (owned: boolean, fnOk: boolean) => {
    const db: Db = {
      query: <T>(sql: string) => {
        if (/run_view_(un)?archive/.test(sql)) { writes.push(sql.replace(/\s+/g, " ").trim()); return Promise.resolve([{ ok: fnOk }] as T[]); }
        return Promise.resolve((owned ? [{ id: "r", status: "done", query: "q", topic: null, created_at: new Date(), finished_at: null, branches: 0, open_branches: 0, document: null, archived_at: null }] : []) as T[]);
      },
      tx: (fn) => fn(db),
    };
    return db;
  };
  await assertRejects(() => setArchived(mk(false, true), WHO, "r", true), NotFound);
  assertEquals(writes.length, 0, "no write for another person's run");
  await assertRejects(() => setArchived(mk(true, false), WHO, "r", true), Conflict, "already archived");
  await assertRejects(() => setArchived(mk(true, false), WHO, "r", false), Conflict, "not archived");
  assertEquals(writes, ["SELECT public.run_view_archive($1, $2::uuid) AS ok", "SELECT public.run_view_unarchive($1, $2::uuid) AS ok"]);
});

Deno.test("the report as a document: the owner's report only, one document through the seam, nothing else written", async () => {
  const sqls: string[] = [];
  const db: Db = {
    query: <T>(sql: string) => {
      sqls.push(sql);
      if (/FROM public\.research_jobs j\b/.test(sql)) return Promise.resolve([{ id: "r", status: "done", query: "How  do\nthe sensors compare?", topic: null, created_at: new Date(), finished_at: null, branches: 0, open_branches: 0, document: null, archived_at: null }] as T[]);
      if (/inlet_private_job/.test(sql)) return Promise.resolve([] as T[]);
      if (/FROM public\.research_jobs WHERE coalesce/.test(sql)) return Promise.resolve([{ id: "r", result: { prose: "", synthesis: "THE REPORT TEXT" } }] as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(db),
  };
  const made: unknown[] = [];
  const seam = { createOwnDocument: (i: unknown, w: Identity) => { made.push([i, w.sub]); return Promise.resolve({ path: "documents/user-a/x.md" }); } };
  const d = await reportAsDocument(db, seam, WHO, "r");
  assertEquals(d, { path: "documents/user-a/x.md", title: "How do the sensors compare?" });
  assertEquals(made, [[{ title: "How do the sensors compare?", body: "THE REPORT TEXT\n", fields: { research_run: "r" } }, "user-a"]]);
  assert(!sqls.some((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)), "no database write");
  await assertRejects(() => reportAsDocument(db, {}, WHO, "r"), Error, "not available");
  assertEquals(reportOf({ prose: " ", synthesis: "" }), "");
  assertEquals(reportOf({ prose: "P", synthesis: "S" }), "P");
});

Deno.test("the contract document has the five routes, user-only, no MCP tool, and the list names no person", () => {
  const db: Db = { query: () => Promise.resolve([]), tx: (fn) => fn(db) };
  const doc = openApiDocument(createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.resolve([]), chunk: (s) => [s],
    mountsRoot: "/tmp", streamPollMs: 1000, log: () => {},
  })) as any;
  const P = "/workbench/contract/research/runs";
  assertEquals(doc.paths[P].get.operationId, "researchRuns");
  assertEquals(doc.paths[`${P}/{id}`].get.operationId, "researchRun");
  assertEquals(doc.paths[`${P}/{id}/archive`].post.operationId, "archiveResearchRun");
  assertEquals(doc.paths[`${P}/{id}/unarchive`].post.operationId, "unarchiveResearchRun");
  assertEquals(doc.paths[`${P}/{id}/document`].post.operationId, "researchRunDocument");
  for (const p of [P, `${P}/{id}`, `${P}/{id}/archive`, `${P}/{id}/unarchive`, `${P}/{id}/document`]) {
    for (const o of Object.values(doc.paths[p]) as any[]) assert(o["x-mcp-tool"] === undefined, "a person's runs are not an MCP read");
  }
  assertEquals((doc.paths[P].get.parameters ?? []).map((x: any) => x.name).sort(), ["limit", "view"]);
  assert(USER_ONLY.test(P) && USER_ONLY.test(`${P}/abc/archive`), "a service key has no runs (403)");
  const row = doc.components.schemas.ResearchRunRow;
  assertEquals(Object.keys(row.properties).sort(), ["archived", "archived_at", "branches", "created_at", "document", "finished_at", "group", "id", "question", "status", "topic"]);
});

Deno.test({ ignore: !haveRepo, name: "slot 640: one table, four functions, ob_workbench alone, no right on the table; revert drops them and nothing else; mounted after 420 and 480", fn: () => {
  const up = read("init-research-run-views.sql");
  assert(/PRIMARY KEY \(owner_sub, job_id\)/.test(up) && /ON DELETE CASCADE/.test(up));
  assert(/FORCE ROW LEVEL SECURITY/.test(up) && !/CREATE POLICY/.test(up), "forced RLS with no policy");
  assertEquals((up.match(/^SECURITY DEFINER$/gm) ?? []).length, 4);
  assert(/GRANT EXECUTE ON FUNCTION public\.%s TO ob_workbench/.test(up));
  assert(!/GRANT\s+[A-Z, ]+\s+ON\s+(TABLE\s+)?public\.research_run_views/i.test(up), "no grant on the table");
  assert(!/(UPDATE|DELETE FROM|INSERT INTO) public\.(research_jobs|claims|sources|claim_sources|research_job_events|research_handbacks)\b/.test(up), "no run, claim or source row is written");
  const down = read("revert-research-run-views.sql");
  const stmts = down.split("\n").filter((l) => /^(DROP|ALTER|REVOKE|DELETE|UPDATE)/i.test(l));
  assertEquals(stmts, [
    "DROP FUNCTION IF EXISTS public.run_view_archive(TEXT, UUID);", "DROP FUNCTION IF EXISTS public.run_view_unarchive(TEXT, UUID);",
    "DROP FUNCTION IF EXISTS public.run_views_of(TEXT);", "DROP FUNCTION IF EXISTS public.run_handbacks_of(TEXT);", "DROP TABLE IF EXISTS public.research_run_views;",
  ]);
  const compose = read("docker-compose.yml");
  const nums = compose.split("\n").filter((l) => /docker-entrypoint-initdb\.d\/\d{3}-/.test(l)).map((l) => /initdb\.d\/(\d{3})-/.exec(l)![1]);
  assert(/640-init-research-run-views\.sql/.test(compose));
  assert(nums.indexOf("640") > nums.indexOf("420") && nums.indexOf("640") > nums.indexOf("480") && nums.indexOf("640") > nums.indexOf("600"));
  assertEquals(nums.filter((n) => n === "640").length, 1);
} });
