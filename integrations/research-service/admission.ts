/**
 * admission.ts - the pre-ingestion credibility STAGE of the admission chokepoint
 * (research-workbench P3a, D15 items 7-8 and 10).
 *
 * It is a stage, not a second gate: the gather loop calls it for every search hit before the
 * hit is fetched, and what it admits then goes through the existing chokepoint exactly as
 * before - the injection screen (injection.ts) and the relevance gate (filtering.ts). What it
 * does not admit is never fetched into the pool, never staged, and so never a `sources` row.
 *
 *   hit -> what resolves about it before fetch (own scholarly identifier and its record, the
 *          domain's credibility class, primary-ness) -> its family's score -> x the weight row
 *          for the run's claim kind -> at or above the row's admission floor: ADMITTED
 *                                                       below:              a LEAD
 *   lead -> fetched only to read its outbound links (never staged) -> each link assessed like a
 *           hit -> a link that clears the floor is admitted, remembered as reached `via` the
 *           lead -> after entailment, a via-source with a `supports` verdict carries found_via
 *           (the lead's trail id) and the trail shows the path; a lead whose links reach nothing
 *           of the kind leaves only its trail entry.
 *
 * Pure decisions over injected seams (the resolver, the scholarly cache); the harness owns the
 * fetching and kb.ts the persistence.
 */
import {
  type CredibilityModel, domainClassOf, familyOf, type GeneralSignals, hostOf, type ScholarlyRecord,
  scholarlySignals, scoreSource, type SourceScore, weightedTotal,
} from "./credibility.ts";
import { headDoi, type Identifier, ownIdentifier, type ScholarlyResolver } from "./scholarly.ts";

export interface TrailEntry {
  id: string;
  url: string;
  kind: string;                 // admission_trail_kinds registry
  claim_kind: string;
  family: string | null;
  score: number | null;
  total: number | null;
  floor: number | null;
  model_version: string;
  signals: unknown;
  reasons: string[];
  found_via: string | null;     // the lead's trail id (or a held source id) this was reached through
  path: Array<Record<string, unknown>>;
  source_url: string | null;    // set when the hit became a pool source
}

export interface Assessment {
  url: string;
  title: string;
  identifier: Identifier | null;
  scholarly: ScholarlyRecord | null;
  score: SourceScore;
  total: number;
  floor: number;
  admitted: boolean;
  reasons: string[];
}

export interface AdmissionContext {
  model: CredibilityModel;
  kind: string;
  resolver: ScholarlyResolver | null;
  /** A scholarly record already cached on a stored source (sources.metadata.scholarly), by url. */
  cached?: (url: string) => Promise<ScholarlyRecord | null>;
  /** Tokens of the run's subject: a host carrying one is the subject's own (primary) source. */
  subjectTokens: string[];
  now: Date;
  memo?: Map<string, ScholarlyRecord | null>;
}

export function subjectTokens(entity: string): string[] {
  return String(entity || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !/^\d+$/.test(t));
}

/** A primary source for the subject: its own domain, or a row already marked authority=primary. */
export function isPrimary(url: string, tokens: string[], metadataAuthority?: string | null): { primary: boolean; basis: string } {
  if (metadataAuthority === "primary") return { primary: true, basis: "metadata.authority = primary" };
  const host = hostOf(url);
  const label = host.split(".").slice(0, -1).join(".");
  const t = tokens.find((tok) => label.split(/[.-]/).includes(tok));
  return t ? { primary: true, basis: `host ${host} carries the subject token '${t}'` } : { primary: false, basis: "not the subject's own domain" };
}

/** "By <Name>" / "Author: <Name>" in the head of the text: the general family's author identity. */
export function authorIdentity(content: string): string | null {
  const head = String(content || "").slice(0, 2500);
  const m = head.match(/\b(?:by|author[s]?:|written by|posted by)\s+([A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+){0,3})/u);
  if (!m) return null;
  const name = m[1].trim();
  return /^(Anonymous|Admin|Staff|Team|Guest)$/i.test(name) ? null : name;
}

async function scholarlyFor(ctx: AdmissionContext, url: string, id: Identifier, content: string): Promise<ScholarlyRecord> {
  const memo = ctx.memo ?? (ctx.memo = new Map());
  if (memo.has(url)) return memo.get(url)!;
  let rec = ctx.cached ? await ctx.cached(url).catch(() => null) : null;
  if (!rec) {
    rec = ctx.resolver
      ? await ctx.resolver.resolve(id, id.kind === "pmcid" || id.kind === "pmid" ? headDoi(content) : null)
      : {
        state: "unresolved", identifier: id, doi: id.kind === "doi" ? id.value : null, cited_by: null, published: null,
        authors: [], resolved_at: ctx.now.toISOString(), via: null,
        reason: "no scholarly resolver configured",   // a reason CODE (scholarly.ts SCHOLARLY_REASON_PATTERN)
      };
  }
  memo.set(url, rec);
  return rec;
}

/**
 * Score one hit (or a fetched page, when `content` is given) in its family and decide admission.
 * Before fetch the general family knows only its domain class and primary-ness; after fetch the
 * author identity is read too. Link structure and entailment agreement arrive after the run's
 * entailment stage and are added when the source is stamped (`finalScore`).
 */
export async function assess(
  ctx: AdmissionContext,
  hit: { url: string; title?: string; content?: string; authority?: string | null },
): Promise<Assessment> {
  const content = hit.content ?? "";
  const id = ownIdentifier(hit.url, content);
  const scholarly = id ? await scholarlyFor(ctx, hit.url, id, content) : null;
  const family = familyOf(scholarly);
  const reasons: string[] = [];
  let signals: ReturnType<typeof scholarlySignals> | GeneralSignals;
  if (family === "scholarly") {
    signals = scholarlySignals(scholarly!, ctx.now);
    reasons.push(`${id!.kind} ${id!.value} resolved via ${scholarly!.via}`);
  } else {
    const cls = domainClassOf(ctx.model, hit.url);
    const p = isPrimary(hit.url, ctx.subjectTokens, hit.authority);
    if (scholarly) reasons.push(`${id!.kind} ${id!.value} UNRESOLVED (${scholarly.reason}): scored as general`);
    reasons.push(`primary: ${p.basis}`);
    signals = {
      author_identity: content ? authorIdentity(content) : null,
      domain_class: cls.key,
      primary: p.primary,
      link_structure: { inbound_corroborations: 0, found_via: 0 },
      entailment_agreement: { supports: 0, partial: 0, unsupported: 0 },
    };
  }
  const score = scoreSource(ctx.model, family, signals);
  const w = weightedTotal(ctx.model, ctx.kind, score);
  const floor = w.row.admissionFloor;
  return {
    url: hit.url, title: hit.title ?? "", identifier: id, scholarly, score, total: w.total, floor,
    admitted: w.total >= floor,
    reasons: [...reasons, ...score.reasons, w.reason, `${w.total >= floor ? "clears" : "below"} the ${ctx.kind} admission floor ${floor}`],
  };
}

export function trailEntry(
  a: Assessment, kind: string, ctx: AdmissionContext,
  extra: Partial<Pick<TrailEntry, "found_via" | "path" | "source_url">> = {},
): TrailEntry {
  return {
    id: crypto.randomUUID(), url: a.url, kind, claim_kind: ctx.kind, family: a.score.family,
    score: a.score.score, total: a.total, floor: a.floor, model_version: ctx.model.modelVersion,
    signals: a.score.signals, reasons: a.reasons, found_via: extra.found_via ?? null,
    path: extra.path ?? [], source_url: extra.source_url ?? null,
  };
}

/**
 * The final per-source score stamped on the source after entailment: the general family gains
 * its link structure and entailment agreement (the scholarly family's signals do not change -
 * scoring a paper from general signals is refused by scoreSource).
 */
export function finalScore(
  ctx: AdmissionContext,
  a: Assessment,
  observed: { supports: number; partial: number; unsupported: number; inbound: number; foundVia: number },
): { score: SourceScore; total: number } {
  if (a.score.family !== "general") {
    const w = weightedTotal(ctx.model, ctx.kind, a.score);
    return { score: a.score, total: w.total };
  }
  const g = a.score.signals as GeneralSignals;
  const signals: GeneralSignals = {
    ...g,
    link_structure: { inbound_corroborations: observed.inbound, found_via: observed.foundVia },
    entailment_agreement: { supports: observed.supports, partial: observed.partial, unsupported: observed.unsupported },
  };
  const score = scoreSource(ctx.model, "general", signals);
  return { score, total: weightedTotal(ctx.model, ctx.kind, score).total };
}
