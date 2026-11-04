// deno test thought-owner.test.ts - rw-inlet-owner: every thought read in index.ts carries the owner clause
import { assertEquals } from "jsr:@std/assert@1";
import { thoughtOwnerSql, thoughtReader } from "./thought-owner.ts";

Deno.test("the reader is the lane's subject: WORKSPACE_DEFAULT_SUB, blank = operator", () => {
  assertEquals(thoughtReader((k) => (k === "WORKSPACE_DEFAULT_SUB" ? " sub-1 " : undefined)), "sub-1");
  assertEquals(thoughtReader(() => ""), "operator");
});

Deno.test("the clause: shared rows plus the reader's own", () => {
  assertEquals(thoughtOwnerSql("$4"), "(user_id IS NULL OR user_id = $4)");
  assertEquals(thoughtOwnerSql("$1", "t"), "(t.user_id IS NULL OR t.user_id = $1)");
});

Deno.test("every FROM thoughts in index.ts is owner-scoped (a source check: a new read must carry the clause)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const reads = [...src.matchAll(/FROM thoughts\b/g)];
  // the clause sits right after the FROM (inline SQL) or in the condition list built just before it (list_thoughts)
  const scoped = reads.filter((m) => src.slice(Math.max(0, m.index! - 1200), m.index! + 400).includes("thoughtOwnerSql("));
  assertEquals(reads.length > 0, true);
  assertEquals(scoped.length, reads.length, `${reads.length - scoped.length} thought read(s) without the owner clause`);
});
