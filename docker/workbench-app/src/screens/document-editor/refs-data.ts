// What the References tab reads and writes (rwr-doc-refs). Every call goes through lib/api.ts (the one door); nothing
// names a user and nothing is kept in the browser. The routes are the workbench's own:
//   GET    contract/documents/pending-refs?path=      the "to place" queue, oldest first        { path, pending_refs, total }
//   POST   contract/documents/pending-refs            add a cite (source_id | claim_id)         201 row; 409 names the row waiting
//   DELETE contract/documents/pending-refs/<id>       take a cite out of the queue
//   POST   contract/documents/pending-refs/<id>/place pin a record and leave the queue          201 { record, insert }
//   GET    documents/references?path=                 the holder rows in order                  { references: [...], listed }
//   DELETE documents/references/<id>?path=            remove an ATTACHED reference (a cited one is removed from the text)
//   POST   documents/references/<id>/repin?path=      a NEW record at the newest revision       201 { replaces, record, insert }
//   GET    documents/candidates?path=&q=              link candidates (sources, claims, pages, documents)
//   POST   contract/diff-check                        { references: [{ reference_id }] } -> is each pin out of date
//   GET    contract/sources/<id>/quality              the score and why
//   GET    contract/references/<id>                   a reference record (its quote) or a source (its title)
//   GET    contract/chunks/<source>:<idx>/context     the chunk of the newest revision
import { api, ApiError } from "../../lib/api";

export type PendingRow = { id: string; source_id: string | null; claim_id: string | null; section: string; quote: string; added_from: string; created_at: string };
export type HolderRow = { origin: string; seq: number; reference_id: string; source_id: string; pinned_revision: number; scope: string; title: string };
export type Candidate = { kind: string; id: string; title: string; snippet: string; tags: string[] };
export type Diff = { reference_id: string; pinned_revision: number; current_revision: number | null; out_of_date: boolean; equivalent_current_chunk_id: string | null; anchor: string };
export type RepinResult = { replaces: string; record: { id: string }; insert: string };

const enc = encodeURIComponent;
const cq = "/workbench/contract/documents/pending-refs";
const bad = () => new Error("unexpected answer");

export async function readPending(path: string): Promise<{ rows: PendingRow[]; total: number }> {
  const { data } = await api<any>("GET", `${cq}?path=${enc(path)}&limit=200`); // 200 = the route's maximum and the queue's own bound
  if (!data || !Array.isArray(data.pending_refs)) throw bad();
  return { rows: data.pending_refs as PendingRow[], total: Number(data.total) || data.pending_refs.length };
}
export async function readHolders(path: string): Promise<HolderRow[]> {
  const { data } = await api<any>("GET", `/workbench/documents/references?path=${enc(path)}`);
  if (!data || !Array.isArray(data.references)) throw bad();
  return data.references as HolderRow[];
}
// a cite goes into the queue: a source or a claim, with the section and quote it carried (a re-queue keeps them)
export async function addPendingRow(path: string, row: { source_id: string | null; claim_id: string | null; section: string; quote: string }, from: string): Promise<void> {
  await api("POST", cq, {
    path, ...(row.source_id ? { source_id: row.source_id } : { claim_id: row.claim_id }),
    ...(row.section ? { section: row.section } : {}), ...(row.quote ? { quote: row.quote } : {}), added_from: from,
  });
}
export async function removePending(id: string): Promise<void> {
  await api("DELETE", `${cq}/${enc(id)}`);
}
export async function placePending(id: string): Promise<{ insert: string; recordId: string }> {
  const { data } = await api<any>("POST", `${cq}/${enc(id)}/place`, { form: "chip" });
  if (!data || typeof data.insert !== "string" || typeof data.record?.id !== "string") throw bad();
  return { insert: data.insert, recordId: data.record.id };
}
export async function removeAttached(path: string, referenceId: string): Promise<void> {
  await api("DELETE", `/workbench/documents/references/${enc(referenceId)}?path=${enc(path)}`);
}
export async function repin(path: string, referenceId: string): Promise<RepinResult> {
  const { data } = await api<any>("POST", `/workbench/documents/references/${enc(referenceId)}/repin?path=${enc(path)}`);
  if (!data || typeof data.insert !== "string" || typeof data.record?.id !== "string") throw bad();
  return data as RepinResult;
}
export async function findCandidates(path: string, q: string): Promise<Candidate[]> {
  const { data } = await api<any>("GET", `/workbench/documents/candidates?path=${enc(path)}&q=${enc(q)}`);
  if (!data || !Array.isArray(data.candidates)) throw bad();
  return (data.candidates as any[]).map((c) => ({ kind: String(c.kind), id: String(c.id), title: String(c.title ?? ""), snippet: String(c.snippet ?? ""), tags: Array.isArray(c.tags) ? c.tags.map(String) : [] }));
}
export async function diffCheck(referenceIds: string[]): Promise<Map<string, Diff>> {
  const out = new Map<string, Diff>();
  if (!referenceIds.length) return out;
  const { data } = await api<any>("POST", "/workbench/contract/diff-check", { references: referenceIds.slice(0, 200).map((reference_id) => ({ reference_id })) });
  if (!data || !Array.isArray(data.results)) throw bad();
  for (const r of data.results as Diff[]) if (r?.reference_id) out.set(r.reference_id, r);
  return out;
}
// The quality note of a source: the score and the first reason; a null value is "not rated"
export async function readQuality(sourceId: string): Promise<{ value: number | null; family: string; reason: string }> {
  const { data } = await api<any>("GET", `/workbench/contract/sources/${enc(sourceId)}/quality`);
  if (!data || typeof data !== "object" || !data.score) throw bad();
  return { value: typeof data.score.value === "number" ? data.score.value : null, family: String(data.family ?? ""), reason: String(data.factors?.[0]?.reason ?? "") };
}
// a source's title (a held source answers `held`); a source the caller cannot read is a 404 and has no title here
export async function readSourceTitle(sourceId: string): Promise<string | null> {
  try {
    const { data } = await api<any>("GET", `/workbench/contract/references/${enc(sourceId)}`);
    const t = data?.source?.title ?? data?.held?.title;
    return typeof t === "string" && t ? t : "Untitled source";
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
// the two sides of the re-pin view: the words the reference pins, and the text now standing for them
export async function readPinnedWords(referenceId: string): Promise<string> {
  const { data } = await api<any>("GET", `/workbench/contract/references/${enc(referenceId)}`);
  const q = data?.record?.selectors?.quote?.exact;
  return typeof q === "string" ? q : "";
}
export async function readChunk(chunkId: string): Promise<string> {
  const { data } = await api<any>("GET", `/workbench/contract/chunks/${enc(chunkId)}/context?window=0`);
  const t = (data?.chunks ?? []).find((c: any) => c?.is_target) ?? data?.chunks?.[0];
  return typeof t?.content === "string" ? t.content : "";
}

// ── pure helpers ──
// the section of the text a citation sits in: the nearest heading above it ("" = before any heading); null = not in the text
export function sectionOf(body: string, referenceId: string): string | null {
  const id = referenceId.toLowerCase();
  const lower = body.toLowerCase();
  let at = lower.indexOf(`[@ref:${id}]`);
  const t = lower.indexOf(`{{ref:${id}}}`);
  if (at < 0 || (t >= 0 && t < at)) at = t;
  if (at < 0) return null;
  let heading = "";
  for (const line of body.slice(0, at).split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) heading = m[1];
  }
  return heading;
}

// why a write failed, in words (the server's own short sentence when it gave one for the caller's mistake)
export function why(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "That is not available any more: it may have been removed. The lists have been refreshed.";
    if (e.status >= 400 && e.status < 500 && e.message && e.message.length < 200 && !/^HTTP \d+$/.test(e.message)) return e.message;
  }
  return fallback;
}
