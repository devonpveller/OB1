// rwr-doc-versions-api attempt 6 (the tester's T6-U0, U1, U2 and U5 adopted). deno test -A --no-check src/documents/versions_cas_test.ts (Linux only:
// a `git` wrapper on PATH injects another writer's commit inside gitMv's window).
// The plumbing path of gitMv (renameCommit: private index, commit-tree, update-ref HEAD <new> <old>):
//   T6-U1 a commit by another writer lands between renameCommit's `rev-parse HEAD` and its `update-ref` (deterministic: a git
//         wrapper on PATH runs the other writer's commit just before update-ref): no commit lost, nothing mixed, history kept?
//   T6-U2 the same race left to the scheduler: A's gitMv and B's unlocked note move (moveNote -> gitMv) in one Promise.all
//   T6-U3 modes and symlinks: 100755 and 120000 entries keep their mode and blob through the rename commit
//   T6-U4 the private index file: gone after success, after a failing plumbing step, after the CAS refusal; a crash leaves it
//   T6-U5 nothing anyone else staged (add, modify, delete, rename, mode, intent-to-add, neighbours) enters A's commit
//   T6-U6 A's own text staged by a sweeper's `git add` (not committed) before A's move
import { assert, assertEquals } from "jsr:@std/assert@1";

const WIN = Deno.build.os === "windows"; // the injector is a /bin/sh script: Linux only (the image build gate runs it)
// deno-lint-ignore no-explicit-any
const T = (name: string, fn: () => any) => Deno.test({ name, ignore: WIN, fn });

const vault = await Deno.makeTempDir({ prefix: "t6-vault-" });
Deno.env.set("WIKI_GIT_DIR", vault);
const REAL_GIT = Deno.build.os === "windows" ? "git" : "/usr/bin/git";
const dec = new TextDecoder();
const git = async (...a: string[]) => {
  const r = await new Deno.Command(REAL_GIT, { args: ["-C", vault, ...a], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(`git ${a.join(" ")}: ${dec.decode(r.stderr)}`);
  return dec.decode(r.stdout);
};
await git("init", "-q");
await git("config", "user.email", "t@lab.local");
await git("config", "user.name", "lab");

// the fault injector: a `git` on PATH that, while $T6_FLAG exists and an argument equals $T6_AT, first runs $T6_CMD (the
// other writer), then either goes on (mode go), fails the step (mode fail) or kills its parent, the deno process (mode kill)
const wrapDir = await Deno.makeTempDir({ prefix: "t6-wrap-" });
await Deno.writeTextFile(`${wrapDir}/git`, `#!/bin/sh
if [ -n "$T6_FLAG" ] && [ -f "$T6_FLAG" ]; then
  for a in "$@"; do
    if [ "$a" = "$T6_AT" ]; then
      n=$(cat "$T6_FLAG"); if [ "$n" -gt 1 ] 2>/dev/null; then echo $((n-1)) > "$T6_FLAG"; else rm -f "$T6_FLAG"; fi
      if [ -n "$T6_CMD" ]; then T6_FLAG= sh "$T6_CMD" >>"$T6_LOG" 2>&1; fi
      echo "injected at $T6_AT mode $T6_MODE" >>"$T6_LOG"
      if [ "$T6_MODE" = "fail" ]; then exit 1; fi
      if [ "$T6_MODE" = "kill" ]; then kill -9 $PPID; exit 1; fi
      break
    fi
  done
fi
if [ -n "$T6_LOCKMV" ] && [ -f "$T6_LOCKMV" ]; then
  case " $* " in
    *" mv "*)
      sk=$(cat "$T6_LOCKMV.skip" 2>/dev/null || echo 0)
      if [ "$sk" -gt 0 ] 2>/dev/null; then echo $((sk-1)) > "$T6_LOCKMV.skip"
      else
        n=$(cat "$T6_LOCKMV")
        if [ "$n" -gt 0 ] 2>/dev/null; then
          echo $((n-1)) > "$T6_LOCKMV"; echo "lock-mv" >> "$T6_LOG"
          : > "$T6_VAULT/.git/index.lock"; ${REAL_GIT} "$@"; rc=$?; rm -f "$T6_VAULT/.git/index.lock"; exit $rc
        fi
      fi;;
  esac
fi
exec ${REAL_GIT} "$@"
`);
await Deno.chmod(`${wrapDir}/git`, 0o755);
if (!WIN) Deno.env.set("PATH", `${wrapDir}:${Deno.env.get("PATH")}`);
const flag = `${wrapDir}/flag`, cmdFile = `${wrapDir}/cmd.sh`, logFile = `${wrapDir}/log`;
Deno.env.set("T6_FLAG", flag);
Deno.env.set("T6_LOG", logFile);
Deno.env.set("T6_VAULT", vault);
const lockMv = `${wrapDir}/lockmv`;
Deno.env.set("T6_LOCKMV", lockMv);
// the next `git mv` calls hold .git/index.lock: skip the first `skip`, then lock `count` of them (the undo of an exhausted move is the second `git mv`)
async function armLockMv(skip: number, count: number) {
  await Deno.writeTextFile(`${lockMv}.skip`, String(skip));
  await Deno.writeTextFile(lockMv, String(count));
}

Deno.env.set("T6_CMD", cmdFile);
// count: how many times the injection fires (each time the matching git call is made) before it disarms itself
async function arm(at: string, mode: "go" | "fail" | "kill", cmd: string, count = 1) {
  Deno.env.set("T6_AT", at);
  Deno.env.set("T6_MODE", mode);
  await Deno.writeTextFile(cmdFile, `cd ${vault}\n${cmd}\n`);
  await Deno.writeTextFile(flag, String(count));
}
const fired = async () => !(await Deno.stat(flag).then(() => true).catch(() => false));

const v = await import("./versions.ts");
const vlt = { ...(await import("../util/vault.ts")), ...(await import("../util/vault_versions.ts")) };
const A = { sub: "user-a", actor: "user-a", name: "Alice", key: "user-a" };
// deno-lint-ignore no-explicit-any
const db: any = { query: () => Promise.resolve([]), tx: (fn: (d: unknown) => unknown) => fn(db) };
const ctxA = { db, who: A };
let doc = 0;
const big = (tag: string) => Array.from({ length: 14 }, (_, i) => `line ${i} of a document long enough for git to pair it ${tag}`).join("\n") + "\n";
const rewrite = (tag: string) => Array.from({ length: 14 }, (_, i) => `completely new sentence ${i * 7} written over the old one ${tag} zz`).join("\n") + "\n";
async function put(rel: string, text: string, msg: string) {
  await vlt.vaultWrite(rel, text);
  await git("--literal-pathspecs", "add", "--", rel);
  await git("--literal-pathspecs", "commit", "-q", "-m", msg, "--", rel);
}
const filesOf = async (c: string) => (await git("diff-tree", "--root", "-r", "-z", "--no-renames", "--name-only", "--no-commit-id", c)).split("\0").filter(Boolean).sort();
const statusOf = async (c: string) => (await git("diff-tree", "--root", "-r", "-M", "--name-status", "--no-commit-id", c)).trim();
const head = async () => (await git("rev-parse", "HEAD")).trim();
const isAncestor = async (a: string, b: string) => (await new Deno.Command(REAL_GIT, { args: ["-C", vault, "merge-base", "--is-ancestor", a, b] }).output()).success;
const leftovers = async () => {
  const out: string[] = [];
  for await (const e of Deno.readDir(`${vault}/.git`)) if (e.name.startsWith("index.rename")) out.push(e.name);
  return out;
};
const stagedRaw = async () => (await git("diff", "--cached", "--raw", "--no-renames", "-z")).split("\0").filter(Boolean).join("|");
const report: string[] = [];
const note = (s: string) => { report.push(s); console.log(`T6REPORT ${s}`); };

T("T6-U0 the wrapper is on PATH (the injection is real)", async () => {
  await Deno.writeTextFile(`${vault}/seed.md`, "seed\n");
  await git("add", "seed.md");
  await git("commit", "-q", "-m", "seed");
  await arm("rev-parse", "go", "echo wrapper-ran");
  await vlt.git(["rev-parse", "HEAD"]);
  assert(await fired(), "the wrapper ran for gitMv's own git calls");
  assert((await Deno.readTextFile(logFile)).includes("wrapper-ran"));
});

// T6-U1: B's commit lands in A's window. bkind: pathlimited = a commit holding only B's own paths (moveNote's own renameCommit
// or its --only fallback); wholeindex = notes' vaultCommitPath (`git add <B's note>` + `git commit`, the whole index);
// addall = vaultCommit / the wiki compile (`git add -A` + `git commit`)
for (const bkind of ["pathlimited", "wholeindex", "addall"] as const) {
  for (const unsaved of ["none", "small", "rewrite"] as const) {
    for (const verb of ["trash", "move"] as const) {
      T(`T6-U1 CAS race: B's ${bkind} commit before A's update-ref, A ${verb} with ${unsaved} unsaved text`, async () => {
        const id = ++doc;
        const live = `documents/${A.key}/u1-${bkind}-${unsaved}-${verb}-${id}.md`;
        const to = verb === "trash" ? `documents/${A.key}/.trash/u1-${bkind}-${unsaved}-${verb}-${id}.md` : `documents/${A.key}/sub/u1-${bkind}-${unsaved}-${verb}-${id}.md`;
        for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
        const bNote = `notes/b-${id}.md`, bNote2 = `notes/moved/b-${id}.md`;
        await put(bNote, `B's note ${id}\n`, `notes: edit ${bNote}`);
        const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
        const text = unsaved === "none" ? big(`v3-${id}`) : unsaved === "small" ? big(`v3-${id}`) + "one unsaved line\n" : rewrite(`r${id}`);
        await vlt.vaultWrite(live, text);
        const bcmd = bkind === "pathlimited"
          ? `mkdir -p notes/moved && git mv ${bNote} ${bNote2} && git commit -q -m "notes: move ${bNote} -> ${bNote2}" --only -- ${bNote} ${bNote2}`
          : bkind === "wholeindex"
          ? `echo "B edit" >> ${bNote} && git add ${bNote} && git commit -q -m "notes: edit ${bNote}"`
          : `echo "B edit" >> ${bNote} && git add -A && git commit -q -m "ai-note: write ${bNote}"`;
        await arm("update-ref", "go", bcmd);
        const h0 = await head();
        let threw = "";
        try {
          await vlt.gitMv(live, to, verb === "move" ? `documents: move ${live} -> ${to}` : `documents: ${verb} ${live}`, A.name);
        } catch (e) {
          threw = (e as Error).message.slice(0, 120);
        }
        assert(await fired(), "the other writer's commit ran inside A's window");
        const log = (await git("log", "--format=%H %s", `${h0}..HEAD`)).trim().split("\n").filter(Boolean);
        const bCommit = log.find((l) => / (notes|ai-note): /.test(l))?.split(" ")[0] ?? "";
        const aCommits = log.filter((l) => / documents: /.test(l)).map((l) => l.split(" ")[0]);
        const lost = !bCommit || !(await isAncestor(bCommit, "HEAD"));
        const mixed: string[] = [];
        for (const c of aCommits) for (const f of await filesOf(c)) if (f !== live && f !== to) mixed.push(f);
        const after = (await v.versionsOf(to, ctxA).catch(() => [])).map((x) => x.commit);
        const kept = before.every((c, i) => after[i] === c);
        const added = after.length - before.length;
        const st = (await git("status", "--porcelain", "--", to)).trim();
        const aStatus = [];
        for (const c of aCommits) aStatus.push((await statusOf(c)).replace(/\n/g, ";").replace(/\t/g, " ").replace(/documents\/user-a\//g, ""));
        note(`U1 ${bkind}/${unsaved}/${verb}: threw=${threw ? JSON.stringify(threw) : "no"} commits=${log.length} Bcommit-lost=${lost} A-commits=${aCommits.length} [${aStatus.join(" | ")}] mixed=${mixed.length} history-kept=${kept} before=${before.length} after=${after.length} added=${added} wt-status=${JSON.stringify(st)} leftovers=${(await leftovers()).length}`);
        assertEquals(lost, false, "the other writer's commit is never lost");
        assertEquals(mixed, [], "A's commit never holds another path");
        assertEquals(await leftovers(), [], "no private index left behind");
        if (bkind !== "addall") {
          // the claim of Case 2 / Case 15: a keyed document keeps v1..v3 through move and trash, however large the unsaved edit
          assert(kept, `${bkind}/${unsaved}/${verb}: v1..v3 kept (before ${before.length}, after ${after.length}; A ${aStatus.join(" | ")})`);
        }
        await git("add", "-A");
        await git("commit", "-q", "--allow-empty", "-m", "t6 clear");
      });
    }
  }
}

// T6-U2: the race left to the scheduler. moveNote calls gitMv without the vault lock, so B's note move can run while A's
// document move (under the documents lock) is inside renameCommit.
for (const unsaved of ["small", "rewrite"] as const) {
  T(`T6-U2 natural race: A's keyed trash (${unsaved} unsaved) and B's note move in one Promise.all, 20 rounds`, async () => {
    let lost = 0, mixed = 0, hist = 0, added = 0, aThrew = 0, bThrew = 0, rounds = 0;
    const errs = new Set<string>();
    for (let r = 0; r < 20; r++) {
      const id = ++doc;
      const live = `documents/${A.key}/u2-${unsaved}-${id}.md`, to = `documents/${A.key}/.trash/u2-${unsaved}-${id}.md`;
      for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
      const bNote = `notes/u2-${id}.md`, bTo = `notes/u2moved/u2-${id}.md`;
      await put(bNote, `B's note ${id}\n`, `notes: edit ${bNote}`);
      await vlt.vaultWrite(bNote, `B's note ${id}\nB unsaved\n`);
      const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
      await vlt.vaultWrite(live, unsaved === "small" ? big(`v3-${id}`) + "one unsaved line\n" : rewrite(`r${id}`));
      const h0 = await head();
      const [ra, rb] = await Promise.allSettled([
        vlt.gitMv(live, to, `documents: trash ${live}`, A.name),
        new Promise((res) => setTimeout(res, r % 4 * 3)).then(() => vlt.gitMv(bNote, bTo, `notes: move ${bNote} -> ${bTo}`, "Bob")),
      ]);
      rounds++;
      if (ra.status === "rejected") { aThrew++; errs.add(`A:${String(ra.reason?.message).slice(0, 80)}`); }
      if (rb.status === "rejected") { bThrew++; errs.add(`B:${String(rb.reason?.message).slice(0, 80)}`); }
      const log = (await git("log", "--format=%H %s", `${h0}..HEAD`)).trim().split("\n").filter(Boolean);
      const aC = log.filter((l) => l.includes(" documents: ")).map((l) => l.split(" ")[0]);
      const bC = log.filter((l) => l.includes(" notes: ")).map((l) => l.split(" ")[0]);
      if (ra.status === "fulfilled" && aC.length === 0) lost++;
      if (rb.status === "fulfilled" && bC.length === 0) lost++;
      for (const c of aC) for (const f of await filesOf(c)) if (f !== live && f !== to) mixed++;
      for (const c of bC) for (const f of await filesOf(c)) if (f !== bNote && f !== bTo) mixed++;
      const after = (await v.versionsOf(to, ctxA).catch(() => [])).map((x) => x.commit);
      if (ra.status === "fulfilled" && !before.every((c, i) => after[i] === c)) hist++;
      if (ra.status === "fulfilled" && after.length > before.length) added++;
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", "t6 clear");
    }
    note(`U2 ${unsaved}: rounds=${rounds} commits-lost=${lost} mixed-paths=${mixed} A-history-lost=${hist} A-version-added=${added} A-threw=${aThrew} B-threw=${bThrew} errors=${JSON.stringify([...errs])} leftovers=${(await leftovers()).length}`);
    assertEquals(lost, 0, "no commit lost");
    assertEquals(mixed, 0, "no commit mixed");
    assertEquals(await leftovers(), []);
    assertEquals(hist, 0, "A's history kept in every round");
  });
}

// T6-U5: nothing anyone else staged enters A's commit
T("T6-U5 every shape of a foreign staged change stays staged, unchanged, and out of A's commit", async () => {
  const id = ++doc;
  const dir = `documents/${A.key}`;
  const live = `${dir}/u5-${id}.md`, to = `${dir}/.trash/u5-${id}.md`;
  for (let i = 1; i <= 2; i++) await put(live, big(`s${i}-${id}`), `documents: edit ${live}`);
  const bMod = `documents/user-b/mod-${id}.md`, bDel = `documents/user-b/del-${id}.md`, bRen = `documents/user-b/ren-${id}.md`, bMode = `documents/user-b/mode-${id}.md`;
  const aOther = `${dir}/other-${id}.md`;
  for (const f of [bMod, bDel, bRen, bMode, aOther]) await put(f, big(`base ${f}`), `documents: create ${f}`);
  // the shapes
  await vlt.vaultWrite(`documents/user-b/new-${id}.md`, "B new\n");
  await git("add", "--", `documents/user-b/new-${id}.md`);
  await vlt.vaultWrite(bMod, "B modified\n");
  await git("add", "--", bMod);
  await git("rm", "-q", "--", bDel);
  await Deno.mkdir(`${vault}/documents/user-b/.trash`, { recursive: true });
  await git("mv", bRen, `documents/user-b/.trash/ren-${id}.md`);
  await Deno.chmod(`${vault}/${bMode}`, 0o755);
  await git("add", "--", bMode);
  await vlt.vaultWrite(`documents/user-b/ita-${id}.md`, "B intent to add\n");
  await git("add", "-N", "--", `documents/user-b/ita-${id}.md`);
  await vlt.vaultWrite(aOther, "A's other document, staged edit\n");
  await git("add", "--", aOther);
  for (const n of [`${dir}/.trash/u5-${id}.mdx`, `${dir}/.trash/u5-${id}`, `${dir}/.trash/u5-${id}.md.bak`, `documents/user-b/.trash/u5-${id}.md`, `${dir}/.trash/u5-${id}.m`]) {
    await vlt.vaultWrite(n, `neighbour ${n}\n`);
    await git("add", "--", n);
  }
  const stagedBefore = await stagedRaw();
  const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
  await vlt.gitMv(live, to, `documents: trash ${live}`, A.name);
  const files = await filesOf("HEAD");
  const stagedAfter = await stagedRaw();
  note(`U5: files=${JSON.stringify(files.map((f) => f.replace(/documents\//, "")))} history-kept=${JSON.stringify((await v.versionsOf(to, ctxA)).map((x) => x.commit)) === JSON.stringify(before)}`);
  assertEquals(files, [live, to].sort(), "A's commit holds exactly its two paths");
  const ita = `documents/user-b/ita-${id}.md`;
  for (const p of [`documents/user-b/new-${id}.md`, bMod, bDel, bRen, `documents/user-b/.trash/ren-${id}.md`, bMode, aOther]) {
    assert(stagedBefore.includes(p), `was staged: ${p}`);
    assert(stagedAfter.includes(p), `still staged: ${p}`);
  }
  assert((await git("ls-files", "-s", "--", ita)).trim().length > 0, "the intent-to-add entry is still in the index");
  assert(!(await git("ls-tree", "-r", "--name-only", "HEAD")).includes(ita), "and not in HEAD");
  // each foreign raw entry (modes, blobs, status letter) is byte-identical
  const entries = (s: string) => {
    const parts = s.split("|"); const m = new Map<string, string>();
    for (let i = 0; i + 1 < parts.length; i += 2) m.set(parts[i + 1], parts[i]);
    return m;
  };
  const eb = entries(stagedBefore), ea = entries(stagedAfter);
  for (const [p, raw] of eb) if (p !== live && p !== to) assertEquals(ea.get(p), raw, `unchanged staged entry ${p}`);
  assertEquals(await leftovers(), []);
  await git("commit", "-q", "-m", "t6 clear");
});

T("T6-ZZ report", () => {
  console.log("==== T6 REPORT ====\n" + report.join("\n"));
});

// ── attempt 6 fix: a refused update-ref is retried on the new HEAD; it never falls back to a path commit of the on-disk text ──
const bEdit = (n: number) => `mkdir -p notes && echo "B edit ${n}-$$" >> notes/b-${n}.md && git add notes/b-${n}.md && git commit -q -m "notes: edit notes/b-${n}.md" -- notes/b-${n}.md`; // path-limited: A's staged rename stays staged until A commits it

T("T6-FIX retry: another writer's commit lands in 3 consecutive windows; A's keyed move still lands once, as a pure rename, history kept, every B commit kept", async () => {
  const id = ++doc;
  const live = `documents/${A.key}/retry-${id}.md`, to = `documents/${A.key}/.trash/retry-${id}.md`;
  for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
  const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
  const unsaved = rewrite(`retry${id}`);
  await vlt.vaultWrite(live, unsaved);
  const h0 = await head();
  await arm("update-ref", "go", bEdit(id), 3);
  await vlt.gitMv(live, to, `documents: trash ${live}`, A.name);
  const log = (await git("log", "--format=%H %s", `${h0}..HEAD`)).trim().split("\n").filter(Boolean);
  assertEquals(log.filter((l) => / notes: edit /.test(l)).length, 3, "all three of B's commits are on the branch (none lost to a CAS-less update-ref)");
  const aCommits = log.filter((l) => / documents: trash /.test(l)).map((l) => l.split(" ")[0]);
  assertEquals(aCommits.length, 1, "exactly one move commit");
  assertEquals((await git("show", "--name-status", "--format=", "-M", aCommits[0])).trim(), `R100\t${live}\t${to}`, "a pure rename of the committed text");
  assertEquals(await filesOf(aCommits[0]), [live, to].sort());
  assertEquals((await v.versionsOf(to, ctxA)).map((x) => x.commit), before, "v1..v3 kept, no version added");
  assertEquals(await vlt.vaultRead(to), unsaved, "the unsaved text is still unsaved");
  assertEquals((await leftovers()).length, 0, "no private index file left");
});

T("T6-FIX exhausted: another writer's commit lands in EVERY window; A's keyed move fails with an error, is undone, and commits nothing (never the on-disk text)", async () => {
  const id = ++doc;
  const live = `documents/${A.key}/exhaust-${id}.md`, to = `documents/${A.key}/.trash/exhaust-${id}.md`;
  for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
  const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
  const unsaved = rewrite(`exhaust${id}`);
  await vlt.vaultWrite(live, unsaved);
  const h0 = await head();
  await arm("update-ref", "go", bEdit(id), 99);
  let threw = "";
  try {
    await vlt.gitMv(live, to, `documents: trash ${live}`, A.name);
  } catch (e) {
    threw = (e as Error).message;
  }
  await Deno.remove(flag).catch(() => {}); // disarm
  assert(/not committed/.test(threw) && /undone/.test(threw), `a clear error that says the move was undone: ${threw}`);
  const log = (await git("log", "--format=%H %s", `${h0}..HEAD`)).trim().split("\n").filter(Boolean);
  assert(log.length >= 2 && log.every((l) => / notes: edit /.test(l)), "only the other writer's commits are on the branch: A committed nothing");
  assert(!log.some((l) => / documents: /.test(l)), "and in particular no path commit of the on-disk text");
  assert(await vlt.vaultExists(live) && !(await vlt.vaultExists(to)), "the move was undone: the file is where it was");
  assertEquals(await vlt.vaultRead(live), unsaved, "with its unsaved text");
  assertEquals((await v.versionsOf(live, ctxA)).map((x) => x.commit), before, `history untouched; status [${(await git("status", "--porcelain")).trim()}]; log [${(await git("log", "--format=%h %s", "-n6", "--", live)).trim()}]; ls-files [${(await git("ls-files", "--", live, to)).trim()}]`);
  assertEquals((await git("status", "--porcelain", "--", live, to)).trim(), `M ${live}`, "the index is as before the move (only the unsaved edit shows)");
  assertEquals((await leftovers()).length, 0);
});

// ── attempt 7 (review 1): the undo of an exhausted move meets a held index.lock ────────────────────────────────────────────
// The exhaustion itself (every window refused) is injected as before; the undo is the SECOND `git mv` (the forward move is the first).
const recDb = () => {
  const log: string[] = [];
  // deno-lint-ignore no-explicit-any
  const d: any = { query: (sql: string, a: unknown[] = []) => { log.push(`${sql.replace(/\s+/g, " ").trim().slice(0, 70)} ${JSON.stringify(a)}`); return Promise.resolve([]); }, tx: (fn: (x: unknown) => unknown) => fn(d) };
  return { d, log };
};

T("T7-FIX undo retry: the undo meets index.lock twice, then succeeds - the move is undone, nothing staged, history kept", async () => {
  const id = ++doc;
  const live = `documents/${A.key}/undo1-${id}.md`, to = `documents/${A.key}/.trash/undo1-${id}.md`;
  for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
  const before = (await v.versionsOf(live, ctxA)).map((x) => x.commit);
  const unsaved = rewrite(`undo1-${id}`);
  await vlt.vaultWrite(live, unsaved);
  await arm("update-ref", "go", bEdit(id), 99);
  await armLockMv(1, 2);
  let err: unknown = null;
  try {
    await vlt.gitMv(live, to, `documents: trash ${live}`, A.name);
  } catch (e) {
    err = e;
  }
  await Deno.remove(flag).catch(() => {});
  await Deno.remove(lockMv).catch(() => {});
  assert(err instanceof vlt.MoveNotCommitted, `a MoveNotCommitted: ${err}`);
  assertEquals((err as InstanceType<typeof vlt.MoveNotCommitted>).moved, false, "undone");
  assert(/undone/.test((err as Error).message), (err as Error).message);
  assert((await Deno.readTextFile(logFile)).split("lock-mv").length - 1 >= 2, "the undo really met the lock twice");
  assert(await vlt.vaultExists(live) && !(await vlt.vaultExists(to)), "the file is where it was");
  assertEquals(await vlt.vaultRead(live), unsaved);
  assertEquals((await git("status", "--porcelain", "--", live, to)).trim(), `M ${live}`, "nothing staged for the file: only its unsaved edit shows");
  assertEquals((await v.versionsOf(live, ctxA)).map((x) => x.commit), before, "history kept");
  assertEquals((await git("ls-files", "--", to)).trim(), "", "no staged destination");
});

T("T7-FIX undo lock outlasts its retries: the file stays at the destination (staged), `moved` is true, and the documents listing FOLLOWS the file; an undone move answers 503 and leaves the listing", async () => {
  const docs = await import("./repo.ts");
  const id = ++doc;
  const live = `documents/${A.key}/undo2-${id}.md`, to = `documents/${A.key}/.trash/undo2-${id}.md`;
  for (let i = 1; i <= 3; i++) await put(live, big(`v${i}-${id}`), `documents: edit ${live}`);
  await vlt.vaultWrite(live, rewrite(`undo2-${id}`));
  const { d, log } = recDb();
  await arm("update-ref", "go", bEdit(id), 99);
  await armLockMv(1, 99);
  const out = await docs.moveTo({ db: d, reg: {} as never }, live, to, `documents: trash ${live}`, A).then((r) => r, (e) => e);
  await Deno.remove(flag).catch(() => {});
  await Deno.remove(lockMv).catch(() => {});
  assertEquals(out, to, "answered as done: the file really is at the destination");
  assert(await vlt.vaultExists(to) && !(await vlt.vaultExists(live)), "the file is at `to`");
  assertEquals((await git("ls-files", "--", to)).trim(), to, "its rename is staged");
  assert(log.some((l) => /UPDATE public\.user_document_listings SET path/.test(l) && l.includes(live) && l.includes(to)), `the listing followed the file: ${log.join(" | ")}`);
  await git("reset", "-q"); // the lab vault: clear the staged leftovers
  await Deno.rename(`${vault}/${to}`, `${vault}/${live}`).catch(() => {});
  await git("checkout", "-q", "--", ".").catch(() => {});
  // the undone case: exhausted, undo succeeds -> a 503, the listing untouched
  const id2 = ++doc;
  const live2 = `documents/${A.key}/undo3-${id2}.md`, to2 = `documents/${A.key}/.trash/undo3-${id2}.md`;
  for (let i = 1; i <= 3; i++) await put(live2, big(`v${i}-${id2}`), `documents: edit ${live2}`);
  const rec2 = recDb();
  await arm("update-ref", "go", bEdit(id2), 99);
  const out2 = await docs.moveTo({ db: rec2.d, reg: {} as never }, live2, to2, `documents: trash ${live2}`, A).then((r) => r, (e) => e);
  await Deno.remove(flag).catch(() => {});
  assert(out2 instanceof docs.DocError && out2.status === 503 && /busy/.test(out2.message), `503 busy: ${out2}`);
  assert(!rec2.log.some((l) => /UPDATE public\.user_document_listings SET path/.test(l)), "the listing was not touched");
  assert(await vlt.vaultExists(live2) && !(await vlt.vaultExists(to2)));
});
