// deno test --allow-read src/contracts/private_claim_reads_test.ts - no database (rw-private-claim-reads).
// A claim drawn from a person's PRIVATE idea report is marked in research_private_report_claims and is not shared
// material (slot 570's rule; library.ts, ideas.ts). This test keeps the reads of public.claims honest in two ways:
//   1. the helper's SQL: private-only = marked AND no shared synthesis filed it (slot 570's definition, init-private-report-claims.sql:18-22);
//      the owner exception goes through the marking report's owner, bound by parameter; a read with no caller excludes a
//      private-only claim outright; a mixed claim (synthesis_id set) is shared and never hidden;
//   2. a ledger of EVERY non-test read of public.claims (FROM / JOIN / USING) with its verdict. A "filtered" read must
//      carry the marker test in its own SQL statement (so dropping the filter from search or timeline turns this red
//      with no database); a "not shared" read states why. A read that is not in the ledger fails the test: whoever adds
//      one decides its verdict here, in the same change.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { claimNotPrivate, claimVisibleTo } from "./repo/private_claims.ts";

Deno.test("claimVisibleTo: an unmarked claim, or one marked by a report the caller owns; nobody else", () => {
  const sql = claimVisibleTo("c", "$4");
  assertStringIncludes(sql, "research_private_report_claims");
  assertStringIncludes(sql, "pc.claim_id = c.id");
  assertStringIncludes(sql, "pr.owner_sub = $4::text");
  assertStringIncludes(sql, "pcl.synthesis_id IS NULL"); // private-only: a mixed claim (a shared synthesis filed it) stays shared
  assertStringIncludes(sql, "research_private_reports pr");
  assert(sql.trimStart().startsWith("(NOT EXISTS"), "starts from 'not marked'");
});

Deno.test("claimVisibleTo with no caller, and claimNotPrivate: a marked claim is out, no owner exception", () => {
  for (const sql of [claimVisibleTo("x", null), claimNotPrivate("x")]) {
    assertStringIncludes(sql, "research_private_report_claims pc JOIN public.claims pcl ON pcl.id = pc.claim_id");
    assertStringIncludes(sql, "pc.claim_id = x.id AND pcl.synthesis_id IS NULL");
    assert(!sql.includes("owner_sub"), "no owner clause");
  }
});

type Verdict = "filtered" | "not shared";
// file -> its reads of public.claims, in source order: [alias, verdict, why / which filter]
const LEDGER: Record<string, [string, Verdict, string][]> = {
  "contracts/repo/gaps.ts": [["c", "not shared", "coveredBy answers a boolean over ids the caller's own run filed; no text, no id"]],
  "contracts/repo/ideas.ts": [
    ["c", "filtered", "producedOf: the idea's dossier claims; the marker branch is the OWNER's own report (idea owner only)"],
    ["c", "filtered", "contextGraph claim nodes: claimVisibleTo(owner)"],
  ],
  "contracts/repo/knowledge.ts": [
    ["c", "filtered", "neighbours 'contested' flag: claimVisibleTo(viewer)"],
    ["n", "filtered", "claims() contradicted_by_newer: the newer claim must be visible to the caller"],
    ["c", "filtered", "claims(): claimVisibleTo(owner)"],
    ["c", "not shared", "verdictsOf: verdicts by id for rows claims() already filtered"],
    ["c", "not shared", "enrich (filter branch): date/quality for hits search() already filtered"],
    ["c", "not shared", "enrich: date/quality/thread for hits search() already filtered"],
    ["c", "filtered", "search(): claimVisibleTo(owner or viewer)"],
    ["c", "filtered", "timeline(): claimVisibleTo(caller)"],
  ],
  "contracts/repo/library.ts": [
    ["c", "filtered", "waitingClaims: claimNotPrivate (shared library, no caller; a mixed claim stays shared)"],
    ["n", "filtered", "waitingClaims: the newer-claim join of a claim already filtered; a boolean"],
    ["c", "filtered", "recentSources count: claimNotPrivate"],
  ],
  "contracts/repo/lifecycle.ts": [
    ["c", "not shared", "scoped dependence: an existence test inside a metadata filter; returns the source's own rows"],
    ["c", "not shared", "suppress: the mean confidence of the source's edges, an aggregate stored in the suppression record; no text"],
    ["c", "not shared", "sever: a DELETE of an edge by id with the claim's synthesis id; the admin acts on the source's own edge"],
  ],
  "contracts/repo/pending_refs.ts": [["c", "filtered", "add: a private-report claim not the caller's answers as a missing claim"]],
  "contracts/repo/sources.ts": [
    ["lc", "filtered", "quality(): scoped corroboration line"],
    ["cl", "filtered", "quality(): co-grounds claim text"],
    ["cl", "filtered", "quality(): contradicted claim text"],
    ["mc", "filtered", "quality(): own claim of a contradicting pair"],
    ["other", "filtered", "quality(): the contradicting claim's text"],
  ],
  "contracts/repo/trust.ts": [["c", "not shared", "sessionLinks: source ids of a report's claims; the claim row is not returned"]],
  "documents/hub.ts": [
    ["c", "filtered", "seedsOf: a [[claim:id]] link expands to the claim's sources only when the claim is visible to the viewer"],
    ["c", "filtered", "hub markers: contested claim text, claimVisibleTo(viewer)"],
  ],
  "documents/seed.ts": [["c", "not shared", "reads one claim's synthesis id for the idea owner's own dossier claims; no text"]],
};
const TOKEN = /claimVisibleTo\(|claimNotPrivate\(|research_private_report_claims/;
const SRC = new URL("../", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) yield* walk(new URL(`${e.name}/`, dir));
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) yield new URL(e.name, dir);
  }
}

Deno.test("ledger: every non-test read of public.claims has a verdict; a filtered read carries the marker test", async () => {
  const seen: Record<string, { alias: string; stmt: string }[]> = {};
  for await (const f of walk(SRC)) {
    const rel = f.href.slice(SRC.href.length);
    if (rel === "contracts/repo/private_claims.ts") continue; // the rule itself reads claims.synthesis_id
    const text = (await Deno.readTextFile(f)).replace(/\r\n/g, "\n");
    for (const m of text.matchAll(/\b(?:FROM|JOIN|USING)\s+public\.claims\b(?!_)\s*(\w+)?/g)) {
      const start = text.lastIndexOf("`", m.index!), end = text.indexOf("`", m.index! + 1);
      (seen[rel] ??= []).push({ alias: m[1] ?? "", stmt: text.slice(start, end) });
    }
  }
  assertEquals(Object.keys(seen).sort(), Object.keys(LEDGER).sort(), "the files that read public.claims");
  for (const [file, reads] of Object.entries(LEDGER)) {
    const got = seen[file];
    assertEquals(got.length, reads.length, `${file}: ${got.length} reads of public.claims, ${reads.length} in the ledger - give each new read a verdict`);
    reads.forEach(([alias, verdict, why], i) => {
      assertEquals(got[i].alias, alias, `${file} read #${i + 1} (${why})`);
      if (verdict === "filtered") assert(TOKEN.test(got[i].stmt), `${file} read #${i + 1} (${why}) must carry the private-report marker test`);
    });
  }
});

Deno.test("search, timeline and claims go through claimVisibleTo with the caller's subject", async () => {
  const k = (await Deno.readTextFile(new URL("./repo/knowledge.ts", import.meta.url))).replace(/\r\n/g, "\n");
  for (const fn of ["export async function claims(", "export async function search(", "export async function timeline("]) {
    const i = k.indexOf(fn);
    assert(i >= 0, fn);
    const body = k.slice(i, k.indexOf("\nexport async function", i + 10) === -1 ? undefined : k.indexOf("\nexport async function", i + 10));
    assert(body.includes("claimVisibleTo("), `${fn} filters through claimVisibleTo`);
  }
});

Deno.test("dependence for a user: a private-report claim's edge is counted but its id and text are withheld", async () => {
  const l = (await Deno.readTextFile(new URL("./repo/lifecycle.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const i = l.indexOf("const OWNED_DEPENDENCE");
  const body = l.slice(i, l.indexOf("export async function dependence(", i));
  assert(body.includes("claimIdVisibleTo("), "OWNED_DEPENDENCE tests the claim edge's claim id");
  assert(body.includes("'private-claim:'") && body.includes("'a private claim'"), "the row is shown as a private claim, not by id or text");
});
