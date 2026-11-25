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
const vlt = { ...(await import("../util/vault.ts")), ...(await import("../util/vault_versions.ts")) };
const { DocError } = await import("./repo.ts");

// the identities (the seam's shape)
const A = { sub: "user-a", actor: "user-a", name: "Alice", key: "user-a" };
const B = { sub: "user-b", actor: "user-b", name: "Bob", key: "user-b" };

// the snapshots table, in memory; every statement the module sends is logged
interface Snap { id: string; owner_sub: string; actor_sub: string; commit_hash: string; blob_hash: string; name: string; kind: string; created_at: string }
const snaps: Snap[] = [];
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
  const all = [`q"uote`, `back\\slash`, `uni\u00e9\u4e2d`, `rep[1]`, `st*r`, `sp ace`, `q?m`, `it's`, `-dash`, `#hash`];
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
