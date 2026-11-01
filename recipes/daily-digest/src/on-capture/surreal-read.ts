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

/**
 * The statement with its string literals blanked to '' - by a SCANNER, not a regex (capture-fix round 2,
 * tester t-p7a-capture D1): a quote that is not inside a literal used to open a fake literal and hide real
 * code (`SELECT x /* ' *\/, fn::w() AS q /* ' *\/ FROM a` ran a writing function). FAIL CLOSED: outside a
 * literal, every comment marker (`/*`, `*\/`, `--`, `#`, `//`), every quoted-identifier delimiter (backtick,
 * U+27E8 / U+27E9 angle brackets), every `;` and every non-ASCII character (homoglyphs of `:`, zero-width joiners) REFUSE the
 * statement; an unterminated literal refuses. The capture sends only its own fixed queries, none of which
 * uses any of them. A literal is '...' or "..." with backslash escapes.
 */
export function code(q: string): string {
  let out = "";
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < q.length; j++) {
        if (q[j] === "\\") {
          j++;
          continue;
        }
        if (q[j] === ch) break;
      }
      if (j >= q.length) throw new Error("read-only client: an unterminated string literal");
      out += "''";
      i = j;
      continue;
    }
    const two = q.slice(i, i + 2);
    if (two === "/*" || two === "*/" || two === "--" || two === "//" || ch === "#") throw new Error("read-only client: no comments");
    if (ch === "`" || ch === "\u27e8" || ch === "\u27e9") throw new Error("read-only client: no quoted identifiers");
    if (ch === ";") throw new Error("read-only client: one statement per query, no ';'");
    if (ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
      throw new Error("read-only client: only printable ASCII outside a string literal");
    }
    out += ch;
  }
  return out;
}

export function assertReadOnly(q: string): void {
  const c = code(q).trim();
  // INFO FOR DB / NS, and INFO FOR TABLE <one plain table name> (the schema the quiesce check fingerprints)
  if (/^INFO\s+FOR\s+(DB|NS)$/i.test(c) || /^INFO\s+FOR\s+TABLE\s+[a-z_][a-z0-9_]*$/i.test(c)) return;
  if (!/^SELECT\b/i.test(c)) throw new Error("read-only client: only SELECT or INFO FOR DB / NS / TABLE");
  // round 2: no function call - a fn:: (user-defined) function can write, http:: can reach out. The ONE
  // exception (capture-fix): the built-in, side-effect-free crypto::sha256( that the fingerprint uses to
  // hash rows on the server.
  // (exact spelling, case-sensitive, not glued to a longer name: `xcrypto::sha256(`, `crypto::sha256x(`,
  // `CRYPTO::SHA256(`, `crypto::sha256 (` all keep their `::` and refuse)
  if (c.replace(/(?<![A-Za-z0-9_:])crypto::sha256\(/g, "").includes("::")) throw new Error("read-only client: no function calls ('::')");
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
    if (!res.ok) throw new Error(`surreal ${res.status}: ${text.slice(0, 600)}`);
    const out = JSON.parse(text) as { status: string; result: unknown }[];
    if (out.length !== 1 || out[0].status !== "OK") throw new Error(`surreal query failed: ${text.slice(0, 300)}`);
    return out[0].result as T[];
  }
}
