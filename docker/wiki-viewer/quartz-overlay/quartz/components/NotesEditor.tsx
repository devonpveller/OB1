// NotesEditor (P3.5, WYSIWYG) — the author-owned notes layer, edited IN PLACE on
// the page (no shadowbox). On a user-note page an "✎ Edit" toolbar swaps the
// rendered prose for a CodeMirror 6 Live-Preview editor (Obsidian-style: type
// inside the rendered text, caret line shows raw markdown), with [[ ]] link
// autocomplete and autosave (~1.5s) via PUT /workbench/notes (If-Match). New
// notes are created from a notebook hub. All client logic lives in the bundled
// inline module so it can pull in CodeMirror as a real dependency.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore — Quartz's inline-script-loader bundles this (with its npm deps,
// incl. CodeMirror) into a string at build time.
import script from "./scripts/NotesEditor.inline"

const NotesEditor: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const fm = (fileData?.frontmatter ?? {}) as Record<string, unknown>
  const showLauncher = fm.type === "notebook"
  // A user note is ANY page from the author-owned notes/ layer (notes/notebooks/
  // <nb>/x.md AND a flat notes/x.md). The page's own slug IS its vault path; the
  // API path is relative to notes/, so strip the leading "notes/". The Changes
  // log is machine-written, so it's excluded.
  const slug = String(fileData?.slug ?? "")
  const isUserNote = slug.startsWith("notes/") && !slug.startsWith("notes/Changes")
  const noteApiPath = slug.replace(/^notes\//, "") + ".md"
  return (
    <div
      class={`notes-editor-root ${displayClass ?? ""}`}
      data-notes-root
      data-notebook-id={String(fm.thread_id ?? "")}
      data-notebook-slug={String(fm.slug ?? "")}
      data-notebook-name={String(fm.title ?? "")}
    >
      {showLauncher ? <button class="ne-launch" data-ne-launch>✎ Write a note</button> : null}
      {isUserNote ? (
        <button class="ne-launch ne-edit" data-ne-edit data-note-path={noteApiPath} data-note-slug={slug}>
          ✎ Edit this note
        </button>
      ) : null}
    </div>
  )
}

NotesEditor.afterDOMLoaded = script

NotesEditor.css = `
.notes-editor-root { display: inline-block; }
.notes-editor-root .ne-launch { font-size: .85rem; padding: .3rem .7rem; border: 1px solid var(--secondary); background: transparent; color: var(--secondary); border-radius: 6px; cursor: pointer; margin-left: .4rem; }
.notes-editor-root .ne-launch.ne-editing { background: var(--secondary); color: var(--light); }
.ne-create-input { font-size: .85rem; padding: .28rem .5rem; margin-left: .4rem; border: 1px solid var(--lightgray); border-radius: 6px; min-width: 220px; }

/* edit-in-place toolbar over the article */
.ne-toolbar { display: flex; align-items: center; gap: .6rem; margin: 0 0 .5rem; }
.ne-toolbar .ne-launch { margin-left: 0; }
.ne-toolbar .ne-status { font-size: .78rem; color: var(--gray); }

/* the CodeMirror host — sized + typed like the article it replaces */
.ne-cm-host { margin: 0 0 1rem; }
.ne-cm-host .cm-editor { min-height: 60vh; }
.ne-cm-host .cm-scroller { font-family: var(--bodyFont); line-height: 1.6; overflow: visible; }
.ne-cm-host .cm-content { padding: 0; }

/* Live-preview rendered styles (non-caret lines) */
.ne-cm-host .ne-cm-h1 { font-size: 1.6rem; font-weight: 700; line-height: 1.3; }
.ne-cm-host .ne-cm-h2 { font-size: 1.4rem; font-weight: 700; line-height: 1.3; }
.ne-cm-host .ne-cm-h3 { font-size: 1.2rem; font-weight: 700; }
.ne-cm-host .ne-cm-h4 { font-size: 1.1rem; font-weight: 700; }
.ne-cm-host .ne-cm-h5 { font-size: 1rem; font-weight: 700; }
.ne-cm-host .ne-cm-h6 { font-size: .92rem; font-weight: 700; color: var(--gray); }
.ne-cm-host .ne-cm-strong { font-weight: 700; }
.ne-cm-host .ne-cm-em { font-style: italic; }
.ne-cm-host .ne-cm-code { font-family: var(--codeFont); background: var(--lightgray); border-radius: 4px; padding: 0 .25em; font-size: .9em; }
.ne-cm-host .ne-cm-link { color: var(--secondary); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--secondary) 40%, transparent); cursor: pointer; }
.ne-cm-host .cm-tooltip-autocomplete { font-size: .82rem; }
.ne-cm-host .cm-tooltip-autocomplete ul li[aria-selected] { background: var(--secondary); color: var(--light); }
.ne-cm-host .cm-completionDetail { color: var(--gray); font-style: normal; font-family: var(--codeFont); font-size: .9em; margin-left: .5em; }
`

export default (() => NotesEditor) satisfies QuartzComponentConstructor
