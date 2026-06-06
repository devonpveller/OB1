// NotebookIndex (P2.7) — the live card on the notebooks MOC page
// (content/notebooks.md). Lists every active notebook (link → its hub) and lets
// the user CREATE a notebook from the UI (POST /workbench/notebooks, slug pinned
// server-side). Card UX, consistent with the other surfaces. Hydrates on nav;
// degrades to the baked MOC list above if the API is down.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const NotebookIndex: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const slug = String(fileData?.slug ?? "")
  // the compiler writes the MOC at content/notebooks.md (slug "content/notebooks")
  if (slug !== "notebooks" && !slug.endsWith("/notebooks")) return null
  return (
    <div class={`notebook-index ${displayClass ?? ""}`} data-notebook-index>
      <div class="ni-head">
        <span class="ni-title">📚 Notebooks — live</span>
        <span class="ni-status" data-ni-status>loading…</span>
      </div>
      <p class="ni-help">
        Every research group. Open one to manage its sources, notes and suggestions. Create a new
        notebook here — its hub page is generated on the next wiki compile.
      </p>
      <ul class="ni-list" data-ni-list></ul>
      <div class="ni-create">
        <input class="ni-name" data-ni-name placeholder="new notebook name…" />
        <button class="ni-create-btn" data-ni-create>+ Create notebook</button>
      </div>
    </div>
  )
}

NotebookIndex.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-notebook-index]")
  if (!root || root.dataset.niInit) return
  root.dataset.niInit = "1"
  const list = root.querySelector("[data-ni-list]")
  const status = root.querySelector("[data-ni-status]")
  const input = root.querySelector("[data-ni-name]")
  const createBtn = root.querySelector("[data-ni-create]")

  const render = (nbs) => {
    list.innerHTML = ""
    if (!nbs.length) { list.innerHTML = "<li class='ni-empty'>no notebooks yet — create one below.</li>"; return }
    nbs.forEach(nb => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"
      a.href = "/content/notebooks/" + nb.slug + "/" + nb.slug
      a.textContent = nb.name
      li.appendChild(a)
      if (nb.description) { const d = document.createElement("span"); d.className = "ni-desc"; d.textContent = nb.description; li.appendChild(d) }
      list.appendChild(li)
    })
  }
  const load = async () => {
    try { const j = await (await fetch("/workbench/notebooks")).json(); render(j.notebooks || []); status.textContent = "" }
    catch (e) { status.textContent = "live list unavailable — showing the static list above" }
  }
  const doCreate = async () => {
    const name = input.value.trim()
    if (!name) return
    createBtn.disabled = true; status.textContent = "creating…"
    try {
      const r = await fetch("/workbench/notebooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status))
      input.value = ""
      status.textContent = "✓ created “" + j.notebook.name + "” — its hub builds on the next compile."
      await load()
    } catch (e) { status.textContent = "✗ " + (e && e.message ? e.message : e) }
    createBtn.disabled = false
  }
  createBtn.addEventListener("click", doCreate)
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doCreate() } })
  document.addEventListener("workbench-notebook-changed", () => load())
  load()
})
`

NotebookIndex.css = `
.notebook-index { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.notebook-index .ni-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.notebook-index .ni-title { font-weight: 600; font-size: .95rem; }
.notebook-index .ni-status { font-size: .76rem; color: var(--gray); }
.notebook-index .ni-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .5rem; max-width: 72ch; }
.notebook-index .ni-list { list-style: none; margin: 0 0 .6rem; padding: 0; }
.notebook-index .ni-list li { display: flex; align-items: baseline; gap: .5rem; padding: .3rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .9rem; }
.notebook-index .ni-list li:last-child { border-bottom: 0; }
.notebook-index .ni-desc { font-size: .76rem; color: var(--gray); }
.notebook-index .ni-empty { color: var(--gray); font-style: italic; border-bottom: 0 !important; }
.notebook-index .ni-create { display: flex; gap: .5rem; margin-top: .4rem; }
.notebook-index .ni-name { flex: 1; padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); font-size: .85rem; }
.notebook-index .ni-create-btn { font-size: .8rem; padding: .35rem .8rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 6px; cursor: pointer; font-weight: 600; }
.notebook-index .ni-create-btn:disabled { opacity: .5; cursor: default; }
`

export default (() => NotebookIndex) satisfies QuartzComponentConstructor
