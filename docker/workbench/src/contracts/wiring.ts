// Production wiring for the contract: the workbench's own pool, the registry reader, the
// pre-ingestion scorer (unavailable until P3a), the local embedder and the chunker.
import { pool } from "../db/pool.ts";
import { embed } from "../util/embed.ts";
import { chunkText } from "../util/chunk.ts";
import { poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { ContractDeps } from "./routes/http.ts";

export function contractDeps(): ContractDeps {
  const db = poolDb(pool);
  return {
    db,
    registry: new RegistryReader(db),
    scorer: unavailableScorer,
    embed,
    chunk: chunkText,
    // Where named mounts live inside this container (compose binds e.g. the podcast archive
    // at <root>/podcast-archive). A ROOT, not a destination: the destination is a setting.
    mountsRoot: Deno.env.get("CONTRACT_MOUNTS_ROOT") || "/mounts",
    streamPollMs: parseInt(Deno.env.get("CONTRACT_STREAM_POLL_MS") || "1000", 10),
    log: (m) => console.log(`[contract] ${m}`),
  };
}
