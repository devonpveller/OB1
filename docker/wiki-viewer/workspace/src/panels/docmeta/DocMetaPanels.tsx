// Two small side panels of the open document (D12 parity item 7): its PROPERTIES (the frontmatter,
// set one key at a time; every other line kept verbatim) and its HISTORY (the vault's git commits
// of the file, with recover).
import { useEffect, useMemo, useState } from "react";
import { D, get, post, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { parseFrontmatter } from "../../lib/grammar";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

export function PropertiesPanel(_p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => path && get(`${D}/file?path=${q(path)}`).then((f) => setFields(parseFrontmatter(f.content).fields));
  useEffect(() => {
    load();
  }, [path, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = async (k: string, v: string | null) => {
    try {
      await post(`${D}/property`, { path, key: k, value: v });
      setMsg(v === null ? `removed ${k}` : `set ${k}`);
      setState({ documentRev: Date.now() });
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  const leaves = useMemo<Leaf[]>(() => [
    ...Object.entries(fields).map(([k, v]) => ({ key: k, label: <span><strong>{k}</strong>: {v}</span> })),
    { key: "__new", label: <span>add a property</span> },
  ], [fields]);
  if (!path) return <div className="ws-side ws-muted">Open a document to see its properties.</div>;
  return (
    <div className="ws-side ws-properties">
      <Disclosure
        testId="properties-disclosure"
        summary={<span>{Object.keys(fields).length} properties</span>}
        leaves={leaves}
        actions={(l) => l.key === "__new"
          ? (
            <form onSubmit={(e) => { e.preventDefault(); set(key, draft); }}>
              <input placeholder="key (e.g. idea)" value={key} onChange={(e) => setKey(e.target.value)} required data-testid="prop-key" />
              <input placeholder="value" value={draft} onChange={(e) => setDraft(e.target.value)} required data-testid="prop-value" />
              <button type="submit" data-action="set-property">Set</button>
            </form>
          )
          : (
            <form onSubmit={(e) => { e.preventDefault(); set(l.key, draft); }}>
              <input defaultValue={fields[l.key]} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" data-action="set-property">Set</button>
              <button type="button" data-action="remove-property" onClick={() => set(l.key, null)}>Remove</button>
            </form>
          )}
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

export function HistoryPanel(_p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const [commits, setCommits] = useState<{ hash: string; author: string; date: string; message: string }[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (path) get(`${D}/history?path=${q(path)}`).then((r) => setCommits(r.commits)).catch(() => setCommits([]));
  }, [path, rev]);
  if (!path) return <div className="ws-side ws-muted">Open a document to see its history.</div>;
  return (
    <div className="ws-side ws-history">
      <Disclosure
        testId="history-disclosure"
        summary={<span>{commits.length} revisions</span>}
        leaves={commits.map((c) => ({ key: c.hash, label: <span>{new Date(c.date).toLocaleString()} - {c.message}</span>, detail: <span className="ws-muted">{c.author}</span> }))}
        actions={(l) => (
          <button type="button" data-action="recover" onClick={async () => {
            const r = await post(`${D}/recover`, { path, from: l.key });
            setMsg(`recovered from ${l.key.slice(0, 8)}`);
            setState({ documentPath: r.recovered, documentRev: Date.now() });
          }}>Recover this revision</button>
        )}
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "properties", version: 1, title: "Properties", kind: "side", component: PropertiesPanel, position: "right" });
registerNav({ id: "properties", version: 1, label: "Properties", order: 60, panel: "properties" });
registerPanel({ id: "history", version: 1, title: "History", kind: "side", component: HistoryPanel, position: "right" });
registerNav({ id: "history", version: 1, label: "History", order: 70, panel: "history" });
