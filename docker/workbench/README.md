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
`WIKI_ASSETS_DIR`.
