// The export panel (research-workbench P6b, rw-p6b-gate): export one of MY documents to PDF through the
// verification gate, and see my exports - passed (download again) or blocked (the blocking findings and
// warnings, the file never served). Per user (07-MULTI-USER): the documents are the contract's
// documents listing and the exports are GET /workbench/exports - both answered for the signed-in
// subject only (the identity seam's owner scope); this panel sends no user of its own.
import { useEffect, useMemo, useState } from "react";
import { C, get, q, raw } from "../../lib/api";
import { useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

export const X = "/workbench/exports";

interface Finding {
  code: string;
  page?: number;
  detail: string;
  stage?: string;
}
interface Run {
  id: string;
  path: string;
  format: string;
  style: string;
  status: "passed" | "blocked";
  blocking_findings: Finding[];
  warnings: Finding[];
  filename: string;
  created_at: string;
}
interface Doc {
  title: string;
  path: string;
}

const findingText = (f: Finding) => `${f.code}${f.page ? ` (page ${f.page})` : ""}: ${f.detail}`;

function save(blob: Blob, name: string) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* no download in this environment (tests) */ }
}

export function ExportPanel(_p: PanelProps) {
  const open = useWorkspace((s) => s.documentPath);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [last, setLast] = useState<{ status: string; blocking: Finding[]; warnings: Finding[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([get(`${C}/documents?limit=500`), get(`${X}?limit=50`)]).then(([d, r]) => {
      if (!live) return;
      setDocs((d.documents ?? []).filter((x: Doc) => !/\/\.(trash|archive)\//.test(x.path)));
      setRuns(r.exports ?? []);
    }).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [tick]);
  const chosen = target || open || docs[0]?.path || "";

  const exportPdf = async () => {
    if (!chosen) return;
    setBusy(true);
    setMsg("");
    setLast(null);
    try {
      const r = await raw(`/workbench/export?path=${q(chosen)}&format=pdf`);
      if (r.ok) {
        const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "export.pdf";
        save(await r.blob(), name);
        setLast({ status: "passed", blocking: [], warnings: [] });
        setMsg(`passed the verification gate (${r.headers.get("x-export-warnings") ?? "0"} warning(s)); downloaded`);
      } else {
        let b: any = {};
        try { b = await r.json(); } catch { /* not json */ }
        if (b.code === "layout-gate") {
          setLast({ status: "blocked", blocking: b.blocking_findings ?? [], warnings: b.warnings ?? [] });
          setMsg("blocked by the verification gate: the file was not served");
        } else {
          setMsg(String(b.error ?? `HTTP ${r.status}`));
        }
      }
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  const leaves = useMemo<Leaf[]>(() => [
    { key: "new", label: <span data-leaf-new="1">export a document to PDF</span> },
    ...runs.map((r) => ({
      key: r.id,
      badges: [r.status, r.format],
      label: <span data-export={r.id} data-status={r.status}>{r.path.split("/").pop()}</span>,
      detail: <span className="ws-muted">{new Date(r.created_at).toLocaleString()} - {r.blocking_findings.length} blocking, {r.warnings.length} warning(s)</span>,
    })),
  ], [runs]);

  const actions = (l: Leaf) => {
    if (l.key === "new") {
      return (
        <div>
          <select data-testid="export-doc" value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {docs.map((d) => <option key={d.path} value={d.path}>{d.title || d.path}</option>)}
          </select>
          <button type="button" data-action="export-pdf" disabled={busy || !chosen} onClick={exportPdf}>{busy ? "Checking..." : "Export PDF"}</button>
          {last && (
            <div data-testid="export-verdict" data-status={last.status}>
              {last.blocking.length > 0 && <ul data-testid="export-blocking">{last.blocking.map((f, i) => <li key={i}>{findingText(f)}</li>)}</ul>}
              {last.warnings.length > 0 && <ul data-testid="export-warnings" className="ws-muted">{last.warnings.map((f, i) => <li key={i}>{findingText(f)}</li>)}</ul>}
            </div>
          )}
        </div>
      );
    }
    const r = runs.find((x) => x.id === l.key)!;
    return (
      <div data-testid="export-run">
        <p className="ws-muted">{r.path} - {r.style}</p>
        {r.blocking_findings.length > 0 && <ul data-testid="run-blocking">{r.blocking_findings.map((f, i) => <li key={i}>{findingText(f)}</li>)}</ul>}
        {r.warnings.length > 0 && <ul data-testid="run-warnings" className="ws-muted">{r.warnings.map((f, i) => <li key={i}>{findingText(f)}</li>)}</ul>}
        {r.status === "passed" && <a data-action="download" href={`${X}/${encodeURIComponent(r.id)}/file`} download={r.filename}>Download</a>}
        {r.status === "blocked" && <span className="ws-muted">blocked: the file was not served</span>}
      </div>
    );
  };

  const blocked = runs.filter((r) => r.status === "blocked").length;
  return (
    <div className="ws-side ws-export">
      <Disclosure
        testId="export-disclosure"
        summary={<span>{runs.length} export(s), {blocked} blocked</span>}
        leaves={leaves}
        actions={actions}
      />
      {msg && <p className="ws-muted" data-testid="export-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "export", version: 1, title: "Export", kind: "side", component: ExportPanel, position: "right" });
registerNav({ id: "export", version: 1, label: "Export", order: 80, panel: "export" });
