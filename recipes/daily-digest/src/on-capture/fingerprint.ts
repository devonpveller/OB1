/**
 * The fingerprint of Open Notebook's datastore that the capture records and `verify-quiesced`
 * recomputes (research-workbench P7a, C12): any write after the capture changes it.
 *
 * Round 2 (tester D4): EVERYTHING the datastore holds - every row of every table with every field
 * (embeddings included, read in pages so no single response is huge) and the SCHEMA: INFO FOR NS and
 * INFO FOR DB (tables, functions, params, users, analyzers, ...) under "__ns__" / "__db__", and INFO FOR
 * TABLE per table (fields, indexes, events) under "__table__:<name>". A new row, an in-place embedding
 * update, a DEFINE INDEX / FIELD / FUNCTION / PARAM each change a hash. Read-only (SurrealReader).
 */
import { sha256Hex } from "../podcast/archive.ts";

export type Fingerprint = Record<string, { rows: number; sha256: string }>;

export interface Reader {
  query<T = Record<string, unknown>>(q: string): Promise<T[]>;
}

export const PAGE = 200;

export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

async function sha(v: unknown): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(canon(v)));
}

export async function tables(r: Reader): Promise<string[]> {
  const info = await r.query<unknown>("INFO FOR DB") as unknown as { tables?: Record<string, string> };
  return Object.keys(info.tables ?? {}).sort();
}

export async function fingerprint(r: Reader): Promise<Fingerprint> {
  const out: Fingerprint = {};
  out.__ns__ = { rows: 0, sha256: await sha(await r.query<unknown>("INFO FOR NS")) };
  out.__db__ = { rows: 0, sha256: await sha(await r.query<unknown>("INFO FOR DB")) };
  for (const t of await tables(r)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`unexpected table name ${t}`);
    out[`__table__:${t}`] = { rows: 0, sha256: await sha(await r.query<unknown>(`INFO FOR TABLE ${t}`)) };
    const pages: string[] = [];
    let rows = 0;
    for (let start = 0;; start += PAGE) {
      // capture-fix (2026-10-31, the live capture's 400): each row is hashed BY THE SERVER over its whole
      // value (`<string> $this`: every field, embeddings included) and only the id and the hash travel.
      // `SELECT *` cannot be used: a live `source` row's full_text holds a NUL byte, which SurrealDB 2.6's
      // JSON responder refuses to serialise ("to be serialized string contained a null byte", HTTP 400) -
      // the whole page fails. The hash is the record's SurrealQL text, deterministic (ordered fields).
      const page = await r.query<Record<string, unknown>>(`SELECT id, crypto::sha256(<string> $this) AS h FROM ${t} ORDER BY id LIMIT ${PAGE} START ${start}`);
      if (!page.length) break;
      rows += page.length;
      pages.push(await sha(page));
      if (page.length < PAGE) break;
    }
    out[t] = { rows, sha256: await sha(pages) };
  }
  return out;
}

/** The keys whose entry differs between two fingerprints (a key on one side only counts). */
export function changed(a: Fingerprint, b: Fingerprint): string[] {
  return Object.keys({ ...a, ...b }).sort().filter((k) => canon(a[k]) !== canon(b[k]));
}
