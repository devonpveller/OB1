/**
 * Phase 1 — per-job research contract (policy-as-data).
 *
 * A contract rides inside `research_jobs.options.contract` (jsonb, no schema
 * change) and DECLARES what a single job is allowed to do: which sources it may
 * pull, how much budget it may spend, and any hard red lines. It is:
 *   - narrowing-only — a contract can only tighten the service's standing limits,
 *     never widen egress, raise a ceiling, or disable injection defense;
 *   - fail-closed — a malformed contract throws `ContractError` so the job errors
 *     rather than running wide-open (silently ignoring a red line is the danger);
 *   - pure data — `ResolvedContract` is JSON-serializable so it echoes verbatim
 *     into `result.contract` ("no traces, no trust", applied to scope).
 *
 * This module has NO I/O and NO dependency on the harness/deps, so it is fully
 * unit-testable (see contract.test.ts). Enforcement lives at two call sites:
 *   - index.ts wraps searchWeb/fetchPage with permitsUrl/permitsQuery (source +
 *     red-line query enforcement) — the gather loop is untouched;
 *   - harness.ts clamps the backstop budget and drops denied seeds.
 *
 * Governing plan: documentation/implementation-guide/supervised-research-pipeline/
 *   TASKS-phase1-contract.md.
 */
import { domainOf } from "./lib.ts";

/** Raw contract as a caller writes it under options.contract (all fields optional). */
export interface ResearchContract {
  sources?: { allow?: string[]; deny?: string[]; classes?: string[] };
  budget?: { max_fetch?: number; wall_ms?: number; rounds?: number };
  redlines?: string[];
}

/** Compiled, validated, JSON-serializable contract (echoed into result.contract). */
export interface ResolvedContract {
  allowDomains: string[]; // non-empty ⇒ default-deny outside the set (discovered sources only)
  denyDomains: string[];  // deny always wins over allow; red-line hosts merged in
  budget: { maxFetch?: number; wallMs?: number; rounds?: number };
  redlines: string[];
}

export class ContractError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ContractError";
  }
}

/** Named source sets → domain globs. Representative + operator-extensible. */
export const CLASS_REGISTRY: Record<string, string[]> = {
  advisories: [
    "nvd.nist.gov", "cve.mitre.org", "cve.org", "cisa.gov", "us-cert.gov",
    "cert.org", "first.org", "msrc.microsoft.com", "security.apple.com",
    "security.paloaltonetworks.com", "tools.cisco.com",
  ],
  academic: ["arxiv.org", "acm.org", "ieee.org", "usenix.org", "*.edu"],
  "vendor-psirt": [
    "msrc.microsoft.com", "security.apple.com", "security.paloaltonetworks.com",
    "tools.cisco.com", "psirt.global.sonicwall.com",
  ],
};

/** Known red lines. Extend the union in ResearchContract + the switch as they grow. */
export const KNOWN_REDLINES = new Set(["no_exploit_fetch"]);

/** Hosts the `no_exploit_fetch` red line denies (exploit/PoC distribution). */
const EXPLOIT_HOSTS = [
  "exploit-db.com", "packetstormsecurity.com", "0day.today", "seebug.org",
];

/** Queries that operationalize an exploit — dropped under `no_exploit_fetch`.
 *  Deliberately targets *operationalizing* terms, NOT threat-intel mentions
 *  ("actively exploited in the wild" is legitimate and must pass). */
const EXPLOIT_QUERY_RE =
  /\b(proof[- ]?of[- ]?concept|poc|exploit code|working exploit|how to exploit|weaponi[sz]e|metasploit|shellcode|reverse shell|payload delivery)\b/i;

const uniq = (a: string[]): string[] => [...new Set(a)];

function asStrArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ContractError(`contract.${field} must be an array of strings`);
  }
  return v as string[];
}

function asPosInt(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ContractError(`contract.${field} must be a positive integer`);
  }
  return v;
}

/**
 * Resolve options.contract into a validated ResolvedContract, or null when no
 * contract is declared (⇒ today's unconstrained behavior). Throws ContractError
 * (fail-closed) on anything malformed — the job then errors instead of running
 * wide-open.
 */
export function resolveContract(options: Record<string, unknown> | null | undefined): ResolvedContract | null {
  const raw = options?.contract;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractError("contract must be an object");
  }
  const c = raw as ResearchContract;

  const sources = c.sources ?? {};
  if (typeof sources !== "object" || Array.isArray(sources)) {
    throw new ContractError("contract.sources must be an object");
  }
  const allow = asStrArray(sources.allow, "sources.allow");
  const deny = asStrArray(sources.deny, "sources.deny");
  const classes = asStrArray(sources.classes, "sources.classes");
  for (const cls of classes) {
    const domains = CLASS_REGISTRY[cls];
    if (!domains) throw new ContractError(`unknown source class: ${cls}`);
    allow.push(...domains);
  }

  const redlines = asStrArray(c.redlines, "redlines");
  for (const r of redlines) {
    if (!KNOWN_REDLINES.has(r)) throw new ContractError(`unknown red line: ${r}`);
  }
  if (redlines.includes("no_exploit_fetch")) deny.push(...EXPLOIT_HOSTS);

  const budgetRaw = c.budget ?? {};
  if (typeof budgetRaw !== "object" || Array.isArray(budgetRaw)) {
    throw new ContractError("contract.budget must be an object");
  }
  const budget: ResolvedContract["budget"] = {};
  const maxFetch = asPosInt(budgetRaw.max_fetch, "budget.max_fetch");
  const wallMs = asPosInt(budgetRaw.wall_ms, "budget.wall_ms");
  const rounds = asPosInt(budgetRaw.rounds, "budget.rounds");
  if (maxFetch !== undefined) budget.maxFetch = maxFetch;
  if (wallMs !== undefined) budget.wallMs = wallMs;
  if (rounds !== undefined) budget.rounds = rounds;

  return {
    allowDomains: uniq(allow),
    denyDomains: uniq(deny),
    budget,
    redlines: uniq(redlines),
  };
}

/** `*.nist.gov`, `nist.gov` → both match host-or-subdomain (nvd.nist.gov, nist.gov). */
export function matchDomain(host: string, glob: string): boolean {
  const h = host.toLowerCase();
  const base = glob.toLowerCase().replace(/^\*\./, "");
  return h === base || h.endsWith("." + base);
}

/** True if the URL's host matches any deny-domain (red-line hosts included). */
export function deniedUrl(rc: ResolvedContract, url: string): boolean {
  const host = domainOf(url);
  if (!host) return false; // a non-URL host can't match a domain rule
  return rc.denyDomains.some((g) => matchDomain(host, g));
}

/**
 * Contract decision for a DISCOVERED source (search hit / fetch URL). deny wins;
 * a non-empty allow-list is default-deny outside the set. NB: caller seeds are
 * exempt from the allow-list (they are the subject in article mode) — use
 * deniedUrl for seeds, which enforces deny + red lines only.
 */
export function permitsUrl(rc: ResolvedContract, url: string): boolean {
  const host = domainOf(url);
  if (rc.denyDomains.some((g) => matchDomain(host, g))) return false;
  if (rc.allowDomains.length === 0) return true;
  if (!host) return false; // can't be on the allow-list without a resolvable host
  return rc.allowDomains.some((g) => matchDomain(host, g));
}

/** Contract decision for a generated search/deepen query (red-line query guard). */
export function permitsQuery(rc: ResolvedContract, query: string): boolean {
  if (rc.redlines.includes("no_exploit_fetch") && EXPLOIT_QUERY_RE.test(query)) return false;
  return true;
}

/**
 * Effective ceiling = the tighter of the service default and the contract's cap.
 * The narrowing-only invariant: a contract can only LOWER a ceiling, never raise
 * it (a cap above the default is ignored). Undefined cap ⇒ the service default.
 */
export function clampCeiling(serviceDefault: number, contractCap: number | undefined): number {
  return Math.min(serviceDefault, contractCap ?? Infinity);
}
