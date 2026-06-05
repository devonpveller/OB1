// GroundingBadge (P6.1) — the live grounding-state badge on an entity page.
// Hydrates from the workbench at read time via the P0.6/G12 frontmatter
// contract: the build-time component bakes `entity_id` into a data attribute
// (NEVER URL-parsing), and the inline script reads it + fetches the live state.
// States: Mental model — ungrounded belief (+ CTA) · ⏳ Grounding pending ·
// Grounded by N · ⚠ Ingest failed. Compiler policy: badge thought-only pages,
// never suppress them (D-J).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const GroundingBadge: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  // Only entity pages carry entity_id; on any other page class the badge no-ops.
  if (fm.type !== "wiki" || fm.entity_id == null) return null
  return (
    <div
      class={`grounding-badge ${displayClass ?? ""}`}
      data-grounding-badge
      data-entity-id={String(fm.entity_id)}
    >
      <span class="gb-state" data-gb-state>…</span>
      <a class="gb-cta" data-gb-cta hidden href="#ground-this-claim">Ground this claim with a source</a>
    </div>
  )
}

GroundingBadge.afterDOMLoaded = `
document.querySelectorAll("[data-grounding-badge]").forEach(async (el) => {
  const id = el.dataset.entityId
  const stateEl = el.querySelector("[data-gb-state]")
  const cta = el.querySelector("[data-gb-cta]")
  const LABELS = {
    mental_model:      { t: "Mental model — ungrounded belief", cls: "gb-mental" },
    grounding_pending: { t: "⏳ Grounding pending",             cls: "gb-pending" },
    grounded:          { t: "Grounded",                          cls: "gb-grounded" },
    ingest_failed:     { t: "⚠ Ingest failed",                  cls: "gb-failed" },
  }
  try {
    const r = await fetch("/workbench/grounding/" + encodeURIComponent(id), { headers: { accept: "application/json" } })
    const j = await r.json()
    const meta = LABELS[j.state] || LABELS.mental_model
    stateEl.textContent = j.state === "grounded" ? "Grounded by " + j.grounded_sources + " source(s)" : meta.t
    el.classList.add(meta.cls)
    // The CTA is an invitation to legitimize a belief — NOT an "incomplete page".
    if (j.state === "mental_model") cta.hidden = false
  } catch {
    stateEl.textContent = "grounding state unavailable"
  }
})
`

GroundingBadge.css = `
.grounding-badge { display: inline-flex; gap: .5rem; align-items: center; margin: .25rem 0 .75rem; font-size: .8rem; padding: .2rem .5rem; border-radius: 6px; background: var(--lightgray); }
.grounding-badge.gb-grounded { background: color-mix(in srgb, var(--secondary) 18%, transparent); }
.grounding-badge.gb-failed { background: #f8d7da; }
.grounding-badge .gb-cta { font-weight: 600; }
`

export default (() => GroundingBadge) satisfies QuartzComponentConstructor
