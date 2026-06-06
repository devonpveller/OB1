// NoteReferences (P3.5 follow-up) — a note's dynamic, origin-aware reference
// list, in the consistent full-width card UX. Two origins, kept distinct:
//   • Cited in this note — source leaves linked in the body ([[…source/<uuid>…]])
//   • Added references   — sources the author deliberately attached (organizing)
// Hydrates from /workbench/note-refs; "+ Add reference" searches existing sources
// and attaches one (frontmatter `sources:`); added refs can be removed. On EXPORT
// the union is emitted as a clean "## References" list (origin dropped).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const NoteReferences: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const slug = String(fileData?.slug ?? "")
  const isFolderPage = slug === "index" || slug.endsWith("/index")
  const isUserNote = !isFolderPage && slug.startsWith("notes/") && !slug.startsWith("notes/Changes")
  if (!isUserNote) return null
  const notePath = slug + ".md" // full vault-relative path (notes/…)
  return (
    <div class={`note-refs ${displayClass ?? ""}`} data-note-refs data-note-path={notePath}>
      <div class="nr-head">
        <span class="nr-title">🔗 References</span>
        <span class="nr-head-right">
          <button class="nr-copy" data-nr-copy hidden>⧉ copy list</button>
          <span class="nr-status" data-nr-status></span>
        </span>
      </div>
      <p class="nr-help">
        This note's sources. <strong>Cited</strong> ones are linked in the text; <strong>added</strong>
        ones you attached deliberately (e.g. to organize evidence without quoting it inline). On export,
        both fold into one clean References list.
      </p>
      <section class="nr-sec" data-nr-cited hidden>
        <h3 class="nr-h">Cited in this note <span class="nr-count" data-nr-cited-count></span></h3>
        <ul class="nr-list" data-nr-cited-list></ul>
      </section>
      <section class="nr-sec" data-nr-added hidden>
        <h3 class="nr-h">Added references <span class="nr-count" data-nr-added-count></span></h3>
        <ul class="nr-list" data-nr-added-list></ul>
      </section>
      <div class="nr-add">
        <button class="nr-add-btn" data-nr-add-toggle>+ Add reference</button>
        <div class="nr-search" data-nr-search hidden>
          <input class="nr-q" data-nr-q placeholder="search existing sources by title / content…" />
          <div class="nr-results" data-nr-results></div>
        </div>
      </div>
    </div>
  )
}

NoteReferences.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-note-refs]")
  if (!root || root.dataset.nrInit) return
  root.dataset.nrInit = "1"
  const notePath = root.dataset.notePath
  const refsUrl = "/workbench/note-refs?path=" + encodeURIComponent(notePath)
  const status = root.querySelector("[data-nr-status]")
  const setCount = (el, n) => { if (el) el.textContent = "(" + n + ")" }

  const renderList = (listEl, secEl, countEl, items, removable) => {
    listEl.innerHTML = ""
    setCount(countEl, items.length)
    secEl.hidden = items.length === 0
    items.forEach(s => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"
      a.href = "/content/source/" + s.id
      a.textContent = s.title || s.url || s.id
      li.appendChild(a)
      if (s.content_type) { const ct = document.createElement("span"); ct.className = "nr-ct"; ct.textContent = s.content_type; li.appendChild(ct) }
      if (removable) {
        const rm = document.createElement("button")
        rm.className = "nr-rm"; rm.textContent = "×"; rm.title = "remove this added reference"
        rm.addEventListener("click", async () => {
          rm.disabled = true
          try {
            const r = await fetch(refsUrl + "&source_id=" + encodeURIComponent(s.id), { method: "DELETE" })
            if (!r.ok) throw new Error("HTTP " + r.status)
            apply(await r.json())
          } catch (e) { rm.disabled = false; status.textContent = "✗ remove failed" }
        })
        li.appendChild(rm)
      }
      listEl.appendChild(li)
    })
  }

  const copyBtn = root.querySelector("[data-nr-copy]")
  const apply = (data) => {
    renderList(root.querySelector("[data-nr-cited-list]"), root.querySelector("[data-nr-cited]"), root.querySelector("[data-nr-cited-count]"), data.cited || [], false)
    renderList(root.querySelector("[data-nr-added-list]"), root.querySelector("[data-nr-added]"), root.querySelector("[data-nr-added-count]"), data.added || [], true)
    // a copyable numbered citation list (cited first, then added)
    const all = (data.cited || []).concat(data.added || [])
    copyBtn.hidden = all.length === 0
    copyBtn.onclick = () => {
      const lines = all.map((s, i) => "[" + (i + 1) + "] " + (s.title || s.url || s.id) + (s.url ? ". " + s.url : "."))
      navigator.clipboard.writeText(lines.join("\\n")).then(() => { copyBtn.textContent = "✓ copied"; setTimeout(() => copyBtn.textContent = "⧉ copy list", 1200) }).catch(() => { status.textContent = "copy blocked" })
    }
  }
  const load = async () => {
    try { apply(await (await fetch(refsUrl)).json()); status.textContent = "" }
    catch (e) { status.textContent = "references unavailable" }
  }

  // ── "+ Add reference" — search existing sources, attach one ──
  const search = root.querySelector("[data-nr-search]")
  const results = root.querySelector("[data-nr-results]")
  const q = root.querySelector("[data-nr-q]")
  root.querySelector("[data-nr-add-toggle]").addEventListener("click", () => {
    search.hidden = !search.hidden
    if (!search.hidden) q.focus()
  })
  let timer = null
  q.addEventListener("input", () => {
    clearTimeout(timer)
    const term = q.value.trim()
    timer = setTimeout(async () => {
      results.innerHTML = "<em class='nr-muted'>searching…</em>"
      try {
        const j = await (await fetch("/workbench/sources?q=" + encodeURIComponent(term))).json()
        if (!j.sources || !j.sources.length) { results.innerHTML = "<em class='nr-muted'>no matches</em>"; return }
        results.innerHTML = ""
        j.sources.forEach(s => {
          const d = document.createElement("div")
          d.className = "nr-result"
          d.innerHTML = "<strong>" + (s.title || s.url || s.id).replace(/</g, "&lt;") + "</strong> <span class='nr-ct'>" + (s.content_type || "") + "</span>"
          d.addEventListener("click", async () => {
            status.textContent = "adding…"
            try {
              const r = await fetch(refsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_id: s.id }) })
              if (!r.ok) throw new Error("HTTP " + r.status)
              apply(await r.json())
              status.textContent = "✓ added"
              search.hidden = true; q.value = ""; results.innerHTML = ""
            } catch (e) { status.textContent = "✗ add failed: " + (e && e.message ? e.message : e) }
          })
          results.appendChild(d)
        })
      } catch (e) { results.innerHTML = "<em class='nr-muted'>search failed</em>" }
    }, 300)
  })

  load()
})
`

NoteReferences.css = `
.note-refs { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.note-refs .nr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.note-refs .nr-title { font-weight: 600; font-size: .95rem; }
.note-refs .nr-status { font-size: .76rem; color: var(--gray); }
.note-refs .nr-head-right { display: inline-flex; align-items: center; gap: .5rem; }
.note-refs .nr-copy { font-size: .72rem; padding: .15rem .5rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 5px; cursor: pointer; }
.note-refs .nr-copy:hover { background: var(--lightgray); }
.note-refs .nr-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .5rem; max-width: 72ch; }
.note-refs .nr-sec { margin-top: .5rem; }
.note-refs .nr-h { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--gray); margin: .3rem 0; }
.note-refs .nr-count { color: var(--gray); font-weight: 400; }
.note-refs .nr-list { list-style: none; margin: 0; padding: 0; }
.note-refs .nr-list li { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .85rem; }
.note-refs .nr-list li:last-child { border-bottom: 0; }
.note-refs .nr-ct { font-size: .68rem; color: var(--gray); font-family: var(--codeFont); background: var(--lightgray); padding: 0 .3em; border-radius: 4px; }
.note-refs .nr-rm { margin-left: auto; border: 0; background: transparent; color: var(--gray); font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 0 .25rem; }
.note-refs .nr-rm:hover { color: #c0392b; }
.note-refs .nr-add { margin-top: .6rem; }
.note-refs .nr-add-btn { font-size: .76rem; padding: .25rem .6rem; border: 1px solid var(--secondary); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.note-refs .nr-search { margin-top: .5rem; }
.note-refs .nr-q { width: 100%; padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); font-size: .85rem; }
.note-refs .nr-results { margin-top: .4rem; max-height: 220px; overflow: auto; }
.note-refs .nr-result { padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; margin-bottom: .3rem; cursor: pointer; font-size: .82rem; }
.note-refs .nr-result:hover { background: var(--lightgray); }
.note-refs .nr-muted { color: var(--gray); }
`

export default (() => NoteReferences) satisfies QuartzComponentConstructor
