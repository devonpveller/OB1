// deno test --allow-env src/documents/path_cut_test.ts - rw-doc-path-spaces. documentPathsIn is a free-text scanner: it
// stops at whitespace and at " ' ? & # , ). Every ownership check that reads a path through it must still judge a
// path whose folder name holds those characters as the path it is, never as a shorter one that happens to be
// someone else's or no one's. Pure (a stub of the listing table); the two-identity cases on a real database are in
// the flags lab (src/contracts/flags_integration_test.ts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import { documentPathsIn, ownsDocumentPaths } from "./ownership.ts";

type Row = { path: string; owner_sub: string };
// A stub of public.user_document_listings that answers the two statements ownsDocumentPaths may send, by their shape:
// an equality match on the caller's own rows, and (if sent) a prefix-at-a-terminator match on anyone else's.
function listings(rows: Row[]): Db {
  const db: Db = {
    query: <T>(sql: string, p: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ");
      if (/owner_sub <> \$2/.test(s)) {
        const res = (p[0] as string[]).map((r) => new RegExp(r));
        return Promise.resolve(rows.filter((r) => r.owner_sub !== p[1] && res.some((re) => re.test(r.path))).map((r) => ({ path: r.path })) as T[]);
      }
      const mine = new Set([...(p[0] as string[]), ...(p[2] as string[])]);
      return Promise.resolve(rows.filter((r) => r.owner_sub === p[1] && mine.has(r.path)).map((r) => ({ path: r.path })) as T[]);
    },
    tx: (fn) => fn(db),
  };
  return db;
}
const A = { sub: "ak-a", key: "ak-a" } as never;
const B = { sub: "ak-b", key: "ak-b" } as never;
const owns = (db: Db, who: never, s: string) => ownsDocumentPaths(db, documentPathsIn(s), who);

const ODD = ["Old notes", "a&b", "a,b", "it's", "a(b)", "a#b", "a?b"];

Deno.test("keyed paths: a space or punctuation after the key can never change whose document it is", async () => {
  const db = listings([]);
  for (const f of ODD) {
    assertEquals(await owns(db, B, `documents/ak-a/${f}/cpu.md`), false, `B naming A's ${f}`);
    assertEquals(await owns(db, A, `documents/ak-a/${f}/cpu.md`), true, `A naming A's ${f}`);
    assertEquals(await owns(db, B, `documents/ak-a/${f}/../${f}/cpu.md`), false, `B naming A's ${f} (dots)`);
  }
  // the key segment itself is a SAFE name ([A-Za-z0-9._-]): there is nothing in it for the scanner to stop at
  assertEquals(await owns(listings([]), B, "documents/ak-a /x.md"), false);
  assertEquals(await owns(listings([]), B, "documents/ak-a /x.md"), false);
});

Deno.test("legacy paths (documents/<file>.md, owner = the listing row): a cut path is never checked as someone else's own", async () => {
  // A's legacy file has a space after a prefix that is B's own legacy file
  const db = listings([
    { path: "documents/team.md", owner_sub: "ak-b" },
    { path: "documents/team.md copy.md", owner_sub: "ak-a" },
    { path: "documents/.trash/gone.md", owner_sub: "ak-b" },
    { path: "documents/.trash/gone.md,old.md", owner_sub: "ak-a" },
  ]);
  assertEquals(await owns(db, B, "documents/team.md copy.md"), false, "B naming A's 'team.md copy.md'");
  assertEquals(await owns(db, B, "documents/.trash/gone.md,old.md"), false, "B naming A's 'gone.md,old.md'");
  // and nothing else changed: B's own file is still B's, a missing one is still refused
  assertEquals(await owns(db, B, "documents/none.md"), false);
  // B's own file with no such neighbour is still B's; where the neighbour exists the scanner cannot tell 'team.md'
  // from the cut of 'team.md copy.md', so it answers as for a missing document (fail closed, legacy files only)
  const quiet = listings([{ path: "documents/solo.md", owner_sub: "ak-b" }, { path: "documents/solo-2.md", owner_sub: "ak-a" }]);
  assertEquals(await owns(quiet, B, "documents/solo.md"), true);
  assertEquals(await owns(db, B, "documents/team.md"), false);
  assert(true);
});
