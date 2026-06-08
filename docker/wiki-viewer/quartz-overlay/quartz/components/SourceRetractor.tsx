// SourceRetractor (P4.7) — the three removal verbs on a source leaf page, as a
// STATE-AWARE card. The card colour + description reflect the source's current
// lifecycle state (active vs retracted), and the verbs enable/disable so the
// available action is unambiguous: unlink-from-notebook (soft) · retract
// (global, reversible, the default — a STAGED mutation) · purge (irreversible,
// gated behind an explicit checkbox + confirm). Gravity counter (G11) at request
// time. Hydrates from the leaf frontmatter id (type=source).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceRetractor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  return (
    <div class={`source-retractor ${displayClass ?? ""}`} data-source-retractor data-source-id={String(fm.id)}>
      <div class="sr-head">
        <span class="sr-title">🗂 Source lifecycle</span>
        <span class="sr-state-pill" data-sr-pill>…</span>
        <span class="sr-gravity" data-sr-gravity>checking impact…</span>
      </div>
      <p class="sr-help" data-sr-help>…</p>
      <div class="sr-verbs">
        <button data-sr="retract" class="sr-default">Retract (reversible)</button>
        <button data-sr="restore" class="sr-alt">Restore</button>
      </div>
      <div class="sr-purge-row">
        <label class="sr-purge-toggle"><input type="checkbox" data-sr-show-purge /> show purge — permanent suppression (record kept)</label>
        <button data-sr="purge" class="sr-danger" hidden>Purge (irreversible)</button>
      </div>
      <div class="sr-status" data-sr-status></div>
    </div>
  )
}

SourceRetractor.afterDOMLoaded = `
document.addEventListener("nav", () => {
  document.querySelectorAll("[data-source-retractor]").forEach(async (el) => {
    if (el.dataset.srInit) return
    el.dataset.srInit = "1"
    const id = el.dataset.sourceId
    const grav = el.querySelector("[data-sr-gravity]")
    const pill = el.querySelector("[data-sr-pill]")
    const help = el.querySelector("[data-sr-help]")
    const status = el.querySelector("[data-sr-status]")
    const retractBtn = el.querySelector('[data-sr="retract"]')
    const restoreBtn = el.querySelector('[data-sr="restore"]')
    const purgeBtn = el.querySelector('[data-sr="purge"]')
    let gravity = { notebooks: 0, pages: 0 }

    const ACTIVE_HELP = "Sources are kept, never destroyed. <strong>Retract</strong> (the default) hides this source from all wiki generation but keeps the record — reversible until the next compile. <strong>Restore</strong> reverses it. <strong>Purge</strong> permanently hides it from all generation + search and can't be restored from here — but the record + embeddings are still KEPT (operator-recoverable, auditable). Rare; revealed behind the checkbox."
    const STATES = {
      active:    { pill: "Active",              cls: "",                 help: ACTIVE_HELP, retract: true,  restore: false },
      staged:    { pill: "Retracted (staged)",  cls: "sr-state-retracted", help: "<strong>⚠ This source is retracted (staged).</strong> It's hidden from wiki generation but still <strong>reversible</strong> — click <strong>Restore</strong> to bring it back before the next compile commits the retraction. The record is always kept.", retract: false, restore: true },
      committed: { pill: "Retracted",           cls: "sr-state-retracted", help: "<strong>⚠ This source is retracted.</strong> It's hidden from all wiki generation; the record is kept. Click <strong>Restore</strong> to bring it back.", retract: false, restore: true },
      purged:    { pill: "Purged",               cls: "sr-state-retracted", help: "<strong>⛔ This source is purged.</strong> It's permanently hidden from all wiki generation + search. The record + embeddings are KEPT (operator-recoverable from the database, and auditable) — but it cannot be restored from here.", retract: false, restore: false },
    }
    const setState = (key) => {
      const s = STATES[key] || STATES.active
      el.classList.toggle("sr-state-retracted", !!s.cls)
      pill.textContent = s.pill
      pill.className = "sr-state-pill " + (s.cls ? "sr-pill-retracted" : "sr-pill-active")
      help.innerHTML = s.help
      retractBtn.disabled = !s.retract
      restoreBtn.disabled = !s.restore
    }
    setState("active")

    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetch("/workbench/sources/" + encodeURIComponent(id), { signal: ctrl.signal })
      clearTimeout(t)
      const j = await r.json()
      gravity = j.gravity || gravity
      grav.textContent = "Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s)."
      const src = j.source || {}
      setState(src.purged ? "purged" : src.retracted_at ? (src.retraction_committed_at ? "committed" : "staged") : "active")
    } catch (e) { grav.textContent = "impact unavailable (" + (e && e.message ? e.message : e) + ")" }

    el.querySelector("[data-sr-show-purge]").addEventListener("change", (e) => { purgeBtn.hidden = !e.target.checked })

    retractBtn.addEventListener("click", async () => {
      status.textContent = "staging retract…"
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/retract", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "global" }),
        })
        if (r.ok) { setState("staged"); status.textContent = "Retract staged — reversible (click Restore, or it commits at the next compile)." }
        else status.textContent = "✗ retract failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ retract error: " + (e && e.message ? e.message : e) }
    })
    restoreBtn.addEventListener("click", async () => {
      status.textContent = "restoring…"
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id) + "/restore", { method: "POST" })
        if (r.ok) { setState("active"); status.textContent = "Restored — the source is active again, with its links intact." }
        else status.textContent = "✗ restore failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ restore error: " + (e && e.message ? e.message : e) }
    })
    purgeBtn.addEventListener("click", async () => {
      if (!confirm("Purge permanently hides this source from ALL wiki generation + search and cannot be restored from here.\\n\\nThe record + embeddings are KEPT (operator-recoverable from the database, auditable). Linked to " + gravity.notebooks + " notebook(s), cited on " + gravity.pages + " page(s). Proceed?")) return
      try {
        const r = await fetch("/workbench/sources/" + encodeURIComponent(id), {
          method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
        })
        if (r.ok) { setState("purged"); status.textContent = "Purged — permanently suppressed (record kept)." }
        else status.textContent = "✗ purge failed (" + r.status + ")"
      } catch (e) { status.textContent = "✗ purge error: " + (e && e.message ? e.message : e) }
    })
  })
})
`

SourceRetractor.css = `
.source-retractor { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); transition: background .2s, border-color .2s; }
.source-retractor.sr-state-retracted { background: color-mix(in srgb, #e0a800 16%, transparent); border-color: color-mix(in srgb, #e0a800 55%, transparent); }
.source-retractor .sr-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
.source-retractor .sr-title { font-weight: 600; font-size: .95rem; }
.source-retractor .sr-state-pill { font-size: .68rem; padding: .1rem .5rem; border-radius: 20px; text-transform: uppercase; letter-spacing: .03em; }
.source-retractor .sr-pill-active { background: color-mix(in srgb, var(--secondary) 18%, transparent); color: var(--dark); }
.source-retractor .sr-pill-retracted { background: #e0a800; color: #3a2e00; }
.source-retractor .sr-gravity { font-size: .78rem; color: var(--gray); margin-left: auto; }
.source-retractor .sr-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 74ch; }
.source-retractor .sr-verbs { display: flex; gap: .5rem; align-items: center; }
.source-retractor .sr-verbs button { font-size: .82rem; padding: .35rem .8rem; border: 1px solid var(--lightgray); border-radius: 7px; cursor: pointer; background: transparent; color: var(--dark); }
.source-retractor .sr-default { font-weight: 600; border-color: var(--secondary); color: var(--secondary); }
.source-retractor .sr-alt { color: var(--dark); }
.source-retractor .sr-verbs button:disabled { opacity: .4; cursor: default; border-color: var(--lightgray); color: var(--gray); font-weight: 400; }
.source-retractor .sr-purge-row { display: flex; gap: .75rem; align-items: center; margin-top: .55rem; }
.source-retractor .sr-purge-toggle { font-size: .74rem; color: var(--gray); display: inline-flex; align-items: center; gap: .35rem; }
.source-retractor .sr-danger { font-size: .8rem; padding: .35rem .8rem; border-radius: 7px; cursor: pointer; color: #fff; background: #c0392b; border: 1px solid #c0392b; }
.source-retractor .sr-status { font-size: .8rem; margin-top: .5rem; min-height: 1.2em; color: var(--gray); }
`

export default (() => SourceRetractor) satisfies QuartzComponentConstructor
