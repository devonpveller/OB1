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

  const unresolved = (id: Identifier, reason: string, doi: string | null = null): ScholarlyRecord => ({
    state: "unresolved", identifier: id, doi, cited_by: null, published: null, authors: [],
    resolved_at: now().toISOString(), via: null, reason,
  });

  async function viaOpenAlex(id: Identifier): Promise<ScholarlyRecord | string> {
    if (!cfg.openalexKey) return "OpenAlex not tried: OPENALEX_API_KEY is not configured (the client is keyed)";
    const key = id.kind === "arxiv" ? `doi:10.48550/arxiv.${id.value}` : `${id.kind}:${id.value}`;
    let w: { status: number; body: unknown };
    try { w = await get(oa(`works/${encodeURIComponent(key)}`)); } catch (e) { return `OpenAlex error: ${(e as Error).message}`; }
    if (w.status !== 200 || !w.body || typeof w.body !== "object") return `OpenAlex ${w.status} for ${key}`;
    const work = w.body as Record<string, unknown>;
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
        } else authorNote = `author records: OpenAlex ${a.status}`;
      } catch (e) { authorNote = `author records: ${(e as Error).message}`; }
    }
    const authors: ScholarlyAuthor[] = auths.map((a) => {
      const au = (a.author ?? {}) as Record<string, unknown>;
      const aid = au.id ? String(au.id) : null;
      return { id: aid, name: au.display_name ? String(au.display_name) : null, works_count: aid && counts.has(aid) ? counts.get(aid)! : null };
    });
    const doi = typeof work.doi === "string" ? cleanDoi(work.doi.replace(/^https?:\/\/doi\.org\//i, "")) : (id.kind === "doi" ? id.value : null);
    return {
      state: "resolved", identifier: id, doi,
      cited_by: typeof work.cited_by_count === "number" ? work.cited_by_count : null,
      published: typeof work.publication_date === "string" ? work.publication_date : null,
      authors, resolved_at: now().toISOString(), via: "openalex",
      ...(authorNote ? { reason: authorNote } : {}),
    };
  }

  async function viaCrossref(id: Identifier, doi: string): Promise<ScholarlyRecord | string> {
    let r: { status: number; body: unknown };
    try { r = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(cfg.mailto)}`); }
    catch (e) { return `Crossref error: ${(e as Error).message}`; }
    const msg = (r.body as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
    if (r.status !== 200 || !msg) return `Crossref ${r.status} for ${doi}`;
    const parts = ((msg.published ?? msg["published-print"] ?? msg["published-online"] ?? msg.issued) as Record<string, unknown> | undefined)?.["date-parts"];
    const dp = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] as number[] : [];
    const published = dp.length ? [dp[0], dp[1] ?? 1, dp[2] ?? 1].map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : null;
    const authors: ScholarlyAuthor[] = (Array.isArray(msg.author) ? msg.author : []).slice(0, maxAuthors)
      .map((a: Record<string, unknown>) => ({
        id: typeof a.ORCID === "string" ? a.ORCID : null,
        name: [a.given, a.family].filter(Boolean).join(" ") || null,
        works_count: null,                       // Crossref keeps no author records: unresolved, not 0
      }));
    return {
      state: "resolved", identifier: id, doi: cleanDoi(String(msg.DOI ?? doi)),
      cited_by: typeof msg["is-referenced-by-count"] === "number" ? msg["is-referenced-by-count"] as number : null,
      published, authors, resolved_at: now().toISOString(), via: "crossref",
      reason: "Crossref fallback: author works_count unresolved (Crossref holds no author records)",
    };
  }

  return {
    egress: cfg.fetch.egress,
    async resolve(id: Identifier, fallbackDoi: string | null = null): Promise<ScholarlyRecord> {
      const first = await viaOpenAlex(id);
      if (typeof first !== "string") return first;
      const doi = id.kind === "doi" ? id.value : (id.kind === "arxiv" ? `10.48550/arxiv.${id.value}` : fallbackDoi);
      if (!doi) return unresolved(id, `${first}; no DOI to try Crossref with`);
      const second = await viaCrossref(id, doi);
      if (typeof second !== "string") return { ...second, reason: `${first}; ${second.reason}` };
      return unresolved(id, `${first}; ${second}`, doi);
    },
  };
}
