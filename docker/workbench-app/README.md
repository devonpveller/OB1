# workbench-app

The research workbench redesign's app (item `rwr-app-scaffold`): an empty but working frame in its own
image, `openbrain-workbench-app`. Later items fill it in. Not a stack service yet.

- `src/` Vite + React 19 (pins as the old workspace; no dockview): `lib/api.ts` (the ONE fetch door, same-origin
  `/workbench/*` only, with a request log), `lib/router.ts` (path router), `lib/theme.ts` + `theme/tokens.css`
  (light/dark tokens: `prefers-color-scheme` plus an explicit `data-theme` choice).
- `serve.mjs` serves the index (`no-cache`) for every app route, hashed `/assets/*` as immutable, `/__health`,
  and forwards `/workbench/*` with the door key injected server-side.
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
