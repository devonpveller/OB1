// The universal "+" (operator 2026-09-25 19:59, 20:09): a user-added source joins an EXISTING idea
// refinery, which the user picks; the "+" never creates one. With no refinery the path is a user
// document: create one, paste the source there, then open that document's refinery.
import { useState } from "react";
import { C, D, get, post } from "../lib/api";
import { setState } from "../lib/store";

interface Refinery {
  id: string;
  title: string;
  status: string;
}

export function UniversalPlus() {
  const [open, setOpen] = useState(false);
  const [refineries, setRefineries] = useState<Refinery[] | null>(null);
  const [rid, setRid] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const toggle = async () => {
    setOpen(!open);
    setMsg("");
    if (!open) {
      const r = await get(`${C}/ideas?limit=200`).catch(() => ({ ideas: [] }));
      setRefineries(r.ideas.filter((i: Refinery) => i.status !== "archived"));
    }
  };
  const add = async () => {
    try {
      await post(`${D}/user-sources`, { refinery_id: rid, title, content, url: url || undefined });
      setMsg("held in the refinery");
      setTitle("");
      setContent("");
      setUrl("");
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  const newDoc = async () => {
    const r = await post(`${D}`, { title: "New document" });
    setState({ documentPath: r.path });
    setOpen(false);
  };
  return (
    <span className="ws-plus-wrap">
      <button type="button" className="ws-tb-btn" data-testid="plus" aria-expanded={open} onClick={toggle}>+</button>
      {open && (
        <div className="ws-popover ws-plus" role="dialog" aria-label="add a source">
          {refineries && refineries.length === 0 && (
            <div data-testid="plus-none">
              <p>No idea refinery yet. Create a user document, paste the source there, then open that document's refinery.</p>
              <button type="button" onClick={newDoc}>New document</button>
            </div>
          )}
          {refineries && refineries.length > 0 && (
            <form onSubmit={(e) => { e.preventDefault(); add(); }}>
              <label>
                Which refinery does it join?
                <select value={rid} onChange={(e) => setRid(e.target.value)} required data-testid="plus-refinery">
                  <option value="">choose an existing refinery</option>
                  {refineries.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
              </label>
              <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
              <input placeholder="link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
              <textarea placeholder="paste the source" value={content} onChange={(e) => setContent(e.target.value)} required />
              <button type="submit" disabled={!rid}>Hold it in the refinery</button>
            </form>
          )}
          {msg && <p className="ws-muted" data-testid="plus-msg">{msg}</p>}
        </div>
      )}
    </span>
  );
}
