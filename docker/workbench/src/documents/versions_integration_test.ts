// deno test src/documents/versions_integration_test.ts - rwr-doc-versions-api over a REAL workbench and database (the real
// initdb chain, slot 620 included): numbered versions, named snapshots, restore, compare; two identities with planted
// data; planted markers on shared surfaces; the migration's table.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-doc-versions-tests.ps1 sets it for the :wt workbench on a
// DISPOSABLE internal network. Never point it at a live stack: it writes, restores and trashes documents.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, DOCS_TEST_VAULT (the workbench's vault, mounted here too; git is read
// from it), CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser), DOCS_TEST_SUB_HEADER (default X-Test-Sub).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
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
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: { type: string; text: string }) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": raw?.type ?? "application/json", "x-brain-key": KEY, ...headers },
    body: raw ? raw.text : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const D = "/workbench/documents";
const q = encodeURIComponent;
const A: Record<string, string> = {}; // the default identity
const run = crypto.randomUUID().slice(0, 8);
const B: Record<string, string> = { [SUB_HEADER]: `versions-b-${run}` };
const exists = async (rel: string) => await Deno.stat(`${VAULT}/${rel}`).then(() => true, () => false);
// git on the workbench's own vault, read-only (the test container is not the vault's owner: safe.directory)
async function git(...args: string[]) {
  const r = await new Deno.Command("git", { args: ["-c", "safe.directory=*", "-C", VAULT, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout);
}
const body = (n: number, tag = "") => `line ${n} ${tag}\n`;

async function newDoc(who: Record<string, string>, title: string, text = "first", folder = "") {
  const r = await call("POST", D, { title, body: text, folder }, who);
  assertEquals(r.status, 201, r.text);
  return r.json.path as string;
}
// n further saved versions (a save with commit=1); the document had one already, so it ends at v(1 + n)
async function edit(path: string, text: string, who: Record<string, string> = A) {
  const r = await call("PUT", `${D}/file?path=${q(path)}&commit=1`, { content: text }, who);
  assert(r.status === 200 || r.status === 207, r.text);
}
async function versions(path: string, who: Record<string, string> = A, extra = "") {
  const r = await call("GET", `${D}/versions?path=${q(path)}${extra}`, undefined, who);
  assertEquals(r.status, 200, r.text);
  return r.json as { path: string; current_version: number | null; total: number; next: number | null; unsaved_changes: boolean; versions: { version: number; commit: string; message: string; snapshots: { id: string; name: string; kind: string; version: number }[] }[] };
}
async function docWith(who: Record<string, string>, title: string, n: number) {
  const p = await newDoc(who, title, body(1));
  for (let i = 2; i <= n; i++) await edit(p, `---\ntitle: ${JSON.stringify(title)}\n---\n\n` + body(i), who);
  return p;
}
const textOf = async (p: string) => await Deno.readTextFile(`${VAULT}/${p}`);

t("V1: restore v11 at v14 makes v15 and a snapshot at v14; restoring that snapshot brings v14's text back as v16", async () => {
  const p = await docWith(A, `ver-restore-${run}`, 14);
  const v14 = await textOf(p);
  const vs = await versions(p);
  assertEquals([vs.current_version, vs.total], [14, 14]);
  const v11 = await call("GET", `${D}/compare?path=${q(p)}&from=11&to=11`);
  assertEquals(v11.json.identical, true);
  const r = await call("POST", `${D}/restore-version`, { path: p, version: 11 });
  assertEquals(r.status, 200, r.text);
  assertEquals([r.json.restored, r.json.from_version, r.json.version], [true, 11, 15]);
  assertEquals([r.json.snapshot.name, r.json.snapshot.version, r.json.snapshot.kind], ["Before restoring v11", 14, "before_restore"]);
  assert((await textOf(p)).includes("line 11"), "v11's text is the document's text");
  const after = await versions(p);
  assertEquals([after.current_version, after.total], [15, 15]);
  assertEquals(after.versions[1].snapshots.map((s) => s.name), ["Before restoring v11"], "v14 carries the marker");
  assertEquals(after.versions[0].snapshots, [], "v15 carries none");
  const snaps = await call("GET", `${D}/snapshots?path=${q(p)}`);
  assertEquals([snaps.json.total, snaps.json.snapshots[0].version], [1, 14]);
  const back = await call("POST", `${D}/restore-version`, { path: p, snapshot_id: r.json.snapshot.id });
  assertEquals(back.status, 200, back.text);
  assertEquals([back.json.restored, back.json.from_version, back.json.version], [true, 14, 16]);
  assertEquals(await textOf(p), v14, "v14's text is back, byte for byte");
  // git agrees: v16's blob is v14's blob, and the history is only ever longer
  const log = (await git("log", "--format=%s", "--", p)).trim().split("\n");
  assert(log[0].startsWith("documents: restore") && log[0].endsWith("to v14"), log[0]);
  assert(log[1].endsWith("to v11"), log[1]);
  assertEquals(log.length, 16);
});

t("V2: version numbers do not change after a move, a trash and a restore, an archive and an unarchive", async () => {
  const p = await docWith(A, `ver-stable-${run}`, 5);
  const key = (vs: Awaited<ReturnType<typeof versions>>) => JSON.stringify(vs.versions.map((v) => [v.version, v.commit]));
  const before = key(await versions(p));
  const mv = await call("POST", `${D}/move`, { from: p, to_folder: `vf-${run}` });
  assertEquals(mv.status, 200, mv.text);
  const moved = mv.json.to as string;
  assertEquals(key(await versions(moved)), before, "after a move");
  const tr = await call("POST", `${D}/trash`, { path: moved });
  assertEquals(tr.status, 200, tr.text);
  assertEquals(key(await versions(tr.json.trashed)), before, "in the trash");
  const rs = await call("POST", `${D}/restore`, { path: tr.json.trashed });
  assertEquals(rs.status, 200, rs.text);
  assertEquals(key(await versions(rs.json.restored)), before, "restored from the trash");
  const ar = await call("POST", `${D}/archive`, { path: rs.json.restored });
  assertEquals(ar.status, 200, ar.text);
  assertEquals(key(await versions(ar.json.archived)), before, "archived");
  const un = await call("POST", `${D}/unarchive`, { path: ar.json.archived });
  assertEquals(un.status, 200, un.text);
  assertEquals(key(await versions(un.json.unarchived)), before, "unarchived");
  // a snapshot made before all that is still on its version, and the next edit is the next number
  await edit(un.json.unarchived, "---\ntitle: x\n---\n\nsix\n");
  assertEquals((await versions(un.json.unarchived)).current_version, 6);
});

t("V2b: a snapshot made on a version stays on it after the document moves", async () => {
  const p = await docWith(A, `ver-snapmove-${run}`, 3);
  const s = await call("POST", `${D}/snapshot`, { path: p, name: `keep-${run}`, version: 2 });
  assertEquals(s.status, 201, s.text);
  assertEquals(s.json.snapshot.version, 2);
  const moved = (await call("POST", `${D}/move`, { from: p, to_folder: `vf2-${run}` })).json.to as string;
  const vs = await versions(moved);
  assertEquals(vs.versions.find((v) => v.version === 2)!.snapshots.map((x) => x.name), [`keep-${run}`]);
  assertEquals((await call("GET", `${D}/snapshots?path=${q(moved)}`)).json.total, 1);
  assertEquals((await versions(p, A).catch(() => null)), null, "the old path is gone");
});

t("V3: compare of two versions returns exactly the git diff on the vault file", async () => {
  const p = await docWith(A, `ver-compare-${run}`, 6);
  const vs = (await versions(p)).versions; // newest first
  const c = (n: number) => vs.find((v) => v.version === n)!.commit;
  for (const [from, to] of [[1, 6], [2, 5], [6, 1], [3, 4]]) {
    const r = await call("GET", `${D}/compare?path=${q(p)}&from=${from}&to=${to}`);
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json.diff, await git("diff", c(from), c(to), "--", p), `v${from} -> v${to}`);
    assertEquals([r.json.from.version, r.json.to.version, r.json.from.commit, r.json.to.commit], [from, to, c(from), c(to)]);
    assertEquals(r.json.identical, false);
  }
  assertEquals((await call("GET", `${D}/compare?path=${q(p)}&from=4&to=4`)).json.diff, "");
  // across a move the two commits are still compared
  const moved = (await call("POST", `${D}/move`, { from: p, to_folder: `vf3-${run}` })).json.to as string;
  await edit(moved, "---\ntitle: z\n---\n\nseven\n");
  const vs2 = (await versions(moved)).versions;
  const x = await call("GET", `${D}/compare?path=${q(moved)}&from=1&to=7`);
  assertEquals(x.status, 200, x.text);
  assertEquals(x.json.diff, await git("diff", `${vs2.find((v) => v.version === 1)!.commit}:${p}`, `${vs2.find((v) => v.version === 7)!.commit}:${moved}`)); // blob to blob: the path then on each side
  // read-only: nothing changed, no version added
  assertEquals((await versions(moved)).total, 7);
  for (const bad of ["from=x&to=1", "from=1", "from=0&to=1", "from=1&to=1.5", "from=-1&to=2"]) {
    assertEquals((await call("GET", `${D}/compare?path=${q(moved)}&${bad}`)).status, 400, bad);
  }
  assertEquals((await call("GET", `${D}/compare?path=${q(moved)}&from=1&to=99`)).status, 404);
});

t("V4: two identities, planted data: B never sees A's snapshots, versions or compare, in any field, count or error; a refusal for A's row is a missing row's", async () => {
  const aMark = `APLANT-${run}`;
  const bMark = `BPLANT-${run}`;
  const aDoc = await docWith(A, `ver-a-${run}`, 4);
  await edit(aDoc, `---\ntitle: a\n---\n\nSECRETBODY-${aMark}\n`);
  const aSnap = (await call("POST", `${D}/snapshot`, { path: aDoc, name: `SNAPNAME-${aMark}`, version: 2 })).json.snapshot;
  const aRest = await call("POST", `${D}/restore-version`, { path: aDoc, version: 1 });
  assertEquals(aRest.status, 200, aRest.text);
  const bDoc = await docWith(B, `ver-b-${run}`, 3);
  const bSnap = (await call("POST", `${D}/snapshot`, { path: bDoc, name: `SNAPNAME-${bMark}`, version: 1 }, B)).json.snapshot;
  const aCount = (await sql(`SELECT count(*)::int AS n FROM public.document_snapshots WHERE owner_sub <> $1`, [`versions-b-${run}`]))[0].n;

  const ghostInA = aDoc.replace(`ver-a-${run}`, `ghost-${run}`); // missing, in A's directory
  const ghostInB = bDoc.replace(`ver-b-${run}`, `ghost-${run}`); // missing, in B's own
  const rel = aDoc.split("/").pop()!; // the relative form resolves into B's own directory
  const routes: [string, string, unknown, (p: string) => string][] = [
    ["versions", "GET", undefined, (p) => `${D}/versions?path=${q(p)}`],
    ["versions paged", "GET", undefined, (p) => `${D}/versions?path=${q(p)}&limit=1&before=3`],
    ["snapshots", "GET", undefined, (p) => `${D}/snapshots?path=${q(p)}`],
    ["compare", "GET", undefined, (p) => `${D}/compare?path=${q(p)}&from=1&to=2`],
    ["snapshot", "POST", { name: "intruder", version: 1 }, () => `${D}/snapshot`],
    ["restore version", "POST", { version: 1 }, () => `${D}/restore-version`],
    ["restore snapshot", "POST", { snapshot_id: aSnap.id }, () => `${D}/restore-version`],
  ];
  const seen: string[] = [];
  for (const [name, method, extra, url] of routes) {
    const answers: string[] = [];
    for (const target of [aDoc, ghostInA, ghostInB, rel]) {
      const withPath = method === "POST" ? { ...(extra as object), path: target } : undefined;
      const r = await call(method, url(target), withPath, B);
      answers.push(`${r.status} ${r.text}`);
      seen.push(r.text);
    }
    assertEquals(new Set(answers).size, 1, `${name}: A's row, a missing row in A's directory, a missing row of B's and the relative form answer alike:\n${answers.join("\n")}`);
    assert(answers[0].startsWith("404 "), `${name}: ${answers[0]}`);
    assert(!answers[0].includes(`ver-a-${run}`) && !answers[0].includes(aMark), `${name}: the refusal echoes nothing it was given`);
  }
  // A's snapshot id offered for B's OWN document is the answer of an id that is nothing at all
  const nothing = await call("POST", `${D}/restore-version`, { path: bDoc, snapshot_id: "00000000-0000-4000-8000-00000000abcd" }, B);
  const foreignId = await call("POST", `${D}/restore-version`, { path: bDoc, snapshot_id: aSnap.id }, B);
  const garbage = await call("POST", `${D}/restore-version`, { path: bDoc, snapshot_id: "not-an-id" }, B);
  assertEquals([foreignId.status, foreignId.text], [nothing.status, nothing.text]);
  assertEquals([garbage.status, garbage.text], [nothing.status, nothing.text]);
  assertEquals(nothing.status, 404);
  assertEquals((await versions(bDoc, B)).total, 3, "nothing was restored on B's document");
  assert((await textOf(bDoc)).includes("line 3"));
  // B's own reads carry B's data only: no A marker, no A path, no A count
  const own = [await call("GET", `${D}/versions?path=${q(bDoc)}`, undefined, B), await call("GET", `${D}/snapshots?path=${q(bDoc)}`, undefined, B),
    await call("GET", `${D}/compare?path=${q(bDoc)}&from=1&to=3`, undefined, B)];
  for (const r of own) {
    assertEquals(r.status, 200, r.text);
    seen.push(r.text);
  }
  assertEquals(own[0].json.total, 3);
  assertEquals(own[1].json.total, 1);
  assertEquals(own[1].json.snapshots[0].id, bSnap.id);
  assertEquals(own[0].json.versions.flatMap((v: any) => v.snapshots).length, 1, "B's list totals are B's own");
  const everything = seen.join("\n").toLowerCase();
  for (const m of [aMark, "SECRETBODY", `ver-a-${run}`, "before restoring v1", aSnap.id, aDoc.split("/")[1]]) {
    assert(!everything.includes(m.toLowerCase()), `nothing of A's reaches B: ${m}`);
  }
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.document_snapshots WHERE owner_sub <> $1`, [`versions-b-${run}`]))[0].n, aCount, "B wrote nothing to A's side");
  assertEquals((await versions(aDoc)).total, 6, "A's document is as A left it (v4, one more edit, then A's own restore)");
  // and the other way: A reads none of B's
  const aSees = [await call("GET", `${D}/versions?path=${q(aDoc)}`), await call("GET", `${D}/snapshots?path=${q(aDoc)}`)].map((r) => r.text).join("\n");
  assert(!aSees.includes(bMark) && !aSees.includes(bSnap.id), "nothing of B's reaches A");
  // owner_sub on the rows is the caller's, never a body field
  const forged = await call("POST", `${D}/snapshot`, { path: bDoc, name: `forged-${run}`, owner_sub: `versions-b-${run}-x`, actor_sub: "x" }, B);
  assertEquals(forged.status, 201);
  assertEquals((await sql(`SELECT owner_sub, actor_sub FROM public.document_snapshots WHERE id = $1::uuid`, [forged.json.snapshot.id]))[0], { owner_sub: `versions-b-${run}`, actor_sub: `versions-b-${run}` });
});

t("V5: nothing private from this item is on a shared surface (a planted body, snapshot name and title)", async () => {
  const bodyMark = `VBODY-${run}`;
  const nameMark = `VSNAPNAME-${run}`;
  const titleMark = `VTitle${run}`;
  const p = await newDoc(A, titleMark, bodyMark);
  await edit(p, `---\ntitle: ${titleMark}\n---\n\n${bodyMark} two\n`);
  const s = await call("POST", `${D}/snapshot`, { path: p, name: nameMark });
  assertEquals(s.status, 201, s.text);
  assertEquals((await call("POST", `${D}/restore-version`, { path: p, version: 1 })).status, 200);
  assertEquals((await call("GET", `${D}/compare?path=${q(p)}&from=1&to=2`)).status, 200);
  assertEquals((await call("POST", `${D}/restore-version`, { path: p, version: 99 })).status, 404);
  assertEquals((await call("POST", `${D}/snapshot`, { path: p, name: "" })).status, 400);
  const tables = (await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('user_document_listings', 'user_document_trail', 'document_snapshots')`)).map((r) => r.table_name);
  const hits: string[] = [];
  for (const tb of tables) {
    const n = (await sql(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text ILIKE $1 OR x::text ILIKE $2 OR x::text ILIKE $3`, [`%${bodyMark}%`, `%${nameMark}%`, `%${titleMark}%`]))[0].n;
    if (n) hits.push(`${tb}:${n}`);
  }
  assertEquals(hits, [], "no shared row mentions the body, the snapshot name or the title");
  // the table that holds the name holds it only for its owner, and never the text
  const row = await sql(`SELECT owner_sub, name, kind FROM public.document_snapshots WHERE id = $1::uuid`, [s.json.snapshot.id]);
  assertEquals(row[0].name, nameMark);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.document_snapshots x WHERE x::text ILIKE $1 OR x::text ILIKE $2`, [`%${bodyMark}%`, `%${titleMark}%`]))[0].n, 0, "a snapshot row holds no text and no title");
  for (const term of [bodyMark, nameMark, titleMark]) {
    const found = await call("GET", `/workbench/contract/search?query=${q(term)}`);
    assert(!found.text.toLowerCase().includes(term.toLowerCase()), `the shared search finds nothing of ${term}`);
  }
  // the planted strings are searched in the workbench's log by the runner (VBODY-, VSNAPNAME-, VTitle, SNAPNAME-, SECRETBODY)
});

t("V6: restore edge cases: unchanged text, unsaved text, a trashed document, bad input", async () => {
  const p = await docWith(A, `ver-edge-${run}`, 3);
  const same = await call("POST", `${D}/restore-version`, { path: p, version: 3 });
  assertEquals([same.status, same.json.restored, same.json.unchanged, same.json.version, same.json.snapshot], [200, false, true, 3, null]);
  assertEquals((await versions(p)).total, 3, "restoring the text it has adds no version");
  assertEquals((await call("GET", `${D}/snapshots?path=${q(p)}`)).json.total, 0, "and no marker");
  // a save that was not committed becomes a version first, and the marker is on it
  const put = await call("PUT", `${D}/file?path=${q(p)}`, { content: `---\ntitle: u\n---\n\nUNSAVED-${run}\n` });
  assertEquals(put.status, 200, put.text);
  const l0 = await versions(p);
  assertEquals([l0.total, l0.unsaved_changes], [3, true]);
  const r = await call("POST", `${D}/restore-version`, { path: p, version: 1 });
  assertEquals([r.json.restored, r.json.version, r.json.snapshot.version], [true, 5, 4], "v4 = the unsaved text, v5 = the restore");
  assert(!(await textOf(p)).includes("UNSAVED"));
  const unsaved = (await versions(p)).versions.find((v) => v.version === 4)!;
  assertEquals(unsaved.snapshots.map((s) => s.name), ["Before restoring v1"]);
  // both or neither, a trashed document, bad numbers, a non-JSON body
  for (const bad of [{ path: p }, { path: p, version: 1, snapshot_id: crypto.randomUUID() }]) {
    assertEquals((await call("POST", `${D}/restore-version`, bad)).status, 400, JSON.stringify(bad));
  }
  for (const v of [0, -1, 1.5, "abc", "1; DROP TABLE x", true]) {
    assertEquals((await call("POST", `${D}/restore-version`, { path: p, version: v })).status, 400, String(v));
  }
  assertEquals((await call("POST", `${D}/restore-version`, { path: p, version: 99 })).status, 404);
  assertEquals((await call("POST", `${D}/restore-version`, undefined, A, { type: "text/plain", text: JSON.stringify({ path: p, version: 1 }) })).status, 415);
  assertEquals((await call("POST", `${D}/snapshot`, undefined, A, { type: "text/plain", text: JSON.stringify({ path: p, name: "x" }) })).status, 415);
  const tp = (await call("POST", `${D}/trash`, { path: p })).json.trashed as string;
  const inTrash = await call("POST", `${D}/restore-version`, { path: tp, version: 1 });
  assertEquals(inTrash.status, 400, inTrash.text);
  assert(await exists(tp));
  assertEquals((await versions(tp)).total, 5, "a trashed document still lists its versions");
});

t("V7: snapshot names and versions: trimmed, 1 to 120 characters, the version must exist; a snapshot id of another of A's documents is nothing", async () => {
  const p = await docWith(A, `ver-names-${run}`, 2);
  const other = await docWith(A, `ver-names2-${run}`, 2);
  const ok = await call("POST", `${D}/snapshot`, { path: p, name: `  Draft   one  ` });
  assertEquals([ok.status, ok.json.snapshot.name, ok.json.snapshot.version, ok.json.snapshot.kind, ok.json.current_version], [201, "Draft one", 2, "named", 2]);
  for (const bad of ["", "   ", "x".repeat(121), "a\u0000b", 5, null]) {
    const r = await call("POST", `${D}/snapshot`, { path: p, name: bad });
    assertEquals(r.status, 400, JSON.stringify(bad).slice(0, 20));
    assert(!r.text.includes("xxxxxxxx"), "the refusal does not echo the name");
  }
  assertEquals((await call("POST", `${D}/snapshot`, { path: p, name: "ok", version: 3 })).status, 404);
  assertEquals((await call("POST", `${D}/snapshot`, { path: p, name: "ok", version: 0 })).status, 400);
  assertEquals((await call("POST", `${D}/snapshot`, { path: p, name: "x".repeat(120) })).status, 201, "120 is allowed");
  // this snapshot belongs to `p`; offered for `other` it means nothing, as an id that is nothing means nothing
  const foreign = await call("POST", `${D}/restore-version`, { path: other, snapshot_id: ok.json.snapshot.id });
  const none = await call("POST", `${D}/restore-version`, { path: other, snapshot_id: crypto.randomUUID() });
  assertEquals([foreign.status, foreign.text], [none.status, none.text]);
  assertEquals(foreign.status, 404);
  assertEquals((await versions(other)).total, 2);
  // two documents with the same text do not share versions or snapshots
  const t1 = await newDoc(A, `ver-twin-${run}`, "same");
  const t2 = await newDoc(A, `ver-twin-${run}`, "same");
  assertEquals((await textOf(t1)), (await textOf(t2)), "identical text");
  assertEquals([(await versions(t1)).total, (await versions(t2)).total], [1, 1], "a document whose text equals another's does not inherit its history");
  await call("POST", `${D}/snapshot`, { path: t1, name: "twin" });
  assertEquals([(await call("GET", `${D}/snapshots?path=${q(t1)}`)).json.total, (await call("GET", `${D}/snapshots?path=${q(t2)}`)).json.total], [1, 0]);
});

t("V8: the list pages on `before`; `limit` is bounded", async () => {
  const p = await docWith(A, `ver-page-${run}`, 7);
  const seen: number[] = [];
  let before: number | null = null;
  for (let i = 0; i < 6; i++) {
    const l = await versions(p, A, `&limit=3${before ? `&before=${before}` : ""}`);
    seen.push(...l.versions.map((v) => v.version));
    assertEquals(l.total, 7);
    if (l.next == null) break;
    before = l.next;
  }
  assertEquals(seen, [7, 6, 5, 4, 3, 2, 1]);
  for (const bad of ["limit=0", "limit=501", "limit=x", "before=0", "before=y"]) {
    assertEquals((await call("GET", `${D}/versions?path=${q(p)}&${bad}`)).status, 400, bad);
  }
});

t("V9: two restores of the same version at once make one version and one marker", async () => {
  const p = await docWith(A, `ver-race-${run}`, 3);
  const rs = await Promise.all([1, 2, 3].map(() => call("POST", `${D}/restore-version`, { path: p, version: 1 })));
  for (const r of rs) assertEquals(r.status, 200, r.text);
  assertEquals(rs.filter((r) => r.json.restored).length, 1, "one of them restored");
  assertEquals(rs.filter((r) => r.json.unchanged).length, 2, "the others found the text already back");
  const l = await versions(p);
  assertEquals(l.total, 4);
  assertEquals((await call("GET", `${D}/snapshots?path=${q(p)}`)).json.total, 1);
  assert((await textOf(p)).includes("line 1"));
});

t("V10: migration slot 620: the table, its checks, its row-level security and its grants (read and add only)", async () => {
  const cols = (await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_snapshots' ORDER BY ordinal_position`)).map((r) => r.column_name);
  assertEquals(cols, ["id", "owner_sub", "actor_sub", "commit_hash", "blob_hash", "name", "kind", "created_at"]);
  assertEquals((await sql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.document_snapshots'::regclass`))[0].relrowsecurity, true);
  const priv = async (role: string, p: string) => (await sql(`SELECT has_table_privilege($1, 'public.document_snapshots', $2) AS ok`, [role, p]))[0].ok;
  assertEquals([await priv("service_role", "SELECT"), await priv("service_role", "INSERT")], [true, true]);
  assertEquals([await priv("service_role", "UPDATE"), await priv("service_role", "DELETE"), await priv("service_role", "TRUNCATE")], [false, false, false]);
  const grantees = await sql<{ g: string }>(`SELECT DISTINCT ro.rolname AS g FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee WHERE cl.oid = 'public.document_snapshots'::regclass AND NOT ro.rolsuper`);
  assertEquals(grantees.map((r) => r.g), ["service_role"]);
  // the table's own checks
  const bad = async (text: string, args: unknown[]) => await sql(text, args).then(() => "inserted", (e) => String(e?.message ?? e).includes("violates check constraint") ? "refused" : String(e));
  const ins = `INSERT INTO public.document_snapshots (owner_sub, actor_sub, commit_hash, blob_hash, name, kind) VALUES ('o', 'a', $1, $2, $3, $4)`;
  const h = "a".repeat(40);
  assertEquals(await bad(ins, ["short", h, "n", "named"]), "refused");
  assertEquals(await bad(ins, [h, h.toUpperCase(), "n", "named"]), "refused");
  assertEquals(await bad(ins, [h, h, "", "named"]), "refused");
  assertEquals(await bad(ins, [h, h, "x".repeat(121), "named"]), "refused");
  assertEquals(await bad(ins, [h, h, "n", "other"]), "refused");
});

// ── attempt 1 of the tester: a commit that carries two owners' files ──────────────────────────────────────────────
// B's new document must have exactly one version, B's restore of v1 must leave B's own text, and nothing of A's may reach B
// - whether the two owners' operations race through the API (the vault's git lock keeps their commits apart) or a commit
// that was not made by this service (the wiki compile's `git add -A`, simulated here by staging A's removal by hand)
// sweeps both owners' files into one (the chase follows only exact renames inside one owner's tree).
async function bSeesOnlyOwn(bPath: string, bText: string, aMarker: string, label: string) {
  const l = await versions(bPath, B);
  assertEquals([l.total, l.current_version], [1, 1], `${label}: B has exactly one version`);
  assertEquals(l.versions[0].snapshots, []);
  const r = await call("POST", `${D}/restore-version`, { path: bPath, version: 1 }, B);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.unchanged, true, `${label}: restoring v1 changes nothing`);
  assertEquals(await textOf(bPath), bText, `${label}: B's file is B's`);
  const all = [JSON.stringify(l), r.text, (await call("GET", `${D}/compare?path=${q(bPath)}&from=1&to=1`, undefined, B)).text, (await call("GET", `${D}/snapshots?path=${q(bPath)}`, undefined, B)).text].join("\n");
  assert(!all.includes(aMarker), `${label}: nothing of A's reaches B`);
}

t("V11: A's delete-forever racing B's create (and a hand-staged removal swept into B's commit): B has one version, B's restore of v1 leaves B's text, no marker of A's", async () => {
  for (let round = 0; round < 6; round++) {
    const aMark = `RACE-A-${run}-${round}`;
    const aPath = await newDoc(A, `race-a-${run}-${round}`, aMark);
    for (let i = 0; i < 2; i++) await edit(aPath, `---\ntitle: a\n---\n\n${aMark} ${i}\n`);
    const tp = (await call("POST", `${D}/trash`, { path: aPath })).json.trashed as string;
    const [del, mk] = await Promise.all([
      call("POST", `${D}/delete-forever`, { path: tp, confirm: true }),
      call("POST", D, { title: `race-b-${run}-${round}`, body: `B's own text ${round}`, folder: "" }, B),
    ]);
    assertEquals(del.status, 200, del.text);
    assertEquals(mk.status, 201, mk.text);
    await bSeesOnlyOwn(mk.json.path, await textOf(mk.json.path), aMark, `race round ${round}`);
  }
  // not made by this service: A's removal is staged by hand, then B's create commits the whole index
  for (const same of [false, true]) {
    const aMark = `STAGED-A-${run}-${same}`;
    const aPath = await newDoc(A, `staged-a-${run}-${same}`, aMark);
    await edit(aPath, `---\ntitle: a\n---\n\n${aMark} 2\n`);
    const tp = (await call("POST", `${D}/trash`, { path: aPath })).json.trashed as string;
    await git("rm", "--quiet", "--", tp);
    const mk = await call("POST", D, { title: `staged-b-${run}-${same}`, body: same ? aMark : `B's text ${same}`, folder: "" }, B);
    assertEquals(mk.status, 201, mk.text);
    // (when B's own text is A's text byte for byte the marker is B's too: the checks that remain are the version count and the file)
    await bSeesOnlyOwn(mk.json.path, await textOf(mk.json.path), same ? "no-such-marker-xyz" : aMark, `staged removal (same=${same})`);
  }
});

// V12: a note write by B (vaultCommit: `git add -A`, the whole tree, no lock) commits A's staged removal / move / unsaved text.
// A's version list stays A's (no version authored by B shown, no B message, no B note text; compare names only A's path);
// B sees none of A's history.
t("V12: B's note commit sweeps A's staged move, A's unsaved text and A's staged removal: A's history stays owner-correct, B sees none of it", async () => {
  const NOTE = `V12-NOTE-${run}`;
  const note = async (text: string) => {
    await Deno.mkdir(`${VAULT}/notes`, { recursive: true });
    await Deno.writeTextFile(`${VAULT}/notes/v12-${crypto.randomUUID().slice(0, 6)}.md`, text);
    await git("add", "-A");
    await git("-c", "user.name=Bnote", "-c", "user.email=b@notes.local", "commit", "-q", "-m", `note: ${text}`);
  };
  // 1. a staged move to the trash, swept
  const p1 = await docWith(A, `v12-move-${run}`, 3);
  const t1 = p1.replace(`/documents/`, `/documents/`).replace(/(documents\/[^/]+\/)/, `$1.trash/`);
  await Deno.mkdir(`${VAULT}/${t1.slice(0, t1.lastIndexOf("/"))}`, { recursive: true });
  await git("mv", p1, t1);
  await note(NOTE);
  const l1 = await versions(t1, A);
  assertEquals([l1.total, l1.current_version], [3, 3]);
  const c1 = await call("GET", `${D}/compare?path=${q(t1)}&from=1&to=3`);
  assertEquals(c1.status, 200, c1.text);
  assert(!(JSON.stringify(l1) + c1.text).includes(NOTE) && !(JSON.stringify(l1) + c1.text).includes("Bnote") && !c1.json.diff.includes("notes/"), "nothing of B's note in A's answers");
  // 2. A's unsaved text swept into B's commit: the version stays, its author and message are withheld
  const p2 = await docWith(A, `v12-unsaved-${run}`, 2);
  const put = await call("PUT", `${D}/file?path=${q(p2)}`, { content: `---\ntitle: u\n---\n\nV12-A-THIRD-${run}\n` });
  assertEquals(put.status, 200, put.text);
  await note(NOTE + "-2");
  const l2 = await versions(p2, A);
  assertEquals([l2.total, l2.unsaved_changes], [3, false]);
  const swept = l2.versions[0] as unknown as { version: number; author: string | null; message: string };
  assertEquals([swept.version, swept.author, swept.message], [3, null, ""]);
  const c2 = await call("GET", `${D}/compare?path=${q(p2)}&from=2&to=3`);
  assert(c2.json.diff.includes(`V12-A-THIRD-${run}`) && !c2.json.diff.includes("notes/") && !(JSON.stringify(l2) + c2.text).includes(NOTE));
  // 3. a staged removal, swept: gone for both
  const p3 = await docWith(A, `v12-rm-${run}`, 2);
  await git("rm", "--quiet", "--", p3);
  await note(NOTE + "-3");
  const g = [await call("GET", `${D}/versions?path=${q(p3)}`), await call("GET", `${D}/versions?path=${q(p3)}`, undefined, B)];
  assertEquals([g[0].status, g[0].text], [404, g[1].text === g[0].text ? g[0].text : "differs"]);
  // B reads every one of A's paths: the answer of a missing path
  const miss = await call("GET", `${D}/versions?path=${q(`documents/none-${run}/x.md`)}`, undefined, B);
  for (const target of [t1, p2, p3]) {
    for (const url of [`versions?path=${q(target)}`, `snapshots?path=${q(target)}`, `compare?path=${q(target)}&from=1&to=2`]) {
      const r = await call("GET", `${D}/${url}`, undefined, B);
      assertEquals([r.status, r.text], [miss.status, miss.text], url);
    }
  }
});

// V13 (attempt 2): the vault lock covers every documents writer. delete-folder racing creates by both owners over HTTP: no
// 500, no commit that carries two owners' files. And a move plus an edit that land in ONE commit (a note write's `git add -A`
// between `git mv` and the commit): the history survives (within the owner), the edit is a version, B's name is withheld.
t("V13: delete-folder racing creates by A and B: all succeed, no commit carries two owners' files; a move and an edit in one commit keep A's history", async () => {
  const base = (await git("rev-parse", "HEAD")).trim(); // earlier cases make mixed commits on purpose
  for (let round = 0; round < 6; round++) {
    const folder = `v13f-${run}-${round}`;
    assertEquals((await call("POST", `${D}/folders`, { path: folder })).status, 201);
    await newDoc(A, `v13-in-folder-${run}-${round}`, "in the folder", folder);
    const rs = await Promise.all([
      call("DELETE", `${D}/folders`, { path: folder }),
      ...[0, 1, 2, 3].map((i) => call("POST", D, { title: `v13-b-${run}-${round}-${i}`, body: "b" }, B)),
      ...[0, 1].map((i) => call("POST", D, { title: `v13-a-${run}-${round}-${i}`, body: "a" })),
    ]);
    assertEquals(rs.map((r) => r.status), [200, 201, 201, 201, 201, 201, 201], `round ${round}: ${rs.filter((r) => r.status >= 400).map((r) => r.text).join(" | ")}`);
  }
  const log = (await git("log", "--name-only", "--format=%x1e%H", `${base}..HEAD`)).split("\x1e").filter((b) => b.trim());
  for (const block of log) {
    const owners = new Set(block.split("\n").slice(1).filter((l) => l.startsWith("documents/")).map((l) => l.split("/")[1]));
    assert(owners.size <= 1, `a commit carries two owners' files: ${[...owners].join(",")}`);
  }
  // a move and an unsaved edit swept into one commit by a whole-tree writer
  const long = "a long enough paragraph so that git pairs the renamed file with its old self\n".repeat(8);
  const p = await newDoc(A, `v13-mvedit-${run}`, long);
  for (let i = 2; i <= 3; i++) await edit(p, `---\ntitle: m\n---\n\nrev ${i}\n${long}`);
  const t = p.replace(/(documents\/[^/]+\/)/, "$1.trash/");
  await Deno.mkdir(`${VAULT}/${t.slice(0, t.lastIndexOf("/"))}`, { recursive: true });
  await git("mv", p, t);
  await Deno.writeTextFile(`${VAULT}/${t}`, `---\ntitle: m\n---\n\nrev 4\n${long}`);
  await Deno.mkdir(`${VAULT}/notes`, { recursive: true });
  await Deno.writeTextFile(`${VAULT}/notes/v13-${run}.md`, "a note by B");
  await git("add", "-A");
  await git("-c", "user.name=Bnote", "-c", "user.email=b@notes.local", "commit", "-q", "-m", "note: a note by B");
  const l = await versions(t, A);
  assertEquals(l.total, 4, "the history survives a rename-with-edit and the edit is a version");
  const top = l.versions[0] as unknown as { author: string | null; message: string };
  assertEquals([top.author, top.message], [null, ""]);
});

t("V11b: A (4 versions) has a staged removal and B's create of BYTE-IDENTICAL text to A's current text land in one commit: B has one version, none of A's older text (the exact-bytes cross-owner pairing is never followed)", async () => {
  const title = `v11b-same-${run}`;
  const mark = `V11B-OLDER-${run}`;
  const aPath = await newDoc(A, title, "identical body");
  const v1 = await textOf(aPath);
  await edit(aPath, `---\ntitle: a\n---\n\n${mark} 2\n`);
  await edit(aPath, `---\ntitle: a\n---\n\n${mark} 3\n`);
  await edit(aPath, v1); // A's current text is v1's bytes again: B's create below is byte-identical to it
  assertEquals((await versions(aPath)).total, 4);
  const tp = (await call("POST", `${D}/trash`, { path: aPath })).json.trashed as string;
  const aText = await textOf(tp);
  await git("rm", "--quiet", "--", tp); // staged: the whole-index commit of B's create carries it
  const bPath = await newDoc(B, title, "identical body");
  assertEquals(await textOf(bPath), aText, "byte-identical text");
  await bSeesOnlyOwn(bPath, aText, mark, "byte-identical text, A with 4 versions");
});

// V14 (fix round 3): LEGACY files have no owner key, so every legacy document, legacy .trash/.archive file, note and wiki file
// shares one scope. A whole-tree commit holding A's removed legacy file (or a note) and B's restored legacy document, near-identical
// or byte-identical text, must not hand B A's versions or A's text through restore-version.
t("V14a: a sweep commit holds A's removed legacy document (or a note) and B's restored legacy document: B's versions stay B's, a restore never writes A's text", async () => {
  const bSub = B[SUB_HEADER];
  const SHARED = Array.from({ length: 10 }, (_, k) => `shared paragraph ${k} of a plan two people wrote word for word`).join("\n") + "\n";
  const fm = (title: string, b: string) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n${b}`;
  const commit = async (file: string, text: string, who: string) => {
    await Deno.mkdir(`${VAULT}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${VAULT}/${file}`, text);
    await git("add", "--", file);
    await git("-c", `user.name=${who}`, "-c", "user.email=x@l", "commit", "-q", "-m", `documents: edit ${file}`);
  };
  let n = 0;
  for (const src of [(id: string) => `documents/v14a-${run}-${id}.md`, (id: string) => `notes/v14-${run}/${id}.md`]) {
    for (const kind of ["near", "exact"] as const) {
      const id = `${++n}${kind}`;
      const older = `V14-OLDER-A-${run}-${id}`;
      const la = src(id);
      for (const [k, txt] of [[1, `${older} 1\n` + SHARED], [2, `${older} 2\n` + SHARED], [3, SHARED + `${older}-FINAL\n`]] as const) await commit(la, fm("L", txt), `a-${k}`);
      const lbT = `documents/.trash/v14b-${run}-${id}.md`, lb = `documents/v14b-${run}-${id}.md`;
      for (const k of [1, 2]) await commit(lbT, fm("B", `B-OWN-${k}\n`), bSub);
      await sql(`INSERT INTO public.user_document_listings (path, title, owner_sub, actor_sub) VALUES ($1, 'B', $2, $2)`, [lb, bSub]);
      await git("mv", lbT, lb); // B's restore, staged
      await Deno.writeTextFile(`${VAULT}/${lb}`, fm("L", SHARED + (kind === "exact" ? `${older}-FINAL\n` : `${older}-FINAL-B\n`)));
      await git("rm", "-q", "--", la); // A's removal, staged
      await git("add", "-A");
      await git("-c", "user.name=wiki-compile", "-c", "user.email=w@l", "commit", "-q", "-m", "wiki compile (timer)");
      const l = await call("GET", `${D}/versions?path=${q(lb)}`, undefined, B);
      assertEquals(l.status, 200, l.text);
      assert(!l.text.includes(older) && !l.text.includes(la), `${id}: nothing of the other file in B's list`);
      for (const vv of l.json.versions as { version: number }[]) {
        const rr = await call("POST", `${D}/restore-version`, { path: lb, version: vv.version }, B);
        assertEquals(rr.status, 200, rr.text);
        const now = await textOf(lb);
        assert(!now.includes(`${older} 1`) && !now.includes(`${older} 2`), `${id}: v${vv.version} restore wrote the other file's older text`);
      }
    }
  }
});

// V14b (fix round 3, the residual): the SAME file name for two owners. A's legacy document is trashed by the app (a `documents: trash`
// move) and removed for good; B's NEW legacy document at the same live name lands in the same whole-tree commit. git pairs A's removed
// .trash file with B's new file (R100 for identical text, a similarity rename for near-identical): B must start at its own v1.
t("V14b: A's hard-deleted legacy .trash file and B's new legacy file of the SAME name in one sweep: B has one version, a restore never writes A's text", async () => {
  const bSub = B[SUB_HEADER];
  const SHARED = Array.from({ length: 10 }, (_, k) => `shared paragraph ${k} of a plan two people wrote word for word`).join("\n") + "\n";
  const fm = (title: string, b: string) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n${b}`;
  const commit = async (file: string, text: string, msg: string) => {
    await Deno.mkdir(`${VAULT}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${VAULT}/${file}`, text);
    await git("add", "--", file);
    await git("-c", "user.name=a-user", "-c", "user.email=a@l", "commit", "-q", "-m", msg);
  };
  for (const kind of ["exact", "near"] as const) {
    const older = `V14B-OLDER-A-${run}-${kind}`;
    const live = `documents/v14s-${run}-${kind}.md`, trash = `documents/.trash/v14s-${run}-${kind}.md`;
    for (const k of [1, 2]) await commit(live, fm("S", `${older} ${k}\n` + SHARED), `documents: edit ${live}`);
    await commit(live, fm("S", SHARED + `${older}-FINAL\n`), `documents: edit ${live}`);
    await Deno.mkdir(`${VAULT}/documents/.trash`, { recursive: true });
    await git("mv", live, trash);
    await git("-c", "user.name=a-user", "-c", "user.email=a@l", "commit", "-q", "-m", `documents: trash ${live}`);
    await git("rm", "-q", "--", trash); // A's delete forever, staged
    await Deno.writeTextFile(`${VAULT}/${live}`, fm("S", SHARED + (kind === "exact" ? `${older}-FINAL\n` : `${older}-FINAL-B\n`))); // B's new file
    await sql(`INSERT INTO public.user_document_listings (path, title, owner_sub, actor_sub) VALUES ($1, 'S', $2, $2)`, [live, bSub]);
    await git("add", "-A");
    await git("-c", "user.name=wiki-compile", "-c", "user.email=w@l", "commit", "-q", "-m", "wiki compile (timer)");
    const l = await call("GET", `${D}/versions?path=${q(live)}`, undefined, B);
    assertEquals(l.status, 200, l.text);
    assertEquals([kind, l.json.total], [kind, 1], "B starts at its own v1");
    assert(!l.text.includes(older), "nothing of A's text in B's list");
    const rr = await call("POST", `${D}/restore-version`, { path: live, version: 1 }, B);
    assertEquals(rr.status, 200, rr.text);
    assert(!(await textOf(live)).includes(`${older} 1`), "a restore never writes A's older text");
  }
});

// ── fix round 4 (attempt 4 FAIL): the app's OWN move commit carried B's staged file ───────────────────────────────────────────
// FROZEN RULE: a legacy (scope '') pairing is followed ONLY when the commit provably holds nothing but that one move: (1) every
// app move commit is limited to its own two paths (gitMv: git commit --only), (2) the subject is the app's and `to` is the
// destination its verb implies, (3) whole-tree sweepers' pairings are never followed. H15 / H15b are the tester's cases; V15 guards (1),
// V17 guards (2), V14b guards (3), V16 guards sameOwnerMove (the names must match).
// A's OLDER versions carry `<older> 1` / `<older> 2`; B's own text may equal A's CURRENT text, which holds `<older>` too, so only those lines are A's history
const hasOld = (text: string, older: string) => text.includes(`${older} 1`) || text.includes(`${older} 2`);
const SHARED4 = Array.from({ length: 10 }, (_, k) => `shared paragraph ${k} of a plan two people wrote word for word`).join("\n") + "\n";
const fm4 = (title: string, b: string) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n${b}`;
async function aSub4(): Promise<string> {
  const p = await newDoc(A, `v15-who-${run}-${crypto.randomUUID().slice(0, 4)}`, "who");
  return (await sql<{ owner_sub: string }>(`SELECT owner_sub FROM public.user_document_listings WHERE path = $1`, [p]))[0].owner_sub;
}
async function aCommits(file: string, older: string, aSub: string) {
  for (const txt of [fm4("L", `${older} 1\n` + SHARED4), fm4("L", `${older} 2\n` + SHARED4), fm4("L", SHARED4 + `CURRENT-${older}\n`)]) {
    await Deno.mkdir(`${VAULT}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    await Deno.writeTextFile(`${VAULT}/${file}`, txt);
    await git("add", "--", file);
    await git("-c", `user.name=${aSub}`, "-c", "user.email=a@l", "commit", "-q", "-m", `documents: edit ${file}`);
  }
}
const listRow4 = (path: string, title: string, owner: string) =>
  sql(`INSERT INTO public.user_document_listings (path, title, owner_sub, actor_sub) VALUES ($1, $2, $3, $3)`, [path, title, owner]);
const headFiles4 = async () => (await git("show", "--name-only", "--no-renames", "--format=", "HEAD")).trim().split("\n").filter(Boolean).sort();
const stagedFiles4 = async () => (await git("diff", "--cached", "--name-only")).trim().split("\n").filter(Boolean);

t("H15: A's own legacy trash commit (POST /trash) with B's staged byte-identical legacy file of the same name: the commit holds only A's two paths, and B never gets A's history", async () => {
  const aSub = await aSub4();
  for (const form of ["exact", "a-unsaved-edit"] as const) {
    const id = `h15-${form}`;
    const older = `OLDER-A-${run}-${id}`;
    const la = `documents/lgh15-${run}-${id}.md`, laT = `documents/.trash/lgh15-${run}-${id}.md`, lbA = `documents/.archive/lgh15-${run}-${id}.md`;
    await aCommits(la, older, aSub);
    await listRow4(la, "L", aSub);
    await listRow4(lbA, "B", B[SUB_HEADER]);
    const cur = await Deno.readTextFile(`${VAULT}/${la}`);
    const pb = await call("PUT", `${D}/file?path=${q(lbA)}`, { content: cur }, B); // B's autosave, then staged as an unlocked `git add -A` would
    assert(pb.status === 200 || pb.status === 207, pb.text);
    await git("add", "--", lbA);
    if (form === "a-unsaved-edit") assert([200, 207].includes((await call("PUT", `${D}/file?path=${q(la)}`, { content: cur + "A's unsaved line\n" })).status));
    const tr = await call("POST", `${D}/trash`, { path: la });
    assertEquals(tr.status, 200, tr.text);
    assertEquals(await headFiles4(), [la, laT].sort(), `${form}: the trash commit holds only A's two paths`);
    assert((await stagedFiles4()).includes(lbA), `${form}: B's file is still staged, not committed`);
    const l = await call("GET", `${D}/versions?path=${q(lbA)}`, undefined, B);
    assertEquals(l.status, 200, l.text);
    assert((l.json.total ?? 0) <= 1 && !hasOld(l.text, older) && !l.text.includes(la), `${form}: B's list: ${l.text.slice(0, 200)}`);
    for (const vv of l.json.versions as { version: number }[]) {
      const c = await call("GET", `${D}/compare?path=${q(lbA)}&from=${vv.version}&to=${l.json.current_version}`, undefined, B);
      assert(!hasOld(c.text, older), `${form}: B's compare carries A's older text`);
      await call("POST", `${D}/restore-version`, { path: lbA, version: vv.version }, B);
      assert(!hasOld((await textOf(lbA)), older), `${form}: B's restore wrote A's older text`);
    }
  }
});

t("H15b: the H15 shape, then B unarchives its own document and restores v1: B's file never holds A's older text", async () => {
  const aSub = await aSub4();
  const id = "h15b";
  const older = `OLDER-A-${run}-${id}`;
  const la = `documents/lgh15b-${run}.md`, lbA = `documents/.archive/lgh15b-${run}.md`;
  await aCommits(la, older, aSub);
  await listRow4(la, "L", aSub);
  await listRow4(lbA, "B", B[SUB_HEADER]);
  const cur = await Deno.readTextFile(`${VAULT}/${la}`);
  assert([200, 207].includes((await call("PUT", `${D}/file?path=${q(lbA)}`, { content: cur }, B)).status));
  await git("add", "--", lbA);
  assertEquals((await call("POST", `${D}/trash`, { path: la })).status, 200);
  const ua = await call("POST", `${D}/restore`, { path: lbA }, B); // B's own unarchive of a file that was only ever staged
  assertEquals(ua.status, 200, ua.text);
  const live = String(ua.json.restored ?? ua.json.unarchived ?? "");
  assertEquals(live, la.replace("documents/", "documents/"), "B's file is back at its live path");
  const l = await call("GET", `${D}/versions?path=${q(live)}`, undefined, B);
  assertEquals([l.status, l.json.total], [200, 1], l.text);
  const rv = await call("POST", `${D}/restore-version`, { path: live, version: 1 }, B);
  assertEquals(rv.status, 200, rv.text);
  assert(!hasOld((await textOf(live)), older), "B's file never holds A's older text");
});

t("V15: every app move commit (trash, archive, restore, unarchive) holds only its own two paths: a file anyone else staged stays staged", async () => {
  const aSub = await aSub4();
  const f = `documents/v15-${run}.md`;
  await aCommits(f, `OLDER-A-${run}-v15`, aSub);
  await listRow4(f, "L", aSub);
  const steps: [string, string, string][] = [["trash", f, `documents/.trash/v15-${run}.md`], ["restore", `documents/.trash/v15-${run}.md`, f],
    ["archive", f, `documents/.archive/v15-${run}.md`], ["restore", `documents/.archive/v15-${run}.md`, f]];
  let i = 0;
  for (const [verb, from, to] of steps) {
    const foreign = `notes/v15-${run}-${++i}.md`; // staged by someone else (a note write's add -A) before the move
    await Deno.mkdir(`${VAULT}/notes`, { recursive: true });
    await Deno.writeTextFile(`${VAULT}/${foreign}`, `someone else's staged note ${i}\n`);
    await git("add", "--", foreign);
    const r = await call("POST", `${D}/${verb}`, { path: from });
    assertEquals(r.status, 200, r.text);
    assertEquals(await headFiles4(), [from, to].sort(), `${verb}: the move commit holds only its own paths`);
    assert((await stagedFiles4()).includes(foreign), `${verb}: the foreign staged file stays staged`);
    await git("-c", "user.name=notes", "-c", "user.email=n@l", "commit", "-q", "-m", "notes: write"); // the sweeper's own commit
  }
  assertEquals((await call("GET", `${D}/versions?path=${q(f)}`)).json.total, 3, "A's history followed A's own moves");
});

// A commit the move limit cannot protect: a hand-made whole-tree commit that imitates the app's subject. The destination the verb
// implies is what binds it (V17); legacy names that differ never pair (V16).
t("V16: a hand-made commit with the app's `move` subject that removes A's legacy file and adds B's legacy file of ANOTHER name: not a move", async () => {
  const aSub = await aSub4();
  for (const kind of ["exact", "near"] as const) {
    const older = `OLDER-A-${run}-v16-${kind}`;
    const x = `documents/v16a-${run}-${kind}.md`, y = `documents/v16b-${run}-${kind}.md`;
    await aCommits(x, older, aSub);
    await listRow4(y, "B", B[SUB_HEADER]);
    const cur = await Deno.readTextFile(`${VAULT}/${x}`);
    await git("rm", "-q", "--", x);
    await Deno.writeTextFile(`${VAULT}/${y}`, kind === "exact" ? cur : cur.replace("CURRENT-", "CURRENT2-"));
    await git("add", "-A");
    await git("-c", "user.name=Alice", "-c", "user.email=a@l", "commit", "-q", "-m", `documents: move ${x} -> ${y}`);
    const l = await call("GET", `${D}/versions?path=${q(y)}`, undefined, B);
    assertEquals([l.status, l.json.total], [200, 1], `${kind}: ${l.text}`);
    assert(!hasOld(l.text, older), `${kind}: nothing of A's text`);
    await call("POST", `${D}/restore-version`, { path: y, version: 1 }, B);
    assert(!hasOld((await textOf(y)), older), `${kind}: a restore never writes A's older text`);
  }
});

t("V17: a hand-made commit with the app's `trash` subject that holds A's trash AND B's staged copy at another state: git pairs `from` with B's path, the `to` the verb implies refuses it", async () => {
  const aSub = await aSub4();
  const older = `OLDER-A-${run}-v17`;
  const la = `documents/v17-${run}.md`, laT = `documents/.trash/v17-${run}.md`, lbA = `documents/.archive/v17-${run}.md`;
  await aCommits(la, older, aSub);
  await listRow4(laT, "L", aSub);
  await listRow4(lbA, "B", B[SUB_HEADER]);
  const cur = await Deno.readTextFile(`${VAULT}/${la}`);
  await Deno.mkdir(`${VAULT}/documents/.trash`, { recursive: true });
  await Deno.mkdir(`${VAULT}/documents/.archive`, { recursive: true });
  await git("mv", la, laT);
  await Deno.writeTextFile(`${VAULT}/${laT}`, cur + "A's unsaved line\n");
  await Deno.writeTextFile(`${VAULT}/${lbA}`, cur);
  await git("add", "-A");
  await git("-c", "user.name=Alice", "-c", "user.email=a@l", "commit", "-q", "-m", `documents: trash ${la}`);
  const raw = (await git("diff-tree", "-r", "-M", "--name-status", "--no-commit-id", "HEAD")).replaceAll("\t", " ");
  assert(raw.includes(`${la} ${lbA}`), `git paired A's from with B's path: ${raw}`);
  const l = await call("GET", `${D}/versions?path=${q(lbA)}`, undefined, B);
  assertEquals([l.status, l.json.total], [200, 1], l.text);
  assert(!hasOld(l.text, older) && !l.text.includes(la), "nothing of A's history in B's list");
  await call("POST", `${D}/restore-version`, { path: lbA, version: 1 }, B);
  assert(!hasOld((await textOf(lbA)), older), "a restore never writes A's older text");
});

// V14 (attempt 5, the tester's H16 adopted): a keyed document with UNSAVED autosave text - a small edit and a full rewrite -
// moved, trashed and archived through the API keeps v1..v3 (numbers and commits), gains no version, and the unsaved text stays
// unsaved (the app's move commits the staged rename only); restore and unarchive keep the numbers too.
t("V14: keyed document with unsaved text (small edit / full rewrite), then move / trash / archive and back: v1..v3 keep their numbers, the text stays unsaved", async () => {
  const bigT = (tag: string) => Array.from({ length: 14 }, (_, i) => `line ${i} of a document long enough for git to pair it ${tag}`).join("\n") + "\n";
  const rewriteT = (tag: string) => Array.from({ length: 14 }, (_, i) => `completely new sentence ${i * 7} written over the old one ${tag} zz`).join("\n") + "\n";
  const fm = (t: string, text: string) => `---\ntitle: ${JSON.stringify(t)}\n---\n\n${text}`;
  const key = (l: Awaited<ReturnType<typeof versions>>) => JSON.stringify(l.versions.map((x) => [x.version, x.commit]));
  for (const verb of ["move", "trash", "archive"] as const) {
    for (const kind of ["small", "rewrite"] as const) {
      const p = await newDoc(A, `v14-${verb}-${kind}-${run}`, bigT("v1"));
      await edit(p, fm("v14", bigT("v2")));
      await edit(p, fm("v14", bigT("v3")));
      const before = key(await versions(p));
      const unsaved = fm("v14", kind === "small" ? bigT("v3") + "one unsaved line\n" : rewriteT(verb));
      const pu = await call("PUT", `${D}/file?path=${q(p)}`, { content: unsaved }); // an autosave: no commit
      assertEquals(pu.status, 200, pu.text);
      const r = verb === "move" ? await call("POST", `${D}/move`, { from: p, to_folder: `v14-${run}-${verb}-${kind}` }) : await call("POST", `${D}/${verb}`, { path: p });
      assertEquals(r.status, 200, r.text);
      const at = String(verb === "move" ? r.json.to : verb === "trash" ? r.json.trashed : r.json.archived);
      const after = await versions(at);
      assertEquals(key(after), before, `${verb}/${kind}: v1..v3 keep their numbers and commits, no version was added`);
      assertEquals(after.unsaved_changes, true, "the unsaved text is still unsaved");
      assertEquals(await textOf(at), unsaved, "and still on disk");
      if (verb !== "move") {
        const back = await call("POST", `${D}/${verb === "trash" ? "restore" : "unarchive"}`, { path: at });
        assertEquals(back.status, 200, back.text);
        const bp = String(back.json.restored ?? back.json.unarchived);
        assertEquals(key(await versions(bp)), before, `${verb}/${kind}: and back`);
        assertEquals(await textOf(bp), unsaved);
      }
    }
  }
});

// V18 (attempt 6, the tester's H20 adapted): the CAS window over HTTP. A's keyed document with unsaved text is trashed / moved (under
// the documents lock) while B moves its own notes (POST /workbench/notes/move -> moveNote -> gitMv, NOT under the vault lock): a
// note-move commit can land inside A's window and make A's `update-ref HEAD <new> <old>` refuse. The move is then retried on the new
// HEAD; it never falls back to a path commit of the on-disk text. Checked: no commit lost, none mixed, A keeps v1..v3, A gains no
// version, the unsaved text stays unsaved; and if A's move ever answers 5xx it was undone (the document is where it was).
for (const kind of ["rewrite", "small"] as const) {
  t(`V18 CAS window: A's keyed trash/move with an unsaved ${kind} edit racing B's unlocked note moves`, async () => {
    const bigT = (tag: string) => Array.from({ length: 14 }, (_, i) => `line ${i} of a document long enough for git to pair it ${tag}`).join("\n") + "\n";
    const rewriteT = (tag: string) => Array.from({ length: 14 }, (_, i) => `completely new sentence ${i * 7} written over the old one ${tag} zz`).join("\n") + "\n";
    const fm = (t: string, text: string) => `---\ntitle: ${JSON.stringify(t)}\n---\n\n${text}`;
    const key = (l: Awaited<ReturnType<typeof versions>>) => l.versions.map((x) => x.commit);
    let a5 = 0;
    for (let i = 0; i < 6; i++) {
      const verb = i % 2 ? "move" : "trash";
      const p = await newDoc(A, `v18 ${run} ${kind} ${i}`, bigT("v1"));
      await edit(p, fm("v18", bigT(`v2-${i}`)));
      await edit(p, fm("v18", bigT(`v3-${i}`)));
      const before = key(await versions(p));
      const bNotes: string[] = [];
      for (let k = 0; k < 4; k++) {
        const from = `v18in${run}/n-${kind}-${i}-${k}.md`;
        const w = await call("PUT", `/workbench/notes/${from}?commit=1`, { content: `---\ntitle: v18\n---\n\nB note ${i} ${k}\n` }, B);
        assertEquals(w.status, 200, w.text);
        bNotes.push(from);
      }
      const unsaved = fm("v18", kind === "small" ? bigT(`v3-${i}`) + "one unsaved line\n" : rewriteT(`v18-${i}`));
      const pu = await call("PUT", `${D}/file?path=${q(p)}`, { content: unsaved }); // an autosave
      assertEquals(pu.status, 200, pu.text);
      const h0 = (await git("rev-parse", "HEAD")).trim();
      const aCall = verb === "move" ? call("POST", `${D}/move`, { from: p, to_folder: `v18-${kind}-${i}` }) : call("POST", `${D}/trash`, { path: p });
      const bCalls = bNotes.map((from, k) => new Promise((r) => setTimeout(r, k * 4 + (i % 3) * 2)).then(() => call("POST", "/workbench/notes/move", { from, to_folder: `v18out${run}` }, B)));
      const [ra, ...rb] = await Promise.all([aCall, ...bCalls]);
      const subjects = (await git("log", "--format=%H\t%s", `${h0}..HEAD`)).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
      for (let k = 0; k < bNotes.length; k++) {
        if (rb[k].status === 200) assert(subjects.some(([, s]) => s.startsWith(`notes: move notes/${bNotes[k]} `)), `round ${i}: B's note move ${k} answered 200 but its commit is not on the branch (lost)`);
      }
      const aC = subjects.filter(([, s]) => /^documents: (trash|move) /.test(s)).map(([h]) => h);
      if (ra.status === 200) {
        assertEquals(aC.length, 1, `round ${i}: A's ${verb} answered 200: exactly one move commit`);
        const at = String(verb === "move" ? ra.json.to : ra.json.trashed);
        const names = (await git("diff-tree", "--root", "-r", "-z", "--no-renames", "--name-only", "--no-commit-id", aC[0])).split("\0").filter(Boolean);
        assertEquals(names.sort(), [p, at].sort(), `round ${i}: A's commit holds only A's two paths`);
        assertEquals((await git("diff-tree", "-r", "-M", "--name-status", "--no-commit-id", aC[0])).trim().split("\t")[0], "R100", `round ${i}: a pure rename`);
        const after = await versions(at);
        assertEquals(key(after), before, `round ${i}: v1..v3 kept, no version added`);
        assertEquals(after.unsaved_changes, true);
        assertEquals(await textOf(at), unsaved);
      } else {
        a5++;
        assertEquals(aC.length, 0, `round ${i}: A's move failed (${ra.status}): it committed nothing`);
        assertEquals(await textOf(p), unsaved, "and was undone: the document is where it was, with its unsaved text");
        assertEquals(key(await versions(p)), before);
      }
      for (const [h, s] of subjects.filter(([, s]) => s.startsWith("notes: move "))) {
        const names = (await git("diff-tree", "--root", "-r", "-z", "--no-renames", "--name-only", "--no-commit-id", h)).split("\0").filter(Boolean);
        assert(names.length === 2 && names.every((n) => n.startsWith("notes/")), `round ${i}: B's "${s}" holds only B's note paths`);
      }
      await git("add", "-A");
      await git("-c", "user.name=t", "-c", "user.email=t@l", "commit", "-q", "--allow-empty", "-m", "v18: clear");
    }
    console.log(`V18 ${kind}: A answered 5xx (undone) in ${a5} of 6 rounds`);
  });
}
