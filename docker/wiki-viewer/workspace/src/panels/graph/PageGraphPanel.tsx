// The page graph (research-workbench P8a-1): the pages around a root (GET /contract/neighbours, capped at
// 800) with the caller's own user documents that link into it (GET /contract/documents - the listing
// record's outbound links; D12: a document has outbound edges only). Topic hubs are drawn as link-density
// neighbourhoods - soft clouds with no boundary line (D1: no fenced groups) - and the edges between them
// are marked thin or contested: the discovery layer's entry points (model.ts). A source page shows its
// lifecycle state (D5): a suppressed, unlinked or erased source is labelled with it, whatever the size.
// SVG, written here (no graph library adopted: the concept map, deferred, is where sigma.js would go).
import { useEffect, useMemo, useRef, useState } from "react";
import { C, get, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { SourceStatus, shownStatus } from "../../lib/sourceStatus";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import { buildGraph, DOC_PREFIX, type Graph, layout, markEdges, neighbourhoods, SOURCE_PAGE } from "./model";
import "./graph.css";

const W = 1000, H = 800;
const LABEL_ALL_BELOW = 120;
const hue = (k: number) => (k * 137.508) % 360;

export function PageGraphPanel(p: PanelProps) {
  const selected = useWorkspace((s) => s.reference);
  const fromRef = selected?.source_id ? `${SOURCE_PAGE}${selected.source_id}` : "";
  const [root, setRoot] = useState<string>((p.params.root as string) || fromRef);
  const [input, setInput] = useState(root);
  const [depth, setDepth] = useState(2);
  const [withDocs, setWithDocs] = useState(true);
  const [api, setApi] = useState<{ nodes: any[]; links: any[]; truncated: boolean } | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const [moving, setMoving] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    if (p.params.root) { setRoot(String(p.params.root)); setInput(String(p.params.root)); }
  }, [p.params.root]);
  useEffect(() => {
    if (!root && fromRef) { setRoot(fromRef); setInput(fromRef); }
  }, [fromRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!root) return;
    let live = true;
    setMsg("");
    get(`${C}/neighbours?id=${q(root)}&depth=${depth}&limit=800`)
      .then((r) => live && setApi({ nodes: r.nodes ?? [], links: r.links ?? [], truncated: !!r.truncated }))
      .catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [root, depth]);
  useEffect(() => {
    if (!withDocs) { setDocs([]); return; }
    let live = true;
    get(`${C}/documents?limit=500`).then((r) => live && setDocs(r.documents ?? [])).catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [withDocs, root]);

  const model = useMemo(() => {
    if (!api) return null;
    const g: Graph = buildGraph(api.nodes, api.links, withDocs ? docs : []);
    const nb = neighbourhoods(g);
    const edges = markEdges(g, nb.of);
    const pos = layout(g, nb.of, { width: W, height: H });
    return { g, nb, edges, pos };
  }, [api, docs, withDocs]);

  const byId = useMemo(() => new Map((model?.g.nodes ?? []).map((n) => [n.id, n])), [model]);
  const entries = useMemo(() => (model?.edges ?? []).filter((e) => e.between && (e.thin || e.contested)), [model]);
  const node = pick ? byId.get(pick) : undefined;

  const leaves = useMemo<Leaf[]>(() => {
    if (!model) return [];
    const title = (id: string) => byId.get(id)?.title ?? id;
    return [
      ...entries.map((e) => ({
        key: `edge:${e.source}>${e.target}`,
        label: <span data-entry={`${e.source}>${e.target}`}>{title(e.source)} - {title(e.target)}</span>,
        badges: ["entry point", ...(e.thin ? ["thin"] : []), ...(e.contested ? ["contested"] : [])],
        detail: <p className="ws-muted">joins neighbourhood {e.between![0] + 1} and {e.between![1] + 1}
          {e.thin ? "; the only link between them" : ""}{e.contested ? "; touches a source a contradicted claim rests on" : ""}</p>,
      })),
      ...model.nb.list.filter((h) => h.members.length > 1).map((h) => ({
        key: `hub:${h.id}`,
        label: <span data-hub-centre={h.centre}>neighbourhood {h.id + 1}: around {title(h.centre)}</span>,
        badges: [`${h.members.length} pages`],
      })),
      // every source page that is not plainly active is listed with its state (D5)
      ...model.g.nodes.filter((n) => shownStatus(n.lifecycle)).map((n) => ({
        key: `node:${n.id}`, label: <span data-status-node={n.id}>{n.title}</span>, badges: [n.lifecycle!],
      })),
    ];
  }, [model, entries, byId]);

  const onWheel = (e: React.WheelEvent) => {
    const s = Math.min(8, Math.max(0.2, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setView((v) => ({ ...v, s }));
  };
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setMoving(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) / v.s, y: d.vy + (e.clientY - d.y) / v.s }));
  };
  const onUp = () => {
    drag.current = null;
    setMoving(false);
  };

  const total = model?.g.nodes.length ?? 0;
  const docCount = model?.g.nodes.filter((n) => n.kind === "document").length ?? 0;
  const hubs = model?.nb.list.filter((h) => h.members.length > 1).length ?? 0;
  const sourceOf = (id: string) => (id.startsWith(SOURCE_PAGE) ? id.slice(SOURCE_PAGE.length) : null);

  return (
    <div className="ws-side ws-graph">
      <form className="ws-inline-form" onSubmit={(e) => { e.preventDefault(); setRoot(input.trim()); setPick(null); }}>
        <input placeholder="a page slug (content/...)" value={input} onChange={(e) => setInput(e.target.value)} data-testid="graph-root" />
        <label>depth <input type="number" min={1} max={5} value={depth} onChange={(e) => setDepth(Number(e.target.value) || 1)} /></label>
        <label><input type="checkbox" checked={withDocs} onChange={(e) => setWithDocs(e.target.checked)} data-testid="graph-docs" /> my documents</label>
        <button type="submit">Show</button>
      </form>
      {!root && <p className="ws-muted">Name a page (or select a source) to see the graph around it.</p>}
      {model && (
        <>
          <svg className={`ws-graph-canvas${moving ? " ws-g-moving" : ""}`} viewBox={`0 0 ${W} ${H}`} data-testid="graph-canvas"
            data-nodes={total} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
            <defs>
              <filter id="ws-g-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16" /></filter>
              <marker id="ws-g-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="ws-g-arrowhead" />
              </marker>
            </defs>
            <g transform={`scale(${view.s}) translate(${view.x} ${view.y})`}>
              {/* D1: each neighbourhood a density cloud, blurred at its edge - no outline, no fence */}
              <g className="ws-g-density" filter="url(#ws-g-blur)" data-testid="graph-density">
                {model.g.nodes.filter((n) => n.kind === "page" && (model.nb.list[model.nb.of.get(n.id)!]?.members.length ?? 0) > 1).map((n) => {
                  const pt = model.pos.get(n.id)!;
                  return <circle key={n.id} cx={pt.x} cy={pt.y} r={34} fill={`hsl(${hue(model.nb.of.get(n.id)!)} 70% 55%)`} fillOpacity={0.16} data-density={model.nb.of.get(n.id)} />;
                })}
              </g>
              <g className="ws-g-edges">
                {model.edges.map((e) => {
                  const a = model.pos.get(e.source)!, b = model.pos.get(e.target)!;
                  const cls = ["ws-g-edge", e.kind === "document_link" ? "ws-g-doclink" : "", e.between ? "ws-g-bridge" : "", e.thin ? "ws-g-thin" : "", e.contested ? "ws-g-contested" : ""].filter(Boolean).join(" ");
                  return <line key={`${e.source}>${e.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={cls} data-edge={`${e.source}>${e.target}`}
                    data-kind={e.kind} markerEnd={e.kind === "document_link" ? "url(#ws-g-arrow)" : undefined} />;
                })}
              </g>
              <g className="ws-g-nodes">
                {model.g.nodes.map((n) => {
                  const pt = model.pos.get(n.id)!;
                  const st = shownStatus(n.lifecycle);
                  const cls = ["ws-g-node", n.kind === "document" ? "ws-g-document" : "", st ? `ws-g-status-${st}` : "", n.contested ? "ws-g-contested-node" : "", pick === n.id ? "ws-g-picked" : "", n.id === root ? "ws-g-root" : ""].filter(Boolean).join(" ");
                  const label = total < LABEL_ALL_BELOW || st || pick === n.id || n.id === root || n.kind === "document";
                  return (
                    <g key={n.id} className={cls} data-node={n.id} data-kind={n.kind} data-lifecycle={n.lifecycle ?? ""}
                      data-neighbourhood={model.nb.of.get(n.id) ?? ""} onClick={() => setPick(pick === n.id ? null : n.id)}>
                      {n.kind === "document"
                        ? <rect x={pt.x - 6} y={pt.y - 6} width={12} height={12} />
                        : <circle cx={pt.x} cy={pt.y} r={n.id === root ? 7 : 5} />}
                      {label && <text x={pt.x + 8} y={pt.y + 4}>{n.title}{st ? ` [${st}]` : ""}</text>}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
          <p className="ws-g-legend ws-muted">
            <span className="ws-g-key ws-g-key-thin">thin</span> the only link between two neighbourhoods ·{" "}
            <span className="ws-g-key ws-g-key-contested">contested</span> touches a contradicted claim's source ·{" "}
            <span className="ws-g-key ws-g-key-doc">document</span> your document (links out only)
          </p>
          {node && (
            <div className="ws-g-picked-box" data-testid="graph-picked" data-node={node.id}>
              <strong>{node.title}</strong> <span className="ws-badge">{node.kind === "document" ? "your document" : node.page_class ?? "page"}</span>
              <SourceStatus lifecycle={node.lifecycle} />
              {node.contested && <span className="ws-badge ws-badge-contested">contested</span>}
              <div className="ws-actions">
                {node.kind === "page" && <button type="button" data-action="set-root" onClick={() => { setRoot(node.id); setInput(node.id); setPick(null); }}>Centre here</button>}
                {node.kind === "page" && <a data-action="open-page" href={`/${node.id}`} target="_blank" rel="noopener">Open the page</a>}
                {sourceOf(node.id) && (
                  <button type="button" data-action="open-source" onClick={() => {
                    setState({ reference: { reference_id: null, source_id: sourceOf(node.id)!, chunk_idx: 0 } });
                    openPanel("reference");
                  }}>Open in the reference panel</button>
                )}
                {node.kind === "document" && (
                  <button type="button" data-action="open-document" onClick={() => setState({ documentPath: node.id.slice(DOC_PREFIX.length) })}>Open the document</button>
                )}
              </div>
            </div>
          )}
          <Disclosure
            testId="graph-disclosure"
            summary={<span data-testid="graph-summary">{total - docCount} pages{api?.truncated ? " (capped)" : ""}, {docCount} of your documents, {hubs} neighbourhood{hubs === 1 ? "" : "s"}, {entries.length} entry point{entries.length === 1 ? "" : "s"}</span>}
            leaves={leaves}
            actions={(l) => {
              const id = l.key.startsWith("node:") ? l.key.slice(5) : l.key.startsWith("hub:") ? model.nb.list[Number(l.key.slice(4))]?.centre : l.key.startsWith("edge:") ? l.key.slice(5).split(">")[1] : null;
              return id ? <button type="button" data-action="pick" onClick={() => setPick(id)}>Show on the graph</button> : null;
            }}
            empty="no entry points, neighbourhoods or flagged sources"
          />
        </>
      )}
      {msg && <p className="ws-muted" data-testid="graph-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "graph", version: 1, title: "Page graph", kind: "side", component: PageGraphPanel, position: "right" });
registerNav({ id: "graph", version: 1, label: "Page graph", order: 45, panel: "graph" });
