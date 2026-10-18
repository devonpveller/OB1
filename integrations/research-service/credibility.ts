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
  /**
   * The families the weight table SCORES: those with at least one active weight row (attempt 3).
   * A family registered without any row (P0's expansion by registration) is not in the model yet:
   * it stops nothing until a source of it is scored - then weightFor stops the gate, naming it. A
   * family with SOME rows must have one for every kind. credibility_model_check is the SQL twin.
   */
  scoredFamilies: string[];
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

/**
 * An ORDER (claim kinds, domain classes): absent = 100 in both twins; present, a JSON integer
 * (attempt 3: attempt 2 read "2" as 2 here while the SQL twin's ::int cast refused 1.5 - one rule
 * now, credibility_model_check applies it too).
 */
const order = (v: unknown, field: string): number => {
  if (v === undefined) return 100;
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1e9) {
    throw new CredibilityGateError(`credibility registry: ${field} is not an integer (${JSON.stringify(v ?? null)})`);
  }
  return v;
};

/** The smallest non-zero credibility number (attempt 3; see `unit`). */
export const UNIT_MIN_NONZERO = 1e-9;

/**
 * A number that JSON.parse read as 0 although its text has a non-zero digit (1e-400): it
 * underflowed. `parseRegistryJson` puts this marker in its place so `unit()` refuses it the way
 * the SQL twin refuses the same text (its numeric is non-zero and below 1e-9), instead of reading 0.
 */
export class UnderflowedNumber {
  constructor(readonly source: string) {}
  toJSON() { return this.source; }
}

/**
 * Parse a registry definition's JSON text (attempt 3). The same as JSON.parse except that a
 * number whose text is non-zero but which parses to 0 becomes an UnderflowedNumber. Every other
 * number is the same IEEE double the SQL twin's float8 cast gives for the same text (both round
 * the decimal correctly), so the two twins read one value.
 */
export function parseRegistryJson(text: string): Record<string, unknown> {
  const reviver = (_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" && v === 0 && typeof ctx?.source === "string" && /[1-9]/.test(ctx.source.split(/[eE]/)[0])
      ? new UnderflowedNumber(ctx.source)
      : v;
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/**
 * A credibility number (attempt 2, tester finding 2; attempt 3): a JSON number that is 0 or in
 * [1e-9, 1] - never a string cast ("0.5", "NaN"), never null or missing, never negative, never
 * above 1, and never a non-zero number below 1e-9. Attempt 3 (tester near-miss): 1e-50 raised
 * 22003 in the SQL twin's REAL and read 0 here; 1e-400 underflows to 0 in JSON.parse while the
 * database holds it as a non-zero numeric. Refusing every non-zero number below 1e-9 is the one
 * rule both twins can apply to the same text. The SQL twin's credibility_is_unit /
 * credibility_unit apply exactly this rule (OBC04) and the weight table's CHECK calls the same
 * function, so the two refuse the same rows. The message keeps "is not a number" for a non-number.
 */
export function unit(v: unknown, field: string): number {
  if (v instanceof UnderflowedNumber) {
    throw new CredibilityGateError(`credibility registry: ${field} = ${v.source} is a non-zero number below 1e-9`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CredibilityGateError(`credibility registry: ${field} is not a number (${v === undefined ? "missing" : JSON.stringify(v)})`);
  }
  if (v < 0 || v > 1) throw new CredibilityGateError(`credibility registry: ${field} = ${v} is outside [0, 1]`);
  if (v !== 0 && v < UNIT_MIN_NONZERO) throw new CredibilityGateError(`credibility registry: ${field} = ${v} is a non-zero number below 1e-9`);
  return v;
}

/**
 * An AMOUNT or a TOTAL the pipeline computed (attempt 3): a finite double in [0, 1]. Unlike a
 * registry number it never passes through decimal text that can underflow (it goes to a DOUBLE
 * PRECISION column as its shortest round-trip text and reads back as the same double), so no lower
 * bound applies - a product of two credibility numbers may be below 1e-9.
 */
export function amountUnit(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new CredibilityGateError(`credibility: ${field} is not a number (${v === undefined ? "missing" : JSON.stringify(v)})`);
  }
  if (v < 0 || v > 1) throw new CredibilityGateError(`credibility: ${field} = ${v} is outside [0, 1]`);
  return v;
}

/**
 * A saturation half-point (> 0) or a grace period (>= 0): 0 (grace only) or in [1e-9, 1e9]
 * (attempt 3: bounded both ways for the reason `unit` is - the SQL twin's credibility_is_positive
 * reads the same text through float8, which a number outside that range can underflow or overflow).
 */
const positive = (v: unknown, field: string, allowZero = false): number => {
  const ok = typeof v === "number" && Number.isFinite(v) &&
    ((allowZero && v === 0) || (v >= UNIT_MIN_NONZERO && v <= 1e9));
  if (!ok) {
    const shown = v instanceof UnderflowedNumber ? v.source : JSON.stringify(v ?? null);
    throw new CredibilityGateError(`credibility registry: ${field} is not a ${allowZero ? "non-negative" : "positive"} number in range (${shown})`);
  }
  return v as number;
};

/**
 * A registry key named inside a definition (a weight row's kind and family): exactly the pattern
 * P0's contract_registry_entries.key CHECK enforces on every key (attempt 3, tester near-miss: a
 * weight row for 'practical ' or 'Practical' got past the SQL CHECK and the unique index; SQL used
 * the other rows, TS refused the model). The weight table's CHECK applies the same pattern.
 */
export const REGISTRY_KEY_PATTERN = "^[a-z0-9][a-z0-9._-]*$";
const KEY_RE = new RegExp(REGISTRY_KEY_PATTERN);
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
    order: order(r.definition.order, `claim_kinds.${r.key}.order`),
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
    // attempt 3: kind and family are registry keys as P0's key CHECK defines them - 'practical '
    // or 'Practical' is refused here and by the weight table's CHECK (the same pattern)
    if (typeof d.kind !== "string" || !KEY_RE.test(d.kind) || typeof d.family !== "string" || !KEY_RE.test(d.family)) {
      throw new CredibilityGateError(
        `credibility_weights.${r.key}: kind ${JSON.stringify(d.kind ?? null)} / family ${JSON.stringify(d.family ?? null)} is not a registry key (${REGISTRY_KEY_PATTERN})`,
      );
    }
    const kind = d.kind;
    const family = d.family;
    if (!kinds.some((k) => k.key === kind)) {
      throw new CredibilityGateError(`credibility_weights.${r.key}: claim kind '${kind}' is not registered`);
    }
    if (!families.has(family)) {
      throw new CredibilityGateError(`credibility_weights.${r.key}: source family '${family}' is not registered`);
    }
    // attempt 2: one active row per kind x family (the SQL twin's unique index); attempt 1 let
    // the last of two rows win here while SQL took either
    if (weights.has(`${kind}.${family}`)) {
      throw new CredibilityGateError(`credibility_weights: two active rows for claim kind '${kind}' and family '${family}' (${r.key})`);
    }
    weights.set(`${kind}.${family}`, {
      kind, family,
      weight: unit(d.weight, `${r.key}.weight`),
      admissionFloor: unit(d.admission_floor, `${r.key}.admission_floor`),
      claimFloor: unit(d.claim_floor, `${r.key}.claim_floor`),
      // the one optional field, absent = 0 in both twins; present, it is a credibility number
      primaryBonus: d.primary_bonus === undefined ? 0 : unit(d.primary_bonus, `${r.key}.primary_bonus`),
    });
  }

  const domainClasses: DomainClass[] = of("domain_classes").map((r) => ({
    key: r.key,
    order: order(r.definition.order, `domain_classes.${r.key}.order`),
    score: unit(r.definition.score, `domain_classes.${r.key}.score`),
    patterns: regexes(r.definition.host_patterns),
    fallback: r.definition.fallback === true,
  })).sort((a, b) => a.order - b.order);
  if (domainClasses.filter((c) => c.fallback).length !== 1) {
    throw new CredibilityGateError("domain_classes: exactly one entry must be declared fallback");
  }
  // attempt 3: the first matching class by order decides a host; two classes on one order would
  // be decided by row order here and by the planner in SQL - refused in both twins
  for (let i = 1; i < domainClasses.length; i++) {
    if (domainClasses[i].order === domainClasses[i - 1].order) {
      throw new CredibilityGateError(`domain_classes: ${domainClasses[i - 1].key} and ${domainClasses[i].key} share order ${domainClasses[i].order}`);
    }
  }

  const activePaper = of("paper_score_versions").filter((r) => r.definition.active === true);
  if (activePaper.length !== 1) {
    throw new CredibilityGateError(`paper_score_versions: ${activePaper.length} active versions (exactly one required)`);
  }
  const p = activePaper[0];
  const paper: PaperScoreVersion = {
    key: p.key,
    base: unit(p.definition.base, "paper.base"),
    citeWeight: unit(p.definition.cite_weight, "paper.cite_weight"),
    citeRateHalf: positive(p.definition.cite_rate_half, "paper.cite_rate_half"),
    graceYears: positive(p.definition.grace_years, "paper.grace_years", true),
    graceCredit: unit(p.definition.grace_credit, "paper.grace_credit"),
    authorWeight: unit(p.definition.author_weight, "paper.author_weight"),
    authorHalf: positive(p.definition.author_half, "paper.author_half"),
  };

  const gen = families.get("general") ? of("source_families").find((r) => r.key === "general")!.definition : {};
  const terms = (gen.terms ?? {}) as Record<string, unknown>;
  // attempt 2: required, no `?? 0` - a missing term is a defect the gate names, not a zero
  const general: GeneralTerms = {
    authorIdentity: unit(terms.author_identity, "general.terms.author_identity"),
    linkPer: unit(terms.link_per, "general.terms.link_per"),
    linkCap: unit(terms.link_cap, "general.terms.link_cap"),
    agreementPer: unit(terms.agreement_per, "general.terms.agreement_per"),
    agreementCap: unit(terms.agreement_cap, "general.terms.agreement_cap"),
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
    strongFactor: unit(corr.strong_factor, "corroboration.strong_factor"),
    weakFactor: unit(corr.weak_factor, "corroboration.weak_factor"),
    claimPer: unit(corr.claim_per, "corroboration.claim_per"),
    claimCap: unit(corr.claim_cap, "corroboration.claim_cap"),
  };

  const weightsVersion = `weights v${registryVersions["credibility_weights"] ?? 1}`;
  const paperVersion = `paper ${paper.key}`;
  const scoredFamilies = [...families.keys()].filter((f) => [...weights.values()].some((w) => w.family === f));
  const model: CredibilityModel = {
    kinds, families, scoredFamilies, weights, domainClasses, paper, general, verdicts, corroboration,
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
    for (const f of m.scoredFamilies) weightFor(m, k.key, f);
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
/**
 * DISPLAY ONLY (attempt 3, tester finding: attempt 2 rounded totals with this and the SQL twin did
 * not, so a claim's floor verdict flipped between the twins). It shapes reason TEXT; no number that
 * feeds a total, an amount, a stamp or a floor comparison goes through it (twins.test.ts checks).
 */
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
  return { score, reasons };
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
  return { score: Math.min(1, score), reasons };
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
    // a SIGNAL's recorded precision, not a total's rounding (attempt 3): the age is stored with the
    // signals at 3 decimals of a year and the paper score is computed FROM the stored value, so the
    // stamped signals reproduce the stamped score exactly
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
  // the SQL twin's v_base, op for op: weight x min(1, score + bonus) (a product of two numbers in
  // [0, 1] needs no cap); unrounded (attempt 3)
  const total = row.weight * Math.min(1, s.score + primary);
  return {
    total, row,
    reason: `${kind}/${s.family}: ${r3(s.score)}${primary ? ` + primary ${primary}` : ""} x weight ${row.weight} = ${r3(total)} (${m.weightsVersion})`,
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
    { from_url: paper.url, to_url: general.url, strength: "strong", amount: m.corroboration.strongFactor * pt, claim, verdict },
    { from_url: general.url, to_url: paper.url, strength: "weak", amount: m.corroboration.weakFactor * gt, claim, verdict },
  ];
}

function sameTarget(link: string, url: string, doi: string | null): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");
  if (norm(link) === norm(url)) return true;
  if (doi && norm(link).includes(doi.toLowerCase())) return true;
  return false;
}

// ── the claim total and the report roll-up (D15 items 5-6) ────────────────

/**
 * The rolling total a source brings to ONE line (the claim it will be filed as): its own
 * weighted total plus the corroboration it received - with the FOLD RULE (attempt 2, tester
 * adversarial (3)): corroboration from a source that is itself cited on this line does not
 * count here, because that source already counts in the line once, through claim_per x its own
 * total (lineCredibility). The same giver -> receiver pair on the same line counts once whatever
 * the model version (one row per pair and line, as source_corroborations' key). Capped at 1;
 * every amount must be a finite number in [0, 1]. claim_confidence_d15 / source_rolling_total
 * (p_exclude) are the SQL twin. Attempt 3: unrounded, and the amounts are summed in ONE order -
 * descending, from 0, the SQL twin's sum(amount ORDER BY amount DESC) - so both give the same
 * double whatever order the rows were inserted in (float addition is not associative).
 */
export function foldReceived(
  base: number,
  received: Array<{ from: string; claim: string; amount: number }>,
  coCited: Set<string>,
): number {
  const seen = new Set<string>();
  const amounts: number[] = [];
  for (const e of received) {
    amountUnit(e.amount, `corroboration amount from ${e.from}`);
    if (coCited.has(e.from)) continue;
    const k = `${e.from}\u0000${e.claim}`;
    if (seen.has(k)) continue;
    seen.add(k);
    amounts.push(e.amount);
  }
  const sum = amounts.sort((a, b) => b - a).reduce((a, x) => a + x, 0);
  return Math.min(1, amountUnit(base, "source total") + sum);
}

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
 * Attempt 3: unrounded, in the SQL twin's order - totals descending, the extra summed from 0 in
 * that order, capped, added to the lead, capped at 1; below the floor iff the total is under the
 * highest claim_floor among the kind's family rows (credibility_claim_floor in SQL).
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
  const floor = Math.max(...m.scoredFamilies.map((f) => weightFor(m, kind, f).claimFloor));
  if (!v.transfers || !cited.length) {
    return { line, verdict, lead: 0, corroborators: 0, total: 0, below_floor: true,
      reasons: [`verdict ${verdict}: the line carries no credibility`] };
  }
  const totals = cited.map((c) => c.total).sort((a, b) => b - a);
  const lead = totals[0];
  const extra = Math.min(m.corroboration.claimCap, totals.slice(1).reduce((a, t) => a + m.corroboration.claimPer * t, 0));
  const total = Math.min(1, lead + extra);
  return {
    line, verdict, lead, corroborators: totals.length - 1, total, below_floor: total < floor,
    reasons: [`lead ${r3(lead)}`, `${totals.length - 1} corroborating source(s): +${r3(extra)}`, `claim floor ${floor}`],
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

/**
 * Mean of the per-line totals over the lines that carry a verdict; null when there are none. The
 * mean is a REPORT figure (display, 3 decimals); the below-floor count is each line's unrounded
 * verdict.
 */
export function reportCredibility(m: CredibilityModel, kind: string, lines: LineCredibility[]): ReportCredibility {
  const weights: Record<string, number> = {};
  for (const f of m.scoredFamilies) weights[f] = weightFor(m, kind, f).weight;
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
  // attempt 3: the definition is read as TEXT and parsed by parseRegistryJson, so a number the
  // database holds as non-zero and JSON.parse would read as 0 is refused (unit), as in SQL
  const raw = await client.queryObject<Omit<RegistryRow, "definition"> & { definition: string | Record<string, unknown> }>(
    `SELECT registry, key, version, definition::text AS definition, retired_at::text AS retired_at
       FROM public.contract_registry_entries WHERE registry = ANY($1::text[])`,
    [CREDIBILITY_REGISTRIES],
  );
  const rows = {
    rows: raw.rows.map((r): RegistryRow => ({
      ...r, definition: typeof r.definition === "string" ? parseRegistryJson(r.definition) : r.definition,
    })),
  };
  const versions = await client.queryObject<{ name: string; version: number }>(
    `SELECT name, version FROM public.contract_registries WHERE name = ANY($1::text[])`,
    [CREDIBILITY_REGISTRIES],
  );
  if (!rows.rows.length) throw new CredibilityGateError("the credibility registries are empty - is init-research-credibility.sql applied?");
  return buildModel(rows.rows, Object.fromEntries(versions.rows.map((v) => [v.name, Number(v.version)])));
}
