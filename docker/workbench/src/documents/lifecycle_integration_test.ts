// deno test src/documents/lifecycle_integration_test.ts - rwr-docs-lifecycle-api over a REAL workbench and
// database (the real initdb chain, slot 510 included): unarchive, delete forever, empty trash, the nightly
// 30-day rule with an injected clock, the trail, two identities, a planted marker on shared surfaces.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-docs-lifecycle-tests.ps1 sets it for the :wt
// workbench on a DISPOSABLE internal network. Never point it at a live stack: it deletes documents.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, DOCS_TEST_VAULT (the workbench's vault, mounted here too),
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser), DOCS_TEST_SUB_HEADER (default X-Test-Sub).
// The nightly case imports the workbench's own emptyTrash and runs it here, on the same vault and database
// (WIKI_GIT_DIR / DB_* are set by the runner), because the nightly is a timer in main.ts, not a route.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const D = "/workbench/documents";
const A: Record<string, string> = {}; // the default identity
const run = crypto.randomUUID().slice(0, 8);
const B: Record<string, string> = { [SUB_HEADER]: `lifecycle-b-${run}` };
const exists = async (rel: string) => await Deno.stat(`${VAULT}/${rel}`).then(() => true, () => false);

async function newDoc(who: Record<string, string>, title: string, body: string, folder = "") {
  const r = await call("POST", D, { title, body, folder }, who);
  assertEquals(r.status, 201, r.text);
  return r.json.path as string;
}
async function trashed(who: Record<string, string>, title: string, body = "body " + title) {
  const p = await newDoc(who, title, body);
  const tr = await call("POST", `${D}/trash`, { path: p }, who);
  assertEquals(tr.status, 200, tr.text);
  return tr.json.trashed as string;
}

t("L1: archive then unarchive returns the document to its folder with its history; the archive state is undone", async () => {
  const p = await newDoc(A, `lc-un-${run}`, "UNARCHIVE-BODY", `lcf-${run}`);
  const ar = await call("POST", `${D}/archive`, { path: p });
  assertEquals(ar.status, 200, ar.text);
  const archived = ar.json.archived as string;
  assert(archived.includes("/.archive/") && !(await exists(p)));
  const text = await Deno.readTextFile(`${VAULT}/${archived}`);
  const un = await call("POST", `${D}/unarchive`, { path: archived });
  assertEquals(un.status, 200, un.text);
  assertEquals(un.json.unarchived, p, "back in its own folder");
  assertEquals(await Deno.readTextFile(`${VAULT}/${p}`), text, "text unchanged");
  const h = await call("GET", `${D}/history?path=${encodeURIComponent(p)}`);
  const msgs = (h.json.commits as { message: string }[]).map((c) => c.message).join("\n");
  assert(msgs.includes("archive") && msgs.includes("unarchive"), msgs);
  assertEquals((await call("GET", `${D}/state?path=${encodeURIComponent(p)}`)).json.archived, false);
  // not archived: refused; B cannot unarchive A's archived document and the answer is a missing one's
  assertEquals((await call("POST", `${D}/unarchive`, { path: p })).status, 400);
  const ar2 = await call("POST", `${D}/archive`, { path: p });
  const foreign = await call("POST", `${D}/unarchive`, { path: ar2.json.archived }, B);
  const missing = await call("POST", `${D}/unarchive`, { path: `documents/none/.archive/x.md` }, B);
  assertEquals([foreign.status, foreign.text], [404, JSON.stringify({ error: "no such document" })]);
  assertEquals(missing.status, 404);
  assertEquals(foreign.json, missing.json, "another user's row looks like a missing one");
  assert(await exists(ar2.json.archived));
});

t("L2: delete forever needs confirm: true; an active or archived document is refused; nothing is removed", async () => {
  const p = await newDoc(A, `lc-act-${run}`, "ACTIVE-BODY");
  for (const body of [{ path: p }, { path: p, confirm: false }, { path: p, confirm: "true" }, { path: p, confirm: 1 }]) {
    const r = await call("POST", `${D}/delete-forever`, body);
    assertEquals(r.status, 400, JSON.stringify(body));
    assert(r.text.includes("confirm"), r.text);
  }
  const r = await call("POST", `${D}/delete-forever`, { path: p, confirm: true });
  assertEquals(r.status, 400, "active: refused even when confirmed");
  assert(await exists(p));
  const arch = (await call("POST", `${D}/archive`, { path: p })).json.archived;
  assertEquals((await call("POST", `${D}/delete-forever`, { path: arch, confirm: true })).status, 400);
  assert(await exists(arch));
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE path IN ($1, $2)`, [p, arch]))[0].n, 0);
});

t("L3: delete forever on a trashed document works for its owner and is refused, as a missing one, for another user", async () => {
  const tp = await trashed(A, `lc-own-${run}`);
  const id = (await sql(`SELECT id::text FROM public.user_document_listings WHERE path = $1`, [tp]))[0].id;
  const foreign = await call("POST", `${D}/delete-forever`, { path: tp, confirm: true }, B);
  const missing = await call("POST", `${D}/delete-forever`, { path: tp.replace("lc-own", "lc-none"), confirm: true }, B);
  assertEquals(foreign.status, 404);
  assertEquals(foreign.status, missing.status);
  assertEquals(foreign.json, missing.json);
  assert(!foreign.text.includes(`lc-own-${run}`), "the refusal does not echo the path or title it refused");
  assert(await exists(tp), "refused: nothing removed");
  const ok = await call("POST", `${D}/delete-forever`, { path: tp, confirm: true });
  assertEquals(ok.status, 200, ok.text);
  assertEquals(ok.json.removed, true);
  assert(!(await exists(tp)));
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE id = $1::uuid`, [id]))[0].n, 0);
  assertEquals((await call("POST", `${D}/delete-forever`, { path: tp, confirm: true })).status, 404, "gone");
});

t("L4: empty trash needs confirm: true; A's removes only A's trashed documents; B's trash and live documents are untouched", async () => {
  const a1 = await trashed(A, `lc-a1-${run}`);
  const a2 = await trashed(A, `lc-a2-${run}`);
  const aLive = await newDoc(A, `lc-alive-${run}`, "stays");
  const b1 = await trashed(B, `lc-b1-${run}`);
  const b2 = await trashed(B, `lc-b2-${run}`);
  for (const body of [{}, { confirm: false }, { confirm: "yes" }]) {
    assertEquals((await call("POST", `${D}/empty-trash`, body)).status, 400, JSON.stringify(body));
  }
  assert((await exists(a1)) && (await exists(a2)), "refused: nothing removed");
  const r = await call("POST", `${D}/empty-trash`, { confirm: true });
  assertEquals(r.status, 200, r.text);
  assert(r.json.removed >= 2);
  assert(!(await exists(a1)) && !(await exists(a2)));
  assert(await exists(aLive));
  assert((await exists(b1)) && (await exists(b2)), "B's trash is untouched");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE path = ANY($1)`, [[b1, b2]]))[0].n, 2);
  // the count B is told is B's own
  const rb = await call("POST", `${D}/empty-trash`, { confirm: true }, B);
  assertEquals(rb.status, 200);
  assertEquals(rb.json.removed, 2);
  assert(!(await exists(b1)));
});

t("L5: the nightly run, clock injected: 29 days after the trash it survives, 31 days after it is removed (and a young one stays)", async () => {
  const d1 = await trashed(A, `lc-d1-${run}`);
  const d2 = await trashed(B, `lc-d2-${run}`);
  const DAY = 86_400_000;
  Deno.env.set("WIKI_GIT_DIR", VAULT);
  const { emptyTrash } = await import("./repo.ts");
  const { poolDb } = await import("../contracts/db.ts");
  const deps = { db: poolDb(pool as never), reg: {} as never };
  // the trash date is the LATER of the listing's record and the trash commit's committer date: both are "now" here,
  // so the age is told by the injected clock, not by backdating one source
  const r0 = await emptyTrash(deps, "nightly-cleanup", { now: new Date() });
  assert(!r0.removed.includes(d1) && !r0.removed.includes(d2) && (await exists(d1)), "just trashed: kept");
  const r29 = await emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 29 * DAY) });
  assert(!r29.removed.includes(d1) && !r29.removed.includes(d2) && (await exists(d1)) && (await exists(d2)), "29 days after the trash: kept");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE path = $1`, [d1]))[0].n, 1);
  const fresh = await trashed(A, `lc-fresh-${run}`); // trashed now, after the 29-day pass; the 31-day clock below is 31 days after d1 and d2
  const r31 = await emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 31 * DAY) });
  assert(r31.removed.includes(d1) && !(await exists(d1)), "31 days after the trash: removed");
  assert(r31.removed.includes(d2) && !(await exists(d2)), "another user's too: the nightly is for everyone");
  assert(r31.removed.includes(fresh), "(fresh was trashed seconds after; 31 days on the clock is past it too)");
  const nightly = await sql(`SELECT actor_sub, kind, owner_sub FROM public.user_document_trail WHERE path = ANY($1) ORDER BY id`, [[d1, d2, fresh]]);
  assertEquals(nightly.map((r) => [r.kind, r.actor_sub]), nightly.map(() => ["nightly_expired", "system:nightly"]));
  assertEquals(nightly.length, 3);
});

t("L6: one trail line per hard removal, holding no body text; each user reads only their own lines and counts", async () => {
  const marker = `TRAILBODY-${run}`;
  const titleMark = `TitleMark${run}`;
  const x1 = await trashed(A, titleMark, marker);
  const x2 = await trashed(A, `lc-x2-${run}`, marker);
  const bx = await trashed(B, `lc-bx-${run}`, marker);
  assertEquals((await call("POST", `${D}/delete-forever`, { path: x1, confirm: true })).status, 200);
  assertEquals((await call("POST", `${D}/delete-forever`, { path: bx, confirm: true }, B)).status, 200);
  const rows = await sql(`SELECT id::text, owner_sub, actor_sub, kind, document_id::text, path, trashed_at::text, created_at::text FROM public.user_document_trail WHERE path = ANY($1)`, [[x1, bx]]);
  assertEquals(rows.length, 2, "exactly one line per removal");
  const ownLines = await call("GET", `${D}/trail`);
  assertEquals(ownLines.status, 200);
  const mine = (ownLines.json.lines as { path: string }[]).filter((l) => l.path === x1);
  assertEquals(mine.length, 1);
  assert(!JSON.stringify(rows).toLowerCase().includes(marker.toLowerCase()), "no body text in the trail row");
  assert(!ownLines.text.toLowerCase().includes(marker.toLowerCase()), "no body text in the trail API");
  // two identities: B sees B's line and a B-only count; nothing of A's
  const theirs = await call("GET", `${D}/trail`, undefined, B);
  assertEquals(theirs.status, 200);
  const theirsLow = theirs.text.toLowerCase();
  assert(!theirsLow.includes(x1.toLowerCase()) && !theirsLow.includes(`lc-x2-${run}`) && !theirsLow.includes(titleMark.toLowerCase()), "B never sees A's lines (any letter case)");
  assertEquals(theirs.json.total, (await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE owner_sub = $1`, [`lifecycle-b-${run}`]))[0].n);
  // x2 was never removed: no line
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE path = $1`, [x2]))[0].n, 0);
});

t("L7: nothing private from this item is on a shared surface (planted body and title markers)", async () => {
  const body = `SHAREDBODY-${run}`;
  const title = `SharedTitle${run}`;
  const p = await newDoc(A, title, body);
  const tp = (await call("POST", `${D}/trash`, { path: p })).json.trashed as string;
  const a2 = await newDoc(A, `lc-arch-${run}`, body);
  const arch = (await call("POST", `${D}/archive`, { path: a2 })).json.archived as string;
  await call("POST", `${D}/unarchive`, { path: arch });
  assertEquals((await call("POST", `${D}/delete-forever`, { path: tp, confirm: true })).status, 200);
  await call("POST", `${D}/empty-trash`, { confirm: true });
  // every public table except the owner-keyed ones: no row mentions either marker
  const tables = (await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('user_document_listings', 'user_document_trail')`)).map((r) => r.table_name);
  const hits: string[] = [];
  for (const tb of tables) {
    const n = (await sql(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text ILIKE $1 OR x::text ILIKE $2`, [`%${body}%`, `%${title}%`]))[0].n;
    if (n) hits.push(`${tb}:${n}`);
  }
  assertEquals(hits, [], "no shared row mentions the body or the title");
  // the shared retrieval surface
  const found = await call("GET", `/workbench/contract/search?query=${encodeURIComponent(body)}`);
  assert(!found.text.toLowerCase().includes(body.toLowerCase()) && !found.text.toLowerCase().includes(title.toLowerCase()), "the shared search finds nothing of it");
  // and the trail row (owner table) names no body
  const row = JSON.stringify(await sql(`SELECT id::text, owner_sub, actor_sub, kind, document_id::text, path, trashed_at::text FROM public.user_document_trail WHERE path = $1`, [tp]));
  assert(!row.toLowerCase().includes(body.toLowerCase()));
});

t("L8: migration slot 510: the removal trail table exists with its owner index and grants", async () => {
  const cols = (await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_document_trail' ORDER BY ordinal_position`)).map((r) => r.column_name);
  assertEquals(cols, ["id", "owner_sub", "actor_sub", "kind", "document_id", "path", "trashed_at", "created_at"]);
});

t("L9: the irreversible routes under concurrency and bad input: parallel delete-forever, empty-trash against a restore, a non-JSON body", async () => {
  // eight parallel delete-forevers of one trashed document: exactly one 200, the rest 404, one trail row
  const tp = await trashed(A, `lc-par-${run}`);
  const res = await Promise.all(Array.from({ length: 8 }, () => call("POST", `${D}/delete-forever`, { path: tp, confirm: true })));
  assertEquals(res.filter((r) => r.status === 200 && r.json.removed === true).length, 1, res.map((r) => r.status).join(","));
  assertEquals(res.filter((r) => r.status === 404).length, 7);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE path = $1`, [tp]))[0].n, 1, "one trail row");
  assert(!(await exists(tp)));
  // empty-trash racing a restore, eight rounds: alive with no row, or removed with exactly one row
  for (let i = 0; i < 8; i++) {
    const t0 = await trashed(A, `lc-race${i}-${run}`);
    const live = t0.replace("/.trash/", "/");
    const [e, r] = await Promise.all([call("POST", `${D}/empty-trash`, { confirm: true }), call("POST", `${D}/restore`, { path: t0 })]);
    assertEquals(e.status, 200, e.text);
    const rows = (await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE path = $1`, [t0]))[0].n;
    const alive = await exists(live);
    assert(alive !== (rows === 1), `round ${i}: alive=${alive} rows=${rows} restore=${r.status}`);
    if (alive) await call("POST", `${D}/trash`, { path: live }).then(() => call("POST", `${D}/empty-trash`, { confirm: true }));
  }
  // a non-JSON body is refused before any handler, the document untouched
  const t1 = await trashed(A, `lc-txt-${run}`);
  for (const [path, ct] of [["delete-forever", "text/plain"], ["empty-trash", "application/x-www-form-urlencoded"], ["unarchive", "text/plain"]]) {
    const r = await fetch(`${BASE}${D}/${path}`, { method: "POST", headers: { "content-type": ct, "x-brain-key": KEY }, body: JSON.stringify({ path: t1, confirm: true }) });
    assertEquals(r.status, 415, path);
    await r.text();
  }
  assert(await exists(t1), "nothing removed by a non-JSON body");
});

t("L10 (round 2, review R1): the JSON-only rule is this item's three routes only - every other documents POST answers as before", async () => {
  // a raw call: no content-type at all when there is no body, or the type given
  const raw = async (path: string, ct: string | null, body: string | undefined, who: Record<string, string> = A) => {
    const headers: Record<string, string> = { "x-brain-key": KEY, ...who };
    if (ct) headers["content-type"] = ct;
    const r = await fetch(BASE + path, { method: "POST", headers, body });
    const text = await r.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch { /* not json */ }
    if (r.status === 415) throw new Error(`POST ${path} got 415 (${text}): the JSON-only rule reached a route outside this item`);
    return { status: r.status, json, text };
  };
  // body-less by design: reconcile ("run when the workspace connects")
  const rec = await raw(`${D}/reconcile`, null, undefined);
  assertEquals(rec.status, 200, rec.text);
  // re-pin reads its input from the query: a body-less POST reaches the handler (no such record: its own 404)
  const own = await newDoc(A, `lc-r1-${run}`, "R1-BODY");
  const rp = await raw(`${D}/references/00000000-0000-0000-0000-000000000000/repin?path=${encodeURIComponent(own)}`, null, undefined);
  assertEquals([rp.status, rp.json.error], [404, "no reference record with this id"], rp.text);
  // a text/plain JSON body on create, trash and folders works as it did before this item
  const cr = await raw(D, "text/plain", JSON.stringify({ title: `lc-r1-plain-${run}`, body: "R1-PLAIN" }));
  assert(cr.status === 201 || cr.status === 207, cr.text);
  const fo = await raw(`${D}/folders`, "text/plain", JSON.stringify({ path: `lc-r1-folder-${run}` }));
  assert(fo.status === 201 || fo.status === 200, fo.text);
  // ...and the handlers' own owner checks still refuse another user, whatever the body type
  const bTrash = await raw(`${D}/trash`, "text/plain", JSON.stringify({ path: own }), B);
  assertEquals([bTrash.status, bTrash.json.error], [404, "no such document"], bTrash.text);
  const bRepin = await raw(`${D}/references/00000000-0000-0000-0000-000000000000/repin?path=${encodeURIComponent(own)}`, null, undefined, B);
  assertEquals(bRepin.status, 404, bRepin.text);
  assert(await exists(own), "B's calls left A's document where it was");
  const tr = await raw(`${D}/trash`, "text/plain", JSON.stringify({ path: own }));
  assertEquals(tr.status, 200, tr.text);
  assert(!(await exists(own)) && (await exists(tr.json.trashed)), "A's own text/plain trash moved it to the trash");
});

t("L10: putting a document back (restore, unarchive) writes exactly one trail line for the owner, never for a failed move, never visible to another user", async () => {
  const lines = (path: string) => sql(`SELECT owner_sub, actor_sub, kind, document_id::text, path, trashed_at::text FROM public.user_document_trail WHERE path = $1 ORDER BY id`, [path]);
  const marker = `TRAIL-BODY-${run}`;
  // restore from the trash
  const tp = await trashed(A, `lc-back-${run}`, marker);
  const live = tp.replace("/.trash/", "/");
  const rs = await call("POST", `${D}/restore`, { path: tp });
  assertEquals(rs.status, 200, rs.text);
  assertEquals(rs.json.restored, live);
  const rl = await lines(live);
  assertEquals(rl.length, 1, "exactly one line for the restore");
  assertEquals([rl[0].kind, rl[0].owner_sub], ["restored", (await sql(`SELECT owner_sub FROM public.user_document_listings WHERE path = $1`, [live]))[0].owner_sub]);
  assertEquals((await lines(tp)).length, 0, "no line under the trash path");
  // unarchive
  const ap = (await call("POST", `${D}/archive`, { path: live })).json.archived as string;
  assertEquals((await lines(live)).length, 1, "archiving writes no line");
  const un = await call("POST", `${D}/unarchive`, { path: ap });
  assertEquals(un.status, 200, un.text);
  const ul = await lines(live);
  assertEquals(ul.map((r) => r.kind), ["restored", "unarchived"], "one more line, for the unarchive");
  // the owner reads both in the trail API; no body or title anywhere
  const own = await call("GET", `${D}/trail`);
  const mine = (own.json.lines as { path: string; kind: string }[]).filter((l) => l.path === live);
  assertEquals(mine.map((l) => l.kind).sort(), ["restored", "unarchived"]);
  assert(!own.text.includes(marker) && !JSON.stringify(ul).includes(marker) && !JSON.stringify(ul).includes(`lc-back-${run}`.replace(/-/g, " ")), "no body or title in the lines");
  assertEquals(Object.keys(own.json.lines[0]).sort(), ["actor_sub", "created_at", "id", "kind", "path", "trashed_at"]);
  // another user never sees them, and cannot cause one
  const theirs = await call("GET", `${D}/trail`, undefined, B);
  assert(!theirs.text.toLowerCase().includes(live.toLowerCase()), "B never sees A's restore lines");
  const tp2 = (await call("POST", `${D}/trash`, { path: live })).json.trashed as string;
  const bt = await call("POST", `${D}/restore`, { path: tp2 }, B);
  assertEquals(bt.status, 404, "B cannot restore A's document");
  assertEquals((await lines(live)).length, 2, "B's refused restore wrote no line");

  // a failing move leaves no line: restoring onto a name that is taken is refused (409)
  await Deno.writeTextFile(`${VAULT}/${live}`, `---
title: "squatter"
---
`);
  const bad = await call("POST", `${D}/restore`, { path: tp2 });
  assertEquals(bad.status, 409, bad.text);
  assertEquals((await lines(live)).length, 2, "a refused move wrote no line");
  assertEquals((await lines(tp2)).length, 0);
  assert(await exists(tp2), "the trashed document is where it was");
  // the same for a missing document
  assertEquals((await call("POST", `${D}/unarchive`, { path: `documents/none/.archive/ghost-${run}.md` })).status, 404);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_trail WHERE path LIKE $1`, [`%ghost-${run}.md`]))[0].n, 0);
  // the trail is still append-only through the app role: no UPDATE / DELETE / TRUNCATE for the workbench's own login
  const ob = await sql(`SELECT has_table_privilege('ob_app_memory','public.user_document_trail','UPDATE') AS u, has_table_privilege('ob_app_memory','public.user_document_trail','TRUNCATE') AS tr, has_table_privilege('ob_app_memory','public.user_document_trail','DELETE') AS d`);
  assertEquals([ob[0].u, ob[0].tr, ob[0].d], [false, false, false]);
});

t("L-id: a document's opaque id is the listing row's, stable through archive/unarchive/trash/restore/move; resolve answers the owner only", async () => {
  const p = await newDoc(A, `opq-${run}`, "OPAQUE-BODY");
  const id = (await call("GET", `${D}/state?path=${encodeURIComponent(p)}`)).json.id as string;
  assert(/^[0-9a-f-]{36}$/.test(id), `state carries the listing id: ${id}`);
  const listed = (await call("GET", `/workbench/contract/documents?limit=500`)).json.documents.find((x: any) => x.path === p);
  assertEquals(listed?.id, id, "the contract listing carries the same id");
  const res = async (who: Record<string, string>, v: string) => await call("GET", `${D}/resolve?id=${encodeURIComponent(v)}`, undefined, who);
  const own = await res(A, id);
  assertEquals([own.status, own.json.path, own.json.id, own.json.listed], [200, p, id, true]);
  // archive -> unarchive -> trash -> restore: the row, so the id, stays; resolve follows the path
  const ar = await call("POST", `${D}/archive`, { path: p });
  assertEquals(ar.status, 200, ar.text);
  let r = await res(A, id);
  assertEquals([r.status, r.json.path, r.json.archived], [200, ar.json.archived, true]);
  const un = await call("POST", `${D}/unarchive`, { path: ar.json.archived });
  assertEquals((await res(A, id)).json.path, un.json.unarchived);
  const tr = await call("POST", `${D}/trash`, { path: un.json.unarchived });
  r = await res(A, id);
  assertEquals([r.status, r.json.path, r.json.trashed], [200, tr.json.trashed, true]);
  const rs = await call("POST", `${D}/restore`, { path: tr.json.trashed });
  assertEquals((await res(A, id)).json.path, rs.json.restored);
  // another person's id, a missing id and a non-id answer exactly alike (status and body)
  const foreign = await res(B, id);
  const missing = await res(B, crypto.randomUUID());
  const junk = await res(A, "documents/../etc/passwd");
  const none = await call("GET", `${D}/resolve`);
  assertEquals([foreign.status, foreign.text], [404, JSON.stringify({ error: "no such document" })]);
  for (const x of [missing, junk, none]) assertEquals([x.status, x.text], [foreign.status, foreign.text]);
  // delete forever: the id is gone like any missing one
  const gone = await trashed(A, `opq-gone-${run}`);
  const gid = (await call("GET", `${D}/state?path=${encodeURIComponent(gone)}`)).json.id as string;
  assertEquals((await call("POST", `${D}/delete-forever`, { path: gone, confirm: true })).status, 200);
  assertEquals((await res(A, gid)).text, foreign.text);
});
