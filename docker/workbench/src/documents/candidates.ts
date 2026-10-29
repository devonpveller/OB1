// Link candidates for the writing surface (research-workbench P2b, D12 parity item 2, D17 18:47-18:55):
// the `[[` autocomplete and the search panel read the SAME list - the document listing record (other
// user documents, by title) and the retrieval contract's search (sources, wiki pages, claims;
// research reports are the sources of type research_synthesis) - never Quartz's graphIndex.json.
//
// Search never excludes a source. One hidden in the document's refinery is still listed, sorted to
// the END with the tag "hidden in this session"; linking it in the document unhides it (pick-up).
// Held sources of the document's refinery are searched too (they are citable from day one).
import type { Db } from "../contracts/db.ts";
import { search } from "../contracts/repo/knowledge.ts";
import type { Identity } from "../middleware/identity.ts";
import { owned } from "./repo.ts";

export const HIDDEN_TAG = "hidden in this session";

export interface Candidate {
  kind: string;
  id: string;
  title: string;
  snippet: string;
  state: string;
  insert: string; // the link text the editor inserts
  tags: string[];
}

function linkFor(kind: string, id: string, title: string): string {
  const alias = title.replace(/[\]|\n]/g, " ").trim();
  if (kind === "page") return `[[${id}|${alias}]]`;
  const prefix = kind === "document" ? "doc" : kind;
  return `[[${prefix}:${id}|${alias}]]`;
}

// The user's other documents are candidates; nobody else's (user documents are per user).
export async function candidates(db: Db, q: string, path: string | null, who: Identity, limit = 25): Promise<{ query: string; refinery_id: string | null; candidates: Candidate[] }> {
  const query = q.trim();
  const row = path ? await owned(db, path, who) : null;
  const refineryId = row?.refinery_id ?? null;
  const out: Candidate[] = [];
  if (query.length >= 2) {
    const r = await search(db, { q: query, kinds: [], refinery_id: refineryId, limit, evidenceOnly: false, filter: null });
    const reports = new Set((await db.query<{ id: string }>(
      `SELECT id::text FROM public.sources WHERE id::text = ANY($1::text[]) AND content_type = 'research_synthesis'`,
      [r.results.filter((h) => h.kind === "source").map((h) => h.id)],
    )).map((x) => x.id));
    for (const h of r.results) {
      const kind = h.kind === "source" && reports.has(h.id) ? "report" : h.kind;
      out.push({ kind, id: h.id, title: h.title || h.id, snippet: h.snippet ?? "", state: h.state, insert: linkFor(kind, h.id, h.title || h.id), tags: [] });
    }
  }
  const docs = await db.query<{ path: string; title: string }>(
    `SELECT path, title FROM public.user_document_listings
      WHERE owner_sub = $4 AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR path ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR path <> $2) AND path !~ '^documents/([^./][^/]*/)?[.]trash/'
      ORDER BY updated_at DESC LIMIT $3`,
    [query, path, limit, who.sub],
  );
  for (const d of docs) {
    out.push({ kind: "document", id: d.path, title: d.title, snippet: d.path, state: "current", insert: linkFor("document", d.path, d.title), tags: [] });
  }
  if (refineryId) {
    const hidden = new Set((await db.query<{ k: string }>(
      `SELECT node_kind || ':' || node_ref AS k FROM public.refinery_hidden WHERE refinery_id = $1`, [refineryId],
    )).map((r) => r.k));
    for (const c of out) if (hidden.has(`${c.kind === "report" ? "source" : c.kind}:${c.id}`)) c.tags.push(HIDDEN_TAG);
  }
  // stable: everything not hidden keeps its order; hidden ones go last, nothing is dropped
  const visible = out.filter((c) => !c.tags.includes(HIDDEN_TAG));
  const hiddenOnes = out.filter((c) => c.tags.includes(HIDDEN_TAG));
  return { query, refinery_id: refineryId, candidates: [...visible, ...hiddenOnes] };
}
