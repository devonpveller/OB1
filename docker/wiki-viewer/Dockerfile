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
  grep -q 'searchLayout.replaceChildren()' "$S"

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
  echo 'export { default as WorkbenchProbe } from "./WorkbenchProbe"'; \
  echo 'export { default as GroundingBadge } from "./GroundingBadge"'; \
  echo 'export { default as ImportDropzone } from "./ImportDropzone"'; \
  echo 'export { default as SourceRetractor } from "./SourceRetractor"'; \
  } >> /quartz/quartz/components/index.ts

# Mount the overlay components in the content page (after Backlinks).
# grep-asserts the upstream anchor so a QUARTZ_REF bump that moves it fails
# loudly (same convention as the Explorer/Search patch above).
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'Component.Backlinks(),' "$L"; \
  sed -i 's#\(\s*\)Component.Backlinks(),#\1Component.Backlinks(),\n\1Component.WorkbenchProbe(),\n\1Component.GroundingBadge(),\n\1Component.SourceRetractor(),\n\1Component.ImportDropzone(),#' "$L"; \
  grep -q 'Component.GroundingBadge(),' "$L"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
