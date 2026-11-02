// The trail (research-workbench P8a-1) over trail() (GET /contract/trail): in one list, newest first,
//   - the D5 removals: suppressions, severances, erasures and the tombstone events (origin lifecycle);
//   - P3a's lead trail entries: the leads and the found_via paths they opened (origin admission);
//   - P4a's per-source trail events of research sessions (origin session).
// Every entry about a source shows that source's lifecycle state now (D5). A tombstone opens from the trail
// (GET /contract/tombstones/:id): its original link, reason type and note, the reopen attempts, and the lift
// action (POST /contract/tombstones/:id/lift). Nothing on the trail is evidence. Scope: one source (a param,
// or the selected reference) or everything.
import { useEffect, useMemo, useState } from "react";
import { C, get, post, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { SourceStatus, statusBadges } from "../../lib/sourceStatus";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import "./trail.css";

export interface RemovalEntry {
  kind: string;
  source_id: string;
  tombstone_id: string | null;
  state: string;
  reason: string | null;
  context: Record<string, any>;
  at: string;
  lifecycle: string;
}
export interface LeadEntry {
  id: string;
  origin: string;
  stage: string;
  url: string;
  source_id: string | null;
  lifecycle: string | null;
  found_via: string | null;
  path: Record<string, any>[];
  score: number | null;
  floor: number | null;
  family: string | null;
  reasons: string[];
  job_id: string | null;
  at: string;
}
interface Tomb {
  id: string;
  source_id: string;
  url: string;
  title: string;
  reason_type: string;
  note: string | null;
  eraser_kind: string;
  eraser_user: string | null;
  batch_run_id: string | null;
  erased_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
  attempts: { path: string; outcome: string; note: string | null; attempted_at: string }[];
  may_lift?: boolean; // round 3: the read answers it for the viewer (the eraser, or an admin)
  // rw-p8a2-cleanup round 3b: eraser_user / lifted_by hold opaque action refs, never a person - the read answers
  // whether the viewer erased it; the panel never shows a ref
  erased_by_you?: boolean;
}

type Row = { key: string; at: string; removal?: RemovalEntry; lead?: LeadEntry };

const num = (v: number | null) => (typeof v === "number" ? v.toFixed(2) : "-");
const when = (s: string) => new Date(s).toLocaleString();

// PURE: the removals and the leads in one list, newest first (stable on the key)
export function trailRows(entries: RemovalEntry[], leads: LeadEntry[]): Row[] {
  const rows: Row[] = [
    ...entries.map((e, i) => ({ key: `r:${e.kind}:${e.source_id}:${e.tombstone_id ?? ""}:${i}`, at: e.at, removal: e })),
    ...leads.map((l) => ({ key: `l:${l.origin}:${l.id}`, at: l.at, lead: l })),
  ];
  return rows.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.key.localeCompare(b.key));
}

export function TombstoneView({ id, onLifted }: { id: string; onLifted?: () => void }) {
  const [t, setT] = useState<Tomb | null>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    get(`${C}/tombstones/${q(id)}`).then((r) => live && setT(r)).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [id, tick]);
  if (!t) return <p className="ws-muted" data-testid="tombstone-msg">{msg || "loading the tombstone ..."}</p>;
  const lift = async () => {
    const note = window.prompt("Why lift it? (optional - the URL may be intaken again)") ?? undefined;
    try {
      // round 3: the actor is the identity seam's - nothing about who lifts is sent
      await post(`${C}/tombstones/${q(id)}/lift`, note ? { note } : {});
      setMsg("lifted: its URL may be intaken again");
      setTick((x) => x + 1);
      onLifted?.();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  return (
    <div className="ws-tombstone" data-testid="tombstone" data-tombstone={t.id}>
      <dl>
        <dt>link</dt><dd><a href={t.url} target="_blank" rel="noopener noreferrer" data-testid="tombstone-link">{t.url}</a></dd>
        <dt>title</dt><dd>{t.title || "(none)"}</dd>
        <dt>reason</dt><dd data-testid="tombstone-reason">{t.reason_type}</dd>
        <dt>note</dt><dd data-testid="tombstone-note">{t.note ?? <span className="ws-muted">no note</span>}</dd>
        <dt>erased</dt><dd>{when(t.erased_at)} by {t.eraser_kind}{t.erased_by_you ? " (you)" : ""}{t.batch_run_id ? `, batch ${t.batch_run_id}` : ""}</dd>
        <dt>lifted</dt><dd data-testid="tombstone-lifted">{t.lifted_at ? when(t.lifted_at) : "no"}</dd>
      </dl>
      {t.attempts.length > 0 && (
        <ol className="ws-why" data-testid="tombstone-attempts">
          {t.attempts.map((a, i) => <li key={i}>{when(a.attempted_at)}: {a.path} - {a.outcome}{a.note ? ` (${a.note})` : ""}</li>)}
        </ol>
      )}
      {!t.lifted_at && t.may_lift && <button type="button" data-action="lift" onClick={lift}>Lift the tombstone</button>}
      {!t.lifted_at && !t.may_lift && <p className="ws-muted" data-testid="tombstone-lift-who">only the user who erased it, or an admin, may lift it</p>}
      {msg && <p className="ws-muted" data-testid="tombstone-msg">{msg}</p>}
    </div>
  );
}

function PathList({ path }: { path: Record<string, any>[] }) {
  if (!path.length) return null;
  return (
    <ol className="ws-found-via" data-testid="found-via-path">
      {path.map((s, i) => <li key={i}>{String(s.kind ?? s.stage ?? "")} {String(s.url ?? s.id ?? "")}</li>)}
    </ol>
  );
}

export function TrailPanel(p: PanelProps) {
  const selected = useWorkspace((s) => s.reference);
  const param = (p.params.source as string | undefined) ?? null;
  const [scoped, setScoped] = useState(true);
  const source = param ?? (scoped ? selected?.source_id || null : null);
  const [data, setData] = useState<{ entries: RemovalEntry[]; leads: LeadEntry[] }>({ entries: [], leads: [] });
  const [open, setOpen] = useState<string | null>((p.params.tombstone as string | undefined) ?? null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (p.params.tombstone) setOpen(String(p.params.tombstone));
  }, [p.params.tombstone]);
  useEffect(() => {
    let live = true;
    setMsg("");
    get(`${C}/trail?limit=200${source ? `&source_id=${q(source)}` : ""}`)
      .then((r) => live && setData({ entries: r.entries ?? [], leads: r.leads ?? [] }))
      .catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [source, tick]);

  const rows = useMemo(() => trailRows(data.entries, data.leads), [data]);
  const leaves = useMemo<Leaf[]>(() => rows.map((r) => {
    if (r.removal) {
      const e = r.removal;
      const title = e.context?.title || e.context?.url || e.source_id;
      return {
        key: r.key,
        label: <span className="ws-trail-row" data-trail-kind={e.kind} data-source={e.source_id} data-tombstone={e.tombstone_id ?? ""}>{e.kind}: {title}</span>,
        badges: [e.kind === "erased" ? "tombstone" : "removal", ...statusBadges(e.lifecycle)],
        detail: (
          <div>
            <p>{when(e.at)}{e.reason ? <> - reason: <span data-testid="trail-reason">{e.reason}</span></> : null}</p>
            {e.context?.note ? <p>note: {String(e.context.note)}</p> : null}
            <p className="ws-muted">source {e.source_id.slice(0, 8)} is <SourceStatus lifecycle={e.lifecycle} />{e.lifecycle === "active" ? "active" : ""}</p>
          </div>
        ),
      };
    }
    const l = r.lead!;
    return {
      key: r.key,
      label: <span className="ws-trail-row" data-trail-origin={l.origin} data-stage={l.stage} data-url={l.url}>{l.origin === "admission" ? "lead trail" : "session"} · {l.stage}: {l.url}</span>,
      badges: [l.origin === "admission" ? "found via" : "per-source", ...(l.found_via ? ["found_via"] : []), ...statusBadges(l.lifecycle)],
      detail: (
        <div>
          <p>{when(l.at)} · score {num(l.score)} / floor {num(l.floor)}{l.family ? ` · ${l.family}` : ""}</p>
          {l.reasons.length > 0 && <p>{l.reasons.join("; ")}</p>}
          {l.found_via && <p>found via <code data-testid="found-via">{l.found_via}</code></p>}
          <PathList path={l.path} />
          {l.source_id && <p className="ws-muted">became source {l.source_id.slice(0, 8)} <SourceStatus lifecycle={l.lifecycle} /></p>}
        </div>
      ),
    };
  }), [rows]);

  const actions = (leaf: Leaf) => {
    const r = rows.find((x) => x.key === leaf.key);
    if (!r) return null;
    const sid = r.removal?.source_id ?? r.lead?.source_id ?? null;
    const tomb = r.removal?.tombstone_id ?? null;
    return (
      <>
        {tomb && <button type="button" data-action="open-tombstone" onClick={() => setOpen(tomb)}>Open the tombstone</button>}
        {sid && r.removal?.lifecycle !== "erased" && r.lead?.lifecycle !== "erased" && (
          <button type="button" data-action="open-source" onClick={() => {
            setState({ reference: { reference_id: null, source_id: sid, chunk_idx: 0 } });
            openPanel("reference");
          }}>Open the source</button>
        )}
        {r.lead?.job_id && <button type="button" data-action="open-flow" onClick={() => openPanel("flow", { session: r.lead!.job_id })}>Its research flow</button>}
      </>
    );
  };

  return (
    <div className="ws-side ws-trail-panel">
      <div className="ws-controls">
        {!param && (
          <label><input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} data-testid="trail-scoped" /> the selected source only</label>
        )}
      </div>
      {open && (
        <div className="ws-tombstone-host">
          <TombstoneView id={open} onLifted={() => setTick((x) => x + 1)} />
          <button type="button" data-action="close-tombstone" onClick={() => setOpen(null)}>Close</button>
        </div>
      )}
      <Disclosure
        testId="trail-disclosure"
        summary={<span data-testid="trail-summary">trail{source ? ` of source ${source.slice(0, 8)}` : ""}: {data.entries.length} removal{data.entries.length === 1 ? "" : "s"}, {data.leads.length} lead entr{data.leads.length === 1 ? "y" : "ies"} (none of it is evidence)</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing on the trail"
      />
      {msg && <p className="ws-muted" data-testid="trail-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "trail", version: 1, title: "Trail", kind: "side", component: TrailPanel, position: "right" });
registerNav({ id: "trail", version: 1, label: "Trail", order: 47, panel: "trail" });
