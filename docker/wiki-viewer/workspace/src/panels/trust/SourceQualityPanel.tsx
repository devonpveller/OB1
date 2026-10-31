// The source quality panel (P3b acceptance 3): why this source is rated as it is. Over quality() -
// shared knowledge, the same for every user. BOTH AXES of the panel library (research-panel-library
// 2026-09-18, panel 8): the LEGITIMACY axis - the D15 family score with what it was computed from and
// the family's signals; the RELEVANCE-FOR-RUN axis - how much of a run's claim set the source grounds
// (against the focused session's report, else per run it served; claims()). Then the ROLLING TOTAL with
// its reasons (every factor) and its history, and the sources corroborating or contradicting it.
import { useEffect, useMemo, useState } from "react";
import { C, get, q } from "../../lib/api";
import { useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import type { PanelProps } from "../../shell/registry";
import { setTrust, useTrust } from "./focus";
import { type LedgerClaim, relevanceOf } from "./logic";

interface QSource { source_id: string; title: string; family: string | null; relation: string; amount: number | null; claim: string | null }
interface Quality {
  source_id: string;
  state: string;
  family: string;
  score: { value: number | null; refinery_scoped: number | null; version: string; computed_from: string };
  claim_kind: string | null;
  signals: Record<string, unknown>;
  corroborated_by: QSource[];
  contradicted_by: QSource[];
  history: { score: number; total: number | null; claim_kind: string | null; model_version: string | null; computed_at: string }[];
  factors: { name: string; value: number; reason: string }[];
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
// what quality() answers, read defensively: a missing list is an empty one, never a crash
function asQuality(r: any): Quality {
  return {
    ...r, family: String(r?.family ?? "unknown"),
    score: { value: r?.score?.value ?? null, refinery_scoped: r?.score?.refinery_scoped ?? null, version: String(r?.score?.version ?? ""), computed_from: String(r?.score?.computed_from ?? "") },
    signals: r?.signals ?? {}, corroborated_by: arr(r?.corroborated_by), contradicted_by: arr(r?.contradicted_by),
    history: arr(r?.history), factors: arr(r?.factors),
  };
}
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : v.toFixed(2));

export function SourceQualityPanel(_p: PanelProps) {
  const picked = useTrust((s) => s.source);
  const report = useTrust((s) => s.report);
  const selected = useWorkspace((s) => s.reference);
  const source = picked ?? selected?.source_id ?? null;
  const [qual, setQual] = useState<Quality | null>(null);
  const [title, setTitle] = useState("");
  const [mine, setMine] = useState<LedgerClaim[]>([]);
  const [runClaims, setRunClaims] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!source) return;
    let live = true;
    setMsg("");
    setQual(null);
    get(`${C}/sources/${q(source)}/quality`).then((r) => live && setQual(asQuality(r))).catch((e) => live && setMsg(String((e as Error).message)));
    get(`${C}/references/${q(source)}`).then((r) => live && setTitle(r.source?.title ?? r.held?.title ?? "")).catch(() => live && setTitle(""));
    get(`${C}/claims?source_id=${q(source)}&limit=200`).then((r) => live && setMine(arr(r?.claims))).catch(() => live && setMine([]));
    return () => {
      live = false;
    };
  }, [source]);

  useEffect(() => {
    if (!report) return setRunClaims(null);
    let live = true;
    get(`${C}/claims?synthesis_id=${q(report)}&limit=200`).then((r) => live && setRunClaims(Number(r.count ?? 0))).catch(() => live && setRunClaims(null));
    return () => {
      live = false;
    };
  }, [report]);

  const relevance = relevanceOf(mine, report && runClaims !== null ? { report_id: report, claims: runClaims } : null);
  const familyFactor = qual?.factors.find((f) => f.name === `${qual.family}_family_score`) ?? null;

  const leaves = useMemo<Leaf[]>(() => {
    if (!qual) return [];
    return [
      {
        key: "total",
        label: <span data-testid="rolling-total">rolling total {fmt(qual.score.value)} ({qual.score.version})</span>,
        detail: (
          <ul className="ws-why" data-testid="total-reasons">
            <li>{qual.score.computed_from}</li>
            {qual.factors.map((f, i) => <li key={`${f.name}:${i}`} data-factor={f.name}>{f.name}: {String(f.value)} - {f.reason}</li>)}
          </ul>
        ),
      },
      {
        key: "history",
        label: <span data-testid="history">history: {qual.history.length} scoring{qual.history.length === 1 ? "" : "s"}</span>,
        detail: qual.history.length
          ? (
            <ol className="ws-why" data-testid="history-list">
              {qual.history.map((h, i) => (
                <li key={i}>{new Date(h.computed_at).toLocaleString()}: score {fmt(h.score)}, total {fmt(h.total)}
                  {h.claim_kind ? `, claim kind ${h.claim_kind}` : ""}{h.model_version ? ` (${h.model_version})` : ""}</li>
              ))}
            </ol>
          )
          : <p className="ws-muted">no scoring recorded yet (the total above is computed on read)</p>,
      },
      ...qual.corroborated_by.map((s) => ({
        key: `src:${s.source_id}:c`, label: <span>{s.title || s.source_id} - {s.relation}{s.amount !== null ? ` (+${fmt(s.amount)})` : ""}</span>,
        badges: ["corroborates"], detail: s.claim ? <p className="ws-muted">on: {s.claim}</p> : undefined,
      })),
      ...qual.contradicted_by.map((s) => ({
        key: `src:${s.source_id}:x`, label: <span>{s.title || s.source_id} - {s.relation}</span>,
        badges: ["contested"], detail: s.claim ? <p className="ws-muted">on: {s.claim}</p> : undefined,
      })),
    ];
  }, [qual]);

  if (!source) return <div className="ws-side ws-muted">Select a source (a reference, or a source in the claims ledger) to see why it is rated as it is.</div>;
  if (!qual) return <div className="ws-side ws-muted">{msg ? `quality unavailable: ${msg}` : "loading quality ..."}</div>;
  return (
    <div className="ws-side ws-quality" data-source={qual.source_id}>
      <h4 className="ws-quality-title">{title || qual.source_id}</h4>
      <dl className="ws-axes">
        <div data-testid="axis-legitimacy">
          <dt>legitimacy</dt>
          <dd>{qual.family} family score {fmt(familyFactor?.value ?? null)} - {familyFactor?.reason ?? "no family score recorded"}
            {qual.claim_kind ? `; claim kind ${qual.claim_kind}` : ""}
            {Object.keys(qual.signals ?? {}).length ? `; signals: ${Object.keys(qual.signals).join(", ")}` : ""}</dd>
        </div>
        <div data-testid="axis-relevance">
          <dt>relevance for the run</dt>
          <dd>{relevance.text}</dd>
        </div>
      </dl>
      <Disclosure
        testId="quality-disclosure"
        open
        summary={<span>rolling total {fmt(qual.score.value)} - {qual.factors.length} reason{qual.factors.length === 1 ? "" : "s"}, {qual.history.length} in its history</span>}
        leaves={leaves}
        actions={(l) => {
          const m = /^src:([^:]+):/.exec(l.key);
          return m ? <button type="button" data-action="focus-source" onClick={() => setTrust({ source: m[1] })}>Show its quality</button> : null;
        }}
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}
