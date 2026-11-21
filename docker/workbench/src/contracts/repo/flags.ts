// Flag for cleanup (research-workbench redesign, rwr-flags-api): the reads and writes over public.user_flags
// (init-flags.sql, slot 500).
//
// Per user (07-MULTI-USER): a flag is the flagger's own context. owner_sub is the identity seam's subject_sub,
// actor_sub who acted; every read filters by owner_sub = who.sub - except an admin's explicit scope=all read -
// and another user's flag by id is NOT FOUND, never forbidden (no existence leak: a refusal for another user's
// row is the same answer as a missing row). A flag changes NOTHING about the flagged item: this file never
// writes to sources, claims or reference_records, it only checks that the item exists (shared knowledge).
import type { Db } from "../db.ts";
import { type RegistryReader, requireRegistered, REGISTRY } from "../registry.ts";
import { BadRequest } from "../logic/scope.ts";
import { NotFound } from "./lifecycle.ts";
import type { Identity } from "../../middleware/identity.ts";
import { documentPathsIn, ownsDocumentPaths } from "../../documents/ownership.ts";

export interface FlagRow {
  id: string;
  item_kind: string;
  item_id: string;
  reason: string;
  note: string;
  from: { kind: string; ref: string };
  state: string;
  created_at: string;
  updated_at: string;
  flagged_by: string | null;
}

interface Raw {
  id: string;
  item_kind: string;
  item_id: string;
  reason: string;
  note: string;
  from_kind: string;
  from_ref: string;
  state: string;
  created_at: string;
  updated_at: string;
  owner_sub: string;
}
const COLS = `id, item_kind, item_id, reason, note, from_kind, from_ref, state, created_at, updated_at, owner_sub`;
const shape = (r: Raw, withOwner: boolean): FlagRow => ({
  id: r.id,
  item_kind: r.item_kind,
  item_id: r.item_id,
  reason: r.reason,
  note: r.note,
  from: { kind: r.from_kind, ref: r.from_ref },
  state: r.state,
  created_at: r.created_at,
  updated_at: r.updated_at,
  flagged_by: withOwner ? r.owner_sub : null,
});

// The shared table that holds each flaggable kind (a lookup, never a write).
const ITEM_TABLE: Record<string, string> = {
  source: "public.sources",
  claim: "public.claims",
  reference: "public.reference_records",
};

export interface FlagInput {
  item_kind: string;
  item_id: string;
  reason: string;
  note?: string;
  from: { kind: string; ref: string };
}

export async function createFlag(db: Db, reg: RegistryReader, who: Identity, b: FlagInput): Promise<FlagRow> {
  await requireRegistered(reg, REGISTRY.flagItemKinds, b.item_kind);
  await requireRegistered(reg, REGISTRY.flagReasons, b.reason);
  await requireRegistered(reg, REGISTRY.flagFromKinds, b.from.kind);
  const table = ITEM_TABLE[b.item_kind];
  if (!table) throw new BadRequest(`'${b.item_kind}' cannot be flagged`);
  await checkFrom(db, who, b.from);
  const found = await db.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = $1) AS ok`, [b.item_id]);
  if (!found[0]?.ok) throw new NotFound(`no such ${b.item_kind}`);
  const r = await db.query<Raw>(
    `INSERT INTO public.user_flags (owner_sub, actor_sub, item_kind, item_id, reason, note, from_kind, from_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [who.sub, who.actor, b.item_kind, b.item_id, b.reason, b.note ?? "", b.from.kind, b.from.ref],
  );
  return shape(r[0], false);
}

// Where the flag was made from must be the flagger's own: a document of theirs, or a source id.
async function checkFrom(db: Db, who: Identity, from: { kind: string; ref: string }) {
  if (from.kind === "document") {
    const paths = documentPathsIn(from.ref);
    if (paths.length !== 1 || paths[0] !== from.ref.replace(/\\/g, "/")) throw new BadRequest("from.ref must be a document path (documents/...)");
    if (!(await ownsDocumentPaths(db, paths, who))) throw new NotFound("no such document");
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(from.ref)) {
    throw new BadRequest("from.ref must be a source id");
  }
}

export interface ListOpts {
  limit: number;
  state?: string;
  itemKind?: string;
  all: boolean;
}

// The caller's own flags, newest first - or, for an admin's explicit scope=all, everyone's (with who flagged it).
export async function listFlags(db: Db, who: Identity, o: ListOpts) {
  const args: unknown[] = [];
  const where: string[] = [];
  if (!o.all) {
    args.push(who.sub);
    where.push(`owner_sub = $${args.length}`);
  }
  if (o.state) {
    args.push(o.state);
    where.push(`state = $${args.length}`);
  }
  if (o.itemKind) {
    args.push(o.itemKind);
    where.push(`item_kind = $${args.length}`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_flags ${w}`, args))[0].n;
  args.push(o.limit);
  const rows = await db.query<Raw>(`SELECT ${COLS} FROM public.user_flags ${w} ORDER BY created_at DESC, id LIMIT $${args.length}`, args);
  return { flags: rows.map((r) => shape(r, o.all)), total };
}

// One flag: the caller's own (or any, for an admin); another user's is not found.
export async function getFlag(db: Db, who: Identity, id: string, admin: boolean): Promise<FlagRow | null> {
  const r = await db.query<Raw>(
    `SELECT ${COLS} FROM public.user_flags WHERE id = $1 AND ($3 OR owner_sub = $2)`,
    [id, who.sub, admin],
  );
  return r[0] ? shape(r[0], admin && r[0].owner_sub !== who.sub) : null;
}

export interface FlagPatch {
  reason?: string;
  note?: string;
  state?: string;
}

// Only the flagger changes a flag (its reason, note, or taking it back); another user's is not found.
export async function updateFlag(db: Db, reg: RegistryReader, who: Identity, id: string, p: FlagPatch): Promise<FlagRow | null> {
  if (p.reason === undefined && p.note === undefined && p.state === undefined) throw new BadRequest("give reason, note or state");
  if (p.reason !== undefined) await requireRegistered(reg, REGISTRY.flagReasons, p.reason);
  if (p.state !== undefined) await requireRegistered(reg, REGISTRY.flagStates, p.state);
  const r = await db.query<Raw>(
    `UPDATE public.user_flags SET reason = COALESCE($3, reason), note = COALESCE($4, note), state = COALESCE($5, state), updated_at = now()
      WHERE id = $1 AND owner_sub = $2 RETURNING ${COLS}`,
    [id, who.sub, p.reason ?? null, p.note ?? null, p.state ?? null],
  );
  return r[0] ? shape(r[0], false) : null;
}
