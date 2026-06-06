// SourceLinker (P6.9 + MembershipPicker) — notebook membership from the SOURCE
// side, as a card. Shows which notebooks this source belongs to, lets the user
// add it to more notebooks or unlink it from one (soft → hidden; it stays
// elsewhere + in generation). Entity-level grounding is done from the entity
// page ("Ground this claim"), so this card is notebook-membership-focused.
// Hydrates from the leaf frontmatter id (type=source).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceLinker: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  return (
    <div class={`source-linker ${displayClass ?? ""}`} data-source-linker data-source-id={String(fm.id)}>
      <div class="sl-head">
        <span class="sl-title">🔗 Notebooks</span>
        <span class="sl-status" data-sl-status></span>
      </div>
      <p class="sl-help">
        The notebooks this source belongs to. Add it to more, or unlink it from one — it stays in its
        other notebooks and in wiki generation (unlink isn't deletion). To make a wiki <em>page</em> cite
        this source, use “Ground this claim” on that page instead.
      </p>
      <ul class="sl-list" data-sl-list></ul>
      <div class="sl-add">
        <select class="sl-select" data-sl-select><option value="">add to a notebook…</option></select>
        <button class="sl-add-btn" data-sl-add>+ Add</button>
      </div>
    </div>
  )
}

SourceLinker.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-source-linker]")
  if (!root || root.dataset.slInit) return
  root.dataset.slInit = "1"
  const id = root.dataset.sourceId
  const base = "/workbench/sources/" + encodeURIComponent(id)
  const list = root.querySelector("[data-sl-list]")
  const select = root.querySelector("[data-sl-select]")
  const addBtn = root.querySelector("[data-sl-add]")
  const status = root.querySelector("[data-sl-status]")
  let allNotebooks = []
  let linked = []

  const renderList = () => {
    list.innerHTML = ""
    if (!linked.length) { list.innerHTML = "<li class='sl-empty'>not in any notebook yet.</li>" }
    else linked.forEach(nb => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"; a.href = "/content/notebooks/" + nb.slug + "/" + nb.slug; a.textContent = nb.name
      li.appendChild(a)
      const rm = document.createElement("button")
      rm.className = "sl-unlink"; rm.textContent = "unlink"; rm.title = "remove from this notebook (stays in its others + in generation)"
      rm.addEventListener("click", async () => {
        rm.disabled = true
        try {
          const r = await fetch(base + "/notebooks/" + encodeURIComponent(nb.id), { method: "DELETE" })
          if (!r.ok) throw new Error("HTTP " + r.status)
          document.dispatchEvent(new CustomEvent("workbench-notebook-changed"))
          await load()
        } catch (e) { rm.disabled = false; status.textContent = "✗ unlink failed" }
      })
      li.appendChild(rm)
      list.appendChild(li)
    })
  }
  const renderSelect = () => {
    const linkedIds = new Set(linked.map(n => n.id))
    select.innerHTML = "<option value=''>add to a notebook…</option>"
    allNotebooks.filter(n => !linkedIds.has(n.id)).forEach(n => {
      const o = document.createElement("option"); o.value = n.id; o.textContent = n.name; select.appendChild(o)
    })
  }
  const load = async () => {
    try {
      linked = (await (await fetch(base + "/notebooks")).json()).notebooks || []
      allNotebooks = (await (await fetch("/workbench/notebooks")).json()).notebooks || []
      renderList(); renderSelect(); status.textContent = ""
    } catch (e) { status.textContent = "membership unavailable" }
  }
  addBtn.addEventListener("click", async () => {
    const threadId = select.value
    if (!threadId) return
    addBtn.disabled = true; status.textContent = "linking…"
    try {
      const r = await fetch(base + "/link-notebook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread_id: threadId }) })
      if (!r.ok) throw new Error("HTTP " + r.status)
      status.textContent = "✓ added"
      document.dispatchEvent(new CustomEvent("workbench-notebook-changed"))
      await load()
    } catch (e) { status.textContent = "✗ add failed: " + (e && e.message ? e.message : e) }
    addBtn.disabled = false
  })
  document.addEventListener("workbench-notebook-changed", () => load())
  load()
})
`

SourceLinker.css = `
.source-linker { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.source-linker .sl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.source-linker .sl-title { font-weight: 600; font-size: .95rem; }
.source-linker .sl-status { font-size: .76rem; color: var(--gray); }
.source-linker .sl-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .5rem; max-width: 74ch; }
.source-linker .sl-list { list-style: none; margin: 0 0 .6rem; padding: 0; }
.source-linker .sl-list li { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .85rem; }
.source-linker .sl-list li:last-child { border-bottom: 0; }
.source-linker .sl-empty { color: var(--gray); font-style: italic; border-bottom: 0 !important; }
.source-linker .sl-unlink { margin-left: auto; font-size: .72rem; padding: .15rem .5rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 5px; cursor: pointer; }
.source-linker .sl-add { display: flex; gap: .5rem; }
.source-linker .sl-select { flex: 1; padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); font-size: .85rem; }
.source-linker .sl-add-btn { font-size: .8rem; padding: .35rem .8rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 6px; cursor: pointer; }
`

export default (() => SourceLinker) satisfies QuartzComponentConstructor
