// GroundingPanel (P6.1/P6.9) — the full-width "ground this claim / add sources"
// card on a generated entity (wiki) page. It is the entity-page sibling of
// NotebookPage: same card UX, so adding evidence feels consistent everywhere.
// Replaces the old cramped rail GroundingBadge. Hydrates from the workbench via
// the baked frontmatter entity_id (G12), shows the grounding STATE + the sources
// backing the page + a "Ground this claim" action, and explains what grounding
// does. Plain-DOM hydration on Quartz's "nav" event; lives in afterBody (center).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const GroundingPanel: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  // Only generated entity pages carry entity_id; inert on every other page class.
  if (fm.type !== "wiki" || fm.entity_id == null) return null
  return (
    <div class={`grounding-panel ${displayClass ?? ""}`} data-grounding-panel data-entity-id={String(fm.entity_id)}>
      <div class="gp-head">
        <span class="gp-title">🔭 Grounding</span>
        <span class="gp-state" data-gp-state>…</span>
      </div>
      <p class="gp-help" data-gp-help>
        Wiki pages are built from your captured thoughts. <strong>Grounding</strong> attaches real
        evidence (a document, a URL, or an existing source) to this claim so the next wiki compile can
        cite it — turning an unverified belief into a sourced entity. It's an invitation to legitimize the
        page deliberately, not an error report.
      </p>
      <section class="gp-sec" data-gp-sources hidden>
        <h3 class="gp-h">
          Grounding sources <span class="gp-count" data-gp-src-count></span>
          <button class="gp-copy" data-gp-copy hidden>⧉ copy</button>
        </h3>
        <ul class="gp-list" data-gp-src-list></ul>
      </section>
      <button class="gp-ground" data-gp-ground>Ground this claim with a source</button>
    </div>
  )
}

GroundingPanel.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-grounding-panel]")
  if (!root || root.dataset.gpInit) return
  root.dataset.gpInit = "1"
  const id = root.dataset.entityId
  const stateEl = root.querySelector("[data-gp-state]")
  const helpEl = root.querySelector("[data-gp-help]")

  const LABELS = {
    mental_model:      { t: "Mental model — ungrounded belief", cls: "gp-mental",  help: "This page rests on your captured thoughts, with no external evidence yet. Attach a source below to ground it — an invitation to legitimize the belief, not an error." },
    grounding_pending: { t: "⏳ Grounding pending",             cls: "gp-pending", help: "A source is linked and ingesting. On the next wiki compile this page regenerates citing it, and the badge flips to “Grounded”." },
    grounded:          { t: "Grounded",                          cls: "gp-grounded", help: "This page is backed by real sources (below): its synthesis can cite them as fact. Add more to strengthen it." },
    ingest_failed:     { t: "⚠ Ingest failed",                  cls: "gp-failed",  help: "The last grounding attempt failed to ingest (bad URL or unparseable file). Try another source — the page was not regenerated." },
  }

  const renderSources = (sources) => {
    const sec = root.querySelector("[data-gp-sources]")
    const list = root.querySelector("[data-gp-src-list]")
    list.innerHTML = ""
    root.querySelector("[data-gp-src-count]").textContent = "(" + sources.length + ")"
    sec.hidden = sources.length === 0
    const copyBtn = root.querySelector("[data-gp-copy]")
    copyBtn.hidden = sources.length === 0
    copyBtn.onclick = () => {
      const lines = sources.map((s, i) => "[" + (i + 1) + "] " + (s.title || s.url || s.id) + (s.url ? ". " + s.url : "."))
      navigator.clipboard.writeText(lines.join("\\n")).then(() => { copyBtn.textContent = "✓ copied"; setTimeout(() => copyBtn.textContent = "⧉ copy", 1200) }).catch(() => {})
    }
    sources.forEach(s => {
      const li = document.createElement("li")
      const a = document.createElement("a")
      a.className = "internal"
      a.href = "/content/source/" + s.id
      a.textContent = s.title || s.url || s.id
      li.appendChild(a)
      if (s.content_type) { const ct = document.createElement("span"); ct.className = "gp-ct"; ct.textContent = s.content_type; li.appendChild(ct) }
      if (s.mention_role === "user_linked") { const m = document.createElement("span"); m.className = "gp-manual"; m.textContent = "you linked"; li.appendChild(m) }
      list.appendChild(li)
    })
  }

  const refresh = async () => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const j = await (await fetch("/workbench/grounding/" + encodeURIComponent(id), { signal: ctrl.signal })).json()
      clearTimeout(t)
      const meta = LABELS[j.state] || LABELS.mental_model
      stateEl.textContent = j.state === "grounded" ? "Grounded by " + j.grounded_sources + " source(s)" : meta.t
      stateEl.className = "gp-state " + meta.cls
      if (helpEl && meta.help) helpEl.textContent = meta.help
      renderSources(j.sources || [])
    } catch (e) {
      stateEl.textContent = "grounding state unavailable"
    }
  }

  // "Ground this claim" opens the shared upload modal, pre-targeted to THIS
  // entity (the same route P5 import uses, with target_entity_ids).
  root.querySelector("[data-gp-ground]").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("open-upload-modal", { detail: { entityId: id, title: "Ground this claim with a source" } }))
  })
  // Re-hydrate after a source is grounded/linked via the modal.
  document.addEventListener("workbench-notebook-changed", () => refresh())

  refresh()
})
`

GroundingPanel.css = `
.grounding-panel { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.grounding-panel .gp-head { display: flex; align-items: baseline; gap: .75rem; }
.grounding-panel .gp-title { font-weight: 600; font-size: .95rem; }
.grounding-panel .gp-state { font-size: .8rem; padding: .15rem .55rem; border-radius: 6px; background: var(--lightgray); color: var(--darkgray); }
.grounding-panel .gp-state.gp-grounded { background: color-mix(in srgb, var(--secondary) 20%, transparent); color: var(--dark); }
.grounding-panel .gp-state.gp-failed { background: #f8d7da; color: #842029; }
.grounding-panel .gp-state.gp-pending { background: color-mix(in srgb, #e0a800 25%, transparent); }
.grounding-panel .gp-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .5rem; max-width: 72ch; }
.grounding-panel .gp-h { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--gray); margin: .3rem 0; }
.grounding-panel .gp-count { color: var(--gray); font-weight: 400; }
.grounding-panel .gp-copy { float: right; text-transform: none; letter-spacing: 0; font-size: .72rem; padding: .15rem .5rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; }
.grounding-panel .gp-copy:hover { background: var(--lightgray); }
.grounding-panel .gp-list { list-style: none; margin: 0 0 .6rem; padding: 0; }
.grounding-panel .gp-list li { display: flex; align-items: center; gap: .5rem; padding: .25rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); font-size: .85rem; }
.grounding-panel .gp-list li:last-child { border-bottom: 0; }
.grounding-panel .gp-ct { font-size: .68rem; color: var(--gray); font-family: var(--codeFont); background: var(--lightgray); padding: 0 .3em; border-radius: 4px; }
.grounding-panel .gp-manual { font-size: .68rem; color: var(--secondary); border: 1px solid var(--secondary); padding: 0 .3em; border-radius: 4px; }
.grounding-panel .gp-ground { font-size: .85rem; padding: .4rem .85rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 7px; cursor: pointer; font-weight: 600; }
.grounding-panel .gp-ground:hover { filter: brightness(1.08); }
`

export default (() => GroundingPanel) satisfies QuartzComponentConstructor
