// The research flow (research-workbench P4b): every source a session's tree met, each with its stages -
// the trail entries the pre-ingestion stage recorded for it (admitted, lead, lead path, held folded ...)
// - in order, a new stage animating in as it arrives and the latest one pulsing while the session runs.
// Every stage shows its trail (kind, score against its floor, reasons, what it was found via); a source
// is never shown without it. Another user's session withholds its flow (the round-4 allow-list).
import { useEffect, useMemo, useState } from "react";
import { C, get, q } from "../../lib/api";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerPanel, type PanelProps } from "../../shell/registry";
import "../sessions/sessions.css";

interface Stage {
  kind: string;
  at: string;
  trail: Record<string, any>;
}
interface FlowSource {
  url: string;
  job_id: string;
  stages: Stage[];
}
interface Flow {
  session_id: string;
  running: boolean;
  withheld: boolean;
  sources: FlowSource[];
}

const num = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "-");

export function TrailLine({ t }: { t: Record<string, any> }) {
  return (
    <span className="ws-trail" data-trail={t.id ?? ""}>
      {t.kind} · score {num(t.score)} / floor {num(t.floor)}{t.family ? ` · ${t.family}` : ""}
      {Array.isArray(t.reasons) && t.reasons.length ? ` · ${t.reasons.join("; ")}` : ""}
      {t.found_via ? ` · via ${t.found_via}` : ""}
    </span>
  );
}

export function ResearchFlowPanel(p: PanelProps) {
  const id = p.params.session as string | undefined;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!id) return;
    let live = true;
    get(`${C}/sessions/${q(id)}/flow`)
      .then((f: Flow) => {
        if (!live) return;
        setFlow(f);
        if (f.running) setTimeout(() => live && setTick((x) => x + 1), 2000);
      })
      .catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [id, tick]);
  // stages already shown do not animate again; a new one animates in once
  useEffect(() => {
    if (!flow) return;
    const t = setTimeout(() => setSeen(new Set(flow.sources.flatMap((s) => s.stages.map((_x, i) => `${s.url}#${i}`)))), 600);
    return () => clearTimeout(t);
  }, [flow]);

  const leaves = useMemo<Leaf[]>(() => (flow?.sources ?? []).map((s) => ({
    key: s.url,
    label: (
      <span className="ws-flow-source" data-source={s.url}>
        <span className="ws-flow-url">{s.url}</span>
        <span className="ws-flow-stages">
          {s.stages.map((st, i) => {
            const k = `${s.url}#${i}`;
            const current = flow!.running && i === s.stages.length - 1;
            return (
              <span key={k} className={`ws-flow-stage${seen.has(k) ? "" : " ws-flow-enter"}${current ? " ws-flow-current" : ""}`}
                data-stage={st.kind} data-has-trail={st.trail ? "1" : "0"}>
                {st.kind} <TrailLine t={st.trail} />
              </span>
            );
          })}
        </span>
      </span>
    ),
    badges: [`${s.stages.length} stage${s.stages.length === 1 ? "" : "s"}`],
    detail: (
      <ol className="ws-flow-trail">
        {s.stages.map((st, i) => <li key={i}>{new Date(st.at).toLocaleTimeString()} <TrailLine t={st.trail} /></li>)}
      </ol>
    ),
  })), [flow, seen]);

  const summary = !id ? <span>research flow: no session selected</span>
    : flow?.withheld ? <span>research flow: another user's session (its flow is theirs)</span>
    : <span>research flow: {flow?.sources.length ?? 0} source{flow?.sources.length === 1 ? "" : "s"}{flow?.running ? " · running" : ""}</span>;
  return (
    <div className="ws-side ws-flow" data-running={flow?.running ? "1" : "0"}>
      <Disclosure testId="flow-disclosure" summary={summary} leaves={leaves} actions={() => null} empty="no source yet" />
      {msg && <p className="ws-muted" data-testid="flow-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "flow", version: 1, title: "Research flow", kind: "side", component: ResearchFlowPanel, position: "right" });
