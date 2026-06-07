# openbrain-research — the shared research harness

The Research Engine's front half (P3/P4). **One harness, many thin inlets.**
Inlets (OWUI tool, autonomous agents, Open Notebook) only submit a query, poll,
and render — all the harness logic lives here, and grounding is enforced (nothing
ungrounded is stored or reused; a premature stop degrades to honest `[GAP]`s,
never fabrication).

Full design: [`../../../documentation/implementation-guide/research-engine-for-OB/`](../../../documentation/implementation-guide/research-engine-for-OB/)
(GROUNDING-MODEL.md = governing rubric, PLAN-research-engine.md, TASKS-research-engine.md).

## What it does (per run)

1. **reuse** — recall grounded+fresh claims from the OB KB (`retrieveRelevantClaims`); OD-5 `decideReuse` keeps the ones safe to reuse as-is.
2. **plan** — decompose the question into needs; **coverage** check → which needs are gaps.
3. **stage** (gaps only, P3) — SearXNG search → **per-page** fetch+extract (NOT SmolCrawl; that's the separate whole-domain mode) → dedup vs OB (`find_or_create_source`) → into the `sessions` candidate pool. A URL already fresh in OB is reused, not re-fetched (P3.3).
4. **synthesize** — verbatim, with `[SOURCED]/[INFERRED]/[UNCERTAIN]/[GAP]` + `[Source N]` tags.
5. **enforce + curate** — cited-only sources (§6.3); delegate to **openbrain-curator** (OD-2), which stores the synthesis verbatim and writes grounded claim→source edges (P2). Honest gaps on backstop (OD-6).
6. **metric** — `claims_reused / claims_freshly_gathered / gap_ratio` per run (`research_run_metrics` view) — the compounding-reuse proof.

## Files

| File | Role |
|------|------|
| `index.ts` | config + real seams (llama-cpp, SearXNG, fetch, curator) + HTTP/job layer |
| `harness.ts` | `runResearch` — the testable orchestration (no server); injected seams |
| `kb.ts` | DB-backed claim retrieval + source staging (integration-tested) |
| `lib.ts` | pure helpers: HTML→text, OD-5 reuse decision, OD-6 backstop, citations |
| `lib.test.ts` | 9 pure-logic unit tests (`deno test --allow-net lib.test.ts`) |
| `orchestrator.test.ts` | end-to-end vs the real schema with mocked seams (`deno run --allow-net --allow-env orchestrator.test.ts`, DB on a docker network) |

## API contract (the inlet surface)

Async job + poll (OD-3). All endpoints except `/health` require `x-brain-key`.

```
POST /research
  body:  { "query": "...", "origin": "owui|agent|notebook", "thread_id"?: "<uuid>",
           "options"?: { "confidence_floor"?: 0.5 } }
  -> 202 { "job_id": "<uuid>", "status": "queued" }

GET  /research/jobs/:id
  -> { id, status: queued|running|done|error, progress:{phase,message}, result, metrics, error }
     result: { synthesis, needs[], gaps[], cited_sources[], reuse_claims[], thread_id, reuse_ratio, backstop }

GET  /research/jobs/:id/stream   -> SSE: one `data:` event per poll until terminal
GET  /health                     -> { ok, db }
```

## Inlets

- **OWUI** → [`smolcrawl/deep_research_thin_client.py`](../../../smolcrawl/deep_research_thin_client.py) (P5). Replaces the heavy in-tool harness once this service is deployed + reachable from OWUI.
- **Autonomous agent** (P6.1) → same contract:
  ```bash
  job=$(curl -s -XPOST $RESEARCH/research -H "x-brain-key: $KEY" \
        -d '{"query":"...","origin":"agent"}' | jq -r .job_id)
  curl -s $RESEARCH/research/jobs/$job -H "x-brain-key: $KEY" | jq .result.synthesis
  ```
- **Open Notebook** (P6.2) → same `/research` API, retiring ON's redundant research code. **Gated**: whether ON survives vs the Quartz workbench is an open decision (see memory `quartz-workbench-retire-on`); whichever inlet survives consumes this service rather than re-implementing it.

## Deploy notes (operator)

- 3-place change done: compose (`openbrain-research`, loopback **8818**, obnet+llm-net), recovery (`emergency-recovery.ps1` inventory), stack-map.
- **Schema**: needs `init-claims.sql` (P1) + `init-research-jobs.sql` (P4) applied to the live DB first (G10).
- **Search seam (cross-stack)**: the SearXNG gateway lives in the MAIN stack. Set `RESEARCH_SEARCH_API_BASE` to a URL reachable from obnet/llm-net (or attach this service to the gateway's network). If search is unreachable the harness degrades to honest gaps — it never fabricates.
- Build/run: `docker compose -f OB1/docker/docker-compose.yml up -d --build openbrain-research`.
