// deno test src/contracts/cleanup_round3b_test.ts - rw-p8a2-cleanup round 3b (reviewer: the actor mask fails open).
// No signed-in subject is WRITTEN into a shared D5 row any more: every door that erases, lifts, suppresses or severs
// on behalf of a signed-in user writes a per-user ref (cleanup-action:<id>) whose private cleanup_actions row maps
// it to owner_sub; the lift rule decides eraser-ownership by looking that row up for the caller; reads answer
// erased_by_you / may_lift for the viewer. The actor mask stays only as a backstop - these tests run with it OFF
// (WORKSPACE_RESPONSE_WALK=off, the lab switch that also turns the mask off). No database: the round-3 harness.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { AT, harness, type Handler, lifeUnlinked, lockUnlinked, SRC, TOMB, tombInsert, tombSelect } from "./cleanup_harness_test.ts";
import { mayLiftTombstone } from "./logic/lift.ts";
import { buildDocument } from "./gen.ts";

const REF = /^cleanup-action:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECTS = ["u-ay", "u-bee"];
const action: Handler = [/INSERT INTO public\.cleanup_actions/, (a) => [{ id: a[0], kind: a[3], reason_type: a[4] ?? null, source_id: a[5] ?? null, tombstone_id: a[6] ?? null, detail: {}, created_at: AT, finished_at: AT }]];
const owns = (owner: string): Handler => [/FROM public\.cleanup_actions\s+WHERE 'cleanup-action:' \|\| id::text = \$1/, (a) => [{ owns: a[1] === owner }]];
const withMaskOff = async (fn: () => Promise<void>) => {
  const prev = Deno.env.get("WORKSPACE_RESPONSE_WALK");
  Deno.env.set("WORKSPACE_RESPONSE_WALK", "off");
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("WORKSPACE_RESPONSE_WALK");
    else Deno.env.set("WORKSPACE_RESPONSE_WALK", prev);
  }
};
// every argument of every statement that wrote a shared D5 row
const SHARED_WRITE = /INSERT INTO public\.(source_tombstones|source_trail_events|source_tombstone_attempts)|UPDATE public\.(sources|source_tombstones|source_trail_events)\b/;
function subjectsWritten(seen: { sql: string; args: unknown[] }[]): string[] {
  return seen.filter((s) => SHARED_WRITE.test(s.sql)).flatMap((s) => SUBJECTS.filter((u) => JSON.stringify(s.args).includes(`"${u}"`)).map((u) => `${u} in ${s.sql.slice(0, 60)}`));
}

Deno.test("mayLiftTombstone: a user lifts only a tombstone whose private eraser record is theirs - never by a subject in the shared row", () => {
  const user = (sub: string) => ({ sub, actor: sub, name: sub, key: sub, kind: "header" as const, admin: false, impersonating: null });
  // the shared row holding the caller's own subject is NOT ownership any more
  assertEquals(mayLiftTombstone({ eraser_kind: "user", eraser_user: "u-ay", erased_by_caller: false }, user("u-ay")), false);
  assertEquals(mayLiftTombstone({ eraser_kind: "user", eraser_user: "cleanup-action:x", erased_by_caller: true }, user("u-ay")), true);
  assertEquals(mayLiftTombstone({ eraser_kind: "automation", eraser_user: null, erased_by_caller: false }, { ...user("u-ay"), admin: true }), true);
  assertEquals(mayLiftTombstone({ eraser_kind: "automation", eraser_user: null, erased_by_caller: true }, user("u-ay")), false);
});

Deno.test("the trail's erase (POST /sources/{id}/erase, a user eraser) writes an action ref, never the subject; the ref's private row is the caller's", async () => {
  const h = harness([action, lockUnlinked, lifeUnlinked, tombInsert, tombSelect()]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/sources/${SRC}/erase`, { reason_type: "deliberate", eraser: { kind: "user", user: "u-bee" } });
  assertEquals(r.status, 200, await r.text());
  const ins = h.seen.find((s) => /INSERT INTO public\.source_tombstones/.test(s.sql))!;
  assert(REF.test(String(ins.args[6])), `eraser_user ${ins.args[6]}`);
  const own = h.committed(/INSERT INTO public\.cleanup_actions/);
  assertEquals(own.length, 1);
  assertEquals([own[0].args[1], `cleanup-action:${own[0].args[0]}`], ["u-ay", ins.args[6]], "the private row maps the ref to the caller");
  assertEquals(own[0].tx, ins.tx, "the private row and the erase are one transaction");
  assertEquals(subjectsWritten(h.seen), []);
});

Deno.test("the cleanup erase writes an action ref as eraser_user, never the subject", async () => {
  const h = harness([action, lockUnlinked, lifeUnlinked, tombInsert, tombSelect()]);
  const r = await h.call("u-ay", "POST", `/workbench/contract/cleanup/sources/${SRC}/erase`, { reason_type: "deliberate" });
  assertEquals(r.status, 200, await r.text());
  const ins = h.seen.find((s) => /INSERT INTO public\.source_tombstones/.test(s.sql))!;
  assert(REF.test(String(ins.args[6])), `eraser_user ${ins.args[6]}`);
  assertEquals(subjectsWritten(h.seen), []);
});

Deno.test("the trail's lift: ownership by the private record; lifted_by and the trail actor are a ref", async () => {
  const lock: Handler = [/FROM public\.source_tombstones WHERE id = \$1 FOR UPDATE/, () => [{ id: TOMB, lifted_at: null }]];
  const lifted: Handler = [/UPDATE public\.source_tombstones SET lifted_at/, () => [{ source_id: SRC }]];
  // the shared row holds a ref; u-bee's private row owns it
  let h = harness([owns("u-bee"), lock, lifted, action, tombSelect({ eraser_user: "cleanup-action:11111111-1111-4111-8111-111111111111" })]);
  let r = await h.call("u-bee", "POST", `/workbench/contract/tombstones/${TOMB}/lift`, { by: "u-bee" });
  assertEquals(r.status, 200, await r.text());
  const upd = h.seen.find((s) => /UPDATE public\.source_tombstones SET lifted_at/.test(s.sql))!;
  assert(REF.test(String(upd.args[1])), `lifted_by ${upd.args[1]}`);
  assertEquals(subjectsWritten(h.seen), []);
  // another user: 403 - the shared row naming them proves nothing
  h = harness([owns("u-bee"), lock, lifted, action, tombSelect({ eraser_user: "u-ay" })]);
  r = await h.call("u-ay", "POST", `/workbench/contract/tombstones/${TOMB}/lift`, {});
  assertEquals(r.status, 403, await r.text());
});

Deno.test("the trail's suppress and sever, for a signed-in user, write an action ref as the actor, never the subject", async () => {
  const active: Handler = [/FROM public\.sources WHERE id = \$1 FOR UPDATE/, () => [{ id: SRC, lifecycle: "active", url: "u", title: "x", content: "c" }]];
  let h = harness([action, active, [/AS ctx/, () => [{ ctx: { title: "x" } }]], [/recompute_claims_for_source/, () => [{ n: 0 }]], [/source_blocking_dependence/, () => [{ n: 1 }]]]);
  let r = await h.call("u-ay", "POST", `/workbench/contract/sources/${SRC}/suppress`, { reason: "why" });
  assertEquals(r.status, 200, await r.text());
  const upd = h.seen.find((s) => /UPDATE public\.sources\s+SET retracted_at/.test(s.sql))!;
  assert(REF.test(String(upd.args[1])), `retracted_by ${upd.args[1]}`);
  assertEquals(subjectsWritten(h.seen), []);
  h = harness([action,
    [/FROM public\.sources WHERE id = \$1 FOR UPDATE/, () => [{ id: SRC, lifecycle: "suppressed", url: "u", title: "x", content: "c" }]],
    [/AS lifecycle FROM public\.sources\s+WHERE id = \$1 AND/, () => [{ lifecycle: "suppressed" }]],
    [/source_dependence\(\$1\) d/, () => [{ kind: "chunk", ref: "0", detail: {} }]], [/source_blocking_dependence/, () => [{ n: 0 }]]]);
  r = await h.call("u-ay", "POST", `/workbench/contract/sources/${SRC}/sever`, { all: true });
  assertEquals(r.status, 200, await r.text());
  assertEquals(subjectsWritten(h.seen), []);
});

Deno.test("reads answer erased_by_you / may_lift for the viewer, with the actor mask OFF - no subject in the body", async () => {
  await withMaskOff(async () => {
    const h = harness([owns("u-bee"), tombSelect({ eraser_user: "cleanup-action:11111111-1111-4111-8111-111111111111", lifted_at: AT, lifted_by: "cleanup-action:22222222-2222-4222-8222-222222222222" })]);
    const asB = await (await h.call("u-bee", "GET", `/workbench/contract/tombstones/${TOMB}`)).json();
    assertEquals([asB.erased_by_you, asB.may_lift], [true, true], JSON.stringify(asB));
    const rA = await h.call("u-ay", "GET", `/workbench/contract/tombstones/${TOMB}`);
    const asA = await rA.json();
    assertEquals([asA.erased_by_you, asA.may_lift], [false, false]);
    assert(!JSON.stringify(asA).includes("u-bee"), "no subject without the mask");
  });
});

Deno.test("every contract operation that returns tombstone, trail or admission data is a contract route (the sweep walks it, mask off); none writes a subject", async () => {
  const doc = buildDocument() as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
  const schemas = doc.components.schemas;
  const CARRIES = new Set(["Tombstone", "Trail", "TrailEntry", "AdmissionDecision", "Reference", "EraseResult", "ReopenCandidates", "CleanupErased", "CleanupLifted"]);
  const reaches = (s: any, seen = new Set<string>()): boolean => {
    if (!s || typeof s !== "object") return false;
    if (typeof s.$ref === "string") {
      const n = s.$ref.split("/").pop()!;
      if (CARRIES.has(n)) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      return reaches(schemas[n], seen);
    }
    return Object.values(s).some((v) => reaches(v, seen));
  };
  const ops = Object.entries(doc.paths).flatMap(([p, item]) => Object.entries(item).map(([m, o]) => ({ p, m, o })))
    .filter(({ o }) => Object.values(o.responses ?? {}).some((r: any) => reaches(r)));
  const names = ops.map(({ m, o }) => `${m} ${o.operationId}${o["x-mcp-tool"] ? ` (MCP ${o["x-mcp-tool"]})` : ""}`);
  console.log(`operations carrying tombstone / trail / admission data: ${names.join(", ")}`);
  for (const want of ["tombstone", "trail", "admission", "erase", "liftTombstone", "reference", "cleanupReopenCandidates"]) {
    assert(ops.some(({ o }) => o.operationId === want), `${want} is enumerated`);
  }
  for (const { p } of ops) assert(p.startsWith("/workbench/contract/"), `${p} is a contract route (in the sweep's route table)`);
  assert(ops.some(({ o }) => o["x-mcp-tool"] === "contract_tombstone") && ops.some(({ o }) => o["x-mcp-tool"] === "contract_trail"),
    "the MCP tools over them are the contract routes themselves (openbrain-mcp's adapter calls the same routes)");
  // the source: no door hands a subject to a D5 write
  const files = ["routes/lifecycle.ts", "routes/cleanup.ts", "repo/cleanup.ts", "repo/lifecycle.ts", "../routes/sources.ts"];
  const bad: string[] = [];
  for (const f of files) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    src.split("\n").forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      // a user eraser built from the seam's subject; a D5 write handed the seam's author; the purge door's actor
      if (/user:\s*\(?\s*(await identityOf\(c\)\)|who)\.sub\b/.test(l) || /lc\.(suppress|sever|liftTombstoneAs)\([^;]*authorOf\(/.test(l) ||
          /const by = authorOf\(c\)/.test(l)) bad.push(`${f}:${i + 1} ${l.trim().slice(0, 120)}`);
    });
  }
  assertEquals(bad, [], "a D5 door hands the signed-in subject (or a seam author) to a shared write");
});
