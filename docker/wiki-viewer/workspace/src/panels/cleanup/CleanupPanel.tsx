// The cleanup view (research-workbench P8a, rw-p8a2-cleanup; D5 items 4-7). Two lists, each at rest
// on its summary (the Disclosure rule):
//   1. every suppressed and unlinked source, with its status and dependence counts. A selected source
//      shows its connections (dependence) with sever one / sever all; ERASE is offered only when the
//      source is unlinked with zero blocking connections, and takes a reason type (required) and an
//      optional note. Process all runs over every listed source with ONE reason type and no note.
//   2. reopen candidates - user-erased returns that cleared their bar (a debunked one with its dispute
//      previewed) and deliberate tombstones with a reopen note - each with its evidence and a lift.
// Every write goes to /workbench/contract/cleanup/*, which acts as the signed-in user (the identity
// seam): no request here names a user.
import { useEffect, useMemo, useState } from "react";
import { C, get, post } from "../../lib/api";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

const CL = `${C}/cleanup`;
const PROCESS_ALL = "process-all";

export interface CleanupSource {
  id: string;
  title: string;
  url: string | null;
  lifecycle: string;
  reason: string | null;
  suppressed_at: string;
  unlinked_at: string | null;
  counts: Record<string, number>;
  blocking: number;
  severable: number;
  total: number;
  erase_allowed: boolean;
}

interface Connection {
  kind: string;
  ref: string;
  detail: Record<string, unknown>;
  blocks_erase: boolean;
  severable: boolean;
}

interface Evidence {
  path: string;
  outcome: string;
  session_id: string | null;
  note: string | null;
  attempted_at: string;
  reason: string | null;
  score: { value?: number | null; floor?: number | null; version?: string | null } | null;
}

export interface Candidate {
  kind: string;
  tombstone: {
    id: string; source_id: string; url: string; title: string; reason_type: string; note: string | null;
    eraser_kind: string; erased_by_you: boolean; erased_at: string; confidence: number | null; score_version: string | null;
  };
  evidence: Evidence[];
  dispute_preview: { criticism: { reason_type: string; note: string | null; erased_at: string }; score: { value?: number | null; floor?: number | null } } | null;
}

const KIND_LABEL: Record<string, string> = {
  proposed_contesting: "proposed contesting source",
  credibility_cleared: "credibility bar cleared",
  reopen_note: "reopen note",
};

const errText = (e: unknown) => String((e as Error)?.message ?? e);

function ReasonSelect(props: { reasons: string[]; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <select required value={props.value} onChange={(e) => props.onChange(e.target.value)} data-testid={props.testId} aria-label="reason type">
      <option value="">reason type...</option>
      {props.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
    </select>
  );
}

function Counts({ s }: { s: CleanupSource }) {
  const kinds = Object.entries(s.counts).filter(([, n]) => n > 0);
  return (
    <span className="ws-muted" data-counts={s.id}>
      {s.blocking} blocking, {s.severable} severable{kinds.length ? ": " : ""}
      {kinds.map(([k, n]) => `${k} ${n}`).join(", ")}
    </span>
  );
}

// One selected source: its connections with sever, and (only when unlinked with no dependence) erase.
function SourceActions(props: { s: CleanupSource; reasons: string[]; changed: (msg: string) => void }) {
  const { s } = props;
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [erasing, setErasing] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const load = async () => {
    const d = await get(`${C}/sources/${s.id}/dependence`).catch((e) => { setMsg(errText(e)); return null; });
    setConns(d ? d.connections : []);
  };
  const sever = async (body: Record<string, unknown>) => {
    try {
      const r = await post(`${CL}/sources/${s.id}/sever`, body);
      props.changed(`severed ${r.severed.length}; now ${r.lifecycle}, ${r.blocking} blocking`);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const erase = async () => {
    if (!reason) return setMsg("choose a reason type");
    try {
      await post(`${CL}/sources/${s.id}/erase`, note.trim() ? { reason_type: reason, note: note.trim() } : { reason_type: reason });
      props.changed(`erased "${s.title}" (${reason})`);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <>
      <button type="button" data-action="connections" onClick={load}>Show connections</button>
      {s.lifecycle === "suppressed" && s.severable > 0 && (
        <button type="button" data-action="sever-all" onClick={() => sever({ all: true })}>Sever all ({s.severable})</button>
      )}
      {s.erase_allowed && !erasing && <button type="button" data-action="erase" onClick={() => setErasing(true)}>Erase...</button>}
      {s.erase_allowed && erasing && (
        <form className="ws-inline-form" data-testid="erase-form" onSubmit={(e) => { e.preventDefault(); erase(); }}>
          <ReasonSelect reasons={props.reasons} value={reason} onChange={setReason} testId="erase-reason" />
          <textarea placeholder="note (optional; kept on the tombstone, which every user can open)" value={note}
            onChange={(e) => setNote(e.target.value)} data-testid="erase-note" />
          <button type="submit" data-action="erase-confirm" disabled={!reason}>Erase</button>
        </form>
      )}
      {conns && (
        <ul className="ws-connections" data-testid="connections">
          {conns.length === 0 && <li className="ws-empty">no connections</li>}
          {conns.map((c) => (
            <li key={`${c.kind}:${c.ref}`} data-connection={`${c.kind}:${c.ref}`}>
              {c.kind} {c.ref}{c.blocks_erase ? "" : " (does not block)"}
              {c.severable && s.lifecycle === "suppressed" && (
                <button type="button" data-action="sever-one" onClick={() => sever({ kind: c.kind, ref: c.ref })}>Sever</button>
              )}
              {!c.severable && c.blocks_erase && <span className="ws-muted"> resolved by hand{typeof c.detail?.owner === "string" ? ` (${c.detail.owner})` : ""}</span>}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="ws-muted" data-testid="source-msg">{msg}</p>}
    </>
  );
}

function EvidenceList({ c }: { c: Candidate }) {
  return (
    <div data-evidence={c.tombstone.id}>
      <p className="ws-muted">erased {c.tombstone.reason_type}{c.tombstone.note ? `: ${c.tombstone.note}` : ""} ({c.tombstone.erased_by_you ? "by you" : `by ${c.tombstone.eraser_kind === "user" ? "a user" : c.tombstone.eraser_kind}`})</p>
      <ul className="ws-evidence">
        {c.evidence.map((e, i) => (
          <li key={i} data-evidence-item={e.outcome}>
            {e.path} {e.outcome}
            {e.score && typeof e.score.value === "number" ? `: scored ${e.score.value}${typeof e.score.floor === "number" ? ` (floor ${e.score.floor})` : ""}` : ""}
            {e.session_id ? `, session ${e.session_id}` : ""}{e.note ? ` - ${e.note}` : ""}
            {e.reason ? <span className="ws-muted"> ({e.reason})</span> : null}
          </li>
        ))}
      </ul>
      {c.dispute_preview && (
        <p data-testid="dispute-preview">
          Admitting it opens a dispute: the {c.dispute_preview.criticism.reason_type} verdict
          {c.dispute_preview.criticism.note ? ` ("${c.dispute_preview.criticism.note}")` : ""} stays attached as criticism.
        </p>
      )}
    </div>
  );
}

function LiftAction(props: { c: Candidate; changed: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const lift = async () => {
    try {
      await post(`${CL}/tombstones/${props.c.tombstone.id}/lift`, note.trim() ? { note: note.trim() } : {});
      props.changed(`lifted "${props.c.tombstone.title}": its URL may be taken in again`);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <>
      <input type="text" placeholder="lift note (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="lift-note" />
      <button type="button" data-action="lift" onClick={lift}>Lift</button>
      {msg && <span className="ws-muted">{msg}</span>}
    </>
  );
}

export function CleanupPanel(_p: PanelProps) {
  const [sources, setSources] = useState<CleanupSource[]>([]);
  const [total, setTotal] = useState(0);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkArmed, setBulkArmed] = useState(false);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    get(`${CL}/sources?limit=500`).then((r) => { setSources(r.sources ?? []); setTotal(r.total ?? 0); }).catch((e) => setMsg(errText(e)));
    get(`${CL}/reopen-candidates?limit=500`).then((r) => setCands((r.candidates ?? []).filter((c: Candidate) => c.evidence?.length))).catch(() => setCands([]));
  }, [tick]);
  useEffect(() => {
    get(`${C}/registries/erasure_reasons`).then((r) => setReasons((r.entries ?? []).filter((e: any) => !e.retired_at).map((e: any) => e.key)))
      .catch(() => setReasons([]));
  }, []);
  const changed = (m: string) => {
    setMsg(m);
    setBulkArmed(false);
    setTick((n) => n + 1);
  };

  // process all is a leaf of its own (first), so its form shows only once it is selected (the at-rest rule)
  const sourceLeaves = useMemo<Leaf[]>(() => [
    ...(sources.length ? [{
      key: PROCESS_ALL, label: <span data-testid="process-all-leaf">Process all {sources.length} listed</span>,
      detail: <span className="ws-muted">sever every severable connection, then erase what is left unlinked - one reason type for the batch, no note</span>,
    }] : []),
    ...sources.map((s) => ({
      key: s.id, badges: [s.lifecycle],
      label: <span data-cleanup-source={s.id} data-lifecycle={s.lifecycle}>{s.title || s.url || s.id}</span>,
      detail: <><span className="ws-muted">{s.lifecycle}{s.reason ? `: ${s.reason}` : ""}</span><br /><Counts s={s} /></>,
    })),
  ], [sources]);
  const candLeaves = useMemo<Leaf[]>(() => cands.map((c) => ({
    key: c.tombstone.id, badges: [KIND_LABEL[c.kind] ?? c.kind],
    label: <span data-candidate={c.tombstone.id}>{c.tombstone.title || c.tombstone.url}</span>,
    detail: <EvidenceList c={c} />,
  })), [cands]);

  const processAll = async () => {
    if (!bulkReason) return setMsg("choose one reason type for the batch");
    try {
      const r = await post(`${CL}/process-all`, { reason_type: bulkReason, source_ids: sources.map((s) => s.id) });
      const n = (o: string) => r.items.filter((i: any) => i.outcome === o).length;
      changed(`processed ${r.items.length}: ${r.erased} erased, ${n("blocked")} blocked, ${n("skipped")} skipped`);
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <div className="ws-side ws-cleanup" data-testid="cleanup-panel">
      <Disclosure
        testId="cleanup-sources"
        summary={<span data-testid="cleanup-summary">{total} suppressed or unlinked source{total === 1 ? "" : "s"}</span>}
        leaves={sourceLeaves}
        empty="nothing suppressed"
        actions={(l) => {
          if (l.key === PROCESS_ALL) {
            return (
              <form className="ws-inline-form" data-testid="process-all" onSubmit={(e) => { e.preventDefault(); bulkArmed ? processAll() : setBulkArmed(true); }}>
                <ReasonSelect reasons={reasons} value={bulkReason} onChange={setBulkReason} testId="bulk-reason" />
                <button type="submit" data-action="process-all" disabled={!bulkReason}>
                  {bulkArmed ? `Confirm: sever and erase all ${sources.length}` : `Process all ${sources.length}`}
                </button>
              </form>
            );
          }
          const s = sources.find((x) => x.id === l.key)!;
          return <SourceActions key={s.id} s={s} reasons={reasons} changed={changed} />;
        }}
      />
      <Disclosure
        testId="cleanup-candidates"
        summary={<span data-testid="candidates-summary">{cands.length} reopen candidate{cands.length === 1 ? "" : "s"}</span>}
        leaves={candLeaves}
        empty="no reopen candidates"
        actions={(l) => {
          const c = cands.find((x) => x.tombstone.id === l.key)!;
          return <LiftAction key={c.tombstone.id} c={c} changed={changed} />;
        }}
      />
      {msg && <p className="ws-muted" data-testid="cleanup-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "cleanup", version: 1, title: "Cleanup", kind: "side", component: CleanupPanel, position: "right" });
registerNav({ id: "cleanup", version: 1, label: "Cleanup", order: 90, panel: "cleanup" });
