// RevisionHistory (P4.7) — ONE revision-history card for EVERY editable element
// (user notes AND sources), identical everywhere. The model + controls the
// operator asked for:
//   1. always save after edit  — autosave keeps a working draft (the editor).
//   2. Commit now              — deliberately add the draft to history.
//   3. Revert (per revision)   — commit current edits, then restore that version.
//   4. Discard (on uncommitted)— drop uncommitted edits, reset to the last commit.
// A kind-based adapter points at the right endpoints (sources = source_revisions;
// notes = git log) but the UI/logic is shared. Inline line diff: red − removed /
// green + added / unchanged → ⋯, each revision authored.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

const RevisionHistory: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  const slug = String(fileData?.slug ?? "")
  const isFolderPage = slug === "index" || slug.endsWith("/index")
  const isSource = fm.type === "source" && fm.id != null
  const isUserNote = !isFolderPage && slug.startsWith("notes/") && !slug.startsWith("notes/Changes")
  // Generated wiki pages (entity wikis, notebook hubs, thought leaves) are
  // committed to the vault on every compile, so they HAVE a git history — but
  // it's READ-ONLY (a revert would be overwritten by the next compile).
  const isWikiGen =
    !isFolderPage && !isSource && !isUserNote &&
    (fm.type === "wiki" || fm.type === "notebook" || fm.type === "thought")
  if (!isSource && !isUserNote && !isWikiGen) return null
  const kind = isSource ? "source" : isUserNote ? "note" : "wiki"
  return (
    <div
      class={`revision-history ${displayClass ?? ""}`}
      data-revision-history
      data-kind={kind}
      data-ref={isSource ? String(fm.id) : `${slug}.md`}
    >
      <div class="rh-head">
        <span class="rh-title">🕘 Revision history</span>
        <span class="rh-right">
          {kind !== "wiki" && <button class="rh-commit" data-rh-commit hidden>Commit now</button>}
          <span class="rh-status" data-rh-status></span>
        </span>
      </div>
      {kind === "wiki" ? (
        <p class="rh-help">
          This page is <strong>generated each compile</strong>, so its history is read-only. Each entry is a
          compile that changed the page — expand one to see what changed. Edit the underlying{" "}
          <strong>sources &amp; notes</strong> to shape what the next compile produces here.
        </p>
      ) : (
        <p class="rh-help">
          Edits are a working draft. <strong>Commit now</strong> (or Done) records an authored revision —
          otherwise the next compile commits it. <strong>Revert</strong> a revision to restore it (current
          edits are committed first); <strong>Discard</strong> drops uncommitted edits.
        </p>
      )}
      <div class="rh-list" data-rh-list></div>
    </div>
  )
}

RevisionHistory.afterDOMLoaded = `
document.addEventListener("nav", () => {
  const root = document.querySelector("[data-revision-history]")
  if (!root || root.dataset.rhInit) return
  root.dataset.rhInit = "1"
  const kind = root.dataset.kind
  const ref = root.dataset.ref
  const readOnly = kind === "wiki"
  const enc = encodeURIComponent
  const list = root.querySelector("[data-rh-list]")
  const status = root.querySelector("[data-rh-status]")
  const commitBtn = root.querySelector("[data-rh-commit]")

  // kind adapter — same UI, different endpoints. "wiki" is READ-ONLY: the git
  // log of the generated page (no commit/revert/discard — the compiler owns it).
  const A = readOnly ? {
    history: async () => {
      const j = await (await fetch("/workbench/note-history?path=" + enc(ref))).json()
      return { revisions: (j.revisions || []).map(r => ({ ref: r.hash, author: r.author, date: r.date, content: r.content || "", label: "compile " + String(r.hash || "").slice(0, 8), message: r.message || "" })), working: j.working || "" }
    },
  } : kind === "source" ? {
    history: async () => {
      const revs = (await (await fetch("/workbench/sources/" + enc(ref) + "/revisions")).json()).revisions || []
      const head = ((await (await fetch("/workbench/sources/" + enc(ref))).json()).source || {}).content || ""
      return { revisions: revs.map(r => ({ ref: r.revision, author: r.edited_by, date: r.edited_at, content: r.content || "", label: "rev " + r.revision, message: "" })), working: head }
    },
    commit: () => fetch("/workbench/sources/" + enc(ref) + "/commit", { method: "POST" }),
    revert: (rr) => fetch("/workbench/sources/" + enc(ref) + "/revert/" + enc(rr), { method: "POST" }),
    discard: () => fetch("/workbench/sources/" + enc(ref) + "/discard", { method: "POST" }),
  } : {
    history: async () => {
      const j = await (await fetch("/workbench/note-history?path=" + enc(ref))).json()
      return { revisions: (j.revisions || []).map(r => ({ ref: r.hash, author: r.author, date: r.date, content: r.content || "", label: "commit " + String(r.hash || "").slice(0, 8), message: r.message || "" })), working: j.working || "" }
    },
    commit: () => fetch("/workbench/note-commit?path=" + enc(ref), { method: "POST" }),
    revert: (rr) => fetch("/workbench/note-commit/revert?path=" + enc(ref) + "&hash=" + enc(rr), { method: "POST" }),
    discard: () => fetch("/workbench/note-commit/discard?path=" + enc(ref), { method: "POST" }),
  }
  const savedEvent = kind === "source" ? "workbench-source-saved" : "workbench-note-saved"

  const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const diffLines = (a, b) => {
    const A2 = String(a || "").split("\\n"), B2 = String(b || "").split("\\n")
    const n = A2.length, m = B2.length
    if (n > 1500 || m > 1500) return null
    const dp = []
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A2[i] === B2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    const res = []; let i = 0, j = 0
    while (i < n && j < m) {
      if (A2[i] === B2[j]) { res.push({ t: "ctx" }); i++; j++ }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ t: "del", s: A2[i] }); i++ }
      else { res.push({ t: "add", s: B2[j] }); j++ }
    }
    while (i < n) { res.push({ t: "del", s: A2[i] }); i++ }
    while (j < m) { res.push({ t: "add", s: B2[j] }); j++ }
    return res
  }
  const renderDiff = (oldT, newT) => {
    const d = diffLines(oldT, newT)
    if (d === null) return "<div class='rh-muted'>large change — open the page to view</div>"
    const rows = []; let gap = false; let changes = 0
    for (const x of d) {
      if (x.t === "ctx") { gap = true; continue }
      if (gap && rows.length) rows.push("<div class='rh-gap'>⋯</div>")
      gap = false; changes++
      const cls = x.t === "add" ? "rh-add" : "rh-del"
      const sign = x.t === "add" ? "+" : "−"
      rows.push("<div class='rh-dline " + cls + "'><span class='rh-sign'>" + sign + "</span>" + (escHtml(x.s) || "&nbsp;") + "</div>")
    }
    return changes ? rows.join("") : "<div class='rh-muted'>no line changes</div>"
  }
  const fmtDate = (s) => { try { return s ? new Date(s).toLocaleString() : "" } catch (e) { return s || "" } }

  const item = (label, sub, oldT, newT, openByDefault, action) => {
    const wrap = document.createElement("div"); wrap.className = "rh-item"
    const hd = document.createElement("div"); hd.className = "rh-item-head"
    const tog = document.createElement("button"); tog.type = "button"; tog.className = "rh-toggle"
    tog.innerHTML = "<span class='rh-arrow'>▸</span> <strong>" + escHtml(label) + "</strong> <span class='rh-sub'>" + escHtml(sub) + "</span>"
    hd.appendChild(tog)
    if (action) {
      const ab = document.createElement("button"); ab.type = "button"; ab.className = "rh-action " + (action.cls || ""); ab.textContent = action.label
      ab.addEventListener("click", (e) => { e.stopPropagation(); action.fn() })
      hd.appendChild(ab)
    }
    const body = document.createElement("div"); body.className = "rh-diff"; body.hidden = true
    let rendered = false
    const toggle = () => {
      body.hidden = !body.hidden
      tog.querySelector(".rh-arrow").textContent = body.hidden ? "▸" : "▾"
      if (!body.hidden && !rendered) { body.innerHTML = renderDiff(oldT, newT); rendered = true }
    }
    tog.addEventListener("click", toggle)
    wrap.appendChild(hd); wrap.appendChild(body)
    if (openByDefault) toggle()
    return wrap
  }

  const afterMutate = (reloadNote) => {
    document.dispatchEvent(new CustomEvent(savedEvent))
    if (kind === "note" && reloadNote) {
      // the note's static page rebuilds from the changed file; reload to show it
      status.textContent = "↻ updating…"
      setTimeout(() => location.reload(), 1000)
      return
    }
    load()
  }
  const doCommit = async () => {
    commitBtn.disabled = true; status.textContent = "committing…"
    try { const r = await A.commit(); if (!r.ok) throw new Error("HTTP " + r.status); status.textContent = "✓ committed"; afterMutate(false) }
    catch (e) { status.textContent = "✗ commit failed" }
    commitBtn.disabled = false
  }
  const doRevert = async (rr) => {
    if (!confirm("Revert to this version?\\n\\nAny uncommitted changes are committed first (kept in history), then the content is replaced with this version — which you can then commit.")) return
    status.textContent = "reverting…"
    try { const r = await A.revert(rr); if (!r.ok) throw new Error("HTTP " + r.status); status.textContent = "✓ reverted"; afterMutate(true) }
    catch (e) { status.textContent = "✗ revert failed" }
  }
  const doDiscard = async () => {
    if (!confirm("Discard ALL uncommitted changes and reset to the last committed version?\\n\\nThis can't be undone.")) return
    status.textContent = "discarding…"
    try { const r = await A.discard(); if (!r.ok) throw new Error("HTTP " + r.status); status.textContent = "✓ discarded"; afterMutate(true) }
    catch (e) { status.textContent = "✗ discard failed" }
  }

  const load = async () => {
    try {
      const { revisions, working } = await A.history()
      const latest = revisions[0]
      const dirty = !readOnly && (latest ? working !== latest.content : !!working)
      if (commitBtn) commitBtn.hidden = !dirty
      list.innerHTML = ""
      if (dirty) list.appendChild(item("Uncommitted changes", "working draft · commit now, or at next compile", latest ? latest.content : "", working, true, { label: "Discard edit", cls: "rh-danger", fn: doDiscard }))
      revisions.forEach((r, idx) => {
        const prev = revisions[idx + 1]
        const sub = (r.author || "?") + " · " + fmtDate(r.date) + (r.message ? " · " + r.message : "")
        list.appendChild(item(r.label, sub, prev ? prev.content : "", r.content, false, readOnly ? null : { label: "Revert", fn: () => doRevert(r.ref) }))
      })
      if (!revisions.length && !dirty) list.innerHTML = "<div class='rh-muted'>no revisions yet.</div>"
      status.textContent = ""
    } catch (e) { status.textContent = "history unavailable" }
  }
  if (commitBtn) commitBtn.addEventListener("click", doCommit)
  document.addEventListener(savedEvent, () => load())
  load()
})
`

RevisionHistory.css = `
.revision-history { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--lightgray); border-radius: 10px; background: color-mix(in srgb, var(--lightgray) 25%, transparent); }
.revision-history .rh-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.revision-history .rh-title { font-weight: 600; font-size: .95rem; }
.revision-history .rh-right { display: inline-flex; align-items: center; gap: .5rem; }
.revision-history .rh-commit { font-size: .74rem; padding: .2rem .6rem; border: 1px solid var(--secondary); background: var(--secondary); color: var(--light); border-radius: 6px; cursor: pointer; }
.revision-history .rh-commit:disabled { opacity: .5; cursor: default; }
.revision-history .rh-status { font-size: .76rem; color: var(--gray); }
.revision-history .rh-help { font-size: .76rem; color: var(--gray); line-height: 1.5; margin: .45rem 0 .6rem; max-width: 76ch; }
.revision-history .rh-item { border-top: 1px solid color-mix(in srgb, var(--lightgray) 60%, transparent); }
.revision-history .rh-item:first-child { border-top: 0; }
.revision-history .rh-item-head { display: flex; align-items: center; gap: .5rem; }
.revision-history .rh-toggle { flex: 1; text-align: left; background: none; border: 0; cursor: pointer; padding: .4rem 0; font-size: .84rem; color: var(--dark); }
.revision-history .rh-arrow { color: var(--gray); display: inline-block; width: 1em; }
.revision-history .rh-sub { color: var(--gray); font-size: .74rem; font-family: var(--codeFont); margin-left: .4rem; }
.revision-history .rh-action { font-size: .7rem; padding: .12rem .5rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 5px; cursor: pointer; white-space: nowrap; }
.revision-history .rh-action:hover { background: var(--lightgray); }
.revision-history .rh-action.rh-danger { color: #c0392b; border-color: color-mix(in srgb, #c0392b 50%, var(--lightgray)); }
.revision-history .rh-diff { font-family: var(--codeFont); font-size: .78rem; line-height: 1.5; margin: 0 0 .5rem; border-radius: 6px; overflow: hidden; border: 1px solid var(--lightgray); }
.revision-history .rh-dline { padding: .05rem .5rem; white-space: pre-wrap; word-break: break-word; }
.revision-history .rh-sign { display: inline-block; width: 1em; color: var(--gray); user-select: none; }
.revision-history .rh-add { background: color-mix(in srgb, #2ea043 22%, transparent); }
.revision-history .rh-del { background: color-mix(in srgb, #f85149 20%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, #f85149 70%, transparent); }
.revision-history .rh-gap { text-align: center; color: var(--gray); padding: .05rem; background: color-mix(in srgb, var(--lightgray) 30%, transparent); }
.revision-history .rh-muted { color: var(--gray); font-style: italic; font-size: .8rem; padding: .3rem 0; }
`

export default (() => RevisionHistory) satisfies QuartzComponentConstructor
