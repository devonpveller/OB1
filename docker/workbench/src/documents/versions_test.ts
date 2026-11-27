// deno test -A src/documents/versions_test.ts - rwr-doc-versions-api, no database and no server: a REAL git vault in a
// temp directory and an in-memory stand-in for the snapshots table. The numbering (a move, a trash and a restore never
// shift a number; a rename that edited the text is one version), restore ("Before restoring vN", then the old text as
// a new version), compare (git's own diff), and the two-identity rules (another user's row answers exactly like a
// missing one, before anything about versions or snapshots is read).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const vault = await Deno.makeTempDir({ prefix: "versions-vault-" });
Deno.env.set("WIKI_GIT_DIR", vault);
const git = async (...a: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", vault, ...a], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout);
};
await git("init", "-q");
await git("config", "user.email", "t@lab.local");
await git("config", "user.name", "lab");
const v = await import("./versions.ts");
const { movedAsTheAppDoes } = v;
const vlt = { ...(await import("../util/vault.ts")), ...(await import("../util/vault_versions.ts")) };
const { DocError } = await import("./repo.ts");

// the identities (the seam's shape)
const A = { sub: "user-a", actor: "user-a", name: "Alice", key: "user-a" };
const B = { sub: "user-b", actor: "user-b", name: "Bob", key: "user-b" };

// the snapshots table, in memory; every statement the module sends is logged
interface Snap { id: string; owner_sub: string; actor_sub: string; commit_hash: string; blob_hash: string; name: string; kind: string; created_at: string }
const snaps: Snap[] = [];
// the listing / trail rows a test plants: path -> owner_sub; `lookupFails` makes both lookups throw
const listingRows = new Map<string, string>();
const trailRows = new Map<string, string>();
let lookupFails = false;
const log: string[] = [];
let n = 0;
// deno-lint-ignore no-explicit-any
const db: any = {
  query: (sql: string, a: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    if (/INSERT INTO public\.document_snapshots/.test(sql)) {
      const row: Snap = {
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, owner_sub: a[0] as string, actor_sub: a[1] as string,
        commit_hash: a[2] as string, blob_hash: a[3] as string, name: a[4] as string, kind: a[5] as string,
        created_at: new Date(Date.UTC(2026, 10, 25, 0, 0, n)).toISOString(),
      };
      snaps.push(row);
      return Promise.resolve([row]);
    }
    if (/FROM public\.document_snapshots WHERE owner_sub = \$1 AND commit_hash = ANY/.test(sql)) {
      return Promise.resolve(snaps.filter((s) => s.owner_sub === a[0] && (a[1] as string[]).includes(s.commit_hash)));
    }
    if (/FROM public\.document_snapshots WHERE id = \$1::uuid/.test(sql)) {
      // the owner condition is applied only if the statement carries it (a mutation that drops it must be seen)
      return Promise.resolve(snaps.filter((s) => s.id === a[0] && (!/owner_sub = \$2/.test(sql) || s.owner_sub === a[1])));
    }
    if (/FROM public\.user_document_(listings|trail) WHERE path = \$1/.test(sql)) {
      if (lookupFails) return Promise.reject(new Error("lookup failed"));
      const m = /user_document_listings/.test(sql) ? listingRows : trailRows;
      return Promise.resolve(m.has(a[0] as string) ? [{ owner_sub: m.get(a[0] as string) }] : []);
    }
    return Promise.resolve([]); // no listing rows: an unlisted file is the caller's when it sits in their directory
  },
  tx: (fn: (d: unknown) => unknown) => fn(db),
};
const deps = { db, reg: {} as never };
const snapQueries = () => log.filter((l) => /document_snapshots/.test(l)).length;

async function put(rel: string, text: string, msg: string, who = A) {
  await vlt.vaultWrite(rel, text);
  await vlt.vaultCommitPath(rel, msg, who.name);
}
const body = (n: number) => `---\ntitle: "T"\n---\n\nline ${n}\n`;
let doc = 0;
const newPath = (who = A) => `documents/${who.key}/doc-${++doc}.md`;

Deno.test("numbering: v1 is the creating commit; each text change is the next number; a save that changed nothing is none", async () => {
  const p = newPath();
  for (let i = 1; i <= 3; i++) await put(p, body(i), `documents: edit ${p}`);
  await put(p, body(3), "same text again"); // nothing to commit
  assertEquals((await v.versionsOf(p)).map((x) => x.version), [1, 2, 3]);
  const l = await v.listVersions(deps, p, A);
  assertEquals([l.current_version, l.total, l.unsaved_changes, l.next], [3, 3, false, null]);
  assertEquals(l.versions.map((x) => x.version), [3, 2, 1], "newest first");
});

Deno.test("numbering: a move, a trash, a restore and an archive leave every number and the count where they were", async () => {
  const p = newPath();
  for (let i = 1; i <= 4; i++) await put(p, body(i), `documents: edit ${p}`);
  const before = (await v.versionsOf(p)).map((x) => [x.version, x.blob]);
  const moved = `documents/${A.key}/folder/${p.split("/").pop()}`;
  await vlt.gitMv(p, moved, "documents: move", A.name);
  const trashed = `documents/${A.key}/.trash/folder/${p.split("/").pop()}`;
  await vlt.gitMv(moved, trashed, "documents: trash", A.name);
  assertEquals((await v.versionsOf(trashed)).map((x) => [x.version, x.blob]), before, "in the trash");
  await vlt.gitMv(trashed, moved, "documents: restore", A.name);
  const archived = `documents/${A.key}/.archive/folder/${p.split("/").pop()}`;
  await vlt.gitMv(moved, archived, "documents: archive", A.name);
  await vlt.gitMv(archived, p, "documents: unarchive", A.name);
  assertEquals((await v.versionsOf(p)).map((x) => [x.version, x.blob]), before, "back where it began");
  // an edit after all that is the next number
  await put(p, body(5), `documents: edit ${p}`);
  assertEquals((await v.versionsOf(p)).length, 5);
});

Deno.test("numbering: a rename that also edited the text is one version; the number of an older version is unchanged", async () => {
  const p = newPath();
  await put(p, body(1) + "a long enough paragraph so git sees one file renamed, not a delete and an add\n".repeat(6), "create");
  await put(p, body(2) + "a long enough paragraph so git sees one file renamed, not a delete and an add\n".repeat(6), "edit");
  const to = `documents/${A.key}/renamed-${doc}.md`;
  await vlt.gitMv(p, to, "rename", A.name);
  await vlt.vaultWrite(to, body(3) + "a long enough paragraph so git sees one file renamed, not a delete and an add\n".repeat(6));
  await vlt.vaultCommitPath(to, "edit after rename", A.name);
  const vs = await v.versionsOf(to);
  assertEquals(vs.map((x) => x.version), [1, 2, 3]);
  assertEquals(vs[0].path, p, "v1 remembers the path it was made under");
});

Deno.test("numbering: a document deleted for good and written again at the same path starts again at v1", async () => {
  const p = newPath();
  await put(p, body(1), "create");
  await put(p, body(2), "edit");
  await vlt.gitRm(p, "documents: remove for good", A.name);
  await put(p, body(9), "a new document with the old name");
  assertEquals((await v.versionsOf(p)).map((x) => x.version), [1]);
});

Deno.test("two documents with the same text do not share versions or snapshots", async () => {
  const p1 = newPath();
  const p2 = newPath();
  await put(p1, body(1), "one");
  await put(p2, body(1), "two");
  const s = await v.createSnapshot(deps, { path: p1, name: "mine" }, A);
  assertEquals(s.snapshot.version, 1);
  assertEquals((await v.listSnapshots(deps, p1, A)).total, 1);
  assertEquals((await v.listSnapshots(deps, p2, A)).total, 0);
});

Deno.test("restore: v11 at v14 makes v15 and a snapshot at v14; restoring that snapshot brings v14's text back as v16", async () => {
  const p = newPath();
  for (let i = 1; i <= 14; i++) await put(p, body(i), `documents: edit ${p}`);
  const v14 = await vlt.vaultRead(p);
  const out = await v.restoreVersion(deps, { path: p, version: 11 }, A);
  assertEquals([out.restored, out.from_version, out.version], [true, 11, 15]);
  assertEquals(out.snapshot?.name, "Before restoring v11");
  assertEquals([out.snapshot?.version, out.snapshot?.kind], [14, "before_restore"]);
  assertEquals(await vlt.vaultRead(p), body(11));
  const l = await v.listVersions(deps, p, A);
  assertEquals(l.total, 15);
  assertEquals(l.versions[0].snapshots, [], "v15 carries none");
  assertEquals(l.versions[1].snapshots.map((s) => s.name), ["Before restoring v11"], "v14 carries it");
  const back = await v.restoreVersion(deps, { path: p, snapshot_id: out.snapshot!.id }, A);
  assertEquals([back.restored, back.from_version, back.version], [true, 14, 16]);
  assertEquals(await vlt.vaultRead(p), v14);
  assertEquals((await v.listVersions(deps, p, A)).versions[1].snapshots.map((s) => s.name), ["Before restoring v14"], "v15 now carries the second marker");
  // the history only ever grew: every older version is still its own text
  for (const i of [1, 5, 11, 14]) assertEquals(await vlt.vaultBlob((await v.versionsOf(p))[i - 1].blob), body(i));
});

Deno.test("restore: of the text the document already has changes nothing (no version, no marker)", async () => {
  const p = newPath();
  for (let i = 1; i <= 3; i++) await put(p, body(i), "edit");
  const marks = snaps.length;
  const out = await v.restoreVersion(deps, { path: p, version: 3 }, A);
  assertEquals([out.restored, out.unchanged, out.version, out.snapshot], [false, true, 3, null]);
  assertEquals(snaps.length, marks);
  assertEquals((await v.versionsOf(p)).length, 3);
});

Deno.test("restore: text saved but not yet committed becomes a version first, and the marker is on it", async () => {
  const p = newPath();
  for (let i = 1; i <= 2; i++) await put(p, body(i), "edit");
  await vlt.vaultWrite(p, "unsaved text\n"); // a save without commit
  const l0 = await v.listVersions(deps, p, A);
  assertEquals([l0.total, l0.unsaved_changes], [2, true]);
  const out = await v.restoreVersion(deps, { path: p, version: 1 }, A);
  assertEquals([out.version, out.snapshot?.version], [4, 3], "v3 = the unsaved text, v4 = the restore");
  const vs = await v.versionsOf(p);
  assertEquals(await vlt.vaultBlob(vs[2].blob), "unsaved text\n");
});

Deno.test("restore: a trashed document is not restored in place; a bad request names nothing it was given", async () => {
  const p = newPath();
  await put(p, body(1), "edit");
  await put(p, body(2), "edit");
  const t = `documents/${A.key}/.trash/${p.split("/").pop()}`;
  await vlt.gitMv(p, t, "trash", A.name);
  await assertRejects(() => v.restoreVersion(deps, { path: t, version: 1 }, A), DocError, "put the document back");
  await vlt.gitMv(t, p, "restore", A.name);
  for (const input of [{ path: p }, { path: p, version: 1, snapshot_id: "x" }]) {
    await assertRejects(() => v.restoreVersion(deps, input, A), DocError, "not both and not neither");
  }
  await assertRejects(() => v.restoreVersion(deps, { path: p, version: 99 }, A), DocError, "no such version");
  await assertRejects(() => v.restoreVersion(deps, { path: p, version: "1; drop" }, A), DocError, "whole number");
});

Deno.test("compare: the diff is exactly git diff of the two commits on the vault file", async () => {
  const p = newPath();
  for (let i = 1; i <= 4; i++) await put(p, body(i) + `extra ${i}\n`, "edit");
  const vs = await v.versionsOf(p);
  const out = await v.compareVersions(deps, p, 1, 4, A);
  assertEquals(out.diff, await git("diff", vs[0].commit, vs[3].commit, "--", p));
  assert(out.diff.includes("-line 1") && out.diff.includes("+line 4"));
  assertEquals([out.added, out.removed, out.identical], [2, 2, false]);
  assertEquals((await v.compareVersions(deps, p, 2, 2, A)).diff, "");
  assertEquals((await v.compareVersions(deps, p, 3, 1, A)).diff, await git("diff", vs[2].commit, vs[0].commit, "--", p), "either order");
  // after a move the two commits are still compared as the same document
  const moved = `documents/${A.key}/m/${p.split("/").pop()}`;
  await vlt.gitMv(p, moved, "move", A.name);
  await put(moved, body(5), "edit after move");
  const vs2 = await v.versionsOf(moved);
  const across = await v.compareVersions(deps, moved, 1, 5, A);
  assertEquals(across.diff, await git("diff", `${vs2[0].commit}:${vs2[0].path}`, `${vs2[4].commit}:${vs2[4].path}`));
  assert(across.diff.includes("line 5"));
  await assertRejects(() => v.compareVersions(deps, moved, 1, 9, A), DocError, "no such version");
});

Deno.test("paging: `before` walks the versions newest first and `next` ends at null", async () => {
  const p = newPath();
  for (let i = 1; i <= 7; i++) await put(p, body(i), "edit");
  const seen: number[] = [];
  let before: number | null = null;
  for (let page = 0; page < 5; page++) {
    const l = await v.listVersions(deps, p, A, { limit: 3, before });
    seen.push(...l.versions.map((x) => x.version));
    if (l.next == null) break;
    before = l.next;
  }
  assertEquals(seen, [7, 6, 5, 4, 3, 2, 1]);
});

Deno.test("snapshot: a name is trimmed, 1 to 120 characters, no control characters; the version must exist", async () => {
  const p = newPath();
  await put(p, body(1), "edit");
  assertEquals((await v.createSnapshot(deps, { path: p, name: "  Draft   one \n".replace("\n", "") }, A)).snapshot.name, "Draft one");
  for (const bad of ["", "   ", "x".repeat(121), "a\u0000b", 5, null]) {
    await assertRejects(() => v.createSnapshot(deps, { path: p, name: bad }, A), DocError, "1 to 120 characters");
  }
  await assertRejects(() => v.createSnapshot(deps, { path: p, name: "ok", version: 2 }, A), DocError, "no such version");
  assertEquals((await v.createSnapshot(deps, { path: p, name: "v1 by number", version: 1 }, A)).snapshot.version, 1);
});

Deno.test("two identities: B gets, for A's document, exactly what B gets for a document that does not exist - on every route, with nothing read first", async () => {
  const p = newPath(A);
  for (let i = 1; i <= 3; i++) await put(p, `SECRET-${i}\n`, "edit");
  const s = await v.createSnapshot(deps, { path: p, name: "PRIVATE-NAME" }, A);
  const ghost = `documents/${A.key}/does-not-exist.md`; // also not B's: A's directory
  const mine = `documents/${B.key}/does-not-exist.md`; // B's own, missing
  const calls: [string, (path: string) => Promise<unknown>][] = [
    ["versions", (x) => v.listVersions(deps, x, B)],
    ["snapshots", (x) => v.listSnapshots(deps, x, B)],
    ["snapshot", (x) => v.createSnapshot(deps, { path: x, name: "intruder", version: 1 }, B)],
    ["restore by version", (x) => v.restoreVersion(deps, { path: x, version: 1 }, B)],
    ["restore by snapshot", (x) => v.restoreVersion(deps, { path: x, snapshot_id: s.snapshot.id }, B)],
    ["compare", (x) => v.compareVersions(deps, x, 1, 2, B)],
  ];
  const marks = snaps.length;
  const q0 = snapQueries();
  for (const [name, fn] of calls) {
    const out: string[] = [];
    for (const target of [p, ghost, mine]) {
      const e = await fn(target).then(() => null, (x) => x);
      assert(e instanceof DocError, `${name}: refused`);
      out.push(JSON.stringify([e.status, e.message, e.detail]));
    }
    assertEquals(new Set(out).size, 1, `${name}: A's row, a missing row in A's directory and B's missing row answer alike (${out.join(" | ")})`);
    assertEquals(JSON.parse(out[0]), [404, "no such document", {}]);
  }
  assertEquals(snaps.length, marks, "nothing was written for B");
  assertEquals(snapQueries(), q0, "no snapshot or version row was read before the ownership answer");
  assertEquals(await vlt.vaultRead(p), "SECRET-3\n", "A's text is untouched");
});

Deno.test("two identities: A's snapshot id means nothing to B, and nothing to A on another of A's documents - the same answer as an id that is nothing", async () => {
  const p = newPath(A);
  const q = newPath(A);
  const r = newPath(B);
  await put(p, "p1\n", "edit");
  await put(p, "p2\n", "edit");
  await put(q, "q1\n", "edit");
  await put(r, "r1\n", "edit");
  await put(r, "r2\n", "edit");
  const s = await v.createSnapshot(deps, { path: p, name: "A's mark", version: 1 }, A);
  const answers: string[] = [];
  for (
    const input of [
      { path: r, snapshot_id: s.snapshot.id }, // B, A's id, B's document
      { path: r, snapshot_id: "00000000-0000-4000-8000-0000000000ff" }, // B, an id that is nothing
      { path: r, snapshot_id: "not-an-id" }, // B, not an id at all
      { path: q, snapshot_id: s.snapshot.id, as: A }, // A, A's id, another of A's documents
    ]
  ) {
    const who = (input as { as?: typeof A }).as ?? B;
    const e = await v.restoreVersion(deps, { path: input.path, snapshot_id: input.snapshot_id }, who).then(() => null, (x) => x);
    assert(e instanceof DocError);
    answers.push(JSON.stringify([e.status, e.message]));
  }
  assertEquals(new Set(answers).size, 1, answers.join(" | "));
  assertEquals(JSON.parse(answers[0]), [404, "no such snapshot"]);
  assertEquals(await vlt.vaultRead(r), "r2\n", "nothing restored");
  // B's lists never carry A's marker, in any field or count
  const bl = await v.listVersions(deps, r, B);
  assertEquals(JSON.stringify(bl).includes("A's mark"), false);
  assertEquals((await v.listSnapshots(deps, r, B)).total, 0);
});

Deno.test("the snapshot table missing (slot 620 not applied) fails closed: 503 on every route that reads or writes a snapshot; compare needs none", async () => {
  const p = newPath();
  for (let i = 1; i <= 2; i++) await put(p, body(i), "edit");
  const broken = { ...db, query: (sql: string, a: unknown[]) => /document_snapshots/.test(sql)
    ? Promise.reject(Object.assign(new Error('relation "public.document_snapshots" does not exist'), { fields: { code: "42P01" } }))
    : db.query(sql, a) };
  const d = { db: broken, reg: {} as never };
  const e = await v.createSnapshot(d, { path: p, name: "x" }, A).then(() => null, (x) => x);
  assert(e instanceof DocError);
  assertEquals([e.status, e.message], [503, "snapshots are not available"]);
  assertEquals((await v.compareVersions(d, p, 1, 2, A)).identical, false);
  await assertRejects(() => v.listVersions(d, p, A), DocError, "snapshots are not available"); // the list carries the snapshots: it fails closed too
});

// ── attempt 1 of the tester: quoted paths, a reused old path, commits that carry two owners' files ─────────────────
Deno.test("quoted paths: a document whose path git quotes keeps its whole history after a move, a trash and a restore", async () => {
  // Windows cannot hold some of these names: the full set runs in the image build gate (Linux)
  // (No backslash: gitMv's `git mv` does not move such a name - the app never makes one, its slugs are [a-z0-9-] - and
  // the rename fallback then fails.)
  const all = [`q"uote`, `uni\u00e9\u4e2d`, `rep[1]`, `st*r`, `sp ace`, `q?m`, `it's`, `-dash`, `#hash`];
  const names = Deno.build.os === "windows" ? all.filter((n) => !/["*?\\]/.test(n)) : all;
  for (const n of names) {
    const p = `documents/${A.key}/${n}-${++doc}.md`;
    for (let i = 1; i <= 3; i++) await put(p, body(i), "edit");
    const moved = `documents/${A.key}/fold er/${n}-${doc}.md`;
    await vlt.gitMv(p, moved, "documents: move", A.name);
    const trashed = `documents/${A.key}/.trash/fold er/${n}-${doc}.md`;
    await vlt.gitMv(moved, trashed, "documents: trash", A.name);
    assertEquals((await v.versionsOf(trashed)).map((x) => x.version), [1, 2, 3], `history of ${n} in the trash`);
    await vlt.gitMv(trashed, p, "documents: restore", A.name);
    assertEquals((await v.versionsOf(p)).map((x) => x.version), [1, 2, 3], `history of ${n} back`);
    // a glob character in a name is a name, never a pattern: a sibling it would match has its own history
    const sib = `documents/${A.key}/${n.replace(/[[\]*?]/g, "z")}-sib-${doc}.md`;
    await put(sib, body(9), "sibling");
    assertEquals((await v.versionsOf(sib)).length, 1);
    assertEquals((await v.versionsOf(p)).length, 3);
  }
});

Deno.test("compare: a different document that now sits at the old path is never part of the diff", async () => {
  const p = `documents/${A.key}/reused-${++doc}.md`;
  for (let i = 1; i <= 2; i++) await put(p, body(i) + "X-TEXT\n", "edit");
  const moved = `documents/${A.key}/fold/${p.split("/").pop()}`;
  await vlt.gitMv(p, moved, "documents: move", A.name);
  await put(p, "Y-DOCUMENT-TEXT secret of another document\n", "Y is written at the old path");
  await put(moved, body(3) + "X-TEXT\n", "edit X after the move");
  const out = await v.compareVersions(deps, moved, 1, 3, A);
  const vs = await v.versionsOf(moved);
  assertEquals(vs.length, 3);
  assert(!out.diff.includes("Y-DOCUMENT-TEXT"), "Y's text is not in X's diff");
  assertEquals(out.diff, await git("diff", `${vs[0].commit}:${vs[0].path}`, `${vs[2].commit}:${vs[2].path}`));
  assertEquals((await v.versionsOf(p)).length, 1, "Y has its own single version");
});

// one commit that carries two owners' files: A's removal is staged (git rm), then B's create commits the WHOLE index
async function mixedCommit(aPath: string, bPath: string, bText: string) {
  await git("rm", "--quiet", "--", aPath); // A's delete-forever, staged, not yet committed
  await vlt.vaultWrite(bPath, bText);
  await vlt.vaultCommitPath(bPath, `documents: create ${bPath}`, B.name); // the whole index: both owners' files in one commit
}

Deno.test("a commit that carries two owners' files: B's new document does not inherit A's history, text or marker", async () => {
  const aTrash = `documents/${A.key}/.trash/secret-${++doc}.md`;
  const aText = (n: number) => `---\ntitle: "s"\n---\n\nA-SECRET-MARKER ${n} ` + "a long paragraph of A's text that is quite similar to B's.\n".repeat(8);
  for (let i = 1; i <= 3; i++) await put(aTrash, aText(i), "documents: edit");
  // B's text is near-identical (a similarity pairing git would make) and, in the second round, byte-identical
  for (const bText of [aText(3).replace("A-SECRET-MARKER", "B-OWN-TEXT"), aText(3)]) {
    const aFile = `documents/${A.key}/.trash/secret-${++doc}.md`;
    for (let i = 1; i <= 3; i++) await put(aFile, aText(i), "documents: edit");
    const bPath = `documents/${B.key}/new-${doc}.md`;
    await mixedCommit(aFile, bPath, bText);
    const vs = await v.versionsOf(bPath);
    assertEquals(vs.length, 1, "B has exactly one version");
    assertEquals(await vlt.vaultBlob(vs[0].blob), bText);
    // B's restore of v1 (the only text B ever had) is a no-op: B's file is B's
    const r = await v.restoreVersion(deps, { path: bPath, version: 1 }, B);
    assertEquals([r.restored, r.unchanged], [false, true]);
    assertEquals(await vlt.vaultRead(bPath), bText);
    const everything = JSON.stringify([await v.listVersions(deps, bPath, B), await v.compareVersions(deps, bPath, 1, 1, B)]);
    assert(!everything.includes("A-SECRET-MARKER") && !everything.includes(`secret-${doc}`) && !everything.includes(A.name), "nothing of A's in B's answers");
    assertEquals((await v.versionsOf(aFile)).length, 0, "A's removed file has no live history to read");
  }
});

Deno.test("the compile-sweep form: git add -A commits A's removal and B's new file together; B still sees only B's", async () => {
  const aFile = `documents/${A.key}/.trash/sweep-${++doc}.md`;
  for (let i = 1; i <= 3; i++) await put(aFile, `A-SWEEP-MARKER ${i}\n`.repeat(4), "documents: edit");
  const bPath = `documents/${B.key}/swept-${doc}.md`;
  await git("rm", "--quiet", "--", aFile);
  await vlt.vaultWrite(bPath, `B swept text\n`);
  await git("add", "-A");
  await git("-c", "user.name=wiki", "-c", "user.email=w@x", "commit", "-q", "-m", `compile: documents/${A.key}/.trash/sweep-${doc}.md gone`);
  const l = await v.listVersions(deps, bPath, B);
  assertEquals([l.total, l.current_version], [1, 1]);
  assertEquals(l.versions[0].message, "", "a message naming another document's path is not shown");
  assertEquals(l.versions[0].author, null, "an author that is not the caller is not shown");
  assert(!JSON.stringify(l).includes("A-SWEEP-MARKER") && !JSON.stringify(l).includes(`sweep-${doc}`));
  assertEquals((await v.compareVersions(deps, bPath, 1, 1, B)).diff, "");
});

Deno.test("legacy and cross-owner scopes: an exact rename between two different owners' directories is not a move", async () => {
  const x = `documents/${A.key}/moveme-${++doc}.md`;
  await put(x, body(1) + "cross\n", "A creates");
  await put(x, body(2) + "cross\n", "A edits");
  const y = `documents/${B.key}/moveme-${doc}.md`;
  await vlt.gitMv(x, y, "a bad move across owners", A.name);
  assertEquals((await v.versionsOf(y)).length, 1, "B's file starts at B's first version: the pairing is not followed");
  const { ownerScope } = await import("../util/vault_versions.ts");
  assertEquals([ownerScope(`documents/u1/a.md`), ownerScope(`documents/u1/.trash/a.md`), ownerScope(`documents/.trash/a.md`), ownerScope(`documents/a.md`)], ["u1", "u1", "", ""]);
});

// legacy scope: documents/<file>.md, documents/.trash|.archive/<file>.md, notes/ and content/ have no owner key, so ownerScope
// puts them all in scope ''. Two different listing owners' legacy files, or a note and a legacy document, must never be
// paired by a sweep commit (a whole-tree `git add -A` holding one's removal and the other's new file).
const ctxA = { db, who: A }, ctxB = { db, who: B };
const legacyBody = (tag: string) => Array.from({ length: 12 }, (_, i) => `legacy line ${i} of a document long enough for git to pair it ${i % 3}`).join("\n") + `\n${tag}\n`;
async function legacySweep(src: string, dst: string, mode: "near" | "exact") {
  const id = ++doc;
  for (let i = 1; i <= 3; i++) await put(src, legacyBody(i < 3 ? `OLDER-LEGACY-${i}-${id}` : `CURRENT-LEGACY-${id}`), "edit");
  const cur = await vlt.vaultRead(src);
  await git("rm", "-q", "--", src);
  await vlt.vaultWrite(dst, mode === "exact" ? cur : cur.replace("CURRENT-LEGACY", "CURRENT-LEGACZ"));
  await git("add", "-A");
  await git("-c", "user.name=wiki-compile", "-c", "user.email=w@x", "commit", "-q", "-m", `sweep ${id}`);
  const vs = await v.versionsOf(dst, ctxB);
  return { n: vs.length, followed: vs.some((x) => x.path === src) };
}

Deno.test("T3-U12: a sweep commit that removes one legacy file and adds another is not a move, whatever the scope '' paths are (A legacy -> B legacy, note -> legacy, wiki -> legacy, legacy .trash -> legacy), near or exact", async () => {
  for (const [what, s, d] of [
    ["legacy a -> legacy b", "documents/legacy-owner-a-%.md", "documents/legacy-owner-b-%.md"],
    ["note -> legacy", "notes/someone/private-%.md", "documents/legacy-from-note-%.md"],
    ["wiki -> legacy", "content/source/page-%.md", "documents/legacy-from-wiki-%.md"],
    ["legacy .trash (A) -> legacy root (B)", "documents/.trash/lt-a-%.md", "documents/lt-b-%.md"],
    ["legacy -> keyed", "documents/legacy-to-keyed-%.md", `documents/${B.key}/from-legacy-%.md`],
    ["legacy -> legacy .archive", "documents/legacy-arch-a-%.md", "documents/.archive/legacy-arch-b-%.md"],
  ] as const) {
    for (const mode of ["near", "exact"] as const) {
      const r = await legacySweep(s.replace("%", String(doc + 1)), d.replace("%", String(doc + 1)), mode);
      assertEquals([what, mode, r.n, r.followed], [what, mode, 1, false], "the target starts at its own v1");
    }
  }
});

Deno.test("legacy scope: the app's own legacy trash, restore and archive of ONE file keep its history (same live path)", async () => {
  const id = ++doc;
  const live = `documents/legacy-own-${id}.md`, trash = `documents/.trash/legacy-own-${id}.md`, arch = `documents/.archive/legacy-own-${id}.md`;
  await put(live, legacyBody("v1"), "edit");
  await put(live, legacyBody("v2"), "edit");
  await vlt.gitMv(live, trash, `documents: trash ${live}`, A.name);
  assertEquals((await v.versionsOf(trash, ctxA)).length, 2);
  await vlt.gitMv(trash, live, `documents: restore ${trash}`, A.name);
  assertEquals((await v.versionsOf(live, ctxA)).length, 2);
  await vlt.gitMv(live, arch, `documents: archive ${live}`, A.name);
  assertEquals((await v.versionsOf(arch, ctxA)).length, 2);
  await vlt.gitMv(arch, live, `documents: unarchive ${arch}`, A.name);
  await put(live, legacyBody("v3"), "edit");
  assertEquals((await v.versionsOf(live, ctxA)).length, 3);
});

// the residual shape (same file name, two owners): A's legacy document is trashed by the app and then removed for good; B's
// NEW document at the same live name lands in the same whole-tree commit. git pairs A's removed .trash file with B's new file
// (same liveRel), near or byte-identical. B must not get A's history, with or without a trail line for A's removal.
Deno.test("residual: A's hard-deleted legacy .trash file and B's new legacy file of the SAME name in one sweep commit: B starts at v1 (R100 and near, with and without a trail row)", async () => {
  for (const mode of ["exact", "near"] as const) {
    for (const trail of [false, true]) {
      const id = ++doc;
      const live = `documents/same-name-${id}.md`, trash = `documents/.trash/same-name-${id}.md`;
      await put(live, legacyBody(`OLDER-SAME-1-${id}`), "documents: edit");
      await put(live, legacyBody(`OLDER-SAME-2-${id}`), "documents: edit");
      await put(live, legacyBody(`CURRENT-LEGACY-${id}`), "documents: edit");
      await vlt.gitMv(live, trash, `documents: trash ${live}`, A.name);
      const cur = await vlt.vaultRead(trash);
      if (trail) trailRows.set(trash, A.sub);
      await git("rm", "-q", "--", trash); // A's delete-forever, staged
      await vlt.vaultWrite(live, mode === "exact" ? cur : cur.replace("CURRENT-LEGACY", "CURRENT-LEGACZ")); // B's new file
      await git("add", "-A");
      await git("-c", "user.name=wiki-compile", "-c", "user.email=w@x", "commit", "-q", "-m", "wiki compile");
      const vs = await v.versionsOf(live, ctxB);
      assertEquals([mode, trail, vs.length, vs.some((x) => x.path === trash)], [mode, trail, 1, false]);
      assert(!JSON.stringify(vs).includes("OLDER-SAME"), "none of A's history");
      trailRows.delete(trash);
    }
  }
});

Deno.test("legacy owner proof: the app's own move is followed only when no other owner is on record for `from`; a failed lookup is not followed", async () => {
  const id = ++doc;
  const live = `documents/proof-${id}.md`, trash = `documents/.trash/proof-${id}.md`;
  await put(live, legacyBody("p1"), "documents: edit");
  await put(live, legacyBody("p2"), "documents: edit");
  await vlt.gitMv(live, trash, `documents: trash ${live}`, A.name);
  assertEquals((await v.versionsOf(trash, ctxA)).length, 2, "nothing on record: the app's own move is followed");
  listingRows.set(live, A.sub);
  assertEquals((await v.versionsOf(trash, ctxA)).length, 2, "the caller is the owner on record");
  assertEquals((await v.versionsOf(trash, ctxB)).length, 1, "another owner on record for `from`: not followed");
  listingRows.delete(live);
  trailRows.set(live, B.sub);
  assertEquals((await v.versionsOf(trash, ctxA)).length, 1, "the removal trail names another owner: not followed");
  trailRows.delete(live);
  lookupFails = true;
  assertEquals((await v.versionsOf(trash, ctxA)).length, 1, "a failed lookup: not established, not followed");
  lookupFails = false;
  assertEquals((await v.versionsOf(trash)).length, 1, "no owner check given: a legacy pairing is not followed");
  // a commit that is not the app's move of `from` (the subject names another path) is not followed either
  const id2 = ++doc;
  const l2 = `documents/proof-b-${id2}.md`, t2 = `documents/.trash/proof-b-${id2}.md`;
  await put(l2, legacyBody("q1"), "documents: edit");
  await put(l2, legacyBody("q2"), "documents: edit");
  await vlt.gitMv(l2, t2, `documents: trash documents/other.md`, A.name);
  assertEquals((await v.versionsOf(t2, ctxA)).length, 1);
});

// ── fix round 4 (attempt 4 FAIL, H15 / H15b / T4-U1..U3): the app's OWN move commit carried B's staged file ─────────────────
// FROZEN RULE: a legacy pairing is followed only when the commit holds nothing but that one move: (1) every app move commit is
// limited to its own two paths (gitMv: `git commit --only`), (2) the subject is the app's and `to` is the destination its verb
// implies (movedAsTheAppDoes), (3) whole-tree sweepers are never followed. Residuals: see legacyOwnerCheck.
const hasOlderA = (s: string) => /OLDER-A-/.test(s);
async function blobsOf(vs: { blob: string }[]) {
  const out: string[] = [];
  for (const x of vs) out.push((await vlt.vaultBlob(x.blob)) ?? "");
  return out.join("\n");
}
const headFiles = async () => (await git("show", "--name-only", "--no-renames", "--format=", "HEAD")).trim().split("\n").filter(Boolean).sort();

for (const verb of ["trash", "archive"] as const) {
  Deno.test(`T4-U1 (${verb}): A's own legacy ${verb} commit is limited to A's two paths: B's staged byte-identical file at the same live name never rides in it, and B never gets A's history`, async () => {
    const id = ++doc;
    const live = `documents/t4u1-${verb}-${id}.md`;
    const to = verb === "trash" ? `documents/.trash/t4u1-${verb}-${id}.md` : `documents/.archive/t4u1-${verb}-${id}.md`;
    const bPath = verb === "trash" ? `documents/.archive/t4u1-${verb}-${id}.md` : `documents/.trash/t4u1-${verb}-${id}.md`;
    for (const t of [`OLDER-A-1-${id}`, `OLDER-A-2-${id}`, `CURRENT-${id}`]) await put(live, legacyBody(t), "documents: edit");
    await vlt.vaultWrite(bPath, await vlt.vaultRead(live)); // B's legacy file, staged by a whole-tree add
    await git("add", "--", bPath);
    await vlt.gitMv(live, to, `documents: ${verb} ${live}`, A.name); // the app's own move, honest subject
    assertEquals(await headFiles(), [live, to].sort(), "the move commit holds only the move's own paths");
    assert((await git("diff", "--cached", "--name-only")).split("\n").includes(bPath), "B's file is still staged, not committed");
    assertEquals((await v.versionsOf(to, ctxA)).length, 3, "A's own history follows A's own move");
    // a sweeper later commits B's file: B starts at its own v1
    await git("-c", "user.name=wiki-compile", "-c", "user.email=w@x", "commit", "-q", "-m", "wiki compile");
    const vsB = await v.versionsOf(bPath, ctxB);
    assertEquals([vsB.length, hasOlderA(await blobsOf(vsB))], [1, false]);
  });
}

Deno.test("T4-U2 (restore): A's own legacy restore commit is limited to A's two paths; B's staged .archive file of the same name never gets A's history", async () => {
  const id = ++doc;
  const live = `documents/t4u2-${id}.md`, trash = `documents/.trash/t4u2-${id}.md`, bPath = `documents/.archive/t4u2-${id}.md`;
  for (const t of [`OLDER-A-1-${id}`, `OLDER-A-2-${id}`, `CURRENT-${id}`]) await put(live, legacyBody(t), "documents: edit");
  await vlt.gitMv(live, trash, `documents: trash ${live}`, A.name);
  await vlt.vaultWrite(bPath, await vlt.vaultRead(trash));
  await git("add", "--", bPath);
  await vlt.gitMv(trash, live, `documents: restore ${trash}`, A.name);
  assertEquals(await headFiles(), [live, trash].sort());
  assertEquals((await v.versionsOf(live, ctxA)).length, 3);
  await git("-c", "user.name=wiki-compile", "-c", "user.email=w@x", "commit", "-q", "-m", "wiki compile");
  const vsB = await v.versionsOf(bPath, ctxB);
  assertEquals([vsB.length, hasOlderA(await blobsOf(vsB))], [1, false]);
});

// the same pairing made by a commit the move limit cannot protect (a hand-made whole-tree commit with the app's subject): the
// destination binding refuses it, because git paired A's `from` with B's path, not with the `.trash` path the subject implies
Deno.test("T4-U3: an app-subject commit that holds A's trash (with A's unsaved edit) and B's staged exact copy at another state: git pairs `from` with B's path, the `to` binding refuses it", async () => {
  const id = ++doc;
  const live = `documents/t4u3-${id}.md`, trash = `documents/.trash/t4u3-${id}.md`, bPath = `documents/.archive/t4u3-${id}.md`;
  for (const t of [`OLDER-A-1-${id}`, `OLDER-A-2-${id}`, `CURRENT-${id}`]) await put(live, legacyBody(t), "documents: edit");
  const cur = await vlt.vaultRead(live);
  await Deno.mkdir(`${vault}/documents/.trash`, { recursive: true });
  await git("mv", live, trash);
  await vlt.vaultWrite(trash, cur + "A's unsaved line\n");
  await vlt.vaultWrite(bPath, cur);
  await git("add", "-A");
  await git("-c", "user.name=Alice", "-c", "user.email=a@x", "commit", "-q", "-m", `documents: trash ${live}`);
  listingRows.set(trash, A.sub);
  listingRows.set(bPath, B.sub);
  const vsB = await v.versionsOf(bPath, ctxB);
  assertEquals([vsB.length, hasOlderA(await blobsOf(vsB))], [1, false]);
  listingRows.delete(trash);
  listingRows.delete(bPath);
});

Deno.test("V16 (unit): a hand-made commit with the app's `move` subject that removes A's legacy file and adds B's legacy file of ANOTHER name is not a move (sameOwnerMove, whatever the subject)", async () => {
  for (const mode of ["exact", "near"] as const) {
    const id = ++doc;
    const x = `documents/v16a-${id}.md`, y = `documents/v16b-${id}.md`;
    for (const t of [`OLDER-A-1-${id}`, `OLDER-A-2-${id}`, `CURRENT-${id}`]) await put(x, legacyBody(t), "documents: edit");
    const cur = await vlt.vaultRead(x);
    await git("rm", "-q", "--", x);
    await vlt.vaultWrite(y, mode === "exact" ? cur : cur.replace("CURRENT-", "CURRENT2-"));
    await git("add", "-A");
    await git("-c", "user.name=Alice", "-c", "user.email=a@x", "commit", "-q", "-m", `documents: move ${x} -> ${y}`);
    const vsB = await v.versionsOf(y, ctxB);
    assertEquals([mode, vsB.length, hasOlderA(await blobsOf(vsB))], [mode, 1, false]);
  }
});

Deno.test("gitMv commits only its own paths: a staged file of anyone else stays staged; an untracked draft's move still commits", async () => {
  const id = ++doc;
  const a = `documents/gm-${id}.md`, b = `documents/.trash/gm-${id}.md`, other = `notes/other-${id}.md`;
  await put(a, legacyBody("x"), "documents: edit");
  await vlt.vaultWrite(other, "someone else's staged note\n");
  await git("add", "--", other);
  await vlt.gitMv(a, b, `documents: trash ${a}`, A.name);
  assertEquals(await headFiles(), [a, b].sort());
  assert((await git("diff", "--cached", "--name-only")).split("\n").includes(other), "the other file is still staged");
  await git("-c", "user.name=n", "-c", "user.email=n@x", "commit", "-q", "-m", "notes: other");
  const d = `documents/draft-${id}.md`, d2 = `documents/.trash/draft-${id}.md`;
  await vlt.vaultWrite(d, "a draft never committed\n"); // untracked: the plain-rename fallback
  await vlt.gitMv(d, d2, `documents: trash ${d}`, A.name);
  assertEquals(await headFiles(), [d2]);
  const e = `documents/staged-${id}.md`, e2 = `documents/.trash/staged-${id}.md`;
  await vlt.vaultWrite(e, "staged by a whole-tree add, never committed\n");
  await git("add", "--", e);
  await vlt.gitMv(e, e2, `documents: trash ${e}`, A.name); // `from` is in neither HEAD nor the index after the mv
  assertEquals(await headFiles(), [e2]);
});

Deno.test("movedAsTheAppDoes: the subject must be the app's and `to` the destination its verb implies", () => {
  const rows: [string, string, string, boolean][] = [
    ["documents/a.md", "documents/.trash/a.md", "documents: trash documents/a.md", true],
    ["documents/a.md", "documents/.trash/a.md", "documents: trash documents/a.md (folder documents/f)", true],
    ["documents/.archive/a.md", "documents/.trash/a.md", "documents: trash documents/.archive/a.md", true],
    ["documents/a.md", "documents/.archive/a.md", "documents: archive documents/a.md", true],
    ["documents/.trash/a.md", "documents/a.md", "documents: restore documents/.trash/a.md", true],
    ["documents/.archive/a.md", "documents/a.md", "documents: unarchive documents/.archive/a.md", true],
    ["documents/.archive/a.md", "documents/a.md", "documents: restore documents/.archive/a.md", true],
    ["documents/a.md", "documents/.archive/a.md", "documents: trash documents/a.md", false], // the H15 pairing: the verb says .trash
    ["documents/a.md", "documents/.trash/a.md", "documents: archive documents/a.md", false],
    ["documents/.trash/a.md", "documents/.archive/a.md", "documents: restore documents/.trash/a.md", false],
    ["documents/.trash/a.md", "documents/b.md", "documents: restore documents/.trash/a.md", false],
    ["documents/a.md", "documents/.trash/a.md", "wiki compile 2026 (x)", false],
    ["documents/a.md", "documents/.trash/a.md", "documents: edit documents/a.md", false],
    ["documents/a.md", "documents/.trash/a.md", "documents: trash documents/b.md", false],
    ["documents/a.md", "documents/.trash/a.md", "notes: move documents/a.md -> documents/.trash/a.md", false],
    ["documents/a.md", "documents/b.md", "documents: move documents/a.md -> documents/b.md", true], // (sameOwnerMove refuses legacy names that differ)
    ["documents/a.md", "documents/a.md", "documents: trash documents/a.md", false],
  ];
  assertEquals(rows.filter(([f, t, m, w]) => movedAsTheAppDoes(f, t, m) !== w).map(([f, t, m]) => `${f} -> ${t} (${m})`), []);
});

Deno.test("sameOwnerMove: the rule table (documents/ only; the same key; legacy only for one file's own move)", async () => {
  const { sameOwnerMove } = await import("../util/vault_versions.ts");
  const rows: [string, string, boolean][] = [
    ["documents/u1/a.md", "documents/u1/.trash/a.md", true], ["documents/u1/a.md", "documents/u1/b/c.md", true],
    ["documents/u1/a.md", "documents/u2/a.md", false],
    ["documents/a.md", "documents/.trash/a.md", true], ["documents/.trash/a.md", "documents/a.md", true], ["documents/.archive/a.md", "documents/a.md", true],
    ["documents/a.md", "documents/b.md", false], ["documents/.trash/a.md", "documents/b.md", false],
    ["documents/a.md", "documents/u1/a.md", false], ["documents/u1/a.md", "documents/a.md", false],
    ["notes/x/a.md", "documents/a.md", false], ["documents/a.md", "notes/x/a.md", false], ["content/a.md", "documents/a.md", false],
    ["notes/a.md", "notes/b.md", false], ["notes/a.md", "notes/a.md", false],
  ];
  assertEquals(rows.filter(([f, t, w]) => sameOwnerMove(f, t) !== w).map(([f, t]) => `${f} -> ${t}`), []);
});

Deno.test("restore: a request that answers 404 does not commit the caller's unsaved text", async () => {
  const p = newPath();
  await put(p, body(1), "edit");
  await put(p, body(2), "edit");
  await vlt.vaultWrite(p, "UNSAVED TEXT\n");
  const before = (await git("rev-list", "--count", "HEAD")).trim();
  for (const input of [{ path: p, version: 9 }, { path: p, snapshot_id: "00000000-0000-4000-8000-0000000000aa" }]) {
    await assertRejects(() => v.restoreVersion(deps, input, A), DocError);
  }
  assertEquals((await git("rev-list", "--count", "HEAD")).trim(), before, "no commit was made");
  assertEquals(await vlt.vaultRead(p), "UNSAVED TEXT\n");
  assertEquals((await v.listVersions(deps, p, A)).unsaved_changes, true);
});

// ── the coordinator's extra case: a note write (vaultCommit: `git add -A`, the whole tree, no lock) sweeps A's staged or
// unsaved change into B's commit. A's reader must stay owner-correct; B must see none of A's history.
async function noteWrite(text: string) {
  await vlt.vaultWrite(`notes/b-note-${++doc}.md`, text);
  await git("add", "-A");
  await git("-c", `user.name=${B.name}`, "-c", "user.email=b@notes.local", "commit", "-q", "-m", `note: ${text}`);
}

Deno.test("a note write by B that sweeps A's staged move, A's unsaved text or A's removal: A's versions stay A's, B sees none of A's", async () => {
  const NOTE = `B-NOTE-TEXT-${Date.now()}`;
  // 1. A's document is moved to the trash with a staged `git mv`; B's note write commits the whole tree
  const p1 = newPath();
  for (let i = 1; i <= 3; i++) await put(p1, body(i), `documents: edit ${p1}`);
  const t1 = `documents/${A.key}/.trash/${p1.split("/").pop()}`;
  await vlt.vaultWrite(`${t1}.keep`, ""); // (the directory)
  await Deno.remove(`${vault}/${t1}.keep`);
  await git("mv", p1, t1);
  await noteWrite(NOTE);
  const l1 = await v.listVersions(deps, t1, A);
  assertEquals([l1.total, l1.current_version], [3, 3]);
  for (const x of l1.versions) assertEquals([x.author, x.message.startsWith("documents: ")], ["Alice", true], "A's own commits keep their author and message");
  const c1 = await v.compareVersions(deps, t1, 1, 3, A);
  assert(!JSON.stringify([l1, c1]).includes(NOTE) && !JSON.stringify([l1, c1]).includes("Bob") && !c1.diff.includes("notes/"), "nothing of B's note in A's answers");
  assertEquals(c1.diff.match(/^diff --git .*/gm)?.length, 1, "one file in the diff");
  // 2. A's unsaved text (a save without commit) is swept into B's note commit: a version made inside B's commit
  const p2 = newPath();
  for (let i = 1; i <= 2; i++) await put(p2, body(i), `documents: edit ${p2}`);
  await vlt.vaultWrite(p2, "A's third text, saved but not committed\n");
  await noteWrite(NOTE + "-2");
  const l2 = await v.listVersions(deps, p2, A);
  assertEquals([l2.total, l2.unsaved_changes], [3, false]);
  const swept = l2.versions[0];
  assertEquals([swept.version, swept.author, swept.message], [3, null, ""], "the version stays, B's authorship and B's message are withheld");
  const c2 = await v.compareVersions(deps, p2, 2, 3, A);
  assert(c2.diff.includes("A's third text") && !c2.diff.includes("notes/") && !JSON.stringify([l2, c2]).includes(NOTE), "compare shows only A's path and text");
  // 3. A's document removed (staged git rm) and swept: gone for A and for B alike
  const p3 = newPath();
  await put(p3, body(1), `documents: edit ${p3}`);
  await git("rm", "--quiet", "--", p3);
  await noteWrite(NOTE + "-3");
  const gone = [await v.listVersions(deps, p3, A).then(() => null, (e) => e), await v.listVersions(deps, p3, B).then(() => null, (e) => e)];
  for (const e of gone) assert(e instanceof DocError && e.status === 404 && e.message === "no such document");
  // B asks for every one of A's paths: all 404, the same as a missing path of B's
  for (const target of [t1, p2, p3]) {
    for (const fn of [() => v.listVersions(deps, target, B), () => v.listSnapshots(deps, target, B), () => v.compareVersions(deps, target, 1, 2, B)]) {
      const e = await fn().then(() => null, (x) => x);
      assert(e instanceof DocError && e.status === 404 && e.message === "no such document");
    }
  }
});

// ── attempt 2 of the tester ───────────────────────────────────────────────────────────────────────────────────────────
Deno.test("a move and an edit that land in ONE commit (a note write's `git add -A` between git mv and the commit): the history survives, within the owner", async () => {
  const long = "a long enough paragraph so that git pairs the renamed file with its old self\n".repeat(8);
  const p = `documents/${A.key}/mv-edit-${++doc}.md`;
  for (let i = 1; i <= 3; i++) await put(p, body(i) + long, `documents: edit ${p}`);
  const t = `documents/${A.key}/.trash/${p.split("/").pop()}`;
  await Deno.mkdir(`${vault}/documents/${A.key}/.trash`, { recursive: true });
  await git("mv", p, t); // staged, not committed
  await vlt.vaultWrite(t, body(4) + long); // A's unsaved edit of the moved file
  await noteWrite("note by B that commits the whole tree"); // the whole tree: the move AND the edit in one commit
  const vs = await v.versionsOf(t);
  assertEquals(vs.map((x) => x.version), [1, 2, 3, 4], "history kept across a rename-with-edit, and the edit is one version");
  assertEquals(vs[3].author, "Bob", "(the raw commit is B's; the reader withholds it:)");
  const l = await v.listVersions(deps, t, A);
  assertEquals([l.total, l.versions[0].author, l.versions[0].message], [4, null, ""]);
  // a similar file of ANOTHER owner removed in the same commit is still not this document's history
  const aFile = `documents/${A.key}/.trash/xo-${++doc}.md`;
  for (let i = 1; i <= 2; i++) await put(aFile, body(i) + long, `documents: edit ${aFile}`);
  const bNew = `documents/${B.key}/xo-${doc}.md`;
  await git("rm", "--quiet", "--", aFile);
  await vlt.vaultWrite(bNew, body(2) + long); // byte-identical to A's v2
  await git("add", "-A");
  await git("-c", "user.name=wiki", "-c", "user.email=w@x", "commit", "-q", "-m", "compile");
  assertEquals((await v.versionsOf(bNew)).length, 1, "an identical file of another owner is not followed");
});

Deno.test("T2-U6: delete-folder racing creates, saves and a seed rollback: every vault commit holds one owner's files, nothing fails", async () => {
  const docs = await import("./repo.ts");
  const seed = await import("./seed.ts");
  void seed; // seed.ts takes the same lock for its two commits (checked by the grep test below)
  const base = (await git("rev-parse", "HEAD")).trim(); // earlier tests make mixed commits on purpose
  for (let round = 0; round < 12; round++) {
    const folder = `race${round}-${doc}`;
    const keep = `documents/${A.key}/${folder}/.keep`;
    await vlt.vaultWrite(keep, "");
    await vlt.vaultCommitPath(keep, "documents: create folder", A.name);
    await put(`documents/${A.key}/${folder}/f-${round}.md`, body(1), "documents: create");
    const results = await Promise.allSettled([
      docs.deleteFolder(deps, folder, A),
      ...[0, 1, 2, 3].map((i) => docs.createDocument(deps, { title: `B race ${round} ${i}`, body: "b" }, B)),
      ...[0, 1].map((i) => docs.createDocument(deps, { title: `A race ${round} ${i}`, body: "a" }, A)),
    ]);
    const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 80));
    assertEquals(failed, [], `round ${round}: no writer failed`);
  }
  // no commit carries files of two owners
  const log = (await git("log", "--name-only", "--format=%x1e%H", `${base}..HEAD`)).split("\x1e").filter((b) => b.trim());
  for (const block of log) {
    const owners = new Set(block.split("\n").slice(1).filter((l) => l.startsWith("documents/")).map((l) => l.split("/")[1]));
    assert(owners.size <= 1, `a commit carries two owners' files: ${[...owners].join(",")}`);
  }
});

Deno.test("every vault commit the documents API makes goes through the vault git lock (no bare vaultCommitPath / gitRm / gitMv in documents/ or routes/documents*)", async () => {
  const dirs = [new URL("./", import.meta.url), new URL("../routes/", import.meta.url)];
  const bare: string[] = [];
  for (const d of dirs) {
    for await (const e of Deno.readDir(d)) {
      if (!e.name.endsWith(".ts") || e.name.endsWith("_test.ts") || (d.pathname.endsWith("/routes/") && !e.name.startsWith("documents"))) continue;
      const text = await Deno.readTextFile(new URL(e.name, d));
      text.split("\n").forEach((raw, i) => {
        // comments are not code: a trailing `// ...` (not a URL's) is cut before matching, so a word in a comment cannot excuse a bare call
        const line = raw.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
        if (/^\s*\/\//.test(raw) || /^import\b|^\s+gitMv, gitRm|^export function commitLocked/.test(line)) return;
        if (/\b(vaultCommitPath|gitRm|gitMv|gitRmRecursive)\(/.test(line) && !/withPathLock\(VAULT_GIT|commitLocked/.test(line)) bare.push(`${e.name}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
  }
  assertEquals(bare, [], "bare vault writers");
});
