// Build-time patch: draw the graph from the PAGE'S NEIGHBOURHOOD, not the vault.
//
// Before: renderGraph built an adjacency index from the whole nav index
// (~14MB) on every page, and the fullscreen view (depth < 0) ignored the
// current page entirely - it showed the 800 most-connected pages vault-wide.
// Operator, 2026-08-27: "nodes fan out from the accessed page then connect out
// to other nodes via links... when I full screen view I'm seeing all nodes not
// just the nodes relevant for the page I'm on".
//
// After: both views call /workbench/graph?slug=&depth= and render exactly what
// it returns. Local stays shallow (the component's configured depth, usually
// 1); fullscreen is the SAME page-scoped query at a greater depth. No vault
// scan, no global node list.
//
// Falls back to the previous whole-index behaviour if the endpoint fails, so a
// workbench outage degrades rather than blanking the panel.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "/quartz/quartz/components/scripts/graph.inline.ts";

const FROM = `  const data: Map<SimpleSlug, ContentDetails> = new Map(
    Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
      simplifySlug(k as FullSlug),
      v,
    ]),
  )`;

const TO = `  // [ai-stack patch] Page-scoped graph. depth < 0 means the component asked
  // for the "global" view; we answer with a DEEPER neighbourhood of THIS page
  // rather than the whole vault.
  const apiDepth = depth < 0 ? 3 : Math.max(1, depth)
  const apiGraph = await (async () => {
    try {
      const r = await fetch(
        "/workbench/graph?slug=" + encodeURIComponent(fullSlug) + "&depth=" + apiDepth +
          (depth < 0 ? "&limit=800" : ""),
        { cache: "no-store" },
      )
      if (!r.ok) return null
      const j = await r.json()
      return Array.isArray(j?.nodes) && j.nodes.length ? j : null
    } catch {
      return null
    }
  })()

  const data: Map<SimpleSlug, ContentDetails> = apiGraph
    ? new Map(
        apiGraph.nodes.map((n: any) => [
          simplifySlug(n.slug as FullSlug),
          { title: n.title, links: [], tags: n.tags ?? [] } as unknown as ContentDetails,
        ]),
      )
    : new Map(
        Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
          simplifySlug(k as FullSlug),
          v,
        ]),
      )`;

// The neighbourhood walk is skipped entirely when the API answered: the server
// already returned exactly the nodes to draw.
const FROM2 = `  const neighbourhood = new Set<SimpleSlug>()
  const wl: (SimpleSlug | "__SENTINEL")[] = [slug, "__SENTINEL"]
  if (depth >= 0) {`;

const TO2 = `  const neighbourhood = new Set<SimpleSlug>()
  const wl: (SimpleSlug | "__SENTINEL")[] = [slug, "__SENTINEL"]
  if (apiGraph) {
    // [ai-stack patch] Server already scoped this to the page.
    for (const n of apiGraph.nodes) neighbourhood.add(simplifySlug(n.slug as FullSlug))
    neighbourhood.add(slug)
    if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
  } else if (depth >= 0) {`;

// Edges come from the API too when it answered.
const FROM3 = `  const tweens = new Map<string, TweenNode>()
  for (const [source, details] of data.entries()) {`;

const TO3 = `  const tweens = new Map<string, TweenNode>()
  if (apiGraph) {
    for (const l of apiGraph.links as { source: string; target: string }[]) {
      links.push({
        source: simplifySlug(l.source as FullSlug),
        target: simplifySlug(l.target as FullSlug),
      })
    }
  }
  for (const [source, details] of data.entries()) {`;

const raw = readFileSync(FILE, "utf8");
if (raw.includes("/workbench/graph?slug=")) {
  console.log("[graph-api] already applied");
  process.exit(0);
}
// This file is an OVERLAY fork checked out on Windows, so it arrives with
// CRLF while these anchors are written with LF. Match in LF space and
// restore the original endings on write. Char codes rather than escape
// sequences: escaped forms keep getting mangled by the tooling that writes
// this file, which cost two build cycles to diagnose (2026-08-27).
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const hadCrlf = raw.includes(CR + LF);
const src = raw.split(CR + LF).join(LF);
let out = src;
for (const [from, to, label] of [[FROM, TO, "data"], [FROM2, TO2, "neighbourhood"], [FROM3, TO3, "links"]]) {
  const count = out.split(from).length - 1;
  if (count !== 1) {
    console.error(`[graph-api] anchor "${label}" found ${count} times (expected 1)`);
    process.exit(1);
  }
  out = out.replace(from, to);
}
writeFileSync(FILE, hadCrlf ? out.split(LF).join(CR + LF) : out, "utf8");
const check = readFileSync(FILE, "utf8");
if (!check.includes("/workbench/graph?slug=") || /[\u0000-\u0008]/.test(check)) {
  console.error("[graph-api] verification failed");
  process.exit(1);
}
console.log("[graph-api] applied: graph is page-scoped, fullscreen included");
