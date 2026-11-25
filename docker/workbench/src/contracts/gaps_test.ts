// deno test src/contracts/gaps_test.ts - document gaps (rwr-doc-gaps-api), no database: the normalised de-dup key, the
// duplicate refusal, the one-run rule, the rotate-out rule's branches, the refusal that is the missing row's twin, the
// contract document, and the migration files. The database's own behaviour (two identities, the partial unique indexes,
// the real claims) is gaps_integration_test.ts, run by contract-test/run-gaps-tests.ps1.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { coveredBy, createGap, normalizeGapText, researchGaps, ResearchUnavailable, runQuery, settleGaps, updateGap } from "./repo/gaps.ts";
import { Conflict, NotFound } from "./repo/lifecycle.ts";
import type { Identity } from "../middleware/identity.ts";

const WHO: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const DOC = "documents/user-a/notes.md";
const G1 = "9a900000-0000-4000-8000-000000000001";
const G2 = "9a900000-0000-4000-8000-000000000002";
const JOB = "9a900000-0000-4000-8000-0000000000a1";

const entry = (registry: string, key: string) => ({ registry, key, version: 1, label: key, definition: {}, retired_at: null, superseded_by: null });
const REG = [
  ...["user", "selection", "research", "scan", "topic"].map((k) => entry("gap_origins", k)),
  ...["open", "researching", "covered", "dismissed"].map((k) => entry("gap_states", k)),
];
function reader(db: Db) {
  const r = new RegistryReader(db);
  // deno-lint-ignore no-explicit-any
  (r as any).all = () => Promise.resolve(REG);
  return r;
}
const raw = (id: string, over: Record<string, unknown> = {}) => ({
  id, doc_path: DOC, text: "pump pressure at altitude", origin: "user", state: "open", job_id: null, covered_at: null,
  created_at: "t", updated_at: "t", ...over,
});

// a recording Db: `answer` decides each statement's rows; the log keeps what ran
function recorder(answer: (sql: string, args: unknown[]) => unknown[] | undefined) {
  const log: string[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      log.push(s);
      return Promise.resolve((answer(s, args) ?? []) as T[]);
    },
    tx: (fn) => fn(db),
  };
  return { db, log };
}
// every document the caller names is theirs (ownership.ts asks the listing / vault); the answer a real owner gets
const OWNS = (s: string) => /user_document_listings|SELECT 1 FROM|EXISTS/i.test(s) && !/document_gaps/.test(s) ? [{ ok: true, n: 1, path: DOC }] : undefined;

Deno.test("the de-dup key ignores case, spacing, quotes and edge punctuation", () => {
  assertEquals(normalizeGapText('  "How does the Pump hold   pressure?"  '), "how does the pump hold pressure");
  assertEquals(normalizeGapText("How does the pump hold pressure."), normalizeGapText("how does the pump hold pressure"));
  assert(normalizeGapText("pump A") !== normalizeGapText("pump B"));
  assertEquals(normalizeGapText("?!."), "");
});

Deno.test("a duplicate of an open gap is refused, names the existing gap, and nothing is inserted", async () => {
  const { db, log } = recorder((s) => {
    if (/FROM public\.document_gaps/.test(s) && /state IN \('open', 'researching'\)/.test(s)) return [raw(G1)];
    return OWNS(s);
  });
  const e = await assertRejects(() => createGap(db, reader(db), WHO, { path: DOC, text: "Pump pressure at altitude?" }), Conflict);
  assertEquals((e.detail.existing as { id: string }).id, G1);
  assert(log.every((l) => !/^INSERT/.test(l)), "nothing was added");
});

Deno.test("a dismissed gap of the same origin is looked up as a blocker (it never comes back from there)", async () => {
  const { db, log } = recorder((s) => OWNS(s));
  await createGap(db, reader(db), WHO, { path: DOC, text: "x", origin: "scan" }).catch(() => {});
  const q = log.find((l) => /FROM public\.document_gaps/.test(l))!;
  assert(/state = 'dismissed' AND origin = \$4/.test(q), q);
  assert(/owner_sub = \$1/.test(q), "looked up among the caller's own gaps only");
});

Deno.test("research these: ONE run for two ticked gaps, queued once, both marked researching with that job id", async () => {
  const calls: { path: string; query: string }[] = [];
  const { db, log } = recorder((s) => {
    if (/FOR UPDATE/.test(s)) return [raw(G1, { text: "first need" }), raw(G2, { text: "second need" })];
    if (/WHERE job_id = \$1/.test(s)) return [raw(G1, { state: "researching", job_id: JOB }), raw(G2, { state: "researching", job_id: JOB })];
  });
  const out = await researchGaps(db, (path, query) => { calls.push({ path, query }); return Promise.resolve({ job_id: JOB }); }, WHO, [G1, G2, G1]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].path, DOC);
  assert(calls[0].query.includes("1. first need") && calls[0].query.includes("2. second need"));
  assertEquals(out.job_id, JOB);
  assertEquals(out.gaps.map((g) => g.job_id), [JOB, JOB]);
  assert(log.some((l) => /SET job_id = \$3/.test(l)));
});

Deno.test("research these: a run that cannot be queued puts the gaps back to open", async () => {
  const { db, log } = recorder((s) => /FOR UPDATE/.test(s) ? [raw(G1)] : undefined);
  await assertRejects(() => researchGaps(db, () => Promise.reject(new ResearchUnavailable("down")), WHO, [G1]), ResearchUnavailable);
  assert(log.some((l) => /SET state = 'open'/.test(l) && /job_id IS NULL/.test(l)));
  await assertRejects(() => researchGaps(db, undefined, WHO, [G1]), ResearchUnavailable);
});

Deno.test("research these: another user's gap and a missing one are refused in the same words", async () => {
  // the database answers no row for a gap that is not the caller's: whether it is another's or does not exist
  const { db } = recorder(() => []);
  const a = await assertRejects(() => researchGaps(db, () => Promise.resolve({ job_id: JOB }), WHO, [G1]), NotFound);
  const b = await assertRejects(() => researchGaps(db, () => Promise.resolve({ job_id: JOB }), WHO, ["9a900000-0000-4000-8000-0000000000ff"]), NotFound);
  assertEquals(a.message, b.message);
  assertEquals(a.message, "no such gap");
});

Deno.test("research these: only open gaps, of one document", async () => {
  const q = () => Promise.resolve({ job_id: JOB });
  let r = recorder((s) => /FOR UPDATE/.test(s) ? [raw(G1), raw(G2, { state: "researching" })] : undefined);
  await assertRejects(() => researchGaps(r.db, q, WHO, [G1, G2]), Conflict);
  r = recorder((s) => /FOR UPDATE/.test(s) ? [raw(G1), raw(G2, { doc_path: "documents/user-a/other.md" })] : undefined);
  await assertRejects(() => researchGaps(r.db, q, WHO, [G1, G2]));
});

Deno.test("a gap cannot be set to researching by hand", async () => {
  const { db } = recorder(() => [raw(G1)]);
  await assertRejects(() => updateGap(db, reader(db), WHO, G1, { state: "researching" }), Error, "only by researching");
});

// ── the rotate-out rule ────────────────────────────────────────────────────────────────────
function settleDb(job: { status: string | null; filed: unknown }, covers: boolean) {
  const writes: unknown[][] = [];
  const r = recorder((s, a) => {
    if (/LEFT JOIN public\.research_jobs/.test(s)) return [{ id: G1, text: "pump pressure", status: job.status, filed: job.filed }];
    if (/SELECT EXISTS/.test(s)) return [{ ok: covers }];
    if (/^UPDATE public\.document_gaps/.test(s)) { writes.push(a); return [{ id: G1 }]; }
  });
  return { ...r, writes };
}
const embed = () => Promise.resolve([1, 0, 0]);

Deno.test("rotate-out: a run that finished WITH a claim of two agreeing sources covers the gap", async () => {
  const s = settleDb({ status: "done", filed: [JOB] }, true);
  assertEquals(await settleGaps(s.db, embed, WHO), 1);
  assertEquals(s.writes[0][1], "covered");
});

Deno.test("rotate-out: a run that finished alone does NOT cover the gap (no claim backs it): it goes back to open", async () => {
  const s = settleDb({ status: "done", filed: [JOB] }, false);
  await settleGaps(s.db, embed, WHO);
  assertEquals(s.writes[0][1], "open");
  const none = settleDb({ status: "done", filed: [] }, true); // finished, filed nothing: the claim query is never even asked
  await settleGaps(none.db, embed, WHO);
  assertEquals(none.writes[0][1], "open");
  assert(none.log.every((l) => !/SELECT EXISTS/.test(l)));
  const err = settleDb({ status: "error", filed: [JOB] }, true); // an errored run covers nothing, whatever it filed
  await settleGaps(err.db, embed, WHO);
  assertEquals(err.writes[0][1], "open");
});

Deno.test("rotate-out: the rule asks for two DISTINCT hosts, supporting edges, an active uncontradicted claim near the question", async () => {
  let sql = "";
  const { db } = recorder((s) => { sql = s; return [{ ok: false }]; });
  assertEquals(await coveredBy(db, [JOB], [1, 0], 0.55), false);
  assert(/count\(DISTINCT coalesce\(nullif\(lower\(s\.domain\), ''\), s\.id::text\)\)/.test(sql) && />= 2/.test(sql), sql);
  assert(/edge_type IN \('states', 'corroborates'\)/.test(sql) && !/'contradicts'/.test(sql));
  assert(/c\.status = 'active' AND NOT c\.contradicted/.test(sql) && /c\.embedding <=> \$2::vector/.test(sql));
  assert(/retracted_at IS NULL AND s\.suppression_reason IS NULL AND s\.unlinked_at IS NULL/.test(sql));
});

Deno.test("rotate-out: a question that cannot be embedded leaves the gap researching (settled on a later read)", async () => {
  const s = settleDb({ status: "done", filed: [JOB] }, true);
  assertEquals(await settleGaps(s.db, () => Promise.reject(new Error("down")), WHO), 0);
  assertEquals(s.writes.length, 0);
});

Deno.test("the run's question is the gap's own words, or a numbered list", () => {
  assertEquals(runQuery(["only one"]), "only one");
  assert(runQuery(["a", "b"]).endsWith("1. a\n2. b"));
});

// ── the contract and the files ─────────────────────────────────────────────────────────────
Deno.test("the contract document lists the gap routes, each with the caller's identity from the seam (no user field)", () => {
  const fake = { db: {} as Db, registry: {} as RegistryReader, scorer: unavailableScorer, embed: embed, chunk: () => [], mountsRoot: "/m", streamPollMs: 1, log: () => {} };
  const doc = openApiDocument(createContractApp(fake));
  const paths = doc.paths as Record<string, Record<string, unknown>>;
  assertEquals(Object.keys(paths["/workbench/contract/gaps"]).sort(), ["get", "post"]);
  assertEquals(Object.keys(paths["/workbench/contract/gaps/{id}"]).sort(), ["delete", "get", "patch"]);
  assertEquals(Object.keys(paths["/workbench/contract/gaps/research"]), ["post"]);
  const schemas = JSON.stringify((doc.components as { schemas: unknown }).schemas);
  for (const n of ["GapCreate", "GapUpdate", "GapResearch"]) {
    const s = (doc.components as { schemas: Record<string, { properties: Record<string, unknown>; additionalProperties?: unknown }> }).schemas[n];
    assert(!("owner_sub" in s.properties) && !("owner" in s.properties) && !("user" in s.properties), `${n} has a user field`);
    assertEquals(s.additionalProperties, false, `${n} is strict`);
  }
  assert(schemas.includes("x-registry"));
});

Deno.test("this item adds no cloud call and no model call: its files reach nothing but the database and the injected queue", async () => {
  for (const f of ["repo/gaps.ts", "routes/gaps.ts", "schemas/gaps.ts"]) {
    const t = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assert(!/\bfetch\s*\(|https?:\/\/|llama-cpp|litellm|openrouter|anthropic|openai|XMLHttpRequest|WebSocket/i.test(t.replace(/^\s*\/\/.*$/gm, "")), `${f} reaches out`);
  }
});

Deno.test("the migration: slot 650 is mounted, the revert drops exactly what the forward made, and only the owner's role set is granted", async () => {
  const dir = new URL("../../../", import.meta.url);
  let fwd: string, rev: string, compose: string;
  try {
    fwd = await Deno.readTextFile(new URL("init-document-gaps.sql", dir));
    rev = await Deno.readTextFile(new URL("revert-document-gaps.sql", dir));
    compose = await Deno.readTextFile(new URL("docker-compose.yml", dir));
  } catch {
    return; // inside the image the migrations are not in the build context (the lab runner checks them)
  }
  assert(/init-document-gaps\.sql:\/docker-entrypoint-initdb\.d\/650-init-document-gaps\.sql:ro/.test(compose));
  assert(/CREATE TABLE IF NOT EXISTS public\.document_gaps/.test(fwd) && /DROP TABLE IF EXISTS public\.document_gaps/.test(rev));
  assert(/registry IN \('gap_origins', 'gap_states'\)/.test(rev));
  const grants = [...fwd.matchAll(/GRANT [^;]+ TO ([a-z_]+)/g)].map((m) => m[1]).sort();
  assertEquals(grants, ["ob_workbench", "service_role"]);
  assert(/ENABLE ROW LEVEL SECURITY/.test(fwd));
  assert(!/sources|claims|wiki_pages/.test(rev.replace(/--.*$/gm, "")), "the revert touches no shared knowledge");
});
