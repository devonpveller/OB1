// ImportDropzone (P5.7) — drag/drop or pick a file → POST /workbench/import,
// then poll the job and SHOW what happened: the extracted source (title +
// snippet of the text/transcription), a link to its source page, and a clear
// "already imported" notice on a dedup hit. Notebook target is a DROPDOWN of
// existing notebooks (fetched live). Doubles as the P6 upload-and-link entry
// point via the entity-id field. Inits on Quartz's "nav" event so it works on
// every navigation, not just the first-loaded page.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const ImportDropzone: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div class={`import-dropzone ${displayClass ?? ""}`} data-import-dropzone>
      <label class="iz-drop">
        <input type="file" data-iz-file hidden />
        <span>Drop a file or click to import (PDF, DOC/DOCX, PPT/PPTX, image, audio…)</span>
      </label>
      <div class="iz-targets">
        <select data-iz-notebook>
          <option value="">(no notebook)</option>
        </select>
        <input data-iz-entities placeholder="ground to entity id(s), comma-sep (optional)" />
      </div>
      <div class="iz-status" data-iz-status></div>
      <div class="iz-result" data-iz-result hidden></div>
    </div>
  )
}

ImportDropzone.afterDOMLoaded = `
document.addEventListener("nav", () => {
  document.querySelectorAll("[data-import-dropzone]").forEach((el) => {
    if (el.dataset.izInit) return
    el.dataset.izInit = "1"
    const fileInput = el.querySelector("[data-iz-file]")
    const status = el.querySelector("[data-iz-status]")
    const result = el.querySelector("[data-iz-result]")
    const drop = el.querySelector(".iz-drop")
    const nbSel = el.querySelector("[data-iz-notebook]")

    // Populate the notebook dropdown from the live list (#3).
    fetch("/workbench/notebooks").then(r => r.json()).then(j => {
      (j.notebooks || []).forEach(nb => {
        const o = document.createElement("option")
        o.value = nb.id; o.textContent = nb.name
        nbSel.appendChild(o)
      })
    }).catch(() => {})

    const showResult = async (job) => {
      result.hidden = false
      let html = ""
      if (job.duplicate) html += "<strong>Already imported</strong> — this file matches an existing source (no duplicate created). "
      else html += "<strong>Imported.</strong> "
      try {
        const s = (await (await fetch("/workbench/sources/" + encodeURIComponent(job.source_id))).json()).source
        const snip = (s.content || "").trim().slice(0, 240).replace(/</g,"&lt;")
        html += "It became a <code>" + s.content_type + "</code> source titled <strong>" + (s.title || "(untitled)") + "</strong>."
        html += "<div class='iz-snip'>" + (snip || "(no extracted text)") + (s.content && s.content.length > 240 ? "…" : "") + "</div>"
        html += "<a href='/content/source/" + job.source_id + "'>open the source page →</a> (appears after the next wiki compile)"
      } catch { html += "source id: " + job.source_id }
      result.innerHTML = html
    }

    const pollJob = async (jobId, name) => {
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 1500))
        try {
          const { job } = await (await fetch("/workbench/jobs/" + jobId)).json()
          status.textContent = name + ": " + job.status
          if (job.status === "done") { status.textContent = "✓ " + name; await showResult(job); return }
          if (job.status === "failed") { status.textContent = "✗ " + name + ": " + (job.error || "failed"); return }
        } catch (e) { /* keep polling */ }
      }
      status.textContent = "✗ " + name + ": timed out waiting for the job"
    }

    const send = async (file) => {
      if (!file) return
      result.hidden = true; result.innerHTML = ""
      const fd = new FormData()
      fd.append("file", file)
      if (nbSel.value) fd.append("target_notebook", nbSel.value)
      const ents = el.querySelector("[data-iz-entities]").value.trim()
      if (ents) fd.append("target_entity_ids", ents)
      status.textContent = "uploading " + file.name + "…"
      try {
        const r = await fetch("/workbench/import", { method: "POST", body: fd })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status))
        pollJob(j.job_id, file.name)
      } catch (e) { status.textContent = "✗ " + file.name + ": " + (e && e.message ? e.message : e) }
    }

    fileInput.addEventListener("change", (e) => send(e.target.files[0]))
    ;["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("iz-over") }))
    ;["dragleave","drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("iz-over")))
    drop.addEventListener("drop", (e) => { e.preventDefault(); send(e.dataTransfer.files[0]) })
  })
})
`

ImportDropzone.css = `
.import-dropzone { display: flex; flex-direction: column; gap: .5rem; margin: 1rem 0; }
.import-dropzone .iz-drop { border: 2px dashed var(--lightgray); border-radius: 8px; padding: 1.25rem; text-align: center; cursor: pointer; display: block; }
.import-dropzone .iz-drop.iz-over { border-color: var(--secondary); background: var(--lightgray); }
.import-dropzone .iz-targets { display: flex; gap: .5rem; flex-wrap: wrap; }
.import-dropzone .iz-targets select, .import-dropzone .iz-targets input { flex: 1; min-width: 12rem; padding: .35rem .5rem; }
.import-dropzone .iz-status { font-size: .8rem; min-height: 1.2em; }
.import-dropzone .iz-result { font-size: .85rem; padding: .6rem .75rem; border: 1px solid var(--lightgray); border-radius: 8px; background: var(--light); }
.import-dropzone .iz-snip { margin: .4rem 0; padding: .4rem; background: var(--lightgray); border-radius: 6px; font-family: var(--codeFont); font-size: .78rem; white-space: pre-wrap; }
`

export default (() => ImportDropzone) satisfies QuartzComponentConstructor
