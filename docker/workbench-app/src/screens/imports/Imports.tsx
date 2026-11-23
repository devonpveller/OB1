// Screen 14, Imports (rwr-imports): everything the signed-in person brought in, whether it worked and why not, who can
// see it, and one link or file to add. Drawn only from that person's own jobs (the intake routes are owner-scoped on
// the server); nothing here is stored in the browser. Messages about an action live INSIDE this screen's subject-keyed
// body, so they are dropped with it when a different person is on the page (no global toast, no dialog).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "../../shell/Link";
import { getLockedDocument } from "../../lib/state";
import type { ScreenProps } from "../../routes";
import { ago } from "../home/home-data";
import {
  addOne, canCancel, canRetry, cancelJob, FILE_LIMIT_BYTES, fileProblem, FILTERS, fromOf, isActive, JOBS_LIMIT, landedIn, linkProblem, passes,
  readJobs, readLandings, reasonOf, retriedAlready, retryJob, statusOf, stepsOf, titleOf, weekOf, whoSees, isPrivate,
  type Filter, type Job, type JobsRead, type LandingOption,
} from "./imports-data";
import "./imports.css";

const POLL_MS = 4000;
type Read = { state: "loading" } | { state: "failed" } | { state: "ok"; data: JobsRead };

// Imports is drawn for ONE known subject, as Home is: the body lives under a key made of the last known subject, so a
// different person drops every read in flight, every message and the open form, and reads again.
export function Imports({ subject, whoAnswered, onRetry = () => window.location.reload() }: Partial<ScreenProps> & { onRetry?: () => void }) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <div className="screen imports" data-testid="imports">
        <h1>Imports</h1>
        {whoAnswered
          ? <p className="meta" data-testid="imports-who-failed">Could not tell who you are, so nothing is shown. <button type="button" onClick={onRetry}>Try again</button></p>
          : <p className="meta" role="status" data-testid="imports-waiting">Checking who you are...</p>}
      </div>
    );
  }
  return <ImportsBody key={known} />;
}

function ImportsBody() {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [pick, setPick] = useState<string | null>(null);
  const [panel, setPanel] = useState<"details" | "origins">("details");
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const live = useRef(true);

  const load = useCallback((quiet = false) => {
    if (!quiet) setRead((r) => (r.state === "ok" ? r : { state: "loading" }));
    readJobs().then((data) => { if (live.current) setRead({ state: "ok", data }); }, () => { if (live.current) setRead((r) => (quiet && r.state === "ok" ? r : { state: "failed" })); });
  }, []);
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [load]);

  const jobs = read.state === "ok" ? read.data.jobs : [];
  const anyActive = jobs.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const h = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(h);
  }, [anyActive, load]);

  const shown = jobs.filter((j) => passes(filter, j));
  const picked = jobs.find((j) => j.id === pick) ?? null;
  const week = weekOf(jobs);
  const count = (f: Filter) => jobs.filter((j) => passes(f, j)).length;

  return (
    <div className="screen imports" data-testid="imports">
      <div className="imp-head">
        <div>
          <h1>Imports</h1>
          <p className="lead">Everything you brought in, whether it worked, and who can see it. Items you add are held privately for you.</p>
        </div>
        <button type="button" className={"btn" + (adding ? "" : " pri")} onClick={() => setAdding((a) => !a)} aria-expanded={adding} data-testid="imp-add-toggle">
          {adding ? "Back to the list" : "+ Add a link or file"}
        </button>
      </div>

      <section className="card imp-week" aria-labelledby="imp-week-h" data-testid="imp-week">
        <h2 id="imp-week-h" className="imp-lab">This week</h2>
        {read.state === "ok" ? (
          <dl className="imp-stats">
            {([["came", "came in", week.came], ["landed", "landed", week.landed], ["running", "in progress", week.running], ["failed", "needs a look", week.failed], ["cancelled", "cancelled", week.cancelled]] as const).map(([k, label, n]) => (
              <div key={k} className="imp-stat"><dt>{label}</dt><dd data-testid={"week-" + k}>{n}</dd></div>
            ))}
          </dl>
        ) : <p className="meta">{read.state === "loading" ? "Counting..." : "Not counted: the list did not load."}</p>}
        {read.state === "ok" && read.data.capped && <p className="meta" data-testid="imp-capped">Counted from your newest {JOBS_LIMIT} of each kind; older ones are not in these numbers.</p>}
      </section>

      <p role="status" className={note ? "imp-note" : "sr-only"} data-testid="imp-note">{note}</p>

      {adding && <AddForm onClose={() => setAdding(false)} onAdded={(m) => { setAdding(false); setFilter("all"); setNote(m); load(); }} />}

      {!adding && (
        <section className="card imp-list-card" aria-labelledby="imp-list-h">
          <h2 id="imp-list-h" className="sr-only">What came in</h2>
          <div className="imp-filters" role="group" aria-label="Show">
            {FILTERS.map(([f, label]) => (
              <button key={f} type="button" className={"imp-tab" + (filter === f ? " on" : "")} aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={"filter-" + f}>
                {label}{read.state === "ok" && <span className="count"> {count(f)}</span>}
              </button>
            ))}
          </div>
          {read.state === "loading" && <p className="meta" role="status" data-testid="imp-loading">Loading...</p>}
          {read.state === "failed" && <p className="meta" data-testid="imp-failed">Could not load your imports. <button type="button" onClick={() => load()}>Try again</button></p>}
          {read.state === "ok" && jobs.length === 0 && <p className="empty" data-testid="imp-empty">Nothing has been brought in yet. Use "Add a link or file" to start.</p>}
          {read.state === "ok" && jobs.length > 0 && shown.length === 0 && <p className="empty" data-testid="imp-none">Nothing here: no item matches this filter.</p>}
          {shown.length > 0 && (
            <>
              <div className="imp-cols" aria-hidden="true"><span>What came in</span><span>Status</span><span>From</span><span>Who sees it</span><span>When</span></div>
              <ul className="imp-list">
                {shown.map((j) => {
                  const s = statusOf(j), w = whoSees(j);
                  return (
                    <li key={j.id}>
                      <button type="button" className={"imp-row" + (j.id === pick ? " sel" : "")} aria-current={j.id === pick ? "true" : undefined}
                        onClick={() => { setPick(j.id); setPanel("details"); }} data-testid="imp-row">
                        <span className="imp-what"><span className="row-title" data-testid="imp-title">{titleOf(j)}</span></span>
                        <span><span className="sr-only">Status: </span><span className={"imp-pill " + s.tone}>{s.label}</span></span>
                        <span className="meta"><span className="sr-only">From: </span>{fromOf(j)}</span>
                        <span><span className="sr-only">Who sees it: </span><span className={"imp-pill " + (isPrivate(j) ? "priv" : "shared")}>{w.short}</span></span>
                        <span className="meta"><span className="sr-only">When: </span>{ago(j.created)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="imp-panels" role="group" aria-label="Panel">
        <button type="button" className={"imp-tab" + (panel === "details" ? " on" : "")} aria-pressed={panel === "details"} onClick={() => setPanel("details")} data-testid="panel-details">Details</button>
        <button type="button" className={"imp-tab" + (panel === "origins" ? " on" : "")} aria-pressed={panel === "origins"} onClick={() => setPanel("origins")} data-testid="panel-inlets">Connected inlets</button>
      </div>
      {panel === "details"
        ? <Details job={picked} onChanged={(m) => { setNote(m); load(true); }} />
        : <Inlets jobs={jobs} ok={read.state === "ok"} />}
    </div>
  );
}

function Details({ job, onChanged }: { job: Job | null; onChanged: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [retried, setRetried] = useState<Record<string, true>>({}); // a retry already sent: its button is gone at once, before the re-read
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  if (!job) return <section className="card" data-testid="imp-details-empty"><p className="empty">Pick an item to see its steps, where it landed and why it failed.</p></section>;
  const s = statusOf(job), w = whoSees(job), landed = landedIn(job), steps = stepsOf(job);
  const act = async (verb: "retry" | "cancel") => {
    setBusy(true);
    try {
      await (verb === "retry" ? retryJob(job) : cancelJob(job));
      if (verb === "retry") setRetried((r) => ({ ...r, [job.id]: true }));
      if (live.current) onChanged(verb === "retry" ? "Trying again. It runs once more; check its status here." : "Cancelled. Nothing was kept.");
    } catch (e) {
      if (live.current) onChanged(reasonOf(e, "That did not work. Try again in a moment."));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const showRetry = canRetry(job) && !retried[job.id];
  return (
    <section className="card imp-details" aria-labelledby="imp-d-h" data-testid="imp-details">
      <div className="imp-dhead"><h2 id="imp-d-h">{titleOf(job)}</h2><span className={"imp-pill " + s.tone}>{s.label}</span></div>
      <dl className="imp-kv">
        <dt>From</dt><dd>{fromOf(job)}</dd>
        <dt>Steps</dt>
        <dd>
          {steps ? (
            <ol className="imp-steps">{steps.map((x, i) => <li key={i} className={x.state}><span className="sr-only">{x.state === "done" ? "Done: " : x.state === "now" ? "Now: " : "Next: "}</span>{x.label}</li>)}</ol>
          ) : <span>{job.status === "cancelled" ? "Stopped before it finished." : "It stopped before it finished."} It has run {job.attempts} {job.attempts === 1 ? "time" : "times"}.</span>}
        </dd>
        <dt>Landed in</dt>
        <dd>{job.status === "held" || job.status === "done" ? (landed.href ? <Link to={landed.href}>{landed.text}</Link> : landed.text) : <span>{landed.text} <span className="meta">(when it finishes)</span></span>}</dd>
        <dt>Who sees it</dt><dd>{w.long}</dd>
      </dl>
      {job.status === "failed" && <p className="imp-why" data-testid="imp-why"><strong>Why it failed:</strong> {job.error || "No reason was recorded."}</p>}
      {job.status === "cancelled" && job.error && <p className="meta" data-testid="imp-why">{job.error}</p>}
      {retriedAlready(job) && (
        <p className="imp-why" data-testid="imp-no-retry">It was already tried a second time{job.status === "failed" ? " and failed again" : ""}, so Try again is not offered a third time. Add the link or file again as a new item.</p>
      )}
      <div className="imp-actions">
        {showRetry && <button type="button" className="btn pri" disabled={busy} onClick={() => act("retry")} data-testid="imp-retry">Try again</button>}
        {canCancel(job) && <button type="button" className="btn" disabled={busy} onClick={() => act("cancel")} data-testid="imp-cancel">Cancel</button>}
        {(job.status === "held" || job.status === "done") && job.sourceId && <Link to="/library" className="btn">Open in Library</Link>}
      </div>
    </section>
  );
}

// The connected-inlets panel. The workbench has NO read of the connection record today (inlet_connections is readable
// by no app role: init-inlet-stamp.sql), so the panel does not list connections and does not pretend to. It shows what
// the caller's own jobs say about where items came from, and where connecting is done.
function Inlets({ jobs, ok }: { jobs: Job[]; ok: boolean }) {
  const owui = jobs.filter((j) => j.origin === "owui").length;
  return (
    <section className="card" aria-labelledby="imp-i-h" data-testid="imp-inlets">
      <h2 id="imp-i-h">Connected inlets</h2>
      <p data-testid="inlets-unavailable">Your connected inlets (Gmail, podcasts, Open WebUI chats, Google activity) can't be listed here yet: the workbench has no read for them. They are not hidden, just not shown.</p>
      {ok && <p className="meta" data-testid="inlets-origin">Items of yours that came from Open WebUI chats: {owui}. Everything else in your list was added here.</p>}
      <p className="meta">Connecting or pausing an inlet is done in <Link to="/settings">Settings</Link>. Your inlets are yours: what they bring in is held for you alone.</p>
    </section>
  );
}

// ── One link or file ────────────────────────────────────────────────────────────────────────────────────────────
function AddForm({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => void }) {
  const id = useId();
  const [mode, setMode] = useState<"link" | "file">("link");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lands, setLands] = useState<{ docs: LandingOption[]; ideas: LandingOption[] } | null>(null);
  const [landsFailed, setLandsFailed] = useState(false);
  const [where, setWhere] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    readLandings().then((l) => {
      if (!live.current) return;
      setLands(l);
      const locked = getLockedDocument()?.id;
      const first = locked && l.docs.find((d) => d.landing.kind === "doc" && d.landing.path === locked);
      if (first) setWhere(first.key);
    }, () => { if (live.current) setLandsFailed(true); });
    return () => { live.current = false; };
  }, []);

  const all = lands ? [...lands.docs, ...lands.ideas] : [];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = mode === "link" ? linkProblem(link) : !file ? "Choose a file first." : fileProblem(file);
    if (p) return setProblem(p);
    const target = all.find((o) => o.key === where);
    if (!target) return setProblem("Choose where it lands: one of your documents or ideas.");
    setProblem(""); setBusy(true);
    try {
      await addOne(mode === "link" ? { link: link.trim() } : { file: file! }, target.landing);
      if (live.current) onAdded("Added. It is queued; its status is in the list.");
    } catch (err) {
      if (live.current) { setProblem(reasonOf(err, "That did not work. Try again in a moment.")); setBusy(false); }
    }
  };
  return (
    <section className="card imp-form" aria-labelledby={id + "h"} data-testid="imp-form">
      <h2 id={id + "h"}>Bring in one link or file</h2>
      <p className="meta">Links are fetched through the private search gateway. Nothing else leaves the stack. Only you see what you add until it is admitted.</p>
      <form onSubmit={submit} noValidate>
        <fieldset className="imp-fs">
          <legend>What</legend>
          <label><input type="radio" name={id + "m"} checked={mode === "link"} onChange={() => { setMode("link"); setProblem(""); }} data-testid="mode-link" /> A link</label>
          <label><input type="radio" name={id + "m"} checked={mode === "file"} onChange={() => { setMode("file"); setProblem(""); }} data-testid="mode-file" /> A file</label>
        </fieldset>
        {mode === "link" ? (
          <div className="imp-field">
            <label htmlFor={id + "l"}>Link</label>
            <input id={id + "l"} type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://..." value={link} onChange={(e) => setLink(e.target.value)} data-testid="add-link" />
          </div>
        ) : (
          <div className="imp-field">
            <label htmlFor={id + "f"}>File (a PDF or a saved web page, up to {FILE_LIMIT_BYTES / 1024 / 1024} MB)</label>
            <input id={id + "f"} type="file" accept=".pdf,.html,.htm,.xhtml,application/pdf,text/html" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="add-file" />
          </div>
        )}
        <fieldset className="imp-fs imp-where" data-testid="imp-where">
          <legend>Where it lands</legend>
          {!lands && !landsFailed && <p className="meta" role="status">Loading your documents and ideas...</p>}
          {landsFailed && <p className="meta" data-testid="where-failed">Could not load your documents and ideas, so nothing can be added right now. Close this and open it again.</p>}
          {lands && all.length === 0 && <p className="empty" data-testid="where-empty">You have no document or idea for it to land in yet. <Link to="/documents">Make a document</Link> first.</p>}
          {lands && lands.docs.length > 0 && <p className="imp-sub">Documents</p>}
          {lands?.docs.map((o) => <label key={o.key} className="imp-opt"><input type="radio" name={id + "w"} checked={where === o.key} onChange={() => setWhere(o.key)} data-testid="where-opt" /> {o.label}</label>)}
          {lands && lands.ideas.length > 0 && <p className="imp-sub">Ideas</p>}
          {lands?.ideas.map((o) => <label key={o.key} className="imp-opt"><input type="radio" name={id + "w"} checked={where === o.key} onChange={() => setWhere(o.key)} data-testid="where-opt" /> {o.label}</label>)}
        </fieldset>
        <p role="alert" className={problem ? "imp-why" : "sr-only"} data-testid="add-problem">{problem}</p>
        <div className="imp-actions">
          <button type="submit" className="btn pri" disabled={busy || !lands} data-testid="add-submit">Add</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
