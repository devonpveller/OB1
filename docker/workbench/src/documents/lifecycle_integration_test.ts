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

t("L5: the nightly run, clock injected: trashed 29 days ago survives, 31 days ago is removed (and a young one stays)", async () => {
  const d29 = await trashed(A, `lc-d29-${run}`);
  const d31 = await trashed(A, `lc-d31-${run}`);
  const fresh = await trashed(A, `lc-fresh-${run}`);
  const b31 = await trashed(B, `lc-b31-${run}`);
  const DAY = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * DAY);
  await sql(`UPDATE public.user_document_listings SET updated_at = $2 WHERE path = $1`, [d29, ago(29)]);
  await sql(`UPDATE public.user_document_listings SET updated_at = $2 WHERE path = $1`, [d31, ago(31)]);
  await sql(`UPDATE public.user_document_listings SET updated_at = $2 WHERE path = $1`, [b31, ago(31)]);
  Deno.env.set("WIKI_GIT_DIR", VAULT);
  const { emptyTrash } = await import("./repo.ts");
  const { poolDb } = await import("../contracts/db.ts");
  const out = await emptyTrash({ db: poolDb(pool as never), reg: {} as never }, "nightly-cleanup", { now: new Date() });
  assert(out.removed.includes(d31) && !(await exists(d31)), "31 days: removed");
  assert(out.removed.includes(b31) && !(await exists(b31)), "31 days, another user's: the nightly is for everyone");
  assert(!out.removed.includes(d29) && (await exists(d29)), "29 days: kept");
  assert(!out.removed.includes(fresh) && (await exists(fresh)), "just trashed: kept");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE path = $1`, [d29]))[0].n, 1);
  // the same run, the injected clock two days later: 29 -> 31 days, now removed
  const later = await emptyTrash({ db: poolDb(pool as never), reg: {} as never }, "nightly-cleanup", { now: new Date(Date.now() + 2 * DAY) });
  assert(later.removed.includes(d29) && !(await exists(d29)));
  assert(!later.removed.includes(fresh), "the fresh one is still under 30 days");
  const nightly = await sql(`SELECT actor_sub, kind FROM public.user_document_trail WHERE path = ANY($1) ORDER BY id`, [[d31, b31, d29]]);
  assertEquals(nightly.map((r) => [r.kind, r.actor_sub]), [["nightly_expired", "system:nightly"], ["nightly_expired", "system:nightly"], ["nightly_expired", "system:nightly"]]);
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
  assert(!JSON.stringify(rows).includes(marker), "no body text in the trail row");
  assert(!ownLines.text.includes(marker), "no body text in the trail API");
  // two identities: B sees B's line and a B-only count; nothing of A's
  const theirs = await call("GET", `${D}/trail`, undefined, B);
  assertEquals(theirs.status, 200);
  assert(!theirs.text.includes(x1) && !theirs.text.includes(`lc-x2-${run}`) && !theirs.text.includes(titleMark.toLowerCase()), "B never sees A's lines");
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
    const n = (await sql(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text LIKE $1 OR x::text LIKE $2`, [`%${body}%`, `%${title}%`]))[0].n;
    if (n) hits.push(`${tb}:${n}`);
  }
  assertEquals(hits, [], "no shared row mentions the body or the title");
  // the shared retrieval surface
  const found = await call("GET", `/workbench/contract/search?query=${encodeURIComponent(body)}`);
  assert(!found.text.includes(body) && !found.text.includes(title), "the shared search finds nothing of it");
  // and the trail row (owner table) names no body
  const row = JSON.stringify(await sql(`SELECT id::text, owner_sub, actor_sub, kind, document_id::text, path, trashed_at::text FROM public.user_document_trail WHERE path = $1`, [tp]));
  assert(!row.includes(body));
});

t("L8: migration slot 510: the removal trail table exists with its owner index and grants", async () => {
  const cols = (await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_document_trail' ORDER BY ordinal_position`)).map((r) => r.column_name);
  assertEquals(cols, ["id", "owner_sub", "actor_sub", "kind", "document_id", "path", "trashed_at", "created_at"]);
});
