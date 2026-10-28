// The document's references panel (D12 parity item 8) over the P2a reference record: CITED references
// (in the text) versus ADDED ones (attached deliberately), add by searching sources, remove, copy the
// list. On export both fold into one References list.
import { useEffect, useMemo, useState } from "react";
import { api, D, get, post, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Ref {
  origin: string;
  reference_id: string;
  source_id: string;
  pinned_revision: number;
  scope: string;
  title: string;
}

export function DocReferencesPanel(_p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [find, setFind] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string; kind: string }[]>([]);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (path) get(`${D}/references?path=${q(path)}`).then((r) => setRefs(r.references)).catch(() => setRefs([]));
  }, [path, rev, tick]);
  const leaves = useMemo<Leaf[]>(() => [
    ...refs.map((r) => ({
      key: r.reference_id, badges: [r.origin, `rev ${r.pinned_revision}`],
      label: <span data-ref-row={r.reference_id}>{r.title || r.source_id}</span>,
    })),
    { key: "add", label: <span>add a reference by searching sources</span> },
  ], [refs]);
  const listText = () => refs.map((r, i) => `${i + 1}. ${r.title || r.source_id} (revision ${r.pinned_revision}, ${r.origin})`).join("\n");
  const actions = (l: Leaf) => {
    if (l.key === "add") {
      return (
        <div>
          <input placeholder="search sources" value={find} onChange={(e) => setFind(e.target.value)} data-testid="refs-find" />
          <button type="button" onClick={async () => {
            const r = await get(`${D}/candidates?q=${q(find)}&path=${q(path ?? "")}`);
            setHits(r.candidates.filter((c: any) => c.kind === "source" || c.kind === "report"));
          }}>Find</button>
          <ul>
            {hits.map((h) => (
              <li key={h.id}>
                {h.title}{" "}
                <button type="button" data-action="add-reference" onClick={async () => {
                  await post(`${D}/references`, { path, source_id: h.id, form: "added" });
                  setMsg("added");
                  setTick((t) => t + 1);
                }}>Add</button>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    const r = refs.find((x) => x.reference_id === l.key)!;
    return (
      <>
        <button type="button" data-action="open" onClick={() => {
          setState({ reference: { reference_id: r.reference_id, source_id: r.source_id, chunk_idx: null } });
          openPanel("reference");
        }}>Open</button>
        {r.origin === "added" && (
          <button type="button" data-action="remove" onClick={async () => {
            await api("DELETE", `${D}/references/${r.reference_id}?path=${q(path ?? "")}`);
            setTick((t) => t + 1);
          }}>Remove</button>
        )}
        {r.origin === "cited" && <span className="ws-muted">a cited reference is removed in the text</span>}
        <button type="button" data-action="copy" onClick={() => navigator.clipboard?.writeText(r.title || r.source_id).catch(() => {})}>Copy</button>
        <button type="button" data-action="copy-list" onClick={() => navigator.clipboard?.writeText(listText()).catch(() => {})}>Copy the list</button>
      </>
    );
  };
  if (!path) return <div className="ws-side ws-muted">Open a document to see its references.</div>;
  const cited = refs.filter((r) => r.origin === "cited").length;
  return (
    <div className="ws-side ws-docrefs">
      <Disclosure
        testId="docrefs-disclosure"
        summary={<span>{cited} cited, {refs.length - cited} added</span>}
        leaves={leaves}
        actions={actions}
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "doc-references", version: 1, title: "References", kind: "side", component: DocReferencesPanel, position: "right" });
registerNav({ id: "doc-references", version: 1, label: "References", order: 25, panel: "doc-references" });
