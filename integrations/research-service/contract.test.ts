/** Pure-logic tests for the Phase 1 per-job contract. Run: deno test contract.test.ts */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveContract, matchDomain, permitsUrl, permitsQuery, deniedUrl, clampCeiling,
  ContractError, CLASS_REGISTRY, type ResolvedContract,
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
