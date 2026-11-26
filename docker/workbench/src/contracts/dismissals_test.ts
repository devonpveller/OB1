// deno test src/contracts/dismissals_test.ts - Cleanup "Not again for this" (rwr-cleanup), no database: the repository's
// SQL is scoped to the seam's subject, the kind is a registry, the contract document, and the migration files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader, UnregisteredValue } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { addDismissal, listDismissals, removeDismissal } from "./repo/dismissals.ts";
import { Dismissal, DismissalCreate } from "./schemas/dismissals.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import type { Identity } from "../middleware/identity.ts";

const A: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const B: Identity = { sub: "user-b", actor: "user-b", name: "B", key: "user-b" };
const TOMB = "22222222-2222-4222-8222-222222222222";
const ID = "d15a0000-0000-4000-8000-000000000001";

function recorder(rows: Record<string, unknown[]> = {}) {
  const log: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: s, args });
      if (/INSERT INTO public\.cleanup_dismissals/.test(s)) return Promise.resolve((rows.insert ?? [{ id: ID, kind: "reopen_candidate", ref: TOMB, created_at: "t" }]) as T[]);
      if (/DELETE FROM public\.cleanup_dismissals/.test(s)) return Promise.resolve((rows.del ?? []) as T[]);
      if (/count\(\*\)/.test(s)) return Promise.resolve([{ n: 0 }] as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(db),
  };
  return { db, log };
}
const entry = (registry: string, key: string) => ({ registry, key, version: 1, label: key, definition: {}, retired_at: null, superseded_by: null });
const REG = ["suggestion", "reopen_candidate"].map((k) => entry("dismissal_kinds", k));
function reader(db: Db) {
  const r = new RegistryReader(db);
  // deno-lint-ignore no-explicit-any
  (r as any).all = () => Promise.resolve(REG);
  return r;
}

Deno.test("D1: a dismissal writes only its own row, keyed to the seam's subject", async () => {
  const { db, log } = recorder();
  const d = await addDismissal(db, reader(db), A, { kind: "reopen_candidate", ref: TOMB });
  assertEquals(d.kind, "reopen_candidate");
  const writes = log.filter((l) => /(INSERT INTO|UPDATE public|DELETE FROM)/i.test(l.sql));
  assertEquals(writes.length, 1);
  assertEquals(writes[0].args[0], "user-a");
  assert(!/DO UPDATE|UPDATE public/i.test(writes[0].sql), "the table is not granted UPDATE: a repeat is DO NOTHING and a read-back");
  assert(!("owner_sub" in d), "the row never names its owner");
  assert(/FROM public\.cleanup_dismissals WHERE owner_sub = \$1 AND kind = \$2 AND ref = \$3/.test(writes[0].sql), "the read-back of an existing row is scoped to the person too: "+writes[0].sql);
});

Deno.test("D2: a kind the registry does not know is refused before anything is written", async () => {
  const { db, log } = recorder();
  await assertRejects(() => addDismissal(db, reader(db), A, { kind: "nope", ref: TOMB }), UnregisteredValue);
  assertEquals(log.filter((l) => /(INSERT INTO|UPDATE public|DELETE FROM)/i.test(l.sql)).length, 0);
});

Deno.test("D3: every read and the delete are scoped to owner_sub in SQL; a second person's rows are never selected", async () => {
  const { db, log } = recorder();
  await listDismissals(db, B, { limit: 10 });
  await removeDismissal(db, B, ID);
  for (const l of log) {
    assert(/owner_sub = \$1/.test(l.sql), l.sql);
    assertEquals(l.args[0], "user-b");
  }
});

Deno.test("D4: deleting another person's dismissal finds nothing: the same answer as a missing one", async () => {
  const { db } = recorder({ del: [] });
  assertEquals(await removeDismissal(db, B, ID), false);
  const hit = recorder({ del: [{ id: ID }] });
  assertEquals(await removeDismissal(hit.db, A, ID), true);
});

Deno.test("D5: the ref is a bounded, clean string; no user field; strict", () => {
  const ok = { kind: "suggestion", ref: "dup-source:abc" };
  assertEquals(DismissalCreate.safeParse(ok).success, true);
  for (const bad of [{ ...ok, ref: "" }, { ...ok, ref: "x".repeat(201) }, { ...ok, ref: "a\u0000b" }, { ...ok, owner_sub: "user-b" }, { ...ok, user: "b" }]) {
    assertEquals(DismissalCreate.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
  assertEquals(Dismissal.safeParse({ id: ID, kind: "suggestion", ref: "r", created_at: "t" }).success, true);
});

Deno.test("D6: the contract document carries the three routes, kind is a registry, none is an MCP tool", () => {
  const noDb: Db = { query: () => Promise.reject(new Error("no db")), tx: () => Promise.reject(new Error("no db")) };
  const app = createContractApp({
    db: noDb, registry: new RegistryReader(noDb), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/m", streamPollMs: 1000, log: () => {},
  });
  // deno-lint-ignore no-explicit-any
  const doc = openApiDocument(app) as any;
  const base = doc.paths["/workbench/contract/cleanup/dismissals"];
  assert(base.get && base.post);
  const one = doc.paths["/workbench/contract/cleanup/dismissals/{id}"];
  assert(one.delete);
  for (const o of [base.get, base.post, one.delete]) assert(!o["x-mcp-tool"], "a dismissal is never on the shared MCP surface");
  assertEquals(doc.components.schemas.DismissalCreate.properties.kind["x-registry"], "dismissal_kinds");
  assertEquals(doc.components.schemas.DismissalCreate.additionalProperties, false);
});

Deno.test("D7: the dismissal routes are user-only: a service key reaches none of them", () => {
  for (const p of ["/workbench/contract/cleanup/dismissals", `/workbench/contract/cleanup/dismissals/${ID}`]) assert(USER_ONLY.test(p), p);
  assertEquals(USER_ONLY.test("/workbench/contract/cleanup/sources"), false);
});

Deno.test("D8: migration files: the slot is mounted once, the revert undoes what the forward adds", async () => {
  let compose: string, fwd: string, rev: string;
  try {
    const d = new URL("../../../", import.meta.url);
    compose = await Deno.readTextFile(new URL("docker-compose.yml", d));
    fwd = await Deno.readTextFile(new URL("init-cleanup-dismissals.sql", d));
    rev = await Deno.readTextFile(new URL("revert-cleanup-dismissals.sql", d));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  assert(compose.includes("./init-cleanup-dismissals.sql:/docker-entrypoint-initdb.d/710-init-cleanup-dismissals.sql:ro"));
  assertEquals((compose.match(/\/docker-entrypoint-initdb\.d\/710-/g) ?? []).length, 1);
  assert(/revert: .*revert-cleanup-dismissals\.sql/.test(compose) && /fresh-volume/.test(compose) && /live: psql -f/.test(compose));
  assert(/CREATE TABLE IF NOT EXISTS public\.cleanup_dismissals/.test(fwd) && /DROP TABLE IF EXISTS public\.cleanup_dismissals/.test(rev));
  assert(/UNIQUE \(owner_sub, kind, ref\)/.test(fwd), "one dismissal per person per thing");
  assert(fwd.includes("('dismissal_kinds',") && rev.includes("'dismissal_kinds'"));
  assertEquals([...fwd.matchAll(/\('dismissal_kinds', '([a-z_]+)'/g)].map((m) => m[1]).sort(), ["reopen_candidate", "suggestion"]);
  assert(!/(ALTER|CREATE (OR REPLACE )?TRIGGER|UPDATE) .*public\.(sources|claims|tombstones|reference_records)/i.test(fwd), "no shared table is touched");
});
