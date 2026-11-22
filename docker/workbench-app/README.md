# workbench-app

The research workbench redesign's app (item `rwr-app-scaffold`): an empty but working frame in its own
image, `openbrain-workbench-app`. Later items fill it in. Not a stack service yet.

- `src/` Vite + React 19 (pins as the old workspace; no dockview): `lib/api.ts` (the ONE fetch door, same-origin
  `/workbench/*` only, with a request log), `lib/router.ts` (path router), `lib/theme.ts` + `theme/tokens.css`
  (light/dark tokens: `prefers-color-scheme` plus an explicit `data-theme` choice).
- `serve.mjs` serves the index (`no-cache`) for every app route, hashed `/assets/*` as immutable, `/__health`,
  and forwards `/workbench/*` with the door key injected server-side. Only content-hashed files are immutable
  (the notices file under `/assets` is `no-cache`). HTML carries a Content-Security-Policy (same-origin only,
  no inline script or style, no framing). The forwarder refuses (400) any path that does not stay under
  `/workbench/` (dot-segments in any encoding, backslash, control characters, case or `%77` spellings) and
  rewrites an absolute upstream `Location` to a relative one.
- The fetch door judges the RESOLVED URL (fetch strips tab/CR/LF before resolving dot-segments): control
  characters, space, backslash and dot-segments are refused, and `requestLog()` holds the resolved path.
- **Shared module:** the forwarder and the security headers are the wiki viewer's own
  `../wiki-viewer/lib/workbench-proxy.mjs` and `security-headers.mjs`, not copies. The image takes them through
  the named build context `viewerlib`:

      docker build --build-context viewerlib=OB1/docker/wiki-viewer/lib -t openbrain-workbench-app:<tag> OB1/docker/workbench-app

  The build stage also runs the viewer's own forwarder and header tests against those files. In the repo,
  `serve.mjs` and its tests resolve them from `../wiki-viewer/lib`.
- Forwarder env names are the viewer's (`WORKBENCH_URL`, `WORKBENCH_KEY` / `WORKSPACE_DOOR_KEY`,
  `WIKI_VIEWER_ALLOWED_HOSTS` - this service's own host name must be listed - and `WIKI_VIEWER_ALLOWED_ORIGINS`).
- Build gate (fails the image): `tsc`, `vitest`, `node scripts/notices.mjs --check`, `node --test`.
  Locally: `npm ci && npm run test && npm run test:serve && npm run notices:check`.

## The shell (item `rwr-shell-nav`)

- `src/routes.ts` is the route table the left menu and the router share. A screen that is not built yet shows
  "This screen is coming in phase N" (`shell/Placeholder.tsx`). A built screen is its entry's `screen` field
  (rwr-docs-list): `App.tsx` renders `screen` when there is one, else the placeholder, so adding a screen is ONE
  change in `routes.ts` (`screen: X` on its entry, plus the import); the menu and `App.tsx` do not change. Every
  screen gets `ScreenProps`: `{ route, params, subject, whoAnswered }` (`params` = the decoded `:name` segments,
  `routeParams()`). Tests that walk the placeholders skip entries with a `screen`. `/what-moved-where` is the
  static Overview.
- `shell/`: `TopBar` (Ctrl K search box, + Start research, avatar, locked-document chip), `Rail` (menu, counts,
  Last / Locked document slot), `SearchOverlay` (empty on purpose; rwr-search fills it), `Banner` (default
  subject), and the components later screens use: `ForDocumentBar` (amber, with a way back), `TypedConfirm`,
  `Toast` (with Undo).
- `lib/shell-data.ts` reads who you are (`/workspace/whoami`, `/auth/me`) and the three menu counts (running
  sessions, intake jobs that offer a retry, cleanup sources + reopen candidates). Reads go through `lib/api.ts`
  with `cache: "no-store"`; nothing read is stored, cached or logged. The six reads are independent (each lands
  alone); the Research count is only the cards with `mine: true` (the sessions contract's server-computed owner
  flag: a global list holds other people's cards); a read that came back full shows `N+`; a different subject
  calls `resetState()`. The default-subject banner keys on the identity KIND (`/auth/me` `kind`, else
  `/workspace/whoami` `kind`), not the sign-in mode.
- `lib/state.ts` holds the locked and last document in memory (typed getters + subscribe). `rwr-ui-state-keys`
  replaces its body with the account's settings keys; the shell does not change.
- Tests: `npm test` (vitest incl. `test/contrast.test.ts`, AA for every token pair in light and dark) and the
  headless-Chromium e2e with axe in an isolated lab: `e2e/run-e2e.ps1 -Image openbrain-workbench-app:wt-<id>
  -AxeJs <axe.min.js>` (an `--internal` network, a stub workbench, no plane lease needed).

## Home (item `rwr-home`)

- `src/screens/home/`: `Home.tsx` (the ask box and six cards) and `home-data.ts` (one read per card, its own loading/failed/ok state, a Try again). `App.tsx` mounts it for `/`; nothing else of the shell changed.
- Every read goes through `lib/api.ts`: `contract/documents`, `contract/sessions?state=recent&limit=200` (own cards only: `mine`, the server's owner flag; a full page is shown as capped), `contract/podcasts` + `contract/podcasts/requests`, `contract/ideas`, `contract/library/recent` and `contract/library/waiting-claims` (the two shared-library reads added for Home; exact server totals) for the two library cards, `contract/search` for the ask box (phase 0: a search, results listed on Home; phase 4 makes it a library-wide ask).
- Nothing is stored: no storage, cookie, cache or console call (a vitest source scan holds it). Tests: `test/home.test.tsx`; `e2e/home.e2e.mjs` with `e2e/home.stub.mjs` via `e2e/run-home-e2e.ps1` (same method as `run-e2e.ps1`).

## Documents (item `rwr-docs-list`)

- `src/screens/documents/`: `Documents.tsx` (screen 2: folders with counts, + Folder, + New document, the table,
  Active / Archived / Trash, Open, Archive, Unarchive, Move to trash, Restore, Delete forever and Empty the trash
  behind the shared `shell/TypedConfirm` with the word `DELETE` and a Lost / Stays summary, the Undo toast),
  `DocumentScreen.tsx` (the `/documents/:id` frame rwr-doc-editor fills in: active and archived documents open
  read-only, archived with Unarchive; a trashed one does not open and offers Restore; someone else's or a missing
  one is the same sentence), `docs-data.ts` (every read and write, through `lib/api.ts`).
- Routes used: `contract/documents?limit=500`, `documents/folders`, `POST documents`, `documents/folders`,
  `archive`, `unarchive`, `trash`, `restore`, `delete-forever` and `empty-trash` (`confirm: true`), `state`, `file`.
  The trash's "goes by itself in N days" is 30 days (Q9) from the listing's date, which the trash move sets.
- The menu's Last / Locked document follows a document that is archived, unarchived or restored (its path
  changes); a trash move or a delete clears it, and Undo puts it back.
- Tests: `test/documents.test.tsx` and `e2e/docs.e2e.mjs` (`e2e/run-docs-e2e.ps1`), both against ONE fake documents
  back end, `e2e/docs-fake.mjs` (the server's own isolation is its lab's: `run-docs-lifecycle-tests.ps1`).
