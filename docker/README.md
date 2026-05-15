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
