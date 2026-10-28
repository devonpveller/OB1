// A user document and its idea refinery (research-workbench P2b, D17 items 5-6, the ingestion
// model's held sources 2026-09-25 19:59-20:13).
//
//   start refinery    only for a document that carries an idea (frontmatter `idea:`); creates ONE
//                     ideas row (the idea's statement as its summary) whose single tethered document
//                     this is - no idea_revisions row: revisions are the MCP idea tools' (they carry
//                     the captured thought the memory-plane RLS binds), so the refinery engages when
//                     research is queued from the document, which joins it; a document whose
//                     refinery exists - archived or not - reopens it, never a second
//   archive / reopen  a document-level action that deletes nothing: the idea rests at `archived`
//                     (the previous status kept), the document is tagged "refinery archived" and
//                     stays editable; opening the refinery from the document reopens it and picks up
//                     the links added meanwhile
//   user sources      every user add lands HELD in an EXISTING refinery (the universal "+" names
//                     one; the contextual "+" on a document uses its refinery) and never creates one;
//                     a held source a document links cannot be removed - the trigger flags where in
//                     each document the user must resolve it and edits nothing; replace is
//                     type-conditional and moves only the replacing document's pin
//   research / gaps   queued from the writing surface; while the document is tethered the job joins
//                     the refinery (research_jobs.refinery_id) and stays an ordinary session
// Every operation acts for the identity the seam resolved, on that user's own document (owned()).
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { addHeld, type HeldInput, removeHeld, reviseHeld } from "../contracts/repo/ideas.ts";
import { placeReference } from "../contracts/repo/references.ts";
import { Conflict } from "../contracts/repo/lifecycle.ts";
import type { Identity } from "../middleware/identity.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { parseDocument } from "./grammar.ts";
import { listingRow, type OutboundLink, syncListing } from "./listing.ts";
import { DocError, ownedPath, readDocument } from "./repo.ts";
import { HOLDER_KIND } from "./paths.ts";

export interface RefineryDeps {
  db: Db;
  reg: RegistryReader;
  embed: (t: string) => Promise<number[]>;
  chunk: (t: string) => string[];
  // a link's new contents (replace on a held source with a URL); null when no fetch path is configured
  refetch: ((url: string) => Promise<{ title: string; content: string }>) | null;
  // the research service, with the workspace's own caller key (origin `workspace`, D17 item 1)
  research: ((body: Record<string, unknown>) => Promise<{ job_id: string }>) | null;
}

async function tetheredRefinery(db: Db, rel: string) {
  const row = await listingRow(db, rel);
  if (!row) throw new DocError("the document is not listed yet; save it first", 409);
  if (!row.refinery_id) return { row, refinery: null };
  const r = (await db.query<{ id: string; status: string; archived_at: string | null; archived_from: string | null }>(
    `SELECT i.id::text AS id, i.status, rs.archived_at, rs.archived_from
       FROM public.ideas i LEFT JOIN public.refinery_state rs ON rs.refinery_id = i.id WHERE i.id = $1`,
    [row.refinery_id],
  ))[0];
  return { row, refinery: r ?? null };
}

async function relist(deps: RefineryDeps, rel: string, who: Identity) {
  if (await vaultExists(rel)) return await syncListing(deps.db, deps.reg, rel, await vaultRead(rel), who, who.name);
  return null;
}

// ── start / archive / reopen ──────────────────────────────────────────────────────────────
export async function startRefinery(deps: RefineryDeps, path: string, who: Identity) {
  const doc = await readDocument(deps, path, who);
  const { row, refinery } = await tetheredRefinery(deps.db, doc.path);
  if (refinery) return { ...(await reopenRefinery(deps, doc.path, who)), started: false };
  const parsed = parseDocument(doc.content, doc.path);
  if (!parsed.idea) throw new DocError("add an idea to the document to get started", 422, { needs: "idea" });
  const id = await deps.db.tx(async (t) => {
    const ideaId = (await t.query<{ id: string }>(
      `INSERT INTO public.ideas (title, summary, status, created_by, metadata, owner_sub, actor_sub)
       VALUES ($1, $2, 'new', $3, jsonb_build_object('started_from', 'document', 'document_path', $4::text), $5, $6)
       RETURNING id::text AS id`,
      [parsed.title, parsed.idea, who.name, doc.path, who.sub, who.actor],
    ))[0].id;
    await t.query(
      `INSERT INTO public.refinery_state (refinery_id, origin_kind, origin_document_id) VALUES ($1, 'document', $2)`,
      [ideaId, row.id],
    );
    await t.query(`UPDATE public.user_document_listings SET refinery_id = $1 WHERE id = $2`, [ideaId, row.id]);
    return ideaId;
  });
  const listed = await relist(deps, doc.path, who);
  return { refinery_id: id, started: true, archived: false, picked: listed?.links.length ?? 0 };
}

export async function archiveRefinery(deps: RefineryDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  const { refinery } = await tetheredRefinery(deps.db, rel);
  if (!refinery) return { refinery_id: null, archived: false };
  if (refinery.archived_at) return { refinery_id: refinery.id, archived: true };
  await deps.db.tx(async (t) => {
    await t.query(
      `INSERT INTO public.refinery_state (refinery_id, archived_at, archived_from) VALUES ($1, now(), $2)
       ON CONFLICT (refinery_id) DO UPDATE SET archived_at = now(), archived_from = EXCLUDED.archived_from`,
      [refinery.id, refinery.status],
    );
    await t.query(`UPDATE public.ideas SET status = 'archived', updated_at = now() WHERE id = $1`, [refinery.id]);
  });
  return { refinery_id: refinery.id, archived: true };
}

export async function reopenRefinery(deps: RefineryDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  const { refinery } = await tetheredRefinery(deps.db, rel);
  if (!refinery) throw new DocError("this document has no refinery; start one", 404);
  if (refinery.archived_at) {
    await deps.db.tx(async (t) => {
      await t.query(`UPDATE public.refinery_state SET archived_at = NULL, archived_from = NULL WHERE refinery_id = $1`, [refinery.id]);
      await t.query(`UPDATE public.ideas SET status = $2, updated_at = now() WHERE id = $1`, [refinery.id, refinery.archived_from ?? "engaged"]);
    });
  }
  // pick up what the document linked while the refinery rested
  const listed = await relist(deps, rel, who);
  return { refinery_id: refinery.id, archived: false, reopened: !!refinery.archived_at, picked: listed?.links.length ?? 0 };
}

// ── user sources ──────────────────────────────────────────────────────────────────────────
async function refineryOfDocument(db: Db, rel: string): Promise<string> {
  const { refinery } = await tetheredRefinery(db, rel);
  if (!refinery) {
    throw new DocError("this document has no refinery: open the document's refinery first (a user source lands only in an existing refinery)", 409);
  }
  return refinery.id;
}

// The universal "+": the refinery must already exist; nothing here creates one.
export async function addUserSource(deps: RefineryDeps, refineryId: string, input: HeldInput, who: Identity) {
  const exists = (await deps.db.query(`SELECT 1 FROM public.ideas WHERE id = $1 AND owner_sub = $2`, [refineryId, who.sub])).length;
  if (!exists) throw new DocError("no such refinery (the universal + adds to an existing refinery only)", 404);
  return await addHeld(deps.db, refineryId, { ...input, by: who.name }, deps.chunk, deps.embed, { owner: who.sub });
}

// The contextual "+" on a document: the source is held in the document's refinery. A re-add that
// matched an existing held source with different contents revised it; the pin of THIS document's
// link moves to the new revision (pins are per document - another document keeps its own).
export async function addFromDocument(deps: RefineryDeps, path: string, input: HeldInput, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  const refineryId = await refineryOfDocument(deps.db, rel);
  const added = await addHeld(deps.db, refineryId, { ...input, by: who.name }, deps.chunk, deps.embed, { owner: who.sub }) as
    Awaited<ReturnType<typeof addHeld>> & { revised?: boolean; deduped?: boolean };
  const pinned = added.revised ? await repinLinkRecord(deps, rel, added.source.source_id, who) : null;
  if (pinned) await relist(deps, rel, who);
  return { ...added, refinery_id: refineryId, repinned: pinned ? { reference_id: pinned.id, revision: pinned.pinned_revision } : null };
}

export interface Flag {
  path: string;
  line: number;
  from: number;
  to: number;
  text: string;
  form: "link" | "chip" | "transclusion" | "added";
}

// Where each document that links a source does so - the clean-up trigger FLAGS these; the user
// resolves them by hand. Reads files and holder rows; writes nothing. The places are shown for the
// user's OWN documents; another user's documents are counted, never opened (their text is theirs).
export async function locateLinks(db: Db, sourceId: string, who: Identity) {
  const docs = await db.query<{ path: string; owner_sub: string }>(
    `SELECT d.ref AS path, l.owner_sub FROM public.source_dependence($1::uuid) d
       JOIN public.user_document_listings l ON l.path = d.ref
      WHERE d.kind = 'document_link' ORDER BY d.ref`,
    [sourceId],
  );
  const refs = new Set((await db.query<{ id: string }>(
    `SELECT id::text FROM public.reference_records WHERE source_id = $1`, [sourceId],
  )).map((r) => r.id));
  const mine: { path: string; flags: Flag[] }[] = [];
  for (const d of docs.filter((x) => x.owner_sub === who.sub)) {
    const content = (await vaultExists(d.path)) ? await vaultRead(d.path) : "";
    const p = parseDocument(content, d.path);
    const lineOf = (pos: number) => content.slice(0, pos).split("\n").length;
    const flags: Flag[] = [
      ...p.links.filter((l) => l.kind === "source" && l.id === sourceId).map((l) => ({ ...l, form: "link" as const })),
      ...p.chips.filter((c) => refs.has(c.reference_id)).map((c) => ({ ...c, form: "chip" as const })),
      ...p.transclusions.filter((t) => refs.has(t.reference_id)).map((t) => ({ ...t, form: "transclusion" as const })),
    ].map((f) => ({ path: d.path, line: lineOf(f.from), from: f.from, to: f.to, text: content.slice(f.from, f.to), form: f.form }));
    const added = await db.query<{ id: string }>(
      `SELECT h.reference_id::text AS id FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
        WHERE h.holder_kind = $1 AND h.holder_ref = $2 AND h.origin = 'added' AND r.source_id = $3`,
      [HOLDER_KIND, d.path, sourceId],
    );
    for (const a of added) flags.push({ path: d.path, line: 0, from: -1, to: -1, text: `added reference ${a.id}`, form: "added" });
    mine.push({ path: d.path, flags });
  }
  return { documents: mine, others: docs.filter((x) => x.owner_sub !== who.sub).length };
}

// Remove a held source: blocked while ANY user document links it (the flags say where in the
// user's own documents); never edits a document. When nothing links it, it goes outright (no
// tombstone - it was never folded in).
export async function removeUserSource(deps: RefineryDeps, refineryId: string, sourceId: string, who: Identity) {
  const found = await locateLinks(deps.db, sourceId, who);
  const linked = found.documents.filter((d) => d.flags.length);
  if (linked.length || found.others) {
    throw new DocError("a user document links this held source; resolve the flagged places in the document first", 409, {
      documents: linked, other_users_documents: found.others,
    });
  }
  try {
    return await removeHeld(deps.db, refineryId, sourceId, who.sub);
  } catch (e) {
    if (e instanceof Conflict) throw new DocError(e.message, 409, e.detail as Record<string, unknown>);
    throw e;
  }
}

interface HeldHead {
  id: string;
  refinery_id: string;
  url: string | null;
  title: string;
  revision: number;
  content_hash: string | null;
}

async function heldHead(db: Db, id: string): Promise<HeldHead | null> {
  return (await db.query<HeldHead>(
    `SELECT id::text AS id, refinery_id::text AS refinery_id, url, title, revision, content_hash FROM public.held_sources WHERE id = $1`,
    [id],
  ))[0] ?? null;
}

// Pins are per document: move THIS document's plain-link record for the source to the current
// revision (a new record; the old one goes when nothing holds it). Chips and transclusions keep
// their records - frozen, and flagged out of date by diffCheck. Other documents are not touched.
async function repinLinkRecord(deps: RefineryDeps, rel: string, sourceId: string, who: Identity) {
  return await deps.db.tx(async (t) => {
    const old = await t.query<{ hid: string; rid: string }>(
      `SELECT h.id::text AS hid, r.id::text AS rid FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
        WHERE h.holder_kind = $1 AND h.holder_ref = $2 AND h.origin = 'cited' AND r.scope = 'source' AND r.source_id = $3`,
      [HOLDER_KIND, rel, sourceId],
    );
    const content = (await vaultExists(rel)) ? await vaultRead(rel) : "";
    const doc = parseDocument(content, rel);
    const chipIds = new Set([...doc.chips, ...doc.transclusions].map((x) => x.reference_id));
    for (const o of old.filter((o) => !chipIds.has(o.rid))) {
      await t.query(`DELETE FROM public.reference_holders WHERE id = $1`, [o.hid]);
      await t.query(
        `DELETE FROM public.reference_records r WHERE r.id = $1 AND NOT EXISTS (SELECT 1 FROM public.reference_holders x WHERE x.reference_id = r.id)`,
        [o.rid],
      );
    }
    if (!doc.links.some((l) => l.kind === "source" && l.id === sourceId)) return null;
    const placed = await placeReference(t, deps.reg, {
      source_id: sourceId, holder: { kind: HOLDER_KIND, ref: rel, origin: "cited" }, by: who.name,
    });
    return placed.record;
  });
}

// Replace, type-conditional (operator 20:09):
//   a held LINK (it has a URL)  -> refetch; new contents make a new revision; this document's pin moves
//   an uploaded FILE (no URL)   -> the user supplies the replacement by hand; it becomes a NEW held
//                                  source (a new pin id) in the same refinery
export async function replaceUserSource(
  deps: RefineryDeps, path: string, sourceId: string, input: { title?: string; content?: string }, who: Identity,
) {
  const rel = await ownedPath(deps.db, path, who);
  const h = await heldHead(deps.db, sourceId);
  if (!h) throw new DocError("replace is offered for a held user source only (a folded source cannot be replaced yet)", 409);
  if (h.url) {
    if (!deps.refetch) throw new DocError("no fetch path is configured for a refetch", 503);
    const fresh = await deps.refetch(h.url).catch((e) => {
      throw new DocError(`the link could not be refetched: ${String((e as Error).message).slice(0, 120)}`, 502);
    });
    const same = (await deps.db.query<{ same: boolean }>(`SELECT md5($1) = $2 AS same`, [fresh.content, h.content_hash]))[0].same;
    const revision = same ? h.revision : await reviseHeld(deps.db, h.id, fresh.title || h.title, fresh.content, deps.chunk, deps.embed);
    const record = same ? null : await repinLinkRecord(deps, rel, h.id, who);
    await relist(deps, rel, who);
    return { kind: "link", source_id: h.id, revision, changed: !same, reference: record };
  }
  if (!input.content?.trim()) throw new DocError("an uploaded file is replaced by the user: give the new contents", 400);
  const added = await addHeld(deps.db, h.refinery_id, { title: input.title || h.title, content: input.content, by: who.name },
    deps.chunk, deps.embed, { dedupe: false, owner: who.sub }); // a replacement by hand is a new source, not a re-add
  return { kind: "file", source_id: added.source.source_id, replaces: h.id, revision: added.source.revision, new_pin_id: true };
}

// ── research from the writing surface ─────────────────────────────────────────────────────
export async function queueResearch(
  deps: RefineryDeps, path: string, input: { query: string; kind: "research" | "gap" }, who: Identity,
) {
  if (!deps.research) throw new DocError("the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)", 503);
  const rel = await ownedPath(deps.db, path, who);
  const { refinery } = await tetheredRefinery(deps.db, rel);
  const joined = refinery && !refinery.archived_at ? refinery.id : null;
  const body: Record<string, unknown> = {
    query: input.query,
    origin: "workspace",
    inlet_ref: joined ? { kind: "refinery", id: joined } : { kind: "document", id: rel },
    ...(input.kind === "gap" ? { gap_research: "preliminary" } : {}),
  };
  const r = await deps.research(body);
  // the text the user typed is theirs: kept owner-scoped; the contract shows it to its owner only
  await deps.db.query(
    `INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
    [r.job_id, who.sub, who.actor, input.query],
  );
  if (joined) {
    // the session joins the refinery (session -> refinery -> document); it stays an ordinary session
    await deps.db.query(`UPDATE public.research_jobs SET refinery_id = $2 WHERE id = $1 AND refinery_id IS NULL`, [r.job_id, joined]);
  }
  return { job_id: r.job_id, refinery_id: joined, kind: input.kind };
}

// ── which documents link a source (the reference panel's "see all citations of this source") ─
// The SAME lookup as D5's dependence count - source_dependence()'s document_link branch, i.e. the
// listing records' links - shown for the user's own documents (user documents are per user; the
// dependence count itself counts every user's). No source stores a link back to a document.
export async function citationsOf(db: Db, sourceId: string, who: Identity) {
  const rows = await db.query<{ path: string; title: string }>(
    `SELECT d.ref AS path, COALESCE(d.detail ->> 'title', '') AS title
       FROM public.source_dependence($1::uuid) d JOIN public.user_document_listings l ON l.path = d.ref
      WHERE d.kind = 'document_link' AND l.owner_sub = $2 ORDER BY d.ref`,
    [sourceId, who.sub],
  );
  return { source_id: sourceId, documents: rows };
}

export async function linksOf(db: Db, path: string, who: Identity): Promise<OutboundLink[]> {
  const rel = await ownedPath(db, path, who);
  const row = (await db.query<{ outbound_links: OutboundLink[] }>(
    `SELECT outbound_links FROM public.user_document_listings WHERE path = $1`, [rel],
  ))[0];
  return row?.outbound_links ?? [];
}
