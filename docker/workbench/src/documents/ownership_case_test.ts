// deno test --allow-env src/documents/ownership_case_test.ts - rw-identity-harden round 2 (tester
// t-id-harden F-T1). On a case-insensitive vault mount (a Windows or macOS bind mount)
// `Documents/<other>/x.md` opens the same file as `documents/<other>/x.md`; the owner scope and the
// routes' own ?path= check must see it as a documents path too, and refuse it as another user's.
// The image build runs this file (the test stage's gate; pure, no database is reached).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import { documentPathsIn, ownsDocumentPaths } from "./ownership.ts";

const NO_DB: Db = { query: () => Promise.resolve([]), tx: (fn) => fn(NO_DB) };
const carol = { sub: "ak-carol", key: "ak-carol" } as never;

Deno.test("F-T1: a documents path in any letter case is found, and another user's is refused", async () => {
  const fails: string[] = [];
  for (const p of ["Documents/ak-dave/x.md", "DOCUMENTS/ak-dave/x.md", "dOcUmEnTs/ak-dave/x.md", "notes/../Documents/ak-dave/x.md",
      "Documents/.trash/legacy.md", "x=Documents/ak-dave/x.md", "documents/AK-DAVE/x.md"]) {
    const found = documentPathsIn(p);
    if (!found.length) { fails.push(`${p}: not seen as a documents path`); continue; }
    if (await ownsDocumentPaths(NO_DB, found, carol)) fails.push(`${p}: ${JSON.stringify(found)} judged carol's own`);
  }
  // the caller's own directory, as written, is still hers
  assertEquals(await ownsDocumentPaths(NO_DB, documentPathsIn("documents/ak-carol/mine.md"), carol), true);
  // a path that is not under documents/ is still not per-user
  assertEquals(documentPathsIn("notes/documentsx/a.md"), []);
  assert(fails.length === 0, fails.join("\n"));
});
