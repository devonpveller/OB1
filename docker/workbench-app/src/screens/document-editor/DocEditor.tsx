// The writing surface of an open document (rwr-doc-editor): screen 3's body. DocumentScreen hands an ACTIVE document
// here (archived and trashed ones keep their read-only / restore frames there).
//
//   - the text is the file's BODY; the front matter is kept verbatim behind it and never shown or edited, so what is
//     saved is always front + body;
//   - saving: a pause in typing writes the file (autosave, no version); Save / Ctrl+S and Close make a version (a
//     commit, only when the text differs from the last one). The indicator reads "vN - saved <ago>", N = the number
//     of versions in the history (derived, not stored);
//   - a save carries the hash of the text this tab last read or wrote (if_match). When the server answers 409 the
//     other copy is NOT overwritten and this tab's text is NOT dropped: both stay, the message says what happened,
//     and the person copies their text or deliberately loads the other version (an undoable replace);
//   - Close saves first and stays open (with the reason) when it cannot; it never throws a document away;
//   - nothing here is kept in the browser: the text lives in this component and the editor, both gone when the
//     person changes (the parent is keyed by the subject) or the screen closes.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { navigate } from "../../lib/router";
import {
  getLastDocument, getLockedDocument, setLastDocument, setLockedDocumentSaved, stateEpoch, subscribeState,
} from "../../lib/state";
import { createEditor } from "../../editor";
import { protectedSpans, type ProtectedSpan } from "../../editor/protected";
import { ago, docHref, NOT_FOUND } from "../documents/docs-data";
import {
  AUTOSAVE_MS, Conflict, crumbsOf, isSamePerson, loadDocument, problem, queueResearch, readRoot, readVersion, researchProblem, saveDocument,
  versionText, type Loaded, type Version,
} from "./editor-data";
import { InThisDoc } from "./InThisDoc";
import { SourceDrawer, type DrawerTarget } from "./SourceDrawer";

type Load = { s: "loading" } | { s: "gone" } | { s: "failed" } | { s: "ready"; doc: Loaded };
type Save = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
const RESEARCH_CAP = 1000;

export function DocEditor({ path, subject }: { path: string; subject: string }) {
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const live = useRef(true);
  const read = useCallback(async () => {
    setLoad({ s: "loading" });
    try {
      const doc = await loadDocument(path);
      if (live.current) setLoad({ s: "ready", doc });
    } catch (e) {
      if (live.current) setLoad(problem(e, "") === NOT_FOUND ? { s: "gone" } : { s: "failed" });
    }
  }, [path]);
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [read]);

  if (load.s === "loading") return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">Loading...</p></section>;
  if (load.s === "gone") {
    return (
      <section className="screen doc" data-testid="document">
        <h1>Document</h1>
        <p data-testid="doc-gone">{NOT_FOUND}</p>
        <Link to="/documents">Back to Documents</Link>
      </section>
    );
  }
  if (load.s === "failed") {
    return (
      <section className="screen doc" data-testid="document">
        <h1>Document</h1>
        <p className="meta" data-testid="doc-failed">Could not open this document. <button type="button" onClick={() => void read()}>Try again</button></p>
        <Link to="/documents">Back to Documents</Link>
      </section>
    );
  }
  return <Writing path={path} subject={subject} first={load.doc} />;
}

function Writing({ path, subject, first }: { path: string; subject: string; first: Loaded }) {
  const toast = useToast();
  const locked = useSyncExternalStore(subscribeState, getLockedDocument);
  const epoch0 = useRef(stateEpoch());
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // what this tab holds: the front matter (verbatim), the latest body, the hash of the last text read or written
  const front = useRef(first.front);
  const body = useRef(first.body);
  const hash = useRef(first.hash);
  const dirty = useRef(false);       // text newer than the last write
  const uncommitted = useRef(false); // written, but not yet a version
  const conflicted = useRef(false);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const replacing = useRef(false);   // the box is being set to the other version: not an edit by the person

  const [title] = useState(first.title);
  const [status, setStatus] = useState<Save>("idle");
  const [version, setVersion] = useState<Version | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState("");        // a plain status line (copied, listing warning)
  const [error, setError] = useState("");      // a failed save, said in words
  const [asking, setAsking] = useState(false); // "replace with the other version?" is open
  const [selection, setSelection] = useState("");
  const [researchErr, setResearchErr] = useState("");
  const [lockErr, setLockErr] = useState("");
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const selRef = useRef("");

  // ── the saving machine ──
  const doSave = useCallback(async (commit: boolean): Promise<boolean> => {
    if (conflicted.current) return false;
    if (!commit && !dirty.current) return true;
    if (commit && !dirty.current && !uncommitted.current) return true;
    const text = front.current + body.current;
    const sent = body.current;
    if (alive.current) { setStatus("saving"); setError(""); }
    // only the person who opened the document may write it: a change of person that the shell has not noticed yet must
    // not send this text under the next person's sign-in
    if (!(await isSamePerson(subject))) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (alive.current) { setStatus("error"); setError("Not saved: this page could not confirm that you are still the person who opened this document. Nothing was sent."); }
      return false;
    }
    try {
      const r = await saveDocument(path, text, hash.current, commit);
      hash.current = r.hash;
      if (body.current === sent) dirty.current = false;
      uncommitted.current = commit ? false : true;
      if (!alive.current) return true;
      setSavedAt(new Date().toISOString());
      setStatus(dirty.current ? "dirty" : "saved");
      if (!r.listingOk) setNote("Saved. The list of documents could not be updated yet; it catches up by itself.");
      if (commit) readVersion(path).then((v) => { if (alive.current) setVersion(v); }, () => {});
      return true;
    } catch (e) {
      if (e instanceof Conflict) {
        conflicted.current = true;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        if (alive.current) { setStatus("conflict"); setAsking(false); }
        return false;
      }
      if (alive.current) { setStatus("error"); setError(problem(e, "Not saved: the document could not be written. Your text is still here.")); }
      return false;
    }
  }, [path, subject]);
  // saves run one after another, so a second request never races the first one's hash
  const save = useCallback((commit: boolean) => {
    chain.current = chain.current.then(() => doSave(commit), () => doSave(commit));
    return chain.current;
  }, [doSave]);

  // ── opening: the Last document, the version, the breadcrumb, back to the top ──
  useEffect(() => {
    alive.current = true;
    if (getLastDocument()?.id !== path) setLastDocument({ id: path, title: first.title });
    readVersion(path).then((v) => { if (alive.current) { setVersion(v); setSavedAt(v.at); } }, () => {});
    readRoot().then((root) => { if (alive.current) setCrumbs(crumbsOf(path, root)); });
    const main = document.getElementById("main");
    if (main) main.scrollTop = 0;
    return () => {
      alive.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      // leaving by any in-app door writes what is unwritten, for the same person only (a change of person
      // bumps the state epoch: nothing of theirs is sent under the next person's sign-in)
      if (dirty.current && !conflicted.current && epoch0.current === stateEpoch()) {
        const text = front.current + body.current, h = hash.current;
        void isSamePerson(subject).then((same) => (same ? saveDocument(path, text, h, false) : undefined)).catch(() => {});
      }
    };
  }, [path, subject, first.title]);

  // a warning when the page itself is closed with text that was not written
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => { if (dirty.current || conflicted.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, []);
  // "saved 1 min ago" moves on
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(h); }, []);

  // ── the editor ──
  const openSpan = useCallback((s: ProtectedSpan) => {
    const order = [...new Set(protectedSpans(body.current).map((x) => x.reference_id))];
    setDrawer({ kind: "reference", id: s.reference_id, n: order.indexOf(s.reference_id) + 1 });
  }, []);
  // EVERY write this screen makes (a save, the write on leaving, Research this, Lock / Swap / Unlock and its Undo) goes
  // through `ifSamePerson`: it re-reads who is signed in and runs the write only for the person who opened the document
  // (the shell notices a change of person on a 30 s timer; until then a write would leave under the next person's session)
  const ifSamePerson = useCallback(async <T,>(write: () => Promise<T> | T): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (!(await isSamePerson(subject))) return { ran: false };
    return { ran: true, value: await write() };
  }, [subject]);
  const NOT_SAME = "Not sent: this page could not confirm that you are still the person who opened this document.";
  const research = useCallback(() => {
    const text = selRef.current.trim();
    if (!text) return;
    setResearchErr("");
    const q = text.slice(0, RESEARCH_CAP);
    ifSamePerson(() => queueResearch(path, q)).then((r) => {
      if (!r.ran) { if (alive.current) setResearchErr(NOT_SAME); return; }
      if (alive.current) toast({ message: text.length > RESEARCH_CAP ? `Research queued on the first ${RESEARCH_CAP} characters of the selection.` : "Research queued on the selected text." });
    }).catch((e) => { if (alive.current) setResearchErr(researchProblem(e)); });
  }, [path, toast, ifSamePerson]);
  const researchRef = useRef(research);
  researchRef.current = research;

  useEffect(() => {
    if (!host.current) return;
    const v = createEditor(host.current, {
      doc: first.body,
      onChange: (text) => {
        body.current = text;
        if (replacing.current) return;
        dirty.current = true;
        if (conflicted.current) return;
        setStatus("dirty"); setError(""); setNote("");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; void save(false); }, AUTOSAVE_MS);
      },
      candidates: async () => [],
      onSelectSpan: (s) => openSpan(s),
      onLinkOpen: (t) => {
        if (t.kind === "document") navigate(docHref(t.id));
        else if (t.kind === "source") setDrawer({ kind: "source", id: t.id, n: 0 });
      },
      onSelection: (t) => { selRef.current = t; setSelection(t); setResearchErr(""); },
      onResearch: () => researchRef.current(),
      onLeave: () => { document.querySelector<HTMLElement>("[data-testid=doc-save]")?.focus(); },
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // the editor is made once per opened document; its text lives in the refs above
  }, [first.body, openSpan, save]);

  // ── actions ──
  const close = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const ok = await save(true);
    if (ok) navigate("/documents");
    else if (alive.current) setNote("Not closed, because your text is not saved yet. The message above says why.");
  };
  const manualSave = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    await save(true);
  };
  useEffect(() => {
    // Ctrl+S / Cmd+S saves a version from anywhere on the screen
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); void manualSave(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const copyMine = async () => {
    try { await navigator.clipboard.writeText(body.current); setNote("Your text is copied."); }
    catch { setNote("Your text could not be copied here: select it in the box and copy it by hand."); }
  };
  const takeOther = async () => {
    try {
      const other = await loadDocument(path);
      front.current = other.front; body.current = other.body; hash.current = other.hash;
      dirty.current = false; uncommitted.current = false; conflicted.current = false;
      const v = view.current;
      replacing.current = true;
      try { if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: other.body } }); } // undoable: Ctrl+Z brings your text back
      finally { replacing.current = false; }
      setStatus("saved"); setAsking(false); setError(""); setNote("The other version is loaded. Undo (Ctrl+Z) brings your text back into the box.");
      readVersion(path).then((x) => { if (alive.current) { setVersion(x); setSavedAt(x.at); } }, () => {});
    } catch (e) {
      setAsking(false);
      setNote(problem(e, "The other version could not be loaded."));
    }
  };

  const here = locked?.id === path;
  const toggleLock = async () => {
    setLockErr("");
    if (here) {
      const epoch = stateEpoch();
      const was = locked!;
      const r = await ifSamePerson(() => setLockedDocumentSaved(null));
      if (!r.ran) { setLockErr(NOT_SAME); return; }
      if (!r.value) { setLockErr("The unlock could not be saved."); return; }
      toast({ message: "Unlocked.", onUndo: () => { if (stateEpoch() === epoch) void ifSamePerson(() => setLockedDocumentSaved(was)); } });
      return;
    }
    const r = await ifSamePerson(() => setLockedDocumentSaved({ id: path, title }));
    if (!r.ran) { setLockErr(NOT_SAME); return; }
    if (!r.value) { setLockErr("The lock could not be saved."); return; }
    toast({ message: "Locked." });
  };
  const lockLabel = here ? "Unlock" : locked ? "Swap" : "Lock";

  const indicator = (() => {
    const v = versionText(version);
    if (status === "conflict") return `${v} · not saved`;
    if (status === "error") return `${v} · not saved`;
    if (status === "saving") return `${v} · saving...`;
    if (status === "dirty") return `${v} · unsaved changes`;
    return `${v} · saved${savedAt ? " " + (ago(savedAt, now) || "") : ""}`.trim();
  })();

  return (
    <section className="screen doc doc-ed" data-testid="document" data-doc-state="active">
      <nav className="crumbs" aria-label="Breadcrumb" data-testid="breadcrumb">
        <Link to="/documents">Documents</Link>
        {crumbs.map((c, i) => <span key={i}><span aria-hidden="true"> / </span>{c}</span>)}
        <span aria-hidden="true"> /</span>
      </nav>
      <div className="doc-head doc-ed-head">
        <h1>{title}</h1>
        <span className="doc-ver" role="status" data-testid="doc-version" data-save={status}>{indicator}</span>
        <div className="doc-acts">
          <button type="button" className="btn sm" data-testid="doc-lock" aria-pressed={here}
            title="Cites from anywhere go to this document's queue" onClick={() => void toggleLock()}>{lockLabel}</button>
          <button type="button" className="btn sm" data-testid="doc-save" aria-keyshortcuts="Control+S" disabled={status === "conflict"} onClick={() => void manualSave()}>Save</button>
          <button type="button" className="btn sm pri" data-testid="doc-close" onClick={() => void close()}>Close</button>
        </div>
      </div>
      {lockErr && <p className="docs-err" role="alert">{lockErr}</p>}
      {here && <p className="meta" data-testid="doc-locked-note">This document is locked: cites from anywhere go to its queue.</p>}
      {status === "conflict" && (
        <div className="card doc-note doc-conflict" role="alert" data-testid="doc-conflict">
          <p><strong>This document was changed somewhere else</strong> (another tab or window), so your text was not saved and nothing was overwritten. Your text is still in the box below, and the other version is untouched.</p>
          {asking ? (
            <div className="doc-conflict-ask">
              <p>This replaces what is in this tab with the other version. Your text here is lost unless you copied it (Ctrl+Z in the box brings it back until you leave).</p>
              <div className="doc-conflict-acts">
                <button type="button" className="btn sm danger-line" data-testid="doc-take-other-ok" onClick={() => void takeOther()}>Replace with the other version</button>
                <button type="button" className="btn sm" onClick={() => setAsking(false)}>Keep my text</button>
              </div>
            </div>
          ) : (
            <div className="doc-conflict-acts">
              <button type="button" className="btn sm" data-testid="doc-copy-mine" onClick={() => void copyMine()}>Copy my text</button>
              <button type="button" className="btn sm" data-testid="doc-take-other" onClick={() => setAsking(true)}>Load the other version</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="docs-err" role="alert" data-testid="doc-error">{error}</p>}
      {note && <p className="meta" role="status" data-testid="doc-note">{note}</p>}
      <div className="doc-cols">
        <div className="doc-main">
          <div className="sel-bar" role="toolbar" aria-label="Selected text" data-testid="sel-bar">
            <button type="button" className="btn sm" data-testid="research-this" disabled={!selection.trim()} aria-keyshortcuts="Control+Alt+R"
              onClick={research}>Research this</button>
            <span className="meta">{selection.trim() ? `${selection.trim().length} characters selected` : "Select some text to research it."}</span>
            {researchErr && <span className="docs-err" role="alert" data-testid="research-err">{researchErr}</span>}
          </div>
          <div className="card doc-edit"><div className="doc-editor" ref={host} data-testid="doc-editor" /></div>
          <p className="meta doc-keys" data-testid="doc-keys">Tab or Esc leaves the text box · Ctrl+] indents · Ctrl+S saves a version · Alt+Enter beside a citation opens its source · Ctrl+Alt+R researches the selection</p>
        </div>
        <InThisDoc />
      </div>
      {drawer && <SourceDrawer key={drawer.kind + drawer.id} target={drawer} onClose={() => { setDrawer(null); view.current?.focus(); }} />}
    </section>
  );
}
