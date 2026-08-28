import type { ContentDetails } from "../../plugins/emitters/contentIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceRadial,
  zoomIdentity,
  select,
  drag,
  zoom,
} from "d3"
import { Text, Graphics, Application, Container, Circle } from "pixi.js"
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import { registerEscapeHandler, removeAllChildren } from "./util"
import { FullSlug, SimpleSlug, getFullSlug, resolveRelative, simplifySlug } from "../../util/path"
import { D3Config } from "../Graph"

type GraphicsInfo = {
  color: string
  gfx: Graphics
  alpha: number
  active: boolean
}

type NodeData = {
  id: SimpleSlug
  text: string
  tags: string[]
} & SimulationNodeDatum

type SimpleLinkData = {
  source: SimpleSlug
  target: SimpleSlug
}

type LinkData = {
  source: NodeData
  target: NodeData
} & SimulationLinkDatum<NodeData>

type LinkRenderData = GraphicsInfo & {
  simulationData: LinkData
}

type NodeRenderData = GraphicsInfo & {
  simulationData: NodeData
  label: Text
}

const localStorageKey = "graph-visited"
function getVisited(): Set<SimpleSlug> {
  return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? "[]"))
}

function addToVisited(slug: SimpleSlug) {
  const visited = getVisited()
  visited.add(slug)
  localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
}

type TweenNode = {
  update: (time: number) => void
  stop: () => void
}

// workaround for pixijs webgpu issue: https://github.com/pixijs/pixijs/issues/11389
async function determineGraphicsAPI(): Promise<"webgpu" | "webgl"> {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  const device = adapter && (await adapter.requestDevice().catch(() => null))
  if (!device) {
    return "webgl"
  }

  const canvas = document.createElement("canvas")
  const gl =
    (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
    (canvas.getContext("webgl") as WebGLRenderingContext | null)

  // we have to return webgl so pixijs automatically falls back to canvas
  if (!gl) {
    return "webgl"
  }

  const webglMaxTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
  const webgpuMaxTextures = device.limits.maxSampledTexturesPerShaderStage

  return webglMaxTextures === webgpuMaxTextures ? "webgpu" : "webgl"
}

async function renderGraph(graph: HTMLElement, fullSlug: FullSlug) {
  const slug = simplifySlug(fullSlug)
  const visited = getVisited()
  removeAllChildren(graph)

  let {
    drag: enableDrag,
    zoom: enableZoom,
    depth,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    removeTags,
    showTags,
    focusOnHover,
    enableRadial,
  } = JSON.parse(graph.dataset["cfg"]!) as D3Config

  const data: Map<SimpleSlug, ContentDetails> = new Map(
    Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
      simplifySlug(k as FullSlug),
      v,
    ]),
  )
  const links: SimpleLinkData[] = []
  // [ai-stack patch] Set instead of array-with-includes — the includes() scan
  // was quadratic over ~30k tag mentions at this vault's scale.
  const tags = new Set<SimpleSlug>()
  const validLinks = new Set(data.keys())

  const tweens = new Map<string, TweenNode>()
  for (const [source, details] of data.entries()) {
    const outgoing = details.links ?? []

    for (const dest of outgoing) {
      if (validLinks.has(dest)) {
        links.push({ source: source, target: dest })
      }
    }

    if (showTags) {
      const localTags = details.tags
        .filter((tag) => !removeTags.includes(tag))
        .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))

      for (const tag of localTags) {
        tags.add(tag)
        links.push({ source: source, target: tag })
      }
    }
  }

  // [ai-stack patch] Adjacency index — the BFS below used to re-scan the full
  // link list twice per frontier node (~15M scans for a well-connected hub).
  const adjacency = new Map<SimpleSlug, SimpleSlug[]>()
  const addAdj = (k: SimpleSlug, v: SimpleSlug) => {
    const a = adjacency.get(k)
    if (a) a.push(v)
    else adjacency.set(k, [v])
  }
  for (const l of links) {
    addAdj(l.source, l.target)
    addAdj(l.target, l.source)
  }

  const neighbourhood = new Set<SimpleSlug>()
  const wl: (SimpleSlug | "__SENTINEL")[] = [slug, "__SENTINEL"]
  if (depth >= 0) {
    while (depth >= 0 && wl.length > 0) {
      // compute neighbours
      const cur = wl.shift()!
      if (cur === "__SENTINEL") {
        depth--
        wl.push("__SENTINEL")
      } else {
        neighbourhood.add(cur)
        wl.push(...(adjacency.get(cur) ?? []))
      }
    }
  } else {
    // [ai-stack patch] Global-view scoping for a ~15k-page vault. Provenance
    // leaves (content/source/, content/thought/) are ~40% of all nodes but are
    // citation endpoints, not navigational structure — showing them made the
    // global graph a minutes-long render. Drop them, then cap the rest by
    // connectivity so the simulation stays interactive; the current page is
    // always included.
    // 800 (was 2000 at first cut): human testing 2026-08-24 showed the
    // fullscreen open still stalled the tab — label rasterization dominates,
    // and 2000 was past the interactive budget on a mid-range GPU.
    const GLOBAL_MAX_NODES = 800
    const leafRe = /^content\/(source|thought)\//
    let candidates = [...validLinks].filter((id) => !leafRe.test(id))
    if (candidates.length > GLOBAL_MAX_NODES) {
      const deg = new Map<SimpleSlug, number>()
      for (const l of links) {
        deg.set(l.source, (deg.get(l.source) ?? 0) + 1)
        deg.set(l.target, (deg.get(l.target) ?? 0) + 1)
      }
      candidates = candidates
        .sort((a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0))
        .slice(0, GLOBAL_MAX_NODES)
    }
    candidates.forEach((id) => neighbourhood.add(id))
    neighbourhood.add(slug)
    if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
  }

  const nodes = [...neighbourhood].map((url) => {
    const text = url.startsWith("tags/") ? "#" + url.substring(5) : (data.get(url)?.title ?? url)
    return {
      id: url,
      text,
      tags: data.get(url)?.tags ?? [],
    }
  })
  // [ai-stack patch] O(1) id→node lookups. nodes.find() per link end was
  // O(N·E) — ~1.1e9 string comparisons on the old unscoped global graph, the
  // bulk of its minutes-long "loading".
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const graphData: { nodes: NodeData[]; links: LinkData[] } = {
    nodes,
    links: links
      .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
      .map((l) => ({
        source: nodeById.get(l.source)!,
        target: nodeById.get(l.target)!,
      })),
  }
  // [ai-stack patch] Degree computed once — nodeRadius() used to re-filter the
  // whole link list and was called ≥3× per node (collide force + hit area +
  // circle radius).
  const degreeById = new Map<string, number>()
  for (const l of graphData.links) {
    degreeById.set(l.source.id, (degreeById.get(l.source.id) ?? 0) + 1)
    degreeById.set(l.target.id, (degreeById.get(l.target.id) ?? 0) + 1)
  }

  const width = graph.offsetWidth
  const height = Math.max(graph.offsetHeight, 250)

  // we virtualize the simulation and use pixi to actually render it
  const simulation: Simulation<NodeData, LinkData> = forceSimulation<NodeData>(graphData.nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter().strength(centerForce))
    .force("link", forceLink(graphData.links).distance(linkDistance))
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n)).iterations(3))

  const radius = (Math.min(width, height) / 2) * 0.8
  if (enableRadial) simulation.force("radial", forceRadial(radius).strength(0.2))

  // precompute style prop strings as pixi doesn't support css variables
  const cssVars = [
    "--secondary",
    "--tertiary",
    "--gray",
    "--light",
    "--lightgray",
    "--dark",
    "--darkgray",
    "--bodyFont",
  ] as const
  const computedStyleMap = cssVars.reduce(
    (acc, key) => {
      acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key)
      return acc
    },
    {} as Record<(typeof cssVars)[number], string>,
  )

  // calculate color
  const color = (d: NodeData) => {
    const isCurrent = d.id === slug
    if (isCurrent) {
      return computedStyleMap["--secondary"]
    } else if (visited.has(d.id) || d.id.startsWith("tags/")) {
      return computedStyleMap["--tertiary"]
    } else {
      return computedStyleMap["--gray"]
    }
  }

  function nodeRadius(d: NodeData) {
    return 2 + Math.sqrt(degreeById.get(d.id) ?? 0)
  }

  let hoveredNodeId: string | null = null
  let hoveredNeighbours: Set<string> = new Set()
  const linkRenderData: LinkRenderData[] = []
  const nodeRenderData: NodeRenderData[] = []
  function updateHoverInfo(newHoveredId: string | null) {
    hoveredNodeId = newHoveredId

    if (newHoveredId === null) {
      hoveredNeighbours = new Set()
      for (const n of nodeRenderData) {
        n.active = false
      }

      for (const l of linkRenderData) {
        l.active = false
      }
    } else {
      hoveredNeighbours = new Set()
      for (const l of linkRenderData) {
        const linkData = l.simulationData
        if (linkData.source.id === newHoveredId || linkData.target.id === newHoveredId) {
          hoveredNeighbours.add(linkData.source.id)
          hoveredNeighbours.add(linkData.target.id)
        }

        l.active = linkData.source.id === newHoveredId || linkData.target.id === newHoveredId
      }

      for (const n of nodeRenderData) {
        n.active = hoveredNeighbours.has(n.simulationData.id)
      }
    }
  }

  // [ai-stack] Two-stage activation. A single click/tap SELECTS a node and
  // highlights its chain; a second click on the SAME node navigates. On a
  // touch screen there is no hover at all, so before this the only thing a tap
  // could do was leave the page - you could never inspect a node's links.
  let selectedNodeId: string | null = null
  // What the pointer is ACTUALLY over right now. This must NOT be conflated
  // with hoveredNodeId: since V7.2, hoveredNodeId stays pinned to the selected
  // node after pointerleave so the highlight survives, and d3-drag's subject
  // accessor reads it to decide which node a gesture targets. That made a
  // click on EMPTY SPACE resolve to the selected node - so the background
  // click navigated ("second click") instead of deselecting, and dragging the
  // background dragged the selected node. Operator caught both, 2026-08-28.
  let pointerNodeId: string | null = null
  // Set on every node activation so the canvas click handler below can tell a
  // click that LANDED ON A NODE from a click on empty space: the native click
  // event fires a moment after the pointerup that activated the node.
  let lastNodeActivationAt = 0

  function clearSelection() {
    if (selectedNodeId === null) return
    selectedNodeId = null
    updateHoverInfo(null)
    renderPixiFromD3()
  }

  function activateNode(nodeId: string) {
    lastNodeActivationAt = Date.now()
    if (selectedNodeId === nodeId) {
      const targ = resolveRelative(fullSlug, nodeId as SimpleSlug)
      window.spaNavigate(new URL(targ, window.location.toString()))
      return
    }
    // A different node: the previous selection is dropped. updateHoverInfo
    // recomputes `active` for EVERY node from scratch, so exactly one node is
    // ever selected - clicking B cannot leave A selected.
    selectedNodeId = nodeId
    updateHoverInfo(nodeId)
    renderPixiFromD3()
  }

  let dragStartTime = 0
  let dragging = false
  // [ai-stack patch] frames of link redraw still owed (see animate()).
  let linkFramesLeft = 45

  function renderLinks() {
    tweens.get("link")?.stop()
    const tweenGroup = new TweenGroup()

    for (const l of linkRenderData) {
      let alpha = 1

      // if we are hovering over a node, we want to highlight the immediate neighbours
      // with full alpha and the rest with default alpha
      if (hoveredNodeId) {
        alpha = l.active ? 1 : 0.2
      }

      l.color = l.active ? computedStyleMap["--gray"] : computedStyleMap["--lightgray"]
      tweenGroup.add(new Tweened<LinkRenderData>(l).to({ alpha }, 200))
    }

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("link", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderLabels() {
    tweens.get("label")?.stop()
    const tweenGroup = new TweenGroup()

    const defaultScale = 1 / scale
    const activeScale = defaultScale * 1.1
    for (const n of nodeRenderData) {
      if (!n.label) continue // [ai-stack patch] over-budget nodes have no label
      const nodeId = n.simulationData.id

      if (hoveredNodeId === nodeId) {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: 1,
              scale: { x: activeScale, y: activeScale },
            },
            100,
          ),
        )
      } else {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: n.label.alpha,
              scale: { x: defaultScale, y: defaultScale },
            },
            100,
          ),
        )
      }
    }

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("label", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderNodes() {
    tweens.get("hover")?.stop()

    const tweenGroup = new TweenGroup()
    for (const n of nodeRenderData) {
      let alpha = 1

      // if we are hovering over a node, we want to highlight the immediate neighbours
      // [ai-stack] dim non-neighbours when focusOnHover is configured OR when
      // the user has click-selected a node: the inline graph sets
      // focusOnHover:false, but click-to-highlight must work there too.
      //
      // THREE tiers, not two: the focused node itself stays at full opacity,
      // its chain sits between, everything else recedes. With a flat "chain =
      // 1" you cannot tell WHICH node is selected once you click a neighbour
      // of the previous one - they both look lit.
      if (hoveredNodeId !== null && (focusOnHover || selectedNodeId !== null)) {
        const focusId = selectedNodeId ?? hoveredNodeId
        alpha = n.simulationData.id === focusId ? 1 : n.active ? 0.65 : 0.2
      }

      tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
    }

    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("hover", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderPixiFromD3() {
    renderNodes()
    renderLinks()
    renderLabels()
    // [ai-stack patch] hover tweens run ~200ms — keep link geometry redrawing
    // long enough to show them (see the animate() gate).
    linkFramesLeft = 45
  }

  tweens.forEach((tween) => tween.stop())
  tweens.clear()

  const pixiPreference = await determineGraphicsAPI()
  const app = new Application()
  await app.init({
    width,
    height,
    antialias: true,
    autoStart: false,
    autoDensity: true,
    backgroundAlpha: 0,
    preference: pixiPreference,
    resolution: window.devicePixelRatio,
    eventMode: "static",
  })
  graph.appendChild(app.canvas)

  // [ai-stack] Click on empty space clears the selection. The Pixi stage is
  // deliberately left non-interactive (d3-zoom/-drag own the canvas events),
  // so this is a plain DOM listener: any click that did NOT just activate a
  // node is a click on the background. Hit-testing by hand would mean
  // reimplementing the zoom transform, whose failure mode is worse - a
  // mis-mapped coordinate would clear the selection the user just made.
  const onCanvasClick = () => {
    if (Date.now() - lastNodeActivationAt < 400) return
    clearSelection()
  }
  // On the CONTAINER, not the canvas: in the fullscreen view the canvas does
  // not necessarily cover the whole panel, and a click on the surrounding
  // padding is still "empty space" to the user. Node clicks bubble here too,
  // which the guard above filters out.
  graph.addEventListener("click", onCanvasClick)
  ;(window as any).__wikiGraph = "v7.4"


  const stage = app.stage
  stage.interactive = false

  const labelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
  const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
  const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
  stage.addChild(nodesContainer, labelsContainer, linkContainer)

  // [ai-stack patch] Label budget: every Pixi Text is an individually
  // rasterized GPU texture. On the global view that meant thousands of
  // textures per open — the "tab stalls + viewer VRAM swells" report. Big
  // graphs label only the best-connected nodes (plus the current page);
  // unlabeled nodes still show their name via hover-neighbour highlighting.
  const LABEL_BUDGET = 300
  let labelled: Set<string> | null = null
  if (graphData.nodes.length > 400) {
    labelled = new Set(
      [...graphData.nodes]
        .sort((a, b) => (degreeById.get(b.id) ?? 0) - (degreeById.get(a.id) ?? 0))
        .slice(0, LABEL_BUDGET)
        .map((n) => n.id),
    )
    labelled.add(slug)
  }

  for (const n of graphData.nodes) {
    const nodeId = n.id

    const label = labelled && !labelled.has(nodeId)
      ? null
      : new Text({
          interactive: false,
          eventMode: "none",
          text: n.text,
          alpha: 0,
          anchor: { x: 0.5, y: 1.2 },
          style: {
            fontSize: fontSize * 15,
            fill: computedStyleMap["--dark"],
            fontFamily: computedStyleMap["--bodyFont"],
          },
          // [ai-stack patch] 4× DPR rasterized one texture per node — thousands of
          // labels at global scale. 2× stays crisp at label sizes.
          resolution: window.devicePixelRatio * 2,
        })
    label?.scale.set(1 / scale)

    let oldLabelOpacity = 0
    const isTagNode = nodeId.startsWith("tags/")
    const gfx = new Graphics({
      interactive: true,
      label: nodeId,
      eventMode: "static",
      hitArea: new Circle(0, 0, nodeRadius(n)),
      cursor: "pointer",
    })
      .circle(0, 0, nodeRadius(n))
      .fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })
      .on("pointerover", (e) => {
        pointerNodeId = e.target.label
        updateHoverInfo(e.target.label)
        if (label) oldLabelOpacity = label.alpha
        if (!dragging) {
          renderPixiFromD3()
        }
      })
      .on("pointerleave", () => {
        pointerNodeId = null
        // [ai-stack] restore the SELECTED node's highlight rather than clearing,
        // so a click-selected chain does not vanish when the pointer moves off.
        updateHoverInfo(selectedNodeId)
        if (label) label.alpha = oldLabelOpacity
        if (!dragging) {
          renderPixiFromD3()
        }
      })

    if (isTagNode) {
      gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
    }

    nodesContainer.addChild(gfx)
    if (label) labelsContainer.addChild(label)

    const nodeRenderDatum: NodeRenderData = {
      simulationData: n,
      gfx,
      label,
      color: color(n),
      alpha: 1,
      active: false,
    }

    nodeRenderData.push(nodeRenderDatum)
  }

  for (const l of graphData.links) {
    const gfx = new Graphics({ interactive: false, eventMode: "none" })
    linkContainer.addChild(gfx)

    const linkRenderDatum: LinkRenderData = {
      simulationData: l,
      gfx,
      color: computedStyleMap["--lightgray"],
      alpha: 1,
      active: false,
    }

    linkRenderData.push(linkRenderDatum)
  }

  let currentTransform = zoomIdentity
  if (enableDrag) {
    select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
      drag<HTMLCanvasElement, NodeData | undefined>()
        .container(() => app.canvas)
        // [ai-stack] pointerNodeId, NOT hoveredNodeId: see the comment on its
        // declaration. Using the sticky highlight here made background clicks
        // and drags act on the selected node.
        .subject(() => (pointerNodeId === null ? undefined : nodeById.get(pointerNodeId as SimpleSlug)))
        .on("start", function dragstarted(event) {
          if (!event.active) simulation.alphaTarget(1).restart()
          event.subject.fx = event.subject.x
          event.subject.fy = event.subject.y
          event.subject.__initialDragPos = {
            x: event.subject.x,
            y: event.subject.y,
            fx: event.subject.fx,
            fy: event.subject.fy,
          }
          dragStartTime = Date.now()
          dragging = true
        })
        .on("drag", function dragged(event) {
          const initPos = event.subject.__initialDragPos
          event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
          event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
        })
        .on("end", function dragended(event) {
          if (!event.active) simulation.alphaTarget(0)
          event.subject.fx = null
          event.subject.fy = null
          dragging = false

          // if the time between mousedown and mouseup is short, we consider it a click
          if (Date.now() - dragStartTime < 500) {
            const node = graphData.nodes.find((n) => n.id === event.subject.id) as NodeData
            activateNode(node.id)
          }
        }),
    )
  } else {
    for (const node of nodeRenderData) {
      node.gfx.on("click", () => {
        activateNode(node.simulationData.id)
      })
    }
  }

  if (enableZoom) {
    select<HTMLCanvasElement, NodeData>(app.canvas).call(
      zoom<HTMLCanvasElement, NodeData>()
        .extent([
          [0, 0],
          [width, height],
        ])
        .scaleExtent([0.25, 4])
        .on("zoom", ({ transform }) => {
          currentTransform = transform
          stage.scale.set(transform.k, transform.k)
          stage.position.set(transform.x, transform.y)

          // zoom adjusts opacity of labels too
          const scale = transform.k * opacityScale
          let scaleOpacity = Math.max((scale - 1) / 3.75, 0)
          const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)

          for (const label of labelsContainer.children) {
            if (!activeNodes.includes(label)) {
              label.alpha = scaleOpacity
            }
          }
        }),
    )
  }

  let stopAnimation = false
  function animate(time: number) {
    if (stopAnimation) return
    // [ai-stack patch] Once the simulation cools and nothing is interacting,
    // node positions and link geometry are static — stop paying the
    // clear+stroke of every link on every rAF tick (drag/hover re-arm it).
    if (simulation.alpha() >= 0.001 || dragging) linkFramesLeft = 2
    if (linkFramesLeft > 0) {
      linkFramesLeft--
      for (const n of nodeRenderData) {
        const { x, y } = n.simulationData
        if (!x || !y) continue
        n.gfx.position.set(x + width / 2, y + height / 2)
        if (n.label) {
          n.label.position.set(x + width / 2, y + height / 2)
        }
      }

      for (const l of linkRenderData) {
        const linkData = l.simulationData
        l.gfx.clear()
        l.gfx.moveTo(linkData.source.x! + width / 2, linkData.source.y! + height / 2)
        l.gfx
          .lineTo(linkData.target.x! + width / 2, linkData.target.y! + height / 2)
          .stroke({ alpha: l.alpha, width: 1, color: l.color })
      }
    }

    tweens.forEach((t) => t.update(time))
    app.renderer.render(stage)
    requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)
  return () => {
    stopAnimation = true
    // [ai-stack patch] bare app.destroy() leaves every child + label texture
    // alive on the GPU; the local graph is torn down and rebuilt on EVERY
    // navigation, so label textures accumulated forever — the "viewer
    // machine's VRAM swells" report. Destroy the whole tree + textures.
    app.destroy(true, { children: true, texture: true, textureSource: true })
  }
}

let localGraphCleanups: (() => void)[] = []
let globalGraphCleanups: (() => void)[] = []

function cleanupLocalGraphs() {
  for (const cleanup of localGraphCleanups) {
    cleanup()
  }
  localGraphCleanups = []
}

function cleanupGlobalGraphs() {
  for (const cleanup of globalGraphCleanups) {
    cleanup()
  }
  globalGraphCleanups = []
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const slug = e.detail.url
  addToVisited(simplifySlug(slug))

  async function renderLocalGraph() {
    cleanupLocalGraphs()
    const localGraphContainers = document.getElementsByClassName("graph-container")
    for (const container of localGraphContainers) {
      localGraphCleanups.push(await renderGraph(container as HTMLElement, slug))
    }
  }

  await renderLocalGraph()
  const handleThemeChange = () => {
    void renderLocalGraph()
  }

  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    document.removeEventListener("themechange", handleThemeChange)
  })

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
  async function renderGlobalGraph() {
    const slug = getFullSlug(window)
    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = "1"
      }

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)
      if (graphContainer) {
        globalGraphCleanups.push(await renderGraph(graphContainer, slug))
      }
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = ""
      }
    }
  }

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyGlobalGraphOpen = containers.some((container) =>
        container.classList.contains("active"),
      )
      anyGlobalGraphOpen ? hideGlobalGraph() : renderGlobalGraph()
    }
  }

  const containerIcons = document.getElementsByClassName("global-graph-icon")
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener("click", renderGlobalGraph)
    window.addCleanup(() => icon.removeEventListener("click", renderGlobalGraph))
  })

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcutHandler)
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })
})
