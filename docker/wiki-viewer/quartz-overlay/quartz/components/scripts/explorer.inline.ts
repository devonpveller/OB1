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

// ONE delegated click handler per explorer list (not two listeners + two
// cleanup closures per folder): a click on a folder's icon (or its button in
// "collapse" mode) toggles it; the first expand fetches its children. In
// "link" mode the folder title is a link and navigates.
function onExplorerClick(evt: MouseEvent) {
  const t = evt.target as Element | null
  const toggle = t?.closest?.(".folder-icon, .folder-button")
  if (!toggle || toggle.closest(".explorer-more")) return
  const folderContainer = toggle.closest(".folder-container") as MaybeHTMLElement
  if (!folderContainer) return
  evt.stopPropagation()
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

const esc = (v: string) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// The page's own <template> markup, cut once per setup into the pieces an
// entry fills in. Building a list as ONE HTML string (one parse) instead of a
// template clone + queries per entry is what keeps a navigation's explorer work
// small on a slow phone (rw-p1b-ready perf, 4x CPU throttling).
type Tpl = { folderHead: string; folderTitleBtn: string; folderMid: string; folderTail: string } | null
let tpl: Tpl = null
function cutTemplates(): Tpl {
  const tf = (document.getElementById("template-folder") as HTMLTemplateElement | null)?.innerHTML ?? ""
  const tfile = (document.getElementById("template-file") as HTMLTemplateElement | null)?.innerHTML ?? ""
  const C = '<div class="folder-container">'
  const B = '<button class="folder-button"><span class="folder-title"></span></button>'
  const O = '<div class="folder-outer">'
  const iC = tf.indexOf(C), iB = tf.indexOf(B), iO = tf.indexOf(O)
  if (tfile.replace(/\s+/g, "") !== '<li><ahref="#"></a></li>' || iC < 0 || iB < iC || iO < iB) return null
  return {
    folderHead: tf.slice(0, iC),
    folderTitleBtn: tf.slice(iC + C.length, iB),
    folderMid: tf.slice(iB + B.length, iO),
    folderTail: tf.slice(iO + O.length),
  }
}

function entryHtml(t: NonNullable<Tpl>, node: NavEntry, currentSlug: FullSlug): string {
  if (!node.folder) {
    return `<li><a href="${esc(node.href)}" data-for="${esc(node.slug)}"${currentSlug === node.slug ? ' class="active"' : ""}>${esc(node.title)}</a></li>`
  }
  const folderPath = node.slug
  const open = folderOpen(folderPath, currentSlug)
  // 2026-08-23 state fix 1: an ancestor opened because it holds the current
  // page is RECORDED open, so the next toggle does not persist a stale
  // collapsed:true (the "explorer reverts to an old state" bug).
  if (open && isPrefixOfCurrent(folderPath, currentSlug)) recordState(folderPath, false)
  const title = explorerOpts.folderClickBehavior === "link"
    ? `<a href="${esc(node.href)}" data-for="${esc(folderPath)}" class="folder-title">${esc(node.title)}</a>`
    : `<button class="folder-button"><span class="folder-title">${esc(node.title)}</span></button>`
  return t.folderHead + `<div class="folder-container" data-folderpath="${esc(folderPath)}">` + t.folderTitleBtn + title +
    t.folderMid + `<div class="folder-outer${open ? " open" : ""}">` + t.folderTail
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
  tpl ??= cutTemplates()
  const open: Array<Promise<void>> = []
  let frag: DocumentFragment
  if (tpl) {
    const holder = document.createElement("template")
    holder.innerHTML = entries.map((e) => entryHtml(tpl!, e, explorerSlug)).join("")
    frag = holder.content
  } else {
    // the page's templates are not the shape this fork was written against
    // (a Quartz bump): build entry by entry from them, the slow way
    frag = document.createDocumentFragment()
    for (const e of entries) frag.appendChild(slowEntry(e))
  }
  for (const outer of frag.querySelectorAll(":scope > li > .folder-outer.open")) {
    const c = outer.previousElementSibling as HTMLElement | null
    open.push(loadChildren(outer as HTMLElement, c?.dataset.folderpath ?? ""))
  }
  buildMs += performance.now() - t
  return { frag, open }
}

function slowEntry(node: NavEntry): HTMLLIElement {
  const id = node.folder ? "template-folder" : "template-file"
  const clone = (document.getElementById(id) as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  if (!node.folder) {
    const a = li.querySelector("a") as HTMLAnchorElement
    a.href = node.href
    a.dataset.for = node.slug
    a.textContent = node.title
    if (explorerSlug === node.slug) a.classList.add("active")
    return li
  }
  const c = li.querySelector(".folder-container") as HTMLElement
  c.dataset.folderpath = node.slug
  ;(li.querySelector(".folder-title") as HTMLElement).textContent = node.title
  if (folderOpen(node.slug, explorerSlug)) (li.querySelector(".folder-outer") as HTMLElement).classList.add("open")
  return li
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
  tpl = null // re-cut from this page's templates
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
    explorerUl.addEventListener("click", onExplorerClick)
    window.addCleanup(() => explorerUl.removeEventListener("click", onExplorerClick))

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
