// deno test -A src/documents/body_walk_perf_test.ts - rw-body-size-stall: checking a request body for documents/ paths takes
// time in step with its size. The path scan used to take time in the SQUARE of a long string's length (40 KB 4.6 s,
// 160 KB over 30 s, 1 MB never); a 160 KB body is checked in well under a second, and the time grows about 4x for 4x.
// Hermetic (no database, no network). These tests are RED against the scan before the fix: run them on that code.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { ownerScope } from "../middleware/owner-scope.ts";
import { documentPathsIn } from "./ownership.ts";
import type { Identity } from "../middleware/identity.ts";

const noRows = { query: () => Promise.resolve([]), tx: (f: (d: unknown) => unknown) => f(noRows) } as never;
const who: Identity = { sub: "bob", actor: "bob", name: "bob", key: "k-bob", kind: "user", admin: false, impersonating: null };
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => { c.set("identity" as never, who as never); await next(); });
  a.use("/workbench/*", ownerScope(noRows));
  a.all("/workbench/*", (c) => c.json({ reached: true }));
  return a;
}
// the shapes that cost a backtracking scanner: one long token with no break, and long runs of path units
const SHAPES: Record<string, (n: number) => string> = {
  "one long word": (n) => "a".repeat(n),
  "a/a/a/ path": (n) => "a/".repeat(n / 2),
  "../ units": (n) => "../".repeat(n / 3),
  "./ units": (n) => "./".repeat(n / 2),
  "dots": (n) => ".".repeat(n),
  "no spaces, a .. at the end": (n) => "a".repeat(n - 2) + "..",
};
const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };

for (const [name, make] of Object.entries(SHAPES)) {
  Deno.test(`the path scan: ${name}: 160 KB in under a second, and time in step with size`, () => {
    const t40 = ms(() => documentPathsIn(make(40_000)));
    const t160 = ms(() => documentPathsIn(make(160_000)));
    assert(t160 < 1000, `160 KB took ${t160.toFixed(0)} ms`);
    const t1m = ms(() => documentPathsIn(make(1_000_000)));
    assert(t1m < 2000, `1 MB took ${t1m.toFixed(0)} ms`);
    // 4x the size is ~4x the time (a square would be 16x); the floor keeps a sub-millisecond 40 KB from deciding it
    assert(t160 < Math.max(t40, 5) * 12, `40 KB ${t40.toFixed(1)} ms, 160 KB ${t160.toFixed(1)} ms: not in step with size`);
  });
}

Deno.test("the owner scope: a 160 KB string field in a write body is checked in under a second, both ways", async () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const t = performance.now();
    const r = await app().request("/workbench/settings/user/x", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: make(160_000) }),
    });
    const took = performance.now() - t;
    assertEquals(r.status, 200, name);
    assert(took < 1000, `${name}: the owner scope took ${took.toFixed(0)} ms`);
  }
});

// the refusals that worked before still work on a big body: a foreign path hidden in a long string is still found
Deno.test("a path in a big body is still found and refused", async () => {
  const filler = "a".repeat(100_000);
  for (const hidden of ["documents/alice/x.md", `${"../".repeat(3000)}documents/alice/x.md`, "notes/../documents/alice/x.md", "a/../documents/alice/x.md"]) {
    const r = await app().request("/workbench/settings/user/x", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: `${filler} ${hidden} ${filler}` }),
    });
    assertEquals(r.status, 404, hidden.slice(0, 40));
  }
});

// the new scan finds what the old one found: a seeded differential over random strings against the pre-fix scanner
Deno.test("documentPathsIn: the same paths as the pre-fix scanner over 30,000 random strings", () => {
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const seg of p.replace(/\\/g, "/").split("/")) { if (seg === "" || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
    return out.join("/");
  };
  const isDocs = (p: string) => p.slice(0, 10).toLowerCase() === "documents/";
  const before = (s: string): string[] => {
    const found: string[] = [];
    const t = s.replace(/\\/g, "/");
    for (const m of t.matchAll(/(^|[\/\s"'=:(,])((?:\.{1,2}\/)*documents\/[^\s"'?&#,)]*)/gi)) found.push(m[2]);
    for (const m of t.matchAll(/[^\s"'?&#,]*\.\.[^\s"'?&#,]*/g)) { const n = normalize(m[0]); if (isDocs(n)) found.push(n); }
    return [...new Set(found.map(normalize).filter((p) => isDocs(p) && p.length > "documents/".length))];
  };
  const toks = ["documents/", "Documents/", "DOCUMENTS/", "../", "./", "..", ".", "/", "a", "bee", " ", '"', "'", "?", "&", "#", ",", ")", "(", "=", ":", "\\", " ", "x.md", "\n", "documents", "-"];
  let seed = 20261127;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 30_000; i++) {
    let s = "";
    for (let j = 1 + rnd(14); j > 0; j--) s += toks[rnd(toks.length)];
    assertEquals(documentPathsIn(s).sort(), before(s).sort(), JSON.stringify(s));
  }
});
