// Centralized env/config for openbrain-workbench. One place so handlers and
// repositories don't each reach into Deno.env.

export const config = {
  port: parseInt(Deno.env.get("PORT") || "8000", 10),

  // Shared secret Caddy injects as `X-Brain-Key` when proxying to us (G7).
  // The browser never holds it; we only trust the header on app-net. Reuses
  // the MCP_ACCESS_KEY value (plan §2.3) — supplied here as WORKBENCH_KEY.
  workbenchKey: Deno.env.get("WORKBENCH_KEY") || Deno.env.get("MCP_ACCESS_KEY") || "",

  // Direct Postgres (deno-postgres) for atomic multi-row writes (G8),
  // mirroring openbrain-suggestion-worker.
  db: {
    host: Deno.env.get("DB_HOST") || "openbrain-db",
    port: parseInt(Deno.env.get("DB_PORT") || "5432", 10),
    database: Deno.env.get("DB_NAME") || "openbrain",
    user: Deno.env.get("DB_USER") || "postgres",
    password: Deno.env.get("DB_PASSWORD") || "",
    poolSize: parseInt(Deno.env.get("DB_POOL_SIZE") || "8", 10),
  },

  // PostgREST (via the OB1 Caddy /rest/v1 proxy) for read paths — convenient,
  // non-atomic, fine for reads (G8).
  restBase: (Deno.env.get("OPEN_BRAIN_URL") || "http://openbrain-rest").replace(/\/+$/, ""),

  // Local OpenAI-compatible embeddings (bge-m3, 1024-dim) for chunk/source
  // embedding in later phases.
  embedding: {
    base: (Deno.env.get("EMBEDDING_API_BASE") || "http://llama-cpp-embed:8080/v1").replace(/\/+$/, ""),
    key: Deno.env.get("EMBEDDING_API_KEY") || "not-needed",
    model: Deno.env.get("EMBEDDING_MODEL") || "bge-m3",
    dimension: parseInt(Deno.env.get("EMBEDDING_DIMENSION") || "1024", 10),
    // Starting char budget per embedding call; embed() halves on a
    // physical-batch overflow until it fits (see util/embed.ts).
    maxChars: parseInt(Deno.env.get("EMBEDDING_MAX_CHARS") || "4000", 10),
  },

  // openbrain-extract sidecar (P5).
  extractUrl: (Deno.env.get("EXTRACT_URL") || "http://openbrain-extract:8000").replace(/\/+$/, ""),

  // Vault git repo (notes write path, P3) + binary asset volume (P5).
  vault: {
    gitDir: Deno.env.get("WIKI_GIT_DIR") || "/wiki",
    notesDir: (Deno.env.get("WIKI_GIT_DIR") || "/wiki") + "/notes",
    contentDir: (Deno.env.get("WIKI_OUT_DIR") || "/wiki/content"),
    assetsDir: Deno.env.get("WIKI_ASSETS_DIR") || "/assets",
  },
} as const;
