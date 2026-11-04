/**
 * THE MARKER SWEEP (rw-boundary-core, plan 09 section 5): reusable test infrastructure for PD0a-PD0e. It proves
 * ABSENCE: after a path has run, it counts every marker's hits in EVERY text / varchar / char / json / jsonb / text[]
 * column of EVERY base table in `public` - the column list is generated from information_schema, so a new table
 * cannot escape - except the tables a caller names as private (the hand-back, archives, the personal inlet tables).
 * Those excluded tables are swept too and reported separately: a path whose markers never reached them did not run,
 * and a zero elsewhere would be vacuous.
 * Counts only (marker name, table, column, rows) - never the row content.
 */
export interface Q { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> }
export interface SweepHit { marker: string; table: string; column: string; rows: number }
export interface SweepResult { columns: number; tables: number; hits: SweepHit[]; private: SweepHit[] }

const TEXTY = new Set(["text", "character varying", "character", "json", "jsonb", "ARRAY"]);

/** Plan 09's default private set: the hand-back, every archive table, and the personal inlet tables. */
export const DEFAULT_PRIVATE = (t: string) =>
  t === "research_handbacks" || t.endsWith("_archive") || ["ideas", "idea_revisions"].includes(t);

export async function sweepTables(c: Q, markers: Record<string, string>, isPrivate: (table: string) => boolean = DEFAULT_PRIVATE): Promise<SweepResult> {
  const cols = (await c.queryObject<{ t: string; c: string; dt: string; udt: string }>(
    `SELECT col.table_name AS t, col.column_name AS c, col.data_type AS dt, col.udt_name AS udt
       FROM information_schema.columns col
       JOIN information_schema.tables tb ON tb.table_schema = col.table_schema AND tb.table_name = col.table_name
      WHERE col.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
      ORDER BY col.table_name, col.ordinal_position`)).rows
    .filter((r) => TEXTY.has(r.dt) && (r.dt !== "ARRAY" || ["_text", "_varchar"].includes(r.udt)));
  const names = Object.keys(markers);
  const values = names.map((n) => markers[n].toLowerCase());
  const hits: SweepHit[] = [];
  const priv: SweepHit[] = [];
  for (const col of cols) {
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = (await c.queryObject<{ i: number; n: number }>(
      `SELECT m.i::int AS i, count(*)::int AS n
         FROM public.${ident(col.t)} t, unnest($1::text[]) WITH ORDINALITY AS m(v, i)
        WHERE t.${ident(col.c)} IS NOT NULL AND position(m.v IN lower(t.${ident(col.c)}::text)) > 0
        GROUP BY m.i`, [values])).rows;
    for (const r of rows) {
      const h = { marker: names[r.i - 1], table: col.t, column: col.c, rows: r.n };
      (isPrivate(col.t) ? priv : hits).push(h);
    }
  }
  return { columns: cols.length, tables: new Set(cols.map((x) => x.t)).size, hits, private: priv };
}

/** Marker hits in free text (a stub's request log, a response body): counts per marker, never the text. */
export function sweepText(text: string, markers: Record<string, string>): Record<string, number> {
  const low = text.toLowerCase();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(markers)) {
    const n = low.split(v.toLowerCase()).length - 1;
    if (n) out[k] = n;
  }
  return out;
}

export function describe(r: SweepResult): string {
  const fmt = (xs: SweepHit[]) => xs.map((h) => `${h.marker}@${h.table}.${h.column}=${h.rows}`).join(" ") || "none";
  return `sweep: ${r.columns} columns in ${r.tables} tables; shared hits: ${fmt(r.hits)}; private-table hits: ${fmt(r.private)}`;
}
