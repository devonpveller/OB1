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
3. **admit** (research-workbench P3a, D15) — every search hit is scored BEFORE fetch on what resolves about it (`admission.ts`: its family - `scholarly` when a DOI/PMID/PMCID/arXiv id resolves via `scholarly.ts`, else `general` - and that family's signals, × the weight row for the run's claim kind, `credibility.ts`). Below the kind's admission floor it is a **lead**: fetched only to read its links, never staged; a link that clears the floor is admitted and, if a line citing it is later `supports`, carries `found_via`. Every judged hit is on the admission trail (`research_admission_trail`).
3b. **stage** (gaps only, P3) — SearXNG search → **per-page** fetch+extract (NOT SmolCrawl; that's the separate whole-domain mode) → dedup vs OB (`find_or_create_source`) → into the `sessions` candidate pool. A URL already fresh in OB is reused, not re-fetched (P3.3).
4. **synthesize** — verbatim, with `[SOURCED]/[INFERRED]/[UNCERTAIN]/[GAP]` + `[Source N]` tags.
4b. **entail** (P3a, D10) — every cited line is judged against the text of the sources it cites (`entailment.ts`): one verdict per line, `supports | partial | unsupported` (the `entailment_verdicts` registry); `partial` lowers the tag to `[UNCERTAIN]`, `unsupported` makes the line a `[GAP]` (fail-closed: no verdict = `unsupported`). The footer prints how many lines were demoted and the report credibility roll-up. Replaces the Skeptic (archived, `archive/skeptic/`).
5. **enforce + curate** — cited-only sources (§6.3); delegate to **openbrain-curator** (OD-2), which stores the synthesis verbatim and writes grounded claim→source edges (P2). Honest gaps on backstop (OD-6).
6. **metric** — `claims_reused / claims_freshly_gathered / gap_ratio` per run (`research_run_metrics` view) — the compounding-reuse proof; since P3a also `entailment` (lines, demoted, per verdict), `credibility` (the report roll-up with the model version) and `admission` (judged / admitted / leads / lead paths / held folded) in `research_jobs.metrics`.
7. **credibility records** (P3a) — after the curator files the sources: `sources.metadata.credibility` (family, signals, score, rolling total, reasons, model version) and `.scholarly`, a `source_credibility_history` row, the entailment-gated `source_corroborations`, the trail. On a refinery job (`research_jobs.refinery_id`) the **fold** runs: a held source that clears its floor AND is `supports`-cited moves into `sources` with its uuid; otherwise it stays held (refinery-only, kept out of the curator's copy); a tombstoned one goes through the workbench's D5 admission gate.
8. **the re-score gate** — `claim_confidence_d15` (SQL twin of the model) and the `credibility_before_after` view exist, but the claim trigger keeps the old model until `rescore-gate.ts` finds the operator's confirmation of the current view digest in the findings sink and the DB records it (`credibility_apply_d15_trigger`, refuses otherwise).

## Files

| File | Role |
|------|------|
| `index.ts` | config + real seams (llama-cpp, SearXNG, fetch, curator) + HTTP/job layer |
| `harness.ts` | `runResearch` — the testable orchestration (no server); injected seams |
| `llm.ts` | the chat seam: overload vs upstream-DOWN retry budgets, the process-wide model-down latch, the probe (`llm.test.ts`) |
| `jobs.ts` | job queue: caller deadlines, cancel, model-down pause, the Dispatcher (`jobs.test.ts`; real SQL in `failfast.e2e.test.ts`) |
| `kb.ts` | DB-backed claim retrieval + source staging (integration-tested) |
| `lib.ts` | pure helpers: HTML→text, OD-5 reuse decision, OD-6 backstop, citations |
| `contract.ts` | the per-job contract (`options.contract`): source classes (`advisories`, `academic`, `vendor-psirt`, `software-docs`), allow/deny entries as `host`, `*.suffix` or `host/path/prefix`, budget, red lines; `harness.ts` `withContract` + `runResearch` enforce it on search hits, fetches (final url after redirects), seeds (deny), KB recall and reused claims, recording every drop in `result.contract_drops` (`contract.test.ts`, `harness-contract.test.ts`) |
| `urlnorm.ts` | the one URL normaliser for source-trust checks (ported from agent-bridge; parity corpus `fixtures/url-normalise-corpus.json`, `urlnorm.test.ts`) |
| `credibility.ts` | the D15 model: families, weight table by claim kind × family (fails loud), paper score, corroboration, the filed-claim and report credibility - built from the registries (`credibility.test.ts`) |
| `claim-list.ts`, `claim-edges.ts` | byte-identical copies of the research curator's: the claim list the curator files from a package and its tag -> edge rule. The report scores exactly the claims of the package it hands the curator (`harness.ts` `scoreCuratorPackage`); the figure is over those filed claims only, and `metrics.credibility.judged_not_filed` counts the judged lines that file none (`claim-list.test.ts`, `claim-edges.test.ts` holds the identity, `credibility-attempt6.e2e.test.ts`) |
| `admission.ts` | the pre-ingestion stage of the admission chokepoint: assess a hit, leads, final scores (`admission.test.ts`) |
| `scholarly.ts` | identifiers + the keyed OpenAlex / Crossref-fallback resolver, only through the egress proxy (`scholarly.test.ts`) |
| `entailment.ts` | the per-claim entailment stage (D10), fixture layer `fixtures/entailment/` (`entailment.test.ts`) |
| `rescore-gate.ts` | operator tool: re-score the store only on a confirmation recorded in the findings sink (`rescore-gate.test.ts`) |
| `record-entailment.ts` | operator/tester tool: re-record the entailment fixture layer from the real judge via LiteLLM |
| `run-credibility-e2e.ps1` | the disposable run: image build with its test gate (and a negative control), the SQL twin + gate + fold on a throwaway DB, the workbench quality(id) |
| `lib.test.ts` | 9 pure-logic unit tests (`deno test --allow-net lib.test.ts`) |
| `orchestrator.test.ts` | end-to-end vs the real schema with mocked seams (`deno run --allow-net --allow-env orchestrator.test.ts`, DB on a docker network) |

## API contract (the inlet surface)

Async job + poll (OD-3). All endpoints except `/health` require `x-brain-key`.

```
POST /research
  body:  { "query": "...", "origin": "owui|agent|notebook", "thread_id"?: "<uuid>",
           "deadline_at"?: "<ISO-8601 date-time WITH a zone, e.g. 2026-10-13T12:00:00Z>",
           "options"?: { "confidence_floor"?: 0.5 } }
  -> 202 { "job_id": "<uuid>", "status": "queued", "deadline_at"?: "<ISO>" }
  -> 400 on any other deadline_at (numbers, zone-less times and bare dates are refused)

GET  /research/jobs/:id
  -> { id, status: queued|running|done|error|cancelled, progress:{phase,message,code?}, result, metrics, error,
       model: { state: up|down, since, reason: <fixed code>|null, last_check } }
     result: { synthesis, needs[], gaps[], cited_sources[], reuse_claims[], thread_id, reuse_ratio, backstop }

POST /research/jobs/:id/cancel   body? { "reason": "..." }
  -> 200 { status: "cancelled" }   (was queued: it will never run)
  -> 202 { status: "cancelling" }  (was running: aborted at once, ends `cancelled`)
  -> 409 { status: "running", filing: true }  (the curator is already filing it: the job
         ends with its REAL outcome - done, or the curator's error - never "cancelled")
  -> 200 { status: <terminal>, note: "already terminal" } | 404

GET  /research/jobs/:id/stream   -> SSE: one `data:` event per poll until terminal
GET  /health                     -> { ok, db, model }   (`ok` is DB-only)
```

### Deadlines, cancel, and the model-down signal (2026-10-13)

- **Caller deadline.** A job still `queued` past `deadline_at` is never started: it
  ends `cancelled`, `progress.code = "deadline"`. A job still `running` at it is
  aborted (in-flight model request included) and ends the same way - unless filing to
  the curator has started: that is the point of no return, and the job records what
  really happened.
- **Upstream down is not backpressure.** A 500/502/503 whose body says the model
  cannot be reached - matched against bodies captured through the real llm-queue +
  LiteLLM chain (`fixtures/gateway-bodies.ts`: name resolution, "All connection attempts
  failed", LiteLLM's "Connection error." when llm-queue is gone) - or an unreachable
  gateway, gets `CHAT_DOWN_BUDGET_MS` (3 min), not the 25-minute `CHAT_RETRY_BUDGET_MS`
  that 429s and ambiguous 502s (reset / timeout: "llm-queue: .") keep. The fail-open
  screens (`detectInjection`, `isRelevant`) get no shortcut: they fail open only once
  the model is LATCHED down (and the job is then paused, never filed). Every attempt
  is bounded by `CHAT_FETCH_TIMEOUT_MS` (45 min).
- **Model down = PAUSE.** After that budget a process-wide latch is set: every later
  call fails at once, the job is requeued (`status: "queued"`,
  `progress.code = "model_down"`), and nothing is claimed while it holds. One probe
  (`RESEARCH_MODEL_PROBE_MS`, 60 s; bounded by `RESEARCH_MODEL_PROBE_TIMEOUT_MS`)
  re-checks the model; on success the queue resumes FIFO at the normal concurrency.
  A job paused more than `RESEARCH_MAX_MODEL_DOWN_REQUEUES` (6) times ends `error`,
  `error` starting `model_down:`. A paused job whose deadline passes ends `cancelled`
  with `progress.model_down = true`. A job is never filed from a run the model went
  down under.
- **How a caller reads it:** `isModelDown(job)` in
  `recipes/daily-digest/src/enrich/research-client.ts` (any of: `progress.code ===
  "model_down"`, `progress.model_down === true`, `model.state === "down"`, `error`
  starting `model_down:`). `model.reason` is a fixed code (`upstream_unresolvable`,
  `upstream_refused`, `queue_unreachable`, `gateway_unreachable`,
  `model_unreachable`), never gateway text.

### Job trees (research-workbench P4a)

- `POST /research/jobs/:id/steer` `{step_id, text, contract?, context_snapshot?}` -> 201: a child job
  rooted at the named stage step (`s1`, `s2`, ... from the job's stage events), queued in the
  research-branch lane while the parent keeps running (its status is untouched). The child's anchor
  is the parent's `query`; its contract is the parent's narrowed by the request (a widening is 400).
  The steer record keeps the tree's topic estimate and the anchor it was made against.
- `GET /research/jobs/:id/tree` -> branches, steers, the cumulative report (headed by the topic
  estimate, the prompt shown as origin) and one `exploratory` learning record per branch.
- `GET /research/jobs/:id/events?after=<id>` -> the tree's typed events: `stage` (kind
  `steering|due_process`, step id), `source` (with its admission `trail`), `gap` (D15: a recalled
  claim below its kind's threshold), `interhub_gap` (D1: a thin link between claim-graph
  neighbourhoods), `human_steer`, `branch_open|close`, `topic`.
- Order of claims: a human steer's branch, then main lines, then gap work (D3). Concurrency is
  llm-queue's research-branch lane read back from `/observe/queue/estimate` (no
  `RESEARCH_MAX_CONCURRENCY`). Branch jobs use `RESEARCH_BRANCH_LLM_KEY` (operator-provisioned
  LiteLLM virtual key, `metadata.lane=research-branch`). Lab test: `run-trees-e2e.ps1`.
- Who may steer or cancel (rw-identity round 5; P4b, operator 2026-10-30): a user's job its owner
  only; a job a service started (owner `service:<caller>`, e.g. agent-org) its service AND an admin;
  a job with no recorded owner `WORKSPACE_DEFAULT_SUB`. Anyone else: 404. Only the workspace's own key
  may say who acted (`x-actor-sub`) and that the actor is an admin (`x-actor-admin: 1`), and only with
  `x-on-behalf-of`; any other key naming either is 403 (`viewer.ts` `actorOf`). Every steer records
  `research_steers.actor_sub` (a gap / inter-hub branch: `system:research`). A steer may carry
  `seed_sources` (`[{url, title, content}]`, 1-5): the branch is seeded with them (add-source).

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
