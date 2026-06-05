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
import { EditorState } from "@codemirror/state"
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxTree, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language"
import { autocompletion } from "@codemirror/autocomplete"

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
        if (name === "HeaderMark" || name === "EmphasisMark" || name === "CodeMark") {
          out.push(Decoration.replace({}).range(node.from, node.to))
        } else if (name === "StrongEmphasis") {
          out.push(Decoration.mark({ class: "ne-cm-strong" }).range(node.from, node.to))
        } else if (name === "Emphasis") {
          out.push(Decoration.mark({ class: "ne-cm-em" }).range(node.from, node.to))
        } else if (name === "InlineCode") {
          out.push(Decoration.mark({ class: "ne-cm-code" }).range(node.from, node.to))
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
  "&": { backgroundColor: "transparent", color: "inherit", fontSize: "1rem" },
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

function makeEditor(parent: HTMLElement, doc: string, onChange: (s: string) => void) {
  return new EditorView({
    parent,
    doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle),
      livePreview,
      autocompletion({ override: [wikiComplete] }),
      placeholder("Write in markdown — type [[ to link to another page…"),
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

// ── per-page wiring: edit-in-place on note pages, create on notebook hubs ────
document.addEventListener("nav", () => {
  // Any navigation re-enables the dev hot-reload (the viewer's `quartz build
  // --serve` hard-reloads on every vault change). We suppress it ONLY while a
  // CM editor is open (the injected reload client checks window.__neEditing —
  // patched in the viewer Dockerfile), so autosave persists without flashing.
  ;(window as any).__neEditing = false
  const root = document.querySelector("[data-notes-root]") as HTMLElement | null
  if (!root) return

  // (1) Edit-in-place on a user-note page.
  const editBtn = root.querySelector("[data-ne-edit]") as HTMLElement | null
  if (editBtn && !editBtn.dataset.neWired) {
    editBtn.dataset.neWired = "1"
    const apiPath = editBtn.dataset.notePath || ""
    const article = document.querySelector("article") as HTMLElement | null
    let view: EditorView | null = null
    let host: HTMLElement | null = null
    let toolbar: HTMLElement | null = null
    let statusEl: HTMLElement | null = null
    let fm = ""
    let lastHash: string | null = null
    let timer: any = null

    const setStatus = (t: string) => {
      if (statusEl) statusEl.textContent = t
    }
    const save = async (body: string) => {
      const content = fm + body
      try {
        const r = await fetch(api(apiPath), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(lastHash ? { content, if_match: lastHash } : { content }),
        })
        const j = await r.json().catch(() => ({}))
        if (r.ok) {
          lastHash = j.hash
          setStatus("✓ saved")
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
      const content = fm + view.state.doc.toString()
      // keepalive lets the save outlive a navigation away mid-edit.
      fetch(api(apiPath), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lastHash ? { content, if_match: lastHash } : { content }),
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
      await save(view.state.doc.toString())
      window.removeEventListener("beforeunload", flush)
      ;(window as any).__neEditing = false
      // Reload once to render the saved note (hot-reloads were suppressed while
      // editing) — a single refresh on Done, not a flash on every keystroke.
      location.reload()
    }
    const enterEdit = async () => {
      if (view) return exitEdit()
      setStatus("loading…")
      let raw = ""
      try {
        const j = await (await fetch(api(apiPath))).json()
        raw = j.content || ""
        lastHash = j.hash
      } catch {
        /* new/missing — start blank */
      }
      const split = splitFrontmatter(raw)
      fm = split.fm
      host = document.createElement("div")
      host.className = "ne-cm-host"
      if (article) {
        article.style.display = "none"
        article.parentElement!.insertBefore(host, article)
      } else {
        root.appendChild(host)
      }
      view = makeEditor(host, split.body, (body) => {
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

    // Relocate the Edit button into a toolbar ABOVE the article (over content).
    toolbar = document.createElement("div")
    toolbar.className = "ne-toolbar"
    statusEl = document.createElement("span")
    statusEl.className = "ne-status"
    if (article && article.parentElement) {
      article.parentElement.insertBefore(toolbar, article)
      toolbar.appendChild(editBtn)
      toolbar.appendChild(statusEl)
    }
    editBtn.addEventListener("click", () => (view ? exitEdit() : enterEdit()))

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
  const launch = root.querySelector("[data-ne-launch]") as HTMLElement | null
  if (launch && !launch.dataset.neWired) {
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
      if (!title || !nbSlug) {
        input.hidden = true
        return
      }
      const fileSlug = slugify(title) || "note"
      const path = "notebooks/" + nbSlug + "/" + fileSlug + ".md"
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
