// ImportDropzone (P5.7) — drag/drop or pick a file → POST /workbench/import
// (the single upload route with the raised Caddy body cap), then poll the job.
// Carries the optional "link to wiki page(s) / notebook" target field
// (target_entity_ids / target_notebook), so it doubles as the P6 upload-and-link
// entry point. Per-file progress + clear errors; corrupt files fail loudly.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const ImportDropzone: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div class={`import-dropzone ${displayClass ?? ""}`} data-import-dropzone>
      <label class="iz-drop">
        <input type="file" data-iz-file hidden />
        <span>Drop a file or click to import (PDF, DOCX, PPTX, image, audio…)</span>
      </label>
      <div class="iz-targets">
        <input data-iz-notebook placeholder="link to notebook (thread id, optional)" />
        <input data-iz-entities placeholder="link to wiki page entity id(s), comma-sep (optional)" />
      </div>
      <div class="iz-status" data-iz-status></div>
    </div>
  )
}

ImportDropzone.afterDOMLoaded = `
document.querySelectorAll("[data-import-dropzone]").forEach((el) => {
  const fileInput = el.querySelector("[data-iz-file]")
  const status = el.querySelector("[data-iz-status]")
  const drop = el.querySelector(".iz-drop")
  const send = async (file) => {
    if (!file) return
    const fd = new FormData()
    fd.append("file", file)
    const nb = el.querySelector("[data-iz-notebook]").value.trim()
    const ents = el.querySelector("[data-iz-entities]").value.trim()
    if (nb) fd.append("target_notebook", nb)
    if (ents) fd.append("target_entity_ids", ents)
    status.textContent = "uploading " + file.name + "…"
    try {
      const r = await fetch("/workbench/import", { method: "POST", body: fd })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status))
      pollJob(j.job_id, file.name)
    } catch (e) { status.textContent = "✗ " + file.name + ": " + e.message }
  }
  const pollJob = async (jobId, name) => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const r = await fetch("/workbench/jobs/" + jobId)
        const { job } = await r.json()
        status.textContent = name + ": " + job.status
        if (job.status === "done") { status.textContent = "✓ " + name + " imported"; return }
        if (job.status === "failed") { status.textContent = "✗ " + name + ": " + (job.error || "failed"); return }
      } catch { /* keep polling */ }
    }
  }
  el.querySelector("[data-iz-file]").addEventListener("change", (e) => send(e.target.files[0]))
  ;["dragover","dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("iz-over") }))
  ;["dragleave","drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("iz-over")))
  drop.addEventListener("drop", (e) => { e.preventDefault(); send(e.dataTransfer.files[0]) })
})
`

ImportDropzone.css = `
.import-dropzone { display: flex; flex-direction: column; gap: .5rem; margin: 1rem 0; }
.import-dropzone .iz-drop { border: 2px dashed var(--lightgray); border-radius: 8px; padding: 1.25rem; text-align: center; cursor: pointer; display: block; }
.import-dropzone .iz-drop.iz-over { border-color: var(--secondary); background: var(--lightgray); }
.import-dropzone .iz-targets { display: flex; gap: .5rem; flex-wrap: wrap; }
.import-dropzone .iz-targets input { flex: 1; min-width: 12rem; padding: .35rem .5rem; }
.import-dropzone .iz-status { font-size: .8rem; min-height: 1.2em; }
`

export default (() => ImportDropzone) satisfies QuartzComponentConstructor
