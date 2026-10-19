/**
 * scholarly.ts - scholarly metadata, resolved and cached (research-workbench P3a, D15 item 1).
 *
 * For a source that carries a scholarly identifier (a DOI, PMID, PMCID or arXiv id) the service
 * resolves it through the KEYED OpenAlex API, with Crossref's polite pool as the fallback, and
 * records `metadata.scholarly = {state, identifier, doi, cited_by, published, authors:
 * [{id, works_count}], resolved_at, via}`. Resolution failure is a counted, visible state
 * (`unresolved` with the reason), never a silent zero: a count the resolver did not get is
 * `null`, and the score says so (credibility.ts paperScore).
 *
 * EGRESS: every resolver call goes out through the research service's egress proxy
 * (FETCH_PROXY_URL, the same client the page fetcher uses). The resolver only accepts a
 * `ProxiedFetch` - a fetch built by `proxiedFetch()` around that client - so a call that
 * bypasses the proxy cannot be constructed (`createScholarlyResolver` refuses anything else).
 *
 * Two kinds of identifier, kept apart:
 *   own     the source IS the work: from its URL (doi.org, a DOI in the path, arxiv.org/abs,
 *           PubMed, PMC, publisher article ids with a declared DOI prefix) or, for PMC/PubMed
 *           pages, the work's DOI printed in the page head;
 *   linked  works the source's body LINKS (D15 item 3: a post that links a paper). Never used
 *           to decide the source's own family.
 */
import type { ScholarlyAuthor, ScholarlyRecord } from "./credibility.ts";

// â”€â”€ reasons: codes, never error text (attempt 2, tester finding 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Attempt 1 formed an unresolved record's reason from the fetch error's message, which carries
// the full request URL - `?api_key=<OPENALEX_API_KEY>&mailto=<SCHOLARLY_MAILTO>` - and that
// reason was stored (sources.metadata.scholarly, the credibility reasons, the history) and
// served (POST /research/credibility/score, quality(id) signals.scholarly.reason, the cloud door
// included). A reason is now formed HERE from a closed vocabulary: the service, a status code or
// an error class, and the service's fixed host - no URL, no query, no key, no mailto, no
// identifier text. Every token matches SCHOLARLY_REASON_PATTERN; the workbench's quality(id)
// serves signals.scholarly.reason only when it does (docker/workbench/src/contracts/logic/
// scholarly_reason.ts holds the same pattern; scholarly.test.ts proves the two are equal).
const OPENALEX_HOST = "api.openalex.org";
const CROSSREF_HOST = "api.crossref.org";
export const SCHOLARLY_REASON_PATTERN =
  "^(?:(?:OpenAlex|OpenAlex authors|Crossref) (?:\\d{3}|network error|timeout|unreadable answer) \\((?:api\\.openalex\\.org|api\\.crossref\\.org)\\)" +
  "|OpenAlex not keyed|Crossref fallback: author works_count unresolved|no DOI to try Crossref with|no scholarly resolver configured)$";
const REASON_TOKEN = new RegExp(SCHOLARLY_REASON_PATTERN);

/** Every "; "-separated token of a reason is one of the codes above. */
export function scholarlyReasonAllowed(reason: unknown): boolean {
  return typeof reason === "string" && reason.length > 0 && reason.length <= 400 &&
    reason.split("; ").every((t) => REASON_TOKEN.test(t));
}

/** An error's CLASS, never its message (the message holds the request URL). */
function errorClass(e: unknown): "timeout" | "network error" {
  const n = (e as { name?: string })?.name ?? "";
  return n === "TimeoutError" || n === "AbortError" ? "timeout" : "network error";
}

/**
 * Credential-shaped text (attempt 2; attempt 3 widened it, tester near-miss: a bare key and a
 * fully percent-encoded query passed): a key/token/mailto assignment, a URL with a query string,
 * or a bare TOKEN - a run of 16+ letters, digits, '_' or '-' holding both a letter and a digit -
 * judged on the text AND on its percent-decoded form. UUIDs, DOIs and ORCID iDs are not tokens
 * (they are removed before the token test). The patterns are strings so the workbench's
 * logic/scholarly_reason.ts can hold the same ones (scholarly.test.ts asserts they are equal and
 * runs one vector list through both implementations).
 */
export const SECRET_SHAPED_PATTERN =
  "(?:api[_-]?key|apikey|mailto|token|secret|password|authorization)\\s*[=:]|https?:\\/\\/[^\\s)]*\\?";
export const TOKEN_SHAPED_PATTERN =
  "(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])";
export const NOT_A_TOKEN_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\\b10\\.\\d{4,9}\\/[^\\s\"'<>]+|\\b\\d{4}-\\d{4}-\\d{4}-\\d{3}[0-9X]\\b";
const SECRET_SHAPED = new RegExp(SECRET_SHAPED_PATTERN, "i");
const TOKEN_SHAPED = new RegExp(TOKEN_SHAPED_PATTERN);
const NOT_A_TOKEN = new RegExp(NOT_A_TOKEN_PATTERN, "g");
export const REDACTED_REASON = "reason redacted (it carried a URL or credential-shaped text)";

/** Percent-decoding, lenient (a stray '%' never stops it) and repeated (double encoding), ASCII only. */
function percentDecoded(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    const d = t.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (d === t) break;
    t = d;
  }
  return t;
}

/** Does this text carry anything credential-shaped (see the patterns above)? */
export function credentialShaped(text: unknown): boolean {
  const raw = String(text ?? "");
  for (const t of [raw, percentDecoded(raw)]) {
    if (SECRET_SHAPED.test(t)) return true;
    if (TOKEN_SHAPED.test(t.replace(NOT_A_TOKEN, " "))) return true;
  }
  return false;
}

/** A free-text reason (a credibility reason line) with nothing credential-shaped in it. */
export function safeReasonText(text: string): string {
  return credentialShaped(text) ? REDACTED_REASON : String(text);
}

const PUBLISHED_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const cleanText = (v: unknown): string | null => (typeof v === "string" && v.length <= 400 && !credentialShaped(v) ? v : null);

/**
 * The scholarly record as it may be STORED (and, in the workbench, served): an allow-list of
 * fields AND of their shapes (attempt 3, tester near-miss: a 200 body copying the request URL into
 * `doi` or an author's `display_name` was stored and served unscanned). state is resolved |
 * unresolved; identifier {kind, value}, doi, every author's id and name are kept only when they
 * carry nothing credential-shaped (else null); cited_by and works_count are non-negative integers
 * or null; published is a date; resolved_at an ISO time; via openalex | crossref | null; a reason
 * only when it is made of the codes above. A cached record written by older code, or any other
 * writer, cannot carry a key, a mailto or a URL query forward.
 */
export function safeScholarlyRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  if ("state" in rec) out.state = rec.state === "resolved" || rec.state === "unresolved" ? rec.state : "unresolved";
  if ("identifier" in rec) {
    const id = rec.identifier as Record<string, unknown> | null;
    const kind = id && ["doi", "pmid", "pmcid", "arxiv"].includes(String(id.kind)) ? String(id.kind) : null;
    const value = id ? cleanText(id.value) : null;
    out.identifier = kind && value ? { kind, value } : null;
  }
  if ("doi" in rec) out.doi = cleanText(rec.doi);
  if ("cited_by" in rec) out.cited_by = count(rec.cited_by);
  if ("published" in rec) out.published = typeof rec.published === "string" && PUBLISHED_RE.test(rec.published) ? rec.published : null;
  if ("authors" in rec) {
    out.authors = (Array.isArray(rec.authors) ? rec.authors : []).slice(0, 50).map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return { id: cleanText(x.id), name: cleanText(x.name), works_count: count(x.works_count) };
    });
  }
  if ("resolved_at" in rec) out.resolved_at = typeof rec.resolved_at === "string" && ISO_RE.test(rec.resolved_at) ? rec.resolved_at : null;
  if ("via" in rec) out.via = rec.via === "openalex" || rec.via === "crossref" ? rec.via : null;
  if (rec.reason !== undefined && rec.reason !== null) {
    out.reason = scholarlyReasonAllowed(rec.reason) ? rec.reason : "reason redacted (not an allow-listed reason code)";
  }
  return out;
}

export interface Identifier { kind: "doi" | "pmid" | "pmcid" | "arxiv"; value: string }

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
const DOI_RE_G = /\b(10\.\d{4,9}\/[^\s"'<>]+)/gi;

/** Trailing punctuation and landing-page suffixes are not part of a DOI. */
export function cleanDoi(raw: string): string {
  let d = decodeURIComponentSafe(raw).trim();
  d = d.replace(/[).,;:\]]+$/, "");
  d = d.replace(/\/(full|abstract|pdf|epdf|fulltext|html|meta)(\/.*)?$/i, "");
  d = d.replace(/\.(pdf|html?)$/i, "");
  return d.toLowerCase();
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Publisher article ids that ARE a DOI suffix under a declared prefix. Data, extended by adding a row. */
const PUBLISHER_DOI_RULES: Array<{ host: RegExp; path: RegExp; prefix: string }> = [
  { host: /(^|\.)nature\.com$/i, path: /^\/articles\/([a-z0-9.-]+)$/i, prefix: "10.1038/" },
];

/** The source's OWN identifier, from its URL (and, for PMC/PubMed pages, the head of its text). */
export function ownIdentifier(url: string, content = ""): Identifier | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponentSafe(u.pathname);
  if (/(^|\.)arxiv\.org$/.test(host)) {
    const m = path.match(/^\/(?:abs|pdf)\/([a-z.-]*\/?\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(v\d+)?/i);
    if (m) return { kind: "arxiv", value: m[1].replace(/\.pdf$/i, "") };
  }
  if (/(^|\.)ncbi\.nlm\.nih\.gov$/.test(host) || host === "pmc.ncbi.nlm.nih.gov" || host === "europepmc.org") {
    const pmc = path.match(/\b(PMC\d+)\b/i);
    if (pmc) return { kind: "pmcid", value: pmc[1].toUpperCase() };
  }
  if (host === "pubmed.ncbi.nlm.nih.gov") {
    const m = path.match(/^\/(\d{4,9})\/?$/);
    if (m) return { kind: "pmid", value: m[1] };
  }
  const inPath = (path + (u.search ? decodeURIComponentSafe(u.search) : "")).match(DOI_RE);
  if (inPath) return { kind: "doi", value: cleanDoi(inPath[1]) };
  for (const r of PUBLISHER_DOI_RULES) {
    if (!r.host.test(host)) continue;
    const m = path.match(r.path);
    if (m) return { kind: "doi", value: `${r.prefix}${m[1]}`.toLowerCase() };
  }
  void content;
  return null;
}

/** For a PMC/PubMed record: the work's DOI printed in the page head (the Crossref fallback key). */
export function headDoi(content: string, chars = 1500): string | null {
  const m = String(content || "").slice(0, chars).match(DOI_RE);
  return m ? cleanDoi(m[1]) : null;
}

/** Works the body LINKS: every DOI in the text other than the source's own. */
export function linkedDois(content: string, own: Identifier | null, max = 20): string[] {
  const out: string[] = [];
  for (const m of String(content || "").matchAll(DOI_RE_G)) {
    const d = cleanDoi(m[1]);
    if (own?.kind === "doi" && own.value === d) continue;
    if (!out.includes(d)) out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

// ── egress ────────────────────────────────────────────────────────────────

const PROXIED = Symbol("proxied-fetch");
export type ProxiedFetch = ((url: string, init?: RequestInit) => Promise<Response>) & { [PROXIED]: true; egress: string };

/**
 * Wrap fetch so EVERY call carries the egress proxy client. `client` is the Deno.HttpClient the
 * page fetcher built from FETCH_PROXY_URL; null only when the operator configured FETCH_PROXY_URL=""
 * (the documented explicit-direct choice), and then `direct` must say so - a missing client is
 * never silently direct.
 */
export function proxiedFetch(
  raw: (url: string, init?: RequestInit & { client?: unknown }) => Promise<Response>,
  client: unknown,
  opts: { direct?: boolean } = {},
): ProxiedFetch {
  if (!client && !opts.direct) {
    throw new Error("scholarly resolver refused: no egress proxy client (FETCH_PROXY_URL) and direct egress was not configured");
  }
  const f = ((url: string, init: RequestInit = {}) =>
    raw(url, client ? { ...init, client } : init)) as ProxiedFetch;
  f[PROXIED] = true;
  f.egress = client ? "proxy" : "direct (FETCH_PROXY_URL is empty by configuration)";
  return f;
}

export interface ResolverConfig {
  fetch: ProxiedFetch;
  openalexKey: string;
  mailto: string;
  timeoutMs?: number;
  maxAuthors?: number;
  now?: () => Date;
}

export interface ScholarlyResolver {
  resolve(id: Identifier, fallbackDoi?: string | null): Promise<ScholarlyRecord>;
  readonly egress: string;
}

export function createScholarlyResolver(cfg: ResolverConfig): ScholarlyResolver {
  if (!cfg.fetch || (cfg.fetch as ProxiedFetch)[PROXIED] !== true) {
    throw new Error("scholarly resolver refused: its fetch must be built by proxiedFetch() (the FETCH_PROXY_URL egress)");
  }
  const now = cfg.now ?? (() => new Date());
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const maxAuthors = cfg.maxAuthors ?? 10;
  const get = async (url: string): Promise<{ status: number; body: unknown }> => {
    const r = await cfg.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  };
  const oa = (path: string, extra = "") =>
    `https://api.openalex.org/${path}?api_key=${encodeURIComponent(cfg.openalexKey)}&mailto=${encodeURIComponent(cfg.mailto)}${extra}`;
  // attempt 3 (tester near-miss): a 200 answer whose stored fields carry the request's key, mailto
  // or any URL query - or anything credential-shaped - is not stored: the answer is UNREADABLE
  // (the next service is tried, else the record is unresolved with the code)
  const secrets = [cfg.openalexKey, cfg.mailto].filter((x) => x && x.length >= 4)
    .flatMap((x) => [x, encodeURIComponent(x)]).map((x) => x.toLowerCase());
  const tainted = (rec: ScholarlyRecord): boolean => {
    const texts = [rec.doi, rec.published, rec.identifier?.value, ...rec.authors.flatMap((a) => [a.id, a.name])]
      .filter((x): x is string => typeof x === "string");
    return texts.some((t) => credentialShaped(t) || secrets.some((k) => t.toLowerCase().includes(k)));
  };

  const unresolved = (id: Identifier, reason: string, doi: string | null = null): ScholarlyRecord => ({
    state: "unresolved", identifier: id, doi, cited_by: null, published: null, authors: [],
    resolved_at: now().toISOString(), via: null, reason,
  });

  async function viaOpenAlex(id: Identifier): Promise<ScholarlyRecord | string> {
    if (!cfg.openalexKey) return "OpenAlex not keyed";
    const key = id.kind === "arxiv" ? `doi:10.48550/arxiv.${id.value}` : `${id.kind}:${id.value}`;
    let w: { status: number; body: unknown };
    try { w = await get(oa(`works/${encodeURIComponent(key)}`)); } catch (e) { return `OpenAlex ${errorClass(e)} (${OPENALEX_HOST})`; }
    if (w.status !== 200) return `OpenAlex ${String(w.status).padStart(3, "0").slice(0, 3)} (${OPENALEX_HOST})`;
    if (!w.body || typeof w.body !== "object" || Array.isArray(w.body)) return `OpenAlex unreadable answer (${OPENALEX_HOST})`;
    const work = w.body as Record<string, unknown>;
    // attempt 3 (tester near-miss: a 200 JSON error body resolved as `resolved` with null counts -
    // the scholarly family, paper base, on an error answer): a work is an OpenAlex work id; an
    // `error` / `message` member or a missing id is an error answer, never a resolution
    if ("error" in work || "message" in work || typeof work.id !== "string" || !/^https:\/\/openalex\.org\/W\d+$/.test(work.id)) {
      return `OpenAlex unreadable answer (${OPENALEX_HOST})`;
    }
    const auths = (Array.isArray(work.authorships) ? work.authorships : []).slice(0, maxAuthors) as Array<Record<string, unknown>>;
    const ids = auths.map((a) => String((a.author as Record<string, unknown>)?.id ?? "")).filter(Boolean);
    const counts = new Map<string, number>();
    let authorNote = "";
    if (ids.length) {
      const filter = ids.map((x) => x.replace(/^https?:\/\/openalex\.org\//, "")).join("|");
      try {
        const a = await get(oa("authors", `&filter=${encodeURIComponent(`openalex:${filter}`)}&select=id,works_count&per-page=${maxAuthors}`));
        const results = (a.body as Record<string, unknown>)?.results;
        if (a.status === 200 && Array.isArray(results)) {
          for (const r of results as Array<Record<string, unknown>>) {
            if (typeof r.works_count === "number") counts.set(String(r.id), r.works_count);
          }
        } else authorNote = `OpenAlex authors ${a.status === 200 ? "unreadable answer" : String(a.status).slice(0, 3)} (${OPENALEX_HOST})`;
      } catch (e) { authorNote = `OpenAlex authors ${errorClass(e)} (${OPENALEX_HOST})`; }
    }
    const authors: ScholarlyAuthor[] = auths.map((a) => {
      const au = (a.author ?? {}) as Record<string, unknown>;
      const aid = au.id ? String(au.id) : null;
      return { id: aid, name: au.display_name ? String(au.display_name) : null, works_count: aid && counts.has(aid) ? counts.get(aid)! : null };
    });
    const doi = typeof work.doi === "string" ? cleanDoi(work.doi.replace(/^https?:\/\/doi\.org\//i, "")) : (id.kind === "doi" ? id.value : null);
    const rec: ScholarlyRecord = {
      state: "resolved", identifier: id, doi,
      cited_by: typeof work.cited_by_count === "number" ? work.cited_by_count : null,
      published: typeof work.publication_date === "string" ? work.publication_date : null,
      authors, resolved_at: now().toISOString(), via: "openalex",
      ...(authorNote ? { reason: authorNote } : {}),
    };
    return tainted(rec) ? `OpenAlex unreadable answer (${OPENALEX_HOST})` : rec;
  }

  async function viaCrossref(id: Identifier, doi: string): Promise<ScholarlyRecord | string> {
    let r: { status: number; body: unknown };
    try { r = await get(`https://${CROSSREF_HOST}/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(cfg.mailto)}`); }
    catch (e) { return `Crossref ${errorClass(e)} (${CROSSREF_HOST})`; }
    const body = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
    const msg = body.message as Record<string, unknown> | undefined;
    if (r.status !== 200) return `Crossref ${String(r.status).slice(0, 3)} (${CROSSREF_HOST})`;
    // attempt 3: a Crossref work answer is {status: "ok", message: {DOI, ...}}; an error answer
    // ({status: "failed", message: [...]}) or one without the DOI is unreadable, never resolved
    if (body.status !== "ok" || !msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.DOI !== "string") {
      return `Crossref unreadable answer (${CROSSREF_HOST})`;
    }
    const parts = ((msg.published ?? msg["published-print"] ?? msg["published-online"] ?? msg.issued) as Record<string, unknown> | undefined)?.["date-parts"];
    const dp = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] as number[] : [];
    const published = dp.length ? [dp[0], dp[1] ?? 1, dp[2] ?? 1].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : null;
    const authors: ScholarlyAuthor[] = (Array.isArray(msg.author) ? msg.author : []).slice(0, maxAuthors)
      .map((a: Record<string, unknown>) => ({
        id: typeof a.ORCID === "string" ? a.ORCID : null,
        name: [a.given, a.family].filter(Boolean).join(" ") || null,
        works_count: null,                       // Crossref keeps no author records: unresolved, not 0
      }));
    const rec: ScholarlyRecord = {
      state: "resolved", identifier: id, doi: cleanDoi(String(msg.DOI ?? doi)),
      cited_by: typeof msg["is-referenced-by-count"] === "number" ? msg["is-referenced-by-count"] as number : null,
      published, authors, resolved_at: now().toISOString(), via: "crossref",
      reason: "Crossref fallback: author works_count unresolved",
    };
    return tainted(rec) ? `Crossref unreadable answer (${CROSSREF_HOST})` : rec;
  }

  return {
    egress: cfg.fetch.egress,
    async resolve(id: Identifier, fallbackDoi: string | null = null): Promise<ScholarlyRecord> {
      const first = await viaOpenAlex(id);
      if (typeof first !== "string") return first;
      const doi = id.kind === "doi" ? id.value : (id.kind === "arxiv" ? `10.48550/arxiv.${id.value}` : fallbackDoi);
      if (!doi) return unresolved(id, `${first}; no DOI to try Crossref with`);
      // (every branch below joins codes only: `first` and `second` are reason codes)
      const second = await viaCrossref(id, doi);
      if (typeof second !== "string") return { ...second, reason: `${first}; ${second.reason}` };
      return unresolved(id, `${first}; ${second}`, doi);
    },
  };
}
