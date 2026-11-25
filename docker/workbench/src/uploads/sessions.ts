// Upload sessions (rwr-upload-sessions): a large file sent in pieces that survive a dropped connection, and handed to the
// normal intake add path as ONE source only once it is complete and its size and sha256 are verified.
//
//   start   (filename, size, sha256)  -> an open session of the caller's; refused over the per-file limit or when the
//           caller's unfinished uploads would pass theirs (the declared sizes count from the start: a reservation)
//   piece   (offset, the body)        -> accepted only inside [0, size), at most the piece limit, never overlapping a piece
//           already received (the SAME offset and length again is a resend after a dropped answer: it replaces it)
//   status                            -> bytes received, the first missing byte (where to resume), the missing ranges
//   finish  (refinery_id | path, content_type?) -> every byte present, the intake's target and type rules, then the join:
//           the size and the sha256 must match what start declared, else the session FAILS with the reason and its pieces
//           are removed; on success the add job is made (intake/routes.ts insertAddJob) and run (intake/pipeline.ts)
//   cancel                            -> the session and its pieces are removed
//   sweep                             -> sessions untouched for UPLOAD_ABANDON_HOURS are removed with their pieces, and
//           any directory on the volume that is no session's
//
// WHOSE: every session is the identity seam's subject's (owner_sub = who.sub; a body never names a user). Another
// subject's session id answers exactly as an id that does not exist: the same lookup (one query on id AND owner), the
// same 404, the same text, before any other check and before a piece's body is read. A list, a count or a quota answer
// is computed over the caller's own sessions only.
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";
import type { UploadLimits } from "./limits.ts";
import { PieceInterrupted, PieceTooLarge, type UploadStore } from "./store.ts";

export const NO_SUCH_UPLOAD = "no such upload";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const MISSING_SHOWN = 20;

export class UploadRefused extends Error {
  constructor(public status: 400 | 404 | 409 | 413 | 415 | 416 | 422 | 503, message: string, public detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "UploadRefused";
  }
}
const missingUpload = () => new UploadRefused(404, NO_SUCH_UPLOAD);

export interface Piece {
  offset: number;
  length: number;
}

// ── pure: where the bytes are ─────────────────────────────────────────────────────────────────────
export function coverage(pieces: Piece[], size: number): { received: number; next_offset: number; missing: Piece[] } {
  const sorted = [...pieces].sort((a, b) => a.offset - b.offset);
  const missing: Piece[] = [];
  let at = 0, received = 0;
  for (const p of sorted) {
    if (p.offset > at) missing.push({ offset: at, length: p.offset - at });
    received += p.length;
    at = Math.max(at, p.offset + p.length);
  }
  if (at < size) missing.push({ offset: at, length: size - at });
  return { received, next_offset: missing.length ? missing[0].offset : size, missing };
}

// may a piece [offset, offset + length) join these? "same" = exactly a piece already there (a resend)
export function placement(pieces: Piece[], offset: number, length: number, size: number): "new" | "same" | "out_of_range" | { overlaps: Piece } {
  if (!Number.isSafeInteger(offset) || offset < 0 || length <= 0 || offset + length > size) return "out_of_range";
  for (const p of pieces) {
    if (p.offset === offset && p.length === length) return "same";
    if (offset < p.offset + p.length && p.offset < offset + length) return { overlaps: p };
  }
  return "new";
}

export function parseOffset(raw: string | undefined | null): number | null {
  const s = (raw ?? "").trim();
  if (!/^[0-9]{1,15}$/.test(s)) return null;
  return Number(s);
}

// a file name as the add records it: one name, no directory, no control character
export function cleanFilename(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(s) || s === "." || s === "..") return null;
  return s;
}

// ── the session as the caller sees it ────────────────────────────────────────────────────────────
interface Row {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  state: "open" | "finishing" | "done" | "failed";
  reason: string | null;
  job_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const ROW = `s.id::text AS id, s.filename, s.size::text AS size, s.sha256, s.state, s.reason, s.job_id::text AS job_id, s.created_at, s.updated_at`;
const toRow = (r: Record<string, unknown>): Row => ({ ...(r as unknown as Row), size: Number(r.size) });

export interface UploadView {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  state: Row["state"];
  received: number;
  next_offset: number;
  missing: Piece[];
  missing_ranges: number;
  pieces: number;
  reason: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface UploadDeps {
  db: Db;
  store: UploadStore;
  limits: UploadLimits;
  // the intake add path (injected by src/app.ts: intake/routes.ts imports the documents layer, which this module must not)
  intake: {
    // the target and declared type rules of POST /intake/add; null = fine
    target(who: Identity, t: { refinery_id: string; path: string; content_type: string }): Promise<{ refineryId: string | null; docPath: string | null } | { status: number; body: Record<string, unknown> }>;
    // the file type rule over the file's first bytes; a type, or the add's refusal
    fileType(filename: string, head: Uint8Array, declared: string): { type: string } | { status: number; body: Record<string, unknown> };
    // the add's one write, inside the caller's transaction
    insertJob(t: Db, who: Identity, f: { filename: string; refineryId: string | null; docPath: string | null; declared: string }): Promise<{ id: string; status: string }>;
    // run the add (fire and forget)
    run(jobId: string): void;
  };
}

export function uploadSessions(deps: UploadDeps) {
  const { db, store, limits } = deps;
  const ttlMs = limits.abandonHours * 3600_000;

  const piecesOf = async (q: Db, id: string): Promise<Piece[]> =>
    (await q.query<{ o: string; l: string }>(
      `SELECT piece_offset::text AS o, piece_length::text AS l FROM public.upload_session_pieces WHERE session_id = $1::uuid ORDER BY piece_offset`, [id],
    )).map((p) => ({ offset: Number(p.o), length: Number(p.l) }));

  const view = (r: Row, pieces: Piece[]): UploadView => {
    const cov = coverage(pieces, r.size);
    const updated = iso(r.updated_at);
    return {
      id: r.id, filename: r.filename, size: r.size, sha256: r.sha256, state: r.state,
      received: cov.received, next_offset: cov.next_offset, missing: cov.missing.slice(0, MISSING_SHOWN), missing_ranges: cov.missing.length,
      pieces: pieces.length, reason: r.reason, job_id: r.job_id, created_at: iso(r.created_at), updated_at: updated,
      expires_at: new Date(new Date(updated).getTime() + ttlMs).toISOString(),
    };
  };

  // THE lookup: one query on the id AND the caller. Another subject's session and a missing one are the same answer.
  const own = async (q: Db, who: Identity, id: string, lock = false): Promise<Row> => {
    if (!UUID.test(id) || !who.sub) throw missingUpload();
    const r = (await q.query<Record<string, unknown>>(
      `SELECT ${ROW} FROM public.upload_sessions s WHERE s.id = $1::uuid AND s.owner_sub = $2${lock ? " FOR UPDATE" : ""}`, [id.toLowerCase(), who.sub],
    ))[0];
    if (!r) throw missingUpload();
    return toRow(r);
  };

  const unfinished = async (q: Db, sub: string) =>
    Number((await q.query<{ n: string }>(
      `SELECT coalesce(sum(size), 0)::text AS n FROM public.upload_sessions WHERE owner_sub = $1 AND state IN ('open', 'finishing')`, [sub],
    ))[0].n);

  // a session that can no longer finish: its bytes are removed, the row keeps the reason (until the sweep)
  const failSession = async (id: string, reason: string) => {
    await db.query(`UPDATE public.upload_sessions SET state = 'failed', reason = $2, updated_at = now() WHERE id = $1::uuid`, [id, reason]);
    await store.remove(id);
  };

  const limitsView = () => ({
    max_file_bytes: limits.maxFileBytes, max_unfinished_bytes: limits.maxUnfinishedBytes, max_piece_bytes: limits.maxPieceBytes,
    piece_bytes: limits.pieceBytes, abandon_hours: limits.abandonHours,
  });

  return {
    limits: limitsView,

    async start(who: Identity, b: { filename?: unknown; size?: unknown; sha256?: unknown }): Promise<UploadView> {
      if (!who.sub) throw new UploadRefused(400, "an upload needs a signed-in person");
      const filename = cleanFilename(b.filename);
      if (!filename) throw new UploadRefused(400, "the file name is required: one name of at most 255 characters, no folder and no control character");
      const size = typeof b.size === "number" ? b.size : NaN;
      if (!Number.isSafeInteger(size) || size <= 0) throw new UploadRefused(400, "size is the file's length in bytes (a whole number above 0)");
      const sha256 = typeof b.sha256 === "string" ? b.sha256.trim().toLowerCase() : "";
      if (!SHA.test(sha256)) throw new UploadRefused(400, "sha256 is the file's SHA-256 as 64 hexadecimal characters");
      if (size > limits.maxFileBytes) {
        throw new UploadRefused(413, `the file is ${size} bytes; one upload is at most ${limits.maxFileBytes} bytes`, { limit: limits.maxFileBytes });
      }
      const row = await db.tx(async (t) => {
        // one start at a time per person, so two starts sent together cannot both pass the quota
        await t.query(`SELECT pg_advisory_xact_lock(hashtextextended('upload-sessions:' || $1, 0))`, [who.sub]);
        const used = await unfinished(t, who.sub);
        if (used + size > limits.maxUnfinishedBytes) {
          throw new UploadRefused(409,
            `your unfinished uploads already come to ${used} bytes; with this one they would pass your limit of ${limits.maxUnfinishedBytes} bytes: finish or cancel one first`,
            { unfinished_bytes: used, limit: limits.maxUnfinishedBytes });
        }
        return toRow((await t.query<Record<string, unknown>>(
          `INSERT INTO public.upload_sessions AS s (owner_sub, actor_sub, filename, size, sha256) VALUES ($1, $2, $3, $4, $5) RETURNING ${ROW}`,
          [who.sub, who.actor || who.sub, filename, size, sha256],
        ))[0]);
      });
      return view(row, []);
    },

    async status(who: Identity, id: string): Promise<UploadView> {
      const r = await own(db, who, id);
      return view(r, await piecesOf(db, r.id));
    },

    async list(who: Identity): Promise<{ uploads: UploadView[]; unfinished_bytes: number }> {
      if (!who.sub) return { uploads: [], unfinished_bytes: 0 };
      const rows = (await db.query<Record<string, unknown>>(
        `SELECT ${ROW} FROM public.upload_sessions s WHERE s.owner_sub = $1 ORDER BY s.created_at DESC LIMIT 200`, [who.sub],
      )).map(toRow);
      const out: UploadView[] = [];
      for (const r of rows) out.push(view(r, await piecesOf(db, r.id)));
      return { uploads: out, unfinished_bytes: await unfinished(db, who.sub) };
    },

    async piece(who: Identity, id: string, rawOffset: string | undefined, declaredLength: string | undefined, body: ReadableStream<Uint8Array> | null): Promise<UploadView> {
      // the owner check FIRST: nothing of the request (its offset, its body) is looked at for a session that is not the caller's
      const r = await own(db, who, id);
      if (r.state !== "open") throw new UploadRefused(409, `this upload is ${r.state}: it takes no more pieces${r.reason ? ` (${r.reason})` : ""}`, { state: r.state });
      const offset = parseOffset(rawOffset);
      if (offset === null) throw new UploadRefused(400, "offset is the piece's first byte in the file (a whole number from 0)");
      if (offset >= r.size) throw new UploadRefused(416, `offset ${offset} is outside the file (it is ${r.size} bytes)`, { size: r.size });
      const max = Math.min(limits.maxPieceBytes, r.size - offset);
      const cl = declaredLength !== undefined && declaredLength !== "" ? Number(declaredLength) : null;
      if (cl !== null && Number.isFinite(cl) && cl > max) {
        throw cl > limits.maxPieceBytes
          ? new UploadRefused(413, `a piece is at most ${limits.maxPieceBytes} bytes`, { limit: limits.maxPieceBytes })
          : new UploadRefused(416, `a piece of ${cl} bytes at offset ${offset} runs past the end of the file (it is ${r.size} bytes)`, { size: r.size });
      }
      let got: { tmp: string; length: number };
      try {
        got = await store.receive(r.id, body, max);
      } catch (e) {
        if (e instanceof PieceTooLarge) {
          throw max < limits.maxPieceBytes
            ? new UploadRefused(416, `the piece at offset ${offset} runs past the end of the file (it is ${r.size} bytes)`, { size: r.size })
            : new UploadRefused(413, `a piece is at most ${limits.maxPieceBytes} bytes`, { limit: limits.maxPieceBytes });
        }
        if (e instanceof PieceInterrupted) throw new UploadRefused(400, "the piece did not arrive in full; send it again");
        throw e;
      }
      if (got.length === 0) {
        await store.discard(got.tmp);
        throw new UploadRefused(400, "the piece is empty");
      }
      try {
        const done = await db.tx(async (t) => {
          const locked = await own(t, who, id, true);
          if (locked.state !== "open") throw new UploadRefused(409, `this upload is ${locked.state}: it takes no more pieces`, { state: locked.state });
          const have = await piecesOf(t, locked.id);
          const fits = placement(have, offset, got.length, locked.size);
          if (fits === "out_of_range") throw new UploadRefused(416, `the piece at offset ${offset} (${got.length} bytes) runs past the end of the file (it is ${locked.size} bytes)`, { size: locked.size });
          if (typeof fits === "object") {
            throw new UploadRefused(409,
              `the piece at offset ${offset} (${got.length} bytes) overlaps the piece already received at offset ${fits.overlaps.offset} (${fits.overlaps.length} bytes)`,
              { overlaps: fits.overlaps });
          }
          if (fits === "same") {
            await t.query(`UPDATE public.upload_session_pieces SET received_at = now() WHERE session_id = $1::uuid AND piece_offset = $2`, [locked.id, offset]);
          } else {
            await t.query(`INSERT INTO public.upload_session_pieces (session_id, piece_offset, piece_length) VALUES ($1::uuid, $2, $3)`, [locked.id, offset, got.length]);
          }
          const row = toRow((await t.query<Record<string, unknown>>(
            `UPDATE public.upload_sessions s SET updated_at = now(), reason = NULL WHERE s.id = $1::uuid RETURNING ${ROW}`, [locked.id],
          ))[0]);
          // into place while the session's row is locked (a second piece at this offset waits for this one)
          await store.commit(locked.id, got.tmp, offset);
          return row;
        });
        // the intake's file rule, as early as the first bytes are here: a file the add would refuse is refused now,
        // not after the last of 500 MB
        if (offset === 0) {
          const head = await store.head(done.id);
          const typed = deps.intake.fileType(done.filename, head ?? new Uint8Array(), "");
          if ("status" in typed) {
            const reason = String(typed.body.error ?? "the file is not a type the intake takes");
            await failSession(done.id, reason);
            throw new UploadRefused(415, reason, { content_types: typed.body.content_types });
          }
        }
        return view(done, await piecesOf(db, done.id));
      } catch (e) {
        await store.discard(got.tmp);
        throw e;
      }
    },

    async finish(who: Identity, id: string, b: { refinery_id?: unknown; path?: unknown; content_type?: unknown }): Promise<{ upload: UploadView; job_id: string; created: boolean }> {
      const r = await own(db, who, id);
      if (r.state === "done" && r.job_id) return { upload: view(r, []), job_id: r.job_id, created: false }; // a finish resent after a dropped answer
      if (r.state === "finishing") throw new UploadRefused(409, "this upload is being finished already", { state: r.state });
      if (r.state !== "open") throw new UploadRefused(409, `this upload ${r.state}: ${r.reason ?? "it cannot be finished"}`, { state: r.state });
      const have = await piecesOf(db, r.id);
      const cov = coverage(have, r.size);
      if (cov.missing.length) {
        const first = cov.missing[0];
        const reason = `the file is not complete: ${r.size - cov.received} of its ${r.size} bytes have not arrived (${cov.missing.length} missing range${cov.missing.length === 1 ? "" : "s"}, the first from byte ${first.offset}, ${first.length} bytes); send them, then finish again`;
        await db.query(`UPDATE public.upload_sessions SET reason = $2 WHERE id = $1::uuid AND state = 'open'`, [r.id, reason]);
        throw new UploadRefused(409, reason, { missing: cov.missing.slice(0, MISSING_SHOWN), next_offset: cov.next_offset });
      }
      const str = (v: unknown) => (v == null ? "" : String(v).trim());
      const declared = str(b.content_type);
      const where = await deps.intake.target(who, { refinery_id: str(b.refinery_id), path: str(b.path), content_type: declared });
      if ("status" in where) throw new UploadRefused(where.status as 400, String(where.body.error ?? "the add refused it"), { ...where.body, error: undefined });
      const head = await store.head(r.id);
      const typed = deps.intake.fileType(r.filename, head ?? new Uint8Array(), declared);
      if ("status" in typed) {
        const reason = String(typed.body.error ?? "the file is not a type the intake takes");
        if (!declared) await failSession(r.id, reason); // the file itself is refused; a wrong declared type can be finished again without it
        throw new UploadRefused(415, reason, { content_types: typed.body.content_types });
      }
      // claim the finish: one finish at a time, and no piece lands while the file is joined
      const claimed = await db.query(`UPDATE public.upload_sessions SET state = 'finishing', reason = NULL, updated_at = now() WHERE id = $1::uuid AND owner_sub = $2 AND state = 'open' RETURNING id`, [r.id, who.sub]);
      if (!claimed.length) throw new UploadRefused(409, "this upload is being finished already", { state: "finishing" });
      let joined;
      try {
        joined = await store.assemble(r.id, have);
      } catch (e) {
        await db.query(`UPDATE public.upload_sessions SET state = 'open', updated_at = now() WHERE id = $1::uuid AND state = 'finishing'`, [r.id]);
        throw e;
      }
      const refuse = async (reason: string, detail: Record<string, unknown>): Promise<never> => {
        await failSession(r.id, reason);
        throw new UploadRefused(422, reason, detail);
      };
      if (joined.damaged) {
        await refuse(`the piece at offset ${joined.damaged.offset} is ${joined.damaged.found} bytes in storage, not the ${joined.damaged.expected} received: the upload is damaged; start it again`, { damaged: joined.damaged });
      }
      if (joined.bytes !== r.size) await refuse(`the joined file is ${joined.bytes} bytes, not the ${r.size} declared: start the upload again`, { bytes: joined.bytes, size: r.size });
      if (joined.sha256 !== r.sha256) {
        await refuse(`the joined file's sha256 is ${joined.sha256}, not the ${r.sha256} declared: a piece was not the file's; start the upload again`, { sha256: joined.sha256, declared: r.sha256 });
      }
      // ONE source: the add job and the session's hand-over in one transaction; the session cannot make a second job
      const out = await db.tx(async (t) => {
        const job = await deps.intake.insertJob(t, who, { filename: r.filename, refineryId: where.refineryId, docPath: where.docPath, declared: typed.type });
        const row = toRow((await t.query<Record<string, unknown>>(
          `UPDATE public.upload_sessions s SET state = 'done', job_id = $2::uuid, reason = NULL, updated_at = now()
            WHERE s.id = $1::uuid AND s.state = 'finishing' AND s.job_id IS NULL RETURNING ${ROW}`, [r.id, job.id],
        ))[0]);
        if (!row) throw new UploadRefused(409, "this upload is being finished already", { state: "finishing" });
        await t.query(`DELETE FROM public.upload_session_pieces WHERE session_id = $1::uuid`, [r.id]);
        return { row, job };
      });
      deps.intake.run(out.job.id);
      return { upload: view(out.row, []), job_id: out.job.id, created: true };
    },

    async cancel(who: Identity, id: string): Promise<void> {
      const r = await own(db, who, id);
      if (r.state === "finishing") throw new UploadRefused(409, "this upload is being finished; it can be cancelled once that ends", { state: r.state });
      if (r.state === "done") throw new UploadRefused(409, "this upload is finished: it is an add job now (cancel that from the queue)", { state: r.state, job_id: r.job_id });
      await db.query(`DELETE FROM public.upload_sessions WHERE id = $1::uuid AND owner_sub = $2`, [r.id, who.sub]);
      await store.remove(r.id);
    },

    // ── the add pipeline's side (intake/pipeline.ts UploadPayloads) ──────────────────────────────
    payloads: {
      async payloadOf(jobId: string) {
        if (!UUID.test(jobId)) return null;
        const s = (await db.query<{ id: string; filename: string; size: string; sha256: string }>(
          `SELECT id::text AS id, filename, size::text AS size, sha256 FROM public.upload_sessions WHERE job_id = $1::uuid AND state = 'done'`, [jobId]))[0];
        if (!s) return null;
        const bytes = await store.readAssembled(s.id);
        return bytes ? { filename: s.filename, bytes, upload: { id: s.id, size: Number(s.size), sha256: s.sha256 } } : null;
      },
      async held(jobId: string) {
        if (!UUID.test(jobId)) return;
        const s = (await db.query<{ id: string }>(`SELECT id::text AS id FROM public.upload_sessions WHERE job_id = $1::uuid`, [jobId]))[0];
        if (s) await store.remove(s.id);
      },
    },

    // ── housekeeping ─────────────────────────────────────────────────────────────────────────────
    // at start: a finish the last process did not complete goes back to open (its half-joined file removed)
    async recoverOnStart(): Promise<number> {
      const rows = await db.query<{ id: string }>(`UPDATE public.upload_sessions SET state = 'open' WHERE state = 'finishing' RETURNING id::text AS id`);
      for (const r of rows) await store.dropAssembled(r.id);
      return rows.length;
    },
    // the sweep: every session untouched for the abandon window (and not an add job still running), and every directory
    // on the volume that is no session's. Answers what it removed and the bytes that freed (measured on disk).
    async sweep(now = Date.now()): Promise<{ sessions: number; orphans: number; bytes: number }> {
      const dirs = await store.sessions(); // listed BEFORE the rows are read: a session started after this has no directory here
      const cutoff = new Date(now - ttlMs).toISOString();
      const stale = await db.query<{ id: string }>(
        `DELETE FROM public.upload_sessions s WHERE s.updated_at < $1::timestamptz
            AND NOT EXISTS (SELECT 1 FROM public.import_jobs j WHERE j.id = s.job_id AND j.status IN ('queued', 'fetching', 'extracting', 'embedding', 'linking', 'holding'))
          RETURNING s.id::text AS id`, [cutoff]);
      let bytes = 0;
      for (const s of stale) bytes += await store.remove(s.id);
      const live = new Set((await db.query<{ id: string }>(`SELECT id::text AS id FROM public.upload_sessions WHERE id = ANY($1::uuid[])`, [dirs])).map((r) => r.id));
      let orphans = 0;
      for (const d of dirs) {
        if (live.has(d) || stale.some((s) => s.id === d)) continue;
        bytes += await store.remove(d);
        orphans++;
      }
      return { sessions: stale.length, orphans, bytes };
    },
  };
}
export type UploadSessions = ReturnType<typeof uploadSessions>;
