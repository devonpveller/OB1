// deno test src/contracts/toplace_test.ts - the document's "to place" queue (rwr-doc-toplace-api), no database: the
// repository's scoping, the one refusal text for another user's and a missing document / row, the placement's
// transaction, the contract document, the owner scope's text fields, and the migration files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { BadRequest } from "./logic/scope.ts";
import { Conflict, NotFound } from "./repo/lifecycle.ts";
import { addPendingRef, listPendingRefs, NO_DOC, NO_REF, placePendingRef, removePendingRef } from "./repo/pending_refs.ts";
import { PendingRef, PendingRefCreate, PendingRefPlace } from "./schemas/pending_refs.ts";
import type { Identity } from "../middleware/identity.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import { documentPathsIn } from "../documents/ownership.ts";

const WHO: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const SRC = "11111111-1111-4111-8111-111111111111";
const CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ROW = "9e1d0000-0000-4000-8000-000000000001";
const DOC = "documents/user-a/notes.md";

const row = { id: ROW, path: DOC, source_id: SRC, claim_id: null, section: "", quote: "", added_from: "source", created_at: "t" };

// a recording Db: every statement is kept; `listed` says whether the document is the caller's listed one
function recorder(o: { listed?: boolean; target?: boolean; claim?: boolean; count?: number } = {}) {
  const log: { sql: string; args: unknown[] }[] = [];
  const events: string[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: s, args });
      if (/FROM public\.user_document_listings WHERE path = \$1 AND owner_sub = \$2/.test(s)) return Promise.resolve([{ ok: o.listed ?? true }] as T[]);
      if (/FROM public\.claims WHERE id/.test(s)) return Promise.resolve([{ ok: o.claim ?? true }] as T[]);
      if (/count\(\*\)::int AS n FROM public\.document_pending_refs/.test(s)) return Promise.resolve([{ n: o.count ?? 0 }] as T[]);
      if (/^INSERT INTO public\.document_pending_refs/.test(s)) return Promise.resolve([row] as T[]);
      if (/^DELETE FROM public\.document_pending_refs/.test(s)) return Promise.resolve([row] as T[]);
      return Promise.resolve([] as T[]); // no source / held source: targetHead and placeReference find nothing
    },
    tx: async (fn) => {
      events.push("begin");
      try {
        const out = await fn(db);
        events.push("commit");
        return out;
      } catch (e) {
        events.push("rollback");
        throw e;
      }
    },
  };
  return { db, log, events };
}
const reg = (db: Db) => new RegistryReader(db);

Deno.test("T1: adding a cite writes only its own queue row; shared knowledge is only ever read", async () => {
  const { db, log } = recorder({ target: true });
  // targetHead finds nothing in this fake: use a claim, which the fake knows
  const r = await addPendingRef(db, WHO, { path: DOC, claim_id: CLAIM, added_from: "claim" });
  assertEquals(r.id, ROW);
  const writes = log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.sql));
  assertEquals(writes.length, 1);
  assert(/^INSERT INTO public\.document_pending_refs/.test(writes[0].sql), writes[0].sql);
  assertEquals(writes[0].args[0], "user-a", "owner_sub is the seam's subject");
  assertEquals(writes[0].args[1], "user-a", "actor_sub is the seam's actor");
  assert(log.every((l) => !/sources|claims|reference_records/.test(l.sql) || /^SELECT/.test(l.sql)), "shared tables are only read");
});

Deno.test("T2: exactly one of source_id / claim_id, decided before any statement runs", async () => {
  const { db, log } = recorder();
  await assertRejects(() => addPendingRef(db, WHO, { path: DOC, added_from: "source" }), BadRequest);
  await assertRejects(() => addPendingRef(db, WHO, { path: DOC, source_id: SRC, claim_id: CLAIM, added_from: "source" }), BadRequest);
  assertEquals(log.length, 0);
});

Deno.test("T3: another user's document, an unlisted one and a missing one are one refusal; nothing is written", async () => {
  for (const listed of [false]) {
    const { db, log } = recorder({ listed });
    const e = await assertRejects(() => addPendingRef(db, WHO, { path: DOC, claim_id: CLAIM, added_from: "claim" }), NotFound);
    assertEquals((e as Error).message, NO_DOC);
    const e2 = await assertRejects(() => listPendingRefs(db, WHO, DOC, 10), NotFound);
    assertEquals((e2 as Error).message, NO_DOC);
    assertEquals(log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.sql)).length, 0);
    // the ownership test is by the listing row's owner, in SQL, with the seam's subject
    assert(log.every((l) => l.args.includes("user-a") || l.args.length === 0));
  }
  // a path that is no document path is the caller's error whoever owns what
  const { db } = recorder();
  await assertRejects(() => addPendingRef(db, WHO, { path: "notes/x.txt", claim_id: CLAIM, added_from: "claim" }), BadRequest);
});

Deno.test("T4: every statement over the queue is scoped by owner_sub in the query", async () => {
  const { db, log } = recorder();
  await listPendingRefs(db, WHO, DOC, 50);
  await removePendingRef(db, WHO, ROW);
  await placePendingRef(db, reg(db), WHO, ROW, "chip").catch(() => {}); // placement itself finds no source in the fake
  const own = log.filter((l) => /document_pending_refs/.test(l.sql) && !/^INSERT/.test(l.sql));
  assert(own.length >= 4);
  for (const l of own) assert(/owner_sub = \$[12]/.test(l.sql), `unscoped: ${l.sql}`);
  assert(own.every((l) => l.args.includes("user-a")));
});

Deno.test("T5: another user's row, a missing row and a malformed id are the same refusal (same text, no statement for a malformed id)", async () => {
  const miss: Db = { query: <T>() => Promise.resolve([] as T[]), tx: (fn) => fn(miss) };
  const a = await assertRejects(() => removePendingRef(miss, WHO, ROW), NotFound);
  const b = await assertRejects(() => removePendingRef(miss, WHO, "not-an-id"), NotFound);
  const c = await assertRejects(() => placePendingRef(miss, reg(miss), WHO, ROW, undefined), NotFound);
  const d = await assertRejects(() => placePendingRef(miss, reg(miss), WHO, "../x", undefined), NotFound);
  for (const e of [a, b, c, d]) assertEquals((e as Error).message, NO_REF);
  const { db, log } = recorder();
  await assertRejects(() => removePendingRef(db, WHO, "not-an-id"), NotFound);
  assertEquals(log.length, 0);
});

Deno.test("T6: placing claims the row and places in ONE transaction; a refusal rolls the removal back", async () => {
  const { db, events, log } = recorder();
  await assertRejects(() => placePendingRef(db, reg(db), WHO, ROW, "chip"), NotFound, "no source or held source"); // the fake has no source
  assertEquals(events, ["begin", "rollback"]);
  assert(/^DELETE FROM public\.document_pending_refs/.test(log[0].sql), "the row is claimed first, inside the transaction");
  // an unknown form is refused before anything runs
  const r2 = recorder();
  await assertRejects(() => placePendingRef(r2.db, reg(r2.db), WHO, ROW, "added"), BadRequest);
  assertEquals(r2.log.length, 0);
  // a transclusion needs a quote: the row stays (rolled back)
  const r3 = recorder();
  await assertRejects(() => placePendingRef(r3.db, reg(r3.db), WHO, ROW, "transclusion"), BadRequest, "needs a quote");
  assertEquals(r3.events, ["begin", "rollback"]);
});

Deno.test("T7: a duplicate cite is a conflict naming only the caller's own row; a full queue is a conflict", async () => {
  const dup: Db = {
    query: <T>(sql: string) => {
      if (/user_document_listings/.test(sql)) return Promise.resolve([{ ok: true }] as T[]);
      if (/FROM public\.claims/.test(sql)) return Promise.resolve([{ ok: true }] as T[]);
      if (/count\(\*\)/.test(sql)) return Promise.resolve([{ n: 0 }] as T[]);
      if (/^\s*INSERT/.test(sql)) return Promise.resolve([] as T[]); // ON CONFLICT DO NOTHING
      return Promise.resolve([{ id: ROW }] as T[]);
    },
    tx: (fn) => fn(dup),
  };
  const e = await assertRejects(() => addPendingRef(dup, WHO, { path: DOC, claim_id: CLAIM, added_from: "claim" }), Conflict);
  assertEquals((e as Conflict).detail, { pending_ref_id: ROW });
  const full = recorder({ count: 200 });
  await assertRejects(() => addPendingRef(full.db, WHO, { path: DOC, claim_id: CLAIM, added_from: "claim" }), Conflict, "queue is full");
});

Deno.test("T8: the contract document carries the four routes, strict bodies with no user field, and no MCP tool", () => {
  const noDb: Db = { query: () => Promise.reject(new Error("no db")), tx: () => Promise.reject(new Error("no db")) };
  const app = createContractApp({
    db: noDb, registry: new RegistryReader(noDb), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/m", streamPollMs: 1000, log: () => {},
  });
  // deno-lint-ignore no-explicit-any
  const d = openApiDocument(app) as any;
  const base = d.paths["/workbench/contract/documents/pending-refs"];
  assert(base.get && base.post);
  assert(d.paths["/workbench/contract/documents/pending-refs/{id}"].delete);
  assert(d.paths["/workbench/contract/documents/pending-refs/{id}/place"].post);
  for (const op of [base.get, base.post, d.paths["/workbench/contract/documents/pending-refs/{id}"].delete, d.paths["/workbench/contract/documents/pending-refs/{id}/place"].post]) {
    assert(!op["x-mcp-tool"], "a queue row is never on the shared MCP surface");
  }
  assertEquals(d.components.schemas.PendingRefCreate.additionalProperties, false);
  assertEquals(d.components.schemas.PendingRefPlace.additionalProperties, false);
  for (const k of ["owner_sub", "actor_sub", "user", "owner"]) {
    assert(!(k in d.components.schemas.PendingRefCreate.properties), `no ${k} on the request`);
    assert(!(k in d.components.schemas.PendingRef.properties), `no ${k} on the response`);
  }
  assertEquals(PendingRefCreate.safeParse({ path: DOC, source_id: SRC, added_from: "source", owner_sub: "x" }).success, false);
  assertEquals(PendingRefCreate.safeParse({ path: DOC, source_id: SRC, added_from: "Bad Label" }).success, false);
  assertEquals(PendingRefCreate.safeParse({ path: DOC, source_id: SRC, added_from: "source", quote: "a\u0000b" }).success, false);
  assertEquals(PendingRefCreate.safeParse({ path: DOC, source_id: SRC, added_from: "source", quote: "two\nlines\tand tab" }).success, true);
  assertEquals(PendingRefPlace.safeParse({ user: "b" }).success, false);
  assertEquals(PendingRef.safeParse({ ...row, created_at: "2026-01-01T00:00:00.000Z" }).success, true);
});

Deno.test("T9: the queue routes are user-only; a quote that names a document path is text, not a path", async () => {
  for (const p of ["/workbench/contract/documents/pending-refs", `/workbench/contract/documents/pending-refs/${ROW}`, `/workbench/contract/documents/pending-refs/${ROW}/place`]) assert(USER_ONLY.test(p), p);
  assertEquals(USER_ONLY.test("/workbench/contract/documents"), false, "the listing keeps its own rule");
  assertEquals(USER_ONLY.test("/workbench/contract/documents/coverage"), false);
  // the request gate does not search a `quote` field for paths (a source can quote one), but still searches `section`
  const { ownerScope } = await import("../middleware/owner-scope.ts");
  const { Hono } = await import("hono");
  const noDb: Db = { query: <T>() => Promise.resolve([] as T[]), tx: (fn) => fn(noDb) };
  const app = new Hono();
  app.use("*", ownerScope(noDb));
  app.post("/workbench/contract/documents/pending-refs", (c) => c.json({ ok: true }));
  const OWN = "documents/operator/notes.md"; // the seam's default identity (no sign-in) is 'operator'
  const post = (b: unknown) => app.request("/workbench/contract/documents/pending-refs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assertEquals((await post({ path: OWN, quote: "see documents/other-user/secret.md for details" })).status, 200);
  assertEquals((await post({ path: OWN, section: "documents/other-user/secret.md" })).status, 404);
  assertEquals((await post({ path: "documents/other-user/secret.md", source_id: SRC })).status, 404);
  assert(documentPathsIn("documents/other-user/secret.md").length === 1);
});

Deno.test("T10: migration files: slot 630 is mounted, the forward is the FK-carried queue, the revert drops only its table", async () => {
  let compose: string, fwd: string, rev: string, chk: string;
  try {
    const d = new URL("../../../", import.meta.url);
    compose = await Deno.readTextFile(new URL("docker-compose.yml", d));
    fwd = await Deno.readTextFile(new URL("init-document-toplace.sql", d));
    rev = await Deno.readTextFile(new URL("revert-document-toplace.sql", d));
    chk = await Deno.readTextFile(new URL("check-document-toplace.sql", d));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  assert(compose.includes("./init-document-toplace.sql:/docker-entrypoint-initdb.d/630-init-document-toplace.sql:ro"));
  assertEquals((compose.match(/\/docker-entrypoint-initdb\.d\/630-/g) ?? []).length, 1);
  assert(/revert: put the previous workbench image back FIRST, then revert-document-toplace\.sql/.test(compose) && /fresh-volume/.test(compose) && /live: psql -f/.test(compose));
  assert(/CREATE TABLE IF NOT EXISTS public\.document_pending_refs/.test(fwd));
  assert(/REFERENCES public\.user_document_listings \(path\) ON UPDATE CASCADE ON DELETE CASCADE/.test(fwd), "the queue follows its document by FK");
  assert(/ob_workbench/.test(fwd) && /service_role/.test(fwd), "the role guards");
  assert(/GRANT SELECT, INSERT, DELETE ON public\.document_pending_refs TO service_role/.test(fwd), "the app's rights are exact");
  assert(!/GRANT[^;]*\bUPDATE\b/i.test(fwd) && !/\bTO PUBLIC\b/i.test(fwd));
  assert(!/(ALTER|CREATE (OR REPLACE )?TRIGGER|UPDATE) .*public\.(sources|claims|reference_records)/i.test(fwd), "no shared knowledge table is touched");
  // the revert drops exactly the one table and nothing else
  const stmts = rev.split(/\r?\n/).filter((l) => /^\s*(DROP|DELETE|ALTER|REVOKE|UPDATE)\b/i.test(l));
  assertEquals(stmts, ["DROP TABLE IF EXISTS public.document_pending_refs;"]);
  assert(/document_pending_refs/.test(chk) && /orphan_rows/.test(chk) && /cross_owner_rows/.test(chk) && /grants_exact/.test(chk));
});
