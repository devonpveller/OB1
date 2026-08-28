# Wiki viewer + workbench — architecture for future implementers

Written 2026-08-28 after a multi-week hardening arc. Read this BEFORE changing
anything in `docker/wiki-viewer/`, `docker/workbench/`, or the wiki parts of
`recipes/_shared/` — every rule below exists because its absence shipped a
user-visible bug.

## System map

```
compile pipeline (node, openbrain-wiki)      workbench (Deno, openbrain-workbench)
  writes content/* pages                        writes notes/* files (+ git)
        │                                            │
        ├────────────► /wiki vault (files = SOURCE OF TRUTH) ◄────────────┤
        │                                            │
        └── recipes/_shared/wiki-pages.mjs           └── repositories/notes.ts
              upserts wiki_pages rows                      syncNoteRow/deleteNoteRow
                        │                                        │
                        └────────► wiki_pages (Postgres) ◄───────┘
                                   DERIVED index: search / nav / graph / fallback render

viewer (openbrain-wiki-viewer, node:22 + Quartz 4.5.1 fork)
  internal builder (quartz build --serve, watcher polls the vault)
  → /quartz/public → completeness-gated snapshot → /srv/current (named volume)
  serve.mjs serves: snapshot → live build → wiki_pages DB render → fresh file
  → planned status → themed not-available. NEVER a bare 404 for a page URL.

ingress: CF/Authelia or tailnet → caddy (wiki_app block)
  /workbench/* → openbrain-workbench:8000 (X-Brain-Key injected server-side)
  everything else → openbrain-wiki-viewer:8080
```

## Invariants (violating any of these re-ships a known bug)

1. **Files are the source of truth; `wiki_pages` is derived.** Losing a row
   must never fail a file op (sync helpers are best-effort), and
   `recipes/backfill-wiki-pages.mjs` can rebuild the whole table.
2. **Every notes mutation syncs its row — through the chokepoint.** write,
   move, trash, restore, recover, empty-trash ALL call
   `syncNoteRow`/`deleteNoteRow` in `repositories/notes.ts`. The 2026-08-28
   audit found move/trash/empty skipping it: ghost rows kept "removed" notes
   in the live nav while their pages said not-found, and moved notes vanished
   from their new folder. If you add a mutation, wire the row op in the same
   function, not in the route.
3. **Note links are RESOLVED at write time.** Hand-written wikilinks say
   `[[tool-postgresql]]`; the page lives at `content/tool/tool-postgresql`.
   `resolveLinks()` resolves exact-then-suffix against wiki_pages and keeps
   unresolvable targets raw (self-healing if the page appears later). Without
   this the graph dropped every hand-written link (the "3 nodes local, 2
   fullscreen" report). Generated content pages already write full slugs.
4. **ONE editor.** The DB/fresh fallback for a note emits the SAME DOM
   contract a built note page emits (`NotesEditor.tsx`: `data-notes-root` +
   `data-wb-edit` button) with every value DERIVED from the rendered slug,
   and loads the real bundle. Identity attributes are either generated from
   the slug being rendered or absent — never inherited from other markup
   (inherited identity = editing the WRONG note = silent data loss; that's
   audit A-1's actual lesson). No bespoke second editor, ever again.
5. **Page fallbacks are `Cache-Control: no-store`.** A transient fallback
   cached by CF/browser pins itself over the real page.
6. **All inference through the LiteLLM gateway** (repo-wide rule) and all
   client → workbench calls through caddy's `/workbench/*` (key injected
   server-side; keys never appear in client JS).
7. **Graph endpoint** (`/workbench/graph?slug=&depth=&limit=`): breadth-first
   BOTH directions in Postgres (outgoing links + backlinks via the
   `idx_wiki_pages_links_gin` index), distance-ordered so the cap keeps the
   NEAREST nodes, edges only when both endpoints are present. depth ≤ 5,
   limit ≤ 800 (past ~1000 the d3 simulation stops being interactive).
   Local sidebar and fullscreen are the SAME query at different depth/limit —
   fullscreen must render a superset of local.

## Testing discipline

- **Image-build gates**: viewer runs `node --test` on `lib/` and esbuild
  compile-checks every patched inline script (a patch that writes text can
  still break compilation); workbench runs `deno test` on `src/util/`,
  `search_test.ts`, `graph_test.ts`. Pure note parsing lives in
  `src/util/notes-parse.ts` — NOT repositories/ — because repositories
  imports `@shared/*` from the `/recipes` bind-mount, which does not exist at
  build time. `extractLinks` is deliberately mirrored there and in
  `recipes/_shared/links.mjs` (two runtimes, one contract, tests on both).
- **Verification enters through the user's door.** Drive caddy
  (`http://caddy:8446` from any obnet container), not the container ports,
  and create notes via the workbench API the way the UI does (UI-created
  notes have rows and take the DB-render path; disk-written test files take
  the fresh path — validating the wrong path once shipped a "feature" real
  notes never saw). RED before the fix, GREEN after, in the deployed artifact.

## Dev workflow

- **Sidecar, not live iteration** (each viewer deploy costs a ~25-min cold
  rebuild during which built-page takeover stalls; the DB fallback keeps
  serving):
  `docker run --rm -p 127.0.0.1:8899:8080 --entrypoint node -v open-brain_openbrain-wiki-data:/wiki:ro -v open-brain_wiki-viewer-srv:/srv:ro --network open-brain_obnet openbrain-wiki-viewer:local /quartz/serve.mjs`
  (`--entrypoint node` is REQUIRED — otherwise a competing builder runs at
  400% CPU). Batch changes; deploy ONCE.
- **Patching Quartz**: overlay forks live in `quartz-overlay/`; stock-file
  changes go through grep/sha-asserted seds or anchor-asserted patch scripts
  in `patches/` (sed into TypeScript is banned after it shipped `\x01`
  bytes). Overlay files are CRLF while patch anchors are LF — patch scripts
  must match in LF-space and restore endings (build CR/LF from
  `String.fromCharCode`; every escaped form gets mangled by tooling layers).
- **Never `docker rm` by port filter** — inspect by NAME (a port filter once
  removed the production suggestion-worker).

## Known windows / accepted behaviour

- After a viewer deploy, the cold rebuild (~25 min at 41k pages) delays
  built-page takeover; pages and the note editor serve from the DB fallback
  throughout. Built FOLDER LISTINGS are static HTML and can lag reality
  between rebuilds — the live nav (Explorer) and trash strike markers are the
  fresh views.
- Trashed notes stay listed (struck through) until the nightly cleanup
  hard-removes them; `empty-trash` is the manual equivalent. Removed notes
  are recoverable from git history via the recover endpoint.
- The interaction-aware drain gate pauses backfill compiles for 15 min after
  viewer interaction; the compiler otherwise runs continuously until the
  backfill queue drains.
