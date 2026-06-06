// PageTools (P3.5 follow-up) — a small GLOBAL toolbar on every readable page:
//   • Export — MD / PDF / TEXT / DOCX of THIS page (any page, not just notes;
//     the workbench export route reads any vault .md), via pandoc.
//   • Copy — a "Copy page" button, plus a per-heading copy button (hover) so the
//     reader can lift the whole page or any single section to the clipboard.
// The bar is relocated to the top of the article on load. Self-gates off folder
// /index listing pages (no single backing .md to export).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const PageTools: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const slug = String(fileData?.slug ?? "")
  if (!slug || slug.endsWith("/index")) return null // folder/list pages have no backing .md
  return (
    <div class={`page-tools ${displayClass ?? ""}`} data-page-tools data-vault-path={`${slug}.md`}>
      <span class="pt-group">
        <span class="pt-label">⬇ Export</span>
        <button class="pt-btn" data-pt-export="md">MD</button>
        <button class="pt-btn" data-pt-export="pdf">PDF</button>
        <button class="pt-btn" data-pt-export="txt">TEXT</button>
        <button class="pt-btn" data-pt-export="docx">DOCX</button>
      </span>
      <button class="pt-btn pt-copy" data-pt-copy>⧉ Copy page</button>
      <span class="pt-status" data-pt-status></span>
    </div>
  )
}

PageTools.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-page-tools]")
  if (!root) return
  const article = document.querySelector("article")
  const status = root.querySelector("[data-pt-status]")
  const vaultPath = root.dataset.vaultPath
  const flash = (el, msg, original) => { el.textContent = msg; setTimeout(() => { el.textContent = original }, 1200) }
  const copyText = (text, el, original) => {
    navigator.clipboard.writeText(text).then(() => flash(el, "✓ copied", original)).catch(() => { if (status) status.textContent = "copy failed (clipboard blocked)" })
  }

  // relocate the bar to the top of the article (once)
  if (!root.dataset.ptPlaced && article && article.parentElement) {
    root.dataset.ptPlaced = "1"
    article.parentElement.insertBefore(root, article)
  }

  // ── export ──
  if (!root.dataset.ptWired) {
    root.dataset.ptWired = "1"
    root.querySelectorAll("[data-pt-export]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const f = btn.dataset.ptExport
        if (status) status.textContent = "exporting " + f.toUpperCase() + "…"
        try {
          const r = await fetch("/workbench/export?path=" + encodeURIComponent(vaultPath) + "&format=" + f)
          if (!r.ok) { const j = await r.json().catch(() => ({})); if (status) status.textContent = "✗ " + (j.error || ("HTTP " + r.status)); return }
          const blob = await r.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement("a")
          a.href = url
          a.download = (vaultPath.split("/").pop() || "page").replace(/\\.md$/, "") + "." + f
          a.dataset.routerIgnore = "" // don't let Quartz SPA hijack the blob download
          document.body.appendChild(a); a.click(); a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          if (status) status.textContent = "✓ " + f.toUpperCase()
        } catch (e) { if (status) status.textContent = "✗ " + (e && e.message ? e.message : e) }
      })
    })
    const copyBtn = root.querySelector("[data-pt-copy]")
    copyBtn.addEventListener("click", async () => {
      // Copy the SAME clean text pandoc produces (correct newlines), unwrapped
      // so sentences flow when pasted — not the DOM's ragged innerText.
      copyBtn.textContent = "copying…"
      try {
        const r = await fetch("/workbench/export?path=" + encodeURIComponent(vaultPath) + "&format=txt&wrap=none")
        if (!r.ok) throw new Error("HTTP " + r.status)
        const text = await r.text()
        await navigator.clipboard.writeText(text)
        copyBtn.textContent = "✓ copied"; setTimeout(() => copyBtn.textContent = "⧉ Copy page", 1200)
      } catch (e) {
        // fallback: DOM text (better than nothing if the workbench is unreachable)
        if (article) {
          const clone = article.cloneNode(true)
          clone.querySelectorAll(".pt-copy-h").forEach(b => b.remove())
          copyText((clone.innerText || "").trim(), copyBtn, "⧉ Copy page")
        } else { copyBtn.textContent = "⧉ Copy page" }
      }
    })
  }

  // ── per-heading copy buttons (hover) ──
  if (article) {
    article.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(h => {
      if (h.dataset.ptCopyWired) return
      h.dataset.ptCopyWired = "1"
      const headingText = (h.textContent || "").trim()
      const b = document.createElement("button")
      b.className = "pt-copy-h"
      b.textContent = "⧉"
      b.title = "copy this section"
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation()
        const level = parseInt(h.tagName[1])
        const parts = [headingText]
        let el = h.nextElementSibling
        while (el && !(/^H[1-6]$/.test(el.tagName) && parseInt(el.tagName[1]) <= level)) {
          const t = el.innerText
          if (t) parts.push(t)
          el = el.nextElementSibling
        }
        copyText(parts.join("\\n\\n"), b, "⧉")
      })
      h.appendChild(b)
    })
  }
})
`

PageTools.css = `
.page-tools { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin: 0 0 .75rem; padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 8px; background: color-mix(in srgb, var(--lightgray) 20%, transparent); }
.page-tools .pt-group { display: inline-flex; align-items: center; gap: .3rem; }
.page-tools .pt-label { font-size: .74rem; color: var(--gray); }
.page-tools .pt-btn { font-size: .72rem; padding: .18rem .5rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 5px; cursor: pointer; }
.page-tools .pt-btn:hover { background: var(--lightgray); }
.page-tools .pt-copy { margin-left: auto; }
.page-tools .pt-status { font-size: .74rem; color: var(--gray); min-width: 2em; }
.pt-copy-h { margin-left: .5rem; border: 0; background: transparent; color: var(--gray); cursor: pointer; font-size: .8em; opacity: 0; transition: opacity .12s; vertical-align: middle; }
:is(h1,h2,h3,h4,h5,h6):hover .pt-copy-h { opacity: .65; }
.pt-copy-h:hover { opacity: 1 !important; }
`

export default (() => PageTools) satisfies QuartzComponentConstructor
