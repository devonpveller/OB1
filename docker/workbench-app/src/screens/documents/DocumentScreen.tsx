// The document screen's frame (/documents/:id), as far as rwr-docs-list needs it: a title from the Documents list
// always lands here and opens the document. rwr-doc-editor replaces the body with the writing surface (and its
// Lock / Close / tab strip); until then the text is shown read-only for every document.
//   - active: the text, and Close (back to Documents). Opening it makes it the Last document (the account key).
//   - archived: the text, READ-ONLY by design (no input, no editable region), with an Unarchive button.
//   - trashed: it does not open; it says when it goes by itself and offers Restore.
//   - missing or someone else's: the same one sentence (docs-data NOT_FOUND), never the server's details.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenProps } from "../../routes";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { navigate } from "../../lib/router";
import { getLastDocument, getLockedDocument, setLastDocument, setLockedDocument } from "../../lib/state";
import { docHref, goesText, NOT_FOUND, problem, readFile, readListing, readState, restore, unarchive } from "./docs-data";

type View =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "failed" }
  | { state: "trashed"; path: string; title: string; goes: string }
  | { state: "open"; path: string; title: string; body: string; archived: boolean };

export function DocumentScreen({ params, subject }: ScreenProps) {
  const path = params.id ?? "";
  if (!subject) return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">Checking who you are...</p></section>;
  return <DocumentFor key={subject + "\u0000" + path} path={path} />;
}

function DocumentFor({ path }: { path: string }) {
  const [view, setView] = useState<View>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  const live = useRef(true);

  const read = useCallback(async () => {
    setView({ state: "loading" });
    try {
      const st = await readState(path);
      if (!live.current) return;
      // a path in the person's own directory with no listing row (deleted forever, or never there) answers 200
      // listed:false, not 404 (repo.ts documentState): it is gone, exactly like a missing or someone else's one.
      // (A file whose listing write failed is also unlisted until the reconcile pass repairs it: gone till then.)
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
      const f = await readFile(st.path);
      if (!live.current) return;
      setView({ state: "open", path: st.path, title: f.title, body: f.body, archived: st.archived });
      // an opened document is the Last document (identifier only; the title is shown from memory, never stored)
      if (getLastDocument()?.id !== st.path) setLastDocument({ id: st.path, title: f.title });
    } catch (e) {
      if (live.current) setView(problem(e, "") === NOT_FOUND ? { state: "gone" } : { state: "failed" });
    }
  }, [path]);
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; }; }, [read]);

  const act = (f: () => Promise<string>, done: string, fallback: string) => {
    setBusy(true); setErr("");
    f().then((to) => {
      if (!live.current) return; // the person changed meanwhile (this screen is keyed by the subject): show and move nothing
      const lk = getLockedDocument(), ls = getLastDocument();
      if (lk?.id === path) setLockedDocument({ id: to, title: lk.title });
      if (ls?.id === path) setLastDocument({ id: to, title: ls.title });
      toast({ message: done });
      navigate(docHref(to));
    }, (e) => { if (live.current) { setErr(problem(e, fallback)); setBusy(false); } });
  };

  const back = <Link to="/documents" className="btn" data-testid="doc-close">Close</Link>;
  if (view.state === "loading") return <section className="screen doc" data-testid="document"><h1>Document</h1><p className="meta" role="status">Loading...</p></section>;
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
            onClick={() => act(() => restore(view.path), "Restored to Active.", "The document could not be restored.")}>Restore</button></div>
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
            onClick={() => act(() => unarchive(view.path), "Unarchived.", "The document could not be unarchived.")}>Unarchive</button></div>
        </div>
      )}
      {!view.archived && <p className="meta" data-testid="doc-soon">The writing surface is coming next in phase 1; the text is shown read-only until then.</p>}
      <article className="card doc-body" data-testid="doc-body" aria-label="Document text">{view.body || "(this document is empty)"}</article>
    </section>
  );
}
