// NotebookPage (P2.7) — the live, hydrated section of a notebook hub. The
// compiler bakes the static shell (title, synthesis, a snapshot of sources/
// notes); THIS component hydrates the *interactive* view from the workbench so
// add/remove/triage reflect instantly and degrade to the baked snapshot if the
// API is down (plan §12.4). Keys off the baked frontmatter ids (G12: thread_id
// + slug) — never URL-parsing. Plain-DOM hydration on Quartz's "nav" event.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const NotebookPage: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "notebook" || fm.thread_id == null) return null
  return (
    <div
      class={`notebook-page ${displayClass ?? ""}`}
      data-notebook-page
      data-thread-id={String(fm.thread_id)}
      data-slug={String(fm.slug ?? "")}
    >
      <div class="nbp-head">
        <span class="nbp-title">📓 Notebook — live</span>
        <span class="nbp-status" data-nbp-status>loading…</span>
      </div>
      <section class="nbp-sec" data-nbp-sources hidden>
        <h3 class="nbp-h">
          Sources <span class="nbp-count" data-nbp-src-count></span>
          <button class="nbp-add" data-nbp-add>+ Add source</button>
          <button class="nbp-copy" data-nbp-copy hidden>⧉ copy</button>
        </h3>
        <p class="nbp-help">
          Linked sources are this notebook's <strong>evidence</strong>: on the next wiki compile they
          ground its generated synthesis (the page text above) with real material, and they appear here
          and on the hub. Unlinking removes a source from <em>this</em> notebook only — it stays in its
          other notebooks and in generation, and isn't deleted.
        </p>
        <ul class="nbp-list" data-nbp-src-list></ul>
      </section>
      <section class="nbp-sec" data-nbp-suggestions hidden>
        <h3 class="nbp-h">Suggested sources <span class="nbp-count" data-nbp-sug-count></span></h3>
        <ul class="nbp-list" data-nbp-sug-list></ul>
      </section>
      <section class="nbp-sec" data-nbp-notes hidden>
        <h3 class="nbp-h">Notes</h3>
        <div class="nbp-notes-group" data-nbp-notes-user></div>
        <div class="nbp-notes-group" data-nbp-notes-ai></div>
      </section>
    </div>
  )
}

NotebookPage.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-notebook-page]")
  if (!root || root.dataset.nbpInit) return
  root.dataset.nbpInit = "1"
  const threadId = root.dataset.threadId
  const slug = root.dataset.slug
  const status = root.querySelector("[data-nbp-status]")
  const nb = "/workbench/notebooks/" + encodeURIComponent(threadId)

  const setCount = (el, n) => { if (el) el.textContent = "(" + n + ")" }

  // ── Sources (confirmed membership; unlink = soft hide, not deletion) ──
  const renderSources = (sources) => {
    const sec = root.querySelector("[data-nbp-sources]")
    const list = root.querySelector("[data-nbp-src-list]")
    list.innerHTML = ""
    setCount(root.querySelector("[data-nbp-src-count]"), sources.length)
    sec.hidden = false
    const copyBtn = root.querySelector("[data-nbp-copy]")
    copyBtn.hidden = sources.length === 0
    copyBtn.onclick = () => {
      const lines = sources.map((s, i) => "[" + (i + 1) + "] " + (s.title || s.url || s.id) + (s.url ? ". " + s.url : "."))
      navigator.clipboard.writeText(lines.join("\\n")).then(() => { copyBtn.textContent = "✓ copied"; setTimeout(() => copyBtn.textContent = "⧉ copy", 1200) }).catch(() => { status.textContent = "copy blocked" })
    }
    if (!sources.length) { list.innerHTML = "<li class='nbp-empty'>no sources linked yet — use “+ Add source”.</li>"; return }
    sources.forEach(s => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"
      a.href = "/content/source/" + s.id
      a.textContent = s.title || s.url || s.id
      li.appendChild(a)
      if (s.content_type) { const ct = document.createElement("span"); ct.className = "nbp-ct"; ct.textContent = s.content_type; li.appendChild(ct) }
      const rm = document.createElement("button")
      rm.className = "nbp-btn nbp-unlink"
      rm.textContent = "unlink"
      rm.title = "remove from this notebook (stays in its other notebooks + in generation)"
      rm.addEventListener("click", async () => {
        const sure = window.confirm(
          "Unlink “" + (s.title || s.id) + "” from this notebook?\\n\\n" +
          "This removes it from THIS notebook only — the source stays in any other notebooks it belongs to and keeps feeding wiki generation. It is not deleted and can be re-added later."
        )
        if (!sure) return
        rm.disabled = true; rm.textContent = "…"
        try {
          const r = await fetch(nb + "/sources/" + encodeURIComponent(s.id), { method: "DELETE" })
          if (!r.ok) throw new Error("HTTP " + r.status)
          li.remove()
          setCount(root.querySelector("[data-nbp-src-count]"), list.children.length)
        } catch (e) { rm.disabled = false; rm.textContent = "unlink"; status.textContent = "✗ unlink failed" }
      })
      li.appendChild(rm)
      list.appendChild(li)
    })
  }

  // ── Suggestions (cross-notebook proposals → accept / hide) ──
  const renderSuggestions = (suggestions) => {
    const sec = root.querySelector("[data-nbp-suggestions]")
    const list = root.querySelector("[data-nbp-sug-list]")
    list.innerHTML = ""
    setCount(root.querySelector("[data-nbp-sug-count]"), suggestions.length)
    sec.hidden = suggestions.length === 0
    suggestions.forEach(s => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"
      a.href = "/content/source/" + s.id
      a.textContent = s.title || s.url || s.id
      li.appendChild(a)
      if (s.suggestion_reason) { const why = document.createElement("span"); why.className = "nbp-why"; why.textContent = s.suggestion_reason; li.appendChild(why) }
      const triage = async (action, label) => {
        li.querySelectorAll("button").forEach(b => b.disabled = true)
        try {
          const r = await fetch(nb + "/suggestions/" + encodeURIComponent(s.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })
          if (!r.ok) throw new Error("HTTP " + r.status)
          li.remove()
          setCount(root.querySelector("[data-nbp-sug-count]"), list.children.length)
          if (!list.children.length) sec.hidden = true
          if (action === "accept") refresh() // surface it under Sources
        } catch (e) { li.querySelectorAll("button").forEach(b => b.disabled = false); status.textContent = "✗ " + label + " failed" }
      }
      const ok = document.createElement("button"); ok.className = "nbp-btn nbp-accept"; ok.textContent = "accept"; ok.addEventListener("click", () => triage("accept", "accept"))
      const no = document.createElement("button"); no.className = "nbp-btn nbp-hide"; no.textContent = "hide"; no.title = "won’t be re-proposed"; no.addEventListener("click", () => triage("hide", "hide"))
      li.appendChild(ok); li.appendChild(no)
      list.appendChild(li)
    })
  }

  // ── Notes (this notebook's user notes vs AI notes — split by tree) ──
  const renderNotes = (user, ai) => {
    const sec = root.querySelector("[data-nbp-notes]")
    const prefix = slug + "/"
    const hubPath = slug + "/" + slug + ".md" // the hub page itself is not a "note"
    const mk = (container, paths, label, base) => {
      const mine = paths.filter(p => p.indexOf(prefix) === 0 && p !== hubPath)
      if (!mine.length) { container.innerHTML = ""; return 0 }
      const h = document.createElement("div"); h.className = "nbp-notes-label"; h.textContent = label
      const ul = document.createElement("ul"); ul.className = "nbp-list"
      mine.forEach(p => {
        const name = p.slice(prefix.length).replace(/\\.md$/, "")
        const li = document.createElement("li")
        const a = document.createElement("a"); a.className = "internal"
        a.href = base + p.replace(/\\.md$/, "")
        a.textContent = name
        li.appendChild(a); ul.appendChild(li)
      })
      container.innerHTML = ""
      container.appendChild(h); container.appendChild(ul)
      return mine.length
    }
    const u = mk(root.querySelector("[data-nbp-notes-user]"), user, "Your notes", "/notes/notebooks/")
    const a = mk(root.querySelector("[data-nbp-notes-ai]"), ai, "AI notes", "/content/notebooks/")
    sec.hidden = (u + a) === 0
  }

  const refresh = async () => {
    try {
      const j = await (await fetch(nb)).json()
      renderSources(j.sources || [])
      renderSuggestions(j.suggestions || [])
      status.textContent = ""
    } catch (e) {
      status.textContent = "live data unavailable — showing the static snapshot above"
    }
    try {
      const n = await (await fetch("/workbench/notes")).json()
      renderNotes(n.user || [], n.ai || [])
    } catch (e) {}
  }

  // "+ Add source" opens the shared upload modal, pre-targeted to this notebook.
  const addBtn = root.querySelector("[data-nbp-add]")
  if (addBtn) addBtn.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("open-upload-modal", { detail: { notebook: threadId, title: "Add a source to this notebook" } }))
  })
  // Re-hydrate when a source is imported/linked via the modal (so it shows here
  // immediately, without waiting for a recompile).
  document.addEventListener("workbench-notebook-changed", () => refresh())

  refresh()
})
`

NotebookPage.css = `
.notebook-page { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.notebook-page .nbp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.notebook-page .nbp-title { font-weight: 600; font-size: .95rem; }
.notebook-page .nbp-status { font-size: .76rem; color: var(--gray); }
.notebook-page .nbp-sec { margin-top: .6rem; }
.notebook-page .nbp-h { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--gray); margin: .3rem 0; }
.notebook-page .nbp-count { color: var(--gray); font-weight: 400; }
.notebook-page .nbp-add { float: right; text-transform: none; letter-spacing: 0; font-size: .74rem; padding: .15rem .55rem; border: 1px solid var(--secondary); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.notebook-page .nbp-add:hover { background: var(--secondary); color: var(--light); }
.notebook-page .nbp-copy { float: right; text-transform: none; letter-spacing: 0; font-size: .72rem; padding: .15rem .5rem; margin-right: .4rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.notebook-page .nbp-copy:hover { background: var(--lightgray); }
.notebook-page .nbp-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .1rem 0 .5rem; max-width: 70ch; }
.notebook-page .nbp-list { list-style: none; margin: 0; padding: 0; }
.notebook-page .nbp-list li { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .85rem; }
.notebook-page .nbp-list li:last-child { border-bottom: 0; }
.notebook-page .nbp-empty { color: var(--gray); font-style: italic; border-bottom: 0 !important; }
.notebook-page .nbp-ct { font-size: .68rem; color: var(--gray); font-family: var(--codeFont); background: var(--lightgray); padding: 0 .3em; border-radius: 4px; }
.notebook-page .nbp-why { font-size: .72rem; color: var(--gray); flex: 1; }
.notebook-page .nbp-btn { margin-left: auto; font-size: .72rem; padding: .15rem .5rem; border: 1px solid var(--lightgray); background: transparent; border-radius: 5px; cursor: pointer; color: var(--secondary); }
.notebook-page .nbp-btn + .nbp-btn { margin-left: .3rem; }
.notebook-page .nbp-btn:hover { background: var(--lightgray); }
.notebook-page .nbp-accept { color: var(--secondary); border-color: var(--secondary); }
.notebook-page .nbp-hide { color: var(--gray); }
.notebook-page .nbp-notes-label { font-size: .74rem; color: var(--gray); margin: .35rem 0 .1rem; }
`

export default (() => NotebookPage) satisfies QuartzComponentConstructor
