// deno test src/contracts/cleanup_round2_test.ts - rw-p8a2-cleanup round 2 (tester t-p8a2-cleanup attempt 1), no
// database (a recording stub Db).
//   D1  the listing's `counts` has a FIXED key set - every dependence kind, zero-filled - in the schema, the repo
//       and the example, so whichever source is first, its row has every key the example has (Dredd derived the
//       body's required keys from the example and failed on a row whose counts held only trail_event)
//   N2  an erase (any cleanup write) with a JSON content type and no body is a 400, never a 500
//   N3  lifting an already-lifted tombstone is a 409 and records no second cleanup action
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { Hono } from "hono";
import { internalError } from "../middleware/errors.ts";
import { DEPENDENCE_KINDS, fullCounts } from "./logic/cleanup.ts";
import { CleanupSource, CleanupSources, CX } from "./schemas/cleanup.ts";

Deno.test("D1: every dependence kind the migrations seed is in the fixed counts key set (when the migrations are reachable)", async () => {
  let sql = "";
  try {
    for (const f of ["init-research-contract.sql", "init-references.sql"]) sql += await Deno.readTextFile(new URL(`../../../${f}`, import.meta.url));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  const seeded = [...new Set([...sql.matchAll(/\('dependence_kinds',\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
  assertEquals([...DEPENDENCE_KINDS].sort(), seeded);
});

Deno.test("D1: the counts are zero-filled to the fixed key set; a kind the registry adds later is kept", () => {
  const c = fullCounts({ trail_event: 2, a_later_kind: 1 });
  for (const k of DEPENDENCE_KINDS) assertEquals(typeof c[k], "number", k);
  assertEquals([c.trail_event, c.chunk, c.claim_edge, c.a_later_kind], [2, 0, 0, 1]);
});

Deno.test("D1: the schema requires every kind; the example carries every kind; a Dredd-shaped row matches the example's keys", () => {
  const row = { ...CX.sources.sources[0], id: "d0000000-0000-4000-8000-0000000000d1", counts: fullCounts({ trail_event: 2 }) };
  assert(CleanupSource.safeParse(row).success);
  assertEquals(CleanupSource.safeParse({ ...row, counts: { trail_event: 2 } }).success, false, "a partial counts object is refused");
  const exampleKeys = Object.keys(CX.sources.sources[0].counts).sort();
  assertEquals(exampleKeys, [...DEPENDENCE_KINDS].sort(), "the example's counts are the fixed key set");
  for (const k of exampleKeys) assert(k in row.counts, `row lacks ${k}`);
  assert(CleanupSources.safeParse(CX.sources).success);
});

// a stub Db that records every statement and answers a lifted tombstone
function stubApp(answers: (sql: string) => unknown[] = () => []) {
  const seen: string[] = [];
  const db: Db = {
    query: <T>(sql: string) => {
      seen.push(sql);
      return Promise.resolve(answers(sql) as T[]);
    },
    tx: (fn) => fn(db),
  };
  const contract = createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 10, log: () => {},
  });
  // mounted as src/app.ts mounts it, under the app's last-resort onError (which answers 500): the shape the
  // tester's lab hit (a validator's malformed-JSON refusal escaped the contract app and became a 500)
  const app = new Hono();
  app.onError(internalError);
  app.route("/", contract);
  return { app, seen };
}
const SRC = "33333333-3333-4333-8333-333333333333";
const TOMB = "66666666-6666-4666-8666-666666666667";

Deno.test("N2: a cleanup write with a JSON content type and no (or broken) body is a 400 and touches nothing", async () => {
  const { app, seen } = stubApp();
  for (const [path, body] of [
    [`/workbench/contract/cleanup/sources/${SRC}/erase`, undefined], [`/workbench/contract/cleanup/sources/${SRC}/erase`, ""],
    [`/workbench/contract/cleanup/sources/${SRC}/erase`, "{"], [`/workbench/contract/cleanup/sources/${SRC}/sever`, undefined],
    ["/workbench/contract/cleanup/process-all", undefined], [`/workbench/contract/cleanup/tombstones/${TOMB}/lift`, "  "],
  ] as [string, string | undefined][]) {
    const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    assertEquals(r.status, 400, `${path} body=${JSON.stringify(body)}: ${await r.text()}`);
  }
  assertEquals(seen.length, 0, "no statement ran");
});

Deno.test("N3: lifting an already-lifted tombstone is a 409 and records no cleanup action", async () => {
  // round 3: the lift goes through liftTombstoneAs (it reads the tombstone; the default identity may lift)
  const lifted = { id: TOMB, source_id: SRC, url: "u", title: "t", reason_type: "deliberate", note: null, batch_run_id: null, eraser_kind: "user",
    eraser_run_id: null, eraser_user: "operator", confidence: null, score_version: null, fingerprint: null, erased_at: "2026-11-01T00:00:00.000Z",
    lifted_at: "2026-11-01T00:00:00.000Z", lifted_by: "x", readmitted_source_id: null, attempts: [], readmitted_in_scope: false };
  const { app, seen } = stubApp((sql) => /FROM public\.source_tombstones/.test(sql) && /FOR UPDATE/.test(sql)
    ? [{ id: TOMB, lifted_at: "2026-11-01T00:00:00.000Z" }] : /FROM public\.source_tombstones t/.test(sql) ? [lifted] : []);
  const r = await app.request(`/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assertEquals(r.status, 409, await r.text());
  assertEquals(seen.some((s) => /INSERT INTO public\.cleanup_actions/.test(s)), false, "no second lift action");
  // round 3: liftTombstoneAs's UPDATE ... WHERE lifted_at IS NULL may run, but it changes nothing and its transaction
  // is rolled back by the 409 - no action is the check
});

Deno.test("N3: a tombstone that does not exist is 404 on lift, with no action recorded", async () => {
  const { app, seen } = stubApp();
  const r = await app.request(`/workbench/contract/cleanup/tombstones/${TOMB}/lift`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assertEquals(r.status, 404, await r.text());
  assertEquals(seen.some((s) => /INSERT INTO public\.cleanup_actions/.test(s)), false);
});
