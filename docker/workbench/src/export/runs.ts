// Export runs (research-workbench P6b, rw-p6b-gate): every gated export, recorded for its owner.
// Per user (07-MULTI-USER): a run is read and written ONLY for the identity seam's subject - every
// query below filters on owner_sub = the caller's subject, never a caller-supplied user; another
// user's run by id is "not found" (404), the same answer as an id that does not exist.
import type { Db } from "../contracts/db.ts";
import type { Finding } from "./vision.ts";

export interface ExportRunInput {
  owner_sub: string;
  actor_sub: string;
  path: string;
  format: string;
  style: string;
  status: "passed" | "blocked";
  blocking_findings: Finding[];
  warnings: Finding[];
  checks: Record<string, unknown>;
  filename: string;
  mime: string;
  file: Uint8Array | null; // passed only
}

export interface ExportRunRow {
  id: string;
  path: string;
  format: string;
  style: string;
  status: "passed" | "blocked";
  blocking_findings: Finding[];
  warnings: Finding[];
  checks: Record<string, unknown>;
  filename: string;
  mime: string;
  sha256: string | null;
  bytes: number | null;
  created_at: string;
}

export interface RunStore {
  record(r: ExportRunInput): Promise<string>;
  list(owner: string, limit: number, path?: string): Promise<ExportRunRow[]>;
  get(owner: string, id: string): Promise<ExportRunRow | null>;
  file(owner: string, id: string): Promise<{ filename: string; mime: string; file: Uint8Array } | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = `id::text AS id, path, format, style, status, blocking_findings, warnings, checks, filename, mime, sha256, bytes,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;

const sha256Hex = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

export function runStore(db: Db): RunStore {
  return {
    async record(r) {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO public.export_runs (owner_sub, actor_sub, path, format, style, status, blocking_findings, warnings, checks,
                                         filename, mime, sha256, bytes, file)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14) RETURNING id::text AS id`,
        [r.owner_sub, r.actor_sub, r.path, r.format, r.style, r.status, JSON.stringify(r.blocking_findings), JSON.stringify(r.warnings),
          JSON.stringify(r.checks), r.filename, r.mime, r.file ? await sha256Hex(r.file) : null, r.file ? r.file.byteLength : null, r.file],
      );
      return rows[0].id;
    },
    async list(owner, limit, path) {
      return await db.query<ExportRunRow>(
        `SELECT ${COLS} FROM public.export_runs WHERE owner_sub = $1 AND ($3::text IS NULL OR path = $3)
          ORDER BY created_at DESC, id LIMIT $2`,
        [owner, Math.max(1, Math.min(limit, 200)), path ?? null],
      );
    },
    async get(owner, id) {
      if (!UUID.test(id)) return null;
      const rows = await db.query<ExportRunRow>(`SELECT ${COLS} FROM public.export_runs WHERE id = $1::uuid AND owner_sub = $2`, [id, owner]);
      return rows[0] ?? null;
    },
    async file(owner, id) {
      if (!UUID.test(id)) return null;
      const rows = await db.query<{ filename: string; mime: string; file: Uint8Array | null }>(
        `SELECT filename, mime, file FROM public.export_runs WHERE id = $1::uuid AND owner_sub = $2 AND status = 'passed'`, [id, owner],
      );
      const f = rows[0];
      return f?.file ? { filename: f.filename, mime: f.mime, file: f.file } : null;
    },
  };
}
