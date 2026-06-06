// UploadModal (P5.7 / P6.2 / P6.9) — the source surface as a SHADOWBOX, not an
// always-on widget on every wiki page (#6). Two modes:
//   • Upload new — file or URL → extract→chunk→embed→link.
//   • Link existing — search existing sources and attach one (the deliberate
//     link path, reusing source_entities / thread_sources), #3.
// Opened by the "+ Add source" launcher (notebook hubs) or the
// `open-upload-modal` CustomEvent (GroundingBadge "Ground this claim", #5).
// Inits on Quartz's "nav" event.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const UploadModal: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  // The standalone launcher is retired on notebook hubs — NotebookPage now owns
  // the "+ Add source" entry (and GroundingBadge opens the modal on entity
  // pages). The modal still opens via the `open-upload-modal` event.
  const showLauncher = false
  return (
    <div class={`upload-modal-root ${displayClass ?? ""}`} data-upload-root data-notebook-id={String(fm.thread_id ?? "")}>
      {showLauncher ? <button class="um-launch" data-um-launch>+ Add source to this notebook</button> : null}
      <div class="um-overlay" data-upload-modal hidden>
        <div class="um-backdrop" data-um-close></div>
        <div class="um-box" role="dialog" aria-modal="true">
          <button class="um-x" data-um-close aria-label="close">×</button>
          <h3 class="um-title" data-um-title>Add a source</h3>
          <div class="um-target" data-um-target hidden></div>
          <label class="um-nb-label">Notebook
            <select data-iz-notebook><option value="">(none)</option></select>
          </label>
          <div class="um-modes">
            <button type="button" data-um-mode="upload" class="um-mode-active">Upload new</button>
            <button type="button" data-um-mode="link">Link existing</button>
          </div>
          <div data-um-panel="upload">
            <label class="iz-drop">
              <input type="file" data-iz-file hidden />
              <span>Drop a file or click to import (PDF, DOC/DOCX, PPT/PPTX, image, audio…)</span>
            </label>
            <input class="um-url" data-iz-url placeholder="…or paste a URL to ingest" />
          </div>
          <div data-um-panel="link" hidden>
            <input class="um-search" data-um-search placeholder="search existing sources by title/content…" />
            <div class="um-results" data-um-results></div>
          </div>
          <div class="iz-status" data-iz-status></div>
          <div class="iz-result" data-iz-result hidden></div>
        </div>
      </div>
    </div>
  )
}

UploadModal.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-upload-root]")
  if (!root || root.dataset.umInit) return
  root.dataset.umInit = "1"
  const modal = root.querySelector("[data-upload-modal]")
  const titleEl = root.querySelector("[data-um-title]")
  const targetEl = root.querySelector("[data-um-target]")
  const nbSel = root.querySelector("[data-iz-notebook]")
  const status = root.querySelector("[data-iz-status]")
  const result = root.querySelector("[data-iz-result]")
  const drop = root.querySelector(".iz-drop")
  const results = root.querySelector("[data-um-results]")
  let targetEntityId = null

  fetch("/workbench/notebooks").then(r => r.json()).then(j => {
    (j.notebooks || []).forEach(nb => { const o = document.createElement("option"); o.value = nb.id; o.textContent = nb.name; nbSel.appendChild(o) })
  }).catch(() => {})

  // mode toggle
  root.querySelectorAll("[data-um-mode]").forEach(btn => btn.addEventListener("click", () => {
    const mode = btn.dataset.umMode
    root.querySelectorAll("[data-um-mode]").forEach(b => b.classList.toggle("um-mode-active", b === btn))
    root.querySelector('[data-um-panel="upload"]').hidden = mode !== "upload"
    root.querySelector('[data-um-panel="link"]').hidden = mode !== "link"
  }))

  const open = (opts) => {
    opts = opts || {}
    targetEntityId = opts.entityId || null
    titleEl.textContent = opts.title || (targetEntityId ? "Ground this claim with a source" : "Add a source")
    if (targetEntityId) { targetEl.hidden = false; targetEl.textContent = "Target: entity #" + targetEntityId + " — the source will be cited on this page after the next compile." }
    else { targetEl.hidden = true }
    nbSel.value = opts.notebook || ""
    status.textContent = ""; result.hidden = true; result.innerHTML = ""; results.innerHTML = ""
    modal.hidden = false
  }
  const close = () => { modal.hidden = true }
  const launch = root.querySelector("[data-um-launch]")
  if (launch) launch.addEventListener("click", () => open({ notebook: root.dataset.notebookId || "" }))
  root.querySelectorAll("[data-um-close]").forEach(b => b.addEventListener("click", close))
  document.addEventListener("open-upload-modal", (e) => open((e && e.detail) || {}))
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close() })

  // ── Upload mode ──
  const showResult = async (job) => {
    result.hidden = false
    let html = job.duplicate ? "<strong>Already imported</strong> — matches an existing source (no duplicate created)." : "<strong>Imported.</strong>"
    if (nbSel.value) html += " Linked to the selected notebook."
    if (targetEntityId) html += " Grounding link added — cited after the next compile."
    try {
      const s = (await (await fetch("/workbench/sources/" + encodeURIComponent(job.source_id))).json()).source
      const snip = (s.content || "").trim().slice(0, 240).replace(/</g, "&lt;")
      const article = /^[aeiou]/i.test(s.content_type) ? "an" : "a"
      html += " It became " + article + " <code>" + s.content_type + "</code> source titled <strong>" + (s.title || "(untitled)") + "</strong>."
      html += "<div class='iz-snip'>" + (snip || "(no extracted text)") + (s.content && s.content.length > 240 ? "…" : "") + "</div>"
      html += "<a href='/content/source/" + job.source_id + "'>open the source page →</a> (after the next compile)"
    } catch { html += " source id: " + job.source_id }
    result.innerHTML = html
    // tell NotebookPage (and any listener) to re-hydrate its live source list
    document.dispatchEvent(new CustomEvent("workbench-notebook-changed"))
  }
  const pollJob = async (jobId, name) => {
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        const { job } = await (await fetch("/workbench/jobs/" + jobId)).json()
        status.textContent = name + ": " + job.status
        if (job.status === "done") { status.textContent = "✓ " + name; await showResult(job); return }
        if (job.status === "failed") { status.textContent = "✗ " + name + ": " + (job.error || "failed"); return }
      } catch (e) {}
    }
    status.textContent = "✗ " + name + ": timed out"
  }
  const send = async (file) => {
    const url = root.querySelector("[data-iz-url]").value.trim()
    if (!file && !url) { status.textContent = "pick a file or enter a URL"; return }
    result.hidden = true; result.innerHTML = ""
    const fd = new FormData()
    if (file) fd.append("file", file)
    if (url) fd.append("url", url)
    if (nbSel.value) fd.append("target_notebook", nbSel.value)
    if (targetEntityId) fd.append("target_entity_ids", String(targetEntityId))
    status.textContent = "uploading " + (file ? file.name : url) + "…"
    try {
      const r = await fetch("/workbench/import", { method: "POST", body: fd })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status))
      pollJob(j.job_id, file ? file.name : url)
    } catch (e) { status.textContent = "✗ " + (e && e.message ? e.message : e) }
  }
  root.querySelector("[data-iz-file]").addEventListener("change", (e) => send(e.target.files[0]))
  ;["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("iz-over") }))
  ;["dragleave","drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("iz-over")))
  drop.addEventListener("drop", (e) => { e.preventDefault(); send(e.dataTransfer.files[0]) })

  // ── Link-existing mode ──
  const linkSource = async (id, title) => {
    if (!targetEntityId && !nbSel.value) { status.textContent = "pick a target (entity via 'Ground this claim', or a notebook above)"; return }
    status.textContent = "linking…"
    try {
      if (targetEntityId) {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/link-entity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entity_id: targetEntityId }) })
        if (!r.ok) throw new Error("HTTP " + r.status)
        status.textContent = "✓ linked '" + title + "' to entity #" + targetEntityId + " — cited after the next compile."
      } else {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/link-notebook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread_id: nbSel.value }) })
        if (!r.ok) throw new Error("HTTP " + r.status)
        status.textContent = "✓ linked '" + title + "' to the notebook."
      }
      document.dispatchEvent(new CustomEvent("workbench-notebook-changed"))
    } catch (e) { status.textContent = "✗ link failed: " + (e && e.message ? e.message : e) }
  }
  let searchTimer = null
  root.querySelector("[data-um-search]").addEventListener("input", (e) => {
    clearTimeout(searchTimer)
    const q = e.target.value.trim()
    searchTimer = setTimeout(async () => {
      results.innerHTML = "<em>searching…</em>"
      try {
        const j = await (await fetch("/workbench/sources?q=" + encodeURIComponent(q))).json()
        if (!j.sources || !j.sources.length) { results.innerHTML = "<em>no matches</em>"; return }
        results.innerHTML = ""
        j.sources.forEach(s => {
          const div = document.createElement("div")
          div.className = "um-result-item"
          div.innerHTML = "<strong>" + (s.title || s.url || s.id) + "</strong> <span class='um-ct'>" + s.content_type + "</span>"
          div.addEventListener("click", () => linkSource(s.id, s.title || s.url || s.id))
          results.appendChild(div)
        })
      } catch (err) { results.innerHTML = "<em>search failed</em>" }
    }, 300)
  })
})
`

UploadModal.css = `
.upload-modal-root .um-launch { font-size: .85rem; padding: .3rem .7rem; border: 1px solid var(--secondary); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.um-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
.um-overlay[hidden] { display: none; }
.um-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
.um-box { position: relative; background: var(--light); color: var(--dark); width: min(560px, 92vw); max-height: 86vh; overflow: auto; padding: 1.25rem 1.5rem; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.um-box .um-x { position: absolute; top: .5rem; right: .75rem; font-size: 1.4rem; background: none; border: 0; cursor: pointer; color: var(--gray); }
.um-box .um-title { margin: 0 0 .5rem; font-size: 1.05rem; }
.um-box .um-target { font-size: .8rem; color: var(--secondary); margin-bottom: .5rem; }
.um-box .um-nb-label { display: flex; flex-direction: column; font-size: .72rem; color: var(--gray); gap: .15rem; margin-bottom: .6rem; }
.um-box .um-modes { display: flex; gap: .4rem; margin-bottom: .6rem; }
.um-box .um-modes button { font-size: .8rem; padding: .25rem .6rem; border: 1px solid var(--lightgray); background: transparent; border-radius: 6px; cursor: pointer; }
.um-box .um-modes button.um-mode-active { background: var(--secondary); color: var(--light); border-color: var(--secondary); }
.um-box .iz-drop { border: 2px dashed var(--lightgray); border-radius: 8px; padding: 1.5rem; text-align: center; cursor: pointer; display: block; }
.um-box .iz-drop.iz-over { border-color: var(--secondary); background: var(--lightgray); }
.um-box .um-url, .um-box .um-search { width: 100%; padding: .4rem .5rem; margin-top: .5rem; }
.um-box .um-results { margin-top: .5rem; max-height: 220px; overflow: auto; }
.um-box .um-result-item { padding: .4rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; margin-bottom: .3rem; cursor: pointer; font-size: .82rem; }
.um-box .um-result-item:hover { background: var(--lightgray); }
.um-box .um-result-item .um-ct { color: var(--gray); font-size: .72rem; }
.um-box .iz-status { font-size: .8rem; min-height: 1.2em; margin-top: .5rem; }
.um-box .iz-result { font-size: .85rem; padding: .6rem .75rem; border: 1px solid var(--lightgray); border-radius: 8px; background: var(--lightgray); margin-top: .5rem; }
.um-box .iz-snip { margin: .4rem 0; padding: .4rem; background: var(--light); border-radius: 6px; font-family: var(--codeFont); font-size: .78rem; white-space: pre-wrap; }
`

export default (() => UploadModal) satisfies QuartzComponentConstructor
