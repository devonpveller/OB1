// The coverage panel (P3b acceptance 2 + D1): what a session settled and what is open. Focused on a
// SESSION (params.session_id, or one picked from the open document's sessions): its report credibility
// header, the needs by status - answered / partial / open / search failed, counted, never a percent -
// with the topic estimate beside the anchor it is read against, the hubs its sources fall into and
// what is thin or contested in each, and its gaps. On a DOCUMENT with no session focused: the hubs the
// document touches (the P2b hub-context computation) and the user's own sessions started from it.
// Both reads are the signed-in user's own (another user's session or document is 404).
import { useEffect, useMemo, useState } from "react";
import { C, get, q } from "../../lib/api";
import { useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import type { PanelProps } from "../../shell/registry";
import { openPanel } from "../../shell/dock";
import { setTrust, useTrust } from "./focus";
import { STATUS_LABEL, statusLine } from "./logic";
import { ReportHeader, type Rollup } from "./ReportHeader";

interface Hub {
  centre: { slug: string; title: string; page_class: string | null };
  links: { kind: string; id: string }[];
  sources: number;
  thin: boolean;
  contested: boolean;
  contested_claims: { claim_id: string; text: string }[];
  why: string[];
}
interface SessionCoverage {
  session_id: string;
  status: string;
  needs: { need: string; status: string }[];
  by_status: Record<string, number>;
  gaps: string[];
  topic_estimate: string | null;
  anchor: string | null;
  anchor_basis: string;
  report_id: string | null;
  credibility: Rollup;
  hubs: Hub[];
}
interface DocumentCoverage {
  hubs: Hub[];
  sessions: { id: string; status: string; created_at: string; by_status: Record<string, number>; credibility: string }[];
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);
// what the contract answers, read defensively: a missing list is an empty one, never a crash
function asHub(h: any): Hub {
  return {
    centre: { slug: String(h?.centre?.slug ?? ""), title: String(h?.centre?.title ?? h?.centre?.slug ?? ""), page_class: h?.centre?.page_class ?? null },
    links: arr(h?.links), sources: Number(h?.sources ?? 0), thin: !!h?.thin, contested: !!h?.contested,
    contested_claims: arr(h?.contested_claims), why: arr<string>(h?.why),
  };
}
function asSession(r: any): SessionCoverage {
  return { ...r, needs: arr(r?.needs), by_status: r?.by_status ?? {}, gaps: arr<string>(r?.gaps), hubs: arr(r?.hubs).map(asHub),
    credibility: r?.credibility ?? { report_id: null, recorded: false, value: null, claims: 0, below_floor: 0, claim_kind: null, model_version: null, weights: [], statement: "Report credibility: not answered" } };
}
function asDocument(r: any): DocumentCoverage {
  return { hubs: arr(r?.hubs).map(asHub), sessions: arr(r?.sessions) };
}

function hubLeaf(h: Hub, prefix: string): Leaf {
  return {
    key: `${prefix}hub:${h.centre.slug}`,
    label: <span data-hub={h.centre.slug}>hub: {h.centre.title}</span>,
    badges: [...(h.thin ? ["thin"] : []), ...(h.contested ? ["contested"] : [])],
    detail: (
      <ul className="ws-why">
        {h.why.map((w) => <li key={w}>{w}</li>)}
        {h.contested_claims.map((c) => <li key={c.claim_id}>contested: {c.text}</li>)}
      </ul>
    ),
  };
}

function hubActions(h: Hub | undefined) {
  return h ? <a data-action="open-centre" href={`/${h.centre.slug}`} target="_blank" rel="noopener">Open the centre page</a> : null;
}

export function CoveragePanel(p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const focused = useTrust((s) => s.session);
  const param = typeof p.params?.session_id === "string" ? p.params.session_id : null;
  const session = param ?? focused;
  const [cov, setCov] = useState<SessionCoverage | null>(null);
  const [doc, setDoc] = useState<DocumentCoverage | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (param && param !== focused) setTrust({ session: param, report: null });
  }, [param]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return setCov(null);
    let live = true;
    setMsg("");
    get(`${C}/sessions/${q(session)}/coverage`).then((x) => {
      if (!live) return;
      const r = asSession(x);
      setCov(r);
      setTrust({ report: r.report_id });
    }).catch((e) => live && (setCov(null), setMsg(String((e as Error).message))));
    return () => {
      live = false;
    };
  }, [session]);

  useEffect(() => {
    if (session || !path) return setDoc(null);
    let live = true;
    get(`${C}/documents/coverage?path=${q(path)}`).then((r) => live && setDoc(asDocument(r))).catch((e) => live && (setDoc(null), setMsg(String((e as Error).message))));
    return () => {
      live = false;
    };
  }, [session, path, rev]);

  const sessionLeaves = useMemo<Leaf[]>(() => {
    if (!cov) return [];
    return [
      ...cov.needs.map((n, i) => ({
        key: `need:${i}`, label: <span data-need-status={n.status}>{n.need}</span>, badges: [STATUS_LABEL[n.status] ?? n.status],
      })),
      ...cov.hubs.map((h) => hubLeaf(h, "")),
      ...cov.gaps.map((g, i) => ({ key: `gap:${i}`, label: <span>gap: {g}</span> })),
    ];
  }, [cov]);

  const docLeaves = useMemo<Leaf[]>(() => {
    if (!doc) return [];
    return [
      ...doc.hubs.map((h) => hubLeaf(h, "")),
      ...doc.sessions.map((s) => ({
        key: `session:${s.id}`,
        label: <span data-session={s.id}>session {new Date(s.created_at).toLocaleString()} ({s.status}): {statusLine(s.by_status)}</span>,
        detail: <p className="ws-muted">{s.credibility}</p>,
      })),
    ];
  }, [doc]);

  if (session) {
    if (!cov) return <div className="ws-side ws-muted">{msg ? `coverage unavailable: ${msg}` : "loading coverage ..."}</div>;
    return (
      <div className="ws-side ws-coverage" data-session={cov.session_id}>
        <ReportHeader rollup={cov.credibility} />
        <dl className="ws-estimate" data-testid="estimate">
          <div><dt>topic estimate</dt><dd data-testid="topic-estimate">{cov.topic_estimate ?? "no topic estimate (a run before P4a trees)"}</dd></div>
          <div><dt>anchor</dt><dd data-testid="anchor" title={cov.anchor_basis}>{cov.anchor ?? "no anchor recorded"}</dd></div>
        </dl>
        <p className="ws-status-line" data-testid="status-line">{statusLine(cov.by_status)}</p>
        <div className="ws-controls">
          {path && <button type="button" data-testid="back-to-document" onClick={() => setTrust({ session: null, report: null })}>back to the document</button>}
          <button type="button" data-testid="open-ledger" onClick={() => openPanel("claims-ledger")}>claims of this session</button>
        </div>
        <Disclosure
          testId="coverage-disclosure"
          open
          summary={<span>{cov.needs.length} need{cov.needs.length === 1 ? "" : "s"}, touches {cov.hubs.length} hub{cov.hubs.length === 1 ? "" : "s"}, {cov.gaps.length} gap{cov.gaps.length === 1 ? "" : "s"}</span>}
          leaves={sessionLeaves}
          actions={(l) => (l.key.startsWith("hub:") ? hubActions(cov.hubs.find((h) => `hub:${h.centre.slug}` === l.key)) : null)}
          empty="the session recorded no needs, hubs or gaps"
        />
      </div>
    );
  }
  if (!path) return <div className="ws-side ws-muted">Open a document or focus a session to see what it settled and what is open.</div>;
  return (
    <div className="ws-side ws-coverage" data-document={path}>
      <Disclosure
        testId="coverage-disclosure"
        summary={<span>{doc ? `touches ${doc.hubs.length} hub${doc.hubs.length === 1 ? "" : "s"}, ${doc.sessions.length} session${doc.sessions.length === 1 ? "" : "s"}` : "loading ..."}</span>}
        leaves={docLeaves}
        actions={(l) => {
          if (l.key.startsWith("session:")) {
            const id = l.key.slice("session:".length);
            return <button type="button" data-action="focus-session" onClick={() => setTrust({ session: id, report: null })}>Focus this session</button>;
          }
          return hubActions(doc?.hubs.find((h) => `hub:${h.centre.slug}` === l.key));
        }}
        empty="the document links nothing in the graph and started no session yet"
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}
