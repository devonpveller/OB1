// SourceEditor (P4.7) — inline source editing with the SAME UX as user notes:
// "✎ Edit this source" (relocated OVER the body by the shared NotesEditor script
// via the `data-wb-edit` contract, so CodeMirror is bundled once) PLUS
// "↻ Re-upload new version" (upload a supported document → extract → merge into
// the working head). Both update the head; a numbered revision commits once per
// compile, authored. The source id never changes (links stay valid); updating is
// never replacing. The body re-hydrates with the live content on every save.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceEditor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  const id = String(fm.id)
  return (
    <div class={`source-editor ${displayClass ?? ""}`} data-source-editor data-source-id={id}>
      <button class="ne-launch ne-edit" data-wb-edit data-edit-kind="source" data-source-id={id}>
        ✎ Edit this source
      </button>
      <button class="se-reupload" data-se-reupload>↻ Re-upload new version</button>
      <input type="file" data-se-file hidden />
      <span class="se-reup-status" data-se-status></span>
    </div>
  )
}

SourceEditor.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-source-editor]")
  if (!root || root.dataset.seInit) return
  root.dataset.seInit = "1"
  const id = root.dataset.sourceId
  const reBtn = root.querySelector("[data-se-reupload]")
  const fileInput = root.querySelector("[data-se-file]")
  const status = root.querySelector("[data-se-status]")
  if (!reBtn || !fileInput) return
  reBtn.addEventListener("click", () => fileInput.click())
  fileInput.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    status.textContent = "uploading " + f.name + "…"
    const fd = new FormData()
    fd.append("file", f)
    try {
      const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/replace-from-upload", { method: "POST", body: fd })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { status.textContent = "✗ " + (j.error || ("HTTP " + r.status)); return }
      status.textContent = "✓ merged new version from " + f.name + " — review the diff below."
      // refresh the body + the revision history (uncommitted diff)
      document.dispatchEvent(new CustomEvent("workbench-source-saved"))
    } catch (err) {
      status.textContent = "✗ " + (err && err.message ? err.message : err)
    }
    fileInput.value = ""
  })
})
`

SourceEditor.css = `
.source-editor { display: inline-flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.source-editor .se-reupload { font-size: .8rem; padding: .35rem .7rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.source-editor .se-reupload:hover { background: var(--lightgray); }
.source-editor .se-reup-status { font-size: .76rem; color: var(--gray); }
`

export default (() => SourceEditor) satisfies QuartzComponentConstructor
