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
import { AT, harness, type Handler, lifeUnlinked, lockUnlinked, SRC, TOMB, tombInsert, tombRow, tombSelect } from "./cleanup_harness_test.ts";

const failingAction: Handler = [/INSERT INTO public\.cleanup_actions/, () => { throw new Error("action insert failed (planted)"); }];

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

const REFB = "cleanup-action:11111111-1111-4111-8111-111111111111"; // an erase action whose private row u-bee owns
const ownsB: Handler = [/FROM public\.cleanup_actions\s+WHERE 'cleanup-action:' \|\| id::text = \$1/, (a) => [{ owns: a[0] === REFB && a[1] === "u-bee" }]];

Deno.test("L2 (round 3b): the cleanup erase records eraser_user = its action ref, whose private row is the caller's", async () => {
  const h = harness([lockUnlinked, lifeUnlinked, tombInsert, tombSelect(),
    [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: a[4], source_id: a[5], tombstone_id: a[6], detail: {}, created_at: AT, finished_at: AT }]]]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/sources/${SRC}/erase`, { reason_type: "deliberate" });
  assertEquals(r.status, 200, await r.text());
  const ins = h.seen.find((s) => /INSERT INTO public\.source_tombstones/.test(s.sql))!;
  const own = h.seen.find((s) => /INSERT INTO public\.cleanup_actions/.test(s.sql))!;
  assertEquals([ins.args[4], ins.args[6], own.args[1]], ["user", `cleanup-action:${own.args[0]}`, "u-ay"], "eraser_user is the ref; the private row is u-ay's");
});

Deno.test("L1: the cleanup lift is the operator's rule - another user is 403 with nothing written; `by` is ignored", async () => {
  const action: Handler = [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: null, source_id: null, tombstone_id: a[6], detail: {}, created_at: AT, finished_at: AT }]];
  const lock: Handler = [/FROM public\.source_tombstones WHERE id = \$1 FOR UPDATE/, () => [{ id: TOMB, lifted_at: null }]];
  // not the eraser (u-bee's private row owns the ref)
  let h = harness([ownsB, lock, tombSelect({ eraser_user: REFB }), action]);
  let r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {});
  assertEquals(r.status, 403, await r.text());
  assertEquals(h.committed(/UPDATE public\.source_tombstones|INSERT INTO public\.cleanup_actions/).length, 0);
  // `by` naming the eraser does not make another user the eraser
  r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, { by: "u-bee" });
  assertEquals(r.status, 403, await r.text());
  // the eraser: lifted (with a `by` the route ignores, as the trail's lift does)
  h = harness([ownsB, lock, [/UPDATE public\.source_tombstones SET lifted_at/, () => [{ source_id: SRC }]],
    tombSelect({ eraser_user: REFB, lifted_at: AT, lifted_by: "PLACEHOLDER" }), action]);
  r = await h.call("u-bee", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, { by: "ForgedLifter", note: "ok" });
  assertEquals(r.status, 200, await r.text());
  const upd = h.seen.find((s) => /UPDATE public\.source_tombstones SET lifted_at/.test(s.sql))!;
  assert(!JSON.stringify(upd.args).includes("ForgedLifter"), "the body's `by` is never the lifter");
  // a repeat lift: 409, no action
  h = harness([ownsB, [/FROM public\.source_tombstones WHERE id = \$1 FOR UPDATE/, () => [{ id: TOMB, lifted_at: AT }]], tombSelect({ eraser_user: REFB, lifted_at: AT }), action]);
  r = await h.call("u-bee", "POST", `/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {});
  assertEquals(r.status, 409, await r.text());
  assertEquals(h.committed(/INSERT INTO public\.cleanup_actions/).length, 0);
});

Deno.test("L3 (round 3b, the backstop): a subject that slipped into a shared row is answered as null to anyone else; a ref passes", async () => {
  const h = harness([ownsB, tombSelect({ eraser_user: "u-bee", lifted_at: AT, lifted_by: REFB })]);
  const asA = await (await h.call("u-ay", "GET", `/workbench/contract/tombstones/${TOMB}`)).json();
  assertEquals([asA.eraser_user, asA.lifted_by, asA.may_lift, asA.erased_by_you], [null, REFB, false, false], JSON.stringify(asA));
  const asB = await (await h.call("u-bee", "GET", `/workbench/contract/tombstones/${TOMB}`)).json();
  // its own subject is not hidden from B - but it is NOT ownership either (no private row): may_lift false
  assertEquals([asB.eraser_user, asB.may_lift, asB.erased_by_you], ["u-bee", false, false]);
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
