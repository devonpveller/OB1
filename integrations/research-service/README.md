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

## Getting the answer back

A research run routinely outlasts the request that submitted it, so the API is
submit-then-collect. Two ways to collect:

| | Poll | Callback |
|---|---|---|
| How | `GET /research/jobs/:id` until terminal | pass `callback: {chat_id, message_id}` on submit |
| Caller must | stay alive for the whole run | nothing -- fire and forget |
| Good for | scripts, agents, anything not in a chat | Open WebUI chats |

The callback POSTs the rendered report to Open WebUI's
`/api/v1/chats/:chat/messages/:msg/event` as an appending `message` event. Open
WebUI persists that write regardless of whether a browser is attached, so the
report lands in the transcript even if the tab was closed an hour earlier.

**The report is delivered by writing the chat object, not through the event API.**
Open WebUI documents `POST /chats/:id/messages/:msgId/event` for exactly this and
it does persist -- but only into the message's legacy `content` string. A 0.11
assistant message also carries `output`, an array of structured blocks
(reasoning / message / function_call), and that is what the interface renders.
No endpoint can write `output`. So an event-API delivery lands in the database,
in `chat_message`, and in the chat API response, and still shows a blank chat
before and after a reload. Synthetic test messages have no `output`, which is
why this passed smoke tests and failed the first real run. `deliverReport()`
therefore reads the chat, appends to `content` AND pushes a rendered block onto
`output`, and writes it back; `merge_history` merges per message id, so other
messages are untouched. It re-reads to confirm rather than trusting the 200.

**It then posts the content again as `chat:message:delta`.**
Open WebUI names this event differently on each side and does not alias them:
the backend persists only `message`/`replace`, while the frontend renders only
`chat:message`/`chat:message:delta`. Sending just `message` therefore produced a
report that was durable but invisible to a tab already sitting on the page --
the operator got the notification toast and an apparently unchanged chat, with
the report visible only after a reload. The delta does not persist (verified
against the live instance), so the pair cannot double-append. Drop the second
call if a future Open WebUI aliases the two names.

Two deliberate constraints:

- **The caller names the message, not the host.** `OWUI_BASE_URL`/`OWUI_API_KEY`
  are service-side env. A caller-supplied callback URL would turn every enqueue
  right into an SSRF primitive that leaks the key with it.
- **The job row is committed before the announce.** A failed announce degrades to
  "retrievable by poll"; the reverse order could show a chat a report the job then
  failed to record. `callback_armed` in the 202 response tells the client whether
  an announcement is actually coming -- if false, poll.

## Deploy notes (operator)

- 3-place change done: compose (`openbrain-research`, loopback **8818**, obnet+llm-net), recovery (`emergency-recovery.ps1` inventory), stack-map.
- **Schema**: needs `init-claims.sql` (P1) + `init-research-jobs.sql` (P4) applied to the live DB first (G10).
- **Search seam (cross-stack)**: the SearXNG gateway lives in the MAIN stack. Set `RESEARCH_SEARCH_API_BASE` to a URL reachable from obnet/llm-net (or attach this service to the gateway's network). If search is unreachable the harness degrades to honest gaps — it never fabricates.
- **Async chat callback (cross-stack)**: set `RESEARCH_OWUI_API_KEY` in
  **`OB1/docker/.env`** -- the env file this compose project actually resolves
  against (same file as `MCP_ACCESS_KEY`), NOT the main stack `.env`. Putting it
  in the main `.env` resolves to empty, which reads as `callback_armed: false`
  and silently keeps every client on the polling path. The value is an Open WebUI
  API key (Settings -> Account -> API keys). The key
  must belong to the chat's owner, or to an admin -- Open WebUI's event endpoint
  authorises on `chat.user_id == user.id or user.role == "admin"`.
  `RESEARCH_OWUI_BASE_URL` defaults to `http://openwebui:8080`, reachable because
  both containers sit on `ai-stack_default`. Leave the key empty and the service
  answers `callback_armed: false`, which makes every client fall back to polling --
  the callback is an optimisation, never a dependency.
- Build/run: `docker compose -f OB1/docker/docker-compose.yml up -d --build openbrain-research`.
