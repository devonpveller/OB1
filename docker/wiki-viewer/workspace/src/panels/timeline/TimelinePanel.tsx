// The timeline (research-workbench P8a-1) over timeline() (GET /contract/timeline): source revisions,
// sessions started and finished, claims created and trail events, newest first, in a date range. An
// event about a source shows that source's lifecycle state now (D5). A session's question is shown to its
// owner only (the contract's rule); scope: everything, or the selected source.
import { useEffect, useMemo, useState } from "react";
import { C, get, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { statusBadges } from "../../lib/sourceStatus";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

export interface TimelineEvent {
  at: string;
  kind: string;
  ref: string;
  summary: string;
  source_id: string | null;
  lifecycle: string | null;
}

const LABEL: Record<string, string> = {
  source_revision: "revision", session_started: "session started", session_finished: "session finished",
  claim_created: "claim", trail: "trail",
};
const day = (s: string) => new Date(s).toISOString().slice(0, 10);

export function TimelinePanel(_p: PanelProps) {
  const selected = useWorkspace((s) => s.reference);
  const [scoped, setScoped] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [msg, setMsg] = useState("");
  const source = scoped ? selected?.source_id || null : null;
  useEffect(() => {
    let live = true;
    setMsg("");
    const qs = [`limit=300`, source ? `source_id=${q(source)}` : "", from ? `from=${q(from)}T00:00:00Z` : "", to ? `to=${q(to)}T23:59:59Z` : ""].filter(Boolean).join("&");
    get(`${C}/timeline?${qs}`).then((r) => live && setEvents(r.events ?? [])).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [source, from, to]);

  const leaves = useMemo<Leaf[]>(() => events.map((e, i) => ({
    key: `${e.kind}:${e.ref}:${i}`,
    label: (
      <span className="ws-timeline-row" data-event={e.kind} data-ref={e.ref} data-source={e.source_id ?? ""}>
        <span className="ws-muted">{day(e.at)}</span> {LABEL[e.kind] ?? e.kind}: {e.summary || e.ref}
      </span>
    ),
    badges: [LABEL[e.kind] ?? e.kind, ...statusBadges(e.lifecycle)],
    detail: <p className="ws-muted">{new Date(e.at).toLocaleString()} · {e.ref}</p>,
  })), [events]);

  const actions = (l: Leaf) => {
    const e = events[Number(l.key.split(":").pop())];
    if (!e) return null;
    return (
      <>
        {e.source_id && e.lifecycle !== "erased" && (
          <button type="button" data-action="open-source" onClick={() => {
            setState({ reference: { reference_id: null, source_id: e.source_id!, chunk_idx: 0 } });
            openPanel("reference");
          }}>Open the source</button>
        )}
        {e.source_id && <button type="button" data-action="open-trail" onClick={() => openPanel("trail", { source: e.source_id })}>Its trail</button>}
        {(e.kind === "session_started" || e.kind === "session_finished") && (
          <button type="button" data-action="open-flow" onClick={() => openPanel("flow", { session: e.ref })}>Its research flow</button>
        )}
      </>
    );
  };

  return (
    <div className="ws-side ws-timeline">
      <div className="ws-controls">
        <label>from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="timeline-from" /></label>
        <label>to <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="timeline-to" /></label>
        <label><input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} data-testid="timeline-scoped" /> the selected source only</label>
      </div>
      <Disclosure
        testId="timeline-disclosure"
        summary={<span data-testid="timeline-summary">timeline{source ? ` of source ${source.slice(0, 8)}` : ""}: {events.length} event{events.length === 1 ? "" : "s"}</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing in this range"
      />
      {msg && <p className="ws-muted" data-testid="timeline-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "timeline", version: 1, title: "Timeline", kind: "side", component: TimelinePanel, position: "right" });
registerNav({ id: "timeline", version: 1, label: "Timeline", order: 46, panel: "timeline" });
