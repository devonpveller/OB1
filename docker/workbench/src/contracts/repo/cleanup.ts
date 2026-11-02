// The cleanup view's reads and writes (research-workbench P8a, rw-p8a2-cleanup; D5 items 5-7).
//
// Shared vs per user (07-MULTI-USER): sources, their dependence, their trail and the tombstones are
// shared knowledge, read alike by every user. WHO took a cleanup action is the user's own context:
// it lives only in public.cleanup_actions (owner_sub = the identity seam's subject_sub, actor_sub who
// acted), and every shared row an action writes names the action (cleanup-action:<id>), never a
// subject. Another user's action by id is not found. A reopen candidate's evidence (the admission
// attempts: door, session id, the door's note, the score) is shared knowledge, exactly as the trail and
// GET /tombstones/{id} carry it: the research doors write a fixed note and a job id (job ids are shared),
// never a user's original prompt.
//
// The writes go through the D5 single-source writes in repo/lifecycle.ts (sever, erase, lift), so
// every gate there holds here unchanged: sever needs a suppressed source, erase an unlinked one with
// zero blocking connections, an unregistered reason type is refused.
import type { Db } from "../db.ts";
import { kindDefs } from "../logic/dependence.ts";
import { ACTION_REF, type CandidateAttempt, candidateOf, eraseOffered, fullCounts, tallyCounts } from "../logic/cleanup.ts";
import { type RegistryReader, requireRegistered, REGISTRY } from "../registry.ts";
import { Conflict, erase, liftTombstoneAs, NotFound, sever } from "./lifecycle.ts";
import type { Identity } from "../../middleware/identity.ts";

interface ListedRow {
  id: string;
  title: string;
  url: string | null;
  lifecycle: string;
  reason: string | null;
  suppressed_at: string;
  unlinked_at: string | null;
  counts: Record<string, number>;
}

// Every suppressed and unlinked source with its dependence counts (D5 item 5), newest first.
export async function listSources(db: Db, reg: RegistryReader, limit: number) {
  const defs = kindDefs(await reg.entries("dependence_kinds"));
  const rows = await db.query<ListedRow>(
    `SELECT s.id, s.title, s.url,
            public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) AS lifecycle,
            s.suppression_reason AS reason, s.retraction_committed_at AS suppressed_at, s.unlinked_at,
            COALESCE((SELECT jsonb_object_agg(x.kind, x.n)
                        FROM (SELECT d.kind, count(*)::int AS n FROM public.source_dependence(s.id) d GROUP BY d.kind) x),
                     '{}'::jsonb) AS counts
       FROM public.sources s
      WHERE s.retraction_committed_at IS NOT NULL
      ORDER BY s.retraction_committed_at DESC, s.id
      LIMIT $1`,
    [limit],
  );
  const total = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.sources WHERE retraction_committed_at IS NOT NULL`,
  ))[0].n;
  return {
    total,
    sources: rows.map((r) => {
      const t = tallyCounts(fullCounts(r.counts ?? {}), defs);
      return { ...r, ...t, erase_allowed: eraseOffered(r.lifecycle, t.blocking) };
    }),
  };
}

// ── the action log (per user) ─────────────────────────────────────────────────────────────────
interface ActionRow {
  id: string;
  kind: string;
  reason_type: string | null;
  source_id: string | null;
  tombstone_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}
const ACTION_COLS = `id, kind, reason_type, source_id, tombstone_id, detail, created_at, finished_at`;

async function record(
  db: Db, who: Identity, id: string, kind: string,
  f: { reason_type?: string | null; source_id?: string | null; tombstone_id?: string | null; detail?: Record<string, unknown>; finished?: boolean },
): Promise<ActionRow> {
  return (await db.query<ActionRow>(
    `INSERT INTO public.cleanup_actions (id, owner_sub, actor_sub, kind, reason_type, source_id, tombstone_id, detail, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $9 THEN now() END)
     RETURNING ${ACTION_COLS}`,
    [id, who.sub, who.actor, kind, f.reason_type ?? null, f.source_id ?? null, f.tombstone_id ?? null,
      JSON.stringify(f.detail ?? {}), f.finished !== false],
  ))[0];
}

export async function actions(db: Db, who: Identity, limit: number) {
  return {
    actions: await db.query<ActionRow>(
      `SELECT ${ACTION_COLS} FROM public.cleanup_actions WHERE owner_sub = $1 ORDER BY created_at DESC, id LIMIT $2`,
      [who.sub, limit],
    ),
  };
}

// The caller's own action, or null - another user's action is not found (never 403: no existence leak).
export async function action(db: Db, who: Identity, id: string) {
  return (await db.query<ActionRow>(
    `SELECT ${ACTION_COLS} FROM public.cleanup_actions WHERE id = $1 AND owner_sub = $2`,
    [id, who.sub],
  ))[0] ?? null;
}

// ── writes ─────────────────────────────────────────────────────────────────────────────────────
// Round 3 (reviewer RF1): each write and its action record are ONE transaction, so an action that cannot be
// recorded rolls the sever / erase back (both are irreversible). sever() and erase() run their own tx(), which
// nests into this one (db.ts: a nested tx reuses the open transaction).
export async function severFor(db: Db, reg: RegistryReader, who: Identity, sourceId: string, req: { kind?: string; ref?: string; all?: boolean }) {
  return await db.tx(async (t) => {
    const id = crypto.randomUUID();
    const r = await sever(t, reg, sourceId, { ...req, by: ACTION_REF(id) });
    const a = await record(t, who, id, "sever", {
      source_id: sourceId, detail: { all: !!req.all, severed: r.severed.length, lifecycle: r.lifecycle, blocking: r.blocking },
    });
    return { action: a, severed: r.severed, rescored_claims: r.rescored_claims, pending_compile: r.pending_compile, lifecycle: r.lifecycle, blocking: r.blocking };
  });
}

// Round 3 (operator decision 2026-11-02, with rw-p8a1-core): a user's erasure records the identity seam's
// subject as eraser_user - the lift rule (logic/lift.ts) reads it. Reads name it only to that user
// (routes/actor_mask.ts).
export async function eraseFor(db: Db, reg: RegistryReader, who: Identity, sourceId: string, req: { reason_type: string; note?: string }) {
  await requireRegistered(reg, REGISTRY.erasureReasons, req.reason_type);
  const note = req.note?.trim() ? req.note.trim() : undefined;
  return await db.tx(async (t) => {
    const id = crypto.randomUUID();
    const r = await erase(t, reg, sourceId, { reason_type: req.reason_type, note, eraser: { kind: "user", user: who.sub } });
    const a = await record(t, who, id, "erase", { reason_type: req.reason_type, source_id: sourceId, tombstone_id: r.tombstone.id });
    return { action: a, tombstone_id: r.tombstone.id, reason_type: r.tombstone.reason_type, note: r.tombstone.note };
  });
}

// The cleanup view's lift (round 3): the operator's rule through rw-p8a1-core's liftTombstoneAs - the eraser or an
// admin, anyone else 403 (the request's `by` is ignored, as on the trail's lift). Round 2 (tester N3): a tombstone
// already lifted is a 409 with no action. One transaction that locks the tombstone row first, so two lifts at once
// give one action and one 409; liftTombstoneAs runs before the 409 so a caller who may not lift gets its 403.
export async function liftFor(db: Db, who: Identity, tombstoneId: string, note: string | undefined) {
  return await db.tx(async (t) => {
    const cur = (await t.query<{ id: string; lifted_at: string | null }>(
      `SELECT id, lifted_at FROM public.source_tombstones WHERE id = $1 FOR UPDATE`, [tombstoneId],
    ))[0];
    if (!cur) throw new NotFound("tombstone not found");
    const id = crypto.randomUUID();
    const tb = await liftTombstoneAs(t, tombstoneId, who, ACTION_REF(id), note?.trim() ? note.trim() : null);
    if (cur.lifted_at) throw new Conflict("the tombstone is already lifted", { lifted_at: cur.lifted_at });
    const a = await record(t, who, id, "lift", { tombstone_id: tombstoneId });
    return { action: a, tombstone_id: tombstoneId, lifted_at: tb.lifted_at };
  });
}

// D5 items 4-5: the process over everything marked. ONE reason type for the batch, no note; each
// source: sever every severable connection (a suppressed one), then erase it if that left it unlinked
// with zero blocking connections. A source the sever tool cannot clear (a user document links it, a
// reference holds it) is left for its owner and reported `blocked`. Each tombstone records the run
// (batch_run_id = cleanup-action:<id>).
export async function processAll(db: Db, reg: RegistryReader, who: Identity, reasonType: string, sourceIds: string[]) {
  await requireRegistered(reg, REGISTRY.erasureReasons, reasonType);
  const ids = [...new Set(sourceIds.map((s) => s.toLowerCase()))];
  const id = crypto.randomUUID();
  const run = ACTION_REF(id);
  await record(db, who, id, "process_all", { reason_type: reasonType, detail: { sources: ids.length }, finished: false });
  const items = [];
  for (const sid of ids) {
    const item = { source_id: sid, outcome: "skipped", severed: 0, blocking: 0, tombstone_id: null as string | null, detail: null as string | null };
    try {
      const life = (await db.query<{ lifecycle: string }>(
        `SELECT public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle FROM public.sources WHERE id = $1`,
        [sid],
      ))[0]?.lifecycle ?? null;
      if (life !== "suppressed" && life !== "unlinked") {
        item.detail = life ? `the source is ${life}, not suppressed or unlinked` : "no source with this id";
        items.push(item);
        continue;
      }
      let blocking = 0;
      if (life === "suppressed") {
        const s = await sever(db, reg, sid, { all: true, by: run });
        item.severed = s.severed.length;
        blocking = s.blocking;
        if (s.lifecycle !== "unlinked" || blocking !== 0) {
          item.outcome = "blocked";
          item.blocking = blocking;
          item.detail = `${blocking} connection(s) the sever tool cannot remove`;
          items.push(item);
          continue;
        }
      }
      const e = await erase(db, reg, sid, { reason_type: reasonType, batch_run_id: run, eraser: { kind: "user", user: who.sub } });
      item.outcome = "erased";
      item.tombstone_id = e.tombstone.id;
    } catch (err) {
      if (err instanceof Conflict) {
        item.outcome = "blocked";
        item.blocking = Number((err.detail as { blocking?: number }).blocking ?? 0);
        item.detail = err.message;
      } else if (err instanceof NotFound) {
        item.detail = err.message;
      } else {
        console.error("[cleanup] process-all item failed:", (err as Error)?.message ?? err);
        item.outcome = "failed";
        item.detail = "internal";
      }
    }
    items.push(item);
  }
  const erased = items.filter((i) => i.outcome === "erased").length;
  const a = (await db.query<ActionRow>(
    `UPDATE public.cleanup_actions SET finished_at = now(), detail = $2::jsonb WHERE id = $1 RETURNING ${ACTION_COLS}`,
    [id, JSON.stringify({ sources: ids.length, erased, blocked: items.filter((i) => i.outcome === "blocked").length })],
  ))[0];
  return { action: a, reason_type: reasonType, items, erased };
}

// ── reopen candidates (D5 items 6-7) ──────────────────────────────────────────────────────────
interface CandRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  reason_type: string;
  note: string | null;
  eraser_kind: string;
  eraser_user: string | null;
  erased_by_you: boolean;
  erased_at: string;
  lifted_at: string | null;
  readmitted_source_id: string | null;
  confidence: number | null;
  score_version: string | null;
  attempts: CandidateAttempt[];
}

export async function candidates(db: Db, reg: RegistryReader, who: Identity, limit: number) {
  const sql = `SELECT t.id, t.source_id, t.url, t.title, t.reason_type, t.note, t.eraser_kind, t.eraser_user,
            (t.eraser_kind = 'user' AND t.eraser_user = $1) AS erased_by_you,
            t.erased_at, t.lifted_at, t.readmitted_source_id, t.confidence, t.score_version,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'path', a.path, 'outcome', a.outcome, 'session_id', a.session_id, 'note', a.note,
                        'attempted_at', a.attempted_at, 'reason', a.detail ->> 'reason', 'score', a.detail -> 'score')
                        ORDER BY a.attempted_at, a.id)
                        FROM public.source_tombstone_attempts a
                       WHERE a.tombstone_id = t.id AND a.outcome IN ('candidate', 'note_appended')), '[]'::jsonb) AS attempts
       FROM public.source_tombstones t
      WHERE t.lifted_at IS NULL AND t.readmitted_source_id IS NULL
        AND EXISTS (SELECT 1 FROM public.source_tombstone_attempts a
                     WHERE a.tombstone_id = t.id AND a.outcome IN ('candidate', 'note_appended'))
      ORDER BY (SELECT max(a.attempted_at) FROM public.source_tombstone_attempts a WHERE a.tombstone_id = t.id) DESC, t.id
      LIMIT $2 OFFSET $3`;
  const out = [];
  // Round 3 (reviewer RF2): the candidate rule (registry paths and gates, the stored score) is applied in code, so
  // the read PAGES until it has `limit` candidates or the rows run out - a tombstone that is not a candidate can
  // never push one off the page.
  const page = Math.max(limit, 50);
  for (let offset = 0; out.length < limit; offset += page) {
    const rows = await db.query<CandRow>(sql, [who.sub, page, offset]);
    for (const r of rows) {
      if (out.length >= limit) break;
      const path = await reg.definitionOf<string>("erasure_reasons", r.reason_type, "reopen_path", "");
      const gate = await reg.definitionOf<string>("erasers", r.eraser_kind, "gate", "");
      const attempts = (r.attempts ?? []).map((a) => ({
        path: a.path, outcome: a.outcome, attempted_at: a.attempted_at, reason: a.reason ?? null,
        score: (a.score && typeof a.score === "object") ? a.score : null,
        session_id: a.session_id, note: a.note,
      }));
      const c = candidateOf({ ...r, attempts }, path, gate);
      if (!c) continue;
      out.push({
        kind: c.kind,
        tombstone: {
          id: r.id, source_id: r.source_id, url: r.url, title: r.title, reason_type: r.reason_type, note: r.note,
          eraser_kind: r.eraser_kind, erased_by_you: r.erased_by_you, erased_at: r.erased_at,
          confidence: r.confidence === null ? null : Number(r.confidence), score_version: r.score_version,
        },
        evidence: c.evidence,
        dispute_preview: c.dispute_preview,
      });
    }
    if (rows.length < page) break; // the rows ran out
  }
  return { candidates: out };
}
