// Build-time patch: make a navigation cost what a navigation should cost.
// Implements PLAN-VIEWER-PERF phases V0 (in-page measurement), V1 (do not
// build a sidebar nobody can see) and V2 (cached collator).
//
// MEASURED PROBLEM (2026-08-28, 48,178-page vault): the Explorer rebuilds the
// WHOLE tree on every `nav` event — trie 92 ms + sort 2,165 ms + 98,210 DOM
// elements — and on a phone the nav handler then COLLAPSES the result, so all
// of it is waste. That is the operator's "2-4 s per click", and the "most
// clicks are unresponsive" on mobile.
//
// A SCRIPT, not a sed: these are multi-line insertions with braces, quotes and
// template literals. An earlier sed into TypeScript injected a stray control
// character and broke the bundle for the whole site (2026-08-26). Every anchor
// is asserted unique before the write and re-read after it, so a QUARTZ_REF
// bump fails the BUILD instead of silently dropping the fix.
import { readFileSync, writeFileSync } from "node:fs";

const EXPLORER = "/quartz/quartz/components/scripts/explorer.inline.ts";

// Splice by index rather than String.replace: no $-substitution semantics, no
// regex, nothing for a tooling layer to mangle.
function splice(file, anchor, replacement, marker) {
  const src = readFileSync(file, "utf8");
  if (src.includes(marker)) {
    console.log(`[explorer-perf] already applied: ${marker}`);
    return;
  }
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error(`[explorer-perf] anchor NOT FOUND in ${file}: ${anchor}`);
  if (src.indexOf(anchor, i + 1) !== -1) {
    throw new Error(`[explorer-perf] anchor NOT UNIQUE in ${file}: ${anchor}`);
  }
  writeFileSync(file, src.slice(0, i) + replacement + src.slice(i + anchor.length));
  if (!readFileSync(file, "utf8").includes(marker)) {
    throw new Error(`[explorer-perf] verification failed for ${marker}`);
  }
  console.log(`[explorer-perf] applied: ${marker}`);
}

// ── V0 + V1 helpers, inserted at module scope ───────────────────────────────
const NAV_ANCHOR = `document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  await setupExplorer(currentSlug)
`;

const NAV_REPLACEMENT = `// [ai-stack V0] Opt-in navigation instrumentation: append ?wikiperf=1 to any
// URL. It sticks for the tab (an SPA navigation drops the query string) and
// draws a small badge, because there is NO headless browser in this stack —
// this badge is the client-side measurement harness, and it is the only way to
// get a real number off the operator's phone. ?wikiperf=0 turns it off.
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
    ms: Math.round(ms),
    built,
    li: document.querySelectorAll(".explorer-ul li").length,
  }
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
    .join("\\n")
  console.log("[wikiperf] " + name, store[name])
}

// [ai-stack V1] Lazy Explorer.
let lastNavSlug: FullSlug | null = null
let explorerBuilt = false

// True when the mobile hamburger is on screen, i.e. we are in the <=800px
// layout. checkVisibility() is already used by the stock handler below; if a
// browser lacks it we report "not mobile" so the behaviour is exactly today's.
function explorerMobileLayout(): boolean {
  const toggle = document.querySelector(".explorer .mobile-explorer") as HTMLElement | null
  if (!toggle || typeof toggle.checkVisibility !== "function") return false
  return toggle.checkVisibility()
}

// On a phone the handler below ALWAYS collapses the sidebar after building it,
// so the tree is never displayed — building it cost 2,165 ms of sort plus
// 98,210 DOM elements on every tap, for nothing. Build on first open instead.
function explorerShouldBuildNow(): boolean {
  return !explorerMobileLayout()
}

function deferExplorerBuild(slug: FullSlug) {
  for (const explorer of document.querySelectorAll("div.explorer")) {
    for (const toggle of explorer.querySelectorAll(".explorer-toggle")) {
      const el = toggle as HTMLElement
      const onFirstOpen = async () => {
        el.removeEventListener("click", onFirstOpen)
        // Open FIRST so the tap feels instant, and let the panel paint before
        // the build takes the main thread.
        toggleExplorer.call(el)
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const t0 = performance.now()
        await setupExplorer(lastNavSlug ?? slug)
        explorerBuilt = true
        wikiperfMark("explorer-open", performance.now() - t0, true)
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
  const t0 = performance.now()
  if (explorerShouldBuildNow()) {
    await setupExplorer(currentSlug)
    explorerBuilt = true
  } else {
    // setupExplorer is what binds the toggle handlers, so a deferred build MUST
    // register its own opener or the hamburger would do nothing at all.
    deferExplorerBuild(currentSlug)
  }
  wikiperfMark("explorer", performance.now() - t0, explorerBuilt)
`;

const RESIZE_ANCHOR = `window.addEventListener("resize", function () {
`;

const RESIZE_REPLACEMENT = `window.addEventListener("resize", function () {
  // [ai-stack V1] A phone rotated into the desktop layout (or a narrow window
  // widened) reveals a sidebar we deliberately did not build. Build it once.
  if (!explorerBuilt && lastNavSlug && !explorerMobileLayout()) {
    explorerBuilt = true
    void setupExplorer(lastNavSlug)
  }
`;

// ── V2: one cached collator instead of a fresh one per comparison ───────────
// The comparator arrives as SOURCE TEXT in data-data-fns and is rebuilt with
// new Function, so it cannot close over anything. Overriding it here (rather
// than editing Explorer.tsx's default) keeps the patch to a single anchor and
// self-disables if upstream ever stops using localeCompare.
const SORT_ANCHOR = `    // Get folder state from local storage
    const storageTree = localStorage.getItem("fileTree")`;

const SORT_REPLACEMENT = `    // [ai-stack V2] localeCompare(a, undefined, opts) builds a fresh collator
    // for EVERY comparison. Measured on this vault (48,178 entries): 2,165 ms
    // to sort with the stock comparator vs 75 ms with one cached Intl.Collator
    // — same ordering, 35x. Guarded on the stock comparator's own source text,
    // so a customised sortFn is never silently overridden.
    if (typeof dataFns.sortFn === "string" && dataFns.sortFn.includes("localeCompare")) {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
      opts.sortFn = (a: FileTrieNode, b: FileTrieNode) => {
        if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
          return collator.compare(a.displayName, b.displayName)
        }
        return !a.isFolder && b.isFolder ? 1 : -1
      }
    }

    // Get folder state from local storage
    const storageTree = localStorage.getItem("fileTree")`;

splice(EXPLORER, NAV_ANCHOR, NAV_REPLACEMENT, "[wikiperf] ");
splice(EXPLORER, RESIZE_ANCHOR, RESIZE_REPLACEMENT, "explorerMobileLayout()) {");
splice(EXPLORER, SORT_ANCHOR, SORT_REPLACEMENT, "collator.compare(a.displayName");

// Belt-and-braces: the three behaviours this file exists to guarantee.
const out = readFileSync(EXPLORER, "utf8");
for (const needed of [
  "function wikiperfMark",
  "function explorerShouldBuildNow",
  "deferExplorerBuild(currentSlug)",
  "new Intl.Collator(undefined, { numeric: true, sensitivity: \"base\" })",
]) {
  if (!out.includes(needed)) throw new Error(`[explorer-perf] missing after patch: ${needed}`);
}
console.log("[explorer-perf] OK");
