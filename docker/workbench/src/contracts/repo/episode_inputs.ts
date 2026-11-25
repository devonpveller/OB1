// rwr-episode-from: resolving "make an episode from <kind> <id>" - on the REQUESTER's side only.
//
// Every resolver here takes the identity seam's subject (who.sub, never a user the caller names) and returns the
// material of THAT user's own thing, or null. A thing that is another user's, a thing that does not exist, an id that
// cannot exist and a kind that has no such thing all answer the same null, and the caller turns it into one NotFound
// with one sentence - so a refusal for another user's row reads exactly as a missing one (timing aside).
//
// What a resolver returns is the text the script writer will read and the list of items that text came from, each
// marked (private / cloud): the list a later share step shows the owner before anything becomes visible to others.
// Nothing here writes a row. The caller (podcasts.ts createRequest) records the material on the request row, which only
// its requester reads; it is never written to a shared row.
//
// THE REQUEST BOUNDARY: the only way personal text leaves the private side toward the shared research store is the
// research service's derived door (repo/research_start.ts). An episode does not use it and does not need to: its script
// is written from the requester's own material by the local gateway alias on the podcast service's own key, and the
// result is an episode private to its owner. No resolver below, and no code in this item, sends material to the
// research service, the shared search or any shared row.
import type { Db } from "../db.ts";
import type { Identity } from "../../middleware/identity.ts";
import { FOREIGN_JOB } from "../../documents/ownership.ts";
import { type DisclosureItem, type FromRef, item, ITEMS_MAX, labelOf } from "../logic/episode_inputs.ts";
import { ownPrivateReportClaims } from "./ideas.ts";

export interface Material {
  title: string;
  text: string;
  items: DisclosureItem[];
}

export interface ResolveDeps {
  db: Db;
  /** the owner's document as theirs, or null (injected by src/app.ts, as research_start's readDoc) */
  readOwnDocument?: (path: string, who: Identity) => Promise<{ path: string; content: string } | null>;
}

export const TEXT_MAX = 60000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (s: string) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s);

type Resolver = (d: ResolveDeps, who: Identity, id: string) => Promise<Material | null>;

const idea: Resolver = async (d, who, id) => {
  if (!UUID.test(id)) return null;
  const row = (await d.db.query<{ id: string; title: string; summary: string }>(
    `SELECT id::text AS id, title, summary FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [id, who.sub],
  ))[0];
  if (!row) return null;
  const claims = await ownPrivateReportClaims(d.db, row.id, who.sub);
  const items = [item("idea", row.id, row.title || row.summary)];
  for (const c of claims.slice(0, ITEMS_MAX - 1)) items.push(item("claim", c.id, c.text));
  const text = [row.summary, ...claims.map((c) => c.text)].filter(Boolean).join("\n\n");
  return { title: row.title || labelOf(row.summary), text: clip(text), items };
};

const report: Resolver = async (d, who, id) => {
  if (!UUID.test(id)) return null;
  const row = (await d.db.query<{ id: string; idea_id: string | null; title: string; content: string }>(
    `SELECT id::text AS id, idea_id::text AS idea_id, title, content FROM public.research_private_reports WHERE id = $1::uuid AND owner_sub = $2`,
    [id, who.sub],
  ))[0];
  if (!row) return null;
  // the claims drawn from the idea's private reports are the owner's (slot 570): the owner-checked read, as the idea's own
  const claims = row.idea_id ? await ownPrivateReportClaims(d.db, row.idea_id, who.sub) : [];
  const items = [item("report", row.id, row.title || row.content), ...claims.slice(0, ITEMS_MAX - 1).map((c) => item("claim", c.id, c.text))];
  return { title: row.title || labelOf(row.content), text: clip(row.content), items };
};

const run: Resolver = async (d, who, id) => {
  if (!UUID.test(id)) return null;
  // the caller's own FINISHED run: a recorded prompt of theirs on the job or its root, or the refinery of their idea;
  // and not foreign by the one rule every job read uses (documents/ownership.ts FOREIGN_JOB)
  const row = (await d.db.query<{ id: string; query: string; result: Record<string, unknown> | null }>(
    `SELECT j.id::text AS id, j.query, j.result FROM public.research_jobs j
      WHERE j.id = $1::uuid AND j.status = 'done'
        AND NOT ${FOREIGN_JOB("j", "$2", "$3")}
        AND (EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id IN (j.id, COALESCE(j.root_job_id, j.id)) AND p.owner_sub = $2)
             OR EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = j.refinery_id AND i.owner_sub = $2))`,
    [id, who.sub, who.key],
  ))[0];
  if (!row) return null;
  let result = row.result;
  try { // the owner's own text of a run started from personal data lives in the owner-only store (slot 440)
    const own = (await d.db.query<{ result: Record<string, unknown> | null }>(`SELECT result FROM public.inlet_private_job($1::uuid, $2)`, [row.id, who.sub]))[0];
    if (own?.result) result = own.result;
  } catch { /* slot 440 absent or not readable by this role: the shared text is all there is */ }
  const claims = Array.isArray(result?.claims) ? (result!.claims as { text?: unknown }[]).map((c) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean) : [];
  const prose = ["synthesis", "prose_synthesis", "summary"].map((k) => result?.[k]).find((v) => typeof v === "string" && v) as string | undefined;
  const gaps = Array.isArray(result?.gaps) ? (result!.gaps as unknown[]).filter((g): g is string => typeof g === "string") : [];
  const title = row.query ? labelOf(row.query) : "A research run";
  const text = [row.query ? `Question: ${row.query}` : "", prose ?? "", ...claims.map((c) => `- ${c}`), gaps.length ? `Still open: ${gaps.join("; ")}` : ""].filter(Boolean).join("\n\n");
  if (!text.trim()) return null; // nothing to talk about is the same as nothing there
  const items = [item("run", row.id, title), ...claims.slice(0, ITEMS_MAX - 1).map((c, i) => item("claim", `${row.id}#${i}`, c))];
  return { title, text: clip(text), items };
};

const document: Resolver = async (d, who, id) => {
  if (!d.readOwnDocument) return null;
  const doc = await d.readOwnDocument(id, who).catch(() => null);
  if (!doc) return null;
  const title = (/^#\s+(.+)$/m.exec(doc.content)?.[1] ?? "").trim() || doc.path.split("/").pop() || "A document";
  return { title, text: clip(doc.content), items: [item("document", doc.path, title)] };
};

// a topic is shared knowledge (an entity or notebook page of the wiki): nothing private in it, so nothing to disclose.
// A person's note (class note) is theirs, not a topic; a page the privacy guards withheld has no row at all.
const topic: Resolver = async (d, _who, id) => {
  const row = (await d.db.query<{ slug: string; title: string; body: string }>(
    `SELECT slug, title, body FROM public.wiki_pages WHERE slug = $1 AND page_class IN ('entity', 'notebook')`, [id],
  ))[0];
  if (!row || !row.body.trim()) return null;
  return { title: row.title || row.slug, text: clip(row.body), items: [] };
};

// the resolvers by kind: the registry's workbench half (logic/episode_inputs.ts KINDS names the same kinds, and
// episode_inputs_test.ts proves the two agree). `discussion` has none until its store exists.
export const RESOLVERS: Record<string, Resolver> = { run, report, document, idea, topic };

export async function resolveFrom(d: ResolveDeps, who: Identity, from: FromRef): Promise<Material | null> {
  const r = Object.hasOwn(RESOLVERS, from.kind) ? RESOLVERS[from.kind] : null;
  return r ? await r(d, who, from.id) : null;
}
