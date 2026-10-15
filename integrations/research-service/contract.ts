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
 * unit-testable (see contract.test.ts). Enforcement lives in harness.ts:
 *   - `withContract` wraps searchWeb/fetchPage with permitsUrl/permitsQuery
 *     (search hits, fetches and the FINAL url after redirects; red-line queries)
 *     — the gather loop is untouched;
 *   - runResearch clamps the backstop budget, drops denied seeds, and filters
 *     KB-recalled sources and reused claims (with their grounding sources).
 *   Every drop is recorded (`ContractDrops`, echoed as result.contract_drops).
 *
 * Source entries (kp-contract, operator D11 2026-10-15) are `host` / `*.suffix`
 * (host-or-subdomain, as before) or `host/path/prefix` (EXACT host, and the path
 * at or under the prefix on WHOLE segments). Both are matched on the url as
 * urlnorm.ts normalises it — the one normaliser, ported from the agent-bridge
 * rules. A url it cannot name is refused whenever the contract has a source rule
 * (fail-closed); a budget / red-line-only contract keeps today's behaviour. A
 * GitHub ALLOW entry must be `github.com/<org>/<repo>/blob|tree/<release-tag>`
 * (anyone can post issues and PRs under any repo, and GitHub serves fork commits
 * under the parent's URL); hosts where anyone publishes (gists, *.github.io,
 * *.githubusercontent.com) are never an allow entry. A malformed entry is a
 * ContractError.
 *
 * Governing plan: documentation/implementation-guide/supervised-research-pipeline/
 *   TASKS-phase1-contract.md; kp-contract: agent-knowledge-package/PLAN-v2.md.
 */
import { normaliseUrl, type NormalisedUrl } from "./urlnorm.ts";

/** Raw contract as a caller writes it under options.contract (all fields optional). */
export interface ResearchContract {
  sources?: { allow?: string[]; deny?: string[]; classes?: string[] };
  budget?: { max_fetch?: number; wall_ms?: number; rounds?: number };
  redlines?: string[];
}

/** Compiled, validated, JSON-serializable contract (echoed into result.contract). */
export interface ResolvedContract {
  // Entries: `host`, `*.suffix` or `host/path/prefix`, canonical spelling (see the header).
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
  // kp-contract (PLAN-v2 EXTEND b): the knowledge package's documentation sources,
  // moved here from agent-bridge app/config.py DEFAULT_KNOWLEDGE_SOURCE_HOSTS
  // (development c1bc20a0). No GitHub entry: a caller that needs a repo adds it
  // per job as github.com/<org>/<repo>/blob|tree/<release-tag>.
  "software-docs": [
    "docs.python.org", "peps.python.org", "docs.pytest.org", "www.python-httpx.org",
    "docs.pydantic.dev", "fastapi.tiangolo.com", "www.starlette.io", "docs.sqlalchemy.org",
    "docs.aiohttp.org", "docs.djangoproject.com", "flask.palletsprojects.com", "numpy.org/doc",
    "pandas.pydata.org/docs", "developer.mozilla.org/en-US/docs", "nodejs.org/api", "docs.deno.com",
    "www.typescriptlang.org/docs", "doc.rust-lang.org", "go.dev/doc", "go.dev/ref",
    "learn.microsoft.com/en-us/dotnet/api", "learn.microsoft.com/en-us/dotnet/csharp",
    "learn.microsoft.com/en-us/dotnet/standard", "learn.microsoft.com/en-us/dotnet/core",
    "docs.docker.com", "git-scm.com/docs", "www.postgresql.org/docs",
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
  // Validate every source entry NOW (fail-closed), kept in its canonical spelling.
  for (let i = 0; i < allow.length; i++) allow[i] = canonicalEntry(allow[i], "allow");
  for (let i = 0; i < deny.length; i++) deny[i] = canonicalEntry(deny[i], "deny");

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

// ── Source entries (kp-contract) ─────────────────────────────────────────────
const HOST_ENTRY_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const WILDCARD_ENTRY_RE = /^\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** A release tag (`4.4.0`, `v1.2.3`, `1.0.0-rc1`): never a sha, a bare number or a branch. */
const RELEASE_TAG_RE = /^v?\d+(?:\.\d+)+(?:[.-][A-Za-z0-9]+)*$/;
const USER_CONTENT_SUFFIXES = [".github.com", ".githubusercontent.com", ".github.io"];
const USER_CONTENT_HOSTS = new Set(["githubusercontent.com", "github.io"]);

type SourceRule =
  | { kind: "host"; base: string; spelled: string }   // host-or-subdomain of base
  | { kind: "prefix"; host: string; segs: string[] }; // exact host, whole-segment path prefix

/** Parse one entry into a rule, or throw ContractError. */
function parseEntry(raw: string, side: "allow" | "deny"): SourceRule {
  const e = typeof raw === "string" ? raw.trim() : "";
  const slash = e.indexOf("/");
  let host = (slash === -1 ? e : e.slice(0, slash)).toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const bad = (why: string) =>
    new ContractError(`contract.sources.${side} entry ${JSON.stringify(raw)}: ${why}`);
  const wildcard = host.startsWith("*.");
  if (wildcard ? !WILDCARD_ENTRY_RE.test(host) : !HOST_ENTRY_RE.test(host)) {
    throw bad("not a host, *.suffix or host/path/prefix");
  }
  const segs = slash === -1 ? [] : e.slice(slash + 1).split("/");
  if (slash !== -1) {
    if (wildcard) throw bad("a *.suffix entry takes no path");
    if (segs.some((sg) => !SEGMENT_RE.test(sg) || /^\.+$/.test(sg))) {
      throw bad("a path prefix is plain segments (no empty, dot or escaped segment)");
    }
  }
  const bare = wildcard ? host.slice(2) : host;
  if (side === "allow") {
    if (GITHUB_HOSTS.has(bare)) {
      if (wildcard) throw bad("*.github.com covers user content");
      const [org, repo, kind, tag] = segs;
      if (segs.length !== 4 || !GITHUB_ORG_RE.test(org) || !GITHUB_REPO_RE.test(repo) ||
          (kind !== "blob" && kind !== "tree") || !RELEASE_TAG_RE.test(tag)) {
        throw bad("GitHub only as github.com/<org>/<repo>/blob|tree/<release-tag>");
      }
    } else if (USER_CONTENT_HOSTS.has(bare) || USER_CONTENT_SUFFIXES.some((sfx) => bare.endsWith(sfx))) {
      throw bad("a host where anyone can publish is never an allow entry");
    }
  }
  if (slash === -1) return { kind: "host", base: bare, spelled: host };
  return { kind: "prefix", host, segs };
}

/** The entry in its canonical spelling (host lower-cased, root dot stripped). */
function canonicalEntry(raw: string, side: "allow" | "deny"): string {
  const r = parseEntry(raw, side);
  return r.kind === "prefix" ? `${r.host}/${r.segs.join("/")}` : r.spelled;
}

function ruleMatches(r: SourceRule, n: NormalisedUrl): boolean {
  if (r.kind === "host") return n.host === r.base || n.host.endsWith("." + r.base);
  return n.host === r.host && r.segs.length <= n.segs.length && r.segs.every((sg, i) => n.segs[i] === sg);
}

const rulesOf = (entries: string[], side: "allow" | "deny"): SourceRule[] =>
  entries.map((e) => parseEntry(e, side));

/** Does the contract constrain SOURCES at all (vs budget / red-line queries only)? */
export function hasSourceRules(rc: ResolvedContract): boolean {
  return rc.allowDomains.length > 0 || rc.denyDomains.length > 0;
}

/**
 * True if the url hits a deny entry (red-line hosts included). Seeds use this:
 * they are exempt from the allow-list, never from deny. A url that cannot be
 * normalised is denied when there is any deny entry (it could hide one); an
 * empty url (a seed without one) names no host and is not denied.
 */
export function deniedUrl(rc: ResolvedContract, url: string): boolean {
  if (rc.denyDomains.length === 0 || !url) return false;
  const n = normaliseUrl(url);
  if (!n) return true;
  return rulesOf(rc.denyDomains, "deny").some((r) => ruleMatches(r, n));
}

/**
 * Contract decision for a source: a search hit, a fetch (and its final url after
 * redirects), a KB-recalled source, a reused claim's grounding source. deny wins;
 * a non-empty allow-list is default-deny outside the set. Matching is on the
 * NORMALISED url (urlnorm.ts); a url that cannot be normalised is refused when
 * the contract has any source rule. An empty url (a stored source without one)
 * is on no allow-list and matches no deny entry. NB: caller seeds are exempt
 * from the allow-list (they are the subject in article mode) — use deniedUrl
 * for seeds, which enforces deny + red lines only.
 */
export function permitsUrl(rc: ResolvedContract, url: string): boolean {
  if (!hasSourceRules(rc)) return true;
  if (!url) return rc.allowDomains.length === 0;
  const n = normaliseUrl(url);
  if (!n) return false;
  if (rulesOf(rc.denyDomains, "deny").some((r) => ruleMatches(r, n))) return false;
  if (rc.allowDomains.length === 0) return true;
  return rulesOf(rc.allowDomains, "allow").some((r) => ruleMatches(r, n));
}

// ── What a contract dropped (echoed into result.contract_drops) ──────────────
export type ContractDropStage = "search" | "fetch" | "redirect" | "seed" | "kb_recall" | "reuse";
export interface ContractDrop { stage: ContractDropStage; url: string; claim_id?: string }
export interface ContractDrops {
  /** Every drop, per stage (never capped). */
  counts: Record<ContractDropStage, number>;
  /** The first MAX_RECORDED_DROPS drops; `truncated` counts the rest. */
  items: ContractDrop[];
  truncated: number;
}
export const MAX_RECORDED_DROPS = 200;
const DROP_URL_MAX = 500;

export function newContractDrops(): ContractDrops {
  return {
    counts: { search: 0, fetch: 0, redirect: 0, seed: 0, kb_recall: 0, reuse: 0 },
    items: [],
    truncated: 0,
  };
}

export function recordDrop(
  d: ContractDrops, stage: ContractDropStage, url: string | null | undefined, claimId?: string,
): void {
  d.counts[stage]++;
  if (d.items.length >= MAX_RECORDED_DROPS) { d.truncated++; return; }
  const item: ContractDrop = { stage, url: String(url ?? "").slice(0, DROP_URL_MAX) };
  if (claimId !== undefined) item.claim_id = claimId;
  d.items.push(item);
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
