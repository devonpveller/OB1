// deno test src/contracts/cleanup_round3c_test.ts - rw-p8a2-cleanup2 (round 3c; review r-p8a2-cleanup delta M1, M2, N2).
//   M1  POST /contract/sources/{id}/erase with an eraser kind other than `user` (automation, fixture) is accepted only
//       from a service or an admin - a signed-in user (or the default identity) gets 403 and nothing is written, so no
//       user can erase without a private record or opt a source into automatic readmission.
//   M2  POST /workbench/sources/:id/restore, the legacy staged retract and the purge door name a signed-in caller only by
//       an action ref with its private row (one transaction); the purge door no longer copies a body `by` into the trail
//       (claimed_by), and the staged retract ignores a body `by` for a signed-in caller. The behaviour is proved in the
//       lab (cleanup_integration_test.ts: B restores, then the whole-row scan); this file checks the doors' source.
// No database: the round-3 harness.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { harness, type Handler, lifeUnlinked, lockUnlinked, SRC, tombInsert, tombSelect } from "./cleanup_harness_test.ts";

const body = { reason_type: "debunked", eraser: { kind: "automation", run_id: "run-3c" } };
const handlers = (): Handler[] => [lockUnlinked, lifeUnlinked, tombInsert, tombSelect({ eraser_kind: "automation", eraser_user: null, eraser_run_id: "run-3c" })];
const erased = (h: ReturnType<typeof harness>) => h.committed(/INSERT INTO public\.source_tombstones|DELETE FROM public\.sources WHERE id/).length;
const admin = { sub: "u-admin", actor: "u-admin", name: "Admin", key: "u-admin", kind: "user" as const, admin: true, impersonating: null };

Deno.test("M1: a signed-in user declaring an automation eraser is 403, and nothing is erased", async () => {
  const h = harness(handlers());
  const r = await h.call("u-ay", "POST", `/workbench/contract/sources/${SRC}/erase`, body);
  assertEquals(r.status, 403, await r.text());
  assertEquals(erased(h), 0);
});

Deno.test("M1: the default identity (no sign-in, no header) declaring an automation eraser is 403 too", async () => {
  const h = harness(handlers());
  const r = await h.call("", "POST", `/workbench/contract/sources/${SRC}/erase`, body);
  assertEquals(r.status, 403, await r.text());
  assertEquals(erased(h), 0);
});

Deno.test("M1: a service may record an automation eraser (its run id), and so may an admin", async () => {
  let h = harness(handlers());
  let r = await h.call("service", "POST", `/workbench/contract/sources/${SRC}/erase`, body);
  assertEquals(r.status, 200, await r.text());
  const ins = h.seen.find((s) => /INSERT INTO public\.source_tombstones/.test(s.sql))!;
  assertEquals([ins.args[4], ins.args[5], ins.args[6]], ["automation", "run-3c", null]);
  h = harness(handlers(), { identity: admin });
  r = await h.call("", "POST", `/workbench/contract/sources/${SRC}/erase`, body);
  assertEquals(r.status, 200, await r.text());
});

Deno.test("M1: a user eraser is still open to a signed-in user (with its private ref)", async () => {
  const action: Handler = [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: null, source_id: null, tombstone_id: null, detail: {}, created_at: "x", finished_at: "x" }]];
  const h = harness([action, ...handlers()]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/sources/${SRC}/erase`, { reason_type: "deliberate", eraser: { kind: "user", user: "x" } });
  assertEquals(r.status, 200, await r.text());
});

Deno.test("M2 / N2: the legacy source doors name a signed-in caller only by an action ref; a body `by` is never written", async () => {
  const src = await Deno.readTextFile(new URL("../routes/sources.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const bad = [
    /repo\.restore\(.*authorOf\(c\)/.test(code) && "restore hands the seam's author to the trail",
    /retractStaged\(id, body\?\.by/.test(code) && "the staged retract writes a body `by` as retracted_by",
    /claimed_by/.test(code) && "the purge door copies a body `by` into the trail detail",
  ].filter(Boolean);
  assertEquals(bad, []);
  const repo = await Deno.readTextFile(new URL("../repositories/sources.ts", import.meta.url));
  assert(/INSERT INTO public\.cleanup_actions/.test(repo), "restore / retract record the private row in their own transaction");
});
