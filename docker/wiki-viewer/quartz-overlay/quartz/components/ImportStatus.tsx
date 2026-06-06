// ImportStatus (P5.7) — recent import history, as a card on the notebooks MOC
// page. Reads import_jobs (durable, so it survives a workbench restart): each
// document/URL import with its terminal state, duplicates flagged, and failed
// grounding attempts surfaced with their error. Refreshes on nav + on the
// workbench-notebook-changed event + a manual refresh.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const ImportStatus: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const slug = String(fileData?.slug ?? "")
  if (slug !== "notebooks" && !slug.endsWith("/notebooks")) return null
  return (
    <div class={`import-status ${displayClass ?? ""}`} data-import-status>
      <div class="is-head">
        <span class="is-title">📥 Recent imports</span>
        <button class="is-refresh" data-is-refresh title="refresh">↻</button>
      </div>
      <p class="is-help">
        Document/URL imports and their outcome (durable across restarts). Duplicates are flagged; failed
        imports/grounding attempts show their error.
      </p>
      <ul class="is-list" data-is-list></ul>
    </div>
  )
}

ImportStatus.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-import-status]")
  if (!root || root.dataset.isInit) return
  root.dataset.isInit = "1"
  const list = root.querySelector("[data-is-list]")

  const render = (jobs) => {
    list.innerHTML = ""
    if (!jobs.length) { list.innerHTML = "<li class='is-empty'>no imports yet.</li>"; return }
    jobs.forEach(j => {
      const li = document.createElement("li")
      const badge = document.createElement("span")
      badge.className = "is-badge is-" + (j.status || "")
      badge.textContent = j.status || "?"
      li.appendChild(badge)
      const label = document.createElement("span")
      label.className = "is-label"
      if (j.source_id) {
        const a = document.createElement("a")
        a.className = "internal"; a.href = "/content/source/" + j.source_id; a.textContent = "source " + String(j.source_id).slice(0, 8) + "…"
        label.appendChild(a)
      } else { label.textContent = j.target_entity_ids && j.target_entity_ids.length ? "grounding attempt" : "import" }
      li.appendChild(label)
      if (j.duplicate) { const d = document.createElement("span"); d.className = "is-dup"; d.textContent = "duplicate"; li.appendChild(d) }
      if (j.error) { const e = document.createElement("span"); e.className = "is-err"; e.textContent = j.error; e.title = j.error; li.appendChild(e) }
      const when = document.createElement("span")
      when.className = "is-when"; when.textContent = j.created_at ? new Date(j.created_at).toLocaleString() : ""
      li.appendChild(when)
      list.appendChild(li)
    })
  }
  const load = async () => {
    try { render((await (await fetch("/workbench/jobs")).json()).jobs || []) }
    catch (e) { list.innerHTML = "<li class='is-empty'>import history unavailable</li>" }
  }
  root.querySelector("[data-is-refresh]").addEventListener("click", load)
  document.addEventListener("workbench-notebook-changed", () => load())
  load()
})
`

ImportStatus.css = `
.import-status { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.import-status .is-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.import-status .is-title { font-weight: 600; font-size: .95rem; }
.import-status .is-refresh { font-size: .9rem; background: none; border: 0; cursor: pointer; color: var(--gray); }
.import-status .is-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .5rem; max-width: 74ch; }
.import-status .is-list { list-style: none; margin: 0; padding: 0; }
.import-status .is-list li { display: flex; align-items: center; gap: .5rem; padding: .3rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .82rem; }
.import-status .is-list li:last-child { border-bottom: 0; }
.import-status .is-empty { color: var(--gray); font-style: italic; border-bottom: 0 !important; }
.import-status .is-badge { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; padding: .1rem .45rem; border-radius: 4px; background: var(--lightgray); color: var(--darkgray); }
.import-status .is-done { background: color-mix(in srgb, var(--secondary) 22%, transparent); color: var(--dark); }
.import-status .is-failed { background: #f8d7da; color: #842029; }
.import-status .is-label { font-weight: 500; }
.import-status .is-dup { font-size: .66rem; color: var(--gray); border: 1px solid var(--lightgray); border-radius: 4px; padding: 0 .3em; }
.import-status .is-err { font-size: .72rem; color: #c0392b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.import-status .is-when { margin-left: auto; font-size: .72rem; color: var(--gray); white-space: nowrap; }
`

export default (() => ImportStatus) satisfies QuartzComponentConstructor
