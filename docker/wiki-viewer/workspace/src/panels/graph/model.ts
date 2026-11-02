// The page graph's model (research-workbench P8a-1) - PURE, so every rule is a unit test.
//
// D12 one-way linking: a user document is a node with OUTBOUND edges only, drawn from its listing
// record's links (GET /contract/documents - the caller's own documents). Nothing points INTO a document:
// a page link whose target is a document path is dropped, and only a document can start a document edge.
//
// D1 hubs as link-density neighbourhoods: topic hubs are EMERGENT - the neighbourhoods are computed from
// the page links on read (greedy modularity over the pages, deterministic; nothing stored, no hub id) and
// drawn as soft density clouds with no boundary line (no fenced groups). A user document is never a
// member of a neighbourhood, so it is never drawn as a hub. The edges BETWEEN neighbourhoods are the
// discovery layer's entry points, marked:
//   thin      - the only link between its two neighbourhoods (THIN_BRIDGES or fewer links join them)
//   contested - it touches a source page whose source grounds a contradicted claim (the contract's
//               GraphNode.contested, the hub context's contested rule)
export const THIN_BRIDGES = 1;
export const DOC_PREFIX = "doc:";
export const SOURCE_PAGE = "content/source/";

export interface ApiNode {
  id: string;
  title: string;
  page_class: string | null;
  state?: string;
  distance?: number;
  lifecycle?: string | null;
  contested?: boolean;
}
export interface ApiLink {
  source: string;
  target: string;
}
export interface Listing {
  title: string;
  path: string;
  outbound_links: { kind: string; id: string }[];
}

export interface GNode {
  id: string;
  kind: "page" | "document";
  title: string;
  page_class: string | null;
  lifecycle: string | null;
  contested: boolean;
  distance: number;
}
export interface GEdge {
  source: string;
  target: string;
  kind: "page_link" | "document_link";
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

const isDocumentId = (id: string) => id.startsWith(DOC_PREFIX) || id.startsWith("documents/");

// the page a document link points at: a page slug, or a source / report's leaf page
export function linkTarget(l: { kind: string; id: string }): string | null {
  if (l.kind === "page") return l.id.replace(/^\/+|\/+$/g, "");
  if (l.kind === "source" || l.kind === "report") return `${SOURCE_PAGE}${l.id}`;
  return null; // a claim or another document: not a page of this graph
}

export function buildGraph(nodes: ApiNode[], links: ApiLink[], documents: Listing[] = []): Graph {
  const out: GNode[] = [];
  const have = new Set<string>();
  for (const n of nodes) {
    if (isDocumentId(n.id) || have.has(n.id)) continue; // a document is never a page of the graph
    have.add(n.id);
    out.push({
      id: n.id, kind: "page", title: n.title || n.id, page_class: n.page_class ?? null,
      lifecycle: n.lifecycle ?? null, contested: !!n.contested, distance: n.distance ?? 0,
    });
  }
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (!have.has(l.source) || !have.has(l.target) || isDocumentId(l.target) || isDocumentId(l.source)) continue;
    const k = `${l.source} ${l.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ source: l.source, target: l.target, kind: "page_link" });
  }
  // documents: outbound only, and only those that link something on the graph
  for (const d of documents) {
    const targets = [...new Set(d.outbound_links.map(linkTarget).filter((t): t is string => !!t && have.has(t)))];
    if (!targets.length) continue;
    const id = `${DOC_PREFIX}${d.path}`;
    out.push({ id, kind: "document", title: d.title || d.path, page_class: null, lifecycle: null, contested: false, distance: 0 });
    for (const t of targets) edges.push({ source: id, target: t, kind: "document_link" });
  }
  return { nodes: out, edges };
}

export interface Neighbourhood {
  id: number;
  members: string[];
  centre: string;
}

// The neighbourhoods: greedy modularity agglomeration (Clauset-Newman-Moore) over the PAGE nodes and page
// links (undirected) - start with every page alone, repeatedly merge the two linked groups whose merge raises
// the modularity most (ties: the lower ids), stop when no merge raises it. Deterministic, nothing stored.
// A page with no link stays alone. A document takes part in nothing.
export function neighbourhoods(g: Graph): { of: Map<string, number>; list: Neighbourhood[] } {
  const pages = g.nodes.filter((n) => n.kind === "page").map((n) => n.id).sort();
  const index = new Map(pages.map((id, i) => [id, i]));
  const pairs = new Set<string>();
  const deg = pages.map(() => 0);
  const adj: number[][] = pages.map(() => []);
  for (const e of g.edges) {
    if (e.kind !== "page_link") continue;
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (pairs.has(k)) continue;
    pairs.add(k);
    deg[a]++; deg[b]++;
    adj[a].push(b); adj[b].push(a);
  }
  const m2 = 2 * pairs.size;
  // e[i]: the share of link ends between group i and each linked group; av[i]: group i's share of all ends
  const e = new Map<number, Map<number, number>>();
  const av = new Map<number, number>();
  pages.forEach((_x, i) => { e.set(i, new Map()); av.set(i, m2 ? deg[i] / m2 : 0); });
  for (const k of pairs) {
    const [a, b] = k.split("|").map(Number);
    e.get(a)!.set(b, (e.get(a)!.get(b) ?? 0) + 1 / m2);
    e.get(b)!.set(a, (e.get(b)!.get(a) ?? 0) + 1 / m2);
  }
  const members = new Map<number, number[]>(pages.map((_x, i) => [i, [i]]));
  for (;;) {
    let best = 0, bi = -1, bj = -1;
    for (const [i, row] of e) {
      for (const [j, eij] of row) {
        if (j <= i) continue;
        const dq = 2 * (eij - av.get(i)! * av.get(j)!);
        if (dq > best + 1e-12 || (Math.abs(dq - best) <= 1e-12 && dq > 0 && (i < bi || (i === bi && j < bj)))) { best = dq; bi = i; bj = j; }
      }
    }
    if (bi < 0 || best <= 1e-12) break;
    // merge bj into bi
    const rowJ = e.get(bj)!, rowI = e.get(bi)!;
    for (const [k, v] of rowJ) {
      if (k === bi) continue;
      rowI.set(k, (rowI.get(k) ?? 0) + v);
      const rk = e.get(k)!;
      rk.set(bi, (rk.get(bi) ?? 0) + v);
      rk.delete(bj);
    }
    rowI.delete(bj);
    e.delete(bj);
    av.set(bi, av.get(bi)! + av.get(bj)!);
    av.delete(bj);
    members.set(bi, [...members.get(bi)!, ...members.get(bj)!]);
    members.delete(bj);
  }
  const list: Neighbourhood[] = [];
  const of = new Map<string, number>();
  [...members.values()].sort((a, b) => b.length - a.length || Math.min(...a) - Math.min(...b)).forEach((ms, k) => {
    // the centre: the best-linked member (ties: the id)
    const centre = [...ms].sort((a, b) => adj[b].length - adj[a].length || a - b)[0];
    for (const x of ms) of.set(pages[x], k);
    list.push({ id: k, members: ms.map((x) => pages[x]).sort(), centre: pages[centre] });
  });
  return { of, list };
}

export interface MarkedEdge extends GEdge {
  between: [number, number] | null; // the two neighbourhoods a page link joins, when they differ
  thin: boolean;
  contested: boolean;
}

export function markEdges(g: Graph, of: Map<string, number>): MarkedEdge[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const bridges = new Map<string, number>();
  for (const e of g.edges) {
    if (e.kind !== "page_link") continue;
    const a = of.get(e.source), b = of.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    bridges.set(pairKey(a, b), (bridges.get(pairKey(a, b)) ?? 0) + 1);
  }
  return g.edges.map((e) => {
    const a = of.get(e.source), b = of.get(e.target);
    if (e.kind !== "page_link" || a === undefined || b === undefined || a === b) return { ...e, between: null, thin: false, contested: false };
    const contested = !!byId.get(e.source)?.contested || !!byId.get(e.target)?.contested;
    return { ...e, between: [Math.min(a, b), Math.max(a, b)], thin: (bridges.get(pairKey(a, b)) ?? 0) <= THIN_BRIDGES, contested };
  });
}

// A deterministic force layout: neighbourhoods seeded around a circle, then repulsion between every pair
// (a cell grid keeps it near-linear), attraction along edges and a pull toward the neighbourhood's own
// centroid - so a neighbourhood reads as a dense cloud and its edges to other clouds stand out.
export function layout(g: Graph, of: Map<string, number>, opts: { width?: number; height?: number; iterations?: number } = {}) {
  const W = opts.width ?? 1000, H = opts.height ?? 800;
  const n = g.nodes.length;
  const iterations = opts.iterations ?? (n > 400 ? 60 : n > 150 ? 120 : 220);
  const groups = Math.max(1, new Set(of.values()).size);
  const idx = new Map(g.nodes.map((x, i) => [x.id, i]));
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return ((h >>> 0) % 10000) / 10000;
  };
  const px = new Float64Array(n), py = new Float64Array(n);
  g.nodes.forEach((x, i) => {
    const c = of.get(x.id);
    const angle = c === undefined ? hash(x.id) * Math.PI * 2 : (c / groups) * Math.PI * 2;
    const ring = c === undefined ? 0.45 : 0.3;
    px[i] = W / 2 + Math.cos(angle) * W * ring + (hash(x.id + "x") - 0.5) * 60;
    py[i] = H / 2 + Math.sin(angle) * H * ring + (hash(x.id + "y") - 0.5) * 60;
  });
  const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.6;
  const E = g.edges.map((e) => [idx.get(e.source)!, idx.get(e.target)!] as const).filter(([a, b]) => a !== undefined && b !== undefined);
  const cell = k * 2;
  for (let it = 0; it < iterations; it++) {
    const t = (1 - it / iterations) * k * 0.5 + 0.5;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    // repulsion within neighbouring grid cells
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(px[i] / cell)},${Math.floor(py[i] / cell)}`;
      const l = grid.get(key);
      if (l) l.push(i); else grid.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(px[i] / cell), cy = Math.floor(py[i] / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(`${cx + ox},${cy + oy}`) ?? []) {
          if (j <= i) continue;
          let ddx = px[i] - px[j], ddy = py[i] - py[j];
          let d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) { ddx = 0.1; ddy = 0.1; d2 = 0.02; }
          const f = (k * k) / d2;
          dx[i] += ddx * f; dy[i] += ddy * f; dx[j] -= ddx * f; dy[j] -= ddy * f;
        }
      }
    }
    for (const [a, b] of E) {
      const ddx = px[a] - px[b], ddy = py[a] - py[b];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.1;
      const f = d / k;
      dx[a] -= ddx * f; dy[a] -= ddy * f; dx[b] += ddx * f; dy[b] += ddy * f;
    }
    // the pull toward each neighbourhood's centroid
    const sum = new Map<number, [number, number, number]>();
    g.nodes.forEach((x, i) => {
      const c = of.get(x.id);
      if (c === undefined) return;
      const s = sum.get(c) ?? [0, 0, 0];
      s[0] += px[i]; s[1] += py[i]; s[2]++;
      sum.set(c, s);
    });
    g.nodes.forEach((x, i) => {
      const c = of.get(x.id);
      const s = c === undefined ? undefined : sum.get(c);
      if (s && s[2] > 1) { dx[i] += (s[0] / s[2] - px[i]) * 0.05 * k; dy[i] += (s[1] / s[2] - py[i]) * 0.05 * k; }
    });
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const m = Math.min(d, t);
      px[i] = Math.min(W - 10, Math.max(10, px[i] + (dx[i] / d) * m));
      py[i] = Math.min(H - 10, Math.max(10, py[i] + (dy[i] / d) * m));
    }
  }
  const pos = new Map<string, { x: number; y: number }>();
  g.nodes.forEach((x, i) => pos.set(x.id, { x: px[i], y: py[i] }));
  return pos;
}
