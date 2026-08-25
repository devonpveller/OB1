/**
 * entity-links — the single definition of "which entities have EARNED a
 * wiki page" (>= minLinked links across thoughts + non-retracted sources).
 *
 * INVARIANT (churn fix, 2026-08-25): the planned manifest's
 * backfill-eligible set must be a SUBSET of the sweep's kept-set.
 * Before this module, sweepOrphanEntityPages() and writePlannedManifest()
 * each derived "deserves a page" independently: the planner queued
 * zero-link entities that the sweep is defined to delete, so every
 * backfill slice was generated, swept, and re-queued inside the same
 * compile. The queue head (most-recently-updated first) was ~98%
 * zero-link, so the drain regenerated the SAME ~50 pages every compile
 * for a net drain of zero while the ~32k genuinely linked backlog
 * behind it starved (observed 2026-08-25: 135 compiles / 12h moved the
 * queue 33,617 -> 33,561).
 *
 * Pure functions: the caller injects the fetched rows and the slug
 * function (slugifyEntity lives in the bind-mounted
 * /recipes/_shared/slug.mjs, which build-time unit tests can't see).
 */

// Link counts per entity id across both junction tables. The source rows
// must already be retraction-filtered by the caller's query (mirrors
// generate-wiki listBatchCandidates — counting only thought links once
// made research-derived source-only pages vanish in the same cycle they
// were written).
export function mergeLinkCounts(thoughtRows, sourceRows) {
  const counts = new Map();
  for (const rows of [thoughtRows, sourceRows]) {
    for (const r of rows || []) {
      const k = r.entity_id;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return counts;
}

// metadata.wiki_slug override, else the canonical slug. Shared by the
// kept-set and the planner so a page can never be "kept" under one name
// while "planned" under another.
export function entitySlug(e, slugifyEntity) {
  return (
    (e.metadata && typeof e.metadata.wiki_slug === "string" && e.metadata.wiki_slug.trim()) ||
    slugifyEntity(e.canonical_name, e.entity_type)
  );
}

// The sweep's kept-set: relative page paths ("type/slug.md") of every
// entity meeting the link threshold. Anything on disk NOT in this set is
// an orphan.
export function keptEntityPages(entities, counts, minLinked, slugifyEntity) {
  const kept = new Set();
  for (const e of entities || []) {
    if ((counts.get(e.id) || 0) < minLinked) continue;
    kept.add(`${e.entity_type}/${entitySlug(e, slugifyEntity)}.md`);
  }
  return kept;
}

// The truthful filler queue. Entities whose page is missing on disk,
// split into:
//   - linked (backfill-eligible: the sweep would KEEP their page), and
//   - unlinked (flagged `unlinked: true`: the sweep would DELETE their
//     page, so generating one is guaranteed waste — kept in the manifest
//     only so the viewer can answer honestly instead of 404ing).
export function planEntityQueue({ entities, counts, minLinked, retiredTypes, slugifyEntity, pageExists }) {
  const planned = {};
  let linkedQueued = 0;
  let unlinkedQueued = 0;
  for (const e of entities || []) {
    if (!e.canonical_name || !e.entity_type) continue;
    if (retiredTypes.has(e.entity_type)) continue;
    const slug = entitySlug(e, slugifyEntity);
    if (pageExists(`${e.entity_type}/${slug}.md`)) continue;
    const entry = {
      id: e.id,
      name: e.canonical_name,
      type: e.entity_type,
      updated_at: e.updated_at,
    };
    if ((counts.get(e.id) || 0) < minLinked) {
      entry.unlinked = true;
      unlinkedQueued++;
    } else {
      linkedQueued++;
    }
    planned[`content/${e.entity_type}/${slug}`] = entry;
  }
  return { planned, linkedQueued, unlinkedQueued };
}

// The per-compile backfill slice: most-recently-active first, ONLY
// backfill-eligible entries. Entries without the `unlinked` flag (e.g. a
// manifest written by a pre-fix service) are treated as eligible — one
// transitional compile may churn them once; the next manifest carries
// flags.
export function backfillSlice(plannedMap, limit) {
  return Object.values(plannedMap || {})
    .filter((p) => Number.isInteger(p.id) && !p.unlinked)
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, limit)
    .map((p) => p.id);
}
