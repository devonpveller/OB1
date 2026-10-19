// D5 items 6-7: what happens when a tombstoned URL comes back. PURE.
//
// The tombstone's reason type picks the PATH (declared per reason in the erasure_reasons
// registry, definition.reopen_path) and the eraser picks the GATE (erasers registry,
// definition.gate). A new reason or eraser that names an existing path or gate needs no code.
//   rescore_contest (debunked)  re-score like any hit; clearing its floor -> a contesting source
//                               with the debunking attached as criticism, surfaced as a dispute.
//   bar_check (credibility)     reopen only when the recorded confidence, score version and
//                               fingerprint show it now clears the bar it failed; a tombstone
//                               missing any of the three cannot have its bar computed -> refused.
//   note_only (deliberate)      append a reopen note; admit nothing.
//   gate auto       automation-erased: an admitting outcome needs no confirmation.
//   gate candidate  user-erased: an admitting outcome lands as a candidate for the operator.
export interface ScoreResult {
  available: boolean;
  value: number | null;
  floor: number | null;
  version: string | null;
  reason: string;
}

export interface TombstoneFacts {
  confidence: number | null;
  score_version: string | null;
  fingerprint: string | null;
}

export interface ReopenInput {
  path: string;
  gate: string;
  tombstone: TombstoneFacts;
  score: ScoreResult;
  candidateFingerprint: string | null;
}

export interface ReopenDecision {
  outcome: string; // a key of the admission_outcomes registry
  admits: boolean;
  reason: string;
}

const refused = (reason: string): ReopenDecision => ({ outcome: "refused", admits: false, reason });

function gated(gate: string, admitted: string, reason: string): ReopenDecision {
  if (gate === "auto") return { outcome: admitted, admits: true, reason };
  if (gate === "candidate") {
    return { outcome: "candidate", admits: false, reason: `${reason}; user-erased: awaits the operator` };
  }
  return refused(`unknown gate '${gate}' - refused`);
}

function clearsFloor(s: ScoreResult): boolean {
  return s.available && s.value !== null && s.floor !== null && s.value >= s.floor;
}

function rescoreContest(i: ReopenInput): ReopenDecision {
  if (!i.score.available) return refused(`re-score unavailable: ${i.score.reason}`);
  if (!clearsFloor(i.score)) return refused(`re-scored ${i.score.value} below floor ${i.score.floor}`);
  return gated(i.gate, "admitted_contesting", `re-scored ${i.score.value} >= floor ${i.score.floor}`);
}

function barCheck(i: ReopenInput): ReopenDecision {
  const t = i.tombstone;
  if (t.confidence === null || t.score_version === null || t.fingerprint === null) {
    return refused("the bar cannot be computed: the tombstone lacks confidence, score version or fingerprint");
  }
  if (!i.score.available) return refused(`re-score unavailable: ${i.score.reason}`);
  if (!clearsFloor(i.score)) return refused(`re-scored ${i.score.value} below floor ${i.score.floor}`);
  const revised = i.candidateFingerprint !== null && i.candidateFingerprint !== t.fingerprint;
  const newVersion = i.score.version !== null && i.score.version !== t.score_version;
  if (!revised && !newVersion) return refused("unchanged since removal (same fingerprint and score version)");
  if ((i.score.value as number) <= t.confidence) {
    return refused(`re-scored ${i.score.value} does not exceed the confidence at removal ${t.confidence}`);
  }
  return gated(i.gate, "admitted", `now ${i.score.value} > ${t.confidence} at removal and >= floor`);
}

export function decideReopen(i: ReopenInput): ReopenDecision {
  if (i.path === "rescore_contest") return rescoreContest(i);
  if (i.path === "bar_check") return barCheck(i);
  if (i.path === "note_only") {
    return { outcome: "note_appended", admits: false, reason: "deliberate erasure: reopen note appended" };
  }
  return refused(`unknown reopen path '${i.path}' - refused`);
}

// The pre-ingestion credibility stage (D15) lands in P3a. Until then the admission gate has no
// score to compute, and the only honest answer is "unavailable": nothing readmits on a guess.
export interface AdmissionScorer {
  score(input: { url: string; title: string; content: string; content_type: string }): Promise<ScoreResult>;
}

export const unavailableScorer: AdmissionScorer = {
  score: () =>
    Promise.resolve({
      available: false,
      value: null,
      floor: null,
      version: null,
      reason: "the pre-ingestion credibility stage lands in P3a (D15)",
    }),
};

// research-workbench P3a: the D15 pre-ingestion score of a URL, from the research service that
// owns the model (POST /research/credibility/score) - one implementation, read through HTTP, so
// the debunked and credibility reopen paths use the same score a research run admits by. A
// research service that cannot answer is "unavailable" (refused), never a guess; a claim kind
// with no weight row comes back as the research service's own refusal, naming the kind.
export function httpScorer(
  baseUrl: string,
  key: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 30_000,
): AdmissionScorer {
  const url = `${baseUrl.replace(/\/+$/, "")}/research/credibility/score`;
  return {
    async score(input) {
      const off = (reason: string): ScoreResult => ({ available: false, value: null, floor: null, version: null, reason });
      let r: Response;
      try {
        r = await fetchFn(url, {
          method: "POST", headers: { "content-type": "application/json", "x-brain-key": key },
          body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return off(`the D15 scorer is unreachable: ${(e as Error).message}`);
      }
      const d = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (!r.ok || !d) return off(`the D15 scorer answered ${r.status}: ${String(d?.detail ?? d?.error ?? "no body")}`);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      if (d.available !== true || num(d.value) === null || num(d.floor) === null) return off(`the D15 scorer gave no score: ${String(d.reason ?? "")}`);
      return { available: true, value: num(d.value), floor: num(d.floor), version: String(d.version ?? ""), reason: String(d.reason ?? "") };
    },
  };
}
