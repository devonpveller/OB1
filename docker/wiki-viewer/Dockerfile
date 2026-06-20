# Read-only Quartz 4 viewer (D15) for the compiled wiki.
# Quartz is fetched at build time (build-time network is fine; the
# "no cloud" rule governs runtime model/data, not image builds — same
# as pulling node:22-alpine). Pinned for reproducibility.
FROM node:22-slim

ARG QUARTZ_REF=v4.5.1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /quartz
RUN git clone --depth 1 --branch ${QUARTZ_REF} https://github.com/jackyzha0/quartz.git . \
  && npm ci

# CodeMirror 6 for the NotesEditor Live-Preview overlay (P3.5). Bundled into the
# client by Quartz's inline-script-loader (`NotesEditor.inline.ts`). Installed
# here (own layer) so it's cached independent of overlay/source changes. No
# runtime CDN — these ship inside the image (self-hosted rule).
RUN npm install --no-audit --no-fund \
  @codemirror/state \
  @codemirror/view \
  @codemirror/language \
  @codemirror/commands \
  @codemirror/autocomplete \
  @codemirror/lang-markdown \
  @lezer/markdown \
  @lezer/highlight

# Idempotency patch (duplication fix). Vanilla Quartz's Explorer and Search
# render their content client-side on every `nav` event and APPEND without
# clearing the previous render first (explorer.inline.ts `insertBefore`,
# search.inline.ts `appendChild`). That is only safe because Quartz's SPA
# router morph-resets the server DOM between navigations; any redundant `nav`
# without a reset stacks a duplicate Explorer tree and a duplicate Search
# results panel. We clear the containers before (re)rendering so both
# components are idempotent regardless of how many times `nav` fires.
# The pre-`sed` greps assert the upstream anchors still exist, so a future
# QUARTZ_REF bump fails the build loudly instead of silently dropping the fix.
RUN set -e; \
  E=quartz/components/scripts/explorer.inline.ts; \
  S=quartz/components/scripts/search.inline.ts; \
  grep -q 'explorerUl.insertBefore(fragment, explorerUl.firstChild)' "$E"; \
  sed -i 's#^\(\s*\)explorerUl.insertBefore(fragment, explorerUl.firstChild)#\1explorerUl.querySelectorAll(":scope > li:not(.overflow-end)").forEach((el) => el.remove())\n\1explorerUl.insertBefore(fragment, explorerUl.firstChild)#' "$E"; \
  grep -q 'explorerUl.querySelectorAll(":scope > li:not(.overflow-end)")' "$E"; \
  grep -q 'if (!searchLayout) return' "$S"; \
  sed -i 's#^\(\s*\)if (!searchLayout) return$#\1if (!searchLayout) return\n\1searchLayout.replaceChildren()#' "$S"; \
  grep -q 'searchLayout.replaceChildren()' "$S"; \
  grep -q 'if (!explorerUl) continue' "$E"; \
  sed -i 's#    if (!explorerUl) continue#    if (!explorerUl) continue\n    const onExplorerWheel = (e) => { const b = explorerUl.scrollTop; const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? explorerUl.clientHeight : 1; explorerUl.scrollTop += e.deltaY * m; if (explorerUl.scrollTop !== b) e.preventDefault() }\n    explorerUl.addEventListener("wheel", onExplorerWheel, { passive: false })\n    window.addCleanup(() => explorerUl.removeEventListener("wheel", onExplorerWheel))#' "$E"; \
  grep -q 'onExplorerWheel' "$E"

# Guard the dev hot-reload so the NotesEditor (P3.5) can suppress it while a
# Live-Preview editor is open (autosave must not hard-reload the page out from
# under the editor on every keystroke). The injected `--serve` reload client
# hard-reloads on every vault change; we gate it behind `window.__neEditing`,
# which the editor sets while open and clears on Done. grep-asserted so a
# QUARTZ_REF bump that moves this line fails the build loudly.
RUN set -e; \
  P=/quartz/quartz/plugins/index.ts; \
  grep -q "() => document.location.reload(true)" "$P"; \
  sed -i "s#() => document.location.reload(true)#() => { if (!window.__neEditing) document.location.reload(true) }#" "$P"; \
  grep -q "if (!window.__neEditing) document.location.reload(true)" "$P"

# Build resilience: the compiler's orphan-sweep deletes leaf pages while a
# rebuild is mid-flight, so a Quartz parse worker can hit ENOENT on a file that
# vanished underneath it. Upstream trace() then THROWS (in a worker) or
# process.exit(1) (main thread), which deadlocks the shared esbuild service and
# kills the ENTIRE build — a ~30-min loss every time a sweep overlaps a rebuild.
# Make trace() SKIP a vanished file (warn + return) instead; a swept orphan
# SHOULD be absent from the output anyway, and every other error path is
# unchanged. grep-asserted so a QUARTZ_REF bump that moves the signature fails
# the build loudly.
RUN set -e; \
  T=/quartz/quartz/util/trace.ts; \
  grep -q 'export function trace(msg: string, err: Error) {' "$T"; \
  sed -i 's#export function trace(msg: string, err: Error) {#&\n  if ((err as any)?.code === "ENOENT") { console.warn("[skip vanished file] " + msg); return }#' "$T"; \
  grep -q 'skip vanished file' "$T"

# ── Workbench overlay (plan §2.5 / P0.4) ────────────────────────────────────
# Layer custom Quartz components over the pinned clone ADDITIVELY, so
# QUARTZ_REF stays upgradeable. New component files are copied in; the upstream
# files that must change are touched with append-only / grep-asserted edits so
# a future QUARTZ_REF bump fails the build loudly instead of silently dropping
# the wiring. Later phases (P2–P6) add their components into quartz-overlay/.
COPY quartz-overlay/quartz/ /quartz/quartz/

# Register overlay components. Append-only re-export needs NO upstream anchor —
# Quartz's `import * as Component from "./components"` picks up every named
# export, so appending here can never conflict with an upstream edit. Each
# component self-gates on frontmatter (returns null where it doesn't apply), so
# placing them all in one rail is harmless on non-matching page classes.
RUN { \
  echo ''; \
  echo '// --- openbrain workbench overlay components (additive) ---'; \
  echo 'export { default as GroundingBadge } from "./GroundingBadge"'; \
  echo 'export { default as UploadModal } from "./UploadModal"'; \
  echo 'export { default as SourceRetractor } from "./SourceRetractor"'; \
  echo 'export { default as NotesEditor } from "./NotesEditor"'; \
  echo 'export { default as NotebookPage } from "./NotebookPage"'; \
  echo 'export { default as GroundingPanel } from "./GroundingPanel"'; \
  echo 'export { default as NoteReferences } from "./NoteReferences"'; \
  echo 'export { default as PageTools } from "./PageTools"'; \
  echo 'export { default as NotebookIndex } from "./NotebookIndex"'; \
  echo 'export { default as SourceEditor } from "./SourceEditor"'; \
  echo 'export { default as SourceLinker } from "./SourceLinker"'; \
  echo 'export { default as ImportStatus } from "./ImportStatus"'; \
  echo 'export { default as RevisionHistory } from "./RevisionHistory"'; \
  } >> /quartz/quartz/components/index.ts

# Mount the overlay components in the content page (after Backlinks).
# grep-asserts the upstream anchor so a QUARTZ_REF bump that moves it fails
# loudly (same convention as the Explorer/Search patch above).
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'Component.Backlinks(),' "$L"; \
  sed -i 's#\(\s*\)Component.Backlinks(),#\1Component.Backlinks(),\n\1Component.UploadModal(),\n\1Component.NotesEditor(),#' "$L"; \
  grep -q 'Component.NotesEditor(),' "$L"

# Wide hydrated CARDS (NotebookPage on hubs, GroundingPanel on entity pages) go
# in the center column (sharedPageComponents.afterBody, full content width), NOT
# the narrow right rail. Each self-gates by frontmatter, so only one renders per
# page. GroundingPanel SUPERSEDES the old rail GroundingBadge (a consistent,
# full-width "add sources / ground this claim" UX everywhere).
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'afterBody: \[\],' "$L"; \
  sed -i 's#afterBody: \[\],#afterBody: [Component.PageTools(), Component.NotebookPage(), Component.NotebookIndex(), Component.ImportStatus(), Component.GroundingPanel(), Component.SourceEditor(), Component.SourceLinker(), Component.SourceRetractor(), Component.NoteReferences(), Component.RevisionHistory()],#' "$L"; \
  grep -q 'Component.NoteReferences(), Component.RevisionHistory()' "$L"

# Also mount NotesEditor on the LIST/FOLDER page layout (its beforeBody is a
# single-line array), so "✎ Write a note" is reachable from every folder level,
# not just the notebook hub. grep-asserted anchor.
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'Component.ContentMeta()]' "$L"; \
  sed -i 's#Component.ContentMeta()]#Component.ContentMeta(), Component.NotesEditor()]#' "$L"; \
  grep -q 'Component.ContentMeta(), Component.NotesEditor()]' "$L"

COPY serve.mjs /serve.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
