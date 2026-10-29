# Wiki viewer + workbench — architecture for future implementers

Written 2026-08-28 after a multi-week hardening arc. Read this BEFORE changing
anything in `docker/wiki-viewer/`, `docker/workbench/`, or the wiki parts of
`recipes/_shared/` — every rule below exists because its absence shipped a
user-visible bug.

## System map

```
compile pipeline (node, openbrain-wiki)      workbench (Deno, openbrain-workbench)
  writes content/* page FILE + its ROW          writes notes/* files (+ git) + rows
        │  (rows flushed per batch; unsynced         │
        │   rows FAIL the run - D13 item 1)          │
        ├────────────► /wiki vault (the durable copy) ◄───────────────────┤
        │                                            │
        └── recipes/_shared/wiki-pages.mjs           └── repositories/notes.ts
                        │                                        │
                        └────────► wiki_pages (Postgres) ◄───────┘
                                   WHAT IS PRESENTED: every page, nav, graph, search
              recipes/_shared/reconcile-wiki-pages.mjs: files vs rows per page_class
              (after each compile; viewer health probe; repair pass on (re)connect)

viewer (openbrain-wiki-viewer, node:22; NO Quartz in the image since P1c -
        the Quartz 4.5.1 fork survives only as the frozen bundle, see below)
  serve.mjs: every PAGE URL -> lib/live-route.mjs -> page-class registry
    -> the row rendered with the Quartz chrome          x-wiki-render: db
    -> known page, no row - or a row not presentable as-is
       (stale, future-dated, empty body, or its FILE gone - an
       orphan): pending-compile                         x-wiki-render: pending
    URLs are Quartz's slugified paths ("sp ace.md" -> /sp-ace; a dotted
    name like "pv.1.md" is a page when no published file has that path);
    the row's vault path 302s there; a row for a path Quartz does not build
    (private/, templates/, a dot-directory) is never presented
    -> database not answering: ONE screen, every URL    x-wiki-render: connecting|unreachable
    -> nothing known: themed not-available              x-wiki-render: not-available
    -> a renderer bug outside an isolated entry         x-wiki-render: error (500)
  READINESS (P1b, P1c): serves from the moment it listens; nothing in the
  container builds anything (no builder, no snapshot loop, no nightly rebuild,
  no /srv volume). The site index is warmed at start, not by the first reader.
  HEALTH: /__health (200 ok | 503 degraded: site index warming, database not
  up, reconciliation drift, a broken page class, a render error) = the
  Docker/compose healthcheck.
  client bundle + static assets: the FROZEN bundle (D7, P1c) - bundle/ in this
  directory (index.css, prescript.js, postscript.js, static/), committed byte
  for byte (.gitattributes -text) with its sha256 in bundle.sha256, copied to
  /viewer/bundle (the image build checks the manifest). lib/chrome-static.mjs
  is frozen the same way. A file the bundle lacks is a vault attachment, read
  from /wiki itself (assets/<id>/<name>, slug-indexed; never a .md, never
  private/, templates/ or a dot path). Never a bare 404 for a page URL. Pages carry ETag W/"p-..."
  (304 on If-None-Match) and server-timing. No page carries a
  notifications strip any more: the workspace's title bar bell replaced it
  (research-workbench P2b, D13).
  workspace: /workspace - the Vite + React 19 panel workspace (source in
  workspace/, built in the Dockerfile's `workspace` stage from its
  package-lock.json, served from /viewer/workspace - only that build, never
  the vault; see workspace/README.md).
  /workbench/*: forwarded to the workbench with WORKBENCH_KEY injected
  server-side (lib/workbench-proxy.mjs); only for an allow-listed Host
  (WIKI_VIEWER_ALLOWED_HOSTS; 421 otherwise), and a write only from the
  viewer's own origin or an allow-listed edge origin
  (WIKI_VIEWER_ALLOWED_ORIGINS; 403 otherwise) - CSRF and DNS-rebinding guard.
  explorer: /__nav?folder= - ONE folder at a time, sorted (lib/nav-tree.mjs),
  served by the NAV WORKER (lib/nav-worker.mjs: own thread + heap, port 8082,
  so the page thread's GC never delays it); the browser reaches it as
  /workbench/nav (the workbench forwards to :8082; :8080/__nav proxies). Search
  (incl. #tag) is /workbench/search. /static/graphIndex.json is live from the
  rows (streamed in slices), read only by the notes editor's autocomplete when
  the editor opens; the graph never falls back to it (a page without a graph
  answer - a folder or tag page - draws itself alone).

ingress: CF/Authelia or tailnet → caddy (wiki_app block)
  /workbench/* → openbrain-workbench:8000 (X-Brain-Key injected server-side)
  everything else → openbrain-wiki-viewer:8080
```

## Invariants (violating any of these re-ships a known bug)

1. **Compile owns both; the row is what is presented; the file is the
   durable copy** (research-workbench D13, settled 2026-09-25; rewritten from
   "files are the source of truth, rows derived"). Ingest -> compile ->
   present: a page is offered only once its row landed. A compile whose rows
   do not land FAILS (non-zero exit, the unsynced count and first slugs in the
   log) - never "compile ok" with unsynced rows. No row = the typed
   `pending-compile` state, never an empty leaf and never a render of the
   file. **Stale is a miss** (D13 item 5): a row older than its file, a row
   dated in the future (its time cannot show a newer file replaced it) or a
   row with an empty body (folder/tag indexes excepted) is pending too - the
   same `rowState()` + `isEmptyBody()` rules the reconciliation applies. A row
   whose body is empty while its FILE is empty too (a note that is frontmatter
   only) is a faithfully empty page and is presented as Quartz presents it (an
   empty article), not pending and not drift. A transcluded page (`![[page]]`)
   is its row too; a known page without a presentable row is the
   pending-compile marker inside the transclude block. Drift (file without
   row, stale / future / empty row, row without file, an open structural
   compile failure) is measured per page_class by
   `recipes/_shared/reconcile-wiki-pages.mjs` and repaired on (re)connect,
   never on read. A structural compile failure is not retried until its
   inputs change (`recipes/_shared/structural-ledger.mjs`; manual clear:
   `generate-wiki.mjs --clear-structural <ids|all>` - an id that is not open
   exits 1). Every ledger change is one locked read-modify-write (a lockfile
   beside it), so racing compiles lose nothing and a clear is never written
   back.
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
4. **ONE editor.** The live page for a note (and for a source) emits the SAME
   DOM contract a built page emits (`NotesEditor.tsx`: `data-notes-root` +
   `data-wb-edit` button; `SourceEditor.tsx`: `data-source-editor`) with every
   value DERIVED from the slug / row being rendered, and loads the real
   bundle (`lib/components.mjs`). Identity attributes are either generated from
   the slug being rendered or absent — never inherited from other markup
   (inherited identity = editing the WRONG note = silent data loss; that's
   audit A-1's actual lesson). No bespoke second editor, ever again.
5. **State pages are `Cache-Control: no-store`** (pending-compile, the
   database screen, not-available). A transient state cached by CF/browser
   pins itself over the real page.
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

8. **Page classes are a REGISTRY** (research-workbench expansion by
   registration). The renderer never names a class: `lib/page-classes/*.mjs`
   entries (one renderer template each) resolve a request in priority order;
   their compile halves are `recipes/_shared/page-classes.mjs` (one compile
   rule each, the `page_class` the row carries). Adding a class = one entry on
   each side; no existing entry changes (`live-render.test.mjs` proves it).
   Names AND priorities are unique: an entry file that reuses a name, ties a
   priority, has no default export or an invalid shape FAILS the load and
   the container exits (a duplicate never silently replaces a built-in). An
   entry whose `resolve()`/`template()` throws is isolated: logged, counted,
   named by `/__health`, and resolution falls through to the next entry.
9. **The database being unreachable is a front-end condition, not a page
   state**: one screen (`connecting to database` / `database unreachable`)
   for every URL and a degraded `/__health`, never a pending page, never a
   file render.
10. **Raw HTML in a body is dropped** (`lib/render-page.mjs`): only the HTML
   the transform set itself generates (escaped) reaches the page. The Quartz
   builder renders raw HTML; the live renderer never does. **No
   `javascript:`/`vbscript:`/`data:` URL** survives into an article attribute
   (a link becomes its text, an image its alt; a `data:image/<raster>` src
   is allowed), and mermaid runs with `securityLevel: "strict"` (Dockerfile).

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
  notes have rows; a disk-written test file with no row is `pending` - there
  is no file-render path any more). RED before the fix, GREEN after, in the
  deployed artifact.
- **The disposable P1a environment** (`test/p1a-env.sh`): a private network,
  a fresh Postgres seeded only with the committed synthetic fixtures
  (`test/fixtures/`), the real Caddyfile + PostgREST, a stub LLM
  (`test/stub-llm.mjs`), and the `:wt-<id>` image; `test/parity-diff.mjs`
  diffs every rendered body against the built page for the fixed URL list;
  `test/run-acceptance.sh` runs every case (names, subnet and port are
  parameters: `P1A_PREFIX`, `P1A_TAG`, `P1A_SUBNET`, `P1A_PORT`).
- **P1b adds** (`test/p1b-env.sh`, `test/run-p1b.sh`): a contract database
  built from the REAL initdb chain (docker-compose.yml order), the workbench
  on it, the portal Caddyfile's own `(wiki_app)` snippet as the front door,
  headless Chromium for the perf floor (`test/perf-nav.mjs`: explorer per
  navigation, nav TTFB, nav payload; unthrottled, DevTools "Slow 4G" + 4x CPU,
  mobile), synthetic vaults shaped like the live table (`p1b-env.sh
  perfseed <rows>`), and `test/p1b-checks.mjs` (the URL list on an empty
  /srv, listing counts vs SQL, the 200-URL crawl, the nav order vs SQL).

## Dev workflow

- **CLIENT-side change? The bundle is FROZEN (P1c, D7).** `bundle/` and
  `lib/chrome-static.mjs` are committed files; the viewer image copies them and
  builds nothing. They were emitted ONCE by Quartz v4.5.1 + `quartz-overlay/`
  with an offline freeze tool, which rw-p1c-retire2 deleted (operator
  2026-10-28; it lives in git history at OB1 5dfa57b). There is NO re-emit
  path: a change before P8b retires the overlay means editing the files in
  `bundle/` (and `lib/chrome-static.mjs`) by hand, keeping `quartz-overlay/`
  in step as the record of the source, and updating their lines in
  `bundle.sha256` (`sha256sum`; the image build fails on a mismatch):

  ```sh
  # 1. edit bundle/<file> by hand, then refresh its manifest line
  (cd OB1/docker/wiki-viewer && sha256sum bundle/postscript.js)   # replace that line in bundle.sha256

  # 2. build the viewer image and run it in a DRILL environment
  #    (test/p1a-env.sh), never the live container; a drill may bind-mount
  #    a candidate file over /viewer/bundle/postscript.js.

  # 3. verify THROUGH CADDY, not the container port (the explorer's nav too)
  docker exec openbrain-wiki-viewer node -e 'fetch("http://caddy:8446/postscript.js").then(r=>r.text()).then(j=>console.log(j.length, /<marker>/.test(j)))'
  docker exec openbrain-wiki-viewer node -e 'fetch("http://caddy:8446/workbench/nav?folder=").then(r=>console.log(r.status, r.headers.get("x-wiki-nav")))'
  ```

  The ETag is size+mtime and the bundle is served `no-cache, must-revalidate`,
  so browsers pick it up on the next load with no purge.

  **On a real deploy** nothing waits: the new image serves every page and its
  frozen bundle from the first request (no splash), and is ready when
  `docker inspect --format '{{.State.Health.Status}}' openbrain-wiki-viewer`
  says `healthy` (site index warm, the database answers, the reconciliation
  found no drift).


- **Sidecar, not live iteration**: the viewer is the image on a vault
  (read-only) and a database; there is nothing to switch off (P1c: no builder).
  Its explorer and search call `/workbench/*`, which only exists behind caddy.
  Batch changes; deploy ONCE.
- **Quartz sources**: the overlay forks the frozen bundle was built from live
  in `quartz-overlay/` (a record only - nothing builds them since
  rw-p1c-retire2). The parity diff's "built" side is the COMMITTED reference
  `test/fixtures/parity-reference.tar.gz` (the env's vault as Quartz built it,
  html only; `test/p1a-env.sh ref` loads it) and the slug check compares the
  shared rule against the committed `test/fixtures/quartz-slug-table.json`
  (`test/slug-table-check.mjs`); both were emitted once, before the freeze
  tool was deleted, so a new fixture-vault page needs its built page and its
  table row added by hand.
- **Never `docker rm` by port filter** — inspect by NAME (a port filter once
  removed the production suggestion-worker).

## Known windows / accepted behaviour

- After a viewer deploy every page is live from its row at once, with the
  frozen bundle; there is no rebuild of anything (P1c). Folder and tag listings and the explorer's folders are generated
  from the rows and follow a write within WIKI_NAV_TTL_MS (default 30 s) with
  no reader waiting (fix round 1): a background tick every TTL/4 checks the
  table signature (row count + newest updated_at) and applies the rows written
  since the snapshot in place (a new page in an existing folder, a title, tags,
  links); a deletion, a new folder or an alias change takes the full rebuild,
  off the request path, while the tick keeps applying deltas. Backlinks TO a
  new page follow that rebuild.
- Trashed notes stay listed (struck through) until the nightly cleanup
  hard-removes them; `empty-trash` is the manual equivalent. Removed notes
  are recoverable from git history via the recover endpoint.
- Compile pacing is purely performance-based (P1c, operator 2026-09-25): the
  compiler runs on boot, on the change-watch and on demand, the backfill drain
  never pauses for a reader (the 15-min viewer-idle gate is gone), there is no
  daily recompile, and the wiki's LLM calls carry its own caller key, which
  llm-queue ranks below interactive callers.
