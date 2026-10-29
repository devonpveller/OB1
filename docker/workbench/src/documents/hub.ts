// The hub context of an open user document (research-workbench P2b, D1 settled 2026-09-25 17:45):
// the topic neighbourhoods the document's outbound links fall into, computed from the page graph
// ON READ, each named by its computed centre, with thin / contested markers.
//
// Hubs are EMERGENT: nothing here is stored - no topic or hub table, no hub id on a document. The
// document is an authored focus pointing one way into one or several hubs; it is never a hub
// itself (it is not a node of the computation - only what it links is).
//
// The computation: each linked item is a seed page (a source or report -> its leaf page
// content/source/<id>; a claim -> the leaf pages of the sources that ground it; a page -> itself).
// A seed's neighbourhood is the pages it links and the pages that link it. A hub centre is the
// neighbour shared by the most seeds (ties: the higher in-degree, then the slug), chosen greedily
// until every seed with a neighbour is covered; a seed that shares nothing is its own neighbourhood,
// centred on its best-connected neighbour. Thin = fewer than THIN_SOURCES source pages around the
// centre; contested = a claim grounded in the hub's sources is contradicted.
import type { Db } from "../contracts/db.ts";
import type { OutboundLink } from "./listing.ts";

export const THIN_SOURCES = 3;
export const SOURCE_PREFIX = "content/source/";

export interface Neighbour {
  seed: string;
  slug: string;
  title: string;
  page_class: string | null;
  in_degree: number;
}

export interface HubOut {
  centre: { slug: string; title: string; page_class: string | null; in_degree: number };
  seeds: string[];
  links: { kind: string; id: string }[];
}

// PURE: the greedy cover. `neighbours` are (seed, neighbour) pairs.
export function clusterSeeds(seeds: string[], neighbours: Neighbour[]): { centre: Neighbour; seeds: string[] }[] {
  const bySlug = new Map<string, { n: Neighbour; seeds: Set<string> }>();
  for (const n of neighbours) {
    if (seeds.includes(n.slug) && n.slug === n.seed) continue;
    const e = bySlug.get(n.slug) ?? { n, seeds: new Set<string>() };
    e.seeds.add(n.seed);
    bySlug.set(n.slug, e);
  }
  const left = new Set(seeds);
  const out: { centre: Neighbour; seeds: string[] }[] = [];
  const rank = (a: { n: Neighbour; seeds: Set<string> }, b: { n: Neighbour; seeds: Set<string> }) => {
    const ca = [...a.seeds].filter((s) => left.has(s)).length;
    const cb = [...b.seeds].filter((s) => left.has(s)).length;
    return cb - ca || b.n.in_degree - a.n.in_degree || a.n.slug.localeCompare(b.n.slug);
  };
  while (left.size) {
    const best = [...bySlug.values()].filter((e) => [...e.seeds].some((s) => left.has(s))).sort(rank)[0];
    if (!best) break;
    const covered = [...best.seeds].filter((s) => left.has(s)).sort();
    covered.forEach((s) => left.delete(s));
    out.push({ centre: best.n, seeds: covered });
  }
  // a seed with no neighbour at all: its own neighbourhood, centred on itself
  for (const s of [...left].sort()) {
    out.push({ centre: { seed: s, slug: s, title: s.split("/").pop() ?? s, page_class: null, in_degree: 0 }, seeds: [s] });
  }
  return out;
}

async function seedsOf(db: Db, links: OutboundLink[]): Promise<Map<string, { kind: string; id: string }[]>> {
  const seeds = new Map<string, { kind: string; id: string }[]>();
  const add = (slug: string, l: { kind: string; id: string }) => seeds.set(slug, [...(seeds.get(slug) ?? []), l]);
  for (const l of links) {
    if (l.kind === "source" || l.kind === "report") add(`${SOURCE_PREFIX}${l.id}`, l);
    else if (l.kind === "page") add(l.id, l);
  }
  const claimIds = [...new Set(links.filter((l) => l.kind === "claim").map((l) => l.id))];
  if (claimIds.length) {
    const rows = await db.query<{ claim_id: string; source_id: string }>(
      `SELECT claim_id::text, source_id::text FROM public.claim_sources WHERE claim_id::text = ANY($1::text[])`, [claimIds],
    );
    for (const r of rows) add(`${SOURCE_PREFIX}${r.source_id}`, { kind: "claim", id: r.claim_id });
  }
  return seeds;
}

async function neighboursOf(db: Db, seeds: string[]): Promise<Neighbour[]> {
  if (!seeds.length) return [];
  return await db.query<Neighbour>(
    `WITH s AS (SELECT unnest($1::text[]) AS seed),
     e AS (
       SELECT s.seed, t.target AS slug FROM s JOIN public.wiki_pages w ON w.slug = s.seed
         CROSS JOIN LATERAL jsonb_array_elements_text(w.links) AS t(target)
       UNION
       SELECT s.seed, b.slug FROM s CROSS JOIN LATERAL (
         SELECT b.slug FROM public.wiki_pages b WHERE b.links @> to_jsonb(s.seed) LIMIT 200) b
     )
     SELECT e.seed, e.slug, w.title, w.page_class,
            (SELECT count(*)::int FROM public.wiki_pages x WHERE x.links @> to_jsonb(e.slug)) AS in_degree
       FROM e JOIN public.wiki_pages w ON w.slug = e.slug
      WHERE e.slug <> e.seed`,
    [seeds],
  );
}

async function markers(db: Db, centre: string, hubSources: string[]) {
  const around = await db.query<{ n: number }>(
    `SELECT count(DISTINCT x.slug)::int AS n FROM (
       SELECT t.target AS slug FROM public.wiki_pages w CROSS JOIN LATERAL jsonb_array_elements_text(w.links) AS t(target) WHERE w.slug = $1
       UNION SELECT b.slug FROM public.wiki_pages b WHERE b.links @> to_jsonb($1::text)
       UNION SELECT $1::text) x
      WHERE x.slug LIKE '${SOURCE_PREFIX}%'`,
    [centre],
  );
  const ids = hubSources.filter((s) => s.startsWith(SOURCE_PREFIX)).map((s) => s.slice(SOURCE_PREFIX.length));
  const contested = ids.length
    ? await db.query<{ claim_id: string; text: string }>(
      `SELECT DISTINCT c.id::text AS claim_id, left(c.text, 160) AS text
         FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
        WHERE cs.source_id::text = ANY($1::text[]) AND (c.contradicted OR cs.edge_type = 'contradicts')
        ORDER BY 1 LIMIT 20`,
      [ids],
    )
    : [];
  const sources = around[0]?.n ?? 0;
  return {
    sources, thin: sources < THIN_SOURCES, contested: contested.length > 0, contested_claims: contested,
    why: [
      sources < THIN_SOURCES ? `${sources} source page(s) around the centre (thin below ${THIN_SOURCES})` : `${sources} source pages around the centre`,
      contested.length ? `${contested.length} contradicted claim(s) grounded in this neighbourhood` : "no contradicted claim grounded here",
    ],
  };
}

export async function hubContext(db: Db, path: string, links: OutboundLink[]) {
  const seeds = await seedsOf(db, links);
  const seedSlugs = [...seeds.keys()];
  const clusters = clusterSeeds(seedSlugs, await neighboursOf(db, seedSlugs));
  const hubs = [];
  for (const c of clusters) {
    const m = await markers(db, c.centre.slug, c.seeds);
    hubs.push({
      centre: { slug: c.centre.slug, title: c.centre.title, page_class: c.centre.page_class, in_degree: c.centre.in_degree },
      seeds: c.seeds,
      links: c.seeds.flatMap((s) => seeds.get(s) ?? []),
      ...m,
    });
  }
  return { document: path, computed_at: new Date().toISOString(), stored: false, hubs };
}
