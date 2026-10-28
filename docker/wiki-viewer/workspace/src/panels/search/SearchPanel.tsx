// Find what is already collected (D1 tool on the writing surface): the same candidate list as the
// [[ autocomplete - the listing record and the retrieval contract's search, never Quartz's index.
// Nothing is excluded: a source hidden in the document's refinery is listed LAST, tagged "hidden in
// this session". MIRROR: the editor sends its selection here as a search (Mod-Shift-F).
import { useEffect, useMemo, useState } from "react";
import { D, get, post, q } from "../../lib/api";
import { getState, setState, useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Cand {
  kind: string;
  id: string;
  title: string;
  snippet: string;
  insert: string;
  tags: string[];
}

export function SearchPanel(_p: PanelProps) {
  const mirror = useWorkspace((s) => s.mirror);
  const path = useWorkspace((s) => s.documentPath);
  const [query, setQuery] = useState("");
  const [ran, setRan] = useState("");
  const [results, setResults] = useState<Cand[]>([]);
  const [msg, setMsg] = useState("");
  const run = async (text: string) => {
    setRan(text);
    const r = await get(`${D}/candidates?q=${q(text)}${path ? `&path=${q(path)}` : ""}`).catch(() => ({ candidates: [] }));
    setResults(r.candidates);
  };
  useEffect(() => {
    if (mirror?.query) {
      setQuery(mirror.query);
      run(mirror.query);
    }
  }, [mirror?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaves = useMemo<Leaf[]>(() => results.map((c) => ({
    key: `${c.kind}:${c.id}`, badges: [c.kind, ...c.tags],
    label: <span data-result={c.id}>{c.title}</span>, detail: <span className="ws-muted">{c.snippet.slice(0, 240)}</span>,
  })), [results]);

  const actions = (l: Leaf) => {
    const c = results.find((x) => `${x.kind}:${x.id}` === l.key)!;
    const source = c.kind === "source" || c.kind === "report";
    return (
      <>
        <button type="button" data-action="link" onClick={() => {
          const ed = getState().editor;
          if (!ed) return setMsg("open a document in the editor to link at its cursor");
          ed.insertAtCursor(c.insert);
        }}>Link at cursor</button>
        {source && (
          <button type="button" data-action="cite" onClick={async () => {
            const ed = getState().editor;
            if (!ed) return setMsg("open a document in the editor to cite at its cursor");
            const r = await post(`${D}/references`, { path: ed.path, source_id: c.id, form: "chip" });
            ed.insertAtCursor(r.insert);
          }}>Cite at cursor</button>
        )}
        {source && (
          <button type="button" data-action="open" onClick={() => {
            setState({ reference: { reference_id: null, source_id: c.id, chunk_idx: 0 } });
            openPanel("reference");
          }}>Open in the reference panel</button>
        )}
      </>
    );
  };

  return (
    <div className="ws-side ws-search">
      <form className="ws-inline-form" onSubmit={(e) => { e.preventDefault(); run(query); }}>
        <input type="search" placeholder="search what is collected" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search-input" />
      </form>
      {ran && (
        <Disclosure
          testId="search-disclosure"
          open={!!mirror && mirror.query === ran}
          summary={<span data-testid="search-summary">{results.length} results for "{ran}"</span>}
          leaves={leaves}
          actions={actions}
        />
      )}
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "search", version: 1, title: "Search", kind: "side", component: SearchPanel, position: "right" });
registerNav({ id: "search", version: 1, label: "Search", order: 30, panel: "search" });
