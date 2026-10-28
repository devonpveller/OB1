// References as first-class records (research-workbench P2a): create and read reference rows,
// the holders that hold them by id, the legacy-note migration and reconcile,
// and diffCheck over pinned revisions.
//
// Invariants this module keeps:
//   - a reference row is written ONLY with a quote and a position selector (and page+quad where
//     the selector registry requires it); the database trigger refuses anything else, so the
//     rule holds for every writer;
//   - a pin is the source's current revision when the reference is placed, and never moves;
//   - diffCheck reads ids, revisions and chunk indexes - it never selects chunk text, and its
//     response carries none (P2a acceptance 4);
//   - nothing here reads or writes claims, claim_sources or reports (the grounding chain).
import type { Db } from "../db.ts";
import type { MetadataFilter } from "../logic/scope.ts";
import { BadRequest } from "../logic/scope.ts";
import type { RegistryReader } from "../registry.ts";
import { requireRegistered, REGISTRY } from "../registry.ts";
import { Conflict, NotFound } from "./lifecycle.ts";
import {
  anchorText, deriveWholeSourceSelectors, frontmatterSources, noteRefsCited, planLegacyHolders,
  requiredSelectorKinds,
} from "../logic/citations.ts";
import { getHeld, getSource, omitted, reference, sourceReference, tombstoneBySource, tombstoneOut } from "./sources.ts";

// The holder kind the legacy note routes use (a key of reference_holder_kinds).
export const LEGACY_NOTE = "legacy_note";

export interface RecordRow {
  id: string;
  source_id: string;
  scope: string;
  provenance: string;
  pinned_revision: number;
  chunk_idx: number | null;
  state: string;
  selectors: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

const RECORD_COLS = `r.id::text AS id, r.source_id::text AS source_id, r.scope, r.provenance, r.pinned_revision,
  r.chunk_idx, r.state, r.selectors, r.created_by, r.created_at`;

export async function getRecord(db: Db, id: string): Promise<RecordRow | null> {
  return (await db.query<RecordRow>(`SELECT ${RECORD_COLS} FROM public.reference_records r WHERE r.id = $1`, [id]))[0] ??
    null;
}

// ── reference(id): a reference record, or (P0) a source in any lifecycle state ────────────
// A record is read through its target at the PINNED revision, so the state says whether the
// source has moved on ('updated'). Records carry no metadata: under a metadata filter they are
// not returned at all (fail closed, as P0 does for every metadata-less kind).
export async function referenceById(
  db: Db,
  id: string,
  opts: { version: number | null; evidenceOnly: boolean; visible: Set<string>; filter: MetadataFilter },
) {
  const rec = await getRecord(db, id);
  if (!rec) return await reference(db, id, opts);
  if (opts.filter) return null;
  const base = {
    id: rec.id, kind: "reference", requested_version: rec.pinned_revision,
    source: null, tombstone: null, held: null, record: rec,
  };
  const s = await getSource(db, rec.source_id, null);
  if (s) {
    if (opts.evidenceOnly && !opts.visible.has(s.lifecycle)) return omitted({ ...base, record: null });
    // the filter is null here (a filtered caller returned above): records carry no metadata
    return await sourceReference(db, s, rec.pinned_revision, base, null);
  }
  const h = await getHeld(db, rec.source_id, null);
  if (h) {
    if (opts.evidenceOnly && !opts.visible.has("held")) return omitted({ ...base, record: null });
    return {
      ...base, state: h.revision > rec.pinned_revision ? "updated" : "held", lifecycle: "held", version: h.revision,
      state_detail: { refinery_id: h.refinery_id, scope: "refinery only until folded" },
      held: { refinery_id: h.refinery_id, title: h.title, url: h.url, excerpt: h.excerpt, user_source_status: h.status },
    };
  }
  if (opts.evidenceOnly) return omitted({ ...base, record: null });
  const t = await tombstoneBySource(db, rec.source_id);
  if (t) {
    return {
      ...base, state: "erased", lifecycle: "erased", version: null,
      state_detail: { reason_type: t.reason_type, note: t.note, url: t.url }, tombstone: tombstoneOut(t),
    };
  }
  return {
    ...base, state: "erased", lifecycle: null, version: null,
    state_detail: { reason: "the source no longer exists and left no tombstone (removed before P0)" },
  };
}

// ── targets: the current revision of a source and its text ────────────────────────────────
interface Target {
  id: string;
  in_sources: boolean;
  content_type: string;
  revision: number;
  text: string | null;
  title: string | null;
}

// Sources are matched on id::text = the id AS WRITTEN (case-sensitive), which is what the legacy
// readers did (they keyed the rows by id::text): an id in upper case resolved to nothing before
// P2a and resolves to nothing now. The text is the pinned revision's: the latest committed
// revision snapshot, or the head while a source has no revisions (revision 1).
async function sourceTargets(db: Db, ids: string[]): Promise<Map<string, Target>> {
  if (!ids.length) return new Map();
  const rows = await db.query<Target>(
    `SELECT s.id::text AS id, true AS in_sources, s.content_type, COALESCE(rv.revision, 1) AS revision,
            COALESCE(rv.content, s.content) AS text, COALESCE(NULLIF(rv.title, ''), s.title) AS title
       FROM public.sources s
       LEFT JOIN LATERAL (SELECT r.revision, r.content, r.title FROM public.source_revisions r
                           WHERE r.source_id = s.id ORDER BY r.revision DESC LIMIT 1) rv ON true
      WHERE s.id = ANY($1::uuid[]) AND s.id::text = ANY($2::text[])`,
    [ids, ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function anyTarget(db: Db, id: string): Promise<Target | null> {
  const s = (await sourceTargets(db, [id.toLowerCase()])).get(id.toLowerCase());
  if (s) return s;
  const h = await db.query<Target>(
    `SELECT h.id::text AS id, false AS in_sources, h.content_type, h.revision, h.content AS text, h.title
       FROM public.held_sources h WHERE h.id = $1`,
    [id],
  );
  return h[0] ?? null;
}

async function selectorEntries(db: Db) {
  return await db.query<{ key: string; definition: Record<string, unknown>; retired_at: string | null }>(
    `SELECT key, definition, retired_at FROM public.contract_registry_entries WHERE registry = 'reference_selector_kinds'`,
  );
}

async function chunkWithQuote(db: Db, target: Target, exact: string): Promise<number | null> {
  const table = target.in_sources ? "public.source_chunks" : "public.held_source_chunks";
  const key = target.in_sources ? "source_id" : "held_source_id";
  const rows = await db.query<{ idx: number }>(
    `SELECT idx FROM ${table} WHERE ${key} = $1 AND strpos(content, $2) > 0 ORDER BY idx LIMIT 1`,
    [target.id, exact],
  );
  return rows[0]?.idx ?? null;
}

async function firstChunk(db: Db, target: Target): Promise<number | null> {
  const table = target.in_sources ? "public.source_chunks" : "public.held_source_chunks";
  const key = target.in_sources ? "source_id" : "held_source_id";
  const rows = await db.query<{ idx: number | null }>(`SELECT min(idx) AS idx FROM ${table} WHERE ${key} = $1`, [target.id]);
  return rows[0]?.idx ?? null;
}

async function insertRecord(
  db: Db,
  r: { source_id: string; scope: string; selectors: Record<string, unknown>; provenance: string; pinned_revision: number; chunk_idx: number | null; by: string | null },
): Promise<RecordRow> {
  return (await db.query<RecordRow>(
    `INSERT INTO public.reference_records AS r (source_id, scope, selectors, provenance, pinned_revision, chunk_idx, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     RETURNING ${RECORD_COLS}`,
    [r.source_id, r.scope, JSON.stringify(r.selectors), r.provenance, r.pinned_revision, r.chunk_idx, r.by],
  ))[0];
}

// ── create (POST /references) ─────────────────────────────────────────────────────────────
export interface CreateInput {
  source_id: string;
  selectors: Record<string, unknown>;
  provenance: string;
  scope?: string;
  chunk_idx?: number;
  holder?: { kind: string; ref: string; origin?: string };
  by?: string;
}

export class SelectorRefused extends Error {}

export async function createReference(db: Db, reg: RegistryReader, input: CreateInput) {
  const scope = input.scope ?? "span";
  await requireRegistered(reg, REGISTRY.referenceProvenances, input.provenance);
  await requireRegistered(reg, REGISTRY.referenceScopes, scope);
  if (input.holder) {
    await requireRegistered(reg, REGISTRY.referenceHolderKinds, input.holder.kind);
    await requireRegistered(reg, REGISTRY.referenceOrigins, input.holder.origin ?? "added");
  }
  return await db.tx(async (t) => {
    const target = await anyTarget(t, input.source_id);
    if (!target) throw new NotFound("no source or held source with this id");
    // The quote must be what the position selects in the pinned revision.
    const quote = input.selectors.quote as { exact: string };
    const pos = input.selectors.position as { start: number; end: number; field?: string };
    const text = (pos.field === "title" ? target.title : target.text) ?? "";
    if (text.slice(pos.start, pos.end) !== quote.exact) {
      throw new SelectorRefused(
        `position ${pos.start}-${pos.end} does not select the quote in revision ${target.revision} of ${target.id}`,
      );
    }
    let chunkIdx: number | null = input.chunk_idx ?? null;
    if (chunkIdx !== null) {
      const table = target.in_sources ? "public.source_chunks" : "public.held_source_chunks";
      const key = target.in_sources ? "source_id" : "held_source_id";
      const hit = await t.query(`SELECT 1 FROM ${table} WHERE ${key} = $1 AND idx = $2`, [target.id, chunkIdx]);
      if (!hit.length) throw new NotFound(`no chunk ${chunkIdx} in ${target.id}`);
    } else {
      chunkIdx = scope === "source" ? await firstChunk(t, target) : await chunkWithQuote(t, target, quote.exact);
    }
    const record = await insertRecord(t, {
      source_id: target.id, scope, selectors: input.selectors, provenance: input.provenance,
      pinned_revision: target.revision, chunk_idx: chunkIdx, by: input.by ?? null,
    });
    let held = null;
    if (input.holder) {
      const h = input.holder;
      await lockHolder(t, h.kind, h.ref);
      const dup = await t.query(
        `SELECT 1 FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2 AND source_key = $3`,
        [h.kind, h.ref, target.id],
      );
      if (dup.length) throw new Conflict("this holder already holds a reference to that source", { holder: h, source_id: target.id });
      await t.query(
        `INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
         SELECT $1, $2, $3, $4, $5,
                COALESCE((SELECT max(seq) + 1 FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2), 0),
                COALESCE((SELECT max(number) + 1 FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2), 1)`,
        [h.kind, h.ref, record.id, target.id, h.origin ?? "added"],
      );
      held = (await heldRows(t, h.kind, h.ref)).find((x) => x.reference_id === record.id) ?? null;
    }
    return { record, held };
  });
}

// ── holders ──────────────────────────────────────────────────────────────────────────────
interface HeldRow {
  seq: number;
  number: number | null;
  origin: string;
  cited_ref: string;
  reference_id: string | null;
  source_id: string | null;
  pinned_revision: number | null;
  scope: string | null;
  provenance: string | null;
}

async function heldRows(db: Db, kind: string, ref: string): Promise<HeldRow[]> {
  return await db.query<HeldRow>(
    `SELECT h.seq, h.number, h.origin, h.cited_ref, h.reference_id::text AS reference_id,
            r.source_id::text AS source_id, r.pinned_revision, r.scope, r.provenance
       FROM public.reference_holders h LEFT JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = $1 AND h.holder_ref = $2 ORDER BY h.seq`,
    [kind, ref],
  );
}

interface StateRow {
  content_sha256: string | null;
  migrated_at: string;
  removed_at: string | null;
}

async function holderState(db: Db, kind: string, ref: string): Promise<StateRow | null> {
  return (await db.query<StateRow>(
    `SELECT content_sha256, migrated_at, removed_at FROM public.reference_holder_state WHERE holder_kind = $1 AND holder_ref = $2`,
    [kind, ref],
  ))[0] ?? null;
}

async function lockHolder(db: Db, kind: string, ref: string) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`reference-holder:${kind}:${ref}`]);
}

// GET /holders/{kind}/references - body-less: ids, pins and order, never selectors or text.
export async function holderReferences(db: Db, kind: string, ref: string) {
  const st = await holderState(db, kind, ref);
  const refs = await heldRows(db, kind, ref);
  if (!st && !refs.length) return null;
  return {
    holder_kind: kind, holder_ref: ref,
    state: st?.removed_at ? "erased" : "current",
    state_detail: st?.removed_at ? { reason: "the holder was removed; its references are kept for a recover", removed_at: st.removed_at } : {},
    migrated_at: st?.migrated_at ?? null,
    references: refs,
  };
}

// ── legacy notes: migrate on first touch, reconcile after ──────────────────────────────────
export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The migration refused a note: what the legacy reader listed and what the records would list
// differ, or the note carries an id the legacy reader could not resolve. Nothing was written.
export class MigrationRefused extends Conflict {}

interface ResolvedRow {
  id: string;
  title: string;
  url: string | null;
  content_type: string;
}

// The pre-P2a note-refs reading of a note, kept verbatim as the migration's BEFORE side: each
// list is resolved against public.sources on its own, an id that is not a uuid makes the SQL
// cast fail and the legacy code then returned an empty list (its `.catch(() => [])`), and rows
// are matched back by id::text. A savepoint keeps that failure from aborting the migration's
// transaction.
async function legacyNoteRefsView(db: Db, content: string): Promise<{ added: ResolvedRow[]; cited: ResolvedRow[] }> {
  const resolve = async (uuids: string[]) => {
    if (!uuids.length) return [];
    await db.query("SAVEPOINT legacy_note_refs");
    let rows: ResolvedRow[] = [];
    try {
      rows = await db.query<ResolvedRow>(
        `SELECT id::text AS id, title, url, content_type FROM public.sources WHERE id = ANY($1::uuid[])`,
        [uuids],
      );
      await db.query("RELEASE SAVEPOINT legacy_note_refs");
    } catch {
      await db.query("ROLLBACK TO SAVEPOINT legacy_note_refs");
      rows = [];
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return uuids.map((u) => byId.get(u)).filter(Boolean) as ResolvedRow[];
  };
  const added = frontmatterSources(content);
  return { added: await resolve(added), cited: await resolve(noteRefsCited(content, added)) };
}

// What note-refs lists AFTER P2a: the holder's references whose target is a source, in order.
export async function noteRefsView(db: Db, ref: string, kind = LEGACY_NOTE) {
  const rows = await db.query<ResolvedRow & { origin: string }>(
    `SELECT s.id::text AS id, s.title, s.url, s.content_type, h.origin
       FROM public.reference_holders h
       JOIN public.reference_records r ON r.id = h.reference_id
       JOIN public.sources s ON s.id = r.source_id
      WHERE h.holder_kind = $1 AND h.holder_ref = $2 ORDER BY h.seq`,
    [kind, ref],
  );
  const strip = ({ origin: _o, ...r }: ResolvedRow & { origin: string }) => r;
  return {
    added: rows.filter((r) => r.origin === "added").map(strip),
    cited: rows.filter((r) => r.origin !== "added").map(strip),
  };
}

export interface SyncOptions {
  addAdded?: string;
  removeAdded?: string;
  onlyIfUnmigrated?: boolean; // the batch migration: skip notes already migrated
  dryRun?: boolean; // compute and check, then roll back
  by?: string;
}

export interface SyncReport {
  path: string;
  migrated: boolean; // true = this call was the note's first touch
  skipped?: boolean;
  before?: { added: number; cited: number; total: number };
  after: { added: number; cited: number; total: number; unresolved: number };
  references_created: number;
}

class DryRun extends Error {
  constructor(public report: SyncReport) {
    super("dry run");
  }
}

// One note, one transaction: the holder rows are rebuilt from the file (cited links) and from
// the holder's own added list (the frontmatter `sources:` on the first touch only - after the
// migration the record is the added list's home). Existing pins are kept by id; a new id is
// pinned at its source's current revision. On the first touch the result must list exactly what
// the legacy reader listed, or the note is refused and nothing is written.
export async function syncLegacyNote(db: Db, rel: string, content: string, opts: SyncOptions = {}): Promise<SyncReport> {
  try {
    return await db.tx(async (t) => {
      await lockHolder(t, LEGACY_NOTE, rel);
      const st = await holderState(t, LEGACY_NOTE, rel);
      if (st && opts.onlyIfUnmigrated) {
        const v = await noteRefsView(t, rel);
        return {
          path: rel, migrated: false, skipped: true, references_created: 0,
          after: { added: v.added.length, cited: v.cited.length, total: v.added.length + v.cited.length, unresolved: 0 },
        };
      }
      const firstTouch = !st;
      const old = await heldRows(t, LEGACY_NOTE, rel);
      let added = firstTouch ? frontmatterSources(content) : old.filter((h) => h.origin === "added").map((h) => h.cited_ref);
      if (opts.addAdded && !added.includes(opts.addAdded)) added = [...added, opts.addAdded];
      if (opts.removeAdded) added = added.filter((u) => u !== opts.removeAdded);
      const plan = planLegacyHolders(content, added);
      if (firstTouch && plan.unstorable.length) {
        throw new MigrationRefused("the note cites ids that are not uuids; the legacy reader could not resolve them", {
          path: rel, ids: plan.unstorable,
        });
      }
      const before = firstTouch ? await legacyNoteRefsView(t, content) : null;

      const keep = new Map(old.filter((h) => h.reference_id).map((h) => [h.cited_ref, h.reference_id!]));
      const targets = await sourceTargets(t, plan.holders.filter((h) => !keep.has(h.cited_ref)).map((h) => h.cited_ref));
      const kinds = await selectorEntries(t);
      await t.query(`DELETE FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2`, [LEGACY_NOTE, rel]);
      let created = 0;
      let unresolved = 0;
      for (const h of plan.holders) {
        let refId = keep.get(h.cited_ref) ?? null;
        const target = targets.get(h.cited_ref);
        if (!refId && target) {
          const a = anchorText(target.text, target.title);
          if (!a) {
            throw new MigrationRefused("a cited source has neither text nor title to anchor a quote in", {
              path: rel, source_id: target.id,
            });
          }
          const rec = await insertRecord(t, {
            source_id: target.id, scope: "source",
            selectors: deriveWholeSourceSelectors(a, requiredSelectorKinds(kinds, target.content_type)),
            provenance: "user", pinned_revision: target.revision, chunk_idx: await firstChunk(t, target),
            by: opts.by ?? (firstTouch ? "migration" : "reconcile"),
          });
          refId = rec.id;
          created++;
        }
        if (!refId) unresolved++;
        await t.query(
          `INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [LEGACY_NOTE, rel, refId, h.cited_ref, h.origin, h.seq, h.number],
        );
      }
      // A reference this note no longer holds is held by nothing (pins are per holder): remove it.
      const dropped = old.map((h) => h.reference_id).filter((id): id is string => !!id && !plan.holders.some((p) => keep.get(p.cited_ref) === id));
      if (dropped.length) {
        await t.query(
          `DELETE FROM public.reference_records r WHERE r.id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM public.reference_holders h WHERE h.reference_id = r.id)`,
          [dropped],
        );
      }
      const after = await noteRefsView(t, rel);
      const report: SyncReport = {
        path: rel, migrated: firstTouch, references_created: created,
        after: { added: after.added.length, cited: after.cited.length, total: after.added.length + after.cited.length, unresolved },
      };
      if (before) {
        report.before = { added: before.added.length, cited: before.cited.length, total: before.added.length + before.cited.length };
        const ids = (rows: ResolvedRow[]) => rows.map((r) => r.id).join(",");
        if (ids(before.added) !== ids(after.added) || ids(before.cited) !== ids(after.cited)) {
          throw new MigrationRefused("the note's references differ before and after the migration", {
            path: rel, before: { added: before.added.map((r) => r.id), cited: before.cited.map((r) => r.id) },
            after: { added: after.added.map((r) => r.id), cited: after.cited.map((r) => r.id) },
          });
        }
      }
      await t.query(
        `INSERT INTO public.reference_holder_state (holder_kind, holder_ref, content_sha256, migration)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (holder_kind, holder_ref) DO UPDATE
            SET content_sha256 = EXCLUDED.content_sha256, reconciled_at = now(), removed_at = NULL`,
        [LEGACY_NOTE, rel, await sha256(content), JSON.stringify(firstTouch ? { before: report.before, after: report.after } : {})],
      );
      if (opts.dryRun) throw new DryRun(report);
      return report;
    });
  } catch (e) {
    if (e instanceof DryRun) return e.report;
    throw e;
  }
}

// The GET paths (note-refs, export) read the table; when the file changed outside the workbench
// since the last reconcile (or the note was never touched), they reconcile first.
export async function ensureLegacyNote(db: Db, rel: string, content: string): Promise<void> {
  const st = await holderState(db, LEGACY_NOTE, rel);
  if (st && !st.removed_at && st.content_sha256 === await sha256(content)) return;
  await syncLegacyNote(db, rel, content);
}

// A note moved: its references move with it (pins kept).
export async function moveHolder(db: Db, from: string, to: string, kind = LEGACY_NOTE): Promise<void> {
  await db.tx(async (t) => {
    await lockHolder(t, kind, from);
    await t.query(`UPDATE public.reference_holders SET holder_ref = $3 WHERE holder_kind = $1 AND holder_ref = $2`, [kind, from, to]);
    await t.query(`UPDATE public.reference_holder_state SET holder_ref = $3 WHERE holder_kind = $1 AND holder_ref = $2`, [kind, from, to]);
  });
}

// A note was hard-removed (empty trash): it no longer counts as a dependence; a recover finds its
// references (and their pins) where it left them.
export async function markHolderRemoved(db: Db, ref: string, kind = LEGACY_NOTE): Promise<void> {
  await db.query(
    `UPDATE public.reference_holder_state SET removed_at = now() WHERE holder_kind = $1 AND holder_ref = $2`,
    [kind, ref],
  );
}

// ── placing a reference from a quote (research-workbench P2b) ─────────────────────────────
// The workspace places references by what the user selected (a quote in a chunk), or for the
// source as a whole (a link placed in a document). The position is found in the CURRENT revision's
// text - the revision the new record pins - and the record goes through createReference, so the
// selector rule, the registry checks and the holder bookkeeping are the ones every writer uses.
export interface PlaceInput {
  source_id: string;
  exact?: string | null; // absent: the whole source (scope source)
  near_chunk?: number | null; // where the user selected it (the first occurrence at or after it wins)
  holder: { kind: string; ref: string; origin?: string };
  provenance?: string;
  by?: string;
}

export async function placeReference(db: Db, reg: RegistryReader, input: PlaceInput) {
  const target = await anyTarget(db, input.source_id);
  if (!target) throw new NotFound("no source or held source with this id");
  const required = requiredSelectorKinds(await selectorEntries(db), target.content_type);
  const exact = (input.exact ?? "").trim() ? input.exact! : null;
  let selectors: Record<string, unknown>;
  let scope = "span";
  if (!exact) {
    const a = anchorText(target.text, target.title);
    if (!a) throw new SelectorRefused("the source has neither text nor title to anchor a quote in");
    selectors = deriveWholeSourceSelectors(a, required);
    scope = "source";
  } else {
    const text = target.text ?? "";
    const start = await quoteStart(db, target, text, exact, input.near_chunk ?? null);
    if (start < 0) throw new SelectorRefused(`the quote is not in revision ${target.revision} of ${target.id}`);
    const end = start + exact.length;
    selectors = {
      quote: { exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) },
      position: { start, end },
    };
    // a span on a PDF without page geometry anchors to its first page as a whole (as the whole-source
    // deriver does); the quote and position carry the precise anchor
    if (required.includes("pdf")) selectors.pdf = { page: 1, quads: [[0, 0, 1, 0, 1, 1, 0, 1]] };
  }
  return await createReference(db, reg, {
    source_id: target.id, selectors, provenance: input.provenance ?? "user", scope,
    holder: input.holder, by: input.by,
  });
}

// The offset of the quote in the revision text: the first occurrence at or after the chunk the
// user selected it in (chunk text is a slice of the revision text), else the first anywhere.
async function quoteStart(db: Db, target: Target, text: string, exact: string, nearChunk: number | null) {
  if (nearChunk !== null) {
    const table = target.in_sources ? "public.source_chunks" : "public.held_source_chunks";
    const key = target.in_sources ? "source_id" : "held_source_id";
    const c = (await db.query<{ content: string }>(`SELECT content FROM ${table} WHERE ${key} = $1 AND idx = $2`, [target.id, nearChunk]))[0];
    if (c) {
      const chunkAt = text.indexOf(c.content);
      if (chunkAt >= 0) {
        const at = text.indexOf(exact, chunkAt);
        if (at >= 0) return at;
      }
    }
  }
  return text.indexOf(exact);
}

// The id, revision and content type of a source or held source - no text (the documents API checks
// a link target exists before it pins it).
export async function targetHead(db: Db, id: string) {
  const t = await anyTarget(db, id);
  return t ? { id: t.id, in_sources: t.in_sources, revision: t.revision, content_type: t.content_type, title: t.title } : null;
}

// ── export ───────────────────────────────────────────────────────────────────────────────
// The export (research-workbench P6a, src/export/repo.ts) reads a legacy note's numbered references
// from its holder rows and renders them through pandoc --citeproc; the plain References list that
// was rendered here is retired.

// ── diffCheck ────────────────────────────────────────────────────────────────────────────
export interface DiffCheckInput {
  references?: { reference_id?: string; source_id?: string; revision?: number; chunk_idx?: number }[];
  holder?: { kind: string; ref: string };
}

interface DiffRow {
  ord: number;
  reference_id: string | null;
  source_id: string;
  pinned_revision: number;
  chunk_idx: number | null;
  visible: boolean;
  current_revision: number | null;
  lifecycle: string | null;
  chunk_exists: boolean;
  reanchor: string | null;
  moved_idx: number | null;
}

// The target columns every diffCheck query shares: current revision, lifecycle, and whether the
// pinned chunk exists - ids and integers only. `$X` placeholders: the row's source id and chunk.
const TARGET_COLS = (sid: string, idx: string) => `
  CASE WHEN s.id IS NOT NULL THEN COALESCE((SELECT max(sr.revision) FROM public.source_revisions sr WHERE sr.source_id = s.id), 1)
       WHEN h.id IS NOT NULL THEN h.revision END AS current_revision,
  CASE WHEN s.id IS NOT NULL THEN public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at)
       WHEN h.id IS NOT NULL THEN 'held'
       WHEN EXISTS (SELECT 1 FROM public.source_tombstones t WHERE t.source_id = ${sid}) THEN 'erased' END AS lifecycle,
  CASE WHEN ${idx} IS NULL THEN false
       WHEN s.id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.source_chunks c WHERE c.source_id = s.id AND c.idx = ${idx})
       WHEN h.id IS NOT NULL THEN EXISTS (SELECT 1 FROM public.held_source_chunks c WHERE c.held_source_id = h.id AND c.idx = ${idx})
       ELSE false END AS chunk_exists`;

// Under a filter only a SOURCE whose metadata contains it is visible: a held source is out of scope
// whatever its own metadata says (it belongs to a refinery, which carries no metadata - P0's getHeld
// rule, rw-p0-contract2 attempt 2), and an erased or unknown id is omitted.
async function diffBarePins(db: Db, refs: { source_id: string; revision: number; chunk_idx?: number }[], f: MetadataFilter) {
  return await db.query<DiffRow>(
    `SELECT q.ord::int AS ord, NULL::text AS reference_id, q.source_id::text AS source_id, q.revision AS pinned_revision,
            q.chunk_idx, ($4::jsonb IS NULL OR COALESCE(s.metadata @> $4::jsonb, false)) AS visible,
            NULL::text AS reanchor, NULL::int AS moved_idx, ${TARGET_COLS("q.source_id", "q.chunk_idx")}
       FROM unnest($1::uuid[], $2::int[], $3::int[]) WITH ORDINALITY AS q(source_id, revision, chunk_idx, ord)
       LEFT JOIN public.sources s ON s.id = q.source_id
       LEFT JOIN public.held_sources h ON h.id = q.source_id AND s.id IS NULL
      ORDER BY q.ord`,
    [refs.map((r) => r.source_id), refs.map((r) => r.revision), refs.map((r) => r.chunk_idx ?? null), f ? JSON.stringify(f) : null],
  );
}

// For an out-of-date pin, the scope's reanchor rule (registry reference_scopes) finds the chunk
// of the current revision that stands for it - INSIDE the database: strpos over the current
// chunks returns an index, never the text.
async function diffRecords(db: Db, ids: string[]) {
  return await db.query<DiffRow>(
    `SELECT q.ord::int AS ord, rr.id::text AS reference_id, rr.source_id::text AS source_id, rr.pinned_revision,
            rr.chunk_idx, true AS visible, COALESCE(sc.definition ->> 'reanchor', 'quote') AS reanchor,
            ${TARGET_COLS("rr.source_id", "rr.chunk_idx")},
            mv.moved_idx
       FROM unnest($1::uuid[]) WITH ORDINALITY AS q(id, ord)
       JOIN public.reference_records rr ON rr.id = q.id
       LEFT JOIN public.sources s ON s.id = rr.source_id
       LEFT JOIN public.held_sources h ON h.id = rr.source_id AND s.id IS NULL
       LEFT JOIN public.contract_registry_entries sc ON sc.registry = 'reference_scopes' AND sc.key = rr.scope
       LEFT JOIN LATERAL (
         SELECT CASE WHEN s.id IS NOT NULL THEN COALESCE((SELECT max(sr.revision) FROM public.source_revisions sr WHERE sr.source_id = s.id), 1)
                     WHEN h.id IS NOT NULL THEN h.revision END AS cur) c ON true
       LEFT JOIN LATERAL (
         SELECT CASE
           WHEN c.cur IS NULL OR c.cur <= rr.pinned_revision THEN NULL
           WHEN COALESCE(sc.definition ->> 'reanchor', 'quote') = 'first_chunk' THEN
             COALESCE((SELECT min(x.idx) FROM public.source_chunks x WHERE x.source_id = s.id),
                      (SELECT min(x.idx) FROM public.held_source_chunks x WHERE x.held_source_id = h.id))
           WHEN COALESCE(sc.definition ->> 'reanchor', 'quote') = 'quote' THEN
             COALESCE((SELECT x.idx FROM public.source_chunks x WHERE x.source_id = s.id
                         AND strpos(x.content, rr.selectors #>> '{quote,exact}') > 0 ORDER BY x.idx LIMIT 1),
                      (SELECT x.idx FROM public.held_source_chunks x WHERE x.held_source_id = h.id
                         AND strpos(x.content, rr.selectors #>> '{quote,exact}') > 0 ORDER BY x.idx LIMIT 1))
         END AS moved_idx) mv ON true
      ORDER BY q.ord`,
    [ids],
  );
}

function result(r: DiffRow) {
  if (!r.visible) {
    return {
      reference_id: r.reference_id, source_id: r.source_id, pinned_revision: r.pinned_revision, current_revision: null,
      out_of_date: false, chunk_idx: r.chunk_idx, equivalent_current_chunk_id: null, anchor: "omitted",
      state: "omitted", lifecycle: null,
    };
  }
  const outOfDate = r.current_revision !== null && r.pinned_revision < r.current_revision;
  let equivalent: string | null = null;
  let anchor = "none";
  if (r.current_revision === null) anchor = "none";
  else if (r.reference_id === null) {
    // a bare pin (P0's form): the same index when it exists
    if (r.chunk_idx !== null && r.chunk_exists) [equivalent, anchor] = [`${r.source_id}:${r.chunk_idx}`, "same_idx"];
  } else if (!outOfDate) {
    if (r.chunk_idx !== null) {
      [equivalent, anchor] = r.chunk_exists ? [`${r.source_id}:${r.chunk_idx}`, "pinned"] : [null, "lost"];
    }
  } else if (r.moved_idx !== null) {
    [equivalent, anchor] = [`${r.source_id}:${r.moved_idx}`, r.reanchor === "first_chunk" ? "first_chunk" : "requoted"];
  } else anchor = "lost";
  return {
    reference_id: r.reference_id, source_id: r.source_id, pinned_revision: r.pinned_revision,
    current_revision: r.current_revision, out_of_date: outOfDate, chunk_idx: r.chunk_idx,
    equivalent_current_chunk_id: equivalent, anchor,
    state: r.lifecycle === null ? "erased" : outOfDate ? "updated" : "current",
    lifecycle: r.lifecycle,
  };
}

// diffCheck(references | holder). A metadata filter (the cloud door) fails closed for reference
// records and holders, which carry no metadata; a bare pin is answered only for a source (never a
// held source) whose metadata contains the filter.
export async function diffCheck(db: Db, input: DiffCheckInput, f: MetadataFilter) {
  if (input.holder) {
    if (f) return { results: [] };
    const ids = (await db.query<{ id: string }>(
      `SELECT reference_id::text AS id FROM public.reference_holders
        WHERE holder_kind = $1 AND holder_ref = $2 AND reference_id IS NOT NULL ORDER BY seq`,
      [input.holder.kind, input.holder.ref],
    )).map((r) => r.id);
    return { results: (await diffRecords(db, ids)).map(result) };
  }
  const refs = input.references ?? [];
  if (!refs.length) throw new BadRequest("give references or holder");
  const recIdx = refs.flatMap((r, i) => (r.reference_id ? [i] : []));
  const pinIdx = refs.flatMap((r, i) => (r.reference_id ? [] : [i]));
  const out: unknown[] = new Array(refs.length);
  if (recIdx.length) {
    const ids = recIdx.map((i) => refs[i].reference_id!);
    // records carry no metadata: under a filter they do not exist for the caller (fail closed,
    // as GET /references/{id} answers 404)
    if (f) throw new NotFound(`no reference record with id ${ids.join(", ")}`);
    const rows = await diffRecords(db, ids);
    const found = new Map(rows.map((r) => [r.reference_id!, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFound(`no reference record with id ${missing.join(", ")}`);
    recIdx.forEach((i) => out[i] = result(found.get(refs[i].reference_id!)!));
  }
  if (pinIdx.length) {
    const pins = pinIdx.map((i) => refs[i] as { source_id: string; revision: number; chunk_idx?: number });
    const rows = await diffBarePins(db, pins, f);
    rows.forEach((r, k) => out[pinIdx[k]] = result(r));
  }
  return { results: out };
}

