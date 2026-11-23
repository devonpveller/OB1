// deno test src/contracts/inlets_test.ts - rwr-imports-server-api, no database: the repository asks the function for the
// identity seam's subject only, the contract document, the user-only rule, the migration files, and the retry cap's wiring.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { connectionsOf } from "./repo/inlets.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import { MAX_ATTEMPTS, RETRIED_ALREADY } from "../intake/repo.ts";
import type { Identity } from "../middleware/identity.ts";

const WHO: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
// source files of the workbench resolve from this file (they are in the image too); the SQL and the compose file live
// beside the workbench, not inside its image, so the cases that read them run in the repo checkout and are skipped in the
// image's build gate (the lab runs them as the round trip and the catalog)
const src = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const docker = new URL("../../../", import.meta.url);
const haveRepo = (() => { try { Deno.statSync(new URL("init-inlet-connections-read.sql", docker)); return true; } catch { return false; } })();
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, docker));

Deno.test("the read passes the identity seam's subject and nothing else, and names no table", async () => {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      return Promise.resolve([{ kind: "gmail", created_at: new Date("2026-10-17T12:00:00Z"), updated_at: new Date("2026-10-17T12:00:00Z") }] as T[]);
    },
    tx: (fn) => fn(db),
  };
  const rows = await connectionsOf(db, WHO);
  assertEquals(rows, [{ kind: "gmail", created_at: "2026-10-17T12:00:00.000Z", updated_at: "2026-10-17T12:00:00.000Z" }]);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].args, ["user-a"]);
  assert(/inlet_connections_of\(\$1\)/.test(seen[0].sql) && !/FROM public\.inlet_connections\b(?!_of)/.test(seen[0].sql), seen[0].sql);
  assert(!/inlet_connections\s+(c|WHERE)/.test(src("repo/inlets.ts").replace(/inlet_connections_of/g, "")), "the repo never reads the table itself");
});

Deno.test("the contract document has the route, user-only, with kind and stamps and no other field", () => {
  const db: Db = { query: () => Promise.resolve([]), tx: (fn) => fn(db) };
  const doc = openApiDocument(createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.resolve([]), chunk: (s) => [s],
    mountsRoot: "/tmp", streamPollMs: 1000, log: () => {},
  })) as any;
  const op = doc.paths["/workbench/contract/inlets/connections"]?.get;
  assert(op, "GET /workbench/contract/inlets/connections is in the contract");
  assertEquals(op.operationId, "inletConnections");
  assertEquals(op.parameters ?? [], [], "no query or header names a person");
  assert(op["x-mcp-tool"] === undefined, "no MCP tool: a person's inlets are not a shared read");
  const item = doc.components.schemas.InletConnection;
  assertEquals(Object.keys(item.properties).sort(), ["created_at", "kind", "updated_at"]);
  assertEquals(Object.keys(doc.components.schemas.InletConnections.properties), ["connections"]);
  assert(USER_ONLY.test("/workbench/contract/inlets/connections"), "a service key has no inlets (403)");
});

Deno.test({ ignore: !haveRepo, name: "slot 600: one function, kind and stamps only, ob_workbench alone, no right on the table; revert drops that function only", fn: () => {
  const up = read("init-inlet-connections-read.sql");
  assert(/RETURNS TABLE \(kind TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ\)/.test(up));
  assert(/SECURITY DEFINER/.test(up) && /SET search_path = public, pg_temp/.test(up));
  assert(/c\.owner_sub = p_sub/.test(up) && /inlet_subject_ok\(p_sub\)/.test(up));
  assert(!/\bc\.id\b|\bowner_sub,|SELECT c\.\*/.test(up.replace(/c\.owner_sub = p_sub/g, "")), "no id, no owner column in the answer");
  assert(/GRANT EXECUTE ON FUNCTION public\.inlet_connections_of\(TEXT\) TO ob_workbench;/.test(up));
  assert(!/GRANT\s+[A-Z, ]+\s+ON\s+(TABLE\s+)?public\.inlet_connections\b(?!_of)/i.test(up), "no grant on the table");
  assert(!/ALTER TABLE|CREATE POLICY|CREATE TABLE/i.test(up), "the slot changes no table");
  const down = read("revert-inlet-connections-read.sql");
  const stmts = down.split("\n").filter((l) => /^(DROP|ALTER|REVOKE|DELETE|UPDATE)/i.test(l));
  assertEquals(stmts, ["DROP FUNCTION IF EXISTS public.inlet_connections_of(TEXT);"]);
  const compose = read("docker-compose.yml");
  const lines = compose.split("\n").filter((l) => /docker-entrypoint-initdb\.d\/\d{3}-/.test(l)).map((l) => /initdb\.d\/(\d{3})-/.exec(l)![1]);
  assert(lines.indexOf("600") > lines.indexOf("580") && lines.indexOf("600") > lines.indexOf("480") && lines.indexOf("600") > lines.indexOf("470"), "600 is mounted after 470, 480 and 580");
  assert(/600-init-inlet-connections-read\.sql/.test(compose));
} });

Deno.test("the retry cap: the route refuses a job already retried, for every caller, with the shared reason; the UPDATE carries the same bound", () => {
  assertEquals(MAX_ATTEMPTS, 2);
  assert(/already retried once/.test(RETRIED_ALREADY));
  const routes = src("../intake/routes.ts");
  assert(/attempts \?\? 1\) >= repo\.MAX_ATTEMPTS\) return c\.json\(\{ error: repo\.RETRIED_ALREADY \}, 409\)/.test(routes));
  assert(/attempts < \$2/.test(routes) && /\[job\.id, repo\.MAX_ATTEMPTS\]/.test(routes), "the bound is in the UPDATE too (two retries together)");
  const pos = (s: string) => routes.indexOf(s);
  assert(pos("repo.RETRIED_ALREADY") > pos("a ${job.status} ${job.kind} job cannot be retried") && pos("repo.RETRIED_ALREADY") < pos("UPDATE public.import_jobs SET status = 'queued'"), "the cap sits after the 404 / state checks and before the write");
});
