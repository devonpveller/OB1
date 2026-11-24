// The document screen's frame (/documents/d/:ref): a title from the Documents list always lands here and opens the
// document. The address carries the document's OPAQUE id (the listing row's), never its title, a slug or the owner's
// folder key; the id is resolved to the person's own path by an owner-scoped read (another person's id, a deleted one
// and a made-up one are the same 404, so they show the same sentence). An old /documents/<path> address is swapped
// for the id form with history.replaceState (LegacyDocument), so the path leaves no history entry.
//   - active: the writing surface (document-editor/DocEditor.tsx, rwr-doc-editor): breadcrumb, version, Lock / Save / Close,
//     the "In this doc" tabs. Opening it makes it the Last document (the account key).
//   - archived: the text, READ-ONLY by design (no input, no editable region), with an Unarchive button.
//   - trashed: it does not open; it says when it goes by itself and offers Restore.
//   - missing or someone else's: the same one sentence (docs-data NOT_FOUND), never the server's details.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenProps } from "../../routes";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { replaceUrl } from "../../lib/router";
import { getLastDocument, getLockedDocument, setLastDocument, setLockedDocument } from "../../lib/state";
import { DocEditor } from "../document-editor/DocEditor";
import { docHref, DOC_PREFIX, goesText, NOT_FOUND, problem, readFile, readListing, readState, resolveRef, restore, unarchive } from "./docs-data";

type View =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "failed" }
  | { state: "trashed"; path: string; title: string; goes: string }
  | { state: "writing"; path: string }
  | { state: "open"; path: string; title: string; body: string; archived: boolean };

export function DocumentScreen({ params, subject }: ScreenProps) {
  const docRef = params.ref ?? "";
  if (!subject) return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">Checking who you are...</p></section>;
  return <DocumentFor key={subject + "\u0000" + docRef} docRef={docRef} subject={subject} />;
}

// /documents/<path> (the address before opaque ids: a bookmark, a link in an old message). The path is resolved through
// the owner-scoped state read and the address is REPLACED by /documents/d/<id>, so no history entry keeps the path.
// A path that is not the person's own (or not there) is replaced by the id form of "nothing", which shows the same one
// sentence as a foreign id. A failed read (no network) keeps what is in the address and offers a retry.
export function LegacyDocument({ params, subject }: ScreenProps) {
  const path = params.id ?? "";
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!subject) return;
    let on = true;
    setFailed(false);
    readState(path).then(
      (st) => { if (on) replaceUrl(st.listed && st.id ? docHref(st.id) : DOC_PREFIX + "none"); },
      (e) => { if (!on) return; if (problem(e, "") === NOT_FOUND) replaceUrl(DOC_PREFIX + "none"); else setFailed(true); },
    );
    return () => { on = false; };
  }, [path, subject, n]);
  if (failed) {
    return (
      <section className="screen doc" data-testid="document">
        <h1>Document</h1>
        <p className="meta" data-testid="doc-failed">Could not open this document. <button type="button" onClick={() => setN(n + 1)}>Try again</button></p>
        <Link to="/documents">Back to Documents</Link>
      </section>
    );
  }
  return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">{subject ? "Opening..." : "Checking who you are..."}</p></section>;
}

function DocumentFor({ docRef, subject }: { docRef: string; subject: string }) {
  const [view, setView] = useState<View>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  const live = useRef(true);

  const read = useCallback(async () => {
    setView({ state: "loading" });
    try {
      const st = await resolveRef(docRef);
      if (!live.current) return;
      // the id is the listing row's, so a resolved document is listed; a row that says otherwise is gone, like a missing one
      if (!st.listed) { setView({ state: "gone" }); return; }
      if (st.trashed) {
        // the trash date is the listing's (the trash move sets it); the text is NOT read: it does not open
        let title = "", goes = goesText("");
        try {
          const row = (await readListing()).docs.find((d) => d.path === st.path);
          if (row) { title = row.title; goes = goesText(row.updated); }
        } catch { /* the generic sentence stands */ }
        if (live.current) setView({ state: "trashed", path: st.path, title, goes });
        return;
      }
      // an active document goes to the writing surface, which reads the file itself (with its hash) and makes the
      // document the Last document; an archived one is shown read-only here
      if (!st.archived) { setView({ state: "writing", path: st.path }); return; }
      const f = await readFile(st.path);
      if (!live.current) return;
      setView({ state: "open", path: st.path, title: f.title, body: f.body, archived: st.archived });
      const ls = getLastDocument();
      if (ls?.id !== st.path || ls.ref !== docRef) setLastDocument({ id: st.path, title: f.title, ref: docRef });
    } catch (e) {
      if (live.current) setView(problem(e, "") === NOT_FOUND ? { state: "gone" } : { state: "failed" });
    }
  }, [docRef]);
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [read]);

  const act = (from: string, f: () => Promise<string>, done: string, fallback: string) => {
    setBusy(true); setErr("");
    f().then((to) => {
      if (!live.current) return; // the person changed meanwhile (this screen is keyed by the subject): show and move nothing
      const lk = getLockedDocument(), ls = getLastDocument();
      if (lk?.id === from) setLockedDocument({ id: to, title: lk.title, ref: docRef });
      if (ls?.id === from) setLastDocument({ id: to, title: ls.title, ref: docRef });
      toast({ message: done });
      // the document keeps its id through a restore or an unarchive: the address does not change, the screen reads again
      setBusy(false);
      void read();
    }, (e) => { if (live.current) { setErr(problem(e, fallback)); setBusy(false); } });
  };

  const back = <Link to="/documents" className="btn" data-testid="doc-close">Close</Link>;
  if (view.state === "loading") return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">Loading...</p></section>;
  if (view.state === "writing") return <DocEditor key={view.path} path={view.path} docRef={docRef} subject={subject} />;
  if (view.state === "gone") {
    return (
      <section className="screen doc" data-testid="document">
        <h1>Document</h1>
        <p data-testid="doc-gone">{NOT_FOUND}</p>
        <Link to="/documents">Back to Documents</Link>
      </section>
    );
  }
  if (view.state === "failed") {
    return (
      <section className="screen doc" data-testid="document">
        <h1>Document</h1>
        <p className="meta" data-testid="doc-failed">Could not open this document. <button type="button" onClick={() => void read()}>Try again</button></p>
        <Link to="/documents">Back to Documents</Link>
      </section>
    );
  }
  if (view.state === "trashed") {
    return (
      <section className="screen doc" data-testid="document" data-doc-state="trashed">
        <div className="doc-head"><h1>{view.title || "Document"}</h1>{back}</div>
        <div className="card doc-note" data-testid="doc-trashed">
          <p><strong>This document is in the trash.</strong> It opens only after you restore it; it {view.goes}.</p>
          {err && <p className="docs-err" role="alert">{err}</p>}
          <div><button type="button" className="btn pri" disabled={busy} data-testid="doc-restore"
            onClick={() => act(view.path, () => restore(view.path), "Restored to Active.", "The document could not be restored.")}>Restore</button></div>
        </div>
      </section>
    );
  }
  return (
    <section className="screen doc" data-testid="document" data-doc-state={view.archived ? "archived" : "active"}>
      <div className="doc-head"><h1>{view.title}</h1>{back}</div>
      {view.archived && (
        <div className="card doc-note" data-testid="doc-archived">
          <p><strong>Archived: read-only.</strong> Unarchive it to work on it again; it goes back to its folder.</p>
          {err && <p className="docs-err" role="alert">{err}</p>}
          <div><button type="button" className="btn pri" disabled={busy} data-testid="doc-unarchive"
            onClick={() => act(view.path, () => unarchive(view.path), "Unarchived.", "The document could not be unarchived.")}>Unarchive</button></div>
        </div>
      )}
      <article className="card doc-body" data-testid="doc-body" aria-label="Document text">{view.body || "(this document is empty)"}</article>
    </section>
  );
}
