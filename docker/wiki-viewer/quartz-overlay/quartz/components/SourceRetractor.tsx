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
      <div class="sr-head">
        <span class="sr-title">🗂 Source lifecycle</span>
        <span class="sr-gravity" data-sr-gravity>checking impact…</span>
      </div>
      <p class="sr-help">
        Sources are kept, never destroyed by default. <strong>Retract</strong> (the default) hides this
        source from all wiki generation but keeps the record — reversible until the next compile.
        <strong> Restore</strong> reverses it. <strong>Purge</strong> permanently deletes it and
        everything it supports (rare, irreversible — revealed behind a checkbox).
      </p>
      <div class="sr-verbs">
        <button data-sr="retract" class="sr-default">Retract (reversible)</button>
        <button data-sr="restore" class="sr-alt">Restore</button>
        <button data-sr="purge" class="sr-danger" hidden>Purge (irreversible)</button>
        <label class="sr-purge-toggle"><input type="checkbox" data-sr-show-purge /> show purge — irreversible delete</label>
      </div>
      <div class="sr-status" data-sr-status></div>
    </div>
  )
}

// NOTE: init MUST run on Quartz's "nav" event (fires on initial load AND every
// SPA navigation), not once at script-execution — otherwise only the
// first-loaded page is wired and every navigation after leaves components dead.
SourceRetractor.afterDOMLoaded = `
document.addEventListener("nav", () => {
  document.querySelectorAll("[data-source-retractor]").forEach(async (el) => {
    if (el.dataset.srInit) return // idempotent across repeated nav events
    el.dataset.srInit = "1"
    const id = el.dataset.sourceId
    const grav = el.querySelector("[data-sr-gravity]")
    const status = el.querySelector("[data-sr-status]")
    let gravity = { notebooks: 0, pages: 0 }
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetch("/workbench/sources/" + encodeURIComponent(id), { signal: ctrl.signal })
      clearTimeout(t)
      const j = await r.json()
      gravity = j.gravity || gravity
      grav.textContent = "Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s)."
    } catch (e) { grav.textContent = "impact unavailable (" + (e && e.message ? e.message : e) + ")" }
    el.querySelector("[data-sr-show-purge]").addEventListener("change", (e) => {
      el.querySelector('[data-sr="purge"]').hidden = !e.target.checked
    })
    el.querySelector('[data-sr="retract"]').addEventListener("click", async () => {
      status.textContent = "staging retract…"
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/retract", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "global" }),
        })
        status.textContent = r.ok ? "Retract staged — reversible (click Restore, or it commits at the next compile)." : "✗ retract failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ retract error: " + (e && e.message ? e.message : e) }
    })
    el.querySelector('[data-sr="restore"]').addEventListener("click", async () => {
      status.textContent = "restoring…"
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/restore", { method: "POST" })
        status.textContent = r.ok ? "Restored — the retract was reversed." : "✗ restore failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ restore error: " + (e && e.message ? e.message : e) }
    })
    el.querySelector('[data-sr="purge"]').addEventListener("click", async () => {
      if (!confirm("Purge is IRREVERSIBLE and cascades. Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s). Proceed?")) return
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id), {
          method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
        })
        status.textContent = r.ok ? "Purged." : "✗ purge failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ purge error: " + (e && e.message ? e.message : e) }
    })
  })
})
`

SourceRetractor.css = `
.source-retractor { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.source-retractor .sr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.source-retractor .sr-title { font-weight: 600; font-size: .95rem; }
.source-retractor .sr-gravity { font-size: .78rem; color: var(--gray); }
.source-retractor .sr-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 72ch; }
.source-retractor .sr-verbs { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.source-retractor .sr-verbs button { font-size: .82rem; padding: .35rem .8rem; border: 1px solid var(--lightgray); border-radius: 7px; cursor: pointer; background: transparent; color: var(--dark); }
.source-retractor .sr-default { font-weight: 600; border-color: var(--secondary) !important; color: var(--secondary) !important; }
.source-retractor .sr-alt { color: var(--gray) !important; }
.source-retractor .sr-danger { color: #fff !important; background: #c0392b !important; border-color: #c0392b !important; }
.source-retractor .sr-purge-toggle { font-size: .74rem; color: var(--gray); }
.source-retractor .sr-status { font-size: .8rem; margin-top: .5rem; min-height: 1.2em; color: var(--gray); }
`

export default (() => SourceRetractor) satisfies QuartzComponentConstructor
