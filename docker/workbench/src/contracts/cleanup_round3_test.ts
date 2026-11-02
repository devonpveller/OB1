// deno test src/contracts/cleanup_round3_test.ts - rw-p8a2-cleanup round 3 (forward-merge onto rw-p8a1-core and
// rw-p8a3-room; the operator's lift rule 2026-11-02; reviewer RF1/RF2), no database: a scripted Db that models
// transactions (a statement belongs to the transaction it ran in; a throw rolls that transaction back), behind the
// real identity seam in header mode (X-Test-Sub), mounted as src/app.ts mounts the contract app.
//   L1  the cleanup lift goes through liftTombstoneAs: a caller who is not the eraser (nor an admin) is 403 with
//       nothing written; `by` is accepted and ignored, as on the trail's lift; a repeat lift is still 409, no action
//   L2  the cleanup erase (and process-all) records eraser_user = the identity seam's subject
//   L3  a tombstone read names its eraser / lifter only to that user (or an admin / the single-user operator):
//       eraser_user is the subject now, and another user must not read it
//   RF1 sever and erase commit in ONE transaction with their cleanup action: a failed action insert rolls back the
//       irreversible step
//   RF2 the reopen-candidate read pages until it has `limit` candidates: non-candidates cannot push one off
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { internalError } from "../middleware/errors.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";

const SRC = "33333333-3333-4333-8333-333333333333";
const TOMB = "66666666-6666-4666-8666-666666666667";
const AT = "2026-11-02T00:00:00.000Z";

interface Stmt { sql: string; args: unknown[]; tx: number }
type Handler = [RegExp, (args: unknown[]) => unknown[]];

const REG = [
  ["erasure_reasons", "deliberate", { reopen_path: "note_only" }], ["erasure_reasons", "debunked", { reopen_path: "rescore_contest" }],
  ["erasers", "user", { gate: "candidate", requires: "user" }], ["erasers", "automation", { gate: "auto", requires: "run_id" }],
  ["dependence_kinds", "chunk", { blocks_erase: true, severable: true }], ["dependence_kinds", "trail_event", { blocks_erase: false, severable: false }],
].map(([registry, key, definition]) => ({ registry, key, version: 1, label: key, definition, retired_at: null, superseded_by: null }));

const tombRow = (over: Record<string, unknown> = {}) => ({
  id: TOMB, source_id: SRC, url: "https://example.org/x", title: "x", reason_type: "deliberate", note: null, batch_run_id: null,
  eraser_kind: "user", eraser_user: "u-bee", eraser_run_id: null, confidence: null, score_version: null, fingerprint: null,
  erased_at: AT, lifted_at: null, lifted_by: null, readmitted_source_id: null, attempts: [], readmitted_in_scope: false, ...over,
});

function harness(handlers: Handler[]) {
  const seen: Stmt[] = [];
  const rolledBack = new Set<number>();
  let nextTx = 0;
  const make = (tx: number): Db => ({
    query: <T>(sql: string, args: unknown[] = []) => {
      seen.push({ sql, args, tx });
      if (/FROM public\.contract_registry_view/.test(sql)) return Promise.resolve(REG as T[]);
      for (const [re, fn] of handlers) if (re.test(sql)) return Promise.resolve().then(() => fn(args) as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: async <T>(fn: (d: Db) => Promise<T>) => {
      if (tx !== 0) return await fn(make(tx)); // nested: the same transaction
      const id = ++nextTx;
      try {
        return await fn(make(id));
      } catch (e) {
        rolledBack.add(id);
        throw e;
      }
    },
  });
  const db = make(0);
  const contract = createContractApp({
    db, registry: new RegistryReader(db, 0), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 10, log: () => {},
  });
  const env = (k: string) => ({ WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" } as Record<string, string>)[k];
  const app = new Hono();
  app.onError(internalError);
  app.use("*", identitySeam(seamDeps(null, env)));
  app.route("/", contract);
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", "x-test-sub": who }, body: body === undefined ? undefined : JSON.stringify(body) });
  // a statement committed = it ran outside any transaction, or in one that was not rolled back
  const committed = (re: RegExp) => seen.filter((s) => re.test(s.sql) && (s.tx === 0 || !rolledBack.has(s.tx)));
  return { call, seen, committed };
}

const failingAction: Handler = [/INSERT INTO public\.cleanup_actions/, () => { throw new Error("action insert failed (planted)"); }];
const lockUnlinked: Handler = [/FROM public\.sources WHERE id = \$1 FOR UPDATE/, () => [{ id: SRC, lifecycle: "unlinked", url: "https://example.org/x", title: "x", content: "c" }]];
const lifeUnlinked: Handler = [/AS lifecycle FROM public\.sources\s+WHERE id = \$1 AND/, () => [{ lifecycle: "unlinked" }]];
const tombInsert: Handler = [/INSERT INTO public\.source_tombstones/, () => [{ id: TOMB }]];
const tombSelect = (over: Record<string, unknown> = {}): Handler => [/FROM public\.source_tombstones t/, () => [tombRow(over)]];

Deno.test("RF1: a failed cleanup-action insert rolls back the erase - nothing is erased", async () => {
  const h = harness([failingAction, lockUnlinked, lifeUnlinked, tombInsert, tombSelect()]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/sources/${SRC}/erase`, { reason_type: "deliberate" });
  assertEquals(r.status, 500, await r.text());
  assert(h.seen.some((s) => /DELETE FROM public\.sources WHERE id/.test(s.sql)), "the erase ran");
  assertEquals(h.committed(/DELETE FROM public\.sources WHERE id|INSERT INTO public\.source_tombstones/).length, 0,
    "the source delete and the tombstone are rolled back with the failed action");
});

Deno.test("RF1: a failed cleanup-action insert rolls back the sever - no connection is removed", async () => {
  const h = harness([
    failingAction,
    [/FROM public\.sources WHERE id = \$1 FOR UPDATE/, () => [{ id: SRC, lifecycle: "suppressed", url: "u", title: "x", content: "c" }]],
    [/AS lifecycle FROM public\.sources\s+WHERE id = \$1 AND/, () => [{ lifecycle: "suppressed" }]],
    [/source_dependence\(\$1\) d/, () => [{ kind: "chunk", ref: "0", detail: {} }]],
    [/source_blocking_dependence/, () => [{ n: 0 }]],
  ]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/sources/${SRC}/sever`, { all: true });
  assertEquals(r.status, 500, await r.text());
  assert(h.seen.some((s) => /DELETE FROM public\.source_chunks/.test(s.sql)), "the sever ran");
  assertEquals(h.committed(/DELETE FROM public\.source_chunks|INSERT INTO public\.source_trail_events/).length, 0, "the sever is rolled back");
});

Deno.test("L2: the cleanup erase records eraser_user = the identity seam's subject (never an action ref, never the body)", async () => {
  const h = harness([lockUnlinked, lifeUnlinked, tombInsert, tombSelect({ eraser_user: "u-ay" }),
    [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: a[4], source_id: a[5], tombstone_id: a[6], detail: {}, created_at: AT, finished_at: AT }]]]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/sources/${SRC}/erase`, { reason_type: "deliberate" });
  assertEquals(r.status, 200, await r.text());
  const ins = h.seen.find((s) => /INSERT INTO public\.source_tombstones/.test(s.sql))!;
  assertEquals([ins.args[4], ins.args[6]], ["user", "u-ay"], "eraser_kind user, eraser_user the seam's subject");
});

Deno.test("L1: the cleanup lift is the operator's rule - another user is 403 with nothing written; `by` is ignored", async () => {
  const action: Handler = [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: null, source_id: null, tombstone_id: a[6], detail: {}, created_at: AT, finished_at: AT }]];
  const lock: Handler = [/FROM public\.source_tombstones WHERE id = \$1 FOR UPDATE/, () => [{ id: TOMB, lifted_at: null }]];
  // not the eraser
  let h = harness([lock, tombSelect({ eraser_user: "u-bee" }), action]);
  let r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {});
  assertEquals(r.status, 403, await r.text());
  assertEquals(h.committed(/UPDATE public\.source_tombstones|INSERT INTO public\.cleanup_actions/).length, 0);
  // `by` naming the eraser does not make another user the eraser
  r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, { by: "u-bee" });
  assertEquals(r.status, 403, await r.text());
  // the eraser: lifted (with a `by` the route ignores, as the trail's lift does)
  h = harness([lock, [/UPDATE public\.source_tombstones SET lifted_at/, () => [{ source_id: SRC }]],
    tombSelect({ eraser_user: "u-bee", lifted_at: AT, lifted_by: "PLACEHOLDER" }), action]);
  r = await h.call("u-bee", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, { by: "ForgedLifter", note: "ok" });
  assertEquals(r.status, 200, await r.text());
  const upd = h.seen.find((s) => /UPDATE public\.source_tombstones SET lifted_at/.test(s.sql))!;
  assert(!JSON.stringify(upd.args).includes("ForgedLifter"), "the body's `by` is never the lifter");
  // a repeat lift: 409, no action
  h = harness([[/FROM public\.source_tombstones WHERE id = \$1 FOR UPDATE/, () => [{ id: TOMB, lifted_at: AT }]], tombSelect({ eraser_user: "u-bee", lifted_at: AT }), action]);
  r = await h.call("u-bee", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {});
  assertEquals(r.status, 409, await r.text());
  assertEquals(h.committed(/INSERT INTO public\.cleanup_actions/).length, 0);
});

Deno.test("L3: a tombstone names its eraser and lifter only to that user", async () => {
  const h = harness([tombSelect({ eraser_user: "u-bee", lifted_at: AT, lifted_by: "u-bee" })]);
  const asA = await (await h.call("u-ay", "GET", `/workbench/contract/tombstones/${TOMB}`)).json();
  assertEquals([asA.eraser_user, asA.lifted_by, asA.may_lift], [null, null, false], JSON.stringify(asA));
  const asB = await (await h.call("u-bee", "GET", `/workbench/contract/tombstones/${TOMB}`)).json();
  assertEquals([asB.eraser_user, asB.lifted_by, asB.may_lift], ["u-bee", "u-bee", true]);
});

Deno.test("RF2: non-candidate tombstones cannot push a candidate off the page", async () => {
  // page 1 (the first `limit` rows by the read's order) holds only refused attempts; the candidate is next
  const nonCand = (i: number) => ({ ...tombRow({ id: `66666666-6666-4666-8666-00000000000${i}`, eraser_user: "u-x" }), erased_by_you: false,
    attempts: [{ path: "intake", outcome: "candidate", session_id: null, note: null, attempted_at: AT, reason: "x", score: null }] });
  const cand = { ...tombRow({ id: "66666666-6666-4666-8666-0000000000c1", eraser_user: "u-x" }), erased_by_you: false,
    attempts: [{ path: "query", outcome: "note_appended", session_id: "s", note: "promising", attempted_at: AT, reason: null, score: null }] };
  const rows = [nonCand(1), nonCand(2), cand];
  const h = harness([[/FROM public\.source_tombstones t\s+WHERE t\.lifted_at IS NULL/, (a) => {
    const limit = Number(a[1]), offset = Number(a[2] ?? 0);
    return rows.slice(offset, offset + limit);
  }]]);
  const r = await (await h.call("u-ay", "GET", "/workbench/contract/cleanup/reopen-candidates?limit=2")).json();
  assertEquals(r.candidates.map((c: any) => c.tombstone.id), ["66666666-6666-4666-8666-0000000000c1"], JSON.stringify(r));
});
