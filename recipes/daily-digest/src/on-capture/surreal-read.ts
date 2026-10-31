/**
 * A READ-ONLY SurrealDB client for the Open Notebook capture (research-workbench P7a). Only a
 * single SELECT (or INFO FOR DB) statement is ever sent: anything else - a second statement, a
 * write keyword anywhere outside a string literal - is refused before a byte leaves this process.
 * The capture runs against the live ON datastore, and the anchor allows exports and queries only.
 *
 * Transport: SurrealDB v2's HTTP /sql endpoint (surreal-ns / surreal-db headers, basic auth).
 */
export interface SurrealConfig {
  url: string; // e.g. http://surrealdb:8000
  ns: string;
  db: string;
  user: string;
  pass: string;
  fetchFn?: typeof fetch;
}

const WRITE = /\b(CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE|REMOVE|DEFINE|ALTER|KILL|LIVE|BEGIN|COMMIT|CANCEL|USE|SLEEP|REBUILD|LET|THROW|RETURN|FOR|IF)\b/i;

/** The statement with string literals blanked, so a keyword inside a literal does not count. */
function code(q: string): string {
  return q.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

export function assertReadOnly(q: string): void {
  const c = code(q).trim().replace(/;\s*$/, "");
  if (c.includes(";")) throw new Error("read-only client: one statement per query");
  if (/^INFO\s+FOR\s+DB$/i.test(c)) return;
  if (!/^SELECT\b/i.test(c)) throw new Error("read-only client: only SELECT or INFO FOR DB");
  const m = WRITE.exec(c);
  if (m) throw new Error(`read-only client: '${m[1]}' is not allowed`);
}

export class SurrealReader {
  readonly #c: SurrealConfig;
  statements = 0;
  constructor(c: SurrealConfig) {
    this.#c = c;
  }

  async query<T = Record<string, unknown>>(q: string): Promise<T[]> {
    assertReadOnly(q);
    this.statements++;
    const res = await (this.#c.fetchFn ?? fetch)(`${this.#c.url.replace(/\/+$/, "")}/sql`, {
      method: "POST",
      headers: {
        Accept: "application/json", "Content-Type": "text/plain",
        "surreal-ns": this.#c.ns, "surreal-db": this.#c.db,
        Authorization: `Basic ${btoa(`${this.#c.user}:${this.#c.pass}`)}`,
      },
      body: q,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`surreal ${res.status}: ${text.slice(0, 200)}`);
    const out = JSON.parse(text) as { status: string; result: unknown }[];
    if (out.length !== 1 || out[0].status !== "OK") throw new Error(`surreal query failed: ${text.slice(0, 300)}`);
    return out[0].result as T[];
  }
}
