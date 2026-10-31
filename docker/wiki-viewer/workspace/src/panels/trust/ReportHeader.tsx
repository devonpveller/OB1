// The report header (P3b acceptance 4, D15 item 5): the report credibility roll-up WITH the claim-kind
// weights it used - the contract's statement (never a bare number) and the weights as a table. The
// export carries the same section (workbench contracts/repo/trust.ts rollupMarkdown).
import { useEffect, useState } from "react";
import { C, get, q } from "../../lib/api";

export interface Rollup {
  report_id: string | null;
  recorded: boolean;
  value: number | null;
  claims: number;
  below_floor: number;
  claim_kind: string | null;
  model_version: string | null;
  weights: { family: string; weight: number }[];
  statement: string;
}

export function ReportHeader({ rollup }: { rollup: Rollup }) {
  return (
    <header className="ws-report-header" data-testid="report-header" data-recorded={rollup.recorded ? "1" : "0"}>
      <p className="ws-rollup" data-testid="rollup-statement">{rollup.statement}</p>
      {rollup.weights.length > 0 && (
        <table className="ws-weights" data-testid="rollup-weights">
          <caption>claim-kind weights used{rollup.claim_kind ? ` (claim kind ${rollup.claim_kind})` : ""}</caption>
          <thead><tr><th>source family</th><th>weight</th></tr></thead>
          <tbody>
            {rollup.weights.map((w) => <tr key={w.family} data-family={w.family}><td>{w.family}</td><td>{w.weight.toFixed(2)}</td></tr>)}
          </tbody>
        </table>
      )}
    </header>
  );
}

// The header of a report by id (shared knowledge: every user reads the same roll-up).
export function ReportHeaderById({ reportId }: { reportId: string }) {
  const [r, setR] = useState<Rollup | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    setR(null);
    get(`${C}/reports/${q(reportId)}/credibility`).then((x) => live && setR(x)).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [reportId]);
  if (r) return <ReportHeader rollup={r} />;
  return <p className="ws-muted" data-testid="report-header-missing">{msg ? `report credibility unavailable: ${msg}` : "loading the report credibility ..."}</p>;
}
