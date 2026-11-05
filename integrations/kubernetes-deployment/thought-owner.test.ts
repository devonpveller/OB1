// deno test thought-owner.test.ts - rw-inlet-owner: every thought read in index.ts carries the owner clause;
// rw-mcp-identity: the subject is the REQUEST's, and every thought write is stamped with it.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { thoughtOwnerSql, thoughtReader, thoughtWriter } from "./thought-owner.ts";
import { callerStore, type Caller } from "./mcp-identity.ts";

const as = <T>(c: Caller, f: () => T) => callerStore.run(c, f);
const A: Caller = { lane: "full", subject: "ak-operator-sub", via: "operator-key", operator: true };
const B: Caller = { lane: "owui", subject: "ak-user-b", via: "token", operator: false };
const NONE: Caller = { lane: "personal", subject: null, via: "none", operator: false };

Deno.test("the reader is the request's subject; null with no identity; outside a request it throws (no default)", () => {
  assertEquals(as(A, () => thoughtReader()), "ak-operator-sub");
  assertEquals(as(B, () => thoughtReader()), "ak-user-b");
  assertEquals(as(NONE, () => thoughtReader()), null);
  assertThrows(() => thoughtReader(), Error, "no default subject");
});

Deno.test("the writer is the request's subject; no identity refuses the write", () => {
  assertEquals(as(B, () => thoughtWriter()), "ak-user-b");
  assertThrows(() => as(NONE, () => thoughtWriter()), Error, "cannot write");
  assertThrows(() => thoughtWriter(), Error);
});

Deno.test("the clause: shared rows plus the reader's own (a NULL reader matches shared rows only)", () => {
  assertEquals(thoughtOwnerSql("$4"), "(user_id IS NULL OR user_id = $4)");
  assertEquals(thoughtOwnerSql("$1", "t"), "(t.user_id IS NULL OR t.user_id = $1)");
});

const src = async (f: string) => (await Deno.readTextFile(new URL(`./${f}`, import.meta.url))).replace(/\r\n/g, "\n");

Deno.test("every FROM thoughts in index.ts is owner-scoped (a source check: a new read must carry the clause)", async () => {
  const s = await src("index.ts");
  const reads = [...s.matchAll(/FROM thoughts\b/g)];
  // the clause sits right after the FROM (inline SQL) or in the condition list built just before it (list_thoughts)
  const scoped = reads.filter((m) => s.slice(Math.max(0, m.index! - 1200), m.index! + 400).includes("thoughtOwnerSql("));
  assertEquals(reads.length > 0, true);
  assertEquals(scoped.length, reads.length, `${reads.length - scoped.length} thought read(s) without the owner clause`);
});

Deno.test("every INSERT INTO thoughts (index.ts, agent-memory.ts) stamps user_id (rw-mcp-identity)", async () => {
  for (const f of ["index.ts", "agent-memory.ts"]) {
    const s = await src(f);
    const ins = [...s.matchAll(/INSERT INTO thoughts\s*\(([^)]*)\)/g)];
    assert(ins.length > 0, `${f}: no thought insert found`);
    for (const m of ins) assert(/\buser_id\b/.test(m[1]), `${f}: a thought insert without user_id: ${m[0]}`);
  }
});

Deno.test("index.ts decides no subject of its own: no WORKSPACE_DEFAULT_SUB read, no module-level owner (rw-mcp-identity)", async () => {
  const s = await src("index.ts");
  assert(!/Deno\.env\.get\("WORKSPACE_DEFAULT_SUB"\)/.test(s), "index.ts reads WORKSPACE_DEFAULT_SUB itself");
  assert(!/IDEA_OWNER/.test(s), "a module-level idea owner is back");
  assert(!/ideaOwner\(/.test(s), "the env-default ideaOwner() is back");
  // every subject a tool passes to SQL comes from thoughtReader() / thoughtWriter()
  assert(!/"operator"/.test(s.replace(/\/\/.*$/gm, "")), "the placeholder subject 'operator' appears in index.ts code");
});

Deno.test("every write is refused before its handler when the request has no identity (the guard is in the wrapper)", async () => {
  const s = await src("index.ts");
  assert(/if \(!read && !currentRequestCaller\(\)\.subject\) \{\n\s*return \{ content: \[\{ type: "text", text: NO_IDENTITY_WRITE \}\], isError: true \};/.test(s),
    "the no-identity write guard is missing from registerCappedOn");
  assert(/app\.use\("\*", async \(c, next\) => \{/.test(s) && /return await callerStore\.run\(r\.caller, \(\) => next\(\)\);/.test(s),
    "every route must run inside the request's caller scope");
});
