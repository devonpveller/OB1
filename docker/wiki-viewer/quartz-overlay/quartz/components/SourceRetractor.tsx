// SourceRetractor (P4.7) — the three removal verbs on a source leaf page, kept
// visually distinct so scope is never confused: unlink-from-notebook (soft) ·
// retract (global, reversible, the default — a STAGED mutation) · purge
// (irreversible, gated behind an explicit confirm). Shows a GRAVITY COUNTER
// (G11) — "linked to N notebooks, cited on M pages" — at request time. Hydrates
// from the leaf frontmatter id (type=source). Purge is hidden by default.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceRetractor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  return (
    <div class={`source-retractor ${displayClass ?? ""}`} data-source-retractor data-source-id={String(fm.id)}>
      <div class="sr-gravity" data-sr-gravity>checking impact…</div>
      <div class="sr-verbs">
        <button data-sr="retract" class="sr-default">Retract (reversible)</button>
        <button data-sr="purge" class="sr-danger" hidden>Purge (irreversible)</button>
        <label class="sr-purge-toggle"><input type="checkbox" data-sr-show-purge /> show purge</label>
      </div>
      <div class="sr-status" data-sr-status></div>
    </div>
  )
}

SourceRetractor.afterDOMLoaded = `
document.querySelectorAll("[data-source-retractor]").forEach(async (el) => {
  const id = el.dataset.sourceId
  const grav = el.querySelector("[data-sr-gravity]")
  const status = el.querySelector("[data-sr-status]")
  let gravity = { notebooks: 0, pages: 0 }
  try {
    const r = await fetch("/workbench/sources/" + encodeURIComponent(id))
    const j = await r.json()
    gravity = j.gravity || gravity
    grav.textContent = "Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s)."
  } catch { grav.textContent = "" }
  el.querySelector("[data-sr-show-purge]").addEventListener("change", (e) => {
    el.querySelector('[data-sr="purge"]').hidden = !e.target.checked
  })
  el.querySelector('[data-sr="retract"]').addEventListener("click", async () => {
    status.textContent = "staging retract…"
    const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/retract", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "global" }),
    })
    status.textContent = r.ok ? "Retract staged — reversible until the next compile (see the Changes log)." : "✗ retract failed"
  })
  el.querySelector('[data-sr="purge"]').addEventListener("click", async () => {
    if (!confirm("Purge is IRREVERSIBLE and cascades. Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s). Proceed?")) return
    const r = await fetch("/workbench/sources/" + encodeURIComponent(id), {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
    })
    status.textContent = r.ok ? "Purged." : "✗ purge failed"
  })
})
`

SourceRetractor.css = `
.source-retractor { margin: 1rem 0; padding: .75rem; border: 1px solid var(--lightgray); border-radius: 8px; }
.source-retractor .sr-gravity { font-size: .8rem; opacity: .8; margin-bottom: .5rem; }
.source-retractor .sr-verbs { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.source-retractor .sr-default { font-weight: 600; }
.source-retractor .sr-danger { color: #fff; background: #c0392b; }
.source-retractor .sr-purge-toggle { font-size: .75rem; opacity: .7; }
.source-retractor .sr-status { font-size: .8rem; margin-top: .5rem; min-height: 1.2em; }
`

export default (() => SourceRetractor) satisfies QuartzComponentConstructor
