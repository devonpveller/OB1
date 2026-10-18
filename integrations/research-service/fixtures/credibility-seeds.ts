/**
 * The credibility registries as SEEDED by the migrations, for offline tests (rw-p3a-entail).
 *
 * `credibility-registry.json` beside this file is the seed set the tests build the model from.
 * It is not hand-written: `parseSeeds()` derives it from docker/init-research-contract.sql (P0's
 * source_families / credibility_terms rows) and docker/init-research-credibility.sql (P3a), and
 * credibility.test.ts fails when the JSON and the SQL disagree - so the model the tests drive IS
 * the table that ships. (The research-service image build has no ../../docker in its context, so
 * that one drift test is ignored there and runs from the checkout.)
 */
import type { RegistryRow } from "../credibility.ts";

export const CREDIBILITY_SQL = [
  new URL("../../../docker/init-research-contract.sql", import.meta.url),
  new URL("../../../docker/init-research-credibility.sql", import.meta.url),
];

const REGISTRIES = new Set([
  "claim_kinds", "credibility_weights", "domain_classes", "paper_score_versions",
  "source_families", "entailment_verdicts", "credibility_terms",
]);

const TUPLE = /\(\s*'([a-z_]+)',\s*'([a-z0-9._-]+)',\s*'((?:[^']|'')*)',\s*'(\{(?:[^']|'')*\})'\s*\)/g;
const MERGE = /SET definition = definition \|\| '(\{(?:[^']|'')*\})'::jsonb\s+WHERE registry = '([a-z_]+)' AND key = '([a-z0-9._-]+)'/g;

export interface SeedSet { rows: RegistryRow[]; versions: Record<string, number> }

/** Derive the seeded rows from the migration texts (P0 first, then P3a). */
export function parseSeeds(sqlTexts: string[]): SeedSet {
  const rows = new Map<string, RegistryRow>();
  for (const sql of sqlTexts) {
    for (const m of sql.matchAll(TUPLE)) {
      if (!REGISTRIES.has(m[1])) continue;
      const k = `${m[1]}/${m[2]}`;
      if (rows.has(k)) continue;                                   // ON CONFLICT DO NOTHING
      rows.set(k, { registry: m[1], key: m[2], version: 1, definition: JSON.parse(m[4].replace(/''/g, "'")), retired_at: null });
    }
    for (const m of sql.matchAll(MERGE)) {
      const r = rows.get(`${m[2]}/${m[3]}`);
      if (r) { r.definition = { ...r.definition, ...JSON.parse(m[1].replace(/''/g, "'")) }; r.version++; }
    }
  }
  // Registry versions as the P3a statement-level trigger leaves them on a fresh volume: each
  // P3a-owned registry is seeded at 0 and its one seeding statement bumps it to 1.
  return { rows: [...rows.values()], versions: { credibility_weights: 1, claim_kinds: 1, domain_classes: 1, paper_score_versions: 1, entailment_verdicts: 1, source_families: 3, credibility_terms: 2 } };
}

export function seedSet(): SeedSet {
  return JSON.parse(Deno.readTextFileSync(new URL("./credibility-registry.json", import.meta.url)));
}

/** A stub-client answer for the two SELECTs loadCredibilityModel issues. */
export function credibilityRows(sql: string): unknown[] | null {
  if (/FROM public\.contract_registry_entries/i.test(sql)) return seedSet().rows;
  if (/FROM public\.contract_registries/i.test(sql)) {
    return Object.entries(seedSet().versions).map(([name, version]) => ({ name, version }));
  }
  return null;
}
