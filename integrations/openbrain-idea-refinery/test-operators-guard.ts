// test-operators-guard.ts - who may trigger a brainstorm, measured at the poll loop's guard.
//
//   deno run --allow-read test-operators-guard.ts [path/to/index.ts]
//
// index.ts starts a server and a Mattermost poll loop on import, so this test does not import
// it. It reads the SOURCE instead: the `if (...) continue;` guard that follows `userName(` in
// the poll loop, plus `mayBrainstorm` when that function exists, and evaluates the guard with
// the OPERATORS set exactly as index.ts parses IDEA_BRAINSTORM_OPERATORS. Pointing it at an
// older index.ts (e.g. `git show e3ff8a8:.../index.ts > old.ts`) reproduces that commit's
// behaviour - which is how the fail-open default was shown RED before it was fixed.
//
// Exit 0 = every case passed; 1 = a case failed; 2 = the guard could not be located.

const path = Deno.args[0] ?? new URL("./index.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const src = await Deno.readTextFile(path);
const lines = src.split(/\r?\n/);

// The guard: the first `if (...) continue;` after the line that resolves `uname`.
const at = lines.findIndex((l) => /const uname = await userName\(/.test(l));
const guardLine = at < 0 ? undefined : lines.slice(at + 1, at + 4).find((l) => /^\s*if \(.*\) continue;/.test(l));
if (!guardLine) {
  console.error(`could not find the poll-loop guard in ${path}`);
  Deno.exit(2);
}
const cond = guardLine.replace(/^\s*if \(/, "").replace(/\) continue;.*$/, "");

// mayBrainstorm, if this version defines it (strip the TS annotations to evaluate it as JS).
const fnMatch = src.match(/function mayBrainstorm\([^)]*\)[^{]*\{[\s\S]*?\n\}/);
const fnJs = fnMatch
  ? fnMatch[0].replace(/\(ops: Set<string>, uname: string\): boolean/, "(ops, uname)")
  : "function mayBrainstorm() { throw new Error('mayBrainstorm not defined in this version'); }";

// Parse IDEA_BRAINSTORM_OPERATORS the way index.ts does.
const parse = (raw: string | undefined) =>
  new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

// deno-lint-ignore no-new-func
const skips = new Function("OPERATORS", "uname", `${fnJs}\nreturn Boolean(${cond});`) as (
  ops: Set<string>,
  uname: string,
) => boolean;

type Case = { name: string; env: string | undefined; uname: string; brainstorm: boolean };
const cases: Case[] = [
  { name: "unset: a stranger gets NO brainstorm", env: undefined, uname: "mallory", brainstorm: false },
  { name: "empty: a stranger gets NO brainstorm", env: "", uname: "mallory", brainstorm: false },
  { name: "blank-ish ' , ': a stranger gets NO brainstorm", env: " , ", uname: "mallory", brainstorm: false },
  { name: "set alice: alice gets a brainstorm", env: "alice", uname: "alice", brainstorm: true },
  { name: "set alice: mallory gets none", env: "alice", uname: "mallory", brainstorm: false },
  { name: "set 'Alice, bob': bob gets a brainstorm", env: "Alice, bob", uname: "bob", brainstorm: true },
];

console.log(`guard (from ${path}): if (${cond}) continue;`);
let failed = 0;
for (const c of cases) {
  const got = !skips(parse(c.env), c.uname);
  const ok = got === c.brainstorm;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (brainstorm=${got})`);
}

// The startup line an empty list must print (static check: the statement exists and is
// guarded by an empty-set test).
const logOk = /if \(OPERATORS\.size === 0\) \{\s*\n\s*console\.log\("brainstorm loop: IDEA_BRAINSTORM_OPERATORS is empty/.test(src);
if (!logOk) failed++;
console.log(`${logOk ? "PASS" : "FAIL"}  an empty list logs 'brainstorms are DISABLED' at startup`);

console.log(failed ? `${failed} FAILED` : "all passed");
Deno.exit(failed ? 1 : 0);
