// deno test src/contracts/integration_test.ts - the contract over a REAL database.
//
// SKIPPED unless CONTRACT_TEST_DB_HOST is set. contract-test/run-contract-tests.ps1 sets it to a
// DISPOSABLE Postgres it creates on its own internal network (the pinned pgvector image, the
// real initdb chain from compose, contract-test/fixtures.sql). Never point it at a live
// database: the tests suppress, sever and erase rows.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { createContractApp, openApiDocument } from "./app.ts";
import type { AdmissionScorer, ScoreResult } from "./logic/reopen.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import { chunkText } from "../util/chunk.ts";
import { postNotification } from "./repo/system.ts";
import * as S from "./schemas/sources.ts";
import * as K from "./schemas/knowledge.ts";
import * as I from "./schemas/ideas.ts";
import { Notifications, Setting } from "./schemas/system.ts";
import { FX } from "./schemas/fixtures.ts";

const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !HOST;
const pool = HOST
  ? new Pool({
    hostname: HOST, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 4, true)
  : null;
const db = pool ? poolDb(pool) : null;
let scoreNext: ScoreResult | null = null;
const scorer: AdmissionScorer = { score: (x) => scoreNext ? Promise.resolve(scoreNext) : unavailableScorer.score(x) };
const embedded: string[] = [];
const app = db
  ? createContractApp({
    db, registry: new RegistryReader(db, 0), scorer, chunk: chunkText, mountsRoot: "/tmp/contract-mounts",
    embed: (t) => {
      embedded.push(t);
      return Promise.resolve(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
    },
    streamPollMs: 20, log: () => {},
  })
  : null;

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
const sql = <T = Record<string, unknown>>(text: string, args: unknown[] = []) => db!.query<T>(text, args);
const B = "/workbench/contract";
async function call(method: string, path: string, body?: unknown) {
  const r = await app!.request(B + path, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* SSE */ }
  return { status: r.status, json, text };
}
const uuid = () => crypto.randomUUID();
async function newSource(over: { url?: string | null; title?: string; content?: string } = {}) {
  const id = uuid();
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, $3, $4)`,
    [id, over.url === undefined ? `https://example.org/t/${id}` : over.url, over.title ?? `test ${id}`, over.content ?? `content ${id}`]);
  return id;
}

// ── acceptance 2: D5 stage 1 ───────────────────────────────────────────────────────────────
t("suppressed source by id: state suppressed with reason and original context, never 404, never unmarked", async () => {
  const r = await call("GET", `/references/${FX.sourceSuppressed}`);
  assertEquals(r.status, 200);
  assert(S.Reference.safeParse(r.json).success);
  assertEquals(r.json.state, "suppressed");
  assertEquals(r.json.lifecycle, "suppressed");
  assertEquals(r.json.state_detail.reason, "misattributed quote");
  assertEquals(r.json.state_detail.context.url, "https://example.org/suppressed");
});

t("evidence_only=true omits a suppressed source (single fetch: state omitted, no body)", async () => {
  const r = await call("GET", `/references/${FX.sourceSuppressed}?evidence_only=true`);
  assertEquals(r.status, 200);
  assertEquals(r.json.state, "omitted");
  assertEquals(r.json.source, null);
  const c = await call("GET", `/chunks/${FX.sourceSuppressed}:0/context?evidence_only=true`);
  assertEquals([c.status, c.json.state, c.json.chunks.length], [200, "omitted", 0]);
  const s = await call("GET", `/search?q=misattributed&kinds=source&evidence_only=true`);
  assertEquals(s.json.results.some((h: any) => h.id === FX.sourceSuppressed), false);
  const cl = await call("GET", `/claims?source_id=${FX.sourceActive}&evidence_only=true`);
  for (const claim of cl.json.claims) assertEquals(claim.sources.some((e: any) => e.source_id === FX.sourceSuppressed), false);
});

t("a suppressed source is absent from retrieval for generation (match_sources, match_source_chunks)", async () => {
  const vec = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  await sql(`UPDATE public.sources SET embedding = $1::vector WHERE id IN ($2, $3)`, [vec, FX.sourceSuppressed, FX.sourceActive]);
  await sql(`UPDATE public.source_chunks SET embedding = $1::vector WHERE source_id IN ($2, $3)`, [vec, FX.sourceSuppressed, FX.sourceActive]);
  const m = await sql<{ id: string }>(`SELECT id FROM public.match_sources($1::vector, -1, 50)`, [vec]);
  assert(m.some((r) => r.id === FX.sourceActive));
  assertEquals(m.some((r) => r.id === FX.sourceSuppressed), false);
  const ch = await sql<{ source_id: string }>(`SELECT source_id FROM public.match_source_chunks($1::vector, -1, 50)`, [vec]);
  assertEquals(ch.some((r) => r.source_id === FX.sourceSuppressed), false);
});

t("a suppressed source lends no grounding, corroboration or authority (scoring excludes it)", async () => {
  const [{ confidence }] = await sql<{ confidence: number }>(`SELECT confidence FROM public.claims WHERE id = $1`, [FX.claim]);
  // states edge from the active source only: 0.90 x 0.85 authority; the suppressed corroborator adds nothing
  assertEquals(Number(confidence).toFixed(3), "0.765");
  const c = uuid();
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, 'grounded only by a suppressed source')`, [c]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [c, FX.sourceSuppressed]);
  const [g] = await sql<{ grounded: boolean; conf: number }>(
    `SELECT public.claim_is_grounded($1) AS grounded, (SELECT confidence FROM public.claims WHERE id = $1) AS conf`, [c]);
  assertEquals([g.grounded, Number(g.conf)], [false, 0]);
  const reuse = await sql(`SELECT id FROM public.reusable_claims WHERE id = $1`, [c]);
  assertEquals(reuse.length, 0, "a claim grounded only by a suppressed source must not be reusable");
});

t("suppress via the contract re-scores the claims and records a trail event", async () => {
  const s = await newSource();
  const c = uuid();
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, 'claim on a source about to be suppressed')`, [c]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [c, s]);
  const before = Number((await sql<{ c: number }>(`SELECT confidence AS c FROM public.claims WHERE id = $1`, [c]))[0].c);
  assert(before > 0);
  const r = await call("POST", `/sources/${s}/suppress`, { reason: "test", by: "tester" });
  assertEquals(r.status, 200);
  assertEquals(r.json.rescored_claims, 1);
  const after = Number((await sql<{ c: number }>(`SELECT confidence AS c FROM public.claims WHERE id = $1`, [c]))[0].c);
  assertEquals(after, 0);
  const tr = await call("GET", `/trail?source_id=${s}`);
  assert(tr.json.entries.some((e: any) => e.kind === "suppressed" && e.counts_as_evidence === false));
});

// ── acceptance 3: D5 stages 2-3 ───────────────────────────────────────────────────────────
t("dependence lists and counts claims by edge type, chunks, citing pages, reports, trail events and found_via leads", async () => {
  const r = await call("GET", `/sources/${FX.sourceSuppressed}/dependence`);
  assertEquals(r.status, 200);
  assert(S.Dependence.safeParse(r.json).success);
  for (const k of ["claim_edge", "chunk", "citing_page", "entity_grounding", "report_session", "report_citation", "found_via_lead"]) {
    assert((r.json.counts[k] ?? 0) >= 1, `no ${k}`);
  }
  assertEquals(r.json.claims_by_edge_type.corroborates, 1);
  assertEquals(r.json.erase_allowed, false);
});

t("erase is refused while dependence is non-zero, and from any state but unlinked", async () => {
  const r = await call("POST", `/sources/${FX.sourceSuppressed}/erase`, { reason_type: "debunked", eraser: { kind: "user", user: "t" } });
  assertEquals(r.status, 409);
  const exists = await sql(`SELECT 1 FROM public.sources WHERE id = $1`, [FX.sourceSuppressed]);
  assertEquals(exists.length, 1, "the source must still exist");
  const active = await newSource();
  const a = await call("POST", `/sources/${active}/erase`, { reason_type: "debunked", eraser: { kind: "user", user: "t" } });
  assertEquals(a.status, 409, "an active source cannot be erased");
});

t("sever(id, connection) removes one connection, re-scores claims, marks pages pending-compile; all -> unlinked -> erase", async () => {
  // a fresh suppressed source with a claim edge, a chunk and a citing page
  const s = await newSource();
  const c = uuid();
  await sql(`INSERT INTO public.claims (id, text, synthesis_id) VALUES ($1, 'claim to sever', $2)`, [c, FX.synthesis]);
  const [{ id: edge }] = await sql<{ id: number }>(
    `INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states') RETURNING id`, [c, s]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'x')`, [s]);
  const page = `content/tool/sever-${s}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, links) VALUES ($1, 'entity', 'p', $2::jsonb)`,
    [page, JSON.stringify([`content/source/${s}`])]);
  await call("POST", `/sources/${s}/suppress`, { reason: "to sever" });
  const one = await call("POST", `/sources/${s}/sever`, { kind: "claim_edge", ref: String(edge) });
  assertEquals(one.status, 200);
  assert(S.SeverResult.safeParse(one.json).success);
  assertEquals(one.json.severed, [{ kind: "claim_edge", ref: String(edge) }]);
  assertEquals(one.json.rescored_claims, 1);
  assert(one.json.pending_compile.includes(`content/source/${FX.synthesis}`));
  assertEquals(one.json.lifecycle, "suppressed");
  const edges = await sql(`SELECT 1 FROM public.claim_sources WHERE id = $1`, [edge]);
  assertEquals(edges.length, 0);
  const all = await call("POST", `/sources/${s}/sever`, { all: true });
  assertEquals([all.status, all.json.lifecycle, all.json.blocking], [200, "unlinked", 0]);
  assert(all.json.pending_compile.includes(page));
  const nb = await call("GET", `/neighbours?id=${page}&depth=1`);
  assertEquals(nb.json.nodes.find((n: any) => n.id === page)?.state, "pending_compile");
  const e = await call("POST", `/sources/${s}/erase`, { reason_type: "deliberate", note: "gone", eraser: { kind: "user", user: "tester" } });
  assertEquals(e.status, 200);
  assertEquals(e.json.tombstone.source_id, s);
});

// ── acceptance 12: D5 stage 4 ─────────────────────────────────────────────────────────────
t("an erased source resolves to a tombstone (URL, reason type, note, batch run id); re-intake is refused, named", async () => {
  const url = `https://example.org/erase-me/${uuid()}`;
  const s = await newSource({ url });
  await call("POST", `/sources/${s}/suppress`, { reason: "bad" });
  const e = await call("POST", `/sources/${s}/erase`, {
    reason_type: "credibility", note: "low credibility", batch_run_id: "batch-7", eraser: { kind: "automation", run_id: "run-7" },
  });
  assertEquals(e.status, 200);
  const tb = e.json.tombstone;
  assertEquals([tb.url, tb.reason_type, tb.note, tb.batch_run_id, tb.eraser_kind, tb.eraser_run_id],
    [url, "credibility", "low credibility", "batch-7", "automation", "run-7"]);
  assert(tb.fingerprint && tb.fingerprint.length === 64);
  const ref = await call("GET", `/references/${s}`);
  assertEquals([ref.status, ref.json.state, ref.json.tombstone.url], [200, "erased", url]);
  // every door: the sources gate refuses the URL (find_or_create_source is how the doors insert)
  let refused = "";
  try {
    await sql(`SELECT * FROM public.find_or_create_source($1, 'back again', NULL, 't')`, [url + "/"]);
  } catch (err) {
    refused = String((err as Error).message);
  }
  assert(refused.includes(tb.id), `re-intake was not refused with the tombstone named: ${refused}`);
  const adm = await call("POST", `/admission`, { url, path: "intake" });
  assertEquals([adm.json.outcome, adm.json.admits, adm.json.tombstone.id], ["refused", false, tb.id]);
  // a tombstone without a URL or a reason cannot exist
  let noUrl = false;
  try {
    await sql(`INSERT INTO public.source_tombstones (source_id, url, url_key, reason_type, eraser_kind) VALUES ($1, NULL, 'x', 'deliberate', 'user')`, [uuid()]);
  } catch {
    noUrl = true;
  }
  assert(noUrl);
});

t("erase validates its eraser: automation must name a run, a user must be named, the reason must be registered", async () => {
  const s = await newSource();
  await call("POST", `/sources/${s}/suppress`, { reason: "x" });
  assertEquals((await call("POST", `/sources/${s}/erase`, { reason_type: "debunked", eraser: { kind: "automation" } })).status, 409);
  assertEquals((await call("POST", `/sources/${s}/erase`, { reason_type: "nope", eraser: { kind: "user", user: "u" } })).status, 409);
});

t("a lifted tombstone admits its URL again", async () => {
  const url = `https://example.org/lift/${uuid()}`;
  const s = await newSource({ url });
  await call("POST", `/sources/${s}/suppress`, { reason: "x" });
  const e = await call("POST", `/sources/${s}/erase`, { reason_type: "deliberate", eraser: { kind: "user", user: "u" } });
  const l = await call("POST", `/tombstones/${e.json.tombstone.id}/lift`, { by: "operator" });
  assertEquals(l.status, 200);
  assert(l.json.lifted_at);
  const ins = await sql<{ id: string }>(`SELECT id FROM public.find_or_create_source($1, 'back', NULL, 't')`, [url]);
  assert(ins[0].id);
});

// ── acceptance 13: D5 items 6-7 ───────────────────────────────────────────────────────────
async function erased(reason: string, eraser: { kind: string; run_id?: string; user?: string }) {
  const url = `https://example.org/reopen/${uuid()}`;
  const s = await newSource({ url, content: "original content" });
  await call("POST", `/sources/${s}/suppress`, { reason: "x" });
  await sql(`UPDATE public.sources SET suppression_context = suppression_context || '{"score_at_removal":{"value":0.3,"version":"v1"}}'::jsonb WHERE id = $1`, [s]);
  const e = await call("POST", `/sources/${s}/erase`, { reason_type: reason, eraser });
  assertEquals(e.status, 200);
  return { url, tomb: e.json.tombstone };
}
const clears = (value = 0.8): ScoreResult => ({ available: true, value, floor: 0.5, version: "v2", reason: "stub scorer" });

t("automation-erased debunked: re-scored, clears its floor -> contesting source, debunking attached as criticism, a dispute", async () => {
  const { url, tomb } = await erased("debunked", { kind: "automation", run_id: "run-a" });
  scoreNext = clears();
  const r = await call("POST", `/admission`, { url, path: "query", candidate: { title: "back", content: "new content" } });
  scoreNext = null;
  assertEquals([r.json.outcome, r.json.admits], ["admitted_contesting", true]);
  const [src] = await sql<{ metadata: any }>(`SELECT metadata FROM public.sources WHERE id = $1`, [r.json.source_id]);
  assertEquals(src.metadata.contesting, true);
  assertEquals(src.metadata.criticism.tombstone_id, tomb.id);
  const d = await sql(`SELECT 1 FROM public.source_disputes WHERE id = $1 AND tombstone_id = $2`, [r.json.dispute_id, tomb.id]);
  assertEquals(d.length, 1);
  assertEquals(r.json.tombstone.attempts.at(-1).outcome, "admitted_contesting");
});

t("automation-erased credibility: admitted outright when confidence, score version and fingerprint show the bar cleared", async () => {
  const { url } = await erased("credibility", { kind: "automation", run_id: "run-b" });
  scoreNext = clears(0.9);
  const r = await call("POST", `/admission`, { url, path: "watch", candidate: { content: "revised content" } });
  scoreNext = null;
  assertEquals([r.json.outcome, r.json.admits], ["admitted", true]);
});

t("credibility reopen without the bar computable is refused (no score yet = P3a not landed)", async () => {
  const { url } = await erased("credibility", { kind: "automation", run_id: "run-c" });
  const r = await call("POST", `/admission`, { url, path: "found_via", candidate: { content: "revised" } });
  assertEquals([r.json.outcome, r.json.admits], ["refused", false]);
  const t2 = await erased("credibility", { kind: "automation", run_id: "run-c2" });
  await sql(`UPDATE public.source_tombstones SET confidence = NULL WHERE id = $1`, [t2.tomb.id]);
  scoreNext = clears(0.99);
  const r2 = await call("POST", `/admission`, { url: t2.url, path: "intake", candidate: { content: "revised" } });
  scoreNext = null;
  assertEquals(r2.json.admits, false, "a tombstone without its recorded confidence cannot readmit");
});

t("user-erased tombstones land only as candidates; deliberate appends a note and admits nothing", async () => {
  for (const reason of ["debunked", "credibility"]) {
    const { url } = await erased(reason, { kind: "user", user: "operator" });
    scoreNext = clears(0.95);
    const r = await call("POST", `/admission`, { url, path: "intake", candidate: { content: "new" } });
    scoreNext = null;
    assertEquals([r.json.outcome, r.json.admits, r.json.source_id], ["candidate", false, null], reason);
  }
  const { url, tomb } = await erased("deliberate", { kind: "automation", run_id: "run-d" });
  scoreNext = clears(0.99);
  const r = await call("POST", `/admission`, { url, path: "query", session_id: "sess-9", note: "returned by a query; looks promising" });
  scoreNext = null;
  assertEquals([r.json.outcome, r.json.admits], ["note_appended", false]);
  const att = await sql<{ note: string; session_id: string }>(
    `SELECT note, session_id FROM public.source_tombstone_attempts WHERE tombstone_id = $1 ORDER BY id DESC LIMIT 1`, [tomb.id]);
  assertEquals([att[0].session_id, att[0].note], ["sess-9", "returned by a query; looks promising"]);
});

t("the tombstone stores eraser, reason type, confidence, score version, fingerprint and every attempt", async () => {
  const { url, tomb } = await erased("debunked", { kind: "automation", run_id: "run-e" });
  await call("POST", `/admission`, { url, path: "intake" });
  await call("POST", `/admission`, { url, path: "watch" });
  const r = await call("GET", `/tombstones/${tomb.id}`);
  assertEquals([r.json.eraser_kind, r.json.eraser_run_id, r.json.reason_type, r.json.score_version], ["automation", "run-e", "debunked", "v1"]);
  assertEquals(Number(r.json.confidence).toFixed(1), "0.3");
  assertEquals(r.json.fingerprint.length, 64);
  assertEquals(r.json.attempts.map((a: any) => a.path), ["intake", "watch"]);
});

t("a tombstoned URL met as a query hit is recorded on its tombstone and dropped (the research doors call this)", async () => {
  const deb = await erased("debunked", { kind: "automation", run_id: "run-q" });
  const del = await erased("deliberate", { kind: "user", user: "u" });
  const [a] = await sql<{ id: string | null }>(`SELECT public.contract_record_query_hit($1, 'sess-q', 'hit') AS id`, [deb.url]);
  const [b] = await sql<{ id: string | null }>(`SELECT public.contract_record_query_hit($1, 'sess-q', 'hit') AS id`, [del.url]);
  const [c] = await sql<{ id: string | null }>(`SELECT public.contract_record_query_hit($1, 'sess-q', 'hit') AS id`, ["https://example.org/never-erased"]);
  assertEquals([a.id, b.id, c.id], [deb.tomb.id, del.tomb.id, null]);
  const outcomes = await sql<{ outcome: string }>(
    `SELECT outcome FROM public.source_tombstone_attempts WHERE tombstone_id = ANY($1::uuid[]) AND path = 'query' ORDER BY tombstone_id = $2 DESC`,
    [[deb.tomb.id, del.tomb.id], deb.tomb.id]);
  assertEquals(outcomes.map((o) => o.outcome), ["refused", "note_appended"]);
});

// ── acceptance 9: D13 notification event ──────────────────────────────────────────────────
t("a notification posted by a stubbed producer round-trips with class, subject, slug, error and count", async () => {
  const subject = `compile structural failure: test-${uuid()}`;
  await postNotification(db!, { class: "structural", subject, slug: "content/x", error: "ReferenceError: extractLinks" });
  await postNotification(db!, { class: "structural", subject, slug: "content/x", error: "second error" });
  const r = await call("GET", `/notifications?class=structural`);
  assert(Notifications.safeParse(r.json).success);
  const n = r.json.notifications.find((x: any) => x.subject === subject);
  assertEquals([n.class, n.slug, n.error, n.count], ["structural", "content/x", "ReferenceError: extractLinks", 2]);
  assert(n.first_seen <= n.last_seen);
  let refused = false;
  try {
    await postNotification(db!, { class: "not-a-class", subject: "x" });
  } catch {
    refused = true;
  }
  assert(refused, "an unregistered class must be refused");
});

// ── acceptance 15-16: ideas and the refinery ──────────────────────────────────────────────
t("a new idea and a dossier delivery each post a notification event", async () => {
  const id = uuid();
  await sql(`INSERT INTO public.ideas (id, title) VALUES ($1, 'notify me')`, [id]);
  await sql(`UPDATE public.ideas SET dossier_source_id = $2 WHERE id = $1`, [id, FX.synthesis]);
  const r = await call("GET", `/notifications?class=informational`);
  const mine = r.json.notifications.filter((n: any) => String(n.entity).startsWith(`idea:${id}`));
  assertEquals(mine.map((n: any) => n.subject).sort(), ["a new idea has been added", "dossier delivered"]);
});

t("ideas() and idea(id) return the aggregate: revisions, sessions, dossier, draft, room, produced sources and claims", async () => {
  const l = await call("GET", `/ideas`);
  assert(I.Ideas.safeParse(l.json).success);
  const r = await call("GET", `/ideas/${FX.idea}`);
  assertEquals(r.status, 200);
  assert(I.Idea.safeParse(r.json).success, JSON.stringify(I.Idea.safeParse(r.json).error));
  assertEquals(r.json.revisions[0].research_job_id, FX.job);
  assertEquals(r.json.sessions[0].id, FX.job);
  assertEquals(r.json.dossier.source_id, FX.synthesis);
  assertEquals([r.json.draft.state, r.json.room.state], ["external", "external"]);
  assert(r.json.produced.sources.some((s: any) => s.id === FX.sourceActive));
  assert(r.json.produced.claims.some((c: any) => c.id === FX.claim));
});

t("the refinery: members, its one document, context graph incl. document links, origin; pins only where the document pinned", async () => {
  const r = await call("GET", `/ideas/${FX.idea}`);
  const ref = r.json.refinery;
  assertEquals(ref.members.document.path, FX.documentPath);
  assertEquals(ref.members.sessions, [FX.job]);
  assert(ref.members.podcasts.includes("podcast-fixture-1"));
  assertEquals(ref.origin.kind, "captured_idea");
  const docLinks = ref.context_graph.links.filter((l: any) => l.kind === "document_link");
  assertEquals(docLinks.find((l: any) => l.target === FX.sourceActive)?.pin, 2);
  assertEquals(docLinks.find((l: any) => l.target === FX.heldLinked)?.pin, null);
  for (const l of ref.context_graph.links.filter((x: any) => x.kind !== "document_link")) assertEquals(l.pin, null);
  assert(ref.context_graph.nodes.some((n: any) => n.kind === "page" && n.id === FX.pageEntity), "links picked up from the document");
  // the session job carries the refinery
  assertEquals((await call("GET", `/sessions/${FX.job}`)).json.refinery_id, FX.idea);
});

t("more than one document per refinery is impossible", async () => {
  let refused = false;
  try {
    await sql(`INSERT INTO public.user_document_listings (path, refinery_id) VALUES ($1, $2)`, [`documents/${uuid()}.md`, FX.idea]);
  } catch {
    refused = true;
  }
  assert(refused);
});

t("hiding a node changes nothing outside the refinery: node, link, score and dependence count unchanged", async () => {
  const snap = async () => ({
    dep: (await call("GET", `/sources/${FX.sourceActive}/dependence`)).json.total,
    conf: (await sql<{ c: number }>(`SELECT confidence AS c FROM public.claims WHERE id = $1`, [FX.claim]))[0].c,
    edges: (await sql(`SELECT * FROM public.claim_sources WHERE source_id = $1 ORDER BY id`, [FX.sourceActive])).length,
    src: JSON.stringify((await sql(`SELECT title, content, metadata, retraction_committed_at FROM public.sources WHERE id = $1`, [FX.sourceActive]))[0]),
    page: JSON.stringify((await sql(`SELECT links, updated_at FROM public.wiki_pages WHERE slug = $1`, [FX.pageEntity]))[0]),
  });
  const before = await snap();
  const h = await call("POST", `/ideas/${FX.idea}/hidden`, { node_kind: "source", node_ref: FX.sourceActive, hidden: true });
  assertEquals([h.status, h.json.hidden], [200, true]);
  assertEquals(await snap(), before);
  const r = await call("GET", `/ideas/${FX.idea}`);
  assertEquals(r.json.refinery.context_graph.nodes.find((n: any) => n.id === FX.sourceActive)?.hidden, true);
  await call("POST", `/ideas/${FX.idea}/hidden`, { node_kind: "source", node_ref: FX.sourceActive, hidden: false });
  // the hidden flag lives on the refinery only: no column on any knowledge table carries it
  const cols = await sql(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name IN ('sources','claims','claim_sources','wiki_pages','held_sources') AND column_name ILIKE '%hidden%'`);
  assertEquals(cols.length, 0);
});

t("refinery membership is not page dependence (D17 item 6)", async () => {
  const d = await call("GET", `/sources/${FX.sourceActive}/dependence`);
  const kinds = Object.keys(d.json.counts);
  assertEquals(kinds.some((k) => k.includes("refinery")), false);
});

// ── acceptance 17: held sources ───────────────────────────────────────────────────────────
t("a user-provided source is held: stored, chunked, embedded, revision 1, in exactly one refinery's user source list", async () => {
  embedded.length = 0;
  const r = await call("POST", `/ideas/${FX.idea}/user-sources`, {
    title: "held by test", content: "Held test text about zebra quokkas. Second sentence.", url: `https://example.org/held/${uuid()}`,
  });
  assertEquals(r.status, 200);
  assert(I.UserSourceAdded.safeParse(r.json).success);
  const id = r.json.source.source_id;
  assertEquals([r.json.source.status, r.json.source.state, r.json.source.revision, r.json.embedded], ["held", "held", 1, true]);
  assert(embedded.length >= 2, "the source and its chunk(s) were embedded");
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.held_source_chunks WHERE held_source_id = $1 AND embedding IS NOT NULL`, [id]);
  assert(n >= 1);
  const list = (await call("GET", `/ideas/${FX.idea}`)).json.refinery.user_sources;
  assert(list.some((u: any) => u.source_id === id && u.status === "held"));
  const ref = await call("GET", `/references/${id}`);
  assertEquals([ref.json.state, ref.json.held.refinery_id], ["held", FX.idea]);
  const noRefinery = await call("POST", `/ideas/${uuid()}/user-sources`, { title: "x", content: "y" });
  assertEquals(noRefinery.status, 404, "a user source needs a pre-existing refinery");
});

t("a held source is absent from every database-wide search, compile, corroboration and credibility computation", async () => {
  const vec = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const m = await sql<{ id: string }>(`SELECT id FROM public.match_sources($1::vector, -1, 1000)`, [vec]);
  assertEquals(m.some((r) => r.id === FX.heldLinked), false);
  const ch = await sql<{ source_id: string }>(`SELECT source_id FROM public.match_source_chunks($1::vector, -1, 1000)`, [vec]);
  assertEquals(ch.some((r) => r.source_id === FX.heldLinked), false);
  const wide = await call("GET", `/search?q=refinery&kinds=source`);
  assertEquals(wide.json.results.some((h: any) => h.id === FX.heldLinked), false, "surfaced outside its refinery");
  const scoped = await call("GET", `/search?q=refinery&kinds=source&refinery_id=${FX.idea}`);
  assert(scoped.json.results.some((h: any) => h.id === FX.heldLinked), "missing inside its refinery");
  const other = await call("GET", `/search?q=refinery&kinds=source&refinery_id=${uuid()}`);
  assertEquals(other.json.results.some((h: any) => h.id === FX.heldLinked), false, "surfaced in another refinery");
  let corroborates = true;
  try {
    await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'corroborates')`, [FX.claim, FX.heldLinked]);
  } catch {
    corroborates = false;
  }
  assertEquals(corroborates, false, "a held source must not corroborate a database claim");
  const inSources = await sql(`SELECT 1 FROM public.sources WHERE id = $1`, [FX.heldLinked]);
  assertEquals(inSources.length, 0, "compile reads `sources`; a held source is not in it");
});

t("user_provided is a versioned refinery-scoped term, zero for admission", async () => {
  const q = await call("GET", `/sources/${FX.heldLinked}/quality`);
  assertEquals(q.status, 200);
  assertEquals([q.json.score.value, q.json.score.refinery_scoped], [0, 0.15]);
  assertEquals(q.json.score.version, "user_provided-v1");
});

t("a held source counts as its document's dependence; removing it is refused while a document links it", async () => {
  const d = await call("GET", `/sources/${FX.heldLinked}/dependence`);
  assertEquals([d.json.lifecycle, d.json.counts.document_link], ["held", 1]);
  const r = await call("DELETE", `/ideas/${FX.idea}/user-sources/${FX.heldLinked}`);
  assertEquals(r.status, 409);
  assertEquals(r.json.detail.documents, [FX.documentPath]);
  assertEquals((await sql(`SELECT 1 FROM public.held_sources WHERE id = $1`, [FX.heldLinked])).length, 1);
});

t("removing an unlinked held source erases it outright, with no tombstone", async () => {
  const add = await call("POST", `/ideas/${FX.idea}/user-sources`, { title: "to remove", content: "remove me", url: `https://example.org/rm/${uuid()}` });
  const id = add.json.source.source_id;
  const r = await call("DELETE", `/ideas/${FX.idea}/user-sources/${id}`);
  assertEquals([r.status, r.json.removed, r.json.tombstoned], [200, true, false]);
  assertEquals((await sql(`SELECT 1 FROM public.held_sources WHERE id = $1`, [id])).length, 0);
  assertEquals((await sql(`SELECT 1 FROM public.source_tombstones WHERE source_id = $1`, [id])).length, 0);
  assertEquals((await sql(`SELECT 1 FROM public.refinery_user_sources WHERE source_id = $1`, [id])).length, 0);
});

t("a held add of a tombstoned URL is refused (held does not bypass the reopen path)", async () => {
  const { url } = await erased("deliberate", { kind: "user", user: "u" });
  const r = await call("POST", `/ideas/${FX.idea}/user-sources`, { title: "x", content: "y", url });
  assertEquals(r.status, 409);
});

// ── acceptance 14: D12 ────────────────────────────────────────────────────────────────────
t("user documents are never pages: the listing is four fields, search and page calls never return one", async () => {
  const r = await call("GET", `/documents`);
  assertEquals(r.status, 200);
  for (const d of r.json.documents) assertEquals(Object.keys(d).sort(), ["outbound_links", "path", "title", "updated"]);
  const cols = (await sql<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'user_document_listings'`)).map((x) => x.c);
  assertEquals(cols.some((c) => /body|content|text/.test(c)), false, `listing record has a body-like column: ${cols}`);
  const s = await call("GET", `/search?q=Fixture`);
  assertEquals(s.json.results.some((h: any) => h.kind === "document" || String(h.id).startsWith("documents/")), false);
  const nb = await call("GET", `/neighbours?id=${FX.pageEntity}&depth=2`);
  assertEquals(nb.json.nodes.some((n: any) => n.kind === "document" || String(n.id).startsWith("documents/")), false);
});

// ── acceptance 13 (D6 item 5): settings ───────────────────────────────────────────────────
t("the archive destination: defaults to the named mount, a write is read back", async () => {
  const d = await call("GET", `/settings/podcast.archive_destination`);
  assert(Setting.safeParse(d.json).success);
  assertEquals([d.json.is_default, d.json.value, d.json.resolved.via], [true, { mount: "podcast-archive" }, "mount:podcast-archive"]);
  assertEquals(d.json.resolved.path, "/tmp/contract-mounts/podcast-archive");
  const w = await call("PUT", `/settings/podcast.archive_destination`, { value: { path: "/srv/optiplex/podcasts" }, by: "t" });
  assertEquals(w.status, 200);
  const back = await call("GET", `/settings/podcast.archive_destination`);
  assertEquals([back.json.is_default, back.json.value.path, back.json.version], [false, "/srv/optiplex/podcasts", 1]);
  assertEquals((await call("PUT", `/settings/podcast.archive_destination`, { value: { path: "relative/dir" } })).status, 409);
  assertEquals((await call("PUT", `/settings/not.a.setting`, { value: { path: "/x" } })).status, 404);
  await sql(`DELETE FROM public.contract_settings WHERE key = 'podcast.archive_destination'`);
});

// ── acceptance 19: expansion by registration ──────────────────────────────────────────────
t("a new registry entry lands with every existing entry and every existing call untouched", async () => {
  const docBefore = JSON.stringify(openApiDocument(app!));
  const entriesBefore = await sql(`SELECT registry, key, version, definition FROM public.contract_registry_entries ORDER BY 1, 2`);
  const registryBefore = (await call("GET", `/registries/notification_classes`)).json;
  const callsBefore = [(await call("GET", `/references/${FX.sourceActive}`)).json, (await call("GET", `/claims?source_id=${FX.sourceActive}`)).json];
  for (const [reg, key] of [["notification_classes", "test-expansion"], ["origins", "test-origin"], ["source_families", "test-family"],
    ["learning_record_fidelities", "test-fidelity"], ["page_classes", "test-page-class"]]) {
    await sql(`INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ($1, $2, 'added by a test')`, [reg, key]);
  }
  await sql(`INSERT INTO public.content_types (value, label, category) VALUES ('test-type', 'test', 'test')`);
  assertEquals(JSON.stringify(openApiDocument(app!)), docBefore, "a new entry needed a schema change");
  const entriesAfter = await sql(`SELECT registry, key, version, definition FROM public.contract_registry_entries
     WHERE key NOT LIKE 'test-%' ORDER BY 1, 2`);
  assertEquals(entriesAfter, entriesBefore, "an existing entry changed");
  const regAfter = (await call("GET", `/registries/notification_classes`)).json;
  assertEquals(regAfter.entries.length, registryBefore.entries.length + 1);
  assertEquals([(await call("GET", `/references/${FX.sourceActive}`)).json, (await call("GET", `/claims?source_id=${FX.sourceActive}`)).json], callsBefore);
  // the new entries work where their registry is enforced
  await postNotification(db!, { class: "test-expansion", subject: "a new class, no schema change" });
  await sql(`INSERT INTO public.research_jobs (status, origin, query) VALUES ('queued', 'test-origin', 'q')`);
  let bogus = false;
  try {
    await sql(`INSERT INTO public.research_jobs (status, origin, query) VALUES ('queued', 'unregistered', 'q')`);
  } catch {
    bogus = true;
  }
  assert(bogus, "an unregistered origin must be refused");
  await sql(`DELETE FROM public.research_jobs WHERE origin = 'test-origin'`);
});

t("ideas.status is the idea_states registry: a new state is one registry INSERT, no DDL (attempt 2, tester F4)", async () => {
  await sql(`INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ('idea_states', 'test-idea-state', 'added by a test')`);
  const id = uuid();
  await sql(`INSERT INTO public.ideas (id, title, status) VALUES ($1, 'idea in a newly registered state', 'test-idea-state')`, [id]);
  assertEquals((await sql<{ status: string }>(`SELECT status FROM public.ideas WHERE id = $1`, [id]))[0].status, "test-idea-state");
  let refused = false;
  try {
    await sql(`INSERT INTO public.ideas (id, title, status) VALUES ($1, 'idea in an unregistered state', 'unregistered-state')`, [uuid()]);
  } catch {
    refused = true;
  }
  assert(refused, "an unregistered idea state must be refused");
  await sql(`DELETE FROM public.ideas WHERE id = $1`, [id]);
  await sql(`DELETE FROM public.contract_registry_entries WHERE registry = 'idea_states' AND key = 'test-idea-state'`);
});

// ── stream / session / jobs ───────────────────────────────────────────────────────────────
t("stream(sessionId) emits a typed snapshot and ends for a finished session", async () => {
  const r = await call("GET", `/sessions/${FX.job}/stream`);
  assertEquals(r.status, 200);
  assert(r.text.includes("event: snapshot") && r.text.includes("event: end"));
  const data = r.text.split("\n").find((l) => l.startsWith("data: ") && l.includes('"snapshot"'))!;
  assertEquals(JSON.parse(data.slice(6)).session.id, FX.job);
});

t("the metadata filter fails closed for record kinds that carry no metadata", async () => {
  const f = encodeURIComponent(JSON.stringify({ share: "cloud" }));
  assertEquals((await call("GET", `/neighbours?id=${FX.pageEntity}&metadata_filter=${f}`)).json.nodes.length, 0);
  assertEquals((await call("GET", `/documents?metadata_filter=${f}`)).json.documents.length, 0);
  assertEquals((await call("GET", `/ideas?metadata_filter=${f}`)).json.ideas.length, 0);
  assertEquals((await call("GET", `/references/${FX.sourceActive}?metadata_filter=${f}`)).status, 404);
  await sql(`UPDATE public.sources SET metadata = metadata || '{"share":"cloud"}' WHERE id = $1`, [FX.sourceLead]);
  assertEquals((await call("GET", `/references/${FX.sourceLead}?metadata_filter=${f}`)).status, 200);
});

// rw-p0-contract2 (reviewer reject of rw-p0-contract): dependence and tombstone honour the filter
t("dependence and tombstone fail closed under the metadata filter; erase snapshots the source metadata", async () => {
  const f = encodeURIComponent(JSON.stringify({ share: "cloud" }));
  // a fixture source with no share=cloud: unknown under the filter, listed without it
  const out = await call("GET", `/sources/${FX.sourceSuppressed}/dependence?metadata_filter=${f}`);
  assertEquals(out.status, 404);
  assertEquals(out.json.connections, undefined);
  assertEquals((await call("GET", `/sources/${FX.sourceSuppressed}/dependence`)).status, 200);
  // an in-scope source: its own chunk, the in-scope claim; the metadata-less page is dropped
  const s = await newSource();
  await sql(`UPDATE public.sources SET metadata = '{"share":"cloud"}' WHERE id = $1`, [s]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'c')`, [s]);
  const [cIn, cOut] = [uuid(), uuid()];
  await sql(`INSERT INTO public.claims (id, text, metadata) VALUES ($1, 'in', '{"share":"cloud"}'), ($2, 'out', '{}')`, [cIn, cOut]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $3, 'states'), ($2, $3, 'states')`, [cIn, cOut, s]);
  const page = `content/scope-test/${s}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ($1, 'entity', 'p', 'b', $2::jsonb)`,
    [page, JSON.stringify([`content/source/${s}`])]);
  const scoped = await call("GET", `/sources/${s}/dependence?metadata_filter=${f}`);
  assertEquals(scoped.status, 200);
  assert(S.Dependence.safeParse(scoped.json).success);
  assertEquals(scoped.json.counts, { chunk: 1, claim_edge: 1 });
  assertEquals(scoped.json.connections.find((c: any) => c.kind === "claim_edge").detail.claim_id, cIn);
  assertEquals(scoped.json.erase_allowed, false);
  const all = await call("GET", `/sources/${s}/dependence`);
  assertEquals(all.json.counts, { chunk: 1, claim_edge: 2, citing_page: 1 });
  await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [page]);
  await sql(`DELETE FROM public.claim_sources WHERE source_id = $1`, [s]);
  await sql(`DELETE FROM public.claims WHERE id = ANY($1::uuid[])`, [[cIn, cOut]]);
  // erase snapshots metadata: the cloud source's tombstone resolves under the filter, a local one does not
  const tomb = async (meta: string) => {
    const x = await newSource();
    await sql(`UPDATE public.sources SET metadata = $2::jsonb WHERE id = $1`, [x, meta]);
    await call("POST", `/sources/${x}/suppress`, { reason: "scope test" });
    const e = await call("POST", `/sources/${x}/erase`, { reason_type: "deliberate", eraser: { kind: "user", user: "t" } });
    assertEquals(e.status, 200, JSON.stringify(e.json));
    return e.json.tombstone.id as string;
  };
  const tIn = await tomb('{"share":"cloud"}');
  const tOut = await tomb("{}");
  const a = await call("GET", `/tombstones/${tIn}?metadata_filter=${f}`);
  assertEquals(a.status, 200);
  assert(S.Tombstone.safeParse(a.json).success);
  const b = await call("GET", `/tombstones/${tOut}?metadata_filter=${f}`);
  assertEquals(b.status, 404);
  assertEquals(b.json.url, undefined);
  assertEquals((await call("GET", `/tombstones/${tOut}`)).status, 200);
  // a fixture tombstone written with no snapshot never resolves under a filter
  assertEquals((await call("GET", `/tombstones/${FX.tombstoneAutomation}?metadata_filter=${f}`)).status, 404);
});

t("every read the fixture answers validates against its schema (live conformance)", async () => {
  const reads: [string, { safeParse: (x: unknown) => { success: boolean } }][] = [
    [`/references/${FX.sourceActive}`, S.Reference], [`/chunks/${FX.sourceActive}:1/context`, S.ChunkContext],
    [`/sources/${FX.sourceActive}/quality`, S.Quality], [`/neighbours?id=${FX.pageEntity}`, K.Neighbours],
    [`/claims`, K.Claims], [`/search?q=fixture`, K.Search], [`/timeline`, K.Timeline], [`/trail`, K.Trail],
    [`/documents`, I.Documents], [`/ideas`, I.Ideas], [`/tombstones/${FX.tombstoneAutomation}`, S.Tombstone],
  ];
  for (const [p, schema] of reads) {
    const r = await call("GET", p);
    assertEquals(r.status, 200, p);
    assert(schema.safeParse(r.json).success, p);
  }
  assertNotEquals((await call("GET", `/references/${uuid()}`)).status, 200);
});

// ── the pre-contract doors honour the D5 lifecycle (attempt 2, tester findings F2) ──────────────
// The workbench's own /workbench/sources router (routes/sources.ts), driven in-process on the same
// disposable database: its pool reads DB_* at import, so they are set from CONTRACT_TEST_* first.
const legacy = HOST
  ? await (async () => {
    Deno.env.set("DB_HOST", HOST);
    Deno.env.set("DB_PORT", Deno.env.get("CONTRACT_TEST_DB_PORT") ?? "5432");
    Deno.env.set("DB_USER", Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres");
    Deno.env.set("DB_PASSWORD", Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "");
    Deno.env.set("DB_POOL_SIZE", "2");
    Deno.env.set("WIKI_GIT_DIR", "/tmp/rwp0-legacy-vault"); // the Changes log is best-effort
    return { routes: await import("../routes/sources.ts"), pool: (await import("../db/pool.ts")).pool };
  })()
  : null;
async function legacyPost(path: string, body: unknown = {}) {
  const r = await legacy!.routes.sources.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}
async function lifeOf(id: string) {
  return (await sql<{ life: string; committed: boolean; unlinked: boolean; reason: string | null }>(
    `SELECT public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS life,
            retraction_committed_at IS NOT NULL AS committed, unlinked_at IS NOT NULL AS unlinked, suppression_reason AS reason
       FROM public.sources WHERE id = $1`, [id]))[0];
}
const trailKinds = async (id: string) =>
  (await sql<{ kind: string; detail: Record<string, unknown> }>(
    `SELECT kind, detail FROM public.source_trail_events WHERE source_id = $1 ORDER BY created_at, id`, [id]));
// a suppressed source WITH dependence (one claim edge), so it stays 'suppressed', not 'unlinked'
async function suppressedWithDependence() {
  const s = await newSource();
  const c = uuid();
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, 'claim on a source the legacy doors meet')`, [c]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [c, s]);
  assertEquals((await call("POST", `/sources/${s}/suppress`, { reason: "legacy door test", by: "tester" })).json.lifecycle, "suppressed");
  return { s, c };
}

t("a staged retract on a suppressed or unlinked source is refused: it never un-commits the suppression", async () => {
  const { s } = await suppressedWithDependence();
  const u = await newSource();
  assertEquals((await call("POST", `/sources/${u}/suppress`, { reason: "legacy door test", by: "tester" })).json.lifecycle, "unlinked");
  for (const [id, life] of [[s, "suppressed"], [u, "unlinked"]]) {
    const before = await trailKinds(id);
    const r = await legacyPost(`/${id}/retract`, { scope: "global", by: "tester" });
    assertEquals(r.status, 409, `staged retract on a ${life} source`);
    assertEquals(r.json.lifecycle, life);
    assertEquals(await lifeOf(id), { life, committed: true, unlinked: life === "unlinked", reason: "legacy door test" });
    assertEquals(await trailKinds(id), before, "a refused retract writes nothing");
    // retraction_committed_at stays set (committed: true above): every consumer that filters
    // it (match_sources, match_source_chunks, ...) still excludes the source
  }
});

t("a staged retract and a restore on an ACTIVE source work as before, with no lifecycle trail event", async () => {
  const s = await newSource();
  const r = await legacyPost(`/${s}/retract`, { scope: "global", by: "tester" });
  assertEquals([r.status, r.json.staged], [200, true]);
  assertEquals((await lifeOf(s)).life, "active"); // staged = still active until the compile commits it
  const back = await legacyPost(`/${s}/restore`);
  assertEquals(back.status, 200);
  assertEquals(await lifeOf(s), { life: "active", committed: false, unlinked: false, reason: null });
  assertEquals((await trailKinds(s)).length, 0);
});

t("a restore of a suppressed or unlinked source is a recorded transition: trail event, state cleared, claims re-scored", async () => {
  const { s, c } = await suppressedWithDependence();
  assertEquals(Number((await sql<{ c: number }>(`SELECT confidence AS c FROM public.claims WHERE id = $1`, [c]))[0].c), 0);
  const u = await newSource();
  await call("POST", `/sources/${u}/suppress`, { reason: "legacy door test", by: "tester" });
  for (const [id, from] of [[s, "suppressed"], [u, "unlinked"]]) {
    const r = await legacyPost(`/${id}/restore`, {});
    assertEquals(r.status, 200, `restore of a ${from} source`);
    assertEquals(r.json.transition, { from, to: "active" });
    assertEquals(await lifeOf(id), { life: "active", committed: false, unlinked: false, reason: null });
    const ev = (await trailKinds(id)).filter((e) => e.kind === "restored");
    assertEquals(ev.length, 1, "exactly one 'restored' trail event");
    assertEquals([ev[0].detail.from, ev[0].detail.to, ev[0].detail.reason], [from, "active", "legacy door test"]);
    const ref = await call("GET", `/references/${id}`);
    assertEquals([ref.json.state, ref.json.lifecycle], ["active", "active"]);
  }
  assert(Number((await sql<{ c: number }>(`SELECT confidence AS c FROM public.claims WHERE id = $1`, [c]))[0].c) > 0,
    "the restored source grounds its claim again (re-scored)");
});

t("restore still refuses a purged source", async () => {
  const s = await newSource();
  await sql(`UPDATE public.sources SET metadata = metadata || '{"purged": true}', retracted_at = now(), retraction_committed_at = now() WHERE id = $1`, [s]);
  const r = await legacyPost(`/${s}/restore`);
  assertEquals(r.status, 404);
  assertEquals((await lifeOf(s)).committed, true);
});

Deno.test({ name: "close the pool", ignore, fn: async () => {
  await pool!.end();
  await legacy?.pool.end();
}, sanitizeOps: false, sanitizeResources: false });
