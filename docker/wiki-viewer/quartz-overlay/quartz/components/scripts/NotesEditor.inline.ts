// NotesEditor live-preview engine (P3.5, WYSIWYG) — a CodeMirror 6 editor with
// an Obsidian-style "Live Preview": you type INSIDE the rendered text; headings,
// bold/italic, inline code, links and [[wikilinks]] render in place, and only
// the line your caret is on falls back to raw markdown. Bundled into the viewer
// image by Quartz's inline-script-loader (`import script from "./scripts/…"`).
//
// Editing is in-place on the note page (no shadowbox): an "✎ Edit" toolbar over
// the article swaps the rendered prose for this editor; edits autosave ~1.5s
// after the last keystroke via PUT /workbench/notes (If-Match), and Quartz's
// hot-reload re-renders the real page within ~1s. Frontmatter is preserved
// verbatim (we edit the body only). New notes are created from a notebook hub.
import {
  EditorView,
  keymap,
  Decoration,
  ViewPlugin,
  WidgetType,
  placeholder,
} from "@codemirror/view"
import { EditorState, EditorSelection } from "@codemirror/state"
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { Strikethrough } from "@lezer/markdown"
import { syntaxTree, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language"
import { autocompletion, startCompletion } from "@codemirror/autocomplete"

// ── [[ ]] link candidates (every existing page + notebook, from Quartz) ──────
let _cands: { slug: string; title: string }[] | null = null
async function loadCandidates() {
  if (_cands) return _cands
  try {
    const idx = await (await fetch("/static/contentIndex.json")).json()
    _cands = Object.keys(idx)
      .map((slug) => ({ slug, title: (idx[slug] && idx[slug].title) || slug }))
      .filter((c) => c.slug && c.slug !== "index" && !c.slug.endsWith("/index"))
  } catch {
    _cands = []
  }
  return _cands
}

// ── link hover popover ───────────────────────────────────────────────────────
// Quartz attaches its popover handler to a.internal links only at `nav`; our
// in-editor link widgets are created later, so they get their own (self-
// contained, reusing Quartz's .popover-hint content + a small floating box).
// Separate show/hide timers + a hover guard. The earlier single-timer version
// could let a pending "show" fire after the cursor had left and wipe the "hide",
// stranding the popover. Now: the show timer is cancelled on leave, and after
// the (async) fetch we re-check that the link/popover is still hovered.
let _pop: HTMLElement | null = null
let _showTimer: any = null
let _hideTimer: any = null
let _hoverLink = false
let _hoverPop = false
function clearShow() {
  if (_showTimer) {
    clearTimeout(_showTimer)
    _showTimer = null
  }
}
function clearHide() {
  if (_hideTimer) {
    clearTimeout(_hideTimer)
    _hideTimer = null
  }
}
function hideLinkPopover() {
  clearShow()
  clearHide()
  _hoverLink = false
  _hoverPop = false
  if (_pop) {
    _pop.remove()
    _pop = null
  }
}
function scheduleHide() {
  clearHide()
  _hideTimer = setTimeout(() => {
    _hideTimer = null
    if (!_hoverLink && !_hoverPop) hideLinkPopover()
  }, 200)
}
function onLinkEnter(anchor: HTMLAnchorElement) {
  _hoverLink = true
  clearHide()
  clearShow()
  const href = anchor.getAttribute("href") || ""
  if (!href.startsWith("/")) return
  _showTimer = setTimeout(async () => {
    _showTimer = null
    try {
      const res = await fetch(href)
      if (!res.ok) return
      if (!_hoverLink) return // cursor left during the fetch — don't strand a popover
      const doc = new DOMParser().parseFromString(await res.text(), "text/html")
      const inner = document.createElement("div")
      inner.className = "ne-cm-popover-inner"
      const hints = doc.querySelectorAll(".popover-hint")
      if (hints.length) hints.forEach((h) => inner.appendChild(h.cloneNode(true)))
      else {
        const art = doc.querySelector("article")
        if (!art) return
        inner.appendChild(art.cloneNode(true))
      }
      if (_pop) {
        _pop.remove() // replace any existing popover (keep hover state/timers)
        _pop = null
      }
      const pop = document.createElement("div")
      pop.className = "ne-cm-popover"
      pop.appendChild(inner)
      pop.addEventListener("mouseenter", () => {
        _hoverPop = true
        clearHide()
      })
      pop.addEventListener("mouseleave", () => {
        _hoverPop = false
        scheduleHide()
      })
      document.body.appendChild(pop)
      const r = anchor.getBoundingClientRect()
      let left = r.left
      if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - pop.offsetWidth - 8
      let top = r.bottom + 6
      if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6
      pop.style.left = Math.max(8, left) + "px"
      pop.style.top = Math.max(8, top) + "px"
      _pop = pop
    } catch {
      /* ignore */
    }
  }, 250)
}
function onLinkLeave() {
  _hoverLink = false
  clearShow()
  scheduleHide()
}

// ── a rendered internal link (used for both [text](url) and [[wikilinks]]) ───
class LinkWidget extends WidgetType {
  constructor(readonly href: string, readonly text: string) {
    super()
  }
  eq(o: LinkWidget) {
    return o.href === this.href && o.text === this.text
  }
  toDOM() {
    const a = document.createElement("a")
    a.className = "internal ne-cm-link"
    a.href = this.href
    a.textContent = this.text
    a.addEventListener("mouseenter", () => onLinkEnter(a))
    a.addEventListener("mouseleave", () => onLinkLeave())
    return a
  }
  ignoreEvent() {
    return false
  }
}

// Lines that contain a selection/caret render RAW (Obsidian behaviour).
function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) set.add(n)
  }
  return set
}

const WIKI_RE = /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g

function buildDecorations(view: EditorView) {
  const state = view.state
  const active = activeLines(state)
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number)
  const out: any[] = []

  // Frontmatter block (leading ---/--- fences): style it as a muted, code-ish
  // "properties" region so editing it inline reads as metadata, not body text.
  if (state.doc.lines >= 2 && state.doc.line(1).text.trim() === "---") {
    let close = 0
    for (let n = 2; n <= state.doc.lines; n++) {
      if (state.doc.line(n).text.trim() === "---") {
        close = n
        break
      }
    }
    if (close > 1) {
      for (let n = 1; n <= close; n++) {
        const line = state.doc.line(n)
        out.push(Decoration.line({ class: n === 1 || n === close ? "ne-cm-fm-fence" : "ne-cm-fm" }).range(line.from))
        // bold the `key:` of a property line (when the caret isn't on it)
        if (n !== 1 && n !== close && !active.has(n)) {
          const ci = line.text.indexOf(":")
          if (ci > 0) out.push(Decoration.mark({ class: "ne-cm-fm-key" }).range(line.from, line.from + ci))
        }
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const raw = isActive(node.from)
        const headingMatch = /^ATXHeading(\d)$/.exec(name)
        if (headingMatch) {
          if (!raw) {
            const lineFrom = state.doc.lineAt(node.from).from
            out.push(Decoration.line({ class: "ne-cm-h" + headingMatch[1] }).range(lineFrom))
          }
          return
        }
        if (name === "Link") {
          if (raw) return false
          const text = state.doc.sliceString(node.from, node.to)
          const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(text)
          if (m) {
            out.push(Decoration.replace({ widget: new LinkWidget(m[2], m[1]) }).range(node.from, node.to))
            return false
          }
          return
        }
        if (raw) return
        if (name === "HeaderMark" || name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          out.push(Decoration.replace({}).range(node.from, node.to))
        } else if (name === "StrongEmphasis") {
          out.push(Decoration.mark({ class: "ne-cm-strong" }).range(node.from, node.to))
        } else if (name === "Emphasis") {
          out.push(Decoration.mark({ class: "ne-cm-em" }).range(node.from, node.to))
        } else if (name === "InlineCode") {
          out.push(Decoration.mark({ class: "ne-cm-code" }).range(node.from, node.to))
        } else if (name === "Strikethrough") {
          out.push(Decoration.mark({ class: "ne-cm-strike" }).range(node.from, node.to))
        }
      },
    })

    // [[wikilinks]] aren't in the markdown grammar — regex pass over visible text.
    const text = state.doc.sliceString(from, to)
    WIKI_RE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = WIKI_RE.exec(text))) {
      const start = from + mm.index
      const end = start + mm[0].length
      if (isActive(start)) continue
      const target = mm[1].trim()
      const alias = (mm[3] != null ? mm[3] : mm[1]).trim()
      out.push(Decoration.replace({ widget: new LinkWidget("/" + target, alias) }).range(start, end))
    }
  }
  return Decoration.set(out, true)
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: any
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: any) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (v: any) => v.decorations },
)

// ── [[ ]] autocomplete (native CM completion popup at the caret) ─────────────
async function wikiComplete(context: any) {
  const before = context.matchBefore(/\[\[[^\]\n]*/)
  if (!before || before.from === before.to) return null
  if (!context.explicit && before.text === "[") return null
  const q = before.text.slice(2).toLowerCase()
  const cands = await loadCandidates()
  const options = cands
    .filter((c) => c.title.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q))
    .slice(0, 12)
    .map((c) => ({ label: c.title, detail: c.slug, type: "link", apply: "[[" + c.slug + "|" + c.title + "]]" }))
  if (!options.length) return null
  return { from: before.from, options, filter: false }
}

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "inherit", fontSize: "1rem", position: "relative" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "inherit",
    lineHeight: "1.6",
    padding: "0",
    caretColor: "var(--secondary)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--secondary)" },
})

// ── QOL: select text + type a pair char ( * _ ` ~ ( [ { " ' ) → wrap it ───────
const WRAP: Record<string, string> = {
  "*": "*", _: "_", "`": "`", "~": "~", "(": ")", "[": "]", "{": "}", '"': '"', "'": "'",
}
const smartWrap = EditorView.inputHandler.of((view, from, to, text) => {
  if (from === to) return false
  const close = WRAP[text]
  if (!close) return false
  const sel = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: text + sel + close },
    selection: EditorSelection.range(from + text.length, from + text.length + sel.length),
    userEvent: "input.type.wrap",
  })
  return true
})

// ── cursor-following, collapsible formatting toolbar ─────────────────────────
// The word (\w run) around a bare cursor, so a toggle with no selection acts on
// the word under the caret (Obsidian behaviour).
function wordAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let s = pos - line.from
  let e = pos - line.from
  while (s > 0 && /\w/.test(text[s - 1])) s--
  while (e < text.length && /\w/.test(text[e])) e++
  return { from: line.from + s, to: line.from + e }
}
// Toggle an inline format, driven by the markdown SYNTAX TREE so it disambiguates
// `**` (strong) from `*` (emphasis) and nests cleanly: if the (word- or
// selection-) range is already inside a node of `typeName`, remove just that
// node's own open/close marks; otherwise wrap with `marker`. Each mod manages
// only its own markers → **bold** +I → ***bold*** +I → **bold**.
function formatToggle(view: EditorView, typeName: string, marker: string) {
  const state = view.state
  view.dispatch(
    state.changeByRange((range) => {
      let from = range.from
      let to = range.to
      if (from === to) {
        const w = wordAt(state, from)
        from = w.from
        to = w.to
      }
      let target: any = null
      for (let n: any = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
        if (n.name === typeName && n.from <= from && n.to >= to) {
          target = n
          break
        }
      }
      if (target) {
        const marks: { from: number; to: number }[] = []
        for (let c: any = target.firstChild; c; c = c.nextSibling) {
          if (c.name.endsWith("Mark")) marks.push({ from: c.from, to: c.to })
        }
        if (marks.length >= 2) {
          const open = marks[0]
          const close = marks[marks.length - 1]
          const lo = open.to - open.from
          return {
            changes: [
              { from: open.from, to: open.to, insert: "" },
              { from: close.from, to: close.to, insert: "" },
            ],
            range: EditorSelection.range(from - lo, to - lo),
          }
        }
      }
      const sel = state.sliceDoc(from, to)
      return {
        changes: { from, to, insert: marker + sel + marker },
        range: EditorSelection.range(from + marker.length, from + marker.length + sel.length),
      }
    }),
  )
  view.focus()
}
function toggleLinePrefix(view: EditorView, prefix: string) {
  const state = view.state
  const changes: any[] = []
  const seen = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      const line = state.doc.line(n)
      if (line.text.startsWith(prefix)) changes.push({ from: line.from, to: line.from + prefix.length, insert: "" })
      else changes.push({ from: line.from, insert: prefix })
    }
  }
  view.dispatch({ changes })
  view.focus()
}
function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const sel = view.state.sliceDoc(range.from, range.to)
      const insert = "[" + sel + "]()"
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length - 1) }
    }),
  )
  view.focus()
}
function insertWiki(view: EditorView) {
  const pos = view.state.selection.main.head
  view.dispatch({ changes: { from: pos, insert: "[[]]" }, selection: EditorSelection.cursor(pos + 2) })
  view.focus()
  startCompletion(view)
}
const TB_BTNS = [
  { t: "Bold", l: "B", run: (v: EditorView) => formatToggle(v, "StrongEmphasis", "**") },
  { t: "Italic", l: "I", run: (v: EditorView) => formatToggle(v, "Emphasis", "*") },
  { t: "Strikethrough", l: "S", run: (v: EditorView) => formatToggle(v, "Strikethrough", "~~") },
  { t: "Inline code", l: "</>", run: (v: EditorView) => formatToggle(v, "InlineCode", "`") },
  { t: "Heading", l: "H", run: (v: EditorView) => toggleLinePrefix(v, "# ") },
  { t: "Quote", l: "❝", run: (v: EditorView) => toggleLinePrefix(v, "> ") },
  { t: "Bulleted list", l: "•", run: (v: EditorView) => toggleLinePrefix(v, "- ") },
  { t: "Numbered list", l: "1.", run: (v: EditorView) => toggleLinePrefix(v, "1. ") },
  { t: "Link", l: "🔗", run: (v: EditorView) => insertLink(v) },
  { t: "Wikilink", l: "[[", run: (v: EditorView) => insertWiki(v) },
]
const cursorToolbar = ViewPlugin.fromClass(
  class {
    view: EditorView
    bar: HTMLElement
    collapsed = false
    raf = 0
    constructor(view: EditorView) {
      this.view = view
      try {
        this.collapsed = localStorage.getItem("ne-tb-collapsed") === "1"
      } catch {}
      this.bar = document.createElement("div")
      this.bar.className = "ne-tb"
      this.render()
      // place() reads layout (coordsAtPos), which CodeMirror forbids DURING an
      // update — so always defer it to an animation frame (outside the update
      // cycle). Lazy attach too: at construction view.dom isn't parented yet.
      this.schedulePlace()
    }
    hostEl(): HTMLElement {
      return (this.view.dom.parentElement as HTMLElement) || this.view.dom
    }
    schedulePlace() {
      if (this.raf) return
      this.raf = requestAnimationFrame(() => {
        this.raf = 0
        this.place()
      })
    }
    render() {
      this.bar.innerHTML = ""
      const toggle = document.createElement("button")
      toggle.className = "ne-tb-toggle"
      toggle.textContent = this.collapsed ? "✎" : "⌄"
      toggle.title = this.collapsed ? "show formatting tools" : "collapse"
      toggle.addEventListener("mousedown", (e) => {
        e.preventDefault()
        this.collapsed = !this.collapsed
        try {
          localStorage.setItem("ne-tb-collapsed", this.collapsed ? "1" : "0")
        } catch {}
        this.render()
        this.place()
      })
      this.bar.appendChild(toggle)
      if (!this.collapsed) {
        for (const b of TB_BTNS) {
          const btn = document.createElement("button")
          btn.className = "ne-tb-btn"
          btn.textContent = b.l
          btn.title = b.t
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault()
            b.run(this.view)
          })
          this.bar.appendChild(btn)
        }
      }
    }
    place() {
      const view = this.view
      const host = this.hostEl()
      // (re)attach to the real host once it's available.
      if (this.bar.parentElement !== host) host.appendChild(this.bar)
      if (!view.hasFocus) {
        this.bar.style.display = "none"
        return
      }
      const head = view.state.selection.main.head
      const coords = view.coordsAtPos(head)
      if (!coords) {
        this.bar.style.display = "none"
        return
      }
      this.bar.style.display = "inline-flex"
      const box = host.getBoundingClientRect()
      let left = coords.left - box.left
      const maxLeft = host.clientWidth - this.bar.offsetWidth - 6
      if (left > maxLeft) left = maxLeft
      if (left < 0) left = 0
      let top = coords.top - box.top - this.bar.offsetHeight - 8
      if (top < 0) top = coords.bottom - box.top + 8 // flip below the caret if no room above
      this.bar.style.left = left + "px"
      this.bar.style.top = top + "px"
    }
    update(u: any) {
      if (u.selectionSet || u.geometryChanged || u.docChanged || u.focusChanged) this.schedulePlace()
    }
    destroy() {
      if (this.raf) cancelAnimationFrame(this.raf)
      this.bar.remove()
    }
  },
)

function makeEditor(parent: HTMLElement, doc: string, onChange: (s: string) => void) {
  return new EditorView({
    parent,
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
      syntaxHighlighting(defaultHighlightStyle),
      livePreview,
      smartWrap,
      cursorToolbar,
      autocompletion({ override: [wikiComplete] }),
      placeholder("Write in markdown — type [[ to link, or select text and hit * ` _ to wrap…"),
      editorTheme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString())
      }),
    ],
  })
}

// ── frontmatter split (edit the body; re-prepend the fm verbatim on save) ────
function splitFrontmatter(raw: string): { fm: string; body: string } {
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4)
    if (end !== -1) {
      const after = end + 4
      const nl = raw.indexOf("\n", after)
      return { fm: raw.slice(0, nl === -1 ? raw.length : nl + 1), body: raw.slice(nl === -1 ? raw.length : nl + 1) }
    }
  }
  return { fm: "", body: raw }
}

function api(path: string) {
  return "/workbench/notes/" + path.split("/").map(encodeURIComponent).join("/")
}

// ── compact markdown → HTML, for hydrating a SOURCE page body with its LIVE
// content (the static leaf isn't recompiled in the preview; in prod the compile
// regenerates it). Injected into <article>, so it inherits Quartz's prose CSS.
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function inlineMd(t: string): string {
  return t
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, tgt, _g, alias) =>
      '<a class="internal" href="/' + String(tgt).trim() + '">' + String((alias != null ? alias : tgt)).trim() + "</a>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
}
function renderMd(src: string): string {
  const lines = escHtml(src || "").split("\n")
  const out: string[] = []
  let para: string[] = []
  let list: string[] = []
  let listType = ""
  let inCode = false
  let code: string[] = []
  const flushP = () => {
    if (para.length) {
      out.push("<p>" + para.map(inlineMd).join("<br>") + "</p>")
      para = []
    }
  }
  const flushL = () => {
    if (list.length) {
      out.push("<" + listType + ">" + list.join("") + "</" + listType + ">")
      list = []
      listType = ""
    }
  }
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push("<pre><code>" + code.join("\n") + "</code></pre>")
        code = []
        inCode = false
      } else {
        flushP()
        flushL()
        inCode = true
      }
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushP()
      flushL()
      out.push("<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">")
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushP()
      flushL()
      out.push("<blockquote>" + inlineMd(line.replace(/^\s*>\s?/, "")) + "</blockquote>")
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushP()
      if (listType !== "ul") {
        flushL()
        listType = "ul"
      }
      list.push("<li>" + inlineMd(line.replace(/^\s*[-*]\s+/, "")) + "</li>")
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushP()
      if (listType !== "ol") {
        flushL()
        listType = "ol"
      }
      list.push("<li>" + inlineMd(line.replace(/^\s*\d+\.\s+/, "")) + "</li>")
      continue
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushP()
      flushL()
      out.push("<hr>")
      continue
    }
    if (line.trim() === "") {
      flushP()
      flushL()
      continue
    }
    para.push(line)
  }
  flushP()
  flushL()
  if (inCode && code.length) out.push("<pre><code>" + code.join("\n") + "</code></pre>")
  return out.join("\n")
}

// ── per-page wiring: edit-in-place on note AND source pages; create on hubs ──
document.addEventListener("nav", () => {
  // Any navigation re-enables the dev hot-reload (the viewer's `quartz build
  // --serve` hard-reloads on every vault change). We suppress it ONLY while a
  // CM editor is open (the injected reload client checks window.__neEditing —
  // patched in the viewer Dockerfile), so autosave persists without flashing.
  ;(window as any).__neEditing = false
  hideLinkPopover() // never let an in-editor popover survive a navigation

  // (1) Edit-in-place on any editable target — a user NOTE or a SOURCE. Found
  // page-wide (the source edit button is rendered by the SourceEditor card,
  // outside the notes root) so the SAME CodeMirror editor drives both kinds.
  const editBtn = document.querySelector("[data-wb-edit]") as HTMLElement | null
  if (editBtn && !editBtn.dataset.neWired) {
    editBtn.dataset.neWired = "1"
    const kind = editBtn.dataset.editKind || "note"
    const isSource = kind === "source"
    const apiPath = editBtn.dataset.notePath || ""
    const sourceId = editBtn.dataset.sourceId || ""
    const article = document.querySelector("article") as HTMLElement | null
    const origLabel = editBtn.textContent || (isSource ? "✎ Edit this source" : "✎ Edit this note")
    let view: EditorView | null = null
    let host: HTMLElement | null = null
    let toolbar: HTMLElement | null = null
    let statusEl: HTMLElement | null = null
    let fm = ""
    // Composes the file content from the body — replaced in enterEdit() with one
    // that serializes the editable frontmatter properties panel.
    let composeContent: (b: string) => string = (b) => fm + b
    let lastHash: string | null = null
    let timer: any = null

    const setStatus = (t: string) => {
      if (statusEl) statusEl.textContent = t
    }
    // Sources PATCH the working head (a revision commits at the next compile);
    // notes PUT the vault file (If-Match optimistic concurrency).
    const saveUrl = () =>
      isSource ? "/workbench/sources/" + encodeURIComponent(sourceId) : api(apiPath)
    const savePayload = (content: string) =>
      isSource ? { content } : (lastHash ? { content, if_match: lastHash } : { content })
    const save = async (body: string, commitNow?: boolean) => {
      const content = composeContent(body)
      // Notes: autosave is a working draft (no git commit); Done adds ?commit=1
      // to record an authored revision. Sources PATCH the head (commit at compile).
      const url = isSource ? saveUrl() : api(apiPath) + (commitNow ? "?commit=1" : "")
      try {
        const r = await fetch(url, {
          method: isSource ? "PATCH" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(savePayload(content)),
        })
        const j = await r.json().catch(() => ({}))
        if (r.ok) {
          if (!isSource) lastHash = j.hash
          setStatus(
            isSource
              ? "✓ saved (working draft — a revision commits at the next compile)"
              : "✓ saved (draft — use “Commit now” to add a revision, or it commits at the next compile)",
          )
          if (!isSource) document.dispatchEvent(new CustomEvent("workbench-note-saved"))
        } else if (r.status === 409) {
          setStatus("⚠ changed elsewhere — reopen to merge")
        } else {
          setStatus("✗ " + (j.error || "HTTP " + r.status))
        }
      } catch (e: any) {
        setStatus("✗ " + (e && e.message ? e.message : e))
      }
    }
    const flush = () => {
      if (!view) return
      const content = composeContent(view.state.doc.toString())
      // keepalive lets the save outlive a navigation away mid-edit.
      fetch(saveUrl(), {
        method: isSource ? "PATCH" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(savePayload(content)),
        keepalive: true,
      }).catch(() => {})
    }
    const exitEdit = async () => {
      if (!view) return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      setStatus("saving…")
      const body = view.state.doc.toString()
      // Done just saves the working draft; committing is DELIBERATE ("Commit
      // now" on the revision card) or caught at the next compile.
      await save(body)
      hideLinkPopover()
      window.removeEventListener("beforeunload", flush)
      ;(window as any).__neEditing = false
      if (isSource) {
        // Re-render the body from the saved content so the edit is visible
        // immediately (the static leaf isn't recompiled in the preview; in prod
        // the compile regenerates it identically). No reload.
        view.destroy()
        view = null
        if (host) {
          host.remove()
          host = null
        }
        if (article) {
          article.style.display = ""
          article.innerHTML = renderMd(composeContent(body))
        }
        editBtn.textContent = origLabel
        editBtn.classList.remove("ne-editing")
        setStatus("✓ saved (working draft — a revision commits at the next compile)")
        // refresh the SourceRevisions card (its uncommitted diff updates live)
        document.dispatchEvent(new CustomEvent("workbench-source-saved"))
      } else {
        // Notes: reload once to render the saved note (hot-reloads were
        // suppressed while editing) — a single refresh, not a per-keystroke flash.
        location.reload()
      }
    }
    const enterEdit = async () => {
      if (view) return exitEdit()
      setStatus("loading…")
      let raw = ""
      if (isSource) {
        try {
          const j = await (await fetch(saveUrl())).json()
          raw = (j.source && j.source.content) || ""
        } catch {
          /* start blank */
        }
      } else {
        try {
          const j = await (await fetch(api(apiPath))).json()
          raw = j.content || ""
          lastHash = j.hash
        } catch {
          /* new/missing — start blank */
        }
      }
      host = document.createElement("div")
      host.className = "ne-cm-host"
      if (article) {
        article.style.display = "none"
        article.parentElement!.insertBefore(host, article)
      } else {
        document.body.appendChild(host)
      }

      // Frontmatter is edited INLINE in the editor (operator preference): the
      // whole file — including the `---` block — IS the document, so save writes
      // it back verbatim (composeContent stays identity). The fm block renders as
      // a styled, muted region via the live-preview decorations, with the actual
      // current values shown (edit tags etc. in place; nothing is defaulted).
      view = makeEditor(host, raw, (body) => {
        setStatus("editing…")
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => save(body), 1500)
      })
      view.focus()
      // Suppress dev hot-reload while the editor is open; flush on unload.
      ;(window as any).__neEditing = true
      window.addEventListener("beforeunload", flush)
      editBtn.textContent = "✓ Done editing"
      editBtn.classList.add("ne-editing")
      setStatus("")
    }

    statusEl = document.createElement("span")
    statusEl.className = "ne-status"
    if (article && article.parentElement) {
      // Relocate the Edit button into a toolbar ABOVE the article (over content)
      // — same UX for notes AND sources. (Export lives in the global PageTools.)
      toolbar = document.createElement("div")
      toolbar.className = "ne-toolbar"
      article.parentElement.insertBefore(toolbar, article)
      toolbar.appendChild(editBtn)
      toolbar.appendChild(statusEl)
    } else {
      editBtn.insertAdjacentElement("afterend", statusEl)
    }
    editBtn.addEventListener("click", () => (view ? exitEdit() : enterEdit()))

    // Sources: hydrate the body with the LIVE content so what you see equals
    // what you edit (the static leaf can be stale in the preview / between
    // compiles), and RE-hydrate on any source save — inline edit OR re-upload.
    if (isSource && article) {
      const hydrateBody = () => {
        fetch(saveUrl())
          .then((r) => r.json())
          .then((j) => {
            const c = j && j.source && j.source.content
            if (c != null && !view) article.innerHTML = renderMd(c)
          })
          .catch(() => {})
      }
      hydrateBody()
      document.addEventListener("workbench-source-saved", hydrateBody)
    }

    // Auto-enter edit when we just created this note (see create flow below).
    try {
      const auto = sessionStorage.getItem("ne-autoedit")
      if (auto && apiPath && (auto === apiPath || auto === editBtn.dataset.noteSlug)) {
        sessionStorage.removeItem("ne-autoedit")
        enterEdit()
      }
    } catch {
      /* ignore */
    }
  }

  // (2) Create a new note from a notebook hub (lightweight inline input).
  const root = document.querySelector("[data-notes-root]") as HTMLElement | null
  const launch = root ? (root.querySelector("[data-ne-launch]") as HTMLElement | null) : null
  if (launch && root && !launch.dataset.neWired) {
    launch.dataset.neWired = "1"
    const nbSlug = root.dataset.notebookSlug || ""
    const nbName = root.dataset.notebookName || ""
    const wrap = document.createElement("span")
    wrap.className = "ne-create"
    const input = document.createElement("input")
    input.placeholder = "new note title…"
    input.className = "ne-create-input"
    input.hidden = true
    launch.after(wrap)
    wrap.appendChild(input)

    const slugify = (s: string) =>
      (s || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")

    const create = async () => {
      const title = input.value.trim()
      if (!title) {
        input.hidden = true
        return
      }
      const fileSlug = slugify(title) || "note"
      // Notebook context → notes/notebooks/<nb>/…; otherwise a flat notes/… note.
      const path = (nbSlug ? "notebooks/" + nbSlug + "/" : "") + fileSlug + ".md"
      const content =
        ["---", "title: " + JSON.stringify(title), "source: user_note", "notebook: " + JSON.stringify(nbName), "tags: [note]", "---", "", ""].join("\n")
      launch.textContent = "creating…"
      // Suppress the hub's hot-reload so the create→navigate hop isn't interrupted.
      ;(window as any).__neEditing = true
      try {
        const r = await fetch(api(path), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        })
        if (!r.ok) throw new Error("HTTP " + r.status)
        // The new page exists after Quartz rebuilds (~1s). Navigate to it and
        // auto-open the editor on arrival (nav resets __neEditing).
        try {
          sessionStorage.setItem("ne-autoedit", path)
        } catch {
          /* ignore */
        }
        const href = "/notes/" + path.replace(/\.md$/, "")
        launch.textContent = "✎ Write a note"
        input.hidden = true
        input.value = ""
        setTimeout(() => {
          window.location.href = href
        }, 1500)
      } catch (e: any) {
        ;(window as any).__neEditing = false
        launch.textContent = "✗ " + (e && e.message ? e.message : e)
      }
    }
    launch.addEventListener("click", () => {
      input.hidden = !input.hidden
      if (!input.hidden) input.focus()
    })
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        create()
      } else if (e.key === "Escape") {
        input.hidden = true
      }
    })
  }
})
