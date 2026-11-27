// deno test -A --no-check src/documents/versions_gitmv_test.ts - rwr-doc-versions-api attempt 5: the app's move commit (gitMv)
// commits the STAGED rename and nothing else: a keyed document with unsaved (autosave) text keeps its numbered history through
// move, trash and archive however much the unsaved text differs; the unsaved text stays unsaved; whatever anyone else has staged
// stays staged; glob and pathspec-magic characters in a name are literal. (T5-U1 is the tester's case, adopted.)
import { assert, assertEquals } from "jsr:@std/assert@1";

const vault = await Deno.makeTempDir({ prefix: "gitmv-vault-" });
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

const A = { sub: "user-a", actor: "user-a", name: "Alice", key: "user-a" };
// deno-lint-ignore no-explicit-any
const db: any = { query: () => Promise.resolve([]), tx: (fn: (d: unknown) => unknown) => fn(db) };
const ctxA = { db, who: A };
async function put(rel: string, text: string, msg: string) {
  await vlt.vaultWrite(rel, text);
  await vlt.vaultCommitPath(rel, msg, A.name);
}
let doc = 0;
const big = (tag: string) => Array.from({ length: 14 }, (_, i) => `line ${i} of a document long enough for git to pair it ${tag}`).join("\n") + "\n";
const rewrite = (tag: string) => Array.from({ length: 14 }, (_, i) => `completely new sentence ${i * 7} written over the old one ${tag} zz`).join("\n") + "\n";
const headFiles = async () => (await git("diff-tree", "--root", "-r", "-z", "--no-renames", "--name-only", "--no-commit-id", "HEAD")).split("\0").filter(Boolean).sort();
const staged = async () => (await git("diff", "--cached", "-z", "--name-only", "--no-renames")).split("\0").filter(Boolean);

for (const verb of ["trash", "archive", "move"] as const) {
  for (const kind of ["small", "rewrite"] as const) {
    Deno.test(`T5-U1 keyed ${verb} with an unsaved ${kind} edit: the numbered history survives and the edit stays unsaved`, async () => {
      const id = ++doc;
      const live = `documents/${A.key}/t5u1-${verb}-${kind}-${id}.md`;
      const to = verb === "trash" ? `documents/${A.key}/.trash/t5u1-${verb}-${kind}-${id}.md`
        : verb === "archive" ? `documents/${A.key}/.archive/t5u1-${verb}-${kind}-${id}.md` : `documents/${A.key}/sub/t5u1-${verb}-${kind}-${id}.md`;
      for (let i = 1; i <= 3; i++) await put(live, big(`v${i}`), `documents: edit ${live}`);
      const before = (await v.versionsOf(live, ctxA)).map((x) => [x.version, x.commit]);
      const unsaved = kind === "small" ? big("v3") + "one unsaved line\n" : rewrite(`r${id}`);
      await vlt.vaultWrite(live, unsaved); // an autosave, no commit
      const msg = verb === "move" ? `documents: move ${live} -> ${to}` : `documents: ${verb} ${live}`;
      await vlt.gitMv(live, to, msg, A.name);
      assertEquals(await headFiles(), [live, to].sort(), "the move commit holds only its own two paths");
      assertEquals((await git("diff-tree", "-r", "-M", "--name-status", "--no-commit-id", "HEAD")).trim().split("\t")[0], "R100", "a pure rename");
      const after = (await v.versionsOf(to, ctxA)).map((x) => [x.version, x.commit]);
      assertEquals(after, before, `${verb}/${kind}: v1..v3 keep their numbers and commits, and no version was added`);
      assertEquals(await vlt.vaultRead(to), unsaved, "the unsaved text is still on disk");
      assert((await git("status", "--porcelain", "--", to)).trim().startsWith("M"), "and still unsaved (not committed by the move)");
    });
  }
}

Deno.test("an unsaved edit, then trash, then restore and unarchive: the numbers stay and the unsaved text is still the document's", async () => {
  const id = ++doc;
  const live = `documents/${A.key}/t5u1-cycle-${id}.md`;
  for (let i = 1; i <= 3; i++) await put(live, big(`v${i}`), `documents: edit ${live}`);
  const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
  const unsaved = rewrite("cycle");
  await vlt.vaultWrite(live, unsaved);
  let at = live;
  for (const sub of [".trash", ".archive", "folder", ""]) {
    const next = sub ? `documents/${A.key}/${sub}/t5u1-cycle-${id}.md` : live;
    await vlt.gitMv(at, next, `documents: move ${at} -> ${next}`, A.name);
    at = next;
    assertEquals((await v.versionsOf(at, ctxA)).map((x) => x.commit), before);
  }
  assertEquals(await vlt.vaultRead(live), unsaved);
});

Deno.test("what anyone else has staged stays staged and out of the move commit; the moved file's own unsaved text stays unsaved", async () => {
  const id = ++doc;
  const live = `documents/${A.key}/other-${id}.md`;
  for (let i = 1; i <= 2; i++) await put(live, big(`o${i}`), `documents: edit ${live}`);
  const foreign = `documents/user-b/staged-${id}.md`;
  await vlt.vaultWrite(foreign, "B's staged text\n");
  await git("add", "--", foreign);
  await vlt.vaultWrite(live, rewrite("o"));
  const to = `documents/${A.key}/.trash/other-${id}.md`;
  await vlt.gitMv(live, to, `documents: trash ${live}`, A.name);
  assertEquals(await headFiles(), [live, to].sort());
  assert((await staged()).includes(foreign), "B's staged file is still staged");
  await git("commit", "-q", "-m", "clear the staged foreign file");
});

// M12: glob and pathspec-magic characters in a name are literal. A decoy that a glob reading of the name would match is staged;
// the move commit must not take it, whether the move is a tracked rename or an untracked draft (the fallback path).
// (Linux only: Windows cannot create these names.)
for (const nm of ["a*b", "q?x", "[ab]c", ":(glob)g", "-lead", "ü日本-é", "sp ace #1", "semi;colon"]) {
  Deno.test(`M12 literal name ${JSON.stringify(nm)}: a tracked rename and an untracked draft move take only their own paths`, async () => {
    if (Deno.build.os === "windows") return;
    const id = ++doc;
    const dir = `documents/${A.key}`;
    const decoys = [`${dir}/aXXb-${id}.md`, `${dir}/.trash/aXXb-${id}.md`, `${dir}/qZx-${id}.md`, `${dir}/.trash/qZx-${id}.md`, `${dir}/ac-${id}.md`, `${dir}/.trash/ac-${id}.md`,
      `${dir}/gg-${id}.md`, `${dir}/.trash/gg-${id}.md`];
    // (the same decoys named like the untracked draft below: its destination is the one pathspec of the fallback commit)
    for (const b of ["aXXb", "qZx", "ac", "bc", "gg", "xx", "semiZcolon"]) decoys.push(`${dir}/.trash/draft-${b}-${id}.md`);
    for (const d of decoys) {
      await vlt.vaultWrite(d, `decoy ${d}\n`);
      await git("--literal-pathspecs", "add", "--", d);
    }
    // decoys that SORT BEFORE the literal name and that a glob reading of it matches (a "*" matches ")", a "?" matches ">"):
    // a reader that takes "the first match" of the pathspec would pick one of these
    const early = nm === "a*b" ? `${dir}/.trash/a)b-${id}.md` : nm === "q?x" ? `${dir}/.trash/q>x-${id}.md` : "";
    if (early) {
      await vlt.vaultWrite(early, `EARLY decoy ${early}\n`);
      await git("--literal-pathspecs", "add", "--", early);
      decoys.push(early);
    }
    const tracked = `${dir}/${nm}-${id}.md`, trashed = `${dir}/.trash/${nm}-${id}.md`;
    for (let i = 1; i <= 2; i++) {
      await vlt.vaultWrite(tracked, big(`m${i}`));
      await git("--literal-pathspecs", "add", "--", tracked);
      await git("--literal-pathspecs", "commit", "-q", "-m", `edit ${i}`, "--", tracked); // decoys stay staged
    }
    await vlt.gitMv(tracked, trashed, `documents: trash ${tracked}`, A.name);
    assertEquals(await headFiles(), [tracked, trashed].sort(), "tracked rename: exactly the two paths");
    assertEquals(await git("show", `HEAD:${trashed}`), big("m2"), "and the moved file's own text, not a decoy's");
    const draft = `${dir}/draft-${nm}-${id}.md`, draftTo = `${dir}/.trash/draft-${nm}-${id}.md`;
    await vlt.vaultWrite(draft, "an untracked draft\n"); // never added: git mv cannot move it
    await vlt.gitMv(draft, draftTo, `documents: trash ${draft}`, A.name);
    assertEquals(await headFiles(), [draftTo], "untracked draft: exactly the new path");
    const st = await staged();
    for (const d of decoys) assert(st.includes(d), `decoy still staged: ${d}`);
    await git("commit", "-q", "-m", "clear the decoys");
  });
}
