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

// The write and control keywords no capture SELECT contains (whole word, case-insensitive, outside literals):
// a second, independent check under the character allow-list.
const WRITE = /\b(CREATE|UPDATE|UPSERT|DELETE|INSERT|RELATE|REMOVE|DEFINE|ALTER|KILL|LIVE|BEGIN|COMMIT|CANCEL|USE|SLEEP|REBUILD|LET|THROW|RETURN|FOR|IF|INFO)\b/i;

/**
 * Round 3 (tester t-p7a-capture attempts 1-2: D1 comments / quoted identifiers, D2 regex literals - each a
 * token kind whose delimiters let a quote open a fake literal): an ALLOW-LIST, not a deny-list. Outside a
 * string literal only these characters may appear - exactly what the capture's own queries use
 * (guard-cases.ts CAPTURE_QUERIES: on-capture.ts readOn + src/on-capture/fingerprint.ts):
 *   A-Z a-z 0-9, space, and   , ( ) * < = > _
 *   plus  $ and :  ONLY inside the two exact tokens  $this  and  crypto::sha256(  (checked in assertReadOnly)
 *   and   '  which opens a single-quoted literal: only after a space or ( , = < >, no backslash inside, never
 *         followed straight by another quote (the capture's one literal is  = 'generate_podcast').
 * Everything else refuses: / " ` ; # - . | @ ? ! & + % ^ ~ [ ] { } \ U+27E8 U+27E9, tab, CR, LF, any
 * non-ASCII character - so no comment, regex, quoted identifier, block, closure, graph arrow, parameter other
 * than $this, second statement or record id can be written outside a literal at all.
 */
export const ALLOWED_OUTSIDE: ReadonlySet<string> = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,()*<=>_$:".split(""),
);

/** The statement with its single-quoted literals blanked to '' (a scanner); any character outside a literal
 *  that is not in ALLOWED_OUTSIDE refuses it; so does an unterminated, prefixed, escaped or doubled literal. */
export function code(q: string): string {
  let out = "";
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === "'") {
      // a literal may open only after a separator (no prefixed r'' s'' d'' u'' b'' f'' or unknown prefix,
      // whose escaping the server may judge differently), holds no backslash (no escape the server could
      // read differently), and is not followed straight by another quote (no doubled-quote ambiguity)
      if (i > 0 && !" (,=<>".includes(q[i - 1])) throw new Error("read-only client: a string literal must follow a space or ( , = < >");
      const j = q.indexOf("'", i + 1);
      if (j < 0) throw new Error("read-only client: an unterminated string literal");
      if (q.slice(i + 1, j).includes("\\")) throw new Error("read-only client: no backslash in a string literal");
      if (q[j + 1] === "'") throw new Error("read-only client: no doubled quotes");
      out += "''";
      i = j;
      continue;
    }
    if (!ALLOWED_OUTSIDE.has(ch)) {
      throw new Error(`read-only client: character U+${ch.charCodeAt(0).toString(16).padStart(4, "0")} is not allowed outside a string literal`);
    }
    out += ch;
  }
  return out;
}

export function assertReadOnly(q: string): void {
  const c = code(q).trim();
  // INFO FOR DB / NS, and INFO FOR TABLE <one plain table name> (the schema the quiesce check fingerprints)
  if (/^INFO FOR (DB|NS)$/.test(c) || /^INFO FOR TABLE [a-z_][a-z0-9_]*$/.test(c)) return;
  if (!/^SELECT /.test(c)) throw new Error("read-only client: only SELECT or INFO FOR DB / NS / TABLE");
  // `:` and `$` exist ONLY as the exact, unglued tokens crypto::sha256( (the one admitted function: built-in,
  // side-effect-free, the fingerprint's server-side row hash) and $this (the row it hashes). Anything else
  // with a ':' (fn::, http::, a record id) or a '$' (any other parameter) refuses.
  const rest = c.replace(/(?<![A-Za-z0-9_:$])crypto::sha256\(/g, " ( ").replace(/(?<![A-Za-z0-9_:$])\$this(?![A-Za-z0-9_])/g, " ");
  if (rest.includes(":")) throw new Error("read-only client: no ':' outside the exact token crypto::sha256(");
  if (rest.includes("$")) throw new Error("read-only client: no '$' outside the exact token $this");
  const m = WRITE.exec(rest);
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
    if (!res.ok) throw new Error(`surreal ${res.status}: ${text.slice(0, 600)}`);
    const out = JSON.parse(text) as { status: string; result: unknown }[];
    if (out.length !== 1 || out[0].status !== "OK") throw new Error(`surreal query failed: ${text.slice(0, 300)}`);
    return out[0].result as T[];
  }
}
