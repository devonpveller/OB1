// The Research screen (rwr-research-runs, screens 5-6): the person's own runs as a list with state counts, grouped by date,
// document or topic, and one run as a live tree they can steer, add a follow-up to, stop, archive and open as a document.
//
// The rules this screen keeps (each has a test):
//  - it is drawn for ONE known subject, under a key made of that subject: a different person on the page (the shell's periodic
//    whoami read, no reload) drops the list, the open run, every draft, the confirm and the live stream with it;
//  - every read is the server's own for the signed-in person (lib/api.ts, same-origin /workbench/* only): another person's run is
//    never listed, counted, grouped or opened (the same one sentence as a missing run); nothing is kept in the browser and no
//    title or question is in the page title, a toast or the address (the address holds the run's id only);
//  - the open run updates by itself: its server-sent stream says "something changed" and the run is read again, so a new branch
//    appears with no reload; a dropped stream reconnects while the run still runs;
//  - steer and "add a follow-up" are one route (a branch at the next steering point); stop asks first; archive is the person's own
//    view state and can be undone; "open the report as a document" makes a new document of their own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenProps } from "../../routes";
import { navigate } from "../../lib/router";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { ago, useCard } from "../home/home-data";
import {
  archiveRun, cancelRun, documentHref, GROUP_LABEL, groupRuns, KIND_LABEL, readRun, readRuns, reportAsDocument, steerRun, streamRun, unarchiveRun,
  type Counts, type Group, type GroupBy, type Outcome, type RunDetail, type RunNode, type RunRow,
} from "./runs-data";
import "./research.css";

export const RECONNECT_MS = 1500;
export const REFRESH_MS = 250;
const NO_RUN = "That run is not available.";

export function Research({ subject, whoAnswered }: Pick<ScreenProps, "subject" | "whoAnswered">) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <section className="screen research" data-testid="research">
        <h1 className="sr-only">Research</h1>
        {whoAnswered
          ? <p className="meta" data-testid="research-failed">Could not tell who you are, so nothing is shown. <button type="button" onClick={() => window.location.reload()}>Try again</button></p>
          : <p className="meta" role="status" data-testid="research-waiting">Checking who you are...</p>}
      </section>
    );
  }
  return <ResearchFor key={known} />;
}

type Filter = Group | "archived" | null;

function ResearchFor() {
  const [list, reload] = useCard(readRuns);
  const [filter, setFilter] = useState<Filter>(null);
  const [by, setBy] = useState<GroupBy>("date");
  const selected = new URLSearchParams(window.location.search).get("run");
  const data = list.state === "ok" ? list.data : null;

  const shown = useMemo(() => {
    if (!data) return [];
    return data.runs.filter((r) => (filter === "archived" ? r.archived : !r.archived && (filter === null || r.group === filter)));
  }, [data, filter]);
  const groups = useMemo(() => groupRuns(shown, by), [shown, by]);
  const open = (id: string) => navigate("/research?run=" + encodeURIComponent(id));

  return (
    <section className="screen research" data-testid="research">
      <div className="rs-head">
        <h1>Research</h1>
        <Link to="/research/start" className="btn pri" data-testid="start-research">+ Start research</Link>
      </div>
      {list.state === "loading" && <p className="meta" role="status" data-testid="runs-loading">Loading your runs...</p>}
      {list.state === "failed" && <p className="meta" data-testid="runs-failed">Could not load your runs. <button type="button" onClick={reload}>Try again</button></p>}
      {data && (
        <div className="rs-cols">
          <div className="rs-list" data-testid="runs-list">
            <Counters counts={data.counts} filter={filter} onFilter={setFilter} />
            <div className="seg rs-by" role="group" aria-label="Group runs by">
              {(["date", "document", "topic"] as GroupBy[]).map((g) => (
                <button key={g} type="button" className={"opt" + (by === g ? " sel" : "")} aria-pressed={by === g} onClick={() => setBy(g)} data-testid={"by-" + g}>
                  {g === "date" ? "Date" : g === "document" ? "Document" : "Topic"}
                </button>
              ))}
            </div>
            {data.runs.length === 0 && (
              <p className="empty" data-testid="runs-empty">You have no research yet. <Link to="/research/start">Start research</Link></p>
            )}
            {data.runs.length > 0 && shown.length === 0 && <p className="meta" data-testid="runs-none">No runs here.</p>}
            {groups.map((g) => (
              <section key={g.key} className="rs-group" aria-label={g.header} data-testid="run-group">
                <h2 className="rs-gh" data-testid="group-header">{g.header} <span className="count">{g.runs.length}</span></h2>
                <ul className="rs-rows">
                  {g.runs.map((r) => <li key={r.id}><RunRowButton r={r} on={r.id === selected} open={open} /></li>)}
                </ul>
              </section>
            ))}
          </div>
          <div className="rs-detail" data-testid="run-detail-area">
            {selected ? <RunView key={selected} id={selected} changed={reload} /> : <p className="meta" data-testid="pick-run">Pick a run to see its tree.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function Counters({ counts, filter, onFilter }: { counts: Counts; filter: Filter; onFilter: (f: Filter) => void }) {
  const items: { k: Group | "archived"; n: number }[] = [
    { k: "running", n: counts.running }, { k: "queued", n: counts.queued }, { k: "done", n: counts.done }, { k: "stopped", n: counts.stopped }, { k: "archived", n: counts.archived },
  ];
  return (
    <div className="rs-counts" role="group" aria-label="Runs by state" data-testid="run-counts">
      {items.map(({ k, n }) => (
        <button key={k} type="button" className={"rs-chip" + (filter === k ? " sel" : "")} aria-pressed={filter === k} data-testid={"count-" + k}
          onClick={() => onFilter(filter === k ? null : k)}>
          {GROUP_LABEL[k]} <span className="count" data-testid={"count-n-" + k}>{n}</span>
        </button>
      ))}
    </div>
  );
}

const pillOf = (g: Group): [string, string] => (g === "running" ? ["running", "run"] : g === "queued" ? ["queued", "wait"] : g === "done" ? ["finished", "done"] : ["stopped", "wait"]);

function RunRowButton({ r, on, open }: { r: RunRow; on: boolean; open: (id: string) => void }) {
  const [label, kind] = pillOf(r.group);
  return (
    <button type="button" className={"rs-row" + (on ? " on" : "")} aria-current={on ? "true" : undefined} onClick={() => open(r.id)} data-testid="run-row">
      <span className="rs-row-main">
        <span className="rs-q" data-testid="run-question">{r.question || "(no question)"}</span>
        <span className="meta">{[r.topic, r.branches ? r.branches + (r.branches === 1 ? " branch" : " branches") : "", ago(r.created_at)].filter(Boolean).join(" · ")}</span>
      </span>
      <span className={"pill " + kind}>{r.archived ? "archived" : label}</span>
    </button>
  );
}

// ── one run ────────────────────────────────────────────────────────────────────────────────
type View = { state: "loading" } | { state: "gone" } | { state: "failed" } | { state: "ok"; d: RunDetail };

function RunView({ id, changed }: { id: string; changed: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<View>({ state: "loading" });
  const [tab, setTab] = useState<"tree" | "discussion">("tree");
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<null | "steer" | "followup">(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  const token = useRef(0);
  const running = view.state === "ok" && view.d.running;

  const load = useCallback(async () => {
    const t = ++token.current;
    try {
      const d = await readRun(id);
      if (!alive.current || t !== token.current) return;
      setView(d ? { state: "ok", d } : { state: "gone" });
    } catch {
      if (alive.current && t === token.current) setView((v) => (v.state === "ok" ? v : { state: "failed" }));
    }
  }, [id]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);

  // live: while the run runs, its stream says "something changed"; the run is read again (coalesced), so a new branch shows
  // with no reload. A dropped stream reconnects while the run still runs; when it ends, the final state is read.
  useEffect(() => {
    if (!running) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, REFRESH_MS); };
    (async () => {
      while (!ac.signal.aborted) {
        const status = await streamRun(id, later, ac.signal);
        if (ac.signal.aborted) return;
        later();
        if (status === 404) return;
        await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    })();
    return () => { ac.abort(); if (timer) clearTimeout(timer); };
  }, [running, id, load]);

  if (view.state === "loading") return <p className="meta" role="status" data-testid="run-loading">Opening the run...</p>;
  if (view.state === "gone") return <p className="meta" data-testid="run-gone">{NO_RUN}</p>;
  if (view.state === "failed") return <p className="meta" data-testid="run-failed">Could not open this run. <button type="button" onClick={() => void load()}>Try again</button></p>;
  const d = view.d;
  const root = d.nodes.find((n) => n.parent_job_id === null) ?? d.nodes[0];
  const node = d.nodes.find((n) => n.id === sel) ?? root;
  const stepId = d.next_steering_point?.step_id ?? null;
  const steerable = d.can_act && !!stepId && d.run.group !== "stopped";

  const say = (o: Outcome, gone = NO_RUN) => {
    if (o.ok) return null;
    return o.kind === "gone" ? gone : o.kind === "conflict" ? "That cannot be done in this run's state now." : o.kind === "unavailable" ? "Not available right now. Nothing was changed." : "That did not work. Nothing was changed. Try again.";
  };
  const run = async (f: () => Promise<Outcome>, after: () => void, gone?: string) => {
    if (busy) return;
    setBusy(true); setNote(null);
    const o = await f();
    if (!alive.current) return;
    setBusy(false);
    const m = say(o, gone);
    if (m) { setNote(m); return; }
    after();
    void load(); changed();
  };

  const doArchive = () => run(() => archiveRun(id), () => toast({ message: "Archived.", undoLabel: "Undo", onUndo: () => { void unarchiveRun(id).then(() => { void load(); changed(); }); } }));
  const doUnarchive = () => run(() => unarchiveRun(id), () => toast({ message: "Unarchived." }));
  const doStop = () => run(() => cancelRun(id), () => { setConfirm(false); toast({ message: "Stopped." }); });
  const doSend = () => {
    const text = draft.trim();
    if (!text || !stepId) return;
    const kind = form;
    return run(() => steerRun(id, stepId, text), () => { setForm(null); setDraft(""); toast({ message: kind === "followup" ? "Follow-up added." : "Steered: a new branch is on its way." }); },
      "This run can no longer be steered.");
  };
  const doReport = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    const o = await reportAsDocument(id);
    if (!alive.current) return;
    setBusy(false);
    if (o.ok && o.path) { toast({ message: "Opened the report as a document." }); navigate(documentHref(o.path)); return; }
    setNote(!o.ok && o.kind === "conflict" ? "This run has no report yet." : say(o) ?? "That did not work. Nothing was changed. Try again.");
  };

  return (
    <div className="rs-run" data-testid="run" data-run={id}>
      <div className="rs-run-head">
        <h2 className="rs-run-q" data-testid="run-title">{d.run.question || "(no question)"}</h2>
        <span className={"pill " + pillOf(d.run.group)[1]} data-testid="run-state">{d.run.archived ? "archived" : pillOf(d.run.group)[0]}</span>
      </div>
      <div className="rs-actions" role="group" aria-label="This run">
        {steerable && <button type="button" onClick={() => { setForm(form === "steer" ? null : "steer"); setNote(null); }} aria-expanded={form === "steer"} data-testid="act-steer">Steer</button>}
        {steerable && <button type="button" onClick={() => { setForm(form === "followup" ? null : "followup"); setNote(null); }} aria-expanded={form === "followup"} data-testid="act-followup">Add a follow-up</button>}
        {d.can_act && d.running && <button type="button" onClick={() => setConfirm(true)} data-testid="act-stop">Stop</button>}
        <button type="button" onClick={doReport} disabled={busy || !root.has_report} data-testid="act-report">Open the report as a document</button>
        {d.run.archived
          ? <button type="button" onClick={doUnarchive} disabled={busy} data-testid="act-unarchive">Unarchive</button>
          : <button type="button" onClick={doArchive} disabled={busy} data-testid="act-archive">Archive</button>}
      </div>
      {confirm && (
        <div className="rs-form" role="group" aria-label="Stop this run" data-testid="stop-confirm">
          <p>Stop this run? What it has found so far is kept. It cannot be started again from here.</p>
          <div className="rs-form-actions">
            <button type="button" onClick={() => setConfirm(false)} data-testid="stop-keep">Keep it going</button>
            <button type="button" className="danger" onClick={doStop} disabled={busy} data-testid="stop-ok">Stop it</button>
          </div>
        </div>
      )}
      {form && (
        <form className="rs-form" data-testid="steer-form" onSubmit={(e) => { e.preventDefault(); void doSend(); }}>
          <label htmlFor="rs-draft">{form === "steer" ? "Which way should it go?" : "What else should it look into?"}</label>
          <textarea id="rs-draft" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="steer-text" maxLength={2000} />
          <p className="meta">This starts a new branch from the run's next steering point. The rest of the run carries on.</p>
          <div className="rs-form-actions">
            <button type="button" onClick={() => { setForm(null); setDraft(""); }} data-testid="steer-cancel">Cancel</button>
            <button type="submit" className="btn pri" disabled={busy || !draft.trim()} data-testid="steer-send">{form === "steer" ? "Steer" : "Add follow-up"}</button>
          </div>
        </form>
      )}
      {note && <p className="note" role="alert" data-testid="run-note">{note}</p>}
      <Tabs tab={tab} onTab={setTab} />
      {tab === "tree" ? (
        <div role="tabpanel" id="rs-p-tree" aria-labelledby="rs-t-tree" className="rs-panel">
          <p className="meta" data-testid="run-live">{d.running ? "Running: new branches appear here by themselves." : "Finished."}</p>
          <Tree nodes={d.nodes} sel={node.id} onSel={setSel} />
          <NodeDetails n={node} root={node.id === root.id} />
        </div>
      ) : (
        <div role="tabpanel" id="rs-p-discussion" aria-labelledby="rs-t-discussion" className="rs-panel" data-testid="discussion-empty">
          <p className="empty">Nothing here yet. The live discussion about a run arrives with a later update.</p>
        </div>
      )}
    </div>
  );
}

function Tabs({ tab, onTab }: { tab: "tree" | "discussion"; onTab: (t: "tree" | "discussion") => void }) {
  const ids = ["tree", "discussion"] as const;
  const key = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    onTab(next);
    document.getElementById("rs-t-" + next)?.focus();
  };
  return (
    <div role="tablist" aria-label="Run views" className="rs-tabs" onKeyDown={key}>
      {ids.map((t) => (
        <button key={t} type="button" role="tab" id={"rs-t-" + t} aria-selected={tab === t} aria-controls={"rs-p-" + t} tabIndex={tab === t ? 0 : -1}
          className={"rs-tab" + (tab === t ? " on" : "")} onClick={() => onTab(t)} data-testid={"tab-" + t}>{t === "tree" ? "Tree" : "Discussion"}</button>
      ))}
    </div>
  );
}

function Tree({ nodes, sel, onSel }: { nodes: RunNode[]; sel: string; onSel: (id: string) => void }) {
  const kids = (pid: string | null) => nodes.filter((n) => n.parent_job_id === pid).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const one = (n: RunNode): React.ReactNode => {
    const c = kids(n.id);
    return (
      <li key={n.id}>
        <button type="button" className={"rs-node" + (sel === n.id ? " on" : "")} aria-current={sel === n.id ? "true" : undefined} onClick={() => onSel(n.id)} data-testid="tree-node" data-node={n.id} data-status={n.status}>
          <span className="rs-kind">{KIND_LABEL[n.branch_kind] ?? n.branch_kind}</span>
          <span className="rs-nq" data-testid="node-question">{n.query}</span>
          <span className={"pill " + (n.open ? "run" : "done")}>{n.pending ? "queued" : n.status === "done" ? "finished" : n.status}</span>
        </button>
        {c.length > 0 && <ul className="rs-sub">{c.map(one)}</ul>}
      </li>
    );
  };
  const roots = kids(null);
  return <ul aria-label="The run's questions and branches" className="rs-tree" data-testid="tree">{(roots.length ? roots : nodes.slice(0, 1)).map(one)}</ul>;
}

function NodeDetails({ n, root }: { n: RunNode; root: boolean }) {
  return (
    <div className="rs-nd" data-testid="node-details" aria-label="Details of the chosen step">
      <h3>{root ? "The question" : KIND_LABEL[n.branch_kind] ?? "Branch"}</h3>
      <h4>Sources <span className="count" data-testid="src-count">{n.sources.length}</span></h4>
      {n.sources.length === 0 ? <p className="meta" data-testid="no-sources">No sources read yet.</p> : (
        <ul className="rs-list2" data-testid="sources">
          {n.sources.map((s) => (
            <li key={s.url}><span className="rs-src">{s.title || s.url}</span>{s.title ? <span className="meta rs-url">{s.url}</span> : null}{s.stages.length ? <span className="meta">{s.stages.join(" > ")}</span> : null}</li>
          ))}
        </ul>
      )}
      <h4>Claims <span className="count" data-testid="claim-count">{n.claims.length}</span></h4>
      {n.claims.length === 0 ? <p className="meta" data-testid="no-claims">No claims from this step.</p> : (
        <ul className="rs-list2" data-testid="claims">{n.claims.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
      )}
      <p className="meta">{n.has_report ? "This step has a report." : "This step has no report yet."}</p>
    </div>
  );
}
