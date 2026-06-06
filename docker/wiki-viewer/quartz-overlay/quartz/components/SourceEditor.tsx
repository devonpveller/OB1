// SourceEditor (P4.7) — inline "update this source / record a revision" on a
// source leaf page, as a card (consistent UX). Update is IN-PLACE and versioned:
// the prior content snapshots into source_revisions, the head updates, the
// source id never changes (so links stay valid). There is deliberately NO
// "replace" affordance — "a better source exists" = ADD a new source. URL
// sources offer "Re-fetch from source" (→ a new revision). Version history is
// listed. Hydrates from the leaf frontmatter id (type=source).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceEditor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  return (
    <div class={`source-editor ${displayClass ?? ""}`} data-source-editor data-source-id={String(fm.id)}>
      <div class="se-head">
        <span class="se-title">✏️ Source content</span>
        <span class="se-status" data-se-status></span>
      </div>
      <p class="se-help">
        Update this source <strong>in place</strong> — your edit is saved as a new <strong>revision</strong>
        (the history is kept and the source id never changes, so every link to it stays valid). An update
        is <strong>never a replace</strong>: to use a different source, <em>add a new source</em> rather
        than overwriting this one.
      </p>
      <label class="se-field">Title<input class="se-input" data-se-title /></label>
      <label class="se-field">Content<textarea class="se-textarea" data-se-content></textarea></label>
      <div class="se-actions">
        <button class="se-update" data-se-update>Update this source / record a revision</button>
        <button class="se-refetch" data-se-refetch hidden>↻ Re-fetch from source</button>
      </div>
      <button class="se-hist-toggle" data-se-hist-toggle>
        <span data-se-arrow>▸</span> Version history <span class="se-hist-count" data-se-hist-count></span>
      </button>
      <ul class="se-hist" data-se-hist hidden></ul>
    </div>
  )
}

SourceEditor.afterDOMLoaded = `
document.addEventListener("nav", () => {
  document.querySelectorAll("[data-source-editor]").forEach(async (el) => {
    if (el.dataset.seInit) return
    el.dataset.seInit = "1"
    const id = el.dataset.sourceId
    const base = "/workbench/sources/" + encodeURIComponent(id)
    const titleEl = el.querySelector("[data-se-title]")
    const contentEl = el.querySelector("[data-se-content]")
    const status = el.querySelector("[data-se-status]")
    const updateBtn = el.querySelector("[data-se-update]")
    const refetchBtn = el.querySelector("[data-se-refetch]")
    const histToggle = el.querySelector("[data-se-hist-toggle]")
    const arrow = el.querySelector("[data-se-arrow]")
    const histList = el.querySelector("[data-se-hist]")
    const histCount = el.querySelector("[data-se-hist-count]")

    const loadSource = async () => {
      try {
        const s = (await (await fetch(base)).json()).source || {}
        titleEl.value = s.title || ""
        contentEl.value = s.content || ""
        const url = s.url || null
        refetchBtn.hidden = !url
        if (url) refetchBtn.title = "re-pull " + url
      } catch (e) { status.textContent = "load failed" }
    }
    const loadHistory = async () => {
      try {
        const revs = (await (await fetch(base + "/revisions")).json()).revisions || []
        histCount.textContent = "(" + revs.length + ")"
        histList.innerHTML = ""
        if (!revs.length) { histList.innerHTML = "<li class='se-empty'>no prior revisions yet — the first edit creates one.</li>"; return }
        revs.forEach(rev => {
          const li = document.createElement("li")
          const when = rev.edited_at ? new Date(rev.edited_at).toLocaleString() : ""
          li.textContent = "rev " + rev.revision + " · " + when + (rev.content_len != null ? " · " + rev.content_len + " chars" : "") + (rev.edited_by ? " · " + rev.edited_by : "")
          histList.appendChild(li)
        })
      } catch (e) { histCount.textContent = "" }
    }
    histToggle.addEventListener("click", () => {
      histList.hidden = !histList.hidden
      arrow.textContent = histList.hidden ? "▸" : "▾"
      if (!histList.hidden) loadHistory()
    })
    updateBtn.addEventListener("click", async () => {
      status.textContent = "saving revision…"; updateBtn.disabled = true
      try {
        const r = await fetch(base, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: titleEl.value, content: contentEl.value }) })
        if (!r.ok) { const e = await r.json().catch(() => ({})); status.textContent = "✗ " + (e.error || ("HTTP " + r.status)) }
        else { status.textContent = "✓ updated — the prior version was saved as a revision and a re-embed enqueued. The page refreshes on the next compile."; loadHistory() }
      } catch (e) { status.textContent = "✗ " + (e && e.message ? e.message : e) }
      updateBtn.disabled = false
    })
    refetchBtn.addEventListener("click", async () => {
      status.textContent = "re-fetching from source…"; refetchBtn.disabled = true
      try {
        const r = await fetch(base + "/refetch", { method: "POST" })
        if (!r.ok) { const e = await r.json().catch(() => ({})); status.textContent = "✗ re-fetch failed: " + (e.error || ("HTTP " + r.status)) }
        else { status.textContent = "✓ re-fetched — landed as a new revision (your edits are preserved as history)."; await loadSource(); loadHistory() }
      } catch (e) { status.textContent = "✗ " + (e && e.message ? e.message : e) }
      refetchBtn.disabled = false
    })

    loadSource()
    loadHistory()
  })
})
`

SourceEditor.css = `
.source-editor { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.source-editor .se-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.source-editor .se-title { font-weight: 600; font-size: .95rem; }
.source-editor .se-status { font-size: .76rem; color: var(--gray); text-align: right; }
.source-editor .se-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 74ch; }
.source-editor .se-field { display: flex; flex-direction: column; font-size: .72rem; color: var(--gray); gap: .2rem; margin-bottom: .5rem; }
.source-editor .se-input { padding: .35rem .5rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); font-size: .9rem; }
.source-editor .se-textarea { min-height: 160px; resize: vertical; padding: .5rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); font-family: var(--codeFont); font-size: .82rem; line-height: 1.5; }
.source-editor .se-actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.source-editor .se-update { font-size: .82rem; font-weight: 600; padding: .4rem .85rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 7px; cursor: pointer; }
.source-editor .se-update:disabled { opacity: .5; cursor: default; }
.source-editor .se-refetch { font-size: .8rem; padding: .4rem .75rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 7px; cursor: pointer; }
.source-editor .se-hist-toggle { margin-top: .6rem; font-size: .76rem; color: var(--gray); background: none; border: 0; cursor: pointer; padding: 0; text-transform: uppercase; letter-spacing: .03em; }
.source-editor .se-hist-count { color: var(--gray); }
.source-editor .se-hist { list-style: none; margin: .4rem 0 0; padding: 0; }
.source-editor .se-hist[hidden] { display: none; }
.source-editor .se-hist li { font-size: .76rem; color: var(--gray); font-family: var(--codeFont); padding: .2rem 0; border-bottom: 1px solid color-mix(in srgb, var(--lightgray) 50%, transparent); }
.source-editor .se-hist li:last-child { border-bottom: 0; }
.source-editor .se-empty { font-family: inherit !important; font-style: italic; border-bottom: 0 !important; }
`

export default (() => SourceEditor) satisfies QuartzComponentConstructor
