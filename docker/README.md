# Open Brain (OB1) — Self-Hosted Docker Stack

A fully local Open Brain: PostgreSQL + pgvector for storage, and the OB1
MCP server wired to the existing **ai-stack** local models. No Supabase,
no OpenRouter, no cloud — embeddings and metadata extraction run on your
own GPUs.

## Architecture

| Service         | Image                          | Role |
|-----------------|--------------------------------|------|
| `openbrain-db`  | `pgvector/pgvector:pg16`       | `thoughts` + 18 extension tables, auto-initialised from `init.sql` + `init-extensions.sql` |
| `openbrain-mcp` | built from `../integrations/kubernetes-deployment` | Core Deno MCP server (4 tools + ChatGPT-compat `search`/`fetch`) — port `8808` |
| `openbrain-ext` | built from `./extensions-server` | Combined extensions MCP server — all 6 OB1 extensions, **39 tools** — port `8809` |
| `openbrain-mcpo` / `openbrain-mcpo-ext` | `ghcr.io/open-webui/mcpo:latest` | Two MCP→OpenAPI bridges for Open WebUI (core / extensions) |

The MCP server joins the external `ai-stack_llm-net` network and calls:

- **Embeddings:** `http://llama-cpp-embed:8080/v1` — `bge-m3`, **1024-dim**
  (the schema uses `vector(1024)`; upstream OB1 defaults to 1536 for OpenAI)
- **Chat (metadata):** `http://llama-cpp:8080/v1` — `qwen36-27b:nothink`

Secrets live in `.env` (gitignored). Committable templates with the same
keys are provided as `*.example` files.

## First-time setup (for a fresh environment)

```bash
cd OB1/docker

# 1. Create the real config from templates (all gitignored)
cp .env.example                   .env
cp mcpo.config.json.example       mcpo.config.json
cp mcpo-ext.config.json.example   mcpo-ext.config.json

# 2. Generate secrets and put them in .env
openssl rand -hex 32   # -> MCP_ACCESS_KEY
openssl rand -hex 16   # -> POSTGRES_PASSWORD
openssl rand -hex 24   # -> MCPO_API_KEY
uuidgen                # -> DEFAULT_USER_ID  (any UUID)

# 3. Put the SAME MCP_ACCESS_KEY value into the x-brain-key field of
#    mcpo.config.json AND mcpo-ext.config.json (replace the placeholder)

# 4. (host MCP clients, e.g. Claude Code) copy mcp.json.example to your
#    client project's .mcp.json, set the same MCP_ACCESS_KEY, gitignore it

# 5. Adjust model endpoints in docker-compose.yml if your local
#    OpenAI-compatible API differs (EMBEDDING_API_BASE / CHAT_API_BASE
#    and model names). Embedding dim must match init.sql's vector(N).

docker compose up -d --build
```

The stack expects an external Docker network `ai-stack_llm-net` with
`llama-cpp` (chat) and `llama-cpp-embed` (embeddings) reachable by name.
Point the `*_API_BASE` env vars at any OpenAI-compatible endpoint if your
setup differs.

## Compose profiles

A bare `docker compose up -d` in this directory starts the **core** fleet
only — the knowledge store, the doors onto it, the workers that keep it
coherent, and its backup. Three groups sit behind compose profiles so a
caller turns on the engines and surfaces it actually needs without editing
`docker-compose.yml` (added 2026-09-19, ai-stack item `sl-ob1-profiles`):

```bash
docker compose up -d                                     # core only
docker compose --profile research up -d                  # + the research engine
docker compose --profile research --profile wiki \
               --profile notebook --profile idea-refinery up -d   # everything
```

Core is everything NOT listed below: `openbrain-db`, `-mcp`, `-ext`,
`-gateway`, `-ops-gateway`, `-mcpo`, `-mcpo-ext`, `-postgrest`, `-rest`,
`-entity-worker`, `-suggestion-worker`, `-extract`, `-chunk-worker`,
`-grounding-backfiller`, `-db-backup`, plus the always-on scheduled slice
(`-cron`, `-gmail-pull`, `-gmail-prune`, `-digest`, `-podcast`).

### What each profile turns on, and why it is not core

| Service | Profile | Why it is not core |
|---------|---------|--------------------|
| `openbrain-curator` | `research` | Exists only to place research output. Its one inbound route is `POST /ingest/research-package`; its only caller in this project is `openbrain-research` (`CURATOR_URL`). No core service reaches it, and with no research running there is nothing to curate. |
| `openbrain-research` | `research` | The research harness itself — search, fetch, synthesis, grounding. An engine, not part of the store: the brain captures, embeds, chunks and serves without it. |
| `openbrain-wiki` | `wiki` | The vault compiler. It *produces* the wiki surface from the store; the store is complete and queryable with no vault compiled. |
| `openbrain-wiki-viewer` | `wiki` | The Quartz renderer of the vault the compiler writes. `depends_on: openbrain-wiki`, so it belongs to the same group by construction — it has nothing to render otherwise. |
| `openbrain-workbench` | `wiki` | The read/write half of the wiki surface, reached same-origin behind the viewer through the portal Caddy `handle /workbench/*`. Its only in-project caller is `openbrain-wiki` (`WORKBENCH_URL`, revision commits). Nothing core calls it. |
| `openbrain-wiki-backup` | `wiki` | Tars `openbrain-wiki-data` + `wiki-assets` — the two volumes only the wiki group writes. With the group off there is no new vault state to protect. |
| `surrealdb` | `notebook` | Open Notebook's local UI/queue/chat store and nothing else's; no other service in this project speaks to it. |
| `open_notebook` | `notebook` | A surface onto `openbrain-db` (the canonical store since IKS), not an engine. `depends_on: surrealdb`, same group. |
| `open-notebook-backup` | `notebook` | Exports the SurrealDB datastore and `notebook_data` — both belong to the notebook surface. |
| `openbrain-idea-refinery` | `idea-refinery` | Pre-existing profile in `docker-compose.scheduled.yml`; the owed-idea drain. It is gated because it needs a Mattermost bot token to deliver dossiers — but it is **running today**, not waiting: the token is set on this host and both ai-stack drivers pass the profile on every invocation. Its only engine is `openbrain-research`, so see the cross-group table below. |

### The invariant a change here must not break

**No core service may `depends_on` a profiled one.** Compose would then
either refuse to render or quietly drag the profiled service in, and the
"core only" promise above would be false. As of this commit no such edge
exists: every `depends_on` either stays inside a group
(`openbrain-research` → `openbrain-curator`, `openbrain-wiki-viewer` →
`openbrain-wiki`, `open_notebook` → `surrealdb`) or points from a profiled
service **down** into core, which is always safe.

### The six cross-group references that survive at runtime

`depends_on` is not the only way one service reaches another. **Six**
references cross a group boundary as environment URLs. None affects the
render and none stops a container starting — every one of them is a `fetch`
that fails at call time, usually inside a `try/catch`. That makes them the
dangerous kind: the stack comes up green and a scheduled job quietly stops
producing output.

| Caller | Caller group | Key | Target | Target profile | What goes dead when the target's profile is off |
|---|---|---|---|---|---|
| `openbrain-ext` | core | `WIKI_RECOMPILE_URL` | `openbrain-wiki` | `wiki` | The `wiki_trigger_recompile` tool gets connection refused; the `wiki_*` readers see whatever the vault last held. The `openbrain-wiki-data` volume is declared top-level, so the read-only mount still resolves and the 39 tools still serve. |
| `openbrain-gmail-prune` | **core** | `WIKI_RECOMPILE_URL` | `openbrain-wiki` | `wiki` | The **nightly prune completes and never recompiles the vault** — `prune-short-term.ts:153` POSTs inside a `try/catch`, so it logs a connection error and exits 0. Nothing alerts. |
| `openbrain-gmail-pull` | **core** | `WIKI_RECOMPILE_URL` | `openbrain-wiki` | `wiki` | Nothing: the key is inherited from the shared `env_file` and `openbrain-gmail-pull`'s code never reads it. Listed because it is in the render and the next reader deserves to know it is inert rather than rediscover it. |
| `openbrain-podcast` | core | `RESEARCH_URL` | `openbrain-research` | `research` | The podcast's link-enrichment research step dies; the episode degrades to email-only. |
| `openbrain-podcast` | core | `ON_BASE` | `open_notebook` | `notebook` | **No audio is rendered** — the chain runs to the end and produces no episode. |
| `openbrain-idea-refinery` | `idea-refinery` | `RESEARCH_URL` | `openbrain-research` | `research` | The drain starts, walks the owed-idea queue and **can never research anything** (`index.ts:268` submits, `:295` polls). Its only engine. |

Two of those are the same shape the digest chain already taught us: run the
scheduled slice with `--profile wiki --profile research --profile notebook`,
or accept that parts of it run nightly and produce nothing.

**`idea-refinery` needs `research`.** Compose has no "this profile implies that
one", so passing `--profile idea-refinery` by hand still requires
`--profile research` beside it. The ai-stack manifest expresses the dependency
instead (`requires = ["research"]` on the profile, expanded by
`scripts/stack/stack.py`), so its drivers pull research in automatically.

### How this list was built — and how to rebuild it

**A grep over these compose files is not enough.** `openbrain-gmail-pull` and
`openbrain-gmail-prune` receive `WIKI_RECOMPILE_URL` from
`env_file: ../recipes/email-history-import/.env`, which never appears in the
compose text; `prune-short-term.ts:32` also hard-codes the same URL as its
default, so unsetting the variable would not remove the reference. The first
attempt at this change grepped, found two, and wrote "two" into three
documents. Match the **render** instead:

```bash
docker compose -f docker-compose.yml --env-file .env \
  --profile research --profile wiki --profile notebook --profile idea-refinery \
  config --format json
```

then match every `environment` **value** against every profiled service name,
and check `depends_on`, `network_mode`, `links`, network aliases and shared
named volumes the same way. (There are no `network_mode`, `links` or aliases
anywhere in this project; `openbrain-wiki-data` is the only cross-group volume
and every core mount of it is read-only.)

Verified by rendering every combination against this file:

| Profiles passed | Services rendered |
|-----------------|-------------------|
| (none) | 20 — core 15 + the 5 always-on scheduled |
| `research` | 22 |
| `wiki` | 24 |
| `notebook` | 23 |
| `idea-refinery` | 21 |
| `idea-refinery` + `research` | 23 — the ai-stack driver's default pair for this plane |
| `research` + `wiki` | 26 |
| `research` + `notebook` | 25 |
| `wiki` + `notebook` | 27 |
| `research` + `wiki` + `notebook` | 29 |
| all four | 30 — the full fleet |

Every number above is the output of
`docker compose -f docker-compose.yml <flags> config --services | wc -l`, not
20 plus the deltas. The `idea-refinery` + `research` row is the one that has
been written down wrong before: it is **23**, and the number that gets put
there by mistake is 22 — the count for `research` ALONE.

These renders assume `COMPOSE_PROFILES` is **unset**. If it is set in `.env`
(see below) a bare `docker compose config` renders whatever that line names —
on a host with all four declared, the `(none)` row reads 30, not 20.

`docker compose config` with all three new profiles is byte-identical to the
render before this change apart from the nine `profiles:` keys.

### How to turn these on

There are three ways, and they do not all behave the same.

**1. `--profile` flags on the command line.** Shown at the top of this section.
A CLI `--profile` **REPLACES** `COMPOSE_PROFILES`; it does not union with it.
Measured against this file with all four profiles in `.env`:
`--profile research` alone renders **22**, not 30 — the other three were
silently dropped. So any script that passes one flag cannot be rescued by an
operator's env file, and a script that passes flags at all must pass every
profile it wants.

**2. `COMPOSE_PROFILES` in this directory's `.env`.** This is a plane's own
declaration site, the same as every other ai-stack plane since the per-plane
env split (D17):

```dotenv
COMPOSE_PROFILES=research,wiki,notebook,idea-refinery
```

Compose loads `OB1/docker/.env` natively because that is the project
directory, so no `--env-file` is needed and the working directory is
irrelevant. With that line present, a bare `docker compose config --services`
renders 30 — service-for-service identical to the four-flag render (`diff`
clean). This is the declaration that makes a bare `docker compose up -d`, and
every ai-stack recovery script that drives this project without flags, start
the whole fleet.

**3. The ai-stack driver.** `python scripts/stack/stack.py enable research`
resolves this plane's profiles from `stack.manifest.toml` and writes them to
its state file:

```
  ob1  profiles: idea-refinery, research, wiki, notebook
```

`up ob1` then emits all four `--profile` flags — 30 services. (`idea-refinery`
is the plane's one `default` profile and `requires` `research`, so it pulls the
engine in; `wiki` and `notebook` come from the research product's `surfaces`.)

**The two declaration sites compose, and the union has a consequence worth
knowing.** The driver unions this plane's `COMPOSE_PROFILES` into whatever it
resolves, deliberately — a `--profile` flag must never start FEWER containers
than a bare invocation would. The effect is that
`stack.py enable research --headless`, which exists to drop the `wiki` and
`notebook` *surfaces*, prints that it dropped them and then drives all four
anyway when `.env` declares all four. Measured. If you want `--headless` to
mean anything for this plane, do not put the surface profiles in `.env`.

### Consumers outside this project

Turning `wiki`, `notebook` or `research` off breaks callers in OTHER compose
projects. None of them fails at start; all of them fail at request time, which
is the same quiet shape as the cross-group table above. The paths are relative
to the **ai-stack** repo that carries this submodule, not to this checkout.

**Scope of this table: a runtime reach by CONTAINER NAME**, i.e. a network call
to one of the ten profiled services over a shared `ai-stack_*` network. **Seven
surfaces at thirteen call sites**, living in three compose projects — `portal`,
`frontend` (its `tailscale` companion, plus the OWUI-hosted tool and pipes that
run inside `openwebui`) and `agent-org` — with one further operator script noted
under the table. Host-side probes that address a published `127.0.0.1` port, and
scripts that drive the `docker` CLI, are a different class and are listed
separately below.

| # | Consumer | File:line (ai-stack) | Reaches | Profile | What the user sees |
|---|---|---|---|---|---|
| 1 | portal Caddy | `portal/config/caddy/Caddyfile:136` | `openbrain-workbench:8000` | `wiki` | the `/workbench/*` route 502s |
| 2 | portal Caddy | `portal/config/caddy/Caddyfile:143` | `openbrain-wiki-viewer:8080` | `wiki` | the published wiki 502s |
| 3 | portal Caddy | `portal/config/caddy/Caddyfile:242`, `:250` | `open_notebook:5055`, `:8502` | `notebook` | the Open Notebook routes 502 |
| 4 | the `frontend` plane's `tailscale` companion | `frontend/entrypoint.sh:60`, route table `:97`, `:99` | `open_notebook:8502` and `:5055/api/config` | `notebook` | the tailnet Open Notebook UI (`:8443`) and API (`:5055`) serve routes fail their probes |
| 5 | `agent-org`'s `agent-bridge` | `agent-org/docker/docker-compose.yml:208` → `agent-bridge/app/config.py:373`, `app/modules/grounding.py:12` | `openbrain-research:8000` | `research` | effort grounding (P4.0a) and the Tier-2 advisor stop producing, in a third compose project |
| 6 | the deployed OWUI **Deep Research** tool | `owui/tools/deep_research.py:47` (deployed per `owui/manifest.csv:10`) | `openbrain-research:8000` | `research` | the tool errors at call time; its own message asks whether `openbrain-research` is reachable |
| 7 | OWUI **Server Status** pipe — two separate modules | `status-pipe/modules/system-health/service/system_health.py:58`, `:66`; `status-pipe/serve/tailscale_serve_pipe.py:119`, `:135`, `:652` | `open_notebook:5055/api/config`, `openbrain-research:8000/health` | `notebook`, `research` | both probes report down (`critical: False`, so the panel degrades rather than alarming) |

Plus one **operator path** whose reach originates inside a profiled container:
`scripts/backup/restore-from-snapshot.ps1:432` `docker exec`s into
`open-notebook-backup` and has it run `surreal import --endpoint
http://surrealdb:8000`. Both ends are `notebook`, so with that profile off the
Open Notebook restore path has neither the container it execs into nor the
datastore it imports to.

**Two of these are easy to get wrong, so they are stated exactly:**

- Row 4 reaches Open Notebook **directly** but reaches the wiki **through portal
  Caddy**: `frontend/docker-compose.yml:366` sets `QUARTZ_HOST=${QUARTZ_HOST:-caddy}`
  and the deployed value is `caddy:8446`. `entrypoint.sh:66`'s own fallback is
  `openbrain-wiki-viewer`, but the compose always supplies a value, so that
  fallback does not apply on this stack — the comment at
  `frontend/docker-compose.yml:361-364` records why it was moved behind Caddy.
  So turning `wiki` off breaks the tailnet wiki route *via* row 2, not as a
  seventh direct edge.
- Row 7 is **two files, not one**. An earlier version of this table named only
  `status-pipe/modules/system-health/`, which does not cover the serve pipe.

**Not in the table, deliberately — the host-side class.** These address a
published `127.0.0.1` port or drive `docker exec` / `docker compose`, so they are
not container-name reaches, but they do go red when a profile is off:
`scripts/checks/check-openbrain-health.ps1` (`127.0.0.1:8818`, `:8816` —
research and curator), `scripts/checks/stack-watchdog.ps1` (`docker exec
open_notebook`, and it *repairs* rather than consumes),
`scripts/checks/wiki-latency-probe.ps1` (`docker exec openbrain-wiki-viewer`).
Also excluded: inventories that merely name the services
(`scripts/lib/stack-services.json`, `stack.manifest.toml`,
`status-pipe/orchestrator.py`'s docstring) and `.env`/`.env.example` lines that
deliver a URL to one of the seven above.

### How to rebuild this list

Nothing in THIS project records these edges — they are another project's
configuration — so the list has to be re-derived, not maintained. From the
ai-stack repo root:

```bash
grep -rnE "(https?://|\"host\"[: ]+\"|target_host[\"'=: ]+|_HOST[=:] *|reverse_proxy +)(openbrain-research|openbrain-wiki|openbrain-wiki-viewer|openbrain-workbench|openbrain-curator|openbrain-idea-refinery|open_notebook|surrealdb)" . \
  --exclude-dir=OB1 --exclude-dir=.git --exclude-dir=node_modules \
  --exclude-dir=archive --exclude-dir=documentation --exclude-dir=backups
```

then read every hit at its line and keep only the runtime reaches. A bare
name-only grep returns ~60 files and is mostly inventories and prose; the
URL/host-field shape above returns 23 lines in 15 files (21 in configuration or
code, two prose mentions in Markdown), which is a list a person can actually
check. **Do not stop at the first project you find** — the first
version of this table had portal and one status-pipe module and missed four
surfaces in three other projects.


## Usage

```bash
cd "d:/Open WebUI/OB1/docker"
docker compose up -d            # start
docker compose ps               # status
docker compose logs -f openbrain-mcp
docker compose down             # stop (keeps data volume)
docker compose down -v          # stop + delete the thoughts database
```

The ai-stack `llama-cpp` / `llama-cpp-embed` containers must be running
(they are on `ai-stack_llm-net`). The first `capture`/`search` call after
idle may be slow while llama-swap loads the Qwen model.

## Endpoint

The MCP endpoint is published only on loopback:

```
http://127.0.0.1:8808/
```

Authenticate with the access key from `.env`, sent either as the
`x-brain-key` header or a `?key=` query parameter.

### Connect from Claude Code

```bash
KEY=$(grep MCP_ACCESS_KEY "d:/Open WebUI/OB1/docker/.env" | cut -d= -f2)
claude mcp add --transport http open-brain http://127.0.0.1:8808/ \
  --header "x-brain-key: $KEY"
```

### Connect from Open WebUI (via the mcpo bridges)

Open WebUI v0.8.10 has **no native MCP** — its URL-based "tool server" /
integration speaks **OpenAPI**. So the stack runs **two** `mcpo`
bridge containers (one per MCP server: a single mcpo instance crashes
when proxying multiple streamable-http servers — anyio cancel-scope bug).
They sit on the shared `ai-stack_llm-net`, reachable from the `openwebui`
container by name (not the host loopback port).

In Open WebUI, add **two** OpenAPI tool servers (Settings → Tools /
Integrations → add server), both using the **same API key**:

| URL | API Key |
|-----|---------|
| `http://openbrain-mcpo:8000/open-brain` | `MCPO_API_KEY` from `.env` |
| `http://openbrain-mcpo-ext:8000/open-brain-extensions` | `MCPO_API_KEY` from `.env` |

That exposes the 6 core tools + 39 extension tools to every Open WebUI
model. Verified: both bridges discover their tools and proxy real calls
(`thought_stats`, `list_vendors`, …) with zero errors. OpenAPI docs:
`…/open-brain/docs` and `…/open-brain-extensions/docs`.

### Connect from Claude Code

A gitignored `.mcp.json` in the ai-stack repo registers both
`open-brain` (`http://127.0.0.1:8808/`, core) and
`open-brain-extensions` (`http://127.0.0.1:8809/`, 39 extension tools).
Reload Claude Code and approve the project MCP servers when prompted.

## Extensions

All six OB1 extensions run in the single `openbrain-ext` server, ported
from Supabase to raw PostgreSQL (39 tools, same names/inputs as upstream):

| Extension | Tools | Examples |
|-----------|-------|----------|
| Household Knowledge | 5 | `add_household_item`, `search_household_items`, `add_vendor` |
| Home Maintenance | 4 | `add_maintenance_task`, `log_maintenance`, `get_upcoming_maintenance` |
| Family Calendar | 6 | `add_family_member`, `add_activity`, `get_week_schedule` |
| Meal Planning | 6 | `add_recipe`, `create_meal_plan`, `generate_shopping_list` |
| Professional CRM | 8 | `add_professional_contact`, `log_interaction`, `link_thought_to_contact` |
| Job Hunt Pipeline | 10 | `add_company`, `submit_application`, `get_pipeline_overview` |

Schema notes: upstream `auth.uid()`/`auth.jwt()` RLS is preserved verbatim
behind a no-op `auth` shim schema; the server connects as superuser
(RLS bypassed) and scopes every query by `DEFAULT_USER_ID` (single user).
`init-extensions.sql` auto-runs on a fresh DB; for the current DB it was
applied manually. The 39 tools add up — see upstream
`docs/05-tool-audit.md` for managing tool-context cost on agentic clients.

### mcpo note (resolved)

A single mcpo instance proxying **both** streamable-http servers reliably
crashes its Python client (anyio "cancel scope" / `GeneratorExit`). Fixed
by running **one mcpo per server** (`openbrain-mcpo` + `openbrain-mcpo-ext`),
each with a single-server config. Both verified discovering tools and
proxying real calls with zero errors. Keep them split if adding more
extensions/servers later.

### Connect from Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "http://127.0.0.1:8808/?key=YOUR_MCP_ACCESS_KEY",
      "transport": "http"
    }
  }
}
```

> The endpoint is loopback-only. To reach it from another device, front it
> with the ai-stack Tailscale/reverse-proxy layer rather than publishing
> the port publicly — the access key is the only auth.

### Quick smoke test

```bash
KEY=$(grep MCP_ACCESS_KEY .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:8808/ \
  -H "x-brain-key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools

`capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`,
plus read-only `search` / `fetch` for ChatGPT connector compatibility.

## Notes & troubleshooting

- **Embedding dimension is fixed at 1024** to match `bge-m3`. If you point
  the server at a different embedding model, change `vector(1024)` in
  `init.sql`, then recreate the DB (`docker compose down -v && up -d`) —
  existing vectors cannot be reused at a different dimension.
- **DB init runs once.** `init.sql` only executes when the data volume is
  empty. After editing it, run `docker compose down -v` to re-init.
- **`capture` errors / CrashLoop:** usually the model endpoint is
  unreachable — confirm `llama-cpp` and `llama-cpp-embed` are healthy
  (`docker ps`) and on `ai-stack_llm-net`.
- This stack is based on the community `integrations/kubernetes-deployment`
  variant (direct Postgres, OpenAI-compatible API) rather than the default
  Supabase + OpenRouter path in `docs/01-getting-started.md`.
