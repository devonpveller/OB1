// Screen 2, Documents (rwr-docs-list): the signed-in person's folders and documents. Active / Archived / Trash
// tabs; Open, Archive, Unarchive, Move to trash, Restore, Delete forever (typed DELETE, with what is lost and
// what stays), Empty the trash (typed), and an Undo toast after Archive or Move to trash.
//
// A title is a plain link to /documents/<path>: there is no dock or panel state that could leave it dead, so it
// opens after a close, a reload or a deep link alike. A trashed document has no link (it opens only after it is
// restored) and says when the nightly removes it (30 days, Q9).
//
// Everything is read and written through docs-data.ts (lib/api.ts); nothing is kept in the browser. The page is
// keyed by the signed-in subject, so another person on this page never sees the previous person's rows.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ScreenProps } from "../../routes";
import { Link } from "../../shell/Link";
import { TypedConfirm } from "../../shell/TypedConfirm";
import { useToast } from "../../shell/Toast";
import { navigate } from "../../lib/router";
import { getLastDocument, getLockedDocument, setLastDocument, setLockedDocument, stateEpoch } from "../../lib/state";
import {
  ago, archive, createDocument, createFolder, deleteForever, docHref, emptyTrash, foldersFor, goesText, linkedText, LIST_LIMIT,
  problem, readListing, restore, trash, unarchive, type DocRow, type Listing, type Tab,
} from "./docs-data";

export const DELETE_WORD = "DELETE";
const TABS: [Tab, string][] = [["active", "Active"], ["archived", "Archived"], ["trash", "Trash"]];
const FOOT: Record<Tab, string> = {
  active: "Archive and Move to trash can both be undone.",
  archived: "Archived documents open read-only, with an Unarchive button.",
  trash: "Documents in the trash open only after you restore them. Each one goes by itself 30 days after it was trashed.",
};
const folderLabel = (f: string) => (f === "" ? "Unfiled" : f);

// The shell's Locked / Last document slot follows a document that moved, so its title never points at a path
// that is gone. A document moved to the trash (or deleted) is "no document" there, as the account keys say.
function retarget(from: string, to: string | null, title: string) {
  const lk = getLockedDocument(), ls = getLastDocument();
  if (lk?.id === from) setLockedDocument(to ? { id: to, title: lk.title || title } : null);
  if (ls?.id === from) setLastDocument(to ? { id: to, title: ls.title || title } : null);
}
// what the slots pointed at before a move, so Undo can put them back
function slotsBefore(path: string) {
  const lk = getLockedDocument(), ls = getLastDocument();
  return { locked: lk?.id === path ? lk : null, last: ls?.id === path ? ls : null };
}

type Load = { state: "loading" } | { state: "failed" } | { state: "ok"; data: Listing };
type Ask = { kind: "one"; doc: DocRow } | { kind: "all"; n: number };

export function Documents({ subject, whoAnswered }: ScreenProps) {
  if (!subject) {
    return (
      <section className="screen docs" data-testid="documents">
        <h1>Documents</h1>
        {whoAnswered
          ? <p className="meta" data-testid="docs-who-failed">Could not tell who you are, so nothing is shown.</p>
          : <p className="meta" role="status">Checking who you are...</p>}
      </section>
    );
  }
  return <DocumentsFor key={subject} />;
}

function DocumentsFor() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tab, setTab] = useState<Tab>("active");
  const [folder, setFolder] = useState<string | null>(null); // null = All documents
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [making, setMaking] = useState<"" | "folder" | "doc">("");
  const shout = useToast();
  const live = useRef(true);
  const seq = useRef(0);
  // a toast only while this person's list is mounted: an answer that lands after the person changed (this
  // component is keyed by the subject, so it has unmounted) shows nothing to the next person
  const toast: typeof shout = useCallback((t) => { if (live.current) shout(t); }, [shout]);

  const reload = useCallback(() => {
    const my = ++seq.current;
    readListing().then((data) => { if (live.current && my === seq.current) setLoad({ state: "ok", data }); },
      () => { if (live.current && my === seq.current) setLoad({ state: "failed" }); });
  }, []);
  useEffect(() => { live.current = true; reload(); return () => { live.current = false; }; }, [reload]);

  // one action at a time; the list is read again after it, whatever the answer
  const run = useCallback(async (f: () => Promise<void>, fallback: string) => {
    setBusy(true); setErr("");
    try { await f(); } catch (e) { if (live.current) setErr(problem(e, fallback)); }
    finally { if (live.current) { setBusy(false); reload(); } }
  }, [reload]);

  const doArchive = (d: DocRow) => run(async () => {
    const before = slotsBefore(d.path);
    const to = await archive(d.path);
    retarget(d.path, to, d.title);
    const epoch = stateEpoch();
    toast({
      message: `Archived "${d.title || "(untitled)"}".`,
      onUndo: () => { if (stateEpoch() !== epoch) return; void run(async () => { const back = await unarchive(to); undoSlots(back, before); }, "The archive could not be undone."); },
    });
  }, "The document could not be archived.");
  const doTrash = (d: DocRow) => run(async () => {
    const before = slotsBefore(d.path);
    const to = await trash(d.path);
    retarget(d.path, null, d.title);
    const epoch = stateEpoch();
    toast({
      message: `Moved "${d.title || "(untitled)"}" to the trash. It goes by itself in 30 days.`,
      onUndo: () => { if (stateEpoch() !== epoch) return; void run(async () => { const back = await restore(to); undoSlots(back, before); }, "The move to the trash could not be undone."); },
    });
  }, "The document could not be moved to the trash.");
  const doUnarchive = (d: DocRow) => run(async () => {
    const to = await unarchive(d.path);
    retarget(d.path, to, d.title);
    toast({ message: `Unarchived "${d.title || "(untitled)"}".` });
  }, "The document could not be unarchived.");
  const doRestore = (d: DocRow) => run(async () => {
    await restore(d.path);
    toast({ message: `Restored "${d.title || "(untitled)"}" to Active.` });
  }, "The document could not be restored.");

  const confirmDelete = () => {
    const a = ask;
    if (!a) return;
    setAsk(null);
    void run(async () => {
      if (a.kind === "one") {
        await deleteForever(a.doc.path);
        retarget(a.doc.path, null, a.doc.title);
        toast({ message: "Deleted forever: 1 document. The trail keeps one line for it." });
      } else {
        const r = await emptyTrash();
        const n = typeof r.removed === "number" ? r.removed : 0;
        toast({ message: `Deleted forever: ${n} ${n === 1 ? "document" : "documents"}. The trail keeps one line for each.` + (r.failed ? ` ${r.failed} could not be removed.` : "") });
      }
    }, "Nothing was deleted: the request did not go through.");
  };

  const data = load.state === "ok" ? load.data : null;
  const inTab = data ? data.docs.filter((d) => d.tab === tab) : [];
  const shown = folder === null ? inTab : inTab.filter((d) => d.folder === folder);
  const fols = data ? foldersFor(data, tab) : [];
  const trashCount = data ? data.docs.filter((d) => d.tab === "trash").length : 0;

  return (
    <section className="screen docs" data-testid="documents">
      <div className="docs-head">
        <h1>Documents</h1>
        <span className="meta">Click a title to open it. Closing a document never loses it: it stays here.</span>
        <div className="docs-make">
          <button type="button" className="btn" data-testid="new-folder" aria-expanded={making === "folder"} onClick={() => setMaking(making === "folder" ? "" : "folder")}>+ Folder</button>
          <button type="button" className="btn pri" data-testid="new-doc" aria-expanded={making === "doc"} onClick={() => setMaking(making === "doc" ? "" : "doc")}>+ New document</button>
        </div>
      </div>
      {making === "folder" && (
        <NewFolder onCancel={() => setMaking("")} busy={busy} onMake={(name) => run(async () => {
          const r = await createFolder(name);
          const root = data?.root ?? "";
          const rel = root && r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : name;
          setMaking(""); setFolder(rel); setTab("active");
          toast({ message: r.created ? `Made the folder "${rel}".` : `The folder "${rel}" is already there.` });
        }, "The folder could not be made.")} />
      )}
      {making === "doc" && (
        <NewDocument folder={folder ?? ""} busy={busy} onCancel={() => setMaking("")}
          onMake={(title, f) => run(async () => { const path = await createDocument(title, f); setMaking(""); navigate(docHref(path)); }, "The document could not be made.")} />
      )}
      {err && <p className="docs-err" role="alert" data-testid="docs-error">{err}</p>}

      {load.state === "loading" && <p className="meta" role="status" data-testid="docs-loading">Loading...</p>}
      {load.state === "failed" && <p className="meta" data-testid="docs-failed">Could not load your documents. <button type="button" onClick={reload}>Try again</button></p>}
      {data && (
        <div className="docs-body">
          <nav className="card docs-folders" aria-label="Folders" data-testid="folders">
            <div className="sec">Folders</div>
            <button type="button" className={"folder" + (folder === null ? " fon" : "")} aria-pressed={folder === null} onClick={() => setFolder(null)} data-testid="folder-all">
              <span>All documents</span><span className="count">{inTab.length}</span>
            </button>
            {fols.map((f) => (
              <button type="button" key={f.folder} className={"folder" + (folder === f.folder ? " fon" : "")} aria-pressed={folder === f.folder}
                onClick={() => setFolder(f.folder)} data-testid="folder">
                <span className="folder-name">{folderLabel(f.folder)}</span><span className="count">{f.count}</span>
              </button>
            ))}
          </nav>
          <div className="card docs-table">
            <div className="docs-tabs" role="group" aria-label="Show">
              {TABS.map(([t, label]) => (
                <button type="button" key={t} className={"tab" + (tab === t ? " tabon" : "")} aria-pressed={tab === t} data-testid={"tab-" + t}
                  onClick={() => { setTab(t); setAsk(null); }}>{label}</button>
              ))}
            </div>
            {ask && <DeleteAsk ask={ask} onConfirm={confirmDelete} onCancel={() => setAsk(null)} />}
            {shown.length === 0
              ? <p className="empty docs-empty" data-testid="docs-empty">{emptyText(tab, folder, data.docs.length === 0)}</p>
              : (
                <div className="docs-scroll">
                  <table>
                    <thead><tr><th scope="col">Title</th><th scope="col">Folder</th><th scope="col">{tab === "trash" ? "Trashed" : "Edited"}</th><th scope="col">Linked to</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {shown.map((d) => (
                        <tr key={d.path} data-testid="doc-row" data-tab={d.tab}>
                          <td>{d.tab === "trash"
                            ? <span className="ttl-off" data-testid="doc-title">{d.title || "(untitled)"}</span>
                            : <Link to={docHref(d.path)} className="ttl" data-testid="doc-title">{d.title || "(untitled)"}</Link>}</td>
                          <td className="meta">{folderLabel(d.folder)}</td>
                          <td className="meta" data-testid="doc-when">{d.tab === "trash" ? [ago(d.updated), goesText(d.updated)].filter(Boolean).join(" · ") : ago(d.updated)}</td>
                          <td className="meta">{linkedText(d.links)}</td>
                          <td className="docs-acts">
                            {d.tab !== "trash" && <Link to={docHref(d.path)} className="btn sm" data-testid="act-open">Open<span className="sr-only"> {d.title}</span></Link>}
                            {d.tab === "active" && <>
                              <button type="button" className="btn sm" disabled={busy} onClick={() => doArchive(d)} data-testid="act-archive">Archive<span className="sr-only"> {d.title}</span></button>
                              <button type="button" className="btn sm" disabled={busy} onClick={() => doTrash(d)} data-testid="act-trash">Move to trash<span className="sr-only"> {d.title}</span></button>
                            </>}
                            {d.tab === "archived" && <button type="button" className="btn sm" disabled={busy} onClick={() => doUnarchive(d)} data-testid="act-unarchive">Unarchive<span className="sr-only"> {d.title}</span></button>}
                            {d.tab === "trash" && <>
                              <button type="button" className="btn sm" disabled={busy} onClick={() => doRestore(d)} data-testid="act-restore">Restore<span className="sr-only"> {d.title}</span></button>
                              <button type="button" className="btn sm danger-line" disabled={busy} onClick={() => setAsk({ kind: "one", doc: d })} data-testid="act-delete">Delete forever...<span className="sr-only"> {d.title}</span></button>
                            </>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <div className="docs-foot">
              <span className="meta">{FOOT[tab]}{data.capped ? ` Showing your newest ${LIST_LIMIT} documents.` : ""}</span>
              {tab === "trash" && trashCount > 0 && (
                <button type="button" className="btn sm danger-line" disabled={busy} onClick={() => setAsk({ kind: "all", n: trashCount })} data-testid="empty-trash">Empty the trash...</button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// Undo of an archive or a trash move: the document is back at `back`; the slots that pointed at it before do again.
function undoSlots(back: string, before: ReturnType<typeof slotsBefore>) {
  if (before.locked) setLockedDocument({ id: back, title: before.locked.title });
  if (before.last) setLastDocument({ id: back, title: before.last.title });
}

function emptyText(tab: Tab, folder: string | null, none: boolean): string {
  if (none) return "You have no documents yet. + New document makes one.";
  const where = folder === null ? "" : ` in ${folderLabel(folder)}`;
  return tab === "active" ? `No active documents${where}.` : tab === "archived" ? `No archived documents${where}.` : `The trash is empty${where}.`;
}

// Delete forever (one) and Empty the trash (all): what goes and what stays, then the typed word.
function DeleteAsk({ ask, onConfirm, onCancel }: { ask: Ask; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const one = ask.kind === "one";
  const n = one ? 1 : ask.n;
  const q = one ? `Delete "${ask.doc.title || "(untitled)"}" forever?` : `Empty the trash: delete ${n} ${n === 1 ? "document" : "documents"} forever?`;
  return (
    <section className="docs-warn" aria-labelledby={id} data-testid="delete-ask">
      <h2 id={id}>{q}</h2>
      <p>This cannot be undone. Check what goes and what stays first.</p>
      <dl className="lostbox" data-testid="lost-stays">
        <dt>Lost</dt>
        <dd data-testid="lost">{one ? "the document's text and every saved version of it, and its links to sources and ideas." : "their text and every saved version of them, and their links to sources and ideas."}</dd>
        <dt>Stays</dt>
        <dd data-testid="stays">{`the sources and claims ${one ? "it" : "they"} cited stay in the Library; one line per document stays in Removals and trail saying it was deleted (never its text).`}</dd>
      </dl>
      <TypedConfirm word={DELETE_WORD} prompt={one ? "Type the word to delete this document forever." : "Type the word to empty your trash. Only your own trash is emptied."}
        confirmLabel={one ? "Delete forever" : `Delete ${n} forever`} onConfirm={onConfirm} onCancel={onCancel} />
    </section>
  );
}

function NewFolder({ onMake, onCancel, busy }: { onMake: (name: string) => void; onCancel: () => void; busy: boolean }) {
  const [name, setName] = useState("");
  const id = useId();
  const ok = name.trim() !== "";
  return (
    <form className="card docs-form" data-testid="folder-form" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onMake(name.trim()); }}>
      <label htmlFor={id}>Folder name</label>
      <input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-testid="folder-name" autoFocus />
      <div className="typed-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={!ok || busy} data-testid="folder-ok">Make the folder</button>
      </div>
    </form>
  );
}

// The new document goes into the folder selected on the left (All documents = Unfiled): the folder list is the
// one place a folder is chosen (no second list control here - the picker owns list UI, rwr-picker-r2's guard).
function NewDocument({ folder, onMake, onCancel, busy }:
  { folder: string; onMake: (title: string, folder: string) => void; onCancel: () => void; busy: boolean }) {
  const [title, setTitle] = useState("");
  const id = useId();
  const ok = title.trim() !== "";
  return (
    <form className="card docs-form" data-testid="doc-form" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onMake(title.trim(), folder); }}>
      <label htmlFor={id + "t"}>Title</label>
      <input id={id + "t"} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" data-testid="doc-name" autoFocus />
      <p className="meta" data-testid="doc-folder">In the folder: {folderLabel(folder)}. Pick another folder on the left first to put it there.</p>
      <div className="typed-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={!ok || busy} data-testid="doc-ok">Make the document</button>
      </div>
    </form>
  );
}
