// The document's references panel (D12 parity item 8) over the P2a reference record: CITED references
// (in the text) versus ADDED ones (attached deliberately), add by searching sources, remove, copy the
// list. On export both fold into one References list.
// research-workbench P6b round 2 (tester D4, coordinator ruling): the panel lists what the export's
// References list will hold - the route's `listed`: ONE entry per source, in citation order, numbered and
// titled as the file prints it - so the panel, "Copy the list" and the exported file agree entry for entry.
// The per-reference actions (open, remove an added one) still act on the holder rows (`references`).
import { useEffect, useMemo, useState } from "react";
import { api, D, get, post, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import { statusBadges, useSourceStates } from "../../lib/sourceStatus";

interface Listed {
  number: number;
  source_id: string;
  title: string;
  reference_ids: string[];
}

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
  const [listed, setListed] = useState<Listed[]>([]);
  const [find, setFind] = useState("");
  const [hits, setHits] = useState<{ id: string; title: string; kind: string }[]>([]);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (path) {
      get(`${D}/references?path=${q(path)}`).then((r) => {
        setRefs(r.references ?? []);
        setListed(r.listed ?? []);
      }).catch(() => {
        setRefs([]);
        setListed([]);
      });
    }
  }, [path, rev, tick]);
  // P8a-1 (D5): each listed source with its lifecycle state
  const states = useSourceStates(listed.map((l) => l.source_id));
  const leaves = useMemo<Leaf[]>(() => [
    ...listed.map((l) => {
      const held = refs.filter((r) => l.reference_ids.includes(r.reference_id));
      return {
        key: `src:${l.source_id}`,
        badges: [`[${l.number}]`, ...statusBadges(states.byId[l.source_id]?.lifecycle), ...[...new Set(held.map((r) => r.origin))], ...[...new Set(held.map((r) => `rev ${r.pinned_revision}`))]],
        label: <span data-ref-row={l.reference_ids[0] ?? l.source_id} data-source={l.source_id}>{l.title || l.source_id}</span>,
      };
    }),
    { key: "add", label: <span>add a reference by searching sources</span> },
  ], [refs, listed, states]);
  const listText = () => listed.map((l) => `[${l.number}] ${l.title || l.source_id}`).join("\n");
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
    const entry = listed.find((x) => `src:${x.source_id}` === l.key)!;
    const held = refs.filter((x) => entry.reference_ids.includes(x.reference_id));
    const r = held[0] ?? { origin: "cited", reference_id: entry.reference_ids[0] ?? "", source_id: entry.source_id, pinned_revision: 0, scope: "", title: entry.title };
    const added = held.filter((x) => x.origin === "added");
    return (
      <>
        <button type="button" data-action="open" onClick={() => {
          setState({ reference: { reference_id: r.reference_id, source_id: r.source_id, chunk_idx: null } });
          openPanel("reference");
        }}>Open</button>
        {added.length > 0 && (
          <button type="button" data-action="remove" onClick={async () => {
            for (const a of added) await api("DELETE", `${D}/references/${a.reference_id}?path=${q(path ?? "")}`);
            setTick((t) => t + 1);
          }}>Remove</button>
        )}
        {held.some((x) => x.origin === "cited") && <span className="ws-muted">a cited reference is removed in the text</span>}
        <button type="button" data-action="copy" onClick={() => navigator.clipboard?.writeText(entry.title || entry.source_id).catch(() => {})}>Copy</button>
        <button type="button" data-action="copy-list" onClick={() => navigator.clipboard?.writeText(listText()).catch(() => {})}>Copy the list</button>
      </>
    );
  };
  if (!path) return <div className="ws-side ws-muted">Open a document to see its references.</div>;
  const cited = listed.filter((l) => refs.some((r) => l.reference_ids.includes(r.reference_id) && r.origin === "cited")).length;
  return (
    <div className="ws-side ws-docrefs">
      <Disclosure
        testId="docrefs-disclosure"
        summary={<span>{listed.length} in the reference list: {cited} cited, {listed.length - cited} added</span>}
        leaves={leaves}
        actions={actions}
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "doc-references", version: 1, title: "References", kind: "side", component: DocReferencesPanel, position: "right" });
registerNav({ id: "doc-references", version: 1, label: "References", order: 25, panel: "doc-references" });
