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

viewer (openbrain-wiki-viewer, node:22 + Quartz 4.5.1 fork)
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
  READINESS (P1b): serves from the moment it listens - an EMPTY /srv serves
  every page; no "Building the wiki" splash, no 503 for readiness. HEALTH:
  /__health (200 ok | 503 degraded: database not up, reconciliation drift,
  a broken page class, a render error) = the Docker/compose healthcheck.
  client bundle + static assets: /srv/current when the builder published one,
  else the copy BAKED into the image (/quartz/bundle, emitted at image build)
  internal builder (WIKI_BUILDER=1, default): quartz build --serve -> idle-gated
  snapshot /srv/current (the parity target; P1c freezes the bundle and removes
  the builder). Never a bare 404 for a page URL. Pages carry ETag W/"p-..."
  (304 on If-None-Match) and server-timing; every db page carries the
  research notifications strip (lib/notifications.mjs, read from the P0
  contract endpoint with WORKBENCH_KEY; /__notifications lists them).
  explorer: /__nav?folder= - ONE folder at a time, sorted (lib/nav-tree.mjs),
  served by the NAV WORKER (lib/nav-worker.mjs: own thread + heap, port 8082,
  so the page thread's GC never delays it); the browser reaches it as
  /workbench/nav (the workbench forwards to :8082; :8080/__nav proxies). Search
  (incl. #tag) is /workbench/search. /static/graphIndex.json is live from the
  rows, read only by the graph's offline fallback and the notes autocomplete.

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

- **CLIENT-side change? Do NOT wait for a cold rebuild.** The client bundle is
  vault-INDEPENDENT: `postscript.js` is the same file whether the vault holds
  1 page or 76,542, and since P1b every image CARRIES its own bundle
  (`/quartz/bundle`, emitted by the image's Quartz at build time from the
  synthetic fixture vault). A viewer with no published snapshot serves that
  copy; a published `/srv/current` takes precedence while the builder runs.

  So iterate by taking the bundle out of the candidate image and swapping it in:

  ```sh
  # 1. the candidate image's bundle (no build needed - it is in the image)
  docker run --rm --entrypoint sh -v bundleout:/out <image> -c 'cp /quartz/bundle/postscript.js /out/postscript.js'

  # 2. if the live viewer has a published snapshot (/srv/current exists: the
  #    builder is on), swap it in there - temp file + RENAME, never edit in
  #    place: snapshots share files by HARDLINK, so an in-place write would
  #    silently rewrite other snapshots too. With NO snapshot the live viewer
  #    serves its own image's baked bundle and the change ships with the image.
  docker run --rm -v bundleout:/out -v open-brain_wiki-viewer-srv:/srv alpine sh -c '
    test -e /srv/current || { echo "no snapshot: the image bundle serves - deploy the image"; exit 0; }
    T=$(readlink -f /srv/current)          # absolute already - do not prefix /srv
    cp /out/postscript.js "$T/postscript.js.new"
    mv "$T/postscript.js.new" "$T/postscript.js"'

  # 3. verify THROUGH CADDY, not the container port (the explorer's nav too)
  docker exec openbrain-wiki-viewer node -e 'fetch("http://caddy:8446/postscript.js").then(r=>r.text()).then(j=>console.log(j.length, /<marker>/.test(j)))'
  docker exec openbrain-wiki-viewer node -e 'fetch("http://caddy:8446/workbench/nav?folder=").then(r=>console.log(r.status, r.headers.get("x-wiki-nav")))'
  ```

  The ETag is size+mtime and the bundle is served `no-cache, must-revalidate`,
  so browsers pick it up on the next load with no purge.

  **Limits, so this is not mistaken for a deploy:** it is TEMPORARY - the next
  published snapshot overwrites it - and it only covers client assets
  (`postscript.js`, `prescript.js`, `index.css`). Changes to `serve.mjs` or
  `lib/` still need a container recreate. Use it to get behaviour in front of a
  human in seconds, then do ONE real image deploy when the behaviour is right.

  **On a real deploy** nothing waits: the new image serves every page and its
  own bundle from the first request (no splash), and is ready when
  `docker inspect --format '{{.State.Health.Status}}' openbrain-wiki-viewer`
  says `healthy` (the database answers and the reconciliation found no drift).


- **Sidecar, not live iteration**: a viewer needs no `/srv` to serve, so a
  sidecar is just the image on the live vault (read-only):
  `docker run --rm -p 127.0.0.1:8899:8080 -e WIKI_BUILDER=0 -v open-brain_openbrain-wiki-data:/wiki:ro --network open-brain_obnet openbrain-wiki-viewer:<candidate>`
  (`WIKI_BUILDER=0` = no competing 400%-CPU builder; its explorer and search
  call `/workbench/*`, which only exists behind caddy - through the sidecar's
  own port they are empty, pages are complete). Batch changes; deploy ONCE.
- **Patching Quartz**: overlay forks live in `quartz-overlay/`; stock-file
  changes go through grep/sha-asserted seds or anchor-asserted patch scripts
  in `patches/` (sed into TypeScript is banned after it shipped `\x01`
  bytes). Overlay files are CRLF while patch anchors are LF — patch scripts
  must match in LF-space and restore endings (build CR/LF from
  `String.fromCharCode`; every escaped form gets mangled by tooling layers).
- **Never `docker rm` by port filter** — inspect by NAME (a port filter once
  removed the production suggestion-worker).

## Known windows / accepted behaviour

- After a viewer deploy every page is live from its row at once, with the
  image's own bundle; the builder's cold rebuild (~25 min at 41k pages) only
  decides when /srv/current replaces it. Folder and tag listings and the
  explorer's folders are generated from the rows too (the site index is
  rebuilt in the nav refresh, off the request path, when the table's
  signature - row count + newest updated_at - changes; WIKI_NAV_TTL_MS).
- Trashed notes stay listed (struck through) until the nightly cleanup
  hard-removes them; `empty-trash` is the manual equivalent. Removed notes
  are recoverable from git history via the recover endpoint.
- The interaction-aware drain gate pauses backfill compiles for 15 min after
  viewer interaction; the compiler otherwise runs continuously until the
  backfill queue drains.
