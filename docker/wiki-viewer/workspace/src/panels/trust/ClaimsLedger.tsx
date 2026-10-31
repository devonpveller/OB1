// The claims ledger (P3b acceptance 1): what the system holds as true here and how strongly. Over
// claims() - shared knowledge, the same for every user. Scope: the focused session's report (the
// coverage panel), else the selected source (the ledger of everything it grounds). Each row carries
// every column: tag, entailment verdict, the stance bar from the edge types, the corroboration count,
// the contradicted-by-newer flag and the confidence; sortable by confidence and by needs-a-look.
import { useEffect, useMemo, useState } from "react";
import { C, get, q } from "../../lib/api";
import { useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import type { PanelProps } from "../../shell/registry";
import { openPanel } from "../../shell/dock";
import { type LedgerClaim, needsALook, type SortKey, sortClaims, stanceOf } from "./logic";
import { setTrust, useTrust } from "./focus";
import { ReportHeaderById } from "./ReportHeader";

// a claim as the ledger reads it: every column present (a field the contract did not send reads as its empty value)
function asClaim(c: any): LedgerClaim {
  return {
    ...c, epistemic_tag: String(c?.epistemic_tag ?? ""), confidence: Number(c?.confidence ?? 0), edges_by_type: c?.edges_by_type ?? {},
    sources: Array.isArray(c?.sources) ? c.sources : [], verdict: typeof c?.verdict === "string" ? c.verdict : null,
    corroborations: Number(c?.corroborations ?? 0), contradicted_by_newer: !!c?.contradicted_by_newer, contradicted: !!c?.contradicted,
    grounded: c?.grounded !== false, synthesis_id: c?.synthesis_id ?? null,
  };
}

export const LEDGER_COLUMNS = ["tag", "verdict", "stance", "corroboration", "contradicted by newer", "confidence"] as const;

export function StanceBar({ edges }: { edges: Record<string, number> }) {
  const s = stanceOf(edges);
  const pct = (n: number) => (s.total ? `${(100 * n) / s.total}%` : "0");
  return (
    <span className="ws-stance" data-testid="stance-bar" data-supports={s.supports} data-contradicts={s.contradicts} data-mentions={s.mentions}
      title={`${s.supports} supporting, ${s.contradicts} contradicting, ${s.mentions} mentioning edge(s)`}>
      <span className="ws-stance-sup" style={{ width: pct(s.supports) }} />
      <span className="ws-stance-con" style={{ width: pct(s.contradicts) }} />
      <span className="ws-stance-men" style={{ width: pct(s.mentions) }} />
    </span>
  );
}

function Row({ c }: { c: LedgerClaim }) {
  return (
    <span className="ws-ledger-row" data-claim={c.id}>
      <span className="ws-col" data-col="tag">{c.epistemic_tag}</span>
      <span className="ws-col" data-col="verdict">{c.verdict ?? "not judged"}</span>
      <span className="ws-col" data-col="stance"><StanceBar edges={c.edges_by_type} /></span>
      <span className="ws-col" data-col="corroboration">+{c.corroborations}</span>
      <span className="ws-col" data-col="contradicted by newer">{c.contradicted_by_newer ? "contradicted by newer" : "-"}</span>
      <span className="ws-col" data-col="confidence">{c.confidence.toFixed(2)}</span>
      <span className="ws-claim-text">{c.text}</span>
    </span>
  );
}

export function ClaimsLedger(_p: PanelProps) {
  const report = useTrust((s) => s.report);
  const pickedSource = useTrust((s) => s.source);
  const selected = useWorkspace((s) => s.reference);
  const source = pickedSource ?? selected?.source_id ?? null;
  const scope = report ? { key: "synthesis_id", id: report, label: "the focused session's report" }
    : source ? { key: "source_id", id: source, label: "the claims this source grounds" } : null;
  const [claims, setClaims] = useState<LedgerClaim[]>([]);
  const [by, setBy] = useState<SortKey>("needs-a-look");
  const [desc, setDesc] = useState(true);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!scope) return;
    let live = true;
    setMsg("");
    get(`${C}/claims?${scope.key}=${q(scope.id)}&limit=200`).then((r) => live && setClaims(Array.isArray(r?.claims) ? r.claims.map(asClaim) : []))
      .catch((e) => live && (setClaims([]), setMsg(String((e as Error).message))));
    return () => {
      live = false;
    };
  }, [scope?.key, scope?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortClaims(claims, by, desc), [claims, by, desc]);
  const leaves = useMemo<Leaf[]>(() => sorted.map((c) => {
    const look = needsALook(c);
    return {
      key: c.id,
      label: <Row c={c} />,
      badges: [...(c.contradicted_by_newer ? ["contradicted by newer"] : []), ...(c.contradicted ? ["contradicted"] : [])],
      detail: (
        <ul className="ws-why">
          <li>needs a look: {look.reasons.length ? look.reasons.join("; ") : "nothing flagged"}</li>
          {c.sources.map((s) => <li key={`${s.source_id}:${s.edge_type}`}>{s.edge_type}: {s.title || s.source_id} ({s.lifecycle})</li>)}
        </ul>
      ),
    };
  }), [sorted]);
  const sortBy = (k: SortKey) => {
    if (k === by) setDesc(!desc);
    else {
      setBy(k);
      setDesc(true);
    }
  };
  if (!scope) return <div className="ws-side ws-muted">Focus a session in Coverage, or select a source, to list its claims.</div>;
  return (
    <div className="ws-side ws-ledger" data-scope={scope.key}>
      {report && <ReportHeaderById reportId={report} />}
      <div className="ws-controls" aria-label="sort">
        sort by
        <button type="button" data-sort="confidence" aria-pressed={by === "confidence"} onClick={() => sortBy("confidence")}>
          confidence{by === "confidence" ? (desc ? " (high first)" : " (low first)") : ""}
        </button>
        <button type="button" data-sort="needs-a-look" aria-pressed={by === "needs-a-look"} onClick={() => sortBy("needs-a-look")}>
          needs a look{by === "needs-a-look" ? (desc ? " (most first)" : " (least first)") : ""}
        </button>
      </div>
      <div className="ws-ledger-head" data-testid="ledger-columns">
        {LEDGER_COLUMNS.map((h) => <span key={h} className="ws-col" data-col={h}>{h}</span>)}
      </div>
      <Disclosure
        testId="ledger-disclosure"
        open={!!report}
        summary={<span>{claims.length} claim{claims.length === 1 ? "" : "s"} - {scope.label}</span>}
        leaves={leaves}
        actions={(l) => {
          const c = claims.find((x) => x.id === l.key)!;
          return (
            <>
              {c.sources.map((s) => (
                <button key={s.source_id + s.edge_type} type="button" data-action="source-quality"
                  onClick={() => { setTrust({ source: s.source_id }); openPanel("source-quality"); }}>
                  Quality of {s.title || s.source_id.slice(0, 8)}
                </button>
              ))}
            </>
          );
        }}
        empty="no claims in this scope"
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}
