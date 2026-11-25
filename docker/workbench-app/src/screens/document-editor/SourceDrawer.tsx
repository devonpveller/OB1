// The side drawer a citation [n] opens (rwr-doc-editor), until the Source screen lands in phase 2: the cited passage
// of the PINNED revision. The reference record pins a revision and the exact words; the drawer shows those words
// first (they are the pinned text), then the pinned passage with its neighbours (read from the source as it is now)
// and says when the source has a newer revision. Not modal: the document stays usable behind it. Esc or Close.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { readCited, type Cited } from "./editor-data";
import { FlagForCleanup } from "../../components/flag/FlagForCleanup";

export type DrawerTarget = { kind: "reference" | "source"; id: string; n: number };
type View = { s: "loading" } | { s: "missing" } | { s: "failed" } | { s: "ready"; c: Cited };

// `docPath` (the open document's vault path) and `subject` (who is signed in) are what "Flag for cleanup" needs: the flag
// records the document it was made from. Without them nothing is offered.
export function SourceDrawer({ target, onClose, docPath, subject }: { target: DrawerTarget; onClose: () => void; docPath?: string; subject?: string | null }) {
  const [view, setView] = useState<View>({ s: "loading" });
  const head = useRef<HTMLHeadingElement>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    setView({ s: "loading" });
    readCited(target.id).then(
      (c) => { if (live) setView({ s: "ready", c }); },
      (e) => { if (live) setView(e instanceof ApiError && e.status === 404 ? { s: "missing" } : { s: "failed" }); },
    );
    return () => { live = false; };
  }, [target.id, tries]);
  useEffect(() => { head.current?.focus(); }, []);

  const label = target.n > 0 ? `Source [${target.n}]` : "Source";
  return (
    <section className="drawer" aria-label={label} data-testid="source-drawer"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="drawer-head">
        <h2 tabIndex={-1} ref={head} data-testid="drawer-title">{view.s === "ready" ? view.c.title : label}</h2>
        <button type="button" className="btn sm" data-testid="drawer-close" onClick={onClose}>Close</button>
      </div>
      {view.s === "loading" && <p className="meta" role="status">Loading the source...</p>}
      {view.s === "missing" && <p data-testid="drawer-missing">This source is not available any more.</p>}
      {view.s === "failed" && <p data-testid="drawer-failed">The source could not be opened. <button type="button" onClick={() => setTries((n) => n + 1)}>Try again</button></p>}
      {view.s === "ready" && (
        <div className="drawer-body" data-testid="drawer-body">
          <p className="meta" data-testid="drawer-pin">
            {target.n > 0 ? `Cited as [${target.n}] · ` : ""}Pinned at revision {view.c.pinned}
            {view.c.current !== null && view.c.current > view.c.pinned ? `. A newer revision (${view.c.current}) exists; this document still cites revision ${view.c.pinned}.` : "."}
          </p>
          {view.c.quote && <blockquote className="drawer-quote" data-testid="drawer-quote">{view.c.quote}</blockquote>}
          {view.c.passage.length > 0 && (
            <>
              <h3 className="sec">The cited section</h3>
              <div data-testid="drawer-passage">
                {view.c.passage.map((p) => (
                  <p key={p.idx} className={p.target ? "drawer-hit" : "meta"} data-target={p.target ? "true" : undefined}>{p.text}</p>
                ))}
              </div>
            </>
          )}
          {docPath && subject && !view.c.held && (
            <div className="drawer-flags" data-testid="drawer-flags">
              {target.kind === "reference" && (
                <FlagForCleanup item={{ kind: "reference", id: view.c.referenceId }} from={{ kind: "document", ref: docPath }}
                  subject={subject} what="this reference" label="Flag this reference" />
              )}
              {view.c.sourceId && (
                <FlagForCleanup item={{ kind: "source", id: view.c.sourceId }} from={{ kind: "document", ref: docPath }}
                  subject={subject} what="this source" label="Flag this source" />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
