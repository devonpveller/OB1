// SourceRevisions (P4.7) — the version history below a source body. Each compile
// commits the working edits as ONE revision (authored). This card lists them
// newest-first; clicking one expands an inline LINE DIFF vs the previous
// revision (red − deleted / green + added / unchanged lines collapsed to "⋯").
// The live "Uncommitted changes" diff (working head vs latest committed) shows at
// the top so you can see edits before the compile. Plain-DOM; reads
// GET /workbench/sources/:id/revisions (content included) + /:id (head).
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const SourceRevisions: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  if (fm.type !== "source" || fm.id == null) return null
  return (
    <div class={`source-revisions ${displayClass ?? ""}`} data-source-revisions data-source-id={String(fm.id)}>
      <div class="srv-head">
        <span class="srv-title">🕘 Revision history</span>
        <span class="srv-status" data-srv-status></span>
      </div>
      <p class="srv-help">
        Edits update a working copy; each compile commits them as one numbered revision, stamped with its
        author. Click a revision to see what changed (red = removed, green = added). Uncommitted edits show
        at the top.
      </p>
      <div class="srv-list" data-srv-list></div>
    </div>
  )
}

SourceRevisions.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-source-revisions]")
  if (!root || root.dataset.srvInit) return
  root.dataset.srvInit = "1"
  const id = root.dataset.sourceId
  const base = "/workbench/sources/" + encodeURIComponent(id)
  const list = root.querySelector("[data-srv-list]")
  const status = root.querySelector("[data-srv-status]")

  const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // LCS line diff (texts are modest; cap to avoid O(n*m) blow-ups).
  const diffLines = (a, b) => {
    const A = String(a || "").split("\\n"), B = String(b || "").split("\\n")
    const n = A.length, m = B.length
    if (n > 1500 || m > 1500) return null
    const dp = []
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    const res = []; let i = 0, j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) { res.push({ t: "ctx" }); i++; j++ }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ t: "del", s: A[i] }); i++ }
      else { res.push({ t: "add", s: B[j] }); j++ }
    }
    while (i < n) { res.push({ t: "del", s: A[i] }); i++ }
    while (j < m) { res.push({ t: "add", s: B[j] }); j++ }
    return res
  }
  const renderDiff = (oldT, newT) => {
    const d = diffLines(oldT, newT)
    if (d === null) return "<div class='srv-big'>large change — open the source to view</div>"
    const rows = []; let gap = false; let changes = 0
    for (const x of d) {
      if (x.t === "ctx") { gap = true; continue }
      if (gap && rows.length) rows.push("<div class='srv-gap'>⋯</div>")
      gap = false; changes++
      const cls = x.t === "add" ? "srv-add" : "srv-del"
      const sign = x.t === "add" ? "+" : "−"
      rows.push("<div class='srv-dline " + cls + "'><span class='srv-sign'>" + sign + "</span>" + (escHtml(x.s) || "&nbsp;") + "</div>")
    }
    return changes ? rows.join("") : "<div class='srv-nochange'>no line changes</div>"
  }
  const fmtDate = (s) => { try { return s ? new Date(s).toLocaleString() : "" } catch (e) { return s || "" } }

  const item = (label, sub, oldT, newT, openByDefault) => {
    const wrap = document.createElement("div"); wrap.className = "srv-item"
    const hd = document.createElement("button"); hd.className = "srv-item-head"; hd.type = "button"
    hd.innerHTML = "<span class='srv-arrow'>▸</span> <strong>" + escHtml(label) + "</strong> <span class='srv-sub'>" + escHtml(sub) + "</span>"
    const body = document.createElement("div"); body.className = "srv-diff"; body.hidden = true
    let rendered = false
    const toggle = () => {
      body.hidden = !body.hidden
      hd.querySelector(".srv-arrow").textContent = body.hidden ? "▸" : "▾"
      if (!body.hidden && !rendered) { body.innerHTML = renderDiff(oldT, newT); rendered = true }
    }
    hd.addEventListener("click", toggle)
    wrap.appendChild(hd); wrap.appendChild(body)
    if (openByDefault) toggle()
    return wrap
  }

  const load = async () => {
    try {
      const revs = (await (await fetch(base + "/revisions")).json()).revisions || []
      const src = (await (await fetch(base)).json()).source || {}
      const head = src.content || ""
      list.innerHTML = ""
      const latest = revs[0]
      if (latest && head !== (latest.content || "")) {
        list.appendChild(item("Uncommitted changes", "working draft · " + (src.last_edited_by || "operator") + " · commits at next compile", latest.content || "", head, true))
      } else if (!revs.length && head) {
        list.appendChild(item("Uncommitted changes", "working draft · not yet committed", "", head, true))
      }
      if (revs.length) {
        revs.forEach((r, idx) => {
          const prev = revs[idx + 1]
          const sub = (r.edited_by || "?") + " · " + fmtDate(r.edited_at) + " · " + (r.content_len != null ? r.content_len + " chars" : "")
          list.appendChild(item(prev ? "rev " + r.revision : "rev " + r.revision + " (baseline)", sub, prev ? (prev.content || "") : "", r.content || "", false))
        })
      } else if (!list.children.length) {
        list.innerHTML = "<div class='srv-empty'>no revisions yet — edits commit at the next compile.</div>"
      }
      status.textContent = ""
    } catch (e) { status.textContent = "history unavailable" }
  }
  // re-hydrate when a source edit was saved (the editor dispatches this)
  document.addEventListener("workbench-source-saved", () => load())
  load()
})
`

SourceRevisions.css = `
.source-revisions { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.source-revisions .srv-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.source-revisions .srv-title { font-weight: 600; font-size: .95rem; }
.source-revisions .srv-status { font-size: .76rem; color: var(--gray); }
.source-revisions .srv-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 74ch; }
.source-revisions .srv-item { border-top: 1px solid color-mix(in srgb, var(--lightgray) 60%, transparent); }
.source-revisions .srv-item:first-child { border-top: 0; }
.source-revisions .srv-item-head { width: 100%; text-align: left; background: none; border: 0; cursor: pointer; padding: .4rem 0; font-size: .84rem; color: var(--dark); }
.source-revisions .srv-arrow { color: var(--gray); display: inline-block; width: 1em; }
.source-revisions .srv-sub { color: var(--gray); font-size: .74rem; font-family: var(--codeFont); margin-left: .4rem; }
.source-revisions .srv-diff { font-family: var(--codeFont); font-size: .78rem; line-height: 1.5; margin: 0 0 .5rem; border-radius: 6px; overflow: hidden; border: 1px solid var(--lightgray); }
.source-revisions .srv-dline { padding: .05rem .5rem; white-space: pre-wrap; word-break: break-word; }
.source-revisions .srv-sign { display: inline-block; width: 1em; color: var(--gray); user-select: none; }
.source-revisions .srv-add { background: color-mix(in srgb, #2ea043 22%, transparent); }
.source-revisions .srv-del { background: color-mix(in srgb, #f85149 20%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, #f85149 70%, transparent); }
.source-revisions .srv-gap { text-align: center; color: var(--gray); padding: .05rem; background: color-mix(in srgb, var(--lightgray) 30%, transparent); }
.source-revisions .srv-nochange, .source-revisions .srv-empty, .source-revisions .srv-big { color: var(--gray); font-style: italic; font-size: .8rem; padding: .3rem 0; }
`

export default (() => SourceRevisions) satisfies QuartzComponentConstructor
