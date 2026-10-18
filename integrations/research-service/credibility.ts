/**
 * credibility.ts - the D15 credibility model (research-workbench P3a, rw-p3a-entail).
 *
 * The operator's model (01-OPEN-ITEMS D15 items 1-10), deterministic and pure:
 *   - every source belongs to one FAMILY (D15 item 10): `scholarly` when a DOI, PMID, PMCID or
 *     arXiv id RESOLVES, `general` otherwise. Each family is scored from its own signals only:
 *       scholarly  cited_by, author works_count, age            (the versioned paper score)
 *       general    author identity, the domain's credibility class, link structure,
 *                  entailment agreement with admitted claims
 *     and the score carries the family and the signals it was computed from;
 *   - the WEIGHT TABLE is keyed by claim kind AND family; a kind or a family with no row stops
 *     the gate with the kind named (item 9: "fails loudly ... rather than defaulting");
 *   - corroboration between sources is bidirectional and asymmetric and counts only when the
 *     entailment verdict for that claim is `supports` (item 3);
 *   - credibility is evaluated BEFORE ingestion (item 7): a hit is scored on what resolves about
 *     it before fetch, and only a hit at or above its kind's floor is ingested (admission.ts);
 *   - the per-reference totals roll up to a report credibility (item 5).
 *
 * Nothing here is a closed list (D18). Claim kinds, families, domain classes, the weight table,
 * the paper score versions and the entailment verdicts are registry entries
 * (`contract_registry_entries`, seeded by docker/init-research-credibility.sql); the model is
 * built from those rows by `buildModel`, and `loadCredibilityModel` reads them from the DB.
 * Adding a kind means adding its cue entry plus one weight row per family - no code.
 *
 * No I/O except `loadCredibilityModel` (one SELECT). Tests drive `buildModel` with the SQL seeds
 * parsed out of the migration file, so the tested model IS the shipped table.
 */

export class CredibilityGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredibilityGateError";
  }
}

export interface RegistryRow {
  registry: string;
  key: string;
  version: number;
  definition: Record<string, unknown>;
  retired_at?: string | null;
}

export interface ClaimKind {
  key: string;
  order: number;
  cues: RegExp[];
  fallback: boolean;
  /** Declared invariant: for this kind every scholarly source outranks every general one. */
  papersOutrank: boolean;
}

export interface WeightRow {
  kind: string;
  family: string;
  weight: number;
  /** Admission floor: a hit scored below it before fetch is a lead, never a source. */
  admissionFloor: number;
  /** Claim floor: the per-claim threshold the reuse gate and gap work read (D15 item 5). */
  claimFloor: number;
  /** general family only: the extra weight a primary source carries for this kind. */
  primaryBonus: number;
}

export interface DomainClass {
  key: string;
  order: number;
  score: number;
  patterns: RegExp[];
  fallback: boolean;
}

export interface PaperScoreVersion {
  key: string;
  base: number;
  citeWeight: number;
  citeRateHalf: number;
  graceYears: number;
  graceCredit: number;
  authorWeight: number;
  authorHalf: number;
}

export interface GeneralTerms {
  authorIdentity: number;
  linkPer: number;
  linkCap: number;
  agreementPer: number;
  agreementCap: number;
}

export interface FamilyDef { key: string; signals: string[] }

export interface VerdictDef {
  key: string;
  /** Does this verdict let corroboration transfer between sources (D15 item 3)? */
  transfers: boolean;
  /** What happens to the line's tag: keep | uncertain | gap. */
  tagEffect: "keep" | "uncertain" | "gap";
}

export interface CorroborationTerms { strongFactor: number; weakFactor: number; claimPer: number; claimCap: number }

export interface CredibilityModel {
  kinds: ClaimKind[];
  families: Map<string, FamilyDef>;
  weights: Map<string, WeightRow>;
  domainClasses: DomainClass[];
  paper: PaperScoreVersion;
  general: GeneralTerms;
  verdicts: Map<string, VerdictDef>;
  corroboration: CorroborationTerms;
  /** "weights v<N>" - the registry version of the weight table (bumped on every change). */
  weightsVersion: string;
  /** "paper <key>" - the active paper score version. */
  paperVersion: string;
  /** One string naming both, stamped on every score and the before/after view. */
  modelVersion: string;
}

const num = (v: unknown, field: string): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new CredibilityGateError(`credibility registry: ${field} is not a number`);
  return n;
};
const regexes = (v: unknown): RegExp[] =>
  (Array.isArray(v) ? v : []).map((s) => new RegExp(String(s), "i"));

/**
 * Build the model from registry rows, validating as it goes. Every inconsistency throws:
 * a weight row naming an unregistered kind or family, a kind without a row for some family,
 * zero or two active paper score versions, a declared `papers_outrank` the numbers break.
 */
export function buildModel(rows: RegistryRow[], registryVersions: Record<string, number>): CredibilityModel {
  const live = rows.filter((r) => !r.retired_at);
  const of = (reg: string) => live.filter((r) => r.registry === reg);

  const kinds: ClaimKind[] = of("claim_kinds").map((r) => ({
    key: r.key,
    order: num(r.definition.order ?? 100, `claim_kinds.${r.key}.order`),
    cues: regexes(r.definition.cues),
    fallback: r.definition.fallback === true,
    papersOutrank: r.definition.papers_outrank === true,
  })).sort((a, b) => a.order - b.order);
  if (kinds.filter((k) => k.fallback).length !== 1) {
    throw new CredibilityGateError("claim_kinds: exactly one entry must be declared fallback");
  }

  const families = new Map<string, FamilyDef>(of("source_families").map((r) => [r.key, {
    key: r.key, signals: Array.isArray(r.definition.signals) ? r.definition.signals.map(String) : [],
  }]));

  const weights = new Map<string, WeightRow>();
  for (const r of of("credibility_weights")) {
    const d = r.definition;
    const kind = String(d.kind ?? "");
    const family = String(d.family ?? "");
    if (!kinds.some((k) => k.key === kind)) {
      throw new CredibilityGateError(`credibility_weights.${r.key}: claim kind '${kind}' is not registered`);
    }
    if (!families.has(family)) {
      throw new CredibilityGateError(`credibility_weights.${r.key}: source family '${family}' is not registered`);
    }
    weights.set(`${kind}.${family}`, {
      kind, family,
      weight: num(d.weight, `${r.key}.weight`),
      admissionFloor: num(d.admission_floor, `${r.key}.admission_floor`),
      claimFloor: num(d.claim_floor, `${r.key}.claim_floor`),
      primaryBonus: num(d.primary_bonus ?? 0, `${r.key}.primary_bonus`),
    });
  }

  const domainClasses: DomainClass[] = of("domain_classes").map((r) => ({
    key: r.key,
    order: num(r.definition.order ?? 100, `domain_classes.${r.key}.order`),
    score: num(r.definition.score, `domain_classes.${r.key}.score`),
    patterns: regexes(r.definition.host_patterns),
    fallback: r.definition.fallback === true,
  })).sort((a, b) => a.order - b.order);
  if (domainClasses.filter((c) => c.fallback).length !== 1) {
    throw new CredibilityGateError("domain_classes: exactly one entry must be declared fallback");
  }

  const activePaper = of("paper_score_versions").filter((r) => r.definition.active === true);
  if (activePaper.length !== 1) {
    throw new CredibilityGateError(`paper_score_versions: ${activePaper.length} active versions (exactly one required)`);
  }
  const p = activePaper[0];
  const paper: PaperScoreVersion = {
    key: p.key,
    base: num(p.definition.base, "paper.base"),
    citeWeight: num(p.definition.cite_weight, "paper.cite_weight"),
    citeRateHalf: num(p.definition.cite_rate_half, "paper.cite_rate_half"),
    graceYears: num(p.definition.grace_years, "paper.grace_years"),
    graceCredit: num(p.definition.grace_credit, "paper.grace_credit"),
    authorWeight: num(p.definition.author_weight, "paper.author_weight"),
    authorHalf: num(p.definition.author_half, "paper.author_half"),
  };

  const gen = families.get("general") ? of("source_families").find((r) => r.key === "general")!.definition : {};
  const terms = (gen.terms ?? {}) as Record<string, unknown>;
  const general: GeneralTerms = {
    authorIdentity: num(terms.author_identity ?? 0, "general.terms.author_identity"),
    linkPer: num(terms.link_per ?? 0, "general.terms.link_per"),
    linkCap: num(terms.link_cap ?? 0, "general.terms.link_cap"),
    agreementPer: num(terms.agreement_per ?? 0, "general.terms.agreement_per"),
    agreementCap: num(terms.agreement_cap ?? 0, "general.terms.agreement_cap"),
  };

  const verdicts = new Map<string, VerdictDef>(of("entailment_verdicts").map((r) => {
    const effect = String(r.definition.tag_effect ?? "");
    if (!["keep", "uncertain", "gap"].includes(effect)) {
      throw new CredibilityGateError(`entailment_verdicts.${r.key}: tag_effect '${effect}' is not keep|uncertain|gap`);
    }
    return [r.key, { key: r.key, transfers: r.definition.transfers === true, tagEffect: effect as VerdictDef["tagEffect"] }];
  }));

  const corr = of("credibility_terms").find((r) => r.key === "corroboration")?.definition ?? {};
  const corroboration: CorroborationTerms = {
    strongFactor: num(corr.strong_factor ?? 0, "corroboration.strong_factor"),
    weakFactor: num(corr.weak_factor ?? 0, "corroboration.weak_factor"),
    claimPer: num(corr.claim_per ?? 0, "corroboration.claim_per"),
    claimCap: num(corr.claim_cap ?? 0, "corroboration.claim_cap"),
  };

  const weightsVersion = `weights v${registryVersions["credibility_weights"] ?? 1}`;
  const paperVersion = `paper ${paper.key}`;
  const model: CredibilityModel = {
    kinds, families, weights, domainClasses, paper, general, verdicts, corroboration,
    weightsVersion, paperVersion, modelVersion: `d15 ${weightsVersion} ${paperVersion}`,
  };
  validateTable(model);
  return model;
}

/** The highest score a general source can reach under the model (every term at its cap). */
export function maxGeneralScore(m: CredibilityModel): number {
  const best = Math.max(...m.domainClasses.map((c) => c.score));
  return Math.min(1, best + m.general.authorIdentity + m.general.linkCap + m.general.agreementCap);
}
/** The lowest score a resolved paper can have (no citations after its grace period, no author record). */
export function minPaperScore(m: CredibilityModel): number {
  return m.paper.base;
}

/**
 * The table's own invariants, checked whenever a model is built:
 *   - every kind has a row for every family (a missing row would otherwise surface mid-run);
 *   - a kind that declares papers_outrank really ranks the weakest paper above the strongest
 *     general source, primary bonus included (D15 item 4: "for new general theory, papers
 *     outrank every other type").
 */
export function validateTable(m: CredibilityModel): void {
  for (const k of m.kinds) {
    for (const f of m.families.keys()) weightFor(m, k.key, f);
    if (k.papersOutrank) {
      const paper = weightFor(m, k.key, "scholarly").weight * minPaperScore(m);
      const g = weightFor(m, k.key, "general");
      const general = g.weight * Math.min(1, maxGeneralScore(m) + g.primaryBonus);
      if (!(paper > general)) {
        throw new CredibilityGateError(
          `claim kind '${k.key}' declares papers_outrank but the weakest paper scores ${paper.toFixed(3)} ` +
          `and the strongest general source ${general.toFixed(3)}`,
        );
      }
    }
  }
}

/** The row for (kind, family) - or the gate stops, naming what is missing. Never a default. */
export function weightFor(m: CredibilityModel, kind: string, family: string): WeightRow {
  if (!m.kinds.some((k) => k.key === kind)) {
    throw new CredibilityGateError(`claim kind '${kind}' is not in the claim_kinds registry - the gate stops (D15 item 9)`);
  }
  const row = m.weights.get(`${kind}.${family}`);
  if (!row) {
    throw new CredibilityGateError(
      `the weight table (${m.weightsVersion}) has no row for claim kind '${kind}' and family '${family}' - the gate stops (D15 item 9)`,
    );
  }
  return row;
}

/** The claim kind of a question: the first registered kind whose cue matches, else the fallback. */
export function classifyClaimKind(m: CredibilityModel, question: string): { kind: string; basis: string } {
  const q = String(question || "");
  for (const k of m.kinds) {
    if (k.fallback) continue;
    const hit = k.cues.find((re) => re.test(q));
    if (hit) return { kind: k.key, basis: `cue ${hit.source}` };
  }
  const fb = m.kinds.find((k) => k.fallback)!;
  return { kind: fb.key, basis: "no cue matched: the registry's declared fallback kind" };
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

export function domainClassOf(m: CredibilityModel, url: string): DomainClass {
  const h = hostOf(url);
  for (const c of m.domainClasses) {
    if (c.fallback) continue;
    if (h && c.patterns.some((re) => re.test(h))) return c;
  }
  return m.domainClasses.find((c) => c.fallback)!;
}

// ── signals ───────────────────────────────────────────────────────────────

export interface ScholarlyAuthor { id: string | null; name?: string | null; works_count: number | null }
export interface ScholarlyRecord {
  state: "resolved" | "unresolved";
  identifier: { kind: string; value: string } | null;
  doi: string | null;
  cited_by: number | null;
  published: string | null;
  authors: ScholarlyAuthor[];
  resolved_at: string;
  via: string | null;
  reason?: string;
}

export interface GeneralSignals {
  author_identity: string | null;
  domain_class: string;
  primary: boolean;
  /** How many independent admitted sources link to it or reached a credible source through it. */
  link_structure: { inbound_corroborations: number; found_via: number };
  /** supports verdicts on lines it is cited by (agreement with admitted claims). */
  entailment_agreement: { supports: number; partial: number; unsupported: number };
}

export interface ScholarlySignals {
  cited_by: number | null;
  author_works_count: number | null;
  age_years: number | null;
}

export interface SourceScore {
  family: string;
  /** Exactly the signal set of the family - never the other family's. */
  signals: ScholarlySignals | GeneralSignals;
  score: number;
  reasons: string[];
  model_version: string;
}

const sat = (x: number, half: number) => (half > 0 ? x / (x + half) : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function ageYears(published: string | null, now: Date): number | null {
  if (!published) return null;
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / (365.25 * 86400_000));
}

/**
 * The deterministic paper score (D15 item 2). Credible on publication (`base`), and the
 * citation count is read against age: inside the grace period a new paper is credited
 * `grace_credit` of the citation term (new papers are favoured until time passes); after it,
 * the citation RATE is what counts. The author term is each paper's best-published author.
 * An unknown count contributes nothing and SAYS so in the reasons - never a silent zero.
 */
export function paperScore(m: CredibilityModel, s: ScholarlySignals): { score: number; reasons: string[] } {
  const p = m.paper;
  const reasons = [`paper score ${p.key}: base ${p.base} (credible on publication)`];
  let citeTerm = 0;
  if (s.cited_by === null) {
    reasons.push("cited_by unresolved: citation term 0, not a count of 0");
  } else if (s.age_years !== null && s.age_years < p.graceYears) {
    citeTerm = Math.max(p.graceCredit, sat(s.cited_by, p.citeRateHalf * p.graceYears));
    reasons.push(`cited_by ${s.cited_by} at age ${s.age_years.toFixed(1)}y (inside the ${p.graceYears}y grace): citation term ${r3(citeTerm)}`);
  } else {
    const age = Math.max(1, s.age_years ?? 1);
    citeTerm = sat(s.cited_by / age, p.citeRateHalf);
    reasons.push(`cited_by ${s.cited_by} over ${age.toFixed(1)}y = ${(s.cited_by / age).toFixed(1)}/y: citation term ${r3(citeTerm)}`);
  }
  let authorTerm = 0;
  if (s.author_works_count === null) {
    reasons.push("author works_count unresolved: author term 0, not a count of 0");
  } else {
    authorTerm = sat(s.author_works_count, p.authorHalf);
    reasons.push(`best author works_count ${s.author_works_count}: author term ${r3(authorTerm)}`);
  }
  const score = Math.min(1, p.base + p.citeWeight * citeTerm + p.authorWeight * authorTerm);
  return { score: r3(score), reasons };
}

export function generalScore(m: CredibilityModel, s: GeneralSignals): { score: number; reasons: string[] } {
  const cls = m.domainClasses.find((c) => c.key === s.domain_class);
  if (!cls) throw new CredibilityGateError(`domain class '${s.domain_class}' is not in the domain_classes registry`);
  const g = m.general;
  const reasons = [`domain class ${cls.key}: ${cls.score}`];
  let score = cls.score;
  if (s.author_identity) { score += g.authorIdentity; reasons.push(`author stated (${s.author_identity}): +${g.authorIdentity}`); }
  else reasons.push("no author identity stated: +0");
  const links = s.link_structure.inbound_corroborations + s.link_structure.found_via;
  const linkTerm = Math.min(g.linkCap, g.linkPer * links);
  if (links) reasons.push(`link structure (${s.link_structure.inbound_corroborations} inbound, ${s.link_structure.found_via} found_via): +${r3(linkTerm)}`);
  score += linkTerm;
  const agree = Math.min(g.agreementCap, g.agreementPer * s.entailment_agreement.supports);
  if (s.entailment_agreement.supports) reasons.push(`entailment agreement (${s.entailment_agreement.supports} supports): +${r3(agree)}`);
  score += agree;
  return { score: r3(Math.min(1, score)), reasons };
}

/**
 * Family assignment (D15 item 10): scholarly iff a scholarly identifier RESOLVED. An identifier
 * that did not resolve leaves the source general, with the unresolved record kept beside it.
 */
export function familyOf(scholarly: ScholarlyRecord | null): "scholarly" | "general" {
  return scholarly && scholarly.state === "resolved" ? "scholarly" : "general";
}

export function scholarlySignals(rec: ScholarlyRecord, now: Date): ScholarlySignals {
  const counts = rec.authors.map((a) => a.works_count).filter((n): n is number => typeof n === "number");
  return {
    cited_by: rec.cited_by,
    author_works_count: counts.length ? Math.max(...counts) : null,
    age_years: ageYears(rec.published, now) === null ? null : r3(ageYears(rec.published, now)!),
  };
}

/** Score a source in its family. A signal set of the wrong family is refused loudly. */
export function scoreSource(
  m: CredibilityModel,
  family: string,
  signals: ScholarlySignals | GeneralSignals,
): SourceScore {
  if (!m.families.has(family)) throw new CredibilityGateError(`source family '${family}' is not registered`);
  const isGeneralSignals = (s: unknown): s is GeneralSignals =>
    !!s && typeof s === "object" && "domain_class" in (s as Record<string, unknown>);
  if (family === "scholarly") {
    if (isGeneralSignals(signals)) throw new CredibilityGateError("a scholarly source cannot be scored from general signals");
    const { score, reasons } = paperScore(m, signals);
    return { family, signals, score, reasons, model_version: m.modelVersion };
  }
  if (family === "general") {
    if (!isGeneralSignals(signals)) throw new CredibilityGateError("a general source cannot be scored from scholarly signals");
    const { score, reasons } = generalScore(m, signals);
    return { family, signals, score, reasons, model_version: m.modelVersion };
  }
  // A registered family with no scorer is a code gap the registry exposed - loud, never general.
  throw new CredibilityGateError(`source family '${family}' is registered but has no signal scorer`);
}

/** The weighted total for one claim kind: family score x weight (+ primary bonus for general). */
export function weightedTotal(m: CredibilityModel, kind: string, s: SourceScore): { total: number; row: WeightRow; reason: string } {
  const row = weightFor(m, kind, s.family);
  const primary = s.family === "general" && (s.signals as GeneralSignals).primary ? row.primaryBonus : 0;
  const total = r3(Math.min(1, row.weight * Math.min(1, s.score + primary)));
  return {
    total, row,
    reason: `${kind}/${s.family}: ${s.score}${primary ? ` + primary ${primary}` : ""} x weight ${row.weight} = ${total} (${m.weightsVersion})`,
  };
}

// ── corroboration (D15 item 3) ────────────────────────────────────────────

export interface CorroborationEdge {
  from_url: string;
  to_url: string;
  strength: "strong" | "weak";
  amount: number;
  claim: string;
  verdict: string;
}

/**
 * A non-paper source that links a paper, on a claim both are cited for: the paper is a STRONG
 * corroboration of the source and the source a WEAK corroboration of the paper - and only when
 * the verdict on that claim is one the registry says transfers (`supports`). Any other verdict
 * transfers nothing: a post cannot borrow credibility by linking a paper that says something else.
 */
export function corroborate(
  m: CredibilityModel,
  kind: string,
  claim: string,
  verdict: string,
  general: { url: string; score: SourceScore; links: string[] },
  paper: { url: string; doi: string | null; score: SourceScore },
): CorroborationEdge[] {
  const v = m.verdicts.get(verdict);
  if (!v) throw new CredibilityGateError(`entailment verdict '${verdict}' is not registered`);
  if (!v.transfers) return [];
  if (general.score.family !== "general" || paper.score.family !== "scholarly") return [];
  const linked = general.links.some((l) => sameTarget(l, paper.url, paper.doi));
  if (!linked) return [];
  const pt = weightedTotal(m, kind, paper.score).total;
  const gt = weightedTotal(m, kind, general.score).total;
  return [
    { from_url: paper.url, to_url: general.url, strength: "strong", amount: r3(m.corroboration.strongFactor * pt), claim, verdict },
    { from_url: general.url, to_url: paper.url, strength: "weak", amount: r3(m.corroboration.weakFactor * gt), claim, verdict },
  ];
}

function sameTarget(link: string, url: string, doi: string | null): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (norm(link) === norm(url)) return true;
  if (doi && norm(link).includes(doi.toLowerCase())) return true;
  return false;
}

// ── the claim total and the report roll-up (D15 items 5-6) ────────────────

export interface LineCredibility {
  line: number;
  verdict: string;
  /** The lead: the best weighted total among the line's cited sources (after transfers). */
  lead: number;
  corroborators: number;
  total: number;
  below_floor: boolean;
  reasons: string[];
}

/**
 * The per-claim total of the same model the trigger will use once the operator confirms the
 * before/after view (claim_confidence_d15 in SQL is the stored twin): the best cited source
 * leads, each further independent cited source adds claim_per x its total, capped; only a
 * transferring verdict earns any of it. A single uncorroborated general source therefore starts
 * at its own weighted total, which the table keeps under the claim floor (D15 item 6).
 */
export function lineCredibility(
  m: CredibilityModel,
  kind: string,
  line: number,
  verdict: string,
  cited: Array<{ total: number }>,
): LineCredibility {
  const v = m.verdicts.get(verdict);
  if (!v) throw new CredibilityGateError(`entailment verdict '${verdict}' is not registered`);
  const floor = Math.max(...[...m.families.keys()].map((f) => weightFor(m, kind, f).claimFloor));
  if (!v.transfers || !cited.length) {
    return { line, verdict, lead: 0, corroborators: 0, total: 0, below_floor: true,
      reasons: [`verdict ${verdict}: the line carries no credibility`] };
  }
  const totals = cited.map((c) => c.total).sort((a, b) => b - a);
  const lead = totals[0];
  const extra = Math.min(m.corroboration.claimCap, totals.slice(1).reduce((a, t) => a + m.corroboration.claimPer * t, 0));
  const total = r3(Math.min(1, lead + extra));
  return {
    line, verdict, lead, corroborators: totals.length - 1, total, below_floor: total < floor,
    reasons: [`lead ${lead}`, `${totals.length - 1} corroborating source(s): +${r3(extra)}`, `claim floor ${floor}`],
  };
}

export interface ReportCredibility {
  value: number | null;
  lines: number;
  below_floor: number;
  kind: string;
  model_version: string;
  weights: Record<string, number>;
}

/** Mean of the per-line totals over the lines that carry a verdict; null when there are none. */
export function reportCredibility(m: CredibilityModel, kind: string, lines: LineCredibility[]): ReportCredibility {
  const weights: Record<string, number> = {};
  for (const f of m.families.keys()) weights[f] = weightFor(m, kind, f).weight;
  const value = lines.length ? r3(lines.reduce((a, l) => a + l.total, 0) / lines.length) : null;
  return { value, lines: lines.length, below_floor: lines.filter((l) => l.below_floor).length, kind, model_version: m.modelVersion, weights };
}

// ── loading ───────────────────────────────────────────────────────────────

export const CREDIBILITY_REGISTRIES = [
  "claim_kinds", "credibility_weights", "domain_classes", "paper_score_versions",
  "source_families", "entailment_verdicts", "credibility_terms",
];

interface QueryClient { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> }

/** Read the registries and build the model. Throws (the gate stops) on any inconsistency. */
export async function loadCredibilityModel(client: QueryClient): Promise<CredibilityModel> {
  const rows = await client.queryObject<RegistryRow>(
    `SELECT registry, key, version, definition, retired_at::text AS retired_at
       FROM public.contract_registry_entries WHERE registry = ANY($1::text[])`,
    [CREDIBILITY_REGISTRIES],
  );
  const versions = await client.queryObject<{ name: string; version: number }>(
    `SELECT name, version FROM public.contract_registries WHERE name = ANY($1::text[])`,
    [CREDIBILITY_REGISTRIES],
  );
  if (!rows.rows.length) throw new CredibilityGateError("the credibility registries are empty - is init-research-credibility.sql applied?");
  return buildModel(rows.rows, Object.fromEntries(versions.rows.map((v) => [v.name, Number(v.version)])));
}
