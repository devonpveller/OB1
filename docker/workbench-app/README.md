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
  "This screen is coming in phase N" (`shell/Placeholder.tsx`); a later item gives its route a real screen and
  the menu does not change. `/what-moved-where` is the static Overview.
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

## Ideas (`rwr-ideas`)

`src/screens/ideas/`: the person's own ideas by state (New, Refining, Has a document, Parked, Archived), one open: its
wording, where it came from and when, what belongs to it, how it changed (each revision, with the run started from that
wording by id), and Research this idea / Create or Open its document / Revise / Archive or Reopen. Every idea says
"private to you". Reads: `contract/ideas`, `contract/ideas/{id}`, `ideas/{id}/research`. Writes: `ideas/{id}/research-now`
(the idea's own research through the request boundary; the screen never opens Start research or posts to
`/workbench/research`), `ideas/{id}/edit`, `ideas/{id}/archive` and `/reopen` (rwr-idea-archive-api), `documents/seed`.
Discuss it and Refine it in chat are not shown until their screens exist. The screen lives under a key made of the last
known subject (a different person on the page drops everything of the first one); an idea's text is never put in the page
title, a URL, a toast or browser storage. `e2e/ideas-fake.mjs` is the one fake back end for the vitest suite and the lab
(`e2e/run-ideas-e2e.ps1`: image, stub, headless Chrome and axe on an `--internal` network).
