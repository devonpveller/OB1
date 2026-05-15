# Open Brain (OB1) — Self-Hosted Docker Stack

A fully local Open Brain: PostgreSQL + pgvector for storage, and the OB1
MCP server wired to the existing **ai-stack** local models. No Supabase,
no OpenRouter, no cloud — embeddings and metadata extraction run on your
own GPUs.

## Architecture

| Service         | Image                          | Role |
|-----------------|--------------------------------|------|
| `openbrain-db`  | `pgvector/pgvector:pg16`       | `thoughts` table + `match_thoughts`, auto-initialised from `init.sql` |
| `openbrain-mcp` | built from `../integrations/kubernetes-deployment` | Deno MCP HTTP server (4 tools + ChatGPT-compat `search`/`fetch`) |

The MCP server joins the external `ai-stack_llm-net` network and calls:

- **Embeddings:** `http://llama-cpp-embed:8080/v1` — `bge-m3`, **1024-dim**
  (the schema uses `vector(1024)`; upstream OB1 defaults to 1536 for OpenAI)
- **Chat (metadata):** `http://llama-cpp:8080/v1` — `qwen36-27b:nothink`

Secrets (`MCP_ACCESS_KEY`, `POSTGRES_PASSWORD`) are generated in `.env`.

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
