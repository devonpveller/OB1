# research-curator — Research-package ingestion inlet

The single front door for deep-research output. deep_research POSTs a "package"
(synthesis + sources + topic hint); the curator **resolves it onto the best
existing thread** (de-fragmentation) and delegates the write to openbrain-mcp's
`/research/persist`. Stops Open Brain fragmenting into one thread per run.

Full design: [`../../../documentation/implementation-guide/expand-OB1-research-inlet-service/PLAN-research-inlet-service.md`](../../../documentation/implementation-guide/expand-OB1-research-inlet-service/PLAN-research-inlet-service.md).

## Files

| File | Role |
|------|------|
| `index.ts` | the service: `GET /health`, `POST /ingest/research-package` |
| `backfill-thread-embeddings.ts` | one-time: embed existing threads (P0.2) |
| `consolidate-threads.ts` | one-time: fold the existing fragmented threads (P5) |

## Flow (`POST /ingest/research-package`)

1. embed the synthesis claim (bge-m3, 1024)
2. **Stage 1** — shortlist top-K threads by pgvector cosine (`threads.embedding`)
3. **Stage 2** — LLM decides: attach to an existing thread or create a new one
   (conservative-merge bias; an explicit `thread_id` bypasses the resolver)
4. ensure the thread exists; **delegate** the write to `/research/persist`
5. refresh the thread's `description` + `embedding` so matching improves

Auth: `x-brain-key` == `MCP_ACCESS_KEY` (health is open). Never hard-fails an
ingest — a down LLM falls back to the nearest candidate / a new thread; a down
persist returns 502 so deep_research can fall back to its own direct persist.

## Deploy (operator)

Additive migration must be applied **before** the service ships (the live volume
already exists, so the compose initdb mount only covers a fresh volume — G3).
Rehearse on a restored copy first, per the promotion-runbook discipline.

```sh
# 1. apply the schema (live DB)
docker exec -i openbrain-db psql -U postgres -d openbrain < OB1/docker/init-thread-embedding.sql

# 2. build + start the service
docker compose -f OB1/docker/docker-compose.yml up -d --build openbrain-curator

# 3. backfill thread embeddings (dry-run, then apply)
docker exec openbrain-curator deno run --allow-net --allow-env backfill-thread-embeddings.ts
docker exec openbrain-curator deno run --allow-net --allow-env backfill-thread-embeddings.ts --apply

# 4. health
curl -s http://127.0.0.1:8816/health
```

Then repoint deep_research: it already prefers the curator (valve
`curator_url`, default `http://openbrain-curator:8000`) — re-paste/redeploy the
OWUI deep_research bundle to pick up the change.

## Retroactive consolidation (operator, gated — P5)

Folds the existing fragmented threads. **Dry-run by default**; reversible
(additive links + archive, never delete). Review the dry-run, then apply, then
recompile the wiki to retire archived hubs.

```sh
docker exec openbrain-curator deno run --allow-net --allow-env consolidate-threads.ts                       # report
docker exec openbrain-curator deno run --allow-net --allow-env consolidate-threads.ts --min-confidence 0.75 # tune
docker exec openbrain-curator deno run --allow-net --allow-env consolidate-threads.ts --apply               # WRITE
```

## Env

`DB_HOST/PORT/NAME/USER/PASSWORD`, `MCP_ACCESS_KEY`, `PERSIST_URL`
(`http://openbrain-mcp:8000`), `EMBEDDING_API_BASE/KEY/MODEL`,
`CHAT_API_BASE/KEY/MODEL`, `SHORTLIST_K` (5), `NEW_THREAD_MIN_CONFIDENCE` (0.60),
`MERGE_FLOOR_DISTANCE` (0.45), `PORT` (8000).
