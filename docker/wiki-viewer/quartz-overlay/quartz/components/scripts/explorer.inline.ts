// FORK of Quartz v4.5.1 quartz/components/scripts/explorer.inline.ts (MIT,
// (c) jackyzha0; THIRD-PARTY-NOTICES.md). The Dockerfile sha256-guards the
// upstream file before this overlay replaces it, so a QUARTZ_REF bump fails
// the build until the fork is re-based.
//
// research-workbench P1b: the explorer reads ONE FOLDER AT A TIME from the
// database (/workbench/nav -> the viewer's /__nav, lib/nav-tree.mjs) instead
// of downloading the whole vault's index and building + sorting a trie of
// every page on every navigation. Measured before (PLAN-VIEWER-PERF, 48,178
// pages): sort 2,165 ms per navigation, 16.3 MB nav payload; the vault is
// 76,542 pages now and the P1b floor must hold at five times that.
//
//   - the server returns a folder's children ALREADY in the explorer's order
//     (folders first, then the display name with Quartz's default comparator),
//     with root-relative hrefs (F3/F4 of PLAN-VIEWER-PERF: baseUrl has no path
//     prefix), paged (NAV_LIMIT per request, "show more" / "show earlier");
//   - a navigation fetches the root and the folders that are open (the current
//     page's ancestors, and the folders the reader left open), in parallel;
//     a collapsed folder is fetched on its first expand;
//   - folder state, the DOM templates, the toggles, the wheel scroll and the
//     scroll restore are upstream's; the two 2026-08-23 state fixes (an
//     auto-opened ancestor is recorded open; saved state of folders not on the
//     page is kept) and the idempotent re-render are built in, not sed-patched;
//   - kept from patches/explorer-perf.mjs (retired with this fork): V0
//     (?wikiperf=1 marks, now `explorer` = the main-thread work of building
//     the visible tree - the client sorts nothing - and `explorer-wall` = the
//     whole setup including the nav requests) and V1 (no build while the
//     mobile sidebar is hidden).
import { FullSlug, simplifySlug } from "../../util/path"

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
}

type FolderState = {
  path: string
  collapsed: boolean
}

interface NavEntry {
  name: string
  slug: string
  href: string
  title: string
  folder: boolean
  count: number
}

interface NavPage {
  folder: string
  title: string
  total: number
  offset: number
  entries: NavEntry[]
  next: number | null
}

const NAV_LIMIT = 100
const NAV_TTL_MS = 30_000
let currentExplorerState: Array<FolderState> = []
let buildMs = 0 // main-thread time spent building explorer DOM in this setup

// One request per folder page; reused for NAV_TTL_MS across SPA navigations,
// then re-requested (the browser revalidates with the ETag: a 304 when the
// folder did not change).
const navCache = new Map<string, { at: number; p: Promise<NavPage | null> }>()
function navFetch(folder: string, offset = 0, focus = ""): Promise<NavPage | null> {
  const key = `${folder}\u0000${offset}\u0000${focus}`
  const hit = navCache.get(key)
  if (hit && Date.now() - hit.at < NAV_TTL_MS) return hit.p
  const url =
    "/workbench/nav?folder=" + encodeURIComponent(folder) + "&limit=" + NAV_LIMIT +
    (offset ? "&offset=" + offset : "") + (focus ? "&focus=" + encodeURIComponent(focus) : "")
  const p = fetch(url, { cache: "no-cache" })
    .then((r) => (r.ok ? (r.json() as Promise<NavPage>) : null))
    .catch(() => null)
  navCache.set(key, { at: Date.now(), p })
  p.then((v) => {
    if (!v) navCache.delete(key) // never cache a failure
  })
  return p
}

// "a/b/index" -> "a/b"; "" for the root.
const folderOf = (folderSlug: string) => folderSlug.replace(/\/?index$/, "")

function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer") as HTMLElement
  if (!nearestExplorer) return
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    // Stop <html> from being scrollable when mobile explorer is open
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

function saveState() {
  localStorage.setItem("fileTree", JSON.stringify(currentExplorerState))
}

function recordState(path: string, collapsed: boolean) {
  const st = currentExplorerState.find((item) => item.path === path)
  if (st) st.collapsed = collapsed
  else currentExplorerState.push({ path, collapsed })
}

function toggleFolder(evt: MouseEvent) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  // Check if target was svg icon or button
  const isSvg = target.nodeName === "svg"

  // corresponding <ul> element relative to clicked button/folder
  const folderContainer = (
    isSvg
      ? // svg -> div.folder-container
        target.parentElement
      : // button.folder-button -> div -> div.folder-container
        target.parentElement?.parentElement
  ) as MaybeHTMLElement
  if (!folderContainer) return
  const childFolderContainer = folderContainer.nextElementSibling as MaybeHTMLElement
  if (!childFolderContainer) return

  childFolderContainer.classList.toggle("open")
  const isCollapsed = !childFolderContainer.classList.contains("open")
  // First expand of a folder that was not loaded: fetch its children now.
  if (!isCollapsed && childFolderContainer.dataset.loaded !== "1") {
    void loadChildren(childFolderContainer, folderContainer.dataset.folderpath ?? "")
  }
  recordState(folderContainer.dataset.folderpath as string, isCollapsed)
  saveState()
}

function createFileNode(currentSlug: FullSlug, node: NavEntry): HTMLLIElement {
  const template = document.getElementById("template-file") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  a.href = node.href
  a.dataset.for = node.slug
  a.textContent = node.title

  if (currentSlug === node.slug) {
    a.classList.add("active")
  }

  return li
}

let explorerOpts: ParsedOptions = {
  folderClickBehavior: "link",
  folderDefaultState: "collapsed",
  useSavedState: true,
}
let explorerSlug: FullSlug = "" as FullSlug

function isPrefixOfCurrent(folderPath: string, currentSlug: FullSlug) {
  const simpleFolderPath = simplifySlug(folderPath as FullSlug)
  return simpleFolderPath === currentSlug.slice(0, simpleFolderPath.length)
}

// Is this folder open on this page (saved state, the default, or because it
// holds the current page)?
function folderOpen(folderPath: string, currentSlug: FullSlug) {
  const isCollapsed =
    currentExplorerState.find((item) => item.path === folderPath)?.collapsed ??
    explorerOpts.folderDefaultState === "collapsed"
  return !isCollapsed || isPrefixOfCurrent(folderPath, currentSlug)
}

function createFolderNode(currentSlug: FullSlug, node: NavEntry): HTMLLIElement {
  const template = document.getElementById("template-folder") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder-outer") as HTMLElement

  const folderPath = node.slug
  folderContainer.dataset.folderpath = folderPath

  if (explorerOpts.folderClickBehavior === "link") {
    // Replace button with link for link behavior
    const button = titleContainer.querySelector(".folder-button") as HTMLElement
    const a = document.createElement("a")
    a.href = node.href
    a.dataset.for = folderPath
    a.className = "folder-title"
    a.textContent = node.title
    button.replaceWith(a)
  } else {
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.textContent = node.title
    const button = titleContainer.querySelector(".folder-button") as HTMLElement
    button.addEventListener("click", toggleFolder)
    window.addCleanup(() => button.removeEventListener("click", toggleFolder))
  }
  const icon = folderContainer.querySelector(".folder-icon") as HTMLElement | null
  if (icon) {
    icon.addEventListener("click", toggleFolder)
    window.addCleanup(() => icon.removeEventListener("click", toggleFolder))
  }

  if (folderOpen(folderPath, currentSlug)) {
    folderOuter.classList.add("open")
    // 2026-08-23 state fix 1: an ancestor opened because it holds the current
    // page is RECORDED open, so the next toggle does not persist a stale
    // collapsed:true (the "explorer reverts to an old state" bug).
    if (isPrefixOfCurrent(folderPath, currentSlug)) recordState(folderPath, false)
  }
  return li
}

// Fill a folder's <ul> from the nav: one page, plus "show earlier" / "show
// more" items for a folder larger than one page. Folders inside that are open
// are filled too (their requests were started in parallel by setupExplorer).
async function loadChildren(folderOuter: HTMLElement, folderSlug: string) {
  folderOuter.dataset.loaded = "1"
  const ul = folderOuter.querySelector("ul") as HTMLUListElement
  const folder = folderOf(folderSlug)
  const focus = isPrefixOfCurrent(folderSlug, explorerSlug) ? explorerSlug : ""
  const page = await navFetch(folder, 0, focus)
  if (!page) {
    folderOuter.dataset.loaded = ""
    return
  }
  await fillList(ul, page, (off) => navFetch(folder, off))
}

function moreItem(label: string, onClick: () => void): HTMLLIElement {
  const li = document.createElement("li")
  li.className = "explorer-more"
  const b = document.createElement("button")
  b.type = "button"
  b.className = "folder-button"
  b.textContent = label
  b.addEventListener("click", (e) => {
    e.stopPropagation()
    onClick()
  })
  li.appendChild(b)
  return li
}

async function renderEntries(entries: NavEntry[]): Promise<{ frag: DocumentFragment; open: Array<Promise<void>> }> {
  const t = performance.now()
  const frag = document.createDocumentFragment()
  const open: Array<Promise<void>> = []
  for (const e of entries) {
    if (e.folder) {
      const li = createFolderNode(explorerSlug, e)
      frag.appendChild(li)
      const outer = li.querySelector(".folder-outer") as HTMLElement
      if (outer.classList.contains("open")) open.push(loadChildren(outer, e.slug))
    } else {
      frag.appendChild(createFileNode(explorerSlug, e))
    }
  }
  buildMs += performance.now() - t
  return { frag, open }
}

// "Show earlier": the page before `offset`, inserted where this item stands.
function earlierItem(offset: number, pageAt: (off: number) => Promise<NavPage | null>): HTMLLIElement {
  const item = moreItem(`Show earlier (${offset})`, async () => {
    const prev = Math.max(0, offset - NAV_LIMIT)
    const p = await pageAt(prev)
    if (!p) return
    const r = await renderEntries(p.entries.slice(0, offset - prev))
    if (prev > 0) r.frag.insertBefore(earlierItem(prev, pageAt), r.frag.firstChild)
    item.replaceWith(r.frag)
    await Promise.all(r.open)
  })
  return item
}

async function fillList(ul: HTMLElement, page: NavPage, pageAt: (off: number) => Promise<NavPage | null>, before?: Node | null) {
  const { frag, open } = await renderEntries(page.entries)
  if (page.offset > 0) frag.insertBefore(earlierItem(page.offset, pageAt), frag.firstChild)
  if (page.next != null) {
    const next = page.next
    const more = moreItem(`Show more (${page.total - next})`, async () => {
      const p = await pageAt(next)
      if (!p) return
      const holder = document.createElement("li")
      more.replaceWith(holder)
      await fillList(ul, p, pageAt, holder)
      holder.remove()
    })
    frag.appendChild(more)
  }
  const t = performance.now()
  ul.insertBefore(frag, before ?? null)
  buildMs += performance.now() - t
  await Promise.all(open)
}

async function setupExplorer(currentSlug: FullSlug) {
  const allExplorers = document.querySelectorAll("div.explorer") as NodeListOf<HTMLElement>
  buildMs = 0
  explorerSlug = currentSlug

  for (const explorer of allExplorers) {
    explorerOpts = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
    }

    // Get folder state from local storage. 2026-08-23 state fix 2: saved
    // state of a folder that is not on this page is KEPT (the tree is lazy
    // now, so most folders are not).
    const storageTree = localStorage.getItem("fileTree")
    const serializedExplorerState =
      storageTree && explorerOpts.useSavedState ? JSON.parse(storageTree) : []
    currentExplorerState = Array.isArray(serializedExplorerState) ? serializedExplorerState : []

    // Start every request this page needs at once: the root and every
    // ancestor of the current page (the rest load as their folders render).
    const segs = currentSlug.split("/")
    for (let i = 0; i < segs.length - 1; i++) {
      void navFetch(segs.slice(0, i + 1).join("/"), 0, currentSlug)
    }
    const root = await navFetch("")

    const explorerUl = explorer.querySelector(".explorer-ul") as HTMLElement | null
    if (!explorerUl) continue
    const onExplorerWheel = (e: WheelEvent) => {
      const b = explorerUl.scrollTop
      const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? explorerUl.clientHeight : 1
      explorerUl.scrollTop += e.deltaY * m
      if (explorerUl.scrollTop !== b) e.preventDefault()
    }
    explorerUl.addEventListener("wheel", onExplorerWheel, { passive: false })
    window.addCleanup(() => explorerUl.removeEventListener("wheel", onExplorerWheel))

    // Idempotent: clear a previous render before inserting (2026-08-23).
    const tc = performance.now()
    explorerUl.querySelectorAll(":scope > li:not(.overflow-end)").forEach((el) => el.remove())
    buildMs += performance.now() - tc
    if (root) {
      const end = explorerUl.querySelector(":scope > li.overflow-end")
      await fillList(explorerUl, root, (off) => navFetch("", off), end)
    }
    saveState()

    // restore explorer scrollTop position if it exists
    const scrollTop = sessionStorage.getItem("explorerScrollTop")
    if (scrollTop) {
      explorerUl.scrollTop = parseInt(scrollTop)
    } else {
      // try to scroll to the active element if it exists
      const activeElement = explorerUl.querySelector(".active")
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: "smooth" })
      }
    }

    // Set up event handlers
    const explorerButtons = explorer.getElementsByClassName(
      "explorer-toggle",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of explorerButtons) {
      button.addEventListener("click", toggleExplorer)
      window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
    }
  }
}

document.addEventListener("prenav", async () => {
  // save explorer scrollTop position
  const explorer = document.querySelector(".explorer-ul")
  if (!explorer) return
  sessionStorage.setItem("explorerScrollTop", explorer.scrollTop.toString())
})

// V0 (PLAN-VIEWER-PERF): opt-in navigation instrumentation - append
// ?wikiperf=1 to any URL. It sticks for the tab (an SPA navigation drops the
// query string) and draws a small badge with the numbers; ?wikiperf=0 turns
// it off. Absent the flag nothing is recorded.
function wikiperfOn(): boolean {
  try {
    if (location.search.includes("wikiperf=0")) sessionStorage.removeItem("wikiperf")
    else if (location.search.includes("wikiperf=1")) sessionStorage.setItem("wikiperf", "1")
    return sessionStorage.getItem("wikiperf") === "1"
  } catch {
    return false
  }
}

function wikiperfMark(name: string, ms: number, built: boolean) {
  if (!wikiperfOn()) return
  const w = window as any
  const store = (w.__wikiperf = w.__wikiperf || {})
  store[name] = {
    ms: Math.round(ms * 10) / 10,
    built,
    li: document.querySelectorAll(".explorer-ul li").length,
  }
  const hist = (w.__wikiperfLog = w.__wikiperfLog || [])
  hist.push({ name, ms: store[name].ms, built, li: store[name].li, at: Date.now() })
  // The SPA morph drops nodes that are not in the incoming HTML, so re-create
  // the badge each time rather than assuming it survived the navigation.
  let badge = document.getElementById("wikiperf-badge")
  if (!badge) {
    badge = document.createElement("div")
    badge.id = "wikiperf-badge"
    badge.setAttribute(
      "style",
      "position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,.82);" +
        "color:#7CFC98;font:11px/1.45 ui-monospace,monospace;padding:5px 7px;border-radius:4px;" +
        "pointer-events:none;white-space:pre;max-width:70vw",
    )
    document.body.appendChild(badge)
  }
  badge.textContent = Object.keys(store)
    .map((k) => k + ": " + store[k].ms + "ms " + (store[k].built ? "built" : "skipped") + " li=" + store[k].li)
    .join("\n")
  console.log("[wikiperf] " + name, store[name])
}

// V1 (PLAN-VIEWER-PERF): no build while the mobile sidebar is hidden.
let lastNavSlug: FullSlug | null = null
let explorerBuilt = false

// True when the mobile hamburger is on screen, i.e. we are in the <=800px
// layout. If a browser lacks checkVisibility() we report "not mobile".
function explorerMobileLayout(): boolean {
  const toggle = document.querySelector(".explorer .mobile-explorer") as HTMLElement | null
  if (!toggle || typeof toggle.checkVisibility !== "function") return false
  return toggle.checkVisibility()
}

// Time the build: the main-thread work of building the tree (what a
// navigation costs the page; nothing is sorted on the client), and the wall
// time of the whole setup including the nav requests.
async function timedSetup(slug: FullSlug, mark: string) {
  const t0 = performance.now()
  await setupExplorer(slug)
  wikiperfMark(mark + "-wall", performance.now() - t0, true)
  wikiperfMark(mark, buildMs, true)
}

function deferExplorerBuild(slug: FullSlug) {
  for (const explorer of document.querySelectorAll("div.explorer")) {
    for (const toggle of explorer.querySelectorAll(".explorer-toggle")) {
      const el = toggle as HTMLElement
      const onFirstOpen = async () => {
        el.removeEventListener("click", onFirstOpen)
        // Open FIRST so the tap feels instant, then build.
        toggleExplorer.call(el)
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        await timedSetup(lastNavSlug ?? slug, "explorer-open")
        explorerBuilt = true
      }
      el.addEventListener("click", onFirstOpen)
      window.addCleanup(() => el.removeEventListener("click", onFirstOpen))
    }
  }
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  lastNavSlug = currentSlug
  explorerBuilt = false
  if (!explorerMobileLayout()) {
    await timedSetup(currentSlug, "explorer")
    explorerBuilt = true
  } else {
    // setupExplorer binds the toggle handlers, so a deferred build registers
    // its own opener or the hamburger would do nothing at all.
    deferExplorerBuild(currentSlug)
    wikiperfMark("explorer", 0, false)
  }

  // if mobile hamburger is visible, collapse by default
  for (const explorer of document.getElementsByClassName("explorer")) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) return

    if (mobileExplorer.checkVisibility()) {
      explorer.classList.add("collapsed")
      explorer.setAttribute("aria-expanded", "false")

      // Allow <html> to be scrollable when mobile explorer is collapsed
      document.documentElement.classList.remove("mobile-no-scroll")
    }

    mobileExplorer.classList.remove("hide-until-loaded")
  }
})

window.addEventListener("resize", function () {
  // V1: a phone rotated into the desktop layout (or a narrow window widened)
  // reveals a sidebar we deliberately did not build. Build it once.
  if (!explorerBuilt && lastNavSlug && !explorerMobileLayout()) {
    explorerBuilt = true
    void setupExplorer(lastNavSlug)
  }
  // Desktop explorer opens by default, and it stays open when the window is resized
  // to mobile screen size. Applies `no-scroll` to <html> in this edge case.
  const explorer = document.querySelector(".explorer")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})
