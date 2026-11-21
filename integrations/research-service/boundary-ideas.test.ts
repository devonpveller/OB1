/**
 * rw-boundary-ideas (plan 09 PD0b): the idea drain and the owner's approval over a FAKE database (no DB, no network,
 * no model) - what the research service WRITES for an idea. Every personal field carries a marker; the HOSTILE proposer
 * returns every field verbatim. The derived job's insert (query, anchor, options, boundary) must carry none of them;
 * the private hand-back's review data may (owner-only).   deno test --allow-read boundary-ideas.test.ts
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { BoundaryDeps, Q } from "./boundary.ts";
import { approveIdeaQuestion, drainIdeaHandbacks, type IdeaHandbackItem, ideaItem, ideaLinks } from "./boundary-ideas.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";

const PAGE = { title: "Community solar roofs cut winter bills", text: "Community solar roofs cut winter bills by 18 percent in 2024, a survey found." };
const MARKERS = Object.values(MK).filter((m) => m !== MK.PUB);
const hits = (s: string) => MARKERS.filter((m) => s.toLowerCase().includes(m.toLowerCase()));

function hostile(): BoundaryDeps {
  return {
    propose: (it) => Promise.resolve([...Object.values(it.fields), Object.values(it.fields).join(" "), `What is known about ${Object.values(it.fields).join(" and ")}?`]),
    fetchPublic: (u) => Promise.resolve(u.startsWith("https://news.example.org/solar-roofs") ? PAGE : null),
    identity: () => Promise.resolve([OWNER.name, OWNER.email]),
    resolve: () => Promise.resolve(["203.0.113.10"]),
  };
}
const honest = (q: string): BoundaryDeps => ({ ...hostile(), propose: () => Promise.resolve([q]) });

function row(over: Partial<IdeaHandbackItem> = {}): IdeaHandbackItem {
  return {
    id: "11111111-1111-4111-8111-111111111111", owner_sub: OWNER.sub, idea_id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f", inlet_revision: 2,
    state: "pending", title: `${MK.TIT} winter plan`, summary: `${MK.SUM} the cheap solar roof plan for my winter cabin ${MK.REV}`,
    domain: MK.DOMAIN, gone: false, ...over,
  };
}

type Call = { sql: string; args: unknown[] };
/** A fake database: what each statement was called with, and scripted answers. */
function fakeDb(r: IdeaHandbackItem | null, opts: { settle?: boolean; decide?: boolean } = {}) {
  const calls: Call[] = [];
  const mk = (): Q & { release(): void } => ({
    queryObject: <T>(sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      let rows: unknown[] = [];
      if (sql.includes("handback_pending")) rows = r ? [{ id: r.id }] : [];
      else if (sql.includes("idea_handback_item")) rows = r && (args.length < 2 || args[1] === r.owner_sub) ? [r] : [];
      else if (sql.includes("INSERT INTO public.research_jobs")) rows = [{ id: "22222222-2222-4222-8222-222222222222" }];
      else if (sql.includes("idea_handback_settle")) rows = [{ ok: opts.settle ?? true }];
      else if (sql.includes("idea_handback_decide")) rows = [{ ok: opts.decide ?? true }];
      return Promise.resolve({ rows: rows as T[] });
    },
    release: () => {},
  });
  return { connect: () => Promise.resolve(mk()), client: mk(), calls };
}
const jobInsert = (calls: Call[]) => calls.filter((c) => c.sql.includes("INSERT INTO public.research_jobs"));
const quiet = { log: () => {} };

Deno.test("ideaItem: the idea's fields and the links it names (transient), its id as the private inlet id", () => {
  const it = ideaItem(row({ summary: `see https://news.example.org/solar-roofs. and ${MK.SUM}` }));
  assertEquals([it.kind, it.id, it.revision, it.owner_sub], ["idea", "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f", 2, OWNER.sub]);
  assertEquals(it.links, ["https://news.example.org/solar-roofs"]);
  assertEquals(Object.keys(it.fields).sort(), ["domain", "summary", "title"]);
  assertEquals(ideaLinks("a http://x.example.org/a, b", "c https://y.example.org/b)"), ["http://x.example.org/a", "https://y.example.org/b"]);
});

Deno.test("drain, HOSTILE proposer, no link: no candidate passes -> awaiting_owner; NO job is written; the review is private", async () => {
  const db = fakeDb(row());
  const o = await drainIdeaHandbacks(db.connect, hostile(), quiet);
  assertEquals(o, { formed: 0, awaiting: 1, refused: 0, superseded: 0 });
  assertEquals(jobInsert(db.calls).length, 0, "a refusal starts no job");
  const settle = db.calls.find((c) => c.sql.includes("idea_handback_settle"))!;
  assertEquals(settle.args[2], "awaiting_owner");
  assertEquals(settle.args[1], 2, "settled against the revision it was formed from");
  assertEquals(hits(String(settle.args[3])), [], "the verdict holds hashes and codes, never the text");
  const view = JSON.parse(String(settle.args[4]));
  assert(typeof view.candidate === "string" && Array.isArray(view.failing), "the owner's review: the best candidate and its failing tokens");
});

Deno.test("drain, HOSTILE proposer, a public link: the template decides; the derived insert carries NO marker in any column", async () => {
  const db = fakeDb(row({ summary: `${MK.SUM} https://news.example.org/solar-roofs?u=${MK.QRY} ${MK.REV}` }));
  const o = await drainIdeaHandbacks(db.connect, hostile(), quiet);
  assertEquals(o.formed, 1);
  const ins = jobInsert(db.calls);
  assertEquals(ins.length, 1);
  const shared = JSON.stringify(ins[0].args);
  assertEquals(hits(shared), [], `no marker on the shared row: ${shared.slice(0, 300)}`);
  assert(String(ins[0].args[0]).startsWith("What is publicly known about"), String(ins[0].args[0]));
  assertFalse(shared.includes("?u="), "the link's query string never rides");
  assertFalse(shared.includes("8b0c4f5e"), "the idea's id never rides on the job");
  const order = db.calls.map((c) => c.sql === "BEGIN" ? "BEGIN" : c.sql.includes("INSERT INTO public.research_jobs") ? "job"
    : c.sql.includes("idea_handback_settle") ? "settle" : c.sql === "COMMIT" ? "COMMIT" : "").filter(Boolean);
  assertEquals(order, ["BEGIN", "job", "settle", "COMMIT"], "the job and its hand-back in one transaction");
});

Deno.test("drain, honest proposer: a public question is accepted; an edit during forming (settle=false) rolls the job back", async () => {
  const q = "What is known about cheap solar roof designs for cold towns?";
  const ok = fakeDb(row());
  assertEquals((await drainIdeaHandbacks(ok.connect, honest(q), quiet)).formed, 1);
  assertEquals(jobInsert(ok.calls)[0].args[0], q);
  const raced = fakeDb(row(), { settle: false });
  const o = await drainIdeaHandbacks(raced.connect, honest(q), quiet);
  assertEquals([o.formed, o.superseded], [0, 1]);
  assert(raced.calls.some((c) => c.sql === "ROLLBACK") && !raced.calls.some((c) => c.sql === "COMMIT"), "the formed job is rolled back, never committed");
});

Deno.test("drain: an archived / deleted idea is refused (not re-read every pass); the model is never asked", async () => {
  let asked = 0;
  const deps = { ...hostile(), propose: () => { asked++; return Promise.resolve([] as string[]); } };
  const db = fakeDb(row({ gone: true }));
  const o = await drainIdeaHandbacks(db.connect, deps, quiet);
  assertEquals([o.refused, asked, jobInsert(db.calls).length], [1, 0, 0]);
});

Deno.test("approve (D7): the owner's identity / a marker is refused; a clean edit runs DERIVED with no marker; another owner is 404", async () => {
  const waiting = row({ state: "awaiting_owner" });
  const deps = hostile();
  for (const q of [`What does ${OWNER.name} want for a cabin roof?`, `What is ${MK.TIT} about?`]) {
    const db = fakeDb(waiting);
    const o = await approveIdeaQuestion(db.client, OWNER.sub, waiting.id, q, deps);
    assertEquals(o.status, 200, q);
    assertEquals(jobInsert(db.calls).length, 0);
  }
  const db = fakeDb(waiting);
  const o = await approveIdeaQuestion(db.client, OWNER.sub, waiting.id, "Which cheap roof designs suit a small cold cabin?", deps);
  assertEquals(o.status, 202);
  assertEquals(hits(JSON.stringify(jobInsert(db.calls)[0].args)), []);
  const decide = db.calls.find((c) => c.sql.includes("idea_handback_decide"))!;
  assertEquals(JSON.parse(String(decide.args[3])).accepted_by, "owner");
  const other = fakeDb(waiting);
  assertEquals((await approveIdeaQuestion(other.client, "user-bee-second", waiting.id, "Which roofs suit a cabin?", deps)).status, 404);
  const decided = fakeDb(row({ state: "queued" }));
  assertEquals((await approveIdeaQuestion(decided.client, OWNER.sub, waiting.id, "Which roofs suit a cabin?", deps)).status, 409);
});
