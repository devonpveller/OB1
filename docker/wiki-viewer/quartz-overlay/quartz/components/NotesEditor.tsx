// NotesEditor (P3.5) — an in-Quartz markdown editor for the author-owned notes
// layer. Live preview + Obsidian-style `[[ ]]` autocomplete (candidates from
// Quartz's own contentIndex, so authors link to an EXISTING page/notebook, not
// a fat-fingered near-duplicate — plan §3.5). Writes user notes to
// notes/notebooks/<notebook-slug>/<file-slug>.md via PUT /workbench/notes
// (the sanctioned vault-commit write path; optimistic concurrency via If-Match).
// AI notes use the SAME backend surface (POST /workbench/notes) but land on the
// content/ side — this editor is the HUMAN entry point only (#4/#5/#11).
//
// Opened by the "✎ Write a note" launcher (notebook hubs) or the
// `open-notes-editor` CustomEvent (detail {notebook, slug, path}). A modal
// shadowbox, NOT an always-on widget (#6). Inits on Quartz's "nav" event.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const NotesEditor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  const showLauncher = fm.type === "notebook"
  return (
    <div
      class={`notes-editor-root ${displayClass ?? ""}`}
      data-notes-root
      data-notebook-id={String(fm.thread_id ?? "")}
      data-notebook-slug={String(fm.slug ?? "")}
      data-notebook-name={String(fm.title ?? "")}
    >
      {showLauncher ? <button class="ne-launch" data-ne-launch>✎ Write a note</button> : null}
      <div class="ne-overlay" data-notes-modal hidden>
        <div class="ne-backdrop" data-ne-close></div>
        <div class="ne-box" role="dialog" aria-modal="true">
          <button class="ne-x" data-ne-close aria-label="close">×</button>
          <h3 class="ne-title" data-ne-heading>Write a note</h3>
          <div class="ne-meta">
            <label class="ne-nb-label">Notebook
              <select data-ne-notebook><option value="">(none)</option></select>
            </label>
            <label class="ne-title-label">Title
              <input class="ne-name" data-ne-name placeholder="note title" />
            </label>
          </div>
          <div class="ne-split">
            <div class="ne-pane ne-edit-pane">
              <div class="ne-pane-h">Markdown — type <code>[[</code> to link</div>
              <textarea class="ne-area" data-ne-area placeholder="Write in markdown. Use [[ to link to an existing page or notebook…" spellcheck="true"></textarea>
              <div class="ne-ac" data-ne-ac hidden></div>
            </div>
            <div class="ne-pane ne-preview-pane">
              <div class="ne-pane-h">Preview</div>
              <div class="ne-preview" data-ne-preview></div>
            </div>
          </div>
          <div class="ne-footer">
            <div class="ne-status" data-ne-status></div>
            <button class="ne-save" data-ne-save>Save note</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// All client logic. NOTE: this is emitted as a STRING and re-parsed as JS, so
// every literal backslash must be DOUBLED here (regex `\\s`, unicode `\\u0300`,
// newline `"\\n"`); backticks are avoided (built via String.fromCharCode(96)).
NotesEditor.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-notes-root]")
  if (!root || root.dataset.neInit) return
  root.dataset.neInit = "1"
  const modal = root.querySelector("[data-notes-modal]")
  const heading = root.querySelector("[data-ne-heading]")
  const nbSel = root.querySelector("[data-ne-notebook]")
  const nameEl = root.querySelector("[data-ne-name]")
  const area = root.querySelector("[data-ne-area]")
  const ac = root.querySelector("[data-ne-ac]")
  const preview = root.querySelector("[data-ne-preview]")
  const status = root.querySelector("[data-ne-status]")
  const saveBtn = root.querySelector("[data-ne-save]")
  const BT = String.fromCharCode(96)
  let currentHash = null      // If-Match hash for the loaded note (null = new)
  let editingPath = null      // explicit path when editing an existing note

  const slugify = (s) => (s || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

  // ── populate notebook dropdown (value=id, data-slug carries the PINNED slug) ──
  const seedNb = { id: root.dataset.notebookId || "", slug: root.dataset.notebookSlug || "", name: root.dataset.notebookName || "" }
  fetch("/workbench/notebooks").then(r => r.json()).then(j => {
    (j.notebooks || []).forEach(nb => {
      const o = document.createElement("option")
      o.value = nb.id; o.textContent = nb.name; o.dataset.slug = nb.slug || slugify(nb.name)
      nbSel.appendChild(o)
    })
    if (seedNb.id) nbSel.value = seedNb.id
  }).catch(() => {})

  // ── markdown → html (compact live-preview renderer) ──
  const codeRe = new RegExp(BT + "([^" + BT + "]+)" + BT, "g")
  const inl = (t) => t
    .replace(/\\[\\[([^\\]|]+)(\\|([^\\]]+))?\\]\\]/g, (m, a, b, c) => '<a class="ne-wl" href="/' + a.trim() + '">' + ((c != null ? c : a).trim()) + '</a>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
    .replace(codeRe, '<code>$1</code>')
  const render = (src) => {
    const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const lines = esc.split("\\n")
    const out = []; let list = null; let para = []
    const flushPara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = [] } }
    const flushList = () => { if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null } }
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\\s+(.*)$/)
      if (h) { flushPara(); flushList(); const n = h[1].length; out.push("<h" + n + ">" + inl(h[2]) + "</h" + n + ">"); continue }
      const li = line.match(/^\\s*[-*]\\s+(.*)$/)
      if (li) { flushPara(); if (!list) list = []; list.push("<li>" + inl(li[1]) + "</li>"); continue }
      if (line.trim() === "") { flushPara(); flushList(); continue }
      flushList(); para.push(inl(line))
    }
    flushPara(); flushList()
    return out.join("\\n")
  }
  const repaint = () => { preview.innerHTML = render(area.value) }

  // ── [[ ]] autocomplete (candidates from Quartz's contentIndex) ──
  let candidates = null; let acItems = []; let acSel = -1; let acStart = -1
  const loadCandidates = async () => {
    if (candidates) return candidates
    try {
      const idx = await (await fetch("/static/contentIndex.json")).json()
      candidates = Object.keys(idx).map(slug => ({ slug, title: (idx[slug] && idx[slug].title) || slug }))
        .filter(c => c.slug && c.slug !== "index" && !c.slug.endsWith("/index"))
    } catch (e) { candidates = [] }
    return candidates
  }
  const hideAc = () => { ac.hidden = true; acItems = []; acSel = -1; acStart = -1 }
  const renderAc = (q) => {
    const ql = q.toLowerCase()
    acItems = (candidates || []).filter(c => c.title.toLowerCase().includes(ql) || c.slug.toLowerCase().includes(ql)).slice(0, 10)
    if (!acItems.length) { hideAc(); return }
    acSel = 0
    ac.innerHTML = ""
    acItems.forEach((c, i) => {
      const d = document.createElement("div")
      d.className = "ne-ac-item" + (i === 0 ? " ne-ac-on" : "")
      d.innerHTML = "<strong>" + c.title.replace(/</g, "&lt;") + "</strong> <span class='ne-ac-slug'>" + c.slug.replace(/</g, "&lt;") + "</span>"
      d.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickAc(i) })
      ac.appendChild(d)
    })
    ac.hidden = false
  }
  const pickAc = (i) => {
    const c = acItems[i]; if (!c) return
    const before = area.value.slice(0, acStart)
    const after = area.value.slice(area.selectionStart)
    const insert = "[[" + c.slug + "|" + c.title + "]]"
    area.value = before + insert + after
    const pos = (before + insert).length
    area.focus(); area.setSelectionRange(pos, pos)
    hideAc(); repaint()
  }
  const updateAc = () => {
    const upto = area.value.slice(0, area.selectionStart)
    const open = upto.lastIndexOf("[[")
    if (open === -1) { hideAc(); return }
    const frag = upto.slice(open + 2)
    if (frag.indexOf("]") !== -1 || frag.indexOf("\\n") !== -1 || frag.length > 80) { hideAc(); return }
    acStart = open
    loadCandidates().then(() => renderAc(frag))
  }
  const moveAc = (delta) => {
    if (ac.hidden || !acItems.length) return
    acSel = (acSel + delta + acItems.length) % acItems.length
    ac.querySelectorAll(".ne-ac-item").forEach((el, i) => el.classList.toggle("ne-ac-on", i === acSel))
  }
  area.addEventListener("input", () => { repaint(); updateAc() })
  area.addEventListener("keydown", (e) => {
    if (ac.hidden) return
    if (e.key === "ArrowDown") { e.preventDefault(); moveAc(1) }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveAc(-1) }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickAc(acSel) }
    else if (e.key === "Escape") { e.preventDefault(); hideAc() }
  })

  // ── frontmatter compose / parse ──
  const parseNote = (raw) => {
    let title = ""; let body = raw
    if (raw.slice(0, 4) === "---\\n") {
      const end = raw.indexOf("\\n---", 4)
      if (end !== -1) {
        const fmBlock = raw.slice(4, end)
        const m = fmBlock.match(/^title:\\s*(.+)$/m)
        if (m) { title = m[1].trim().replace(/^["']|["']$/g, "") }
        body = raw.slice(end + 4).replace(/^\\n+/, "")
      }
    }
    return { title, body }
  }
  const compose = (title, nbName, body) => {
    return ["---", 'title: ' + JSON.stringify(title || "Untitled note"), "source: user_note", 'notebook: ' + JSON.stringify(nbName || ""), "tags: [note]", "---", "", body.replace(/\\s+$/, ""), ""].join("\\n")
  }

  // ── open / close ──
  const open = async (opts) => {
    opts = opts || {}
    status.textContent = ""; currentHash = null; editingPath = opts.path || null
    nbSel.value = opts.notebook || seedNb.id || ""
    if (editingPath) {
      heading.textContent = "Edit note"
      status.textContent = "loading…"
      try {
        const r = await fetch("/workbench/notes/" + editingPath.split("/").map(encodeURIComponent).join("/"))
        if (r.ok) { const j = await r.json(); currentHash = j.hash; const p = parseNote(j.content); nameEl.value = p.title; area.value = p.body; status.textContent = "" }
        else { status.textContent = "could not load note (" + r.status + ")"; nameEl.value = ""; area.value = "" }
      } catch (e) { status.textContent = "load failed: " + (e && e.message ? e.message : e) }
    } else {
      heading.textContent = "Write a note"
      nameEl.value = ""; area.value = ""
    }
    repaint(); hideAc()
    modal.hidden = false
    setTimeout(() => nameEl.focus(), 30)
  }
  const close = () => { modal.hidden = true; hideAc() }
  const launch = root.querySelector("[data-ne-launch]")
  if (launch) launch.addEventListener("click", () => open({ notebook: seedNb.id }))
  root.querySelectorAll("[data-ne-close]").forEach(b => b.addEventListener("click", close))
  document.addEventListener("open-notes-editor", (e) => open((e && e.detail) || {}))
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden && ac.hidden) close() })

  // ── save ──
  saveBtn.addEventListener("click", async () => {
    const title = nameEl.value.trim()
    if (!title) { status.textContent = "give the note a title"; return }
    const opt = nbSel.selectedOptions[0]
    const nbSlug = (opt && opt.dataset.slug) || seedNb.slug || slugify(opt ? opt.textContent : "")
    const nbName = (opt && opt.textContent) || seedNb.name || ""
    if (!nbSlug) { status.textContent = "pick a notebook"; return }
    const path = editingPath || ("notebooks/" + nbSlug + "/" + (slugify(title) || "note") + ".md")
    const content = compose(title, nbName, area.value)
    status.textContent = "saving…"; saveBtn.disabled = true
    try {
      const r = await fetch("/workbench/notes/" + path.split("/").map(encodeURIComponent).join("/"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentHash ? { content, if_match: currentHash } : { content })
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 409) { status.textContent = "✗ edit conflict — this note changed elsewhere. Copy your text, reopen, and reapply."; saveBtn.disabled = false; return }
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status))
      currentHash = j.hash; editingPath = path
      const href = "/notes/" + path.replace(/\\.md$/, "")
      status.innerHTML = "✓ saved to <code>notes/" + path + "</code> — <a href='" + href + "'>open</a> (visible after the next compile)."
    } catch (e) { status.textContent = "✗ save failed: " + (e && e.message ? e.message : e) }
    saveBtn.disabled = false
  })
})
`

NotesEditor.css = `
.notes-editor-root { display: inline-block; }
.notes-editor-root .ne-launch { font-size: .85rem; padding: .3rem .7rem; border: 1px solid var(--secondary); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; margin-left: .4rem; }
.ne-overlay { position: fixed; inset: 0; z-index: 1001; display: flex; align-items: center; justify-content: center; }
.ne-overlay[hidden] { display: none; }
.ne-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
.ne-box { position: relative; background: var(--light); color: var(--dark); width: min(900px, 94vw); max-height: 90vh; overflow: auto; padding: 1.25rem 1.5rem; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.ne-box .ne-x { position: absolute; top: .5rem; right: .75rem; font-size: 1.4rem; background: none; border: 0; cursor: pointer; color: var(--gray); }
.ne-box .ne-title { margin: 0 0 .6rem; font-size: 1.05rem; }
.ne-box .ne-meta { display: flex; gap: .75rem; margin-bottom: .6rem; flex-wrap: wrap; }
.ne-box .ne-nb-label, .ne-box .ne-title-label { display: flex; flex-direction: column; font-size: .72rem; color: var(--gray); gap: .15rem; }
.ne-box .ne-title-label { flex: 1; min-width: 200px; }
.ne-box .ne-name { padding: .35rem .5rem; }
.ne-box select[data-ne-notebook] { padding: .35rem .5rem; }
.ne-split { display: flex; gap: .75rem; }
.ne-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ne-pane-h { font-size: .68rem; color: var(--gray); text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; }
.ne-pane-h code { font-size: .85em; }
.ne-edit-pane { position: relative; }
.ne-area { width: 100%; min-height: 320px; resize: vertical; padding: .6rem; font-family: var(--codeFont); font-size: .85rem; line-height: 1.5; border: 1px solid var(--lightgray); border-radius: 6px; box-sizing: border-box; }
.ne-ac { position: absolute; left: .5rem; right: .5rem; bottom: .5rem; max-height: 200px; overflow: auto; background: var(--light); border: 1px solid var(--secondary); border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,.25); z-index: 5; }
.ne-ac[hidden] { display: none; }
.ne-ac-item { padding: .35rem .5rem; cursor: pointer; font-size: .8rem; display: flex; justify-content: space-between; gap: .5rem; }
.ne-ac-item.ne-ac-on, .ne-ac-item:hover { background: var(--lightgray); }
.ne-ac-slug { color: var(--gray); font-size: .72rem; font-family: var(--codeFont); }
.ne-preview { border: 1px solid var(--lightgray); border-radius: 6px; padding: .6rem .8rem; min-height: 320px; overflow: auto; font-size: .9rem; }
.ne-preview h1, .ne-preview h2, .ne-preview h3 { margin: .4rem 0 .3rem; }
.ne-preview p { margin: .35rem 0; }
.ne-preview .ne-wl { color: var(--secondary); }
.ne-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: .75rem; }
.ne-status { font-size: .8rem; min-height: 1.2em; color: var(--gray); }
.ne-status code { font-size: .82em; }
.ne-save { font-size: .9rem; padding: .4rem 1rem; border: 0; background: var(--secondary); color: var(--light); border-radius: 6px; cursor: pointer; }
.ne-save:disabled { opacity: .5; cursor: default; }
@media (max-width: 700px) { .ne-split { flex-direction: column; } }
`

export default (() => NotesEditor) satisfies QuartzComponentConstructor
