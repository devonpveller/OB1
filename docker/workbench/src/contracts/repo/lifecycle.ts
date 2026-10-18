// D5 lifecycle writes: dependence / suppress / sever / erase / lift, the admission gate
// (reopen paths), and the held user sources of a refinery (ingestion model 2026-09-25).
//
// Every write is one transaction that locks the source row first, so two operators severing
// and erasing the same source serialise instead of racing past the gate.
import type { Db } from "../db.ts";
import { aggregateDependence, type DependenceRow, kindDefs } from "../logic/dependence.ts";
import { type AdmissionScorer, decideReopen } from "../logic/reopen.ts";
import type { MetadataFilter } from "../logic/scope.ts";
import type { RegistryReader } from "../registry.ts";
import { tombstoneById, tombstoneForUrl, tombstoneOut } from "./sources.ts";

export class Conflict extends Error {
  constructor(message: string, public detail: Record<string, unknown> = {}) {
    super(message);
  }
}
export class NotFound extends Error {}

async function lockSource(db: Db, id: string) {
  const rows = await db.query<{ id: string; lifecycle: string; url: string | null; title: string; content: string }>(
    `SELECT id, url, title, content,
            public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle
       FROM public.sources WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function trail(db: Db, sourceId: string, kind: string, detail: Record<string, unknown>, actor: string | null) {
  await db.query(
    `INSERT INTO public.source_trail_events (source_id, kind, detail, actor) VALUES ($1, $2, $3::jsonb, $4)`,
    [sourceId, kind, JSON.stringify(detail), actor],
  );
}

// Under a metadata filter (the cloud door forces {"share":"cloud"}; rw-p0-contract2) the answer
// FAILS CLOSED: a source (or held source) outside the filter is unknown (lifecycle null -> 404),
// and of an in-scope source's connections only these come back - an ALLOW-LIST, so a kind
// source_dependence() gains later is dropped under a filter until it is listed here:
//   chunk, trail_event          the source's own rows (it is in scope)
//   claim_edge                  when the claim's metadata contains the filter
//   report_citation, found_via_lead  when that source row's metadata contains the filter
// citing_page, entity_grounding, report_session and document_link carry no metadata and are
// dropped. A scoped view cannot prove zero dependence, so erase_allowed is false under a filter.
const SCOPED_DEPENDENCE = `
  SELECT d.kind, d.ref, d.detail FROM public.source_dependence($1) d
   WHERE $2::jsonb IS NULL
      OR d.kind IN ('chunk', 'trail_event')
      OR (d.kind = 'claim_edge' AND EXISTS (
            SELECT 1 FROM public.claims c WHERE c.id = (d.detail ->> 'claim_id')::uuid AND c.metadata @> $2::jsonb))
      OR (d.kind IN ('report_citation', 'found_via_lead') AND EXISTS (
            SELECT 1 FROM public.sources x WHERE x.id::text = d.ref AND x.metadata @> $2::jsonb))`;

export async function dependence(db: Db, reg: RegistryReader, id: string, f: MetadataFilter = null) {
  const mf = f ? JSON.stringify(f) : null;
  const life = await db.query<{ lifecycle: string }>(
    `SELECT public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle FROM public.sources
      WHERE id = $1 AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)`,
    [id, mf],
  );
  const held = life[0] ? null : await db.query<{ id: string }>(
    `SELECT id FROM public.held_sources WHERE id = $1 AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)`,
    [id, mf],
  );
  const lifecycle = life[0]?.lifecycle ?? (held && held[0] ? "held" : null);
  const defs = kindDefs(await reg.entries("dependence_kinds"));
  if (lifecycle === null && mf !== null) {
    // out of scope: nothing about it, not even its connection count
    return { source_id: id, lifecycle, ...aggregateDependence([], defs), erase_allowed: false };
  }
  const rows = await db.query<DependenceRow>(SCOPED_DEPENDENCE, [id, mf]);
  const agg = aggregateDependence(rows, defs);
  return { source_id: id, lifecycle, ...agg, erase_allowed: mf === null && lifecycle === "unlinked" && agg.blocking === 0 };
}

// When the last blocking connection goes, a suppressed source becomes unlinked (D5 stage 3).
async function settleUnlinked(db: Db, id: string, actor: string | null): Promise<{ lifecycle: string; blocking: number }> {
  const b = (await db.query<{ n: number }>(`SELECT public.source_blocking_dependence($1) AS n`, [id]))[0].n;
  const cur = (await lockSource(db, id))!;
  if (cur.lifecycle === "suppressed" && b === 0) {
    await db.query(`UPDATE public.sources SET unlinked_at = now() WHERE id = $1`, [id]);
    await trail(db, id, "unlinked", { blocking: 0 }, actor);
    return { lifecycle: "unlinked", blocking: 0 };
  }
  return { lifecycle: cur.lifecycle, blocking: b };
}

// Stage 1. The committed retraction IS the suppressed state, so every consumer that already
// filters retraction_committed_at excludes it from that moment; claims it grounded are
// re-scored now (claim_confidence ignores suppressed edges since 230-init-research-contract).
export async function suppress(db: Db, id: string, reason: string, by: string | null) {
  return await db.tx(async (t) => {
    const s = await lockSource(t, id);
    if (!s) throw new NotFound("source not found");
    if (s.lifecycle !== "active") throw new Conflict(`source is ${s.lifecycle}, not active`, { lifecycle: s.lifecycle });
    const ctx = (await t.query<{ ctx: Record<string, unknown> }>(
      `SELECT jsonb_build_object(
          'title', s.title, 'url', s.url, 'suppressed_by', $2::text, 'suppressed_at', now(),
          'notebooks', (SELECT count(*) FROM public.thread_sources ts WHERE ts.source_id = s.id AND ts.status = 'confirmed'),
          'citing_pages', (SELECT count(*) FROM public.source_dependence(s.id) d WHERE d.kind = 'citing_page'),
          'score_at_removal', jsonb_build_object(
              'value', (SELECT avg(c.confidence) FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
                         WHERE cs.source_id = s.id AND cs.edge_type <> 'contradicts'),
              'version', 'claim-confidence-mean-v1')) AS ctx
         FROM public.sources s WHERE s.id = $1`,
      [id, by],
    ))[0].ctx;
    await t.query(
      `UPDATE public.sources
          SET retracted_at = COALESCE(retracted_at, now()), retracted_by = COALESCE($2, retracted_by, 'operator'),
              retraction_committed_at = now(), suppression_reason = $3, suppression_context = $4::jsonb,
              unlinked_at = NULL
        WHERE id = $1`,
      [id, by, reason, JSON.stringify(ctx)],
    );
    const rescored = (await t.query<{ n: number }>(`SELECT public.recompute_claims_for_source($1) AS n`, [id]))[0].n;
    await trail(t, id, "suppressed", { reason }, by);
    const settled = await settleUnlinked(t, id, by);
    return { source_id: id, lifecycle: settled.lifecycle, reason, context: ctx, rescored_claims: rescored, blocking: settled.blocking };
  });
}

interface Severed {
  kind: string;
  ref: string;
  pages: string[];
  claims: string[];
}

async function markPending(db: Db, pageRef: string, sourceId: string, reason: string) {
  await db.query(
    `INSERT INTO public.page_compile_marks (page_ref, source_id, reason) VALUES ($1, $2, $3)
     ON CONFLICT (page_ref, source_id) DO UPDATE SET marked_at = now(), reason = EXCLUDED.reason`,
    [pageRef, sourceId, reason],
  );
}

// One connection, removed. The claim_sources trigger re-scores a claim whose edge goes.
async function severOne(db: Db, id: string, kind: string, ref: string): Promise<Severed> {
  const out: Severed = { kind, ref, pages: [], claims: [] };
  if (kind === "claim_edge") {
    const r = await db.query<{ claim_id: string; synthesis_id: string | null }>(
      `DELETE FROM public.claim_sources cs USING public.claims c
        WHERE cs.id = $1::bigint AND cs.source_id = $2 AND c.id = cs.claim_id
        RETURNING cs.claim_id, c.synthesis_id`,
      [ref, id],
    );
    out.claims = r.map((x) => x.claim_id);
    out.pages = r.filter((x) => x.synthesis_id).map((x) => `content/source/${x.synthesis_id}`);
  } else if (kind === "chunk") {
    await db.query(`DELETE FROM public.source_chunks WHERE source_id = $1 AND idx = $2::int`, [id, ref]);
  } else if (kind === "citing_page") {
    out.pages = [ref];
  } else if (kind === "entity_grounding") {
    await db.query(`DELETE FROM public.source_entities WHERE source_id = $1 AND entity_id = $2::bigint`, [id, ref]);
    out.pages = [`entity:${ref}`];
  } else if (kind === "report_session") {
    await db.query(`DELETE FROM public.session_sources WHERE session_id = $1::uuid AND source_id = $2`, [ref, id]);
  } else if (kind === "report_citation") {
    // Keep [Source N] alignment: the id becomes null in source_ids, the list keeps its length.
    await db.query(
      `UPDATE public.sources SET metadata = jsonb_set(metadata, '{source_ids}',
          (SELECT COALESCE(jsonb_agg(CASE WHEN e = to_jsonb($2::text) THEN 'null'::jsonb ELSE e END ORDER BY o), '[]'::jsonb)
             FROM jsonb_array_elements(metadata -> 'source_ids') WITH ORDINALITY AS x(e, o)))
        WHERE id = $1::uuid`,
      [ref, id],
    );
    out.pages = [`content/source/${ref}`];
  } else if (kind === "found_via_lead") {
    await db.query(
      `UPDATE public.sources SET metadata = metadata - 'found_via' WHERE id = $1::uuid AND metadata ->> 'found_via' = $2`,
      [ref, id],
    );
  } else {
    throw new Conflict(`dependence kind '${kind}' has no sever rule`);
  }
  for (const p of out.pages) await markPending(db, p, id, `severed ${kind} ${ref}`);
  return out;
}

export async function sever(
  db: Db,
  reg: RegistryReader,
  id: string,
  req: { kind?: string; ref?: string; all?: boolean; by?: string },
) {
  return await db.tx(async (t) => {
    const s = await lockSource(t, id);
    if (!s) throw new NotFound("source not found");
    if (s.lifecycle !== "suppressed") {
      throw new Conflict(`sever needs a suppressed source; this one is ${s.lifecycle}`, { lifecycle: s.lifecycle });
    }
    const dep = await dependence(t, reg, id);
    const targets = req.all
      ? dep.connections.filter((c) => c.severable)
      : dep.connections.filter((c) => c.kind === req.kind && c.ref === req.ref);
    if (!req.all && targets.length === 0) throw new NotFound(`no ${req.kind} connection ${req.ref} on this source`);
    const notSeverable = targets.filter((c) => !c.severable);
    if (notSeverable.length) {
      throw new Conflict(`${notSeverable[0].kind} is not severable by the tool`, { connection: notSeverable[0] });
    }
    const done: Severed[] = [];
    for (const c of targets) {
      const r = await severOne(t, id, c.kind, c.ref);
      await trail(t, id, "severed", { kind: c.kind, ref: c.ref, claims: r.claims, pages: r.pages }, req.by ?? null);
      done.push(r);
    }
    const settled = await settleUnlinked(t, id, req.by ?? null);
    return {
      source_id: id,
      severed: done.map((d) => ({ kind: d.kind, ref: d.ref })),
      rescored_claims: new Set(done.flatMap((d) => d.claims)).size,
      pending_compile: [...new Set(done.flatMap((d) => d.pages))],
      lifecycle: settled.lifecycle,
      blocking: settled.blocking,
    };
  });
}

export interface EraseInput {
  reason_type: string;
  note?: string;
  batch_run_id?: string;
  eraser: { kind: string; run_id?: string; user?: string };
}

async function validateErase(reg: RegistryReader, req: EraseInput) {
  if (!(await reg.has("erasure_reasons", req.reason_type))) {
    throw new Conflict(`reason_type '${req.reason_type}' is not registered`);
  }
  const needs = await reg.definitionOf<string>("erasers", req.eraser.kind, "requires", "");
  if (!(await reg.has("erasers", req.eraser.kind))) throw new Conflict(`eraser '${req.eraser.kind}' is not registered`);
  if (needs === "run_id" && !req.eraser.run_id) throw new Conflict("an automation eraser must name its run_id");
  if (needs === "user" && !req.eraser.user) throw new Conflict("a user eraser must name the user");
}

// Stage 4. Refused unless the source is unlinked AND the recount is zero; the row, chunks and
// revisions go (today's purge, cascading), the named tombstone stays, trail events re-point to it.
export async function erase(db: Db, reg: RegistryReader, id: string, req: EraseInput) {
  await validateErase(reg, req);
  return await db.tx(async (t) => {
    const s = await lockSource(t, id);
    if (!s) throw new NotFound("source not found");
    const dep = await dependence(t, reg, id);
    if (s.lifecycle !== "unlinked" || dep.blocking !== 0) {
      throw new Conflict(`erase refused: the source is ${s.lifecycle} with ${dep.blocking} blocking connection(s)`, {
        lifecycle: s.lifecycle, blocking: dep.blocking, counts: dep.counts,
      });
    }
    const tomb = await t.query<{ id: string }>(
      `INSERT INTO public.source_tombstones
         (source_id, url, url_key, title, reason_type, note, batch_run_id, eraser_kind, eraser_run_id, eraser_user,
          confidence, score_version, fingerprint, original_context, metadata)
       SELECT s.id, COALESCE(s.url, 'urn:openbrain:source:' || s.id::text),
              COALESCE(public.contract_url_key(s.url), 'urn:openbrain:source:' || s.id::text), s.title,
              $2, $3, $4, $5, $6, $7,
              NULLIF(s.suppression_context #>> '{score_at_removal,value}', '')::real,
              s.suppression_context #>> '{score_at_removal,version}',
              encode(sha256(convert_to(s.content, 'UTF8')), 'hex'),
              jsonb_build_object('suppression_reason', s.suppression_reason, 'suppression_context', s.suppression_context,
                                 'content_type', s.content_type, 'domain', s.domain),
              s.metadata
         FROM public.sources s WHERE s.id = $1
       RETURNING id`,
      [id, req.reason_type, req.note ?? null, req.batch_run_id ?? null, req.eraser.kind,
        req.eraser.run_id ?? null, req.eraser.user ?? null],
    );
    const tombstoneId = tomb[0].id;
    await t.query(`UPDATE public.source_trail_events SET tombstone_id = $2 WHERE source_id = $1`, [id, tombstoneId]);
    await t.query(
      `INSERT INTO public.source_trail_events (source_id, tombstone_id, kind, detail, actor) VALUES ($1, $2, 'erased', $3::jsonb, $4)`,
      [id, tombstoneId, JSON.stringify({ reason_type: req.reason_type, batch_run_id: req.batch_run_id ?? null }),
        req.eraser.user ?? req.eraser.run_id ?? null],
    );
    await t.query(`DELETE FROM public.sources WHERE id = $1`, [id]);
    return { tombstone: tombstoneOut((await tombstoneById(t, tombstoneId))!) };
  });
}

export async function lift(db: Db, tombstoneId: string, by: string, note: string | null) {
  return await db.tx(async (t) => {
    const rows = await t.query<{ source_id: string }>(
      `UPDATE public.source_tombstones SET lifted_at = now(), lifted_by = $2, lift_note = $3
        WHERE id = $1 AND lifted_at IS NULL RETURNING source_id`,
      [tombstoneId, by, note],
    );
    const tb = await tombstoneById(t, tombstoneId);
    if (!tb) throw new NotFound("tombstone not found");
    if (rows[0]) await trail(t, rows[0].source_id, "lifted", { tombstone_id: tombstoneId, note }, by);
    return tombstoneOut(tb);
  });
}

export interface AdmissionInput {
  url: string;
  path: string;
  session_id?: string;
  note?: string;
  candidate?: { title?: string; content?: string; content_type?: string };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The gate every door calls before it intakes, watches or follows a URL (D5 items 4, 6, 7).
export async function admission(db: Db, reg: RegistryReader, scorer: AdmissionScorer, req: AdmissionInput) {
  if (!(await reg.has("admission_paths", req.path))) throw new Conflict(`path '${req.path}' is not registered`);
  const base = { url: req.url, path: req.path, tombstone: null, source_id: null, dispute_id: null, score: null };
  const tb = await tombstoneForUrl(db, req.url);
  if (!tb) {
    const lifted = await db.query<{ id: string }>(
      `SELECT id FROM public.source_tombstones WHERE url_key = public.contract_url_key($1)
         AND (lifted_at IS NOT NULL OR readmitted_source_id IS NOT NULL) LIMIT 1`,
      [req.url],
    );
    return lifted[0]
      ? { ...base, outcome: "lifted", admits: true, reason: "the tombstone for this URL was lifted or readmitted" }
      : { ...base, outcome: "not_tombstoned", admits: true, reason: "no tombstone; the door's own admission rules apply" };
  }
  const path = await reg.definitionOf<string>("erasure_reasons", tb.reason_type, "reopen_path", "");
  const gate = await reg.definitionOf<string>("erasers", tb.eraser_kind, "gate", "");
  const c = req.candidate ?? {};
  const score = path === "note_only"
    ? { available: false, value: null, floor: null, version: null, reason: "not scored on the deliberate path" }
    : await scorer.score({ url: req.url, title: c.title ?? tb.title, content: c.content ?? "", content_type: c.content_type ?? "web_article" });
  let decision = decideReopen({
    path, gate, score,
    tombstone: { confidence: tb.confidence === null ? null : Number(tb.confidence), score_version: tb.score_version, fingerprint: tb.fingerprint },
    candidateFingerprint: c.content ? await sha256(c.content) : null,
  });
  if (decision.admits && !c.content) {
    decision = { outcome: "refused", admits: false, reason: `${decision.reason}; but no candidate content was given to admit` };
  }
  return await db.tx(async (t) => {
    await t.query(
      `INSERT INTO public.source_tombstone_attempts (tombstone_id, path, outcome, session_id, note, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [tb.id, req.path, decision.outcome, req.session_id ?? null, req.note ?? decision.reason,
        JSON.stringify({ reason: decision.reason, score })],
    );
    await trail(t, tb.source_id, "reopen_attempt", { path: req.path, outcome: decision.outcome }, null);
    let sourceId: string | null = null;
    let disputeId: string | null = null;
    if (decision.admits) ({ sourceId, disputeId } = await readmit(t, tb, req, decision.outcome));
    return {
      ...base, outcome: decision.outcome, admits: decision.admits, reason: decision.reason,
      tombstone: tombstoneOut((await tombstoneById(t, tb.id))!), source_id: sourceId, dispute_id: disputeId, score,
    };
  });
}

async function readmit(db: Db, tb: Awaited<ReturnType<typeof tombstoneForUrl>> & object, req: AdmissionInput, outcome: string) {
  const c = req.candidate ?? {};
  const contesting = outcome === "admitted_contesting";
  const criticism = { tombstone_id: tb.id, reason_type: tb.reason_type, note: tb.note, erased_at: tb.erased_at };
  await db.query(`SELECT set_config('openbrain.admission_tombstone', $1, true)`, [tb.id]);
  const meta = { readmitted_from: tb.id, ...(contesting ? { contesting: true, criticism } : {}) };
  const ins = await db.query<{ id: string }>(
    `SELECT id FROM public.find_or_create_source($1, $2, NULL, $3, $4, NULL, NULL, NULL, $5::jsonb)`,
    [req.url, c.content, c.title ?? tb.title, c.content_type ?? "web_article", JSON.stringify(meta)],
  );
  const sourceId = ins[0].id;
  await db.query(`SELECT set_config('openbrain.admission_tombstone', '', true)`);
  await db.query(
    `UPDATE public.source_tombstones SET readmitted_source_id = $2, readmitted_at = now() WHERE id = $1`,
    [tb.id, sourceId],
  );
  let disputeId: string | null = null;
  if (contesting) {
    disputeId = (await db.query<{ id: string }>(
      `INSERT INTO public.source_disputes (source_id, tombstone_id, criticism) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [sourceId, tb.id, JSON.stringify(criticism)],
    ))[0].id;
  }
  await trail(db, tb.source_id, "readmitted", { tombstone_id: tb.id, source_id: sourceId, contesting }, null);
  return { sourceId, disputeId };
}
