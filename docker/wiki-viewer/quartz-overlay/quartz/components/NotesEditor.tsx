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
  const slug = String(fileData?.slug ?? "")
  // Quartz folder/list pages have a slug ending in "/index" (or the bare home
  // "index"); leaf pages never do. That cleanly separates a folder listing from
  // an actual note file at the same path.
  const isFolderPage = slug === "index" || slug.endsWith("/index")
  const folder = slug.replace(/\/index$/, "")
  const fParts = folder.split("/")

  // A user note is ANY leaf page from the author-owned notes/ layer
  // (notes/notebooks/<nb>/x.md AND a flat notes/x.md), excluding folder pages
  // and the machine-written Changes log. The slug IS the vault path; the API
  // path is relative to notes/, so strip the leading "notes/".
  const isUserNote = !isFolderPage && slug.startsWith("notes/") && !slug.startsWith("notes/Changes")
  const noteApiPath = slug.replace(/^notes\//, "") + ".md"

  // "Write a note" is offered ONLY in the author-owned `notes/` tree — never
  // under `content/` (the knowledge wiki), where hand-authoring would bypass the
  // intentional generation design. A notebook folder (notes/notebooks/<nb>/)
  // targets that notebook; notes/ root makes a flat note.
  let canCreate = false
  let createNbSlug = ""
  let createNbName = ""
  if (isFolderPage && (folder === "notes" || folder.startsWith("notes/"))) {
    canCreate = true
    if (fParts[1] === "notebooks" && fParts[2]) {
      createNbSlug = fParts[2]
      createNbName = fParts[2]
    }
  }

  return (
    <div
      class={`notes-editor-root ${displayClass ?? ""}`}
      data-notes-root
      data-notebook-id={String(fm.thread_id ?? "")}
      data-notebook-slug={createNbSlug}
      data-notebook-name={createNbName}
      data-folder-rel={folder.replace(/^notes\/?/, "")}
    >
      {canCreate ? <button class="ne-launch" data-ne-launch>✎ Write a note</button> : null}
      {canCreate ? <button class="ne-launch" data-nf-launch>📁 New folder</button> : null}
      {canCreate && folder !== "notes" && folder !== "notes/notebooks" ? (
        <button class="ne-launch ne-danger" data-nf-delete>🗑 Delete folder</button>
      ) : null}
      {isUserNote ? (
        <button class="ne-launch ne-edit" data-wb-edit data-edit-kind="note" data-note-path={noteApiPath} data-note-slug={slug}>
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
.nf-create-input { font-size: .85rem; padding: .28rem .5rem; margin-left: .4rem; border: 1px solid var(--lightgray); border-radius: 6px; min-width: 200px; }
.ne-move-picker { display: inline-flex; align-items: center; gap: .4rem; margin-left: .2rem; }
.ne-move-picker .ne-move-select { font-size: .82rem; padding: .25rem .4rem; border: 1px solid var(--lightgray); border-radius: 6px; background: var(--light); color: var(--dark); max-width: 260px; }
.notes-editor-root .ne-launch.ne-danger, .ne-toolbar .ne-launch.ne-danger { border-color: color-mix(in srgb, #c0392b 55%, var(--lightgray)); color: #c0392b; }
.notes-editor-root .ne-launch.ne-danger:hover, .ne-toolbar .ne-launch.ne-danger:hover { background: #c0392b; color: var(--light); border-color: #c0392b; }

/* edit-in-place toolbar over the article */
.ne-toolbar { display: flex; align-items: center; gap: .6rem; margin: 0 0 .5rem; }
.ne-toolbar .ne-launch { margin-left: 0; }
.ne-toolbar .ne-status { font-size: .78rem; color: var(--gray); }
.ne-toolbar .ne-export { display: inline-flex; align-items: center; gap: .25rem; color: var(--gray); font-size: .8rem; }
.ne-toolbar .ne-export-btn { font-size: .72rem; padding: .2rem .45rem; border: 1px solid var(--lightgray); background: transparent; color: var(--secondary); border-radius: 5px; cursor: pointer; }
.ne-toolbar .ne-export-btn:hover { background: var(--lightgray); }

/* editable frontmatter properties panel */
.ne-props { margin: 0 0 .6rem; border: 1px solid var(--lightgray); border-radius: 7px; }
.ne-props-toggle { width: 100%; text-align: left; background: var(--lightgray); border: 0; padding: .35rem .6rem; font-size: .75rem; color: var(--gray); cursor: pointer; border-radius: 7px; text-transform: uppercase; letter-spacing: .04em; }
.ne-props-body { padding: .5rem .6rem; display: flex; flex-direction: column; gap: .35rem; }
.ne-props-body[hidden] { display: none; }
.ne-prop-row { display: flex; gap: .4rem; align-items: center; }
.ne-prop-key { flex: 0 0 28%; padding: .25rem .4rem; font-family: var(--codeFont); font-size: .8rem; border: 1px solid var(--lightgray); border-radius: 5px; background: var(--light); color: var(--dark); }
.ne-prop-val { flex: 1; padding: .25rem .4rem; font-size: .82rem; border: 1px solid var(--lightgray); border-radius: 5px; background: var(--light); color: var(--dark); }
.ne-prop-rm { border: 0; background: transparent; color: var(--gray); font-size: 1.1rem; line-height: 1; cursor: pointer; padding: 0 .25rem; }
.ne-prop-rm:hover { color: #c0392b; }
.ne-prop-add { align-self: flex-start; border: 1px dashed var(--lightgray); background: transparent; color: var(--secondary); font-size: .75rem; padding: .2rem .5rem; border-radius: 5px; cursor: pointer; }

/* link hover popover (in-editor) */
.ne-cm-popover { position: fixed; z-index: 1002; max-width: 420px; max-height: 420px; overflow: auto; background: var(--light); color: var(--dark); border: 1px solid var(--lightgray); border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
.ne-cm-popover-inner { padding: .6rem .9rem; font-size: .82rem; }
.ne-cm-popover-inner h1, .ne-cm-popover-inner h2 { font-size: 1rem; margin: .3rem 0; }
.ne-cm-popover-inner :is(h3,h4,h5,h6) { font-size: .9rem; margin: .25rem 0; }
.ne-cm-popover-inner img { max-width: 100%; height: auto; }

/* the CodeMirror host — sized + typed like the article it replaces */
.ne-cm-host { margin: 0 0 1rem; position: relative; }
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
.ne-cm-host .ne-cm-strike { text-decoration: line-through; }
/* inline frontmatter ("properties") region */
.ne-cm-host .ne-cm-fm { font-family: var(--codeFont); font-size: .8rem; color: var(--gray); background: color-mix(in srgb, var(--lightgray) 45%, transparent); }
.ne-cm-host .ne-cm-fm-fence { font-family: var(--codeFont); font-size: .7rem; color: var(--lightgray); background: color-mix(in srgb, var(--lightgray) 45%, transparent); }
.ne-cm-host .ne-cm-fm-key { color: var(--secondary); font-weight: 600; }
.ne-cm-host .ne-cm-link { color: var(--secondary); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--secondary) 40%, transparent); cursor: pointer; }
.ne-cm-host .cm-tooltip-autocomplete { font-size: .82rem; }
.ne-cm-host .cm-tooltip-autocomplete ul li[aria-selected] { background: var(--secondary); color: var(--light); }
.ne-cm-host .cm-completionDetail { color: var(--gray); font-style: normal; font-family: var(--codeFont); font-size: .9em; margin-left: .5em; }

/* cursor-following collapsible formatting toolbar */
.ne-cm-host .ne-tb { position: absolute; z-index: 6; display: inline-flex; align-items: center; gap: 1px; padding: 2px; background: var(--light); border: 1px solid var(--lightgray); border-radius: 7px; box-shadow: 0 3px 12px rgba(0,0,0,.18); }
.ne-cm-host .ne-tb-toggle, .ne-cm-host .ne-tb-btn { font-family: var(--bodyFont); font-size: .8rem; line-height: 1; min-width: 1.7em; height: 1.7em; padding: 0 .35em; border: 0; background: transparent; color: var(--darkgray); border-radius: 5px; cursor: pointer; }
.ne-cm-host .ne-tb-toggle { color: var(--gray); }
.ne-cm-host .ne-tb-btn:hover, .ne-cm-host .ne-tb-toggle:hover { background: var(--lightgray); color: var(--dark); }
.ne-cm-host .ne-tb-btn:nth-child(2) { font-weight: 700; }
.ne-cm-host .ne-tb-btn:nth-child(3) { font-style: italic; }
.ne-cm-host .ne-tb-btn:nth-child(4) { text-decoration: line-through; }
`

export default (() => NotesEditor) satisfies QuartzComponentConstructor
