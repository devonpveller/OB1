// Screen 9, Ideas (rwr-ideas): every idea of the signed-in person, listed by state, with one idea open: its wording, where
// it came from, what belongs to it, how it changed, and what to do with it (research it, revise it, create or open its
// document, archive or reopen it). Everything is for ONE known subject: the screen lives under a key made of the last
// known subject, so a different person on the page drops the list, the open idea, a half-typed revision and every read in
// flight. An idea's text is shown here and nowhere else: not in the page title, the URL, a toast or the browser's storage.
// "Research this idea" calls the idea's own research-now (the request boundary); it never opens Start research.
// "Refine it in chat" and "Discuss it" are not shown: their screens are not built yet.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { navigate } from "../../lib/router";
import { stateEpoch } from "../../lib/state";
import { ago } from "../home/home-data";
import {
  approveQuestion, archive, createDocument, GROUPS, groupOf, isArchived, NotAvailable, readIdea, readIdeas, readResearch, reopen, researchNow,
  revise, runPrivately, STATE_LABEL, type IdeaDetail, type IdeaRow, type ResearchState, type Result,
} from "./ideas-data";

export function Ideas({ subject, whoAnswered, onRetry = () => window.location.reload() }: { subject: string | null; whoAnswered: boolean; onRetry?: () => void }) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <div className="screen ideas" data-testid="ideas">
        <h1 className="sr-only">Ideas</h1>
        {whoAnswered
          ? <p className="meta" data-testid="ideas-failed-who">Could not tell who you are, so nothing is shown. <button type="button" onClick={onRetry}>Try again</button></p>
          : <p className="meta" role="status" data-testid="ideas-waiting">Checking who you are...</p>}
      </div>
    );
  }
  return <IdeasScreen key={known} />;
}

type ListState = { state: "loading" } | { state: "failed" } | { state: "ok"; rows: IdeaRow[] };

function IdeasScreen() {
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [sel, setSel] = useState<string | null>(null);
  const live = useRef(true);
  const reload = useCallback(() => {
    readIdeas().then(
      (rows) => { if (live.current) setList({ state: "ok", rows }); },
      () => { if (live.current) setList((l) => (l.state === "ok" ? l : { state: "failed" })); },
    );
  }, []);
  useEffect(() => { live.current = true; reload(); return () => { live.current = false; }; }, [reload]);

  const rows = list.state === "ok" ? list.rows : [];
  // the open idea: the chosen one while it is still listed, else the first of the list
  const ordered = GROUPS.flatMap((g) => rows.filter((r) => groupOf(r.status) === g.key));
  const openId = sel && rows.some((r) => r.id === sel) ? sel : ordered[0]?.id ?? null;
  const openRow = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="screen ideas" data-testid="ideas">
      <div className="ideas-head">
        <h1>Ideas</h1>
        <span className="meta">Only you see your ideas. An idea gathers its research, its document and its chats in one place.</span>
      </div>
      {list.state === "loading" && <p className="meta" role="status" data-testid="ideas-loading">Loading your ideas...</p>}
      {list.state === "failed" && (
        <p className="meta" data-testid="ideas-failed">Could not load your ideas. <button type="button" onClick={() => { setList({ state: "loading" }); reload(); }}>Try again</button></p>
      )}
      {list.state === "ok" && rows.length === 0 && (
        <p className="empty card" data-testid="ideas-empty">You have no ideas yet. An idea you capture appears here, private to you.</p>
      )}
      {list.state === "ok" && rows.length > 0 && (
        <div className="ideas-grid">
          <nav className="card ideas-list" aria-label="Your ideas" data-testid="ideas-list">
            {GROUPS.map((g) => {
              const items = rows.filter((r) => groupOf(r.status) === g.key);
              if (!items.length) return null;
              return (
                <section key={g.key} aria-labelledby={"g-" + g.key} data-testid={"group-" + g.key}>
                  <h2 className="lab" id={"g-" + g.key}>{g.name} · {items.length}</h2>
                  <ul className="plain">
                    {items.map((r) => (
                      <li key={r.id}>
                        <button type="button" className={"idea-pick" + (r.id === openId ? " isel" : "")} aria-current={r.id === openId ? "true" : undefined}
                          data-testid="idea-row" data-id={r.id} onClick={() => setSel(r.id)}>
                          <span className="idea-pick-title">{r.title || "(untitled)"}</span>
                          <span className="meta">{[STATE_LABEL[r.status] ?? r.status, "updated " + ago(r.updated), "private to you"].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </nav>
          {openRow && <IdeaView key={openRow.id} row={openRow} onChanged={reload} />}
        </div>
      )}
    </div>
  );
}

export const RESEARCH_POLL_MS = 5000;

type Load<T> = { state: "loading" } | { state: "failed" } | { state: "gone" } | { state: "ok"; data: T };

function IdeaView({ row, onChanged }: { row: IdeaRow; onChanged: () => void }) {
  const id = row.id;
  const toast = useToast();
  const [d, setD] = useState<Load<IdeaDetail>>({ state: "loading" });
  const [rs, setRs] = useState<ResearchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const live = useRef(true);
  const reviseBtn = useRef<HTMLButtonElement>(null);
  // when the Revise form closes the cursor goes back to its button: asked for here, done after the commit in which the
  // button is enabled again (it is disabled while a write is in flight, and a disabled button cannot take focus)
  const focusRevise = useRef(false);

  const load = useCallback(() => {
    readIdea(id).then(
      (data) => { if (live.current) setD({ state: "ok", data }); },
      (e) => { if (live.current) setD(e instanceof NotAvailable ? { state: "gone" } : { state: "failed" }); },
    );
    readResearch(id).then((s) => { if (live.current) setRs(s); }, () => { if (live.current) setRs(null); });
  }, [id]);
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [load]);
  // while a request is still being prepared the state moves by itself (it may end up waiting for the owner): read it again
  const waitingOn = rs?.state === "pending";
  useEffect(() => {
    if (!waitingOn) return;
    const t = setInterval(() => { readResearch(id).then((s) => { if (live.current) setRs(s); }, () => {}); }, RESEARCH_POLL_MS);
    return () => clearInterval(t);
  }, [waitingOn, id]);

  // A write is answered whenever it is answered: the list is ALWAYS read again (the idea may have moved group even if the
  // person has opened another idea meanwhile). Only what belongs to this view (busy, error, the form, this idea's detail)
  // waits for it to still be on screen, and the toast (with its Undo) is dropped when a different person is on the page.
  const run = async (f: () => Promise<Result>, onOk?: (r: Result) => void) => {
    const epoch = stateEpoch();
    setBusy(true); setError("");
    const r = await f();
    if (live.current) setBusy(false);
    if (!r.ok) { if (live.current) setError(r.message); return; }
    if (stateEpoch() === epoch) onOk?.(r);
    onChanged();
    if (live.current) load();
  };

  const archived = isArchived(d.state === "ok" ? d.data.status : row.status);
  useEffect(() => {
    if (focusRevise.current && !editing && !busy && !archived && reviseBtn.current) { focusRevise.current = false; reviseBtn.current.focus(); }
  });
  const doArchive = () => run(() => archive(id), (r) => {
    // Undo is for the person who archived it: after a switch of person (the epoch moved) it does nothing
    const epoch = stateEpoch();
    toast({ message: r.message, onUndo: () => { if (stateEpoch() === epoch) void reopen(id).then(() => { load(); onChanged(); }); } });
  });
  const doReopen = () => run(() => reopen(id), (r) => toast({ message: r.message }));
  const doResearch = () => run(() => researchNow(id), (r) => toast({ message: r.message }));
  const doDocument = () => run(() => createDocument(id), (r) => { if (r.path) navigate("/documents/" + encodeURIComponent(r.path)); });

  if (d.state === "loading") return <section className="card idea-view" aria-busy="true"><p className="meta" role="status" data-testid="idea-loading">Loading this idea...</p></section>;
  if (d.state === "gone") return <section className="card idea-view"><p data-testid="idea-gone">This idea is not available.</p></section>;
  if (d.state === "failed") return (
    <section className="card idea-view"><p className="meta" data-testid="idea-failed">Could not load this idea. <button type="button" onClick={() => { setD({ state: "loading" }); load(); }}>Try again</button></p></section>
  );
  const x = d.data;
  return (
    <section className="card idea-view" aria-labelledby="idea-title" data-testid="idea-view" data-id={x.id}>
      <div className="idea-top">
        <span className="pill" data-testid="idea-state">{STATE_LABEL[x.status] ?? x.status}</span>
        <span className="meta">captured {ago(x.created) || "earlier"} · from {x.from}</span>
        <span className="pill private" data-testid="idea-private">private to you</span>
      </div>
      <h2 id="idea-title" className="idea-title" data-testid="idea-title">{x.title || "(untitled)"}</h2>
      <p className="idea-summary" data-testid="idea-summary">{x.summary}</p>

      {archived && <p className="meta" data-testid="idea-archived-note">This idea is archived: scheduled research is stopped. Reopen it to research, revise or create a document from it.</p>}

      <div className="idea-actions" role="group" aria-label="What to do with this idea">
        <button type="button" className="btn pri" disabled={busy || archived} onClick={doResearch} data-testid="act-research">Research this idea</button>
        {x.document
          ? <Link to={"/documents/" + encodeURIComponent(x.document.path)} className="btn" data-testid="act-document">Open its document</Link>
          : <button type="button" className="btn" disabled={busy || archived} onClick={doDocument} data-testid="act-document">Create a document from it</button>}
        <button type="button" className="btn" ref={reviseBtn} disabled={busy || archived} aria-expanded={editing} onClick={() => setEditing(true)} data-testid="act-revise">Revise the idea</button>
        {archived
          ? <button type="button" className="btn" disabled={busy} onClick={doReopen} data-testid="act-reopen">Reopen this idea</button>
          : <button type="button" className="btn" disabled={busy} onClick={doArchive} data-testid="act-archive">Archive idea</button>}
      </div>
      <p className="meta idea-help">
        Revise saves a new wording of the idea; the next research uses it, and earlier runs stay linked to the wording they started from.
        Archive stops any scheduled research and moves the idea to Archived, where Reopen brings it back as it was.
      </p>
      {error && <p className="note-err" role="alert" data-testid="idea-error">{error}</p>}

      {editing && (
        <ReviseForm current={x.summary} busy={busy}
          onCancel={() => { focusRevise.current = true; setEditing(false); }}
          onSave={(text) => run(() => revise(id, text), (r) => { focusRevise.current = true; setEditing(false); toast({ message: r.message }); })} />
      )}

      {rs && rs.state !== "none" && <ResearchLine key={rs.review?.candidate ?? rs.state} rs={rs} busy={busy}
        onApprove={(q) => run(() => approveQuestion(id, q), (r) => toast({ message: r.message }))}
        onPrivate={(q) => run(() => runPrivately(id, q), (r) => toast({ message: r.message }))} />}

      <div className="idea-cols">
        <div className="idea-col" data-testid="belongs">
          <h3 className="lab">What belongs to it</h3>
          <Belongs x={x} />
        </div>
        <div className="idea-col" data-testid="changed">
          <h3 className="lab">How it changed</h3>
          <ol className="plain revs">
            {x.revisions.map((r) => {
              const run = r.runId ? x.runs.find((s) => s.id === r.runId) : undefined;
              return (
                <li key={r.revision} className="rev" data-testid="rev" data-revision={r.revision} data-run-id={r.runId || undefined}>
                  <span className="meta rev-at">{ago(r.at) || "earlier"}</span>
                  <span className="rev-what">
                    <span className="meta">{r.revision === 1 ? "Captured" : "Revision " + r.revision}{r.revision === x.revision ? " (current)" : ""}</span>
                    <span className="rev-text">{r.summary}</span>
                    {r.runId && <span className="meta" data-testid="rev-run">{run ? "Research started from this wording: " + (run.query || "a run") : "Research was started from this wording"}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

function Belongs({ x }: { x: IdeaDetail }) {
  const items: { kind: string; name: string; line?: string; to?: string; key: string }[] = [];
  if (x.document) items.push({ kind: "Document", name: x.document.title || "(untitled)", to: "/documents/" + encodeURIComponent(x.document.path), key: "doc" });
  for (const r of x.runs) items.push({ kind: "Research", name: r.query || "a research run", line: r.status, to: "/research", key: "run-" + r.id });
  if (x.chat) items.push({ kind: "Chat", name: "The idea's room", line: x.chat.entries + (x.chat.entries === 1 ? " entry" : " entries"), key: "chat" });
  if (x.podcasts) items.push({ kind: "Podcast", name: x.podcasts + (x.podcasts === 1 ? " podcast" : " podcasts"), to: "/podcasts", key: "pod" });
  for (const s of x.sources) items.push({ kind: "Source", name: s.title || "(untitled)", line: "a source you added", to: "/library", key: "src-" + s.id });
  if (!items.length) return <p className="meta" data-testid="belongs-empty">Nothing yet. Research, a document or a chat on this idea will appear here.</p>;
  return (
    <ul className="plain">
      {items.map((m) => {
        const inner = (
          <>
            <span className="kind">{m.kind}</span>
            <span className="mem-main"><span>{m.name}</span>{m.line && <span className="meta">{m.line}</span>}</span>
          </>
        );
        return <li key={m.key}>{m.to ? <Link to={m.to} className="mem" data-testid="mem">{inner}</Link> : <div className="mem" data-testid="mem">{inner}</div>}</li>;
      })}
    </ul>
  );
}

function ReviseForm({ current, busy, onSave, onCancel }: { current: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(current);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const t = text.trim();
  return (
    <form className="revise" data-testid="revise-form" onSubmit={(e) => { e.preventDefault(); if (t && t !== current.trim()) onSave(t); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <label htmlFor={id}>New wording of the idea</label>
      <textarea id={id} ref={ref} value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={20000} data-testid="revise-text" />
      <div className="revise-actions">
        <button type="button" onClick={onCancel} data-testid="revise-cancel">Cancel</button>
        <button type="submit" className="btn pri" disabled={busy || !t || t === current.trim()} data-testid="revise-save">Save as a new revision</button>
      </div>
    </form>
  );
}

function ResearchLine({ rs, busy, onApprove, onPrivate }: { rs: ResearchState; busy: boolean; onApprove: (q: string) => void; onPrivate: (q: string) => void }) {
  const [q, setQ] = useState(rs.review?.candidate ?? "");
  const id = useId();
  if (rs.state === "awaiting_owner" && rs.review) {
    const t = q.trim();
    return (
      <div className="card review" data-testid="research-state" data-state="awaiting_owner" role="group" aria-label="Research waits for you">
        <p><strong>Research is waiting for you.</strong> The idea could not be turned into a question that is safe to send out as it is.
          Edit the question, then approve it to run as shared research, or run it privately so the report stays yours.</p>
        {rs.review.failing.length > 0 && <p className="meta">Wording that held it back: {rs.review.failing.join(", ")}</p>}
        <label htmlFor={id}>The question</label>
        <textarea id={id} value={q} onChange={(e) => setQ(e.target.value)} rows={3} maxLength={2000} data-testid="review-question" />
        <div className="revise-actions">
          <button type="button" disabled={busy || !t} onClick={() => onPrivate(t)} data-testid="review-private">Run it privately</button>
          <button type="button" className="btn pri" disabled={busy || !t} onClick={() => onApprove(t)} data-testid="review-approve">Approve this question</button>
        </div>
      </div>
    );
  }
  const text = rs.state === "pending" ? "Research was requested: the question is being prepared."
    : rs.state === "queued" ? "Research on this idea is queued or running."
    : rs.state === "delivered" ? "Research on this idea finished."
    : rs.state === "refused" ? "The last research request for this idea was not sent: its question could not be made safe to send. Revise the idea and ask again."
    : rs.state === "failed" ? "The last research request for this idea failed. Ask again."
    : "Research on this idea is in a state this screen does not know yet.";
  return <p className="meta research-line" data-testid="research-state" data-state={rs.state} role="status">{text}{rs.state === "queued" && <> <Link to="/research">See Research</Link></>}</p>;
}
