// Production wiring for the contract: the workbench's own pool, the registry reader, the
// pre-ingestion scorer (P3a: the research service's D15 model over HTTP when RESEARCH_SCORER_URL
// is set; unavailable - every debunked/credibility reopen refused - when it is not), the local
// embedder and the chunker.
import { pool } from "../db/pool.ts";
import { embed } from "../util/embed.ts";
import { chunkText } from "../util/chunk.ts";
import { poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { httpScorer, unavailableScorer } from "./logic/reopen.ts";
import type { ContractDeps } from "./routes/http.ts";

export function contractDeps(): ContractDeps {
  const db = poolDb(pool);
  const scorerUrl = Deno.env.get("RESEARCH_SCORER_URL") ?? "";
  const scorerKey = Deno.env.get("RESEARCH_SCORER_KEY") ?? "";
  return {
    db,
    registry: new RegistryReader(db),
    scorer: scorerUrl && scorerKey ? httpScorer(scorerUrl, scorerKey) : unavailableScorer,
    embed,
    chunk: chunkText,
    // Where named mounts live inside this container (compose binds e.g. the podcast archive
    // at <root>/podcast-archive). A ROOT, not a destination: the destination is a setting.
    mountsRoot: Deno.env.get("CONTRACT_MOUNTS_ROOT") || "/mounts",
    streamPollMs: parseInt(Deno.env.get("CONTRACT_STREAM_POLL_MS") || "1000", 10),
    log: (m) => console.log(`[contract] ${m}`),
    // P7a: blank as shipped = a render request stays queued (nothing is rendered)
    podcastRenderUrl: (Deno.env.get("PODCAST_RENDER_URL") ?? "").trim(),
  };
}
