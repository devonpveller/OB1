/** Pure-logic tests for the Phase 1 per-job contract. Run: deno test contract.test.ts */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveContract, matchDomain, permitsUrl, permitsQuery, deniedUrl, clampCeiling,
  ContractError, CLASS_REGISTRY, type ResolvedContract,
  newContractDrops, recordDrop, MAX_RECORDED_DROPS,
} from "./contract.ts";

// ── resolveContract ──────────────────────────────────────────────────────────
Deno.test("no contract key ⇒ null (today's behavior)", () => {
  assertEquals(resolveContract(undefined), null);
  assertEquals(resolveContract({}), null);
  assertEquals(resolveContract({ mode: "article" }), null);
});

Deno.test("classes expand into allowDomains", () => {
  const rc = resolveContract({ contract: { sources: { classes: ["advisories"] } } })!;
  assertEquals(rc.allowDomains.includes("nvd.nist.gov"), true);
  assertEquals(rc.allowDomains.includes("cve.mitre.org"), true);
  // allow list contains exactly the (deduped) registry domains
  assertEquals(rc.allowDomains.length, new Set(CLASS_REGISTRY.advisories).size);
});

Deno.test("explicit allow + class merge and dedupe", () => {
  const rc = resolveContract({
    contract: { sources: { allow: ["nvd.nist.gov", "example.com"], classes: ["advisories"] } },
  })!;
  // nvd.nist.gov appears once despite being in both allow + the class
  assertEquals(rc.allowDomains.filter((d) => d === "nvd.nist.gov").length, 1);
  assertEquals(rc.allowDomains.includes("example.com"), true);
});

Deno.test("no_exploit_fetch merges exploit hosts into deny", () => {
  const rc = resolveContract({ contract: { redlines: ["no_exploit_fetch"] } })!;
  assertEquals(rc.denyDomains.includes("exploit-db.com"), true);
  assertEquals(rc.redlines.includes("no_exploit_fetch"), true);
});

Deno.test("budget parses positive integers", () => {
  const rc = resolveContract({ contract: { budget: { max_fetch: 20, wall_ms: 60000, rounds: 2 } } })!;
  assertEquals(rc.budget, { maxFetch: 20, wallMs: 60000, rounds: 2 });
});

Deno.test("fail-closed: malformed contracts throw ContractError", () => {
  assertThrows(() => resolveContract({ contract: 42 }), ContractError);
  assertThrows(() => resolveContract({ contract: [] }), ContractError);
  assertThrows(() => resolveContract({ contract: { sources: { allow: "nist.gov" } } }), ContractError);
  assertThrows(() => resolveContract({ contract: { sources: { allow: [1, 2] } } }), ContractError);
  assertThrows(() => resolveContract({ contract: { sources: { classes: ["nope"] } } }), ContractError);
  assertThrows(() => resolveContract({ contract: { redlines: ["no_such_redline"] } }), ContractError);
  assertThrows(() => resolveContract({ contract: { budget: { max_fetch: 0 } } }), ContractError);
  assertThrows(() => resolveContract({ contract: { budget: { max_fetch: 2.5 } } }), ContractError);
  assertThrows(() => resolveContract({ contract: { budget: { wall_ms: -1 } } }), ContractError);
});

// ── matchDomain ──────────────────────────────────────────────────────────────
Deno.test("matchDomain: glob + bare both match host-or-subdomain", () => {
  assertEquals(matchDomain("nvd.nist.gov", "*.nist.gov"), true);
  assertEquals(matchDomain("nist.gov", "*.nist.gov"), true);
  assertEquals(matchDomain("nvd.nist.gov", "nist.gov"), true);
  assertEquals(matchDomain("NIST.GOV", "nist.gov"), true); // case-fold
});

Deno.test("matchDomain: no suffix-spoof match", () => {
  // a look-alike domain must NOT match the base
  assertEquals(matchDomain("nist.gov.evil.com", "nist.gov"), false);
  assertEquals(matchDomain("notnist.gov", "nist.gov"), false);
  assertEquals(matchDomain("example.com", "nist.gov"), false);
});

// ── permitsUrl / deniedUrl ───────────────────────────────────────────────────
const allowOnly: ResolvedContract = { allowDomains: ["nist.gov"], denyDomains: [], budget: {}, redlines: [] };
const denyOne: ResolvedContract = { allowDomains: [], denyDomains: ["evil.com"], budget: {}, redlines: [] };
const both: ResolvedContract = { allowDomains: ["nist.gov"], denyDomains: ["nist.gov"], budget: {}, redlines: [] };
const empty: ResolvedContract = { allowDomains: [], denyDomains: [], budget: {}, redlines: [] };

Deno.test("permitsUrl: empty contract permits all", () => {
  assertEquals(permitsUrl(empty, "https://anything.example.com/x"), true);
});

Deno.test("permitsUrl: non-empty allow is default-deny outside the set", () => {
  assertEquals(permitsUrl(allowOnly, "https://nvd.nist.gov/vuln"), true);
  assertEquals(permitsUrl(allowOnly, "https://randomblog.com/post"), false);
});

Deno.test("permitsUrl: deny beats allow", () => {
  assertEquals(permitsUrl(both, "https://nvd.nist.gov/vuln"), false);
});

Deno.test("permitsUrl: deny-only blocks the denied host, permits the rest", () => {
  assertEquals(permitsUrl(denyOne, "https://evil.com/x"), false);
  assertEquals(permitsUrl(denyOne, "https://good.com/x"), true);
});

Deno.test("deniedUrl: only checks deny (allow-list is irrelevant for seeds)", () => {
  // allow-only contract: a seed NOT on the allow-list is still not "denied"
  assertEquals(deniedUrl(allowOnly, "https://randomblog.com/post"), false);
  assertEquals(deniedUrl(denyOne, "https://evil.com/x"), true);
});

// ── permitsQuery (red-line query guard) ──────────────────────────────────────
const redline: ResolvedContract = { allowDomains: [], denyDomains: [], budget: {}, redlines: ["no_exploit_fetch"] };

Deno.test("permitsQuery: drops operationalizing queries under no_exploit_fetch", () => {
  assertEquals(permitsQuery(redline, "CVE-2024-1234 proof of concept"), false);
  assertEquals(permitsQuery(redline, "how to exploit CVE-2024-1234"), false);
  assertEquals(permitsQuery(redline, "metasploit module for CVE-2024-1234"), false);
});

Deno.test("permitsQuery: permits legitimate threat-intel phrasing", () => {
  // 'actively exploited in the wild' is intel, not operationalizing → must pass
  assertEquals(permitsQuery(redline, "CVE-2024-1234 actively exploited in the wild"), true);
  assertEquals(permitsQuery(redline, "Fortinet advisory severity CVE-2024-1234"), true);
});

Deno.test("permitsQuery: no red line ⇒ everything passes", () => {
  assertEquals(permitsQuery(empty, "how to exploit anything"), true);
});

// ── clampCeiling (narrowing-only invariant) ──────────────────────────────────
Deno.test("clampCeiling: a contract can only LOWER a ceiling", () => {
  assertEquals(clampCeiling(24, 10), 10);          // narrows
  assertEquals(clampCeiling(24, 100), 24);          // a cap ABOVE the default is ignored (never raises)
  assertEquals(clampCeiling(24, undefined), 24);    // no cap ⇒ service default
  assertEquals(clampCeiling(180000, 60000), 60000); // wall_ms narrows
});

// ════════════════════════════════════════════════════════════════════════════
// kp-contract (operator D11/D12, 2026-10-15): path-prefix entries matched on the
// NORMALISED final URL, a software-docs class, fail-closed on what cannot be named.
// ════════════════════════════════════════════════════════════════════════════
const rcOf = (sources: Record<string, unknown>) => resolveContract({ contract: { sources } })!;

/** agent-bridge app/config.py DEFAULT_KNOWLEDGE_SOURCE_HOSTS at development c1bc20a0. */
const AGENT_BRIDGE_DEFAULT_HOSTS =
  "docs.python.org,peps.python.org,docs.pytest.org,www.python-httpx.org," +
  "docs.pydantic.dev,fastapi.tiangolo.com,www.starlette.io,docs.sqlalchemy.org," +
  "docs.aiohttp.org,docs.djangoproject.com,flask.palletsprojects.com,numpy.org/doc," +
  "pandas.pydata.org/docs,developer.mozilla.org/en-US/docs,nodejs.org/api,docs.deno.com," +
  "www.typescriptlang.org/docs,doc.rust-lang.org,go.dev/doc,go.dev/ref," +
  "learn.microsoft.com/en-us/dotnet/api,learn.microsoft.com/en-us/dotnet/csharp," +
  "learn.microsoft.com/en-us/dotnet/standard,learn.microsoft.com/en-us/dotnet/core," +
  "docs.docker.com,git-scm.com/docs,www.postgresql.org/docs";

Deno.test("software-docs class = agent-bridge's DEFAULT_KNOWLEDGE_SOURCE_HOSTS, no GitHub, resolves", () => {
  assertEquals(CLASS_REGISTRY["software-docs"], AGENT_BRIDGE_DEFAULT_HOSTS.split(","));
  assertEquals(CLASS_REGISTRY["software-docs"].some((e) => /github/i.test(e)), false);
  const c = rcOf({ classes: ["software-docs"] });
  assertEquals(c.allowDomains, AGENT_BRIDGE_DEFAULT_HOSTS.split(","));
  assertEquals(permitsUrl(c, "https://docs.python.org/3/library/asyncio.html"), true);
  assertEquals(permitsUrl(c, "https://numpy.org/doc/stable/reference/"), true);
  assertEquals(permitsUrl(c, "https://numpy.org/news/"), false);           // the host only via its prefix
  assertEquals(permitsUrl(c, "https://www.python-httpx.org/async/"), true); // a www. entry matches its own host
  assertEquals(permitsUrl(c, "https://github.com/encode/httpx/issues/1"), false);
  assertEquals(permitsUrl(c, "https://stackoverflow.com/q/1"), false);
});

Deno.test("path-prefix: whole segments only, exact host, on the normalised URL", () => {
  const c = rcOf({ allow: ["numpy.org/doc"] });
  for (const u of [
    "https://numpy.org/doc", "https://numpy.org/doc/", "https://numpy.org/doc/stable/x.html",
    "https://NUMPY.ORG/doc/stable/", "https://numpy.org./doc/stable/", "http://numpy.org/doc/1.26/",
    "https://numpy.org/%64oc/stable/",                         // an unreserved escape names the same path
    "https://numpy.org/doc/stable/x.html?q=../../news#../x",   // query / fragment are not the path
  ]) assertEquals(permitsUrl(c, u), true, u);
  for (const u of [
    "https://numpy.org/docs/", "https://numpy.org/doc-evil/", "https://numpy.org/DOC/stable/",
    "https://numpy.org/", "https://numpy.org", "https://numpy.org//doc/stable/",
    "https://sub.numpy.org/doc/", "https://numpy.org.evil.com/doc/", "https://evilnumpy.org/doc/",
    "https://numpy.org/doc/../news/", "https://numpy.org/doc/./../news/", "https://numpy.org/doc/.../x",
    "https://numpy.org/doc/%2e%2e/news/", "https://numpy.org/doc/.%2E/news/", "https://numpy.org/doc%2f..%2fnews",
    "https://numpy.org/doc%5c..%5cnews", "https://numpy.org/doc\\..\\news", "https://numpy.org/doc/..;/news",
    "https://numpy.org/doc/%252e%252e/news", "https://numpy.org/doc/%c0%ae%c0%ae/news",
    "https://numpy.org/doc/%e2%80%a5/news", "https://numpy.org/doc/%ef%bc%8e%ef%bc%8e/news",
    "https://numpy.org/doc/%00/x", "https://numpy.org/doc/%20/x", "https://numpy.org/doc/‥/x",
    "https://numpy.org/doc/ü", "https://numpy.org:8443/doc/", "https://user@numpy.org/doc/",
    "https://numpy.org@evil.com/doc/", "https://xn--nmpy-0ra.org/doc/", "ftp://numpy.org/doc/",
    "https://numpy.org/doc/%", "javascript:alert(1)//numpy.org/doc", "", "not a url",
  ]) assertEquals(permitsUrl(c, u), false, u);
});

Deno.test("host entries keep host-or-subdomain matching, on the normalised host", () => {
  const c = rcOf({ allow: ["docs.python.org", "*.example-docs.org"] });
  assertEquals(permitsUrl(c, "https://docs.python.org/3/"), true);
  assertEquals(permitsUrl(c, "https://a.docs.python.org/3/"), true);
  assertEquals(permitsUrl(c, "https://docs.python.org.evil.com/3/"), false);
  assertEquals(permitsUrl(c, "https://evildocs.python.org/3/"), false);
  assertEquals(permitsUrl(c, "https://a.example-docs.org/x"), true);
  assertEquals(permitsUrl(c, "https://example-docs.org.evil.com/x"), false);
});

Deno.test("deny entries take paths too, and a deny cannot be escaped by a URL trick", () => {
  const c = rcOf({ deny: ["example.com/private"] });
  assertEquals(permitsUrl(c, "https://example.com/public/x"), true);
  assertEquals(permitsUrl(c, "https://example.com/private"), false);
  assertEquals(permitsUrl(c, "https://example.com/private/x"), false);
  assertEquals(permitsUrl(c, "https://example.com/%70rivate/x"), false);          // decodes to /private
  assertEquals(permitsUrl(c, "https://example.com/public/../private/x"), false);  // refused: dot segment
  assertEquals(permitsUrl(c, "https://example.com/public/%2e%2e/private/x"), false);
  assertEquals(permitsUrl(c, "https://example.com/privatefoo"), true);             // whole segments
  assertEquals(deniedUrl(c, "https://example.com/private/x"), true);
  assertEquals(deniedUrl(c, "https://example.com/public/../private/x"), true);    // a seed is fail-closed too
  assertEquals(deniedUrl(c, "https://example.com/public"), false);
  assertEquals(deniedUrl(c, ""), false);                                          // a URL-less seed names no host
});

Deno.test("GitHub allow entries only as org/repo/blob|tree/<release-tag>; user-content hosts never", () => {
  const g = rcOf({ allow: ["github.com/agronholm/anyio/blob/4.4.0", "github.com/agronholm/anyio/tree/v4.4.0"] });
  assertEquals(permitsUrl(g, "https://github.com/agronholm/anyio/blob/4.4.0/README.rst"), true);
  assertEquals(permitsUrl(g, "https://github.com/agronholm/anyio/tree/v4.4.0/src/anyio"), true);
  for (const u of [
    "https://github.com/agronholm/anyio", "https://github.com/agronholm/anyio/issues/1",
    "https://github.com/agronholm/anyio/blob/main/README.rst", "https://github.com/agronholm/anyio/blob/4.4.0x/README.rst",
    "https://github.com/agronholm/anyio/blob/4.4.0/../main/x", "https://github.com/agronholm/anyio/blob/4.4.0/%2e%2e/main/x",
    "https://github.com/evil/anyio/blob/4.4.0/README.rst", "https://github.com/agronholm/anyio-evil/blob/4.4.0/x",
    "https://gist.github.com/agronholm/anyio/blob/4.4.0/x", "https://raw.githubusercontent.com/agronholm/anyio/4.4.0/x",
    "https://github.com/agronholm/anyio/tree/4.4.0/src", // the tree entry is v4.4.0, not 4.4.0
  ]) assertEquals(permitsUrl(g, u), false, u);
  for (const bad of [
    "github.com", "www.github.com", "GitHub.com.", "github.com/agronholm", "github.com/agronholm/anyio",
    "github.com/agronholm/anyio/blob/main", "github.com/agronholm/anyio/blob/0123456789abcdef0123456789abcdef01234567",
    "github.com/agronholm/anyio/blob/2024", "github.com/agronholm/anyio/issues/4.4.0",
    "github.com/agronholm/anyio/blob/4.4.0/src", "github.com/agronholm/anyio@4.4.0",
    "gist.github.com", "docs.github.com/en", "*.github.com", "raw.githubusercontent.com", "githubusercontent.com",
    "x.github.io", "github.io",
  ]) assertThrows(() => rcOf({ allow: [bad] }), ContractError, undefined, bad);
  // a DENY entry may name GitHub any way (a deny only narrows)
  assertEquals(permitsUrl(rcOf({ deny: ["github.com"] }), "https://github.com/x/y"), false);
});

Deno.test("malformed entries are a ContractError (fail-closed); valid forms resolve", () => {
  for (const bad of [
    "", " ", "*.x.com/docs", "https://x.com", "x.com/../y", "x.com/./y", "x.com/a b", "x.com//y", "x.com/",
    "*", "*.", "x", "localhost", "x.com:443", "user@x.com", "x.com/%2e%2e", "x.com\\y", "x.com/ü",
  ]) {
    assertThrows(() => rcOf({ allow: [bad] }), ContractError, undefined, `allow ${JSON.stringify(bad)}`);
    assertThrows(() => rcOf({ deny: [bad] }), ContractError, undefined, `deny ${JSON.stringify(bad)}`);
  }
  for (const okEntry of ["x.com", "X.COM.", "*.edu", "*.x.com", "x.com/a/b", "x.com/en-US/docs", "x.com/a.b~c_d-e"]) {
    rcOf({ allow: [okEntry] });
  }
});

Deno.test("fail-closed on a URL that cannot be named, but only when the contract has source rules", () => {
  const weird = "https://numpy.org/doc/../news/";
  assertEquals(permitsUrl(rcOf({ allow: ["numpy.org"] }), weird), false);
  assertEquals(permitsUrl(rcOf({ deny: ["evil.com"] }), weird), false);
  // a budget / red-line-only contract has no source rule: today's behaviour, everything passes
  const budgetOnly = resolveContract({ contract: { budget: { max_fetch: 3 } } })!;
  assertEquals(permitsUrl(budgetOnly, weird), true);
  assertEquals(permitsUrl(budgetOnly, "not a url"), true);
  // a source with NO url (a stored row without one) can sit on no allow-list and match no deny entry
  assertEquals(permitsUrl(rcOf({ allow: ["numpy.org"] }), ""), false);
  assertEquals(permitsUrl(rcOf({ deny: ["evil.com"] }), ""), true);
});

Deno.test("drop ledger: counts every drop per stage, keeps a bounded list", () => {
  const d = newContractDrops();
  for (let i = 0; i < MAX_RECORDED_DROPS + 5; i++) recordDrop(d, "search", `https://x.com/${i}`);
  recordDrop(d, "reuse", "https://y.com/a", "claim-1");
  assertEquals(d.counts.search, MAX_RECORDED_DROPS + 5);
  assertEquals(d.counts.reuse, 1);
  assertEquals(d.items.length, MAX_RECORDED_DROPS);
  assertEquals(d.truncated, 6);
  assertEquals(JSON.parse(JSON.stringify(d)).counts.reuse, 1); // echoes into result.contract_drops
});
