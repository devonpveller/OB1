// The writing surface (research-workbench P2b). A user document opens RENDERED, read-only, from its
// file (D12, operator 15:51 - this panel renders it; no page route, no wiki render module, no
// contract page call), and the edit button swaps the view for the editor in place; leaving the
// editor saves with a commit and the rendered view refreshes. Opening runs the diff-id check (ids and
// revisions only) and fetches no reference text until one is opened.
//
// From an open document, without leaving it (D1): the references panel, queue new research, open a
// gap session, the room, search what is already collected, and the hub context - each opens a panel
// beside the document, which stays open.
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { api, ApiError, C, D, get, post, q } from "../../lib/api";
import { getState, setState, useWorkspace } from "../../lib/store";
import { renderDocument, sectionOf } from "../../lib/render";
import { createEditor, insertAtCursor, markStale } from "../../editor";
import type { ProtectedSpan } from "../../editor/protected";
import { openPanel } from "../../shell/dock";
import { registerPanel } from "../../shell/registry";
import type { PanelProps } from "../../shell/registry";
import { Popover, type PopoverState, previewOf } from "./Popover";

export const AUTOSAVE_MS = 1500;

interface DocState {
  path: string;
  listed: boolean;
  trashed: boolean;
  archived: boolean;
  carries_idea: boolean;
  refinery: { id: string; status: string; archived: boolean } | null;
  tags: string[];
}

export function DocumentPanel(_p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const stale = useWorkspace((s) => s.stale);
  const [content, setContent] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [dstate, setDstate] = useState<DocState | null>(null);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const [listingWarned, setListingWarned] = useState(false);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [tool, setTool] = useState<"research" | "gap" | "source" | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ text: string; hash: string | null }>({ text: "", hash: null });

  const load = useCallback(async (p: string) => {
    const [f, st] = await Promise.all([get(`${D}/file?path=${q(p)}`), get(`${D}/state?path=${q(p)}`)]);
    setContent(f.content);
    setHash(f.hash);
    latest.current = { text: f.content, hash: f.hash };
    setDstate(st);
    // the diff-id check: which pins are out of date - ids and revisions, never text
    const dc = await post(`${C}/diff-check`, { holder: { kind: "user_document", ref: f.path } }).catch(() => ({ results: [] }));
    setState({ stale: new Set(dc.results.filter((r: any) => r.out_of_date).map((r: any) => r.reference_id)) });
  }, []);

  useEffect(() => {
    setEditing(false);
    setContent(null);
    if (path) load(path).catch((e) => setStatus(String((e as Error).message)));
  }, [path, rev, load]);

  const save = useCallback(async (commit: boolean) => {
    if (!path) return;
    const { text, hash: h } = latest.current;
    setStatus("saving");
    try {
      const r = await api("PUT", `${D}/file?path=${q(path)}${commit ? "&commit=1" : ""}`, { content: text, if_match: h });
      latest.current.hash = r.data.hash;
      setHash(r.data.hash);
      setUnsaved(false);
      if (r.status === 207 && !listingWarned) {
        setListingWarned(true);
        setStatus("saved - the listing could not be updated; it is repaired when the workspace reconnects");
      } else setStatus("saved");
    } catch (e) {
      setStatus(e instanceof ApiError && e.status === 409 ? "conflict: the document changed elsewhere - reload it" : `not saved: ${(e as Error).message}`);
    }
  }, [path, listingWarned]);

  const selectSpan = useCallback((s: ProtectedSpan, pos: number) => {
    setState({ reference: { reference_id: s.reference_id, source_id: "", chunk_idx: null, from: { path: path ?? "", pos } } });
    openPanel("reference");
  }, [path]);

  const hoverSpan = useCallback((s: ProtectedSpan, dom: HTMLElement) => {
    setPopover({ anchor: dom.getBoundingClientRect(), target: { kind: "reference", id: s.reference_id }, loading: true });
  }, []);

  // the editor, mounted in place of the rendered view
  useEffect(() => {
    if (!editing || !hostRef.current || content === null || !path) return;
    const view = createEditor(hostRef.current, {
      doc: latest.current.text,
      onChange: (text) => {
        latest.current.text = text;
        setUnsaved(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => save(false), AUTOSAVE_MS);
      },
      candidates: async (qq) => (await get(`${D}/candidates?q=${q(qq)}&path=${q(path)}`)).candidates,
      onSelectSpan: selectSpan,
      onHoverSpan: hoverSpan,
      onLinkHover: (t, dom) => setPopover({ anchor: dom.getBoundingClientRect(), target: t, loading: true }),
      onLinkOpen: (t) => t.kind === "page" ? window.open(`/${t.id}`, "_blank") : openSource(t.id),
      onMirror: (sel) => {
        setState({ mirror: { query: sel, at: Date.now() } });
        openPanel("search");
      },
    });
    markStale(view, getState().stale);
    viewRef.current = view;
    setState({
      editor: {
        path,
        insertAtCursor: (t) => insertAtCursor(view, t),
        selection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
        focusAt: (pos) => {
          view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
          view.focus();
        },
        replaceText: (oldText, newText) => {
          const at = view.state.doc.toString().indexOf(oldText);
          if (at < 0) return false;
          view.dispatch({ changes: { from: at, to: at + oldText.length, insert: newText } });
          return true;
        },
      },
    });
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      view.destroy();
      viewRef.current = null;
      setState({ editor: null });
    };
  }, [editing, path, content === null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewRef.current) markStale(viewRef.current, stale);
  }, [stale]);

  const openSource = (id: string) => {
    setState({ reference: { reference_id: null, source_id: id, chunk_idx: null } });
    openPanel("reference");
  };

  const done = async () => {
    await save(true);
    setEditing(false);
    if (path) await load(path);
  };

  if (!path) return <EmptySurface />;
  if (content === null) return <div className="ws-surface ws-muted">opening {path} ...</div>;
  const rendered = renderDocument(content, path, { stale });
  const canRefinery = !!dstate?.carries_idea || !!dstate?.refinery;
  const onViewClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const chip = el.closest(".ws-chip") as HTMLElement | null;
    if (chip) return selectSpan({ kind: "chip", reference_id: chip.dataset.ref!, from: 0, to: 0, text: "" }, 0);
    const link = el.closest("button.ws-wikilink") as HTMLElement | null;
    if (link?.dataset.kind === "source" || link?.dataset.kind === "report") return openSource(link.dataset.id!);
    if (link?.dataset.kind === "document") return setState({ documentPath: link.dataset.id! });
    const copy = el.closest(".ws-copy-heading");
    if (copy) {
      const h = Number((copy.parentElement as HTMLElement).dataset.heading);
      navigator.clipboard?.writeText(sectionOf(content.slice(rendered.doc.frontmatter.end), h)).catch(() => {});
      setStatus("section copied");
    }
  };
  const onViewOver = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const chip = el.closest(".ws-chip") as HTMLElement | null;
    const link = el.closest(".ws-wikilink") as HTMLElement | null;
    if (chip) setPopover({ anchor: chip.getBoundingClientRect(), target: { kind: "reference", id: chip.dataset.ref! }, loading: true });
    else if (link) setPopover({ anchor: link.getBoundingClientRect(), target: { kind: link.dataset.kind!, id: link.dataset.id ?? link.getAttribute("href")!.slice(1) }, loading: true });
  };

  return (
    <div className="ws-surface" data-document={path} data-mode={editing ? "edit" : "view"}>
      <div className="ws-doc-bar" role="toolbar" aria-label="document">
        <strong className="ws-doc-title">{rendered.doc.title}</strong>
        {(dstate?.tags ?? []).map((t) => <span key={t} className="ws-tag" data-tag={t}>{t}</span>)}
        {editing
          ? <button type="button" data-testid="done" onClick={done}>Done</button>
          : <button type="button" data-testid="edit" onClick={() => setEditing(true)}>Edit</button>}
        <span className="ws-status" data-testid="status">{unsaved ? "unsaved changes" : status}</span>
        <span className="ws-spacer" />
        <button type="button" data-tool="references" onClick={() => openPanel("doc-references")}>References</button>
        <button type="button" data-tool="research" onClick={() => setTool(tool === "research" ? null : "research")}>Queue research</button>
        <button type="button" data-tool="gap" onClick={() => setTool(tool === "gap" ? null : "gap")}>Gap session</button>
        <button type="button" data-tool="room" onClick={() => openPanel("refinery", { focus: "room" })}>Room</button>
        <button type="button" data-tool="search" onClick={() => openPanel("search")}>Search collected</button>
        <button type="button" data-tool="hubs" onClick={() => openPanel("hubs")}>Hubs</button>
        <button type="button" data-tool="plus" disabled={!dstate?.refinery} title={dstate?.refinery ? "hold a source in this document's refinery" : "open this document's refinery first"} onClick={() => setTool(tool === "source" ? null : "source")}>+ source</button>
        <button
          type="button"
          data-tool="refinery"
          disabled={!canRefinery}
          title={canRefinery ? "" : "add an idea to the document to get started"}
          onClick={async () => {
            await post(`${D}/refinery/${dstate?.refinery ? "open" : "start"}`, { path });
            await load(path);
            openPanel("refinery");
          }}
        >
          {dstate?.refinery ? "Open refinery" : "Start refinery"}
        </button>
        <ExportMenu path={path} content={content} />
      </div>
      {tool && <ToolForm kind={tool} path={path} onDone={(m) => { setTool(null); setStatus(m); }} />}
      {editing
        ? <div className="ws-editor-host" ref={hostRef} data-testid="editor" />
        : (
          <article
            className="ws-rendered"
            data-testid="rendered"
            onClick={onViewClick}
            onMouseOver={onViewOver}
            onMouseLeave={() => setPopover(null)}
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        )}
      {popover && <Popover state={popover} onClose={() => setPopover(null)} load={previewOf} />}
      <span hidden data-hash={hash ?? ""} />
    </div>
  );
}

function EmptySurface() {
  const create = async () => {
    const r = await post(D, { title: `Untitled ${new Date().toISOString().slice(0, 16).replace("T", " ")}` });
    setState({ documentPath: r.path });
  };
  return (
    <div className="ws-surface ws-empty-surface">
      <p>No document open.</p>
      <button type="button" data-testid="new-document" onClick={create}>New document</button>
      <button type="button" onClick={() => openPanel("documents")}>Open one</button>
    </div>
  );
}

function ToolForm(props: { kind: "research" | "gap" | "source"; path: string; onDone: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const submit = async () => {
    try {
      if (props.kind === "source") {
        await post(`${D}/user-sources`, { path: props.path, title, content: text, url: url || undefined });
        props.onDone("held in this document's refinery");
      } else {
        const r = await post(`${D}/research`, { path: props.path, query: text, kind: props.kind });
        props.onDone(`${props.kind === "gap" ? "gap session" : "research"} queued (${r.job_id.slice(0, 8)})${r.refinery_id ? " - joined the refinery" : ""}`);
      }
    } catch (e) {
      props.onDone(String((e as Error).message));
    }
  };
  return (
    <form className="ws-toolform" data-testid={`toolform-${props.kind}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {props.kind === "source" && <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} required />}
      {props.kind === "source" && <input placeholder="link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />}
      <textarea
        placeholder={props.kind === "source" ? "paste the source" : props.kind === "gap" ? "the gap to work" : "the question to research"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        required
      />
      <button type="submit">{props.kind === "source" ? "Hold it" : "Queue"}</button>
    </form>
  );
}

const FORMATS = [["md", "MD"], ["pdf", "PDF"], ["txt", "TEXT"], ["docx", "DOCX"]] as const;

function ExportMenu(props: { path: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="ws-export">
      <button type="button" data-tool="export" aria-expanded={open} onClick={() => setOpen(!open)}>Export</button>
      {open && (
        <span className="ws-popover ws-export-menu" role="menu">
          {FORMATS.map(([f, label]) => (
            <a key={f} role="menuitem" data-format={f} href={`/workbench/export?path=${q(props.path)}&format=${f}`} download>{label}</a>
          ))}
          <button type="button" role="menuitem" data-format="copy" onClick={() => navigator.clipboard?.writeText(props.content).catch(() => {})}>Copy page</button>
        </span>
      )}
    </span>
  );
}

registerPanel({ id: "document", version: 1, title: "Document", kind: "surface", component: DocumentPanel });
