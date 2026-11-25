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
- Every read goes through `lib/api.ts`: `contract/documents`, `contract/sessions?state=recent&limit=200` (own cards only: `mine`, the server's owner flag; a full page is shown as capped), `contract/podcasts` + `contract/podcasts/requests`, `contract/ideas`, `contract/library/recent` and `contract/library/waiting-claims` (the two shared-library reads added for Home; exact server totals) for the two library cards, and `contract/search` for the ask box, which does not search itself: it shows the shared picker's read-only results view (`PickerResults` from `components/picker`, the same hook, query shape and hit mapping as the picker, `limit=10`). A 200 that is not the expected JSON (an expired sign-in or proxy page) is a failed search, shown as such, never "nothing matches". Known behaviour: Ask stays enabled while a search runs; a new Ask replaces the running one (its answer is dropped), but the earlier request is not aborted, so fast repeated Asks run several searches at once. Phase 0: a search, results listed on Home; phase 4 makes it a library-wide ask.
- Nothing is stored: no storage, cookie, cache or console call (a vitest source scan holds it). Tests: `test/home.test.tsx`; `e2e/home.e2e.mjs` with `e2e/home.stub.mjs` via `e2e/run-home-e2e.ps1` (same method as `run-e2e.ps1`).

## The item picker (`rwr-picker`)

`src/components/picker/` is THE picker: one searchable, filterable, single- or multi-select list for choosing
library items (kind / type / state / topic / date / quality / private filters with live counts, sort, a selected tray
that survives filtering, a private tag on every private row, keyboard use, a `scope` prop). Screens import it only from
`components/picker` (`ItemPicker`, or `PickerResults`, its read-only results view for a screen that opens hits instead of
picking them, e.g. Home's ask box; it draws the private marker itself, beside the row the screen renders); the Ctrl+K overlay is built on the same `useLibrarySearch` and `model.ts`. Only the
picker's own files may import the search exports (`SEARCH_ALLOW`).
`test/picker-single.test.ts` fails if a second picker or list-search component appears. It asks the contract search
route through `lib/api.ts` only, caches nothing and writes nothing to the browser.

- Tests: `npx vitest run` (unit + component + two-identity), and the headless-Chromium e2e with axe on an `--internal`
  network: build with `--build-arg PICKER_HARNESS=1` (adds the dev-only `/picker-harness.html`; the default image has
  none) then `test/e2e/run-picker-lab.ps1`.

## Documents (item `rwr-docs-list`)

- `src/screens/documents/`: `Documents.tsx` (screen 2: folders with counts, + Folder, + New document, the table,
  Active / Archived / Trash, Open, Archive, Unarchive, Move to trash, Restore, Delete forever and Empty the trash
  behind the shared `shell/TypedConfirm` with the word `DELETE` and a Lost / Stays summary, the Undo toast),
  `DocumentScreen.tsx` (the `/documents/d/:ref (an opaque id; the old /documents/<path> address is replaced by it with replaceState)` frame rwr-doc-editor fills in: active and archived documents open
  read-only, archived with Unarchive; a trashed one does not open and offers Restore; someone else's or a missing
  one is the same sentence), `docs-data.ts` (every read and write, through `lib/api.ts`).
- Routes used: `contract/documents?limit=500`, `documents/folders`, `POST documents`, `documents/folders`,
  `archive`, `unarchive`, `trash`, `restore`, `delete-forever` and `empty-trash` (`confirm: true`), `state`, `file`.
  The trash's "goes by itself in N days" is 30 days (Q9) from the listing's date, which the trash move sets.
- The menu's Last / Locked document follows a document that is archived, unarchived or restored (its path
  changes); a trash move or a delete clears it, and Undo puts it back.
- Tests: `test/documents.test.tsx` and `e2e/docs.e2e.mjs` (`e2e/run-docs-e2e.ps1`), both against ONE fake documents
  back end, `e2e/docs-fake.mjs` (the server's own isolation is its lab's: `run-docs-lifecycle-tests.ps1`).

## The document screen (item `rwr-doc-editor`)

`/documents/d/:ref` for an active document is the writing surface: `src/screens/document-editor/` (`DocEditor`, `InThisDoc`,
`SourceDrawer`, `editor-data`) on the CodeMirror editor in `src/editor/` (restored from the old workspace app, last tree
`99cc465^`). It edits the file's body (the front matter is kept verbatim), autosaves after a pause, makes a version on Save /
Ctrl+S / Close (the indicator `vN` counts the history, `v30+` at the route's cap), sends the file's hash with every save and
answers a 409 with a message and BOTH texts kept, opens a citation `[n]` in a side drawer (the pinned words, the pinned
revision, the cited chunk), locks / unlocks / swaps the document through the ui-state keys, queues "Research this" through
`POST /workbench/documents/research`, and shows the seven "In this doc" tabs as placeholders (`InThisDoc.tsx` `DOC_TABS`: a later
item sets one tab's `panel`). Saves are sent only for the person who opened the document (`isSamePerson`). Nothing is kept in the
browser. `src/lib/grammar.ts` is a byte-identical twin of `workbench/src/documents/grammar.ts`:
`node scripts/grammar-twin.mjs` checks it, and the lab runner `run-workspace-tests.ps1` step `[5c]` does too. The CodeMirror
`<style>` element runs under a per-response CSP nonce (`serve.mjs`). E2E: `e2e/run-editor-e2e.ps1` (subnet 10.250.103.0/24).

## Imports (item `rwr-imports`)

`src/screens/imports/` (`Imports.tsx`, `imports-data.ts`, `imports.css`): screen 14 on today's intake routes
(`/workbench/intake/jobs`, `.../jobs/:kind/:id/retry|cancel`, `.../add`), plus the contract's documents and ideas reads
for "where it lands". Listed: what / status / from / who sees it / when; "This week" counts and the four filters are
counted from the person's own jobs read. A failed item shows the server's recorded reason; Try again is offered once
(`attempts` starts at 1; the screen offers it while it is below 2, the server itself would allow more). Held adds are
shown as "Only you" (a held source is private to its refinery until admitted); the older import route lands in the shared
library. One link or file lands in a chosen document or idea (the existing add route); a file is checked up front against the intake route's own limit (25 MB, `FILE_LIMIT_BYTES`, read from the route's source by `test/imports-drift.test.ts`); the forwarder already passes `intake/add` as an upload path (rwr-intake-upload-cap), so the route's check is the real limit and the screen shows any refusal's reason.
The Connected inlets panel lists the person's own connections (kind and when) from `GET /workbench/contract/inlets/connections` (rwr-imports-server-api, slot 600) and says plainly when a read fails. A retry the server refuses (a second one, 409) shows the server's reason; the screen also never offers it.
Tests: `test/imports.test.tsx` (vitest against `e2e/imports-fake.mjs`, a fake of the real routes that the e2e stub shares),
`test/imports-drift.test.ts` (the fake against the server's source), `e2e/imports.e2e.mjs` run by `e2e/run-imports-e2e.ps1`
(lab subnet 10.250.113.0/24).
## Removals and trail (item `rwr-removals`)

- `src/screens/removals/`: `Removals.tsx` (the two tabs), `removals-data.ts` (every read and action, each to a route that already exists), `lost-stays.ts` (the "what is lost / what stays" text and the typed words). `routes.ts` gives `/removals` its `screen` (`RemovalsScreen`); nothing else of the shell changed.
- **Removed tab:** sources by stage (hidden, cut loose) with by / why / depended on it, erased sources with their marker, connections cut, trashed and archived documents, archived ideas. **Show it again** (`POST sources/:id/restore`, `documents/restore`, `documents/unarchive`, `documents/refinery/open`), **Lift the marker** (`POST contract/cleanup/tombstones/:id/lift`, only for who erased it or an admin: the screen asks `contract/tombstones/:id` `may_lift`), **Erase for good** (`POST contract/cleanup/sources/:id/erase`, typed `ERASE`, offered only when the list says `erase_allowed`), **Delete forever** (`POST documents/delete-forever`, typed `DELETE`, a trashed document only).
- **Trail tab:** read only (no button, no text input; three radio-button filters, no <select>); one destructive confirmation is open at a time, the other destructive buttons are off while it is. The put-back lines of documents (restored, unarchived) are shown; a Hidden line is derived from the source's state now, so it goes when the source is shown again. Source lines are the shared trail (`contract/trail`); document lines are the caller's own (`documents/trail`). "You" is answered from the caller's own action log (`contract/cleanup/actions`): a shared line never names a person, so anyone else reads "Someone else".
- Mapping the plan left open: "cut connections" = the trail's `severed` lines; "lift the marker" = lift the tombstone an erase leaves.
- No count of a dependence kind a person can own (document links, references, reports) is shown; the row says only that something in private work still holds the source.
- Tests: `test/removals.test.tsx`; `e2e/removals.e2e.mjs` with `e2e/removals.stub.mjs` via `e2e/run-removals-e2e.ps1` (same method as `run-e2e.ps1`). Both fakes copy the real routes' trail shapes (a lifted line has no tombstone_id column; restore clears the suppressed line and the restored line has no title; the document put-back lines are written), each with the server line cited.
