// P0.4 proving component — confirms the overlay loads AND that a client
// `fetch('/workbench/health')` reaches the workbench through the same-origin
// portal route. Renders a tiny status pill that the inline script hydrates.
// This is the template every later interactive component follows: a thin
// build-time constructor component + a `.inline.ts` that does the work.
//
// Once P2+ components exist this can be dropped from the layout; it stays in
// the overlay as the canonical minimal example.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const WorkbenchProbe: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div class={`workbench-probe ${displayClass ?? ""}`} data-workbench-probe>
      <span class="wb-probe-label">workbench</span>
      <span class="wb-probe-state" data-wb-state>…</span>
    </div>
  )
}

WorkbenchProbe.afterDOMLoaded = `
document.querySelectorAll("[data-workbench-probe]").forEach(async (el) => {
  const out = el.querySelector("[data-wb-state]")
  try {
    const r = await fetch("/workbench/health", { headers: { "accept": "application/json" } })
    const j = await r.json()
    out.textContent = j && j.ok ? "online" : "degraded"
    el.dataset.wbOk = j && j.ok ? "1" : "0"
  } catch {
    out.textContent = "offline"
    el.dataset.wbOk = "0"
  }
})
`

WorkbenchProbe.css = `
.workbench-probe { display: inline-flex; gap: .4rem; align-items: center; font-size: .75rem; opacity: .7; }
.workbench-probe .wb-probe-label { text-transform: uppercase; letter-spacing: .05em; }
.workbench-probe[data-wb-ok="1"] .wb-probe-state { color: var(--secondary); }
.workbench-probe[data-wb-ok="0"] .wb-probe-state { color: #c0392b; }
`

export default (() => WorkbenchProbe) satisfies QuartzComponentConstructor
