// NoteRevisions (P4.7) — version history below a USER NOTE, the note-side twin of
// SourceRevisions. Notes are git-backed (the vault repo), so a note's history is
// its git log: each committed revision (authored) expands to an inline line diff
// (red − removed / green + added / unchanged → ⋯). A live "Uncommitted changes"
// diff (working file vs latest commit) shows at the top, with a **Commit now**
// button — edits otherwise commit at the next compile. Reads
// GET /workbench/note-history; POST /workbench/note-commit.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const NoteRevisions: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const slug = String(fileData?.slug ?? "")
  const isFolderPage = slug === "index" || slug.endsWith("/index")
  const isUserNote = !isFolderPage && slug.startsWith("notes/") && !slug.startsWith("notes/Changes")
  if (!isUserNote) return null
  return (
    <div class={`note-revisions ${displayClass ?? ""}`} data-note-revisions data-note-path={`${slug}.md`}>
      <div class="nrv-head">
        <span class="nrv-title">🕘 Revision history</span>
        <span class="nrv-right">
          <button class="nrv-commit" data-nrv-commit hidden>Commit now</button>
          <span class="nrv-status" data-nrv-status></span>
        </span>
      </div>
      <p class="nrv-help">
        Edits are a working draft; clicking <strong>Done</strong> records an authored revision, or use
        <strong> Commit now</strong> — otherwise the next compile commits pending edits. Click a revision
        to see what changed.
      </p>
      <div class="nrv-list" data-nrv-list></div>
    </div>
  )
}

NoteRevisions.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-note-revisions]")
  if (!root || root.dataset.nrvInit) return
  root.dataset.nrvInit = "1"
  const notePath = root.dataset.notePath
  const histUrl = "/workbench/note-history?path=" + encodeURIComponent(notePath)
  const list = root.querySelector("[data-nrv-list]")
  const status = root.querySelector("[data-nrv-status]")
  const commitBtn = root.querySelector("[data-nrv-commit]")

  const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
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
    if (d === null) return "<div class='nrv-big'>large change — open the note to view</div>"
    const rows = []; let gap = false; let changes = 0
    for (const x of d) {
      if (x.t === "ctx") { gap = true; continue }
      if (gap && rows.length) rows.push("<div class='nrv-gap'>⋯</div>")
      gap = false; changes++
      const cls = x.t === "add" ? "nrv-add" : "nrv-del"
      const sign = x.t === "add" ? "+" : "−"
      rows.push("<div class='nrv-dline " + cls + "'><span class='nrv-sign'>" + sign + "</span>" + (escHtml(x.s) || "&nbsp;") + "</div>")
    }
    return changes ? rows.join("") : "<div class='nrv-nochange'>no line changes</div>"
  }
  const fmtDate = (s) => { try { return s ? new Date(s).toLocaleString() : "" } catch (e) { return s || "" } }
  const item = (label, sub, oldT, newT, openByDefault) => {
    const wrap = document.createElement("div"); wrap.className = "nrv-item"
    const hd = document.createElement("button"); hd.className = "nrv-item-head"; hd.type = "button"
    hd.innerHTML = "<span class='nrv-arrow'>▸</span> <strong>" + escHtml(label) + "</strong> <span class='nrv-sub'>" + escHtml(sub) + "</span>"
    const body = document.createElement("div"); body.className = "nrv-diff"; body.hidden = true
    let rendered = false
    const toggle = () => {
      body.hidden = !body.hidden
      hd.querySelector(".nrv-arrow").textContent = body.hidden ? "▸" : "▾"
      if (!body.hidden && !rendered) { body.innerHTML = renderDiff(oldT, newT); rendered = true }
    }
    hd.addEventListener("click", toggle)
    wrap.appendChild(hd); wrap.appendChild(body)
    if (openByDefault) toggle()
    return wrap
  }

  const load = async () => {
    try {
      const j = await (await fetch(histUrl)).json()
      const revs = j.revisions || []
      const working = j.working || ""
      const latest = revs[0]
      const dirty = latest ? working !== (latest.content || "") : !!working
      commitBtn.hidden = !dirty
      list.innerHTML = ""
      if (dirty) list.appendChild(item("Uncommitted changes", "working draft · commit now, or at next compile", latest ? (latest.content || "") : "", working, true))
      revs.forEach((r, idx) => {
        const prev = revs[idx + 1]
        const sub = (r.author || "?") + " · " + fmtDate(r.date) + (r.message ? " · " + r.message : "")
        list.appendChild(item("commit " + String(r.hash || "").slice(0, 8), sub, prev ? (prev.content || "") : "", r.content || "", false))
      })
      if (!revs.length && !dirty) list.innerHTML = "<div class='nrv-empty'>no revisions yet.</div>"
      status.textContent = ""
    } catch (e) { status.textContent = "history unavailable" }
  }
  commitBtn.addEventListener("click", async () => {
    commitBtn.disabled = true; status.textContent = "committing…"
    try {
      const r = await fetch("/workbench/note-commit?path=" + encodeURIComponent(notePath), { method: "POST" })
      if (!r.ok) throw new Error("HTTP " + r.status)
      status.textContent = "✓ committed"
      await load()
    } catch (e) { status.textContent = "✗ commit failed" }
    commitBtn.disabled = false
  })
  document.addEventListener("workbench-note-saved", () => load())
  load()
})
`

NoteRevisions.css = `
.note-revisions { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.note-revisions .nrv-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.note-revisions .nrv-title { font-weight: 600; font-size: .95rem; }
.note-revisions .nrv-right { display: inline-flex; align-items: center; gap: .5rem; }
.note-revisions .nrv-commit { font-size: .74rem; padding: .2rem .6rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 6px; cursor: pointer; }
.note-revisions .nrv-commit:disabled { opacity: .5; cursor: default; }
.note-revisions .nrv-status { font-size: .76rem; color: var(--gray); }
.note-revisions .nrv-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 74ch; }
.note-revisions .nrv-item { border-top: 1px solid color-mix(in srgb, var(--lightgray) 60%, transparent); }
.note-revisions .nrv-item:first-child { border-top: 0; }
.note-revisions .nrv-item-head { width: 100%; text-align: left; background: none; border: 0; cursor: pointer; padding: .4rem 0; font-size: .84rem; color: var(--dark); }
.note-revisions .nrv-arrow { color: var(--gray); display: inline-block; width: 1em; }
.note-revisions .nrv-sub { color: var(--gray); font-size: .74rem; font-family: var(--codeFont); margin-left: .4rem; }
.note-revisions .nrv-diff { font-family: var(--codeFont); font-size: .78rem; line-height: 1.5; margin: 0 0 .5rem; border-radius: 6px; overflow: hidden; border: 1px solid var(--lightgray); }
.note-revisions .nrv-dline { padding: .05rem .5rem; white-space: pre-wrap; word-break: break-word; }
.note-revisions .nrv-sign { display: inline-block; width: 1em; color: var(--gray); user-select: none; }
.note-revisions .nrv-add { background: color-mix(in srgb, #2ea043 22%, transparent); }
.note-revisions .nrv-del { background: color-mix(in srgb, #f85149 20%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, #f85149 70%, transparent); }
.note-revisions .nrv-gap { text-align: center; color: var(--gray); padding: .05rem; background: color-mix(in srgb, var(--lightgray) 30%, transparent); }
.note-revisions .nrv-nochange, .note-revisions .nrv-empty, .note-revisions .nrv-big { color: var(--gray); font-style: italic; font-size: .8rem; padding: .3rem 0; }
`

export default (() => NoteRevisions) satisfies QuartzComponentConstructor
