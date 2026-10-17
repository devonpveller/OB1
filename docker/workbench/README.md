# openbrain-workbench

The browser-facing read/write API behind the Quartz viewer — the backend half
of the "Quartz as Open Brain workbench" plan
([quartz-4-expansion-plan.md](../../../documentation/implementation-guide/expand-quartz-4/quartz-4-expansion-plan.md)).
Deno + Hono, internal `PORT=8000`.

## Why it exists

A static Quartz page can't write Postgres. This service is the thin write-API
the in-Quartz client components (`NotebookPage.inline.ts`, `SourceEditor`,
`ImportDropzone`, the grounding badge, …) call via same-origin `fetch`. It is
kept **off** the MCP server + cloud-gateway (8-tool contract) so the
multipart/upload/auth surface stays isolated.

## How it's reached (§2.3)

```
browser ──fetch('/workbench/…')──> portal Caddy (wiki.{$PUBLIC_DOMAIN})
   Authelia forward_auth gate ─┐
   handle /workbench/*  ───────┴─> reverse_proxy openbrain-workbench:8000
                                   + header_up X-Brain-Key {$WORKBENCH_KEY}
```

- `handle` (NOT `handle_path`) preserves the `/workbench` prefix, so routes are
  mounted prefix-inclusive (`/workbench/notebooks`, …).
- Caddy **injects** the shared secret server-side (G7) — the browser never holds
  it. `requireBrainKey` trusts the header on `app-net`; the service is never
  host-published except an optional `127.0.0.1` debug port.

## Architecture (G9)

Hono **sub-routers per resource** over a thin **service → repository** layering:

```
src/
  main.ts             app wiring + auth gate + router mounts
  config.ts           env → config (one place)
  middleware/auth.ts  X-Brain-Key gate (G7)
  db/pool.ts          deno-postgres pool + withTransaction (G8, atomic writes)
  db/rest.ts          PostgREST read client (reads only)
  types.ts            shared schema-mirrored types (P0.7)
  routes/health.ts    P0 skeleton
  routes/<resource>   added per phase (notebooks P2, notes P3, sources P4,
                      import P5, grounding P6)
```

- **Writes** (multi-row logical units: import = source + chunks + links) go
  through `withTransaction` so a mid-sequence failure can't half-write (G8).
- **Reads** may use PostgREST (`db/rest.ts`).
- Path/asset normalization (no `../` escape) lives in ONE shared validator
  (added with the notes/import routes), never per-handler.

## Networks

`obnet` (PostgREST) + `llm-net` (embeddings) + `app-net` (portal-Caddy name
resolution — required, §2.3).

## Env

`PORT`, `WORKBENCH_KEY` (= the `MCP_ACCESS_KEY` value), `DB_*`,
`OPEN_BRAIN_URL`, `EMBEDDING_*`, `EXTRACT_URL`, `WIKI_GIT_DIR`, `WIKI_OUT_DIR`,
`WIKI_ASSETS_DIR`, `CONTRACT_MOUNTS_ROOT` (default `/mounts`: where named mounts such as
`podcast-archive` live), `CONTRACT_STREAM_POLL_MS` (default `1000`).

## The retrieval contract (research-workbench P0)

`src/contracts/` is the typed retrieval contract every panel and MCP client reads the
knowledge base through. Zod 4 schemas registered as `@hono/zod-openapi` routes, so the routes
ARE the document: `GET /openapi.json` (bare path, internal) and `GET /workbench/openapi.json`
(behind the key gate) serve it; `src/contracts/generated/` holds the committed copy, the
generated TypeScript types and the MCP tool manifest. Routes live under
`/workbench/contract/*`; the eleven pre-contract routers are untouched.

- **The API owns record states.** Every record carries `state` (a key of the `record_states`
  registry) and `state_detail`. Sources carry their D5 lifecycle (`held | active | suppressed
  | unlinked | erased`); `evidence_only=true` omits everything that is not evidence.
- **Expansion by registration (D18).** Every enumerated kind is a registry row
  (`contract_registries` / `contract_registry_entries`, plus `content_types`); schemas type them
  as strings annotated `x-registry`. The conformance test fails on any `enum`, `const`,
  `anyOf`, `allOf` or `oneOf` in the document.
- **Reads only over MCP (D14).** openbrain-mcp registers every operation marked `x-mcp-tool`
  from `../../integrations/kubernetes-deployment/contract-tools.json` and calls these routes.
  Writes (suppress, sever, erase, admission, held sources, hidden set, settings) are HTTP only.
- **Storage** is `../init-research-contract.sql` (initdb slot 230; revert:
  `../revert-research-contract.sql`).
- **Notices**: `THIRD-PARTY-NOTICES.md` (D9 rule 5), checked at every image build.

```
deno task contract:gen      # regenerate openapi.json, types.ts, mcp-tools.json (+ the MCP copy)
deno task contract:check    # fail when any generated artifact is stale
deno test --allow-net --allow-env --allow-read src/     # unit + document tests (DB tests skip)
powershell -NoProfile -File contract-test/run-contract-tests.ps1   # disposable DB + Dredd
```

The integration test (`src/contracts/integration_test.ts`) runs only against the disposable
database `contract-test/run-contract-tests.ps1` creates; it suppresses, severs and erases rows.
