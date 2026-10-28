// The documents panel (D12): the user documents, listed from the body-less listing record through
// the contract's documents call (title, path, updated, outbound links), by folder; the trash and the
// archive are their own groups. Management (D12 parity item 7): create, new folder, delete folder,
// move, trash and restore, archive. At rest it shows its summary only.
import { useEffect, useMemo, useState } from "react";
import { C, D, get, post, api } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Listing {
  title: string;
  path: string;
  updated: string;
  outbound_links: unknown[];
}

const groupOf = (p: string) => p.startsWith("documents/.trash/") ? "trash" : p.startsWith("documents/.archive/") ? "archive" : "documents";

export function DocumentsPanel(_p: PanelProps) {
  const rev = useWorkspace((s) => s.documentRev);
  const [docs, setDocs] = useState<Listing[]>([]);
  const [folders, setFolders] = useState<string[]>([""]);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    Promise.all([get(`${C}/documents?limit=500`), get(`${D}/folders`)]).then(([d, f]) => {
      if (!live) return;
      setDocs(d.documents);
      setFolders(f.folders);
    }).catch((e) => live && setMsg(String((e as Error).message)));
    const t = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tick, rev]);

  const leaves = useMemo<Leaf[]>(() => [
    ...folders.map((f) => ({ key: `folder:${f}`, label: <span data-folder={f}>{f || "(top folder)"}</span>, badges: ["folder"] })),
    ...docs.map((d) => ({
      key: d.path,
      label: <span data-doc={d.path}>{d.title}</span>,
      badges: groupOf(d.path) === "documents" ? [] : [groupOf(d.path)],
      detail: <span className="ws-muted">{d.path} - {d.outbound_links.length} links - {new Date(d.updated).toLocaleString()}</span>,
    })),
  ], [docs, folders]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg(ok);
      refresh();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };

  const actions = (l: Leaf) => {
    if (l.key.startsWith("folder:")) return <FolderActions folder={l.key.slice(7)} run={run} />;
    const g = groupOf(l.key);
    return (
      <>
        <button type="button" data-action="open" onClick={() => setState({ documentPath: l.key })}>Open</button>
        {g === "documents" && (
          <>
            <select aria-label="move to folder" defaultValue="" onChange={(e) => e.target.value !== "" && run(() => post(`${D}/move`, { from: l.key, to_folder: e.target.value === "/" ? "" : e.target.value }), "moved")}>
              <option value="">move to ...</option>
              {folders.map((f) => <option key={f || "/"} value={f || "/"}>{f || "(top)"}</option>)}
            </select>
            <button type="button" data-action="trash" onClick={() => run(() => post(`${D}/trash`, { path: l.key }), "in the trash")}>Trash</button>
            <button type="button" data-action="archive" onClick={() => run(() => post(`${D}/archive`, { path: l.key }), "archived (and its refinery)")}>Archive</button>
          </>
        )}
        {g !== "documents" && <button type="button" data-action="restore" onClick={() => run(() => post(`${D}/restore`, { path: l.key }), "restored")}>Restore</button>}
      </>
    );
  };

  return (
    <div className="ws-side ws-documents">
      <Disclosure
        testId="documents-disclosure"
        summary={<span>{docs.filter((d) => groupOf(d.path) === "documents").length} documents in {folders.length} folders</span>}
        leaves={leaves}
        actions={actions}
        empty="no user documents yet"
      />
      {msg && <p className="ws-muted" data-testid="documents-msg">{msg}</p>}
    </div>
  );
}

// A folder leaf's actions: a new document or folder inside it, or delete it (its documents go to
// the trash, recoverable).
function FolderActions(props: { folder: string; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  const inside = (n: string) => (props.folder ? `${props.folder}/${n}` : n);
  return (
    <>
      <form className="ws-inline-form" onSubmit={(e) => {
        e.preventDefault();
        props.run(async () => {
          const r = await post(D, { title, folder: props.folder });
          setTitle("");
          setState({ documentPath: r.path });
        }, "created");
      }}>
        <input placeholder="new document title" value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="new-doc-title" />
        <button type="submit" data-action="create-document">New document here</button>
      </form>
      <form className="ws-inline-form" onSubmit={(e) => {
        e.preventDefault();
        props.run(() => post(`${D}/folders`, { path: inside(name) }), "folder created");
        setName("");
      }}>
        <input placeholder="new folder" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit" data-action="create-folder">New folder</button>
      </form>
      {props.folder && (
        <button type="button" data-action="delete-folder" onClick={() => props.run(() => api("DELETE", `${D}/folders`, { path: props.folder }), "folder deleted; its documents are in the trash")}>
          Delete folder
        </button>
      )}
    </>
  );
}

registerPanel({ id: "documents", version: 1, title: "Documents", kind: "side", component: DocumentsPanel, position: "left", defaultOpen: true });
registerNav({ id: "documents", version: 1, label: "Documents", order: 10, panel: "documents" });
