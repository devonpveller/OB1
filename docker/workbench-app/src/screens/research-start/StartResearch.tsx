// The Start research dialog (rwr-start-research, screen 4): opened from every "+ Start research" and from "Research
// this" on a document (/research/start, or /research/start?document=<opaque id>). The person writes the question, chooses
// what it attaches to (nothing, or one of their own documents - never an idea) and how deep, and SEES what would leave
// the workbench before pressing Start.
//
// The rules this screen keeps (each has a test):
//  - the preview is the back end's own (POST /workbench/research/preview), debounced as the question changes;
//  - Start is available only for a preview that matches what is on screen right now, and it sends the SAME body plus
//    approved_question = the text the preview showed (the server refuses with 409 rather than send a different one);
//  - it calls only the workbench's routes (lib/api.ts); nothing is stored (no storage, no URL beyond the document's
//    opaque id, no cache); a toast never carries a title; a different person on the page empties the dialog;
//  - a document that is not the person's own is the same one sentence as a missing one (the title is never learned).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { navigate } from "../../lib/router";
import { ApiError } from "../../lib/api";
import { resolveDocument } from "../../lib/state";
import { docHref, resolveRef } from "../documents/docs-data";
import { ForDocumentBar } from "../../shell/ForDocumentBar";
import { useToast } from "../../shell/Toast";
import { Link } from "../../shell/Link";
import {
  DEPTHS, MAX_QUESTION, bodyOf, documentFromSearch, limitsText, needsAsk, previewResearch, readMyDocuments, readStartDefaults, refusalText, sameBody, startResearch,
  type DocChoice, type Depth, type PreviewOut, type StartBody,
} from "./start-data";
import "./start.css";

export { startResearchHref } from "./start-data";
export const PREVIEW_DEBOUNCE_MS = 400;

// Drawn for ONE known subject: under a key made of that subject and the address's query, so a different person on
// the page (the shell's periodic whoami read) or a different document in the address starts the dialog afresh -
// the question, the document and the preview of the previous person are dropped, with every request in flight.
export function StartResearch({ subject, whoAnswered, debounceMs = PREVIEW_DEBOUNCE_MS }: { subject: string | null; whoAnswered: boolean; debounceMs?: number }) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <div className="screen startres" data-testid="start-research-screen">
        <h1 className="sr-only">Start research</h1>
        {whoAnswered
          ? <p className="meta" data-testid="start-failed">Could not tell who you are, so nothing is shown. <button type="button" onClick={() => window.location.reload()}>Try again</button></p>
          : <p className="meta" role="status" data-testid="start-waiting">Checking who you are...</p>}
      </div>
    );
  }
  const search = window.location.search;
  return <Dialog key={known + "|" + search} search={search} debounceMs={debounceMs} />;
}

type Prev = { body: StartBody; res: PreviewOut | null; failed: boolean; gone: boolean } | null;
type DocState = "none" | "checking" | "gone" | "error";

function Dialog({ search, debounceMs }: { search: string; debounceMs: number }) {
  const toast = useToast();
  const uid = useId();
  const fromRef = useMemo(() => documentFromSearch(search), [search]); // the document's opaque id, never its path
  const asked = useRef(fromRef); // a document named in the address: the dialog was opened for it
  const [attach, setAttach] = useState<"none" | "doc">(fromRef ? "doc" : "none");
  const [doc, setDoc] = useState<DocChoice | null>(null);
  const [docState, setDocState] = useState<DocState>(fromRef ? "checking" : "none");
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<Depth>("standard");
  const [askOver, setAskOver] = useState<number | null>(null); // the person's "ask me before a run reads more than this many pages"
  const depthTouched = useRef(false); // a depth the person chose is never replaced by the default that arrives late
  const [prev, setPrev] = useState<Prev>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null); // the last start's outcome, in words
  const live = useRef(true);
  const qRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { qRef.current?.focus(); }, []);

  // the person's own defaults (this dialog is drawn for one subject: a different person remounts it, so a late answer for
  // the earlier one cannot land here)
  useEffect(() => {
    let on = true;
    readStartDefaults().then(
      (d) => { if (!on) return; if (d.depth && !depthTouched.current) setDepth(d.depth); setAskOver(d.askOver); },
      () => { /* no defaults: the dialog is as it always was */ },
    );
    return () => { on = false; };
  }, []);

  // the prefilled document: read through the owner-scoped state and file routes. Not the person's own, trashed
  // and missing are one answer; the title is shown only when it is theirs and live.
  useEffect(() => {
    if (!fromRef) return;
    let on = true;
    // the id answers only for the person's own document (another person's, a deleted one and a made-up one are one 404)
    const find = async () => {
      try { return await resolveDocument((await resolveRef(fromRef)).path); }
      catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return null; throw e; }
    };
    find().then(
      (d) => { if (!on) return; if (d) { setDoc({ path: d.id, title: d.title, ref: d.ref ?? fromRef }); setDocState("none"); } else { setAttach("none"); setDocState("gone"); } },
      () => { if (!on) return; setAttach("none"); setDocState("error"); },
    );
    return () => { on = false; };
  }, [fromRef]);

  const body = useMemo<StartBody | null>(() => {
    if (question.trim() === "") return null;
    if (attach === "doc") return doc ? bodyOf({ kind: "document", path: doc.path }, question, depth) : null;
    return bodyOf({ kind: "none" }, question, depth);
  }, [question, attach, doc, depth]);
  const bodyKey = body ? JSON.stringify(body) : "";

  // the preview: after the person stops changing things (any change restarts the wait), one read; a late answer to
  // an earlier body is dropped
  useEffect(() => {
    setNote(null);
    if (!body) { setPrev(null); return; }
    let on = true;
    setPrev({ body, res: null, failed: false, gone: false });
    const h = setTimeout(() => {
      previewResearch(body).then(
        (res) => { if (on) setPrev({ body, res, failed: false, gone: false }); },
        (e) => { if (on) setPrev({ body, res: null, failed: true, gone: (e as { status?: number })?.status === 404 }); },
      );
    }, debounceMs);
    return () => { on = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey, debounceMs]);

  const current = prev && body && sameBody(prev.body, body) ? prev : null;
  const ready = !!current?.res?.ok;
  const asks = ready && needsAsk(askOver, current?.res?.depth ?? null);
  const goBack = () => navigate(asked.current ? docHref(asked.current) : "/");

  async function refresh(b: StartBody) {
    try { const res = await previewResearch(b); if (live.current) setPrev({ body: b, res, failed: false, gone: false }); }
    catch { if (live.current) setPrev({ body: b, res: null, failed: true, gone: false }); }
  }

  const start = async () => {
    if (!body || !current?.res?.ok || !current.res.question || starting) return;
    setStarting(true); setNote(null);
    const out = await startResearch(body, current.res.question);
    if (!live.current) return; // the page moved on (a different person, or left): nothing more happens
    setStarting(false);
    if (out.kind === "started") {
      toast({ message: "Research started." }); // never a title or the question: a toast outlives a change of person
      navigate("/research?run=" + encodeURIComponent(out.jobId));
    } else if (out.kind === "refused") {
      setPrev({ body, res: { ok: false, ...out.shown }, failed: false, gone: false });
    } else if (out.kind === "changed") {
      setNote("What would leave changed while you were looking. Check the text below and press Start again.");
      setPrev({ body, res: null, failed: false, gone: false });
      void refresh(body);
    } else if (out.kind === "gone") setNote("That document is not available.");
    else if (out.kind === "unavailable") setNote("Research is not available right now. Nothing was started.");
    else setNote("Could not start the research. Nothing was started. Try again.");
  };

  return (
    <div className="screen startres" data-testid="start-research-screen" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); goBack(); } }}>
      <div className="dlg" role="dialog" aria-labelledby={uid + "t"} data-testid="start-dialog">
        <div className="dlg-head">
          <h1 id={uid + "t"}>Start research</h1>
          <button type="button" className="dlg-x" aria-label="Close" onClick={goBack} data-testid="start-close">&times;</button>
        </div>

        {attach === "doc" && doc && (
          <ForDocumentBar title={doc.title} backTo={docHref(doc.ref)}>
            <span className="fordoc-note">The report and its sources will be attached to it.</span>
          </ForDocumentBar>
        )}
        {docState === "checking" && <p className="meta" role="status" data-testid="doc-checking">Opening the document...</p>}
        {docState === "gone" && <p className="note" role="status" data-testid="doc-gone">That document is not available.</p>}
        {docState === "error" && <p className="note" role="alert" data-testid="doc-error">Could not open that document right now. You can still research without one.</p>}

        <div className="fld">
          <label className="lab" htmlFor={uid + "q"}>Your question</label>
          <textarea id={uid + "q"} ref={qRef} rows={3} maxLength={MAX_QUESTION} value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="What do you want to find out?" data-testid="start-question" />
        </div>

        <div className="fld" role="group" aria-labelledby={uid + "a"}>
          <span className="lab" id={uid + "a"}>Attach the results to</span>
          <div className="seg">
            <button type="button" className={"opt" + (attach === "none" ? " sel" : "")} aria-pressed={attach === "none"} data-testid="attach-none"
              onClick={() => setAttach("none")}><span>Nothing</span><span className="meta">a new report, in Research</span></button>
            <button type="button" className={"opt" + (attach === "doc" ? " sel" : "")} aria-pressed={attach === "doc"} data-testid="attach-doc"
              onClick={() => setAttach("doc")}><span>A document</span><span className="meta">{doc ? "one of your documents, chosen" : "choose one of yours"}</span></button>
          </div>
          <p className="meta" data-testid="idea-hint">To research an idea, open the idea and choose Research this there.</p>
          {attach === "doc" && <DocChooser chosen={doc} onChoose={(d) => { setDoc(d); setDocState("none"); }} />}
        </div>

        <div className="fld" role="group" aria-labelledby={uid + "d"}>
          <span className="lab" id={uid + "d"}>How deep</span>
          <div className="seg">
            {DEPTHS.map((d) => (
              <button key={d.id} type="button" className={"opt" + (depth === d.id ? " sel" : "")} aria-pressed={depth === d.id} data-testid={"depth-" + d.id}
                onClick={() => { depthTouched.current = true; setDepth(d.id); }}><span>{d.label}</span><span className="meta">{d.blurb}</span></button>
            ))}
          </div>
        </div>

        <div className="leaves" data-testid="leaves" aria-live="polite">
          <span className="lab">What leaves the workbench</span>
          <Leaves body={body} current={current} onRetry={() => { if (body) { setPrev({ body, res: null, failed: false, gone: false }); void refresh(body); } }} />
          <span className="meta">Research gets only a cleaned question: the topic, the question and public links. Your document text, names and personal ids stay here. The report becomes shared knowledge; the link back to you stays private.</span>
        </div>

        {asks && current?.res?.depth && (
          <p className="note" role="status" data-testid="ask-first">
            This run may read up to {current.res.depth.max_fetch} pages, more than the {askOver} you asked to be asked about. Press Start anyway to go ahead.
          </p>
        )}
        {note && <p className="note" role="alert" data-testid="start-note">{note}</p>}
        <div className="dlg-foot">
          <span className="meta" data-testid="estimate">{DEPTHS.find((d) => d.id === depth)!.estimate}</span>
          <span className="dlg-actions">
            <button type="button" className="btn" onClick={goBack} data-testid="start-cancel">Cancel</button>
            <button type="button" className="btn pri" disabled={!ready || starting} onClick={() => void start()} data-testid="start-go">{starting ? "Starting..." : asks ? "Start anyway" : "Start"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Leaves({ body, current, onRetry }: { body: StartBody | null; current: Prev; onRetry: () => void }) {
  if (!body) return <span className="meta" data-testid="leaves-idle">Write a question to see exactly what would be sent.</span>;
  if (!current || (!current.res && !current.failed)) return <span className="meta" data-testid="leaves-loading">Checking what would be sent...</span>;
  if (current.failed) {
    return (
      <span className="meta" data-testid="leaves-failed">
        {current.gone ? "That document is not available." : "Could not check what would be sent, so Start is off. "}
        {!current.gone && <button type="button" onClick={onRetry} data-testid="leaves-retry">Check again</button>}
      </span>
    );
  }
  const r = current.res!;
  if (!r.ok) {
    return (
      <span data-testid="leaves-refused">
        <span className="note">{refusalText(r.refusal)}</span>
        {r.refusal && <span className="meta"> (reason: <code>{r.refusal.slice(0, 80)}</code>)</span>}
      </span>
    );
  }
  return (
    <span className="leaves-body" data-testid="leaves-ok">
      <span className="leaves-q" data-testid="leaves-question">&ldquo;{r.question}&rdquo;</span>
      {r.topic && <span className="meta" data-testid="leaves-topic">Topic: {r.topic}</span>}
      {r.links.length > 0 && (
        <span className="meta" data-testid="leaves-links">Public pages it will read: {r.links.map((l, i) => <code key={i} className="leaves-link">{l}</code>)}</span>
      )}
      {r.depth && <span className="meta" data-testid="leaves-limits">{limitsText(r.depth)}</span>}
    </span>
  );
}

// Choosing one of the person's own live documents: their listing (the server scopes it to them), as buttons.
// No search box and no <select>: the one picker component is for the library; a person's documents are a short list.
function DocChooser({ chosen, onChoose }: { chosen: DocChoice | null; onChoose: (d: DocChoice) => void }) {
  const [list, setList] = useState<DocChoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    setList(null); setFailed(false);
    readMyDocuments().then((l) => { if (on) setList(l); }, () => { if (on) setFailed(true); });
    return () => { on = false; };
  }, [n]);
  if (failed) return <p className="meta" role="alert" data-testid="docs-failed">Could not read your documents. <button type="button" onClick={() => setN(n + 1)}>Try again</button></p>;
  if (list === null) return <p className="meta" role="status" data-testid="docs-loading">Reading your documents...</p>;
  if (list.length === 0) return <p className="meta" data-testid="docs-empty">You have no documents yet. <Link to="/documents">Go to Documents</Link></p>;
  return (
    <ul className="docpick" data-testid="doc-chooser" aria-label="Your documents">
      {list.map((d) => (
        <li key={d.path}>
          <button type="button" className={"docpick-row" + (chosen?.path === d.path ? " sel" : "")} aria-pressed={chosen?.path === d.path} data-testid="doc-choice"
            onClick={() => onChoose(d)}>{d.title}</button>
        </li>
      ))}
    </ul>
  );
}
