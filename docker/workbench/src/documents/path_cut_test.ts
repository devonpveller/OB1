// deno test --allow-env src/documents/path_cut_test.ts - rw-doc-path-spaces. documentPathsIn is a free-text scanner: it
// stops at whitespace and at " ' ? & # , ). Every ownership check that reads a path through it must still judge a
// path whose folder name holds those characters as the path it is, never as a shorter one that happens to be
// someone else's or no one's. Pure (a stub of the listing table); the two-identity cases on a real database are in
// the flags lab (src/contracts/flags_integration_test.ts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import { CUT_AFTER, documentPathsIn, ownsDocumentPaths, singleDocumentPath } from "./ownership.ts";

type Row = { path: string; owner_sub: string };
// A stub of public.user_document_listings that answers the two statements ownsDocumentPaths may send, by their shape: an
// equality match on the caller's own rows, and (if sent) the PREFIX match (starts_with) on anyone else's. The stub CANNOT
// stand in for Postgres's regex classes - which is why the next-character decision is made in JS, not in SQL (see the
// code-point test below, and the lab cases that run on a real pg16: every JS-only space, in flags_integration_test.ts).
function listings(rows: Row[]): Db {
  const db: Db = {
    query: <T>(sql: string, p: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ");
      if (/owner_sub <> \$2/.test(s)) {
        assert(/starts_with\(/.test(s) && !/ ~ /.test(s), "the other owners' rows are found by prefix, not by a database regex class");
        const pre = p[0] as string[];
        return Promise.resolve(rows.filter((r) => r.owner_sub !== p[1] && pre.some((x) => r.path.startsWith(x) && r.path.length > x.length)).map((r) => ({ path: r.path })) as T[]);
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

// The class the legacy-prefix check uses must be the scanner's own, character for character. Over every BMP code point:
// the scanner cuts `documents/x<c>y.md` at <c> exactly when CUT_AFTER matches <c>.
Deno.test("CUT_AFTER is exactly the scanner's stop class (every code point)", () => {
  const bad: string[] = [];
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCharCode(cp);
    if (cp < 0x20 || cp === 0x7f || c === "/" || c === "\\") continue; // control characters are refused earlier; / and \ are separators
    const scanned = documentPathsIn(`documents/x${c}y.md`);
    const cutsHere = scanned.length === 1 && scanned[0] === "documents/x";
    if (cutsHere !== CUT_AFTER.test(c)) bad.push(`U+${cp.toString(16).padStart(4, "0")} scanner-cuts=${cutsHere} CUT_AFTER=${CUT_AFTER.test(c)}`);
  }
  assertEquals(bad, []);
});

// every space JavaScript's \s knows that Postgres's \s (en_US.utf8) does not: the tester's case 7
const JS_ONLY_SPACES = [" ", "﻿", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", "　", " ", " ", " ", "", "  "];
Deno.test("legacy paths: a cut at a JavaScript-only space is refused like any other cut", async () => {
  for (const sp of JS_ONLY_SPACES) {
    const db = listings([{ path: "documents/team.md", owner_sub: "ak-b" }, { path: `documents/team.md${sp}copy.md`, owner_sub: "ak-a" }]);
    assertEquals(await owns(db, B, `documents/team.md${sp}copy.md`), false, `U+${[...sp].map((c) => c.charCodeAt(0).toString(16)).join("+")}`);
  }
});

Deno.test("singleDocumentPath: exact lower-case documents/, no encoded dots, no control characters", () => {
  assertEquals(singleDocumentPath("documents/ak-a/Old notes/x.md"), "documents/ak-a/Old notes/x.md");
  for (const bad of ["Documents/ak-a/x.md", "DOCUMENTS/ak-a/x.md", "documents/ak-a/%2e%2e/x.md", "documents/ak-a/%2E%2E/x.md", "documents/ak-a/%252e%252e/x.md", "documents/ak-a/%2e/x.md",
      "documents/ak-a/../x.md", "documents/ak-a//x.md", "documents/", "documents", "notes/x.md", "documents/ak-a/x.md"]) {
    assertEquals(singleDocumentPath(bad), null, bad);
  }
  assertEquals(singleDocumentPath("documents/ak-a/..a/x.md"), "documents/ak-a/..a/x.md"); // dots inside a name are a name
  assertEquals(singleDocumentPath("documents/ak-a/100%2e5/x.md"), "documents/ak-a/100%2e5/x.md");
});

// Review 1 / B1: the own-key skip is for documents/<key>/... only. `documents/<key> notes.md` (a legacy root file of someone
// else) is cut by the scanner to exactly `documents/<key>`, which the caller "owns" - unless the bare key is judged as a prefix.
const AFTER_KEY = [" notes.md", ",old.md", "#1.md", " (copy).md", ")x.md", "'s.md", "&x.md", "?x.md", '"x.md', " notes.md", "　notes.md", "﻿notes.md"];
Deno.test("B1: a legacy root file named `<own key><stop character>...` is never judged as the caller's own directory", async () => {
  for (const tail of AFTER_KEY) {
    const full = `documents/ak-a${tail}`;
    const db = listings([{ path: full, owner_sub: "operator" }]);
    assertEquals(await owns(db, A, full), false, `A naming operator's ${JSON.stringify(full)}`);
    // the caller's own directory, and a file in it, stay theirs when no such neighbour exists
    assertEquals(await owns(listings([]), A, "documents/ak-a"), true);
    assertEquals(await owns(listings([]), A, "documents/ak-a/x.md"), true);
    // and a file inside the own directory is theirs even where the neighbour exists (a slash is not a stop character)
    assertEquals(await owns(db, A, "documents/ak-a/x.md"), true);
  }
});
