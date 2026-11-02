// The cleanup view's decisions (research-workbench P8a, rw-p8a2-cleanup; D5 items 5-7). PURE.
//
// 1. A listed source's erase is OFFERED only when it is unlinked with zero blocking connections - the
//    same gate erase() enforces; the listing never offers more than the write would allow.
// 2. A tombstone is a REOPEN CANDIDATE only when the operator has something to decide, and it always
//    carries the evidence that made it one:
//      rescore_contest (debunked), user-erased: an attempt the admission gate answered `candidate`
//          whose recorded re-score clears its floor -> a proposed contesting source, dispute previewed
//      bar_check (credibility), user-erased: an attempt answered `candidate` (the bar was cleared)
//      note_only (deliberate), any eraser: an attempt that appended a reopen note
//    Never a candidate: a lifted or readmitted tombstone, and an automation-erased tombstone on the
//    debunked / credibility paths (the gate readmits those itself; the trail records the readmission).
import type { KindDef } from "./dependence.ts";

// The listing's counts carry a FIXED key set (rw-p8a2-cleanup round 2, tester D1): every dependence kind the
// migrations seed (init-research-contract.sql, init-references.sql), zero-filled, so every row has the same keys
// whichever source comes first. A kind the registry gains later is kept beside them (the schema's catchall);
// cleanup_round2_test.ts fails when the migrations seed a kind this list lacks.
export const DEPENDENCE_KINDS = [
  "chunk", "citing_page", "claim_edge", "document_link", "entity_grounding", "found_via_lead", "reference_record",
  "report_citation", "report_session", "trail_event",
] as const;

export function fullCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(DEPENDENCE_KINDS.map((k) => [k, 0]));
  for (const [k, n] of Object.entries(counts ?? {})) out[k] = n;
  return out;
}

export interface ListedCounts {
  counts: Record<string, number>;
  blocking: number;
  severable: number;
  total: number;
}

// Dependence counts per kind -> blocking / severable totals, by the dependence_kinds registry
// (an undeclared kind blocks and is not severable: fail closed, as aggregateDependence does).
export function tallyCounts(counts: Record<string, number>, defs: Map<string, KindDef>): ListedCounts {
  let blocking = 0, severable = 0, total = 0;
  for (const [kind, n] of Object.entries(counts)) {
    const d = defs.get(kind) ?? { blocks_erase: true, severable: false };
    total += n;
    if (d.blocks_erase) blocking += n;
    if (d.severable) severable += n;
  }
  return { counts, blocking, severable, total };
}

export function eraseOffered(lifecycle: string, blocking: number): boolean {
  return lifecycle === "unlinked" && blocking === 0;
}

export interface AttemptScore {
  available?: boolean;
  value?: number | null;
  floor?: number | null;
  version?: string | null;
  reason?: string;
}

export interface CandidateAttempt {
  path: string;
  outcome: string;
  session_id: string | null;
  note: string | null;
  attempted_at: string;
  reason: string | null;
  score: AttemptScore | null;
}

export interface CandidateTombstone {
  id: string;
  reason_type: string;
  note: string | null;
  erased_at: string;
  lifted_at: string | null;
  readmitted_source_id: string | null;
  attempts: CandidateAttempt[];
}

export interface Candidate {
  kind: "proposed_contesting" | "credibility_cleared" | "reopen_note";
  evidence: CandidateAttempt[];
  dispute_preview: {
    criticism: { tombstone_id: string; reason_type: string; note: string | null; erased_at: string };
    score: AttemptScore;
  } | null;
}

const clears = (s: AttemptScore | null): boolean =>
  !!s && s.available === true && typeof s.value === "number" && typeof s.floor === "number" && s.value >= s.floor;

// `path` is the tombstone reason's reopen_path (erasure_reasons registry), `gate` its eraser's gate
// (erasers registry). null = not a candidate.
export function candidateOf(t: CandidateTombstone, path: string, gate: string): Candidate | null {
  if (t.lifted_at || t.readmitted_source_id) return null;
  if (path === "note_only") {
    const evidence = t.attempts.filter((a) => a.outcome === "note_appended");
    return evidence.length ? { kind: "reopen_note", evidence, dispute_preview: null } : null;
  }
  // debunked / credibility: only a user-erased tombstone waits for a person (D5 item 7)
  if (gate !== "candidate") return null;
  const evidence = t.attempts.filter((a) => a.outcome === "candidate" && clears(a.score));
  if (!evidence.length) return null;
  if (path === "rescore_contest") {
    const last = evidence[evidence.length - 1];
    return {
      kind: "proposed_contesting", evidence,
      // exactly what the debunked-path admission would attach (repo/lifecycle.ts readmit): the
      // debunking as criticism on the contesting source, with the score that cleared the floor
      dispute_preview: {
        criticism: { tombstone_id: t.id, reason_type: t.reason_type, note: t.note, erased_at: t.erased_at },
        score: last.score!,
      },
    };
  }
  if (path === "bar_check") return { kind: "credibility_cleared", evidence, dispute_preview: null };
  return null; // an unknown reopen path: nothing to offer (fail closed)
}

// The shared rows a cleanup action writes name the ACTION, never the user (init-cleanup.sql).
export const ACTION_REF = (id: string) => `cleanup-action:${id}`;
export const ACTION_REF_RE = /^cleanup-action:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
