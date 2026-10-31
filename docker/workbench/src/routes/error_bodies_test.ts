// deno test --allow-read src/routes/error_bodies_test.ts
// rw-identity-harden round 2 (tester t-id-harden D1): no response body, on any error, carries an
// exception's own text - an OS error names the vault's absolute path, a fetch error the upstream URL.
// The tester's forced repros (a folder named like a note, a write under a file, an unreachable
// extractor) need the vault and the /recipes mount, so they run in the lab
// (identity_integration_test.ts "D1 ..."); this file is the source check and the allow-list's unit.
// The image build runs this file (the test stage's gate).
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("D1: publicError answers only the validators' fixed texts, anything else the route's fixed message", async () => {
  const spec = "../util/public-error.ts"; // a variable: the RED run on a tree without it still type-checks
  const mod = await import(spec).catch(() => null) as Record<string, unknown> | null;
  assert(mod && typeof mod.publicError === "function", "util/public-error.ts publicError does not exist");
  const publicError = mod.publicError as (e: unknown, fallback: string, where?: string) => string;
  const keep = console.error;
  console.error = () => {};
  try {
    for (const m of ["path traversal rejected", "empty path", "invalid path char", "invalid folder name", "notes must be .md files"]) {
      assertEquals(publicError(new Error(m), "the note could not be read"), m);
    }
    for (const m of ["Is a directory (os error 21): readfile '/wiki/notes/x.md'", "error sending request for url (http://x/extract)", "path traversal rejected at /wiki", ""]) {
      assertEquals(publicError(new Error(m), "the note could not be read"), "the note could not be read");
    }
    assertEquals(publicError("a thrown string", "fixed"), "fixed");
  } finally {
    console.error = keep;
  }
});

// No route answers an exception's message: the route files hand a caught error to the client only
// through util/public-error.ts (the validators' fixed texts) or as one of the workbench's own error
// classes. A `String((e as Error).message)` / `e.message` / `${e}` inside c.json(...) or json(...) FAILS.
Deno.test("D1: no route file puts a caught exception's message into a response", async () => {
  const dir = new URL("./", import.meta.url);
  const hits: string[] = [];
  const echo = /\b(?:c\.)?json\(\s*\{[^}]*(?:String\(\s*\(?\s*e\b|\(e as Error\)\??\.message|\$\{\s*e\s*\}|\$\{\s*\(e as Error\)\.message)/;
  for await (const f of Deno.readDir(dir)) {
    if (!f.name.endsWith(".ts") || f.name.endsWith("_test.ts")) continue;
    (await Deno.readTextFile(new URL(f.name, dir))).split("\n").forEach((l, i) => { if (echo.test(l)) hits.push(`routes/${f.name}:${i + 1}: ${l.trim()}`); });
  }
  for (const f of ["../export/exporter.ts", "../contracts/routes/refinery.ts"]) {
    (await Deno.readTextFile(new URL(f, dir))).split("\n").forEach((l, i) => { if (echo.test(l)) hits.push(`${f.slice(3)}:${i + 1}: ${l.trim()}`); });
  }
  assert(hits.length === 0, `${hits.length} responses carry a caught exception's message:\n${hits.join("\n")}`);
});
