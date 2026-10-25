/**
 * claim-list.ts - THE claim list a tagged synthesis files (rw-p3a-entail attempt 6, the structural round).
 *
 * ONE DERIVATION. This file is the only place that says which claims a synthesis yields: the tag
 * segments, the claim text (citation markers stripped), the citations, the tag -> edge rule
 * (claim-edges.ts), and every rule that drops a segment - an empty claim text, a claim with no
 * grounding edge, a claim whose text repeats an earlier one of the same synthesis (case-insensitive),
 * and the deterministic meta-claim filter. The research curator files exactly `claimList(...).claims`
 * (claims.ts writeClaims), and the research service scores exactly `claimList(...).claims` of the
 * package it hands the curator (credibility.ts filedClaimsCredibility), so the claims the report
 * footer and research_jobs.metrics.credibility score ARE the claims the curator files - by
 * construction, not by a second parser kept in step. Attempts 2-5 kept a second derivation in the
 * research service and each round closed one difference (edge factor, re-tag timing, held-only lines,
 * same-run duplicate text, empty text); there is no second derivation left to differ.
 *
 * The two services build from separate Docker contexts, so the research service carries a
 * byte-identical copy at integrations/research-service/claim-list.ts (as it does claim-edges.ts);
 * claim-edges.test.ts in BOTH services fails when either pair differs, and run-credibility-e2e.ps1
 * checks it too. Edit this file, then copy it. Pure, dependency-free (claim-edges.ts only).
 *
 * What the curator applies AFTER this list, and the research service cannot (named residuals): the
 * LLM meta judge (index.ts metaJudge, fails open), a citation whose source did not persist
 * (sourceIds[N-1] null), and the database's own text dedup (find_or_create_claim:
 * md5(lower(btrim(text))) within a thread - across runs, and on case mappings where Postgres' lower()
 * and JavaScript's toLowerCase() differ). This list is NOT made to match lower(btrim()) (collation-
 * dependent; it would move the seam): since rw-p3a-figure-filed the curator's writeClaims returns,
 * per claim of this list, the row it filed it into (filed[], null = not filed), and the research
 * service re-states the report figure from that filing result (credibility.ts filedClaimsCredibility).
 */

import { claimEdges, type EpistemicTag, type ParsedEdge } from "./claim-edges.ts";

export interface ParsedClaim {
  text: string;
  tag: EpistemicTag;
  edges: ParsedEdge[];
}

export interface ParseResult {
  claims: ParsedClaim[];
  /** [GAP] segments — recorded, never stored as claims (rule #7). */
  gaps: string[];
}

/** A claim of the list, with the offset of its tag marker in the synthesis (its line = the newlines before it). */
export interface ListedClaim extends ParsedClaim {
  start: number;
}

/** Why a tagged segment is not filed. */
export type DropReason = "empty_text" | "no_edges" | "duplicate_text" | "meta_pattern";
export interface DroppedSegment {
  start: number;
  tag: string;
  text: string;
  reason: DropReason;
  /** duplicate_text: the start of the earlier claim whose text it repeats */
  duplicateOf?: number;
}

/** What writeClaims files from a synthesis, in order, and every segment it does not. */
export interface ClaimList {
  /** the claims, in synthesis order - writeClaims files exactly these (then its judge / source rules) */
  claims: ListedClaim[];
  /** claims the deterministic meta-claim filter refuses (writeClaims reports each through onMetaSkip) */
  metaSkipped: ListedClaim[];
  /** every tagged segment that is not a claim of `claims`, with its reason, in synthesis order */
  dropped: DroppedSegment[];
  /** [GAP] segments - recorded, never stored as claims (rule #7). */
  gaps: string[];
}

const TAG_RE = /\[(SOURCED|INFERRED|UNCERTAIN|GAP)\]/gi;
// Tolerant of every shape: [Source 1] / [Source 1, 2] / [Sources 1, 2 and 3] /
// [Source 1, Source 2, Source 4] — extract every number inside a [Source...] bracket.
const SRC_RE = /\[Sources?\b[^\]]*\]/gi;

function parseSourceNumbers(segment: string): number[] {
  const nums: number[] = [];
  for (const bracket of segment.match(SRC_RE) || []) {
    for (const d of bracket.match(/\d+/g) || []) {
      const n = parseInt(d, 10);
      if (n > 0 && !nums.includes(n)) nums.push(n);
    }
  }
  return nums;
}

/** Strip citation markers + tidy whitespace to get the bare claim text. */
function cleanClaimText(segment: string): string {
  return segment
    .replace(SRC_RE, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-*•:]+/, "")
    .replace(/[\s\-*•]+$/, "")
    .trim();
}

// ── Meta-claim filter (research-trust 2026-09-11, PLAN Phase 3.1) ───────────
// A claim is a statement about the WORLD. A statement about the SOURCES or
// about this RUN is not a claim, and eight of them are in the claims table
// because nothing here distinguished the two. The worst is stored at 0.85:
//   "The provided sources contain no information specific to the Dell OptiPlex
//    3050 model; all sources reference other platforms…"
// It carries the query's own vocabulary, so the NEXT OptiPlex query recalls it
// as known knowledge and the engine argues with itself.
//
// Two layers, in this order: these patterns, then (for what they do not
// recognise) an LLM judge that FAILS OPEN. Patterns reject; only a confident
// judge verdict rejects beyond them.
//
// ── THE HEAD-CLAUSE RULE (2026-09-11, after the tester's T7 failure) ────────
// The first version judged the WHOLE claim line, so a real fact carrying an
// honest caveat was deleted along with the caveat. Five live claims were being
// eaten — Companies House SR01 form fields, the six-month wait after
// dissolution, registered-office ordering, Conventional Commits keywords, the
// WSO2 licence — each of the shape
//     <a fact about the world>, but/though/; <the sources do not confirm it>.
// Every honest claim is entitled to that tail; it is the engine doing what it
// is supposed to do. So the source-referential and absence-of-evidence families
// are now tested against the HEAD CLAUSE only — the text before the first `;`
// or `, but` / `, though` / `, although` / `, however`. What survives whole-text
// testing is the family that cannot be a caveat: a claim whose whole point is
// that the evidence is about something OTHER than the subject.
//
// A filter that eats knowledge is a worse outcome than the poison it removes.

/**
 * The clause a claim actually asserts. A caveat introduced by `;`, `, but`,
 * `, though`, `, although` or `, however` comments on the assertion; it is not
 * the assertion. Returns the whole text when there is no such break.
 */
export function headClause(text: string): string {
  const t = String(text || "");
  const m = t.match(/;|,\s+(but|though|although|however|whereas|yet)\b/i);
  return (m && m.index !== undefined ? t.slice(0, m.index) : t).trim();
}

/**
 * The head sentence's clauses, each stripped of its subordinator so a
 * `^`-anchored subject pattern can see the subject.
 *
 * The `^` anchor is deliberate — it is what makes these patterns test the
 * SUBJECT rather than fire on any mention of "the sources" — but a LEADING
 * subordinate clause defeated it: "While the provided sources do not address
 * the Dell OptiPlex 3050, they describe the NVIDIA DGX Spark…" is a restatement
 * of the 0.85 poison that attempt 1 caught and attempt 2 did not (tester, X1).
 * So the head is split at `While|Although|Though|Whereas|If|When|Because|Since`
 * and at the comma that ends such a clause, and EVERY resulting clause is
 * judged. A claim is meta if ANY clause's subject is the evidence set.
 */
export function headClauses(text: string): string[] {
  const head = headClause(text);
  // Only a LEADING contrast subordinator restructures the sentence into
  // "<subordinate>, <main>" — and only then does the subject of the second
  // clause need judging separately. A subordinator later in the sentence
  // introduces a REASON ("…, since the sources describe these as independent
  // properties"), which is a justification for a world claim and belongs with
  // the caveat tail. Judging it as a subject cost one live false positive
  // (`083b830e`, an EFS architecture claim) the first time this was written.
  const lead = head.match(/^\s*(while|although|though|whereas|even\s+though)\b\s*/i);
  if (!lead) return [head];
  const rest = head.slice(lead[0].length);
  const comma = rest.search(/,(?![^(]*\))/);
  if (comma < 0) return [rest.trim()];
  return [rest.slice(0, comma).trim(), rest.slice(comma + 1).trim()].filter(Boolean);
}

/**
 * Family 1 — HEAD-ONLY. The thing the sentence is ABOUT is the evidence set:
 * its grammatical subject is "the sources", "no source", "the retrieved pages",
 * "this report". Judged on the head clause, so "…, but the sources do not state
 * its licence type" keeps its claim.
 */
const SOURCE_SUBJECT: RegExp[] = [
  // "The (provided) sources <report-verb> …" as the subject of the head clause.
  /^\W*the\s+(provided\s+|given\s+|available\s+|retrieved\s+|gathered\s+|held\s+)?sources?\b/i,
  // "No source / no provided sources <report-verb> …"
  /^\W*no\s+(provided\s+|available\s+|retrieved\s+)?sources?\b/i,
  /\bno\s+(provided\s+|available\s+|retrieved\s+)?sources?\s+(\w+\s+){0,2}(mention|state|says?|confirm|document|describe|address|explain|discuss|give|list|name|report|indicate|support|cover|contain|provide|specif\w*|clarif\w*|enumerat\w*|frame|label|explicitly)/i,
  /\bnone\s+of\s+(these|the|those)\s+sources?\b/i,
  /^\W*(the\s+)?(retrieved|gathered|fetched|provided|available)\s+(pages?|material|documents?|results?|excerpts?)\b/i,
  /^\W*(this|the)\s+(report|run|search|analysis)\s+(could\s+not|did\s+not|does\s+not|failed\s+to)\b/i,
  /^\W*nothing\s+in\s+the\s+(reviewed|provided|retrieved|available|gathered|cited)\b/i,
  /^\W*in\s+the\s+sources\s+provided\b/i,
];

/**
 * Family 2 — HEAD-ONLY. Absence OF EVIDENCE, said without the word "source"
 * (the tester's B4): "No evidence exists that…", "The literature is silent
 * on…", "No study has tested…". These are claims about the state of the
 * record, and they poison a knowledge base exactly as the audited ones do.
 *
 * Absence in the WORLD is a different thing and must survive: "no evidence OF
 * tampering on the chassis" asserts a fact about a chassis. The separator is
 * the complement — an evidence-absence sentence takes a CLAUSE ("that…",
 * "linking…", "on whether…"), a world-absence sentence takes "of <noun>".
 */
const EVIDENCE_ABSENCE: RegExp[] = [
  /\bno\s+(published\s+|peer-reviewed\s+|available\s+|reviewed\s+|existing\s+)?(evidence|research|literature|documentation|publications?|studies|data)\s+(exists?|was\s+found|were\s+found|has\s+been\s+found|have\s+been\s+found|that\b|linking\b|links\b|addresses\b|addressing\b|supports?\b|indicates?\b|suggests?\b|shows?\b|describ\w+\b|tests?\b|tested\b|examin\w+\b|on\s+whether\b)/i,
  /\bno\s+(study|studies|paper|papers|publication|article|source|document|report)\s+(has|have)\s+(yet\s+)?(tested|examined|measured|reported|addressed|investigated|established|shown|found|confirmed)\b/i,
  /\b(the\s+)?(reviewed\s+|available\s+|retrieved\s+|published\s+)?literature\s+(is|remains)\s+silent\b/i,
  /^\W*no\s+information\s+(specific\s+)?.{0,90}?\b(was|were|is|are)\s+(found|available|retrieved|present)\b/i,
  // A bare "there is no evidence/research …" pattern lived here and fired on
  // "There is no research BUDGET allocated to the programme", where the
  // evidence noun heads a compound and the sentence is about money. Every B4
  // case is already caught by a sibling above, so the bare form is not needed
  // and the false positive is not worth it.
];

/**
 * Family 3 — WHOLE TEXT. The TRANSFER DISCLAIMER: the sentence's purpose is to
 * say that the evidence is about something OTHER than the subject researched.
 * "documented for the DGX Spark … NOT confirmed for the OptiPlex 3050",
 * "pertain to the DGX Spark, not the Dell OptiPlex 3050". This is never a
 * caveat on a claim — it IS the claim, and it is a claim about applicability of
 * evidence. Four of the eight audited poison texts have this shape, and their
 * head clause is an ordinary world sentence, which is why this family cannot be
 * head-restricted.
 */
const CONTRAST = /\b(not|n't|no\s+source|however|but|while|whereas|rather\s+than)\b/i;
// Present-tense forms matter: poison `1306bb5a` says "the sources DESCRIBE this
// for ASUS and Compaq boards", and a past-participle-only list missed it.
//
// Only "<verb> (this) FOR <Named thing>" counts. An "in" branch and an optional
// "that" were here and produced three false positives on the live table, every
// one of them an ordinary attribution: "The article notes that in August 2026,
// several AI browsers were demonstrated vulnerable…", "…(as noted in CNN's
// coverage)…", "OpenAI stated that for Astra specifically, it invested in…".
// Reporting what a named party said is not a transfer disclaimer; the poison
// shape is always "the evidence covers X, and X is not what you asked about".
const TRANSFER_SUBJECT =
  /\b(documented|documents|document|described|describes|describe|stated|states|state|reported|reports|report|noted|notes|observed|observes|shown|shows|demonstrated|demonstrates|established|establishes|confirmed|confirms)\s+(this\s+|these\s+|it\s+)?for\s+(the\s+|a\s+|an\s+)?[A-Z0-9]/;

const TRANSFER_DISCLAIMER: RegExp[] = [
  /\bpertains?\s+to\s+[^,;]+,\s*not\s+(the|a|an)\b/i,
  /\bnot\s+confirmed\s+(as|for|in)\b/i,
  /\bcannot\s+be\s+(directly\s+)?extrapolated\b/i,
  /\bdoes\s+not\s+rule\s+out\b/i,
  // A claim that cites "Source N" INSIDE its own text is describing the
  // evidence set, not the world. (The [Source N] markers are stripped before
  // this runs; a bare "(Source 3)" in prose is not.)
  /\(\s*sources?\s+\d+\s*\)/i,
];

export type MetaVerdict = "meta" | "world";

/**
 * Deterministic half of the filter. "world" means ONLY that these patterns did
 * not recognise it — the caller may still ask the judge.
 */
export function classifyMetaClaim(text: string): MetaVerdict {
  const t = String(text || "");
  if (!t.trim()) return "world";
  for (const clause of headClauses(t)) {
    for (const re of SOURCE_SUBJECT) if (re.test(clause)) return "meta";
    for (const re of EVIDENCE_ABSENCE) if (re.test(clause)) return "meta";
  }
  for (const re of TRANSFER_DISCLAIMER) if (re.test(t)) return "meta";
  // The transfer disclaimer spelled out rather than idiomatic: the evidence is
  // attributed to a NAMED other thing AND the sentence contrasts that with the
  // subject. Both halves are required — "documented for Python 3.12" alone is
  // an ordinary fact.
  if (TRANSFER_SUBJECT.test(t) && CONTRAST.test(t)) return "meta";
  return "world";
}

// ── Omnibus citations (PLAN Phase 3.2) ──────────────────────────────────────
// OMNIBUS_CITATION_MAX, isOmnibusCitation and the tag -> edge rule: claim-edges.ts (attempt 4).

const TAG_MAP: Record<string, EpistemicTag | "gap"> = {
  SOURCED: "sourced",
  INFERRED: "inferred",
  UNCERTAIN: "uncertain",
  GAP: "gap",
};

/**
 * Parse a tagged synthesis into claim candidates + gaps. Pure; no DB, no network.
 * A tagged segment runs from its tag marker to the next tag (or end of text).
 */
function parseSegments(synthesis: string): { claims: ListedClaim[]; gaps: string[]; dropped: DroppedSegment[] } {
  const text = String(synthesis || "");
  const claims: ListedClaim[] = [];
  const gaps: string[] = [];
  const dropped: DroppedSegment[] = [];
  const seen = new Map<string, number>();

  // Collect all tag positions in order.
  const marks: Array<{ tag: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    marks.push({ tag: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < marks.length; i++) {
    const here = marks[i];
    const next = marks[i + 1];
    const segment = text.slice(here.end, next ? next.start : text.length);
    const kind = TAG_MAP[here.tag];
    if (!kind) continue;

    if (kind === "gap") {
      const g = cleanClaimText(segment);
      if (g) gaps.push(g);
      continue;
    }

    const claimText = cleanClaimText(segment);
    if (!claimText) {
      dropped.push({ start: here.start, tag: here.tag, text: "", reason: "empty_text" });
      continue;
    }
    const nums = parseSourceNumbers(segment);
    // Phase 3.2 — a line citing more than OMNIBUS_CITATION_MAX sources is
    // summarising the pool, not asserting a fact eleven sources each state.
    // attempt 4: the ONE rule (claim-edges.ts)
    const filed = claimEdges(kind, nums)!;
    const effectiveTag: EpistemicTag = filed.tag;
    const edges = filed.edges;
    // Rule #1 gate: a claim with no grounding edge is not admitted. (It is
    // neither stored nor counted as a gap — it was an untethered assertion.)
    if (edges.length === 0) {
      dropped.push({ start: here.start, tag: here.tag, text: claimText, reason: "no_edges" });
      continue;
    }

    const dedupKey = claimText.toLowerCase();
    if (seen.has(dedupKey)) {
      dropped.push({ start: here.start, tag: here.tag, text: claimText, reason: "duplicate_text", duplicateOf: seen.get(dedupKey) });
      continue;
    }
    seen.set(dedupKey, here.start);

    claims.push({ text: claimText, tag: effectiveTag, edges, start: here.start });
  }

  return { claims, gaps, dropped };
}

/** The parse alone (before the meta-claim filter): claims + gaps. Pure; no DB, no network. */
export function parseSynthesisClaims(synthesis: string): ParseResult {
  const p = parseSegments(synthesis);
  return { claims: p.claims.map(({ text, tag, edges }) => ({ text, tag, edges })), gaps: p.gaps };
}

/**
 * THE claim list (attempt 6): the parse, then the deterministic meta-claim filter - the list
 * writeClaims files, and the list the research service scores. Pure; no DB, no network.
 */
export function claimList(synthesis: string): ClaimList {
  const p = parseSegments(synthesis);
  const claims: ListedClaim[] = [];
  const metaSkipped: ListedClaim[] = [];
  const dropped = [...p.dropped];
  for (const c of p.claims) {
    // Phase 3.1 — a statement ABOUT THE RUN is not a claim about the world and must not enter the
    // knowledge base. This is the pattern layer; the LLM judge for the rest is the curator's (claims.ts).
    if (classifyMetaClaim(c.text) === "meta") {
      metaSkipped.push(c);
      dropped.push({ start: c.start, tag: c.tag.toUpperCase(), text: c.text, reason: "meta_pattern" });
    } else {
      claims.push(c);
    }
  }
  dropped.sort((a, b) => a.start - b.start);
  return { claims, metaSkipped, dropped, gaps: p.gaps };
}
