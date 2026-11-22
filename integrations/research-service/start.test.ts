/**
 * rwr-research-start-api (research-service half): depth presets inside the admin ceilings, the door's depth /
 * approved_question fields, the preview (same function as the start, no write). Pure: no DB, no network, no model.
 *   deno test --allow-read start.test.ts
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type BoundaryDeps, formDerivedRequest, parseDoorBody, parseRun, type PersonalItem, PURPOSES, runOptions } from "./boundary.ts";
import { DEPTHS, resolveDepth, runCeilings } from "./depth.ts";
import { approvedDeps, doorRefusesIdea, formForDoor, previewBody, startChanged } from "./start.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";

const CEIL = { rounds: 3, max_fetch: 80, wall_ms: 900_000 };

Deno.test("depth presets: each maps to today's research limits, never above the ceilings", () => {
  assertEquals(Object.keys(DEPTHS), ["quick", "standard", "deep"]);
  assertEquals(resolveDepth("deep", CEIL), { name: "deep", budget: { rounds: 3, max_fetch: 80, wall_ms: 900_000 } });
  assertEquals(resolveDepth("quick", CEIL).budget, { rounds: 1, max_fetch: 12, wall_ms: 300_000 });
  assert(resolveDepth("standard", CEIL).budget.max_fetch < resolveDepth("deep", CEIL).budget.max_fetch);
});

Deno.test("depth presets: lower admin ceilings win - asking for deep yields the ceiling, never more", () => {
  const low = { rounds: 1, max_fetch: 10, wall_ms: 120_000 };
  assertEquals(resolveDepth("deep", low).budget, { rounds: 1, max_fetch: 10, wall_ms: 120_000 });
  assertEquals(resolveDepth("standard", low).budget, { rounds: 1, max_fetch: 10, wall_ms: 120_000 });
  assertEquals(resolveDepth("quick", low).budget, { rounds: 1, max_fetch: 10, wall_ms: 120_000 });
  for (const n of ["quick", "standard", "deep"] as const) {
    for (const c of [{ rounds: 1, max_fetch: 1, wall_ms: 1 }, { rounds: 2, max_fetch: 30, wall_ms: 400_000 }, { rounds: 9, max_fetch: 999, wall_ms: 9e9 }]) {
      const b = resolveDepth(n, c).budget;
      assert(b.rounds <= c.rounds && b.max_fetch <= c.max_fetch && b.wall_ms <= c.wall_ms, `${n} ${JSON.stringify(c)}`);
    }
  }
});

Deno.test("runCeilings reads the same env the engine reads (harness defaults when unset)", () => {
  assertEquals(runCeilings(() => undefined), { rounds: 3, max_fetch: 24, wall_ms: 180_000 });
  const env: Record<string, string> = { MAX_ROUNDS: "2", MAX_FETCH: "50", MAX_WALL_MS: "600000" };
  assertEquals(runCeilings((k) => env[k]), { rounds: 2, max_fetch: 50, wall_ms: 600_000 });
  assertEquals(runCeilings((k) => (k === "MAX_ROUNDS" ? "junk" : undefined)).rounds, 3, "a junk value falls back to the default");
});

Deno.test("parseRun takes depth (an enumerated name) and refuses anything else", () => {
  assertEquals(parseRun({ depth: "deep" }), { run: { depth: "deep" } });
  for (const bad of [{ depth: "max" }, { depth: 3 }, { depth: { rounds: 99 } }, { budget: { rounds: 99 } }]) assert("error" in parseRun(bad), JSON.stringify(bad));
});

Deno.test("runOptions writes the preset as contract.budget, clamped by the ceilings passed in", () => {
  assertEquals(runOptions({ depth: "deep" }, { rounds: 2, max_fetch: 30, wall_ms: 600_000 }), { contract: { budget: { rounds: 2, max_fetch: 30, wall_ms: 600_000 } } });
  assertEquals(runOptions({}, CEIL), {}, "no depth, no budget: today's behaviour");
  assertEquals(runOptions({ depth: "quick", mode: "article" }, CEIL).mode, "article");
});

Deno.test("user-start is a purpose of the door", () => {
  assert(PURPOSES.has("user-start"));
  const p = parseDoorBody({ purpose: "user-start", item: { kind: "document", id: "documents/u/a.md#x", owner_sub: "u-1", fields: { question: "q" } }, run: { depth: "standard" } });
  assert(!("error" in p));
  if (!("error" in p)) assertEquals(p.run, { depth: "standard" });
});

Deno.test("parseDoorBody: approved_question is a bounded string", () => {
  const b = { purpose: "user-start", item: { kind: "chat", id: "start-1", owner_sub: "u-1", fields: { question: "q" } } };
  const ok = parseDoorBody({ ...b, approved_question: "What is known about heat pumps?" });
  assert(!("error" in ok));
  if (!("error" in ok)) assertEquals(ok.approved, "What is known about heat pumps?");
  assert("error" in parseDoorBody({ ...b, approved_question: 5 }));
  assert("error" in parseDoorBody({ ...b, approved_question: "x".repeat(301) }));
});

// ── preview = start's function ───────────────────────────────────────────────────────────────
const PAGE = { title: "Heat pumps cut winter bills", text: "Heat pumps cut winter bills by 30 percent in cold climates, a study found." };
function mk(calls: string[]): BoundaryDeps {
  return {
    propose: () => { calls.push("propose"); return Promise.resolve(["What is known about heat pumps and winter bills?"]); },
    fetchPublic: (u) => { calls.push(`fetch:${u}`); return Promise.resolve(u === "https://news.example.org/hp" ? PAGE : null); },
    identity: () => Promise.resolve([OWNER.name, OWNER.email]),
    resolve: () => Promise.resolve(["93.184.216.34"]),
  };
}
const ITEM = (): PersonalItem => ({
  kind: "document", id: "documents/u/a.md#s1", owner_sub: OWNER.sub, links: ["https://news.example.org/hp"],
  fields: { question: `${MK.SUM} should I buy a heat pump`, document: `${MK.TIT} my cabin notes` },
});
const PARSED = () => ({ item: ITEM(), purpose: "user-start" as const, deliver: {}, run: { depth: "deep" as const }, approved: undefined as string | undefined });

Deno.test("preview and start are ONE function: formForDoor, which calls formDerivedRequest; their requests are equal", async () => {
  const preview = await formForDoor(PARSED(), mk([]));
  const start = await formForDoor(PARSED(), mk([]));
  const direct = await formDerivedRequest(ITEM(), "user-start", mk([]));
  assert(preview.ok && start.ok && direct.ok);
  if (preview.ok && start.ok && direct.ok) {
    assertEquals(preview.request, start.request);
    assertEquals(preview.request, direct.request, "what the preview shows is what formDerivedRequest returns");
  }
});

Deno.test("previewBody is exactly what would leave: topic, question, public links, depth - and no marker", async () => {
  const v = await formForDoor(PARSED(), mk([]));
  assert(v.ok);
  const body = previewBody(v, { depth: "deep" }, CEIL);
  assertEquals(Object.keys(body).sort(), ["depth", "links", "ok", "question", "topic"]);
  const s = JSON.stringify(body);
  for (const m of Object.values(MK)) assertFalse(s.includes(m), `a personal marker reached the preview: ${m}`);
  assertFalse(s.includes(OWNER.sub));
  if (v.ok) assertEquals(body.question, v.request.question);
});

Deno.test("a refusal's preview carries the refusal code only", async () => {
  const dead: BoundaryDeps = { ...mk([]), propose: () => Promise.resolve([]), fetchPublic: () => Promise.resolve(null) };
  const v = await formForDoor(PARSED(), dead);
  assertFalse(v.ok);
  const b = previewBody(v, {}, CEIL);
  assertEquals(b.ok, false);
  assertEquals(Object.keys(b).sort(), ["ok", "refusal"]);
});

Deno.test("approved_question: the model is not asked again, the gate still decides, a changed question is reported", async () => {
  const c: string[] = [];
  const approved = "What is known about heat pumps and winter bills?";
  const v = await formForDoor({ ...PARSED(), approved }, mk(c));
  assertFalse(c.includes("propose"), "the approved question replaces the model's proposal");
  assert(v.ok);
  assertFalse(startChanged(v, approved));
  const bad = `What is known about ${MK.SUM}?`;
  const v2 = await formForDoor({ ...PARSED(), approved: bad }, mk([]));
  assert(!v2.ok || v2.request.question !== bad, "a question made of the owner's own words cannot pass the gate");
  if (v2.ok) assert(startChanged(v2, bad));
  assertEquals(typeof approvedDeps(mk([]), approved).fetchPublic, "function");
});

// ── round 2: an idea is not a start (slot 580 PD0b) - the preview refuses it as the derived door does ─────────────────
Deno.test("the preview refuses an idea exactly as the derived door does: item kind idea or purpose idea-research", () => {
  const base = { purpose: "user-start", item: { kind: "document", id: "d#1", owner_sub: OWNER.sub, fields: { question: "q" }, links: [] }, run: { depth: "quick" } };
  const doc = parseDoorBody(base);
  assert(!("error" in doc));
  if (!("error" in doc)) assertFalse(doorRefusesIdea(doc), "a document start is not refused");
  for (const b of [
    { ...base, item: { ...base.item, kind: "idea", id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f#s1", revision: 3 } },
    { ...base, purpose: "idea-research" },
    { ...base, purpose: "idea-research", item: { ...base.item, kind: "idea" } },
  ]) {
    const p = parseDoorBody(b);
    assert(!("error" in p), JSON.stringify(b));
    if (!("error" in p)) assert(doorRefusesIdea(p), JSON.stringify(b));
  }
});
