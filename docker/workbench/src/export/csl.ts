// CSL-JSON items from the two metadata services (research-workbench P6a). PURE.
//
// Ported from manubot/cite/csl_item.py at 859dd15 (BSD-2-Clause-Plus-Patent; notice in
// THIRD-PARTY-NOTICES.md): CSL_Item.type_mapping + correct_invalid_type (Crossref work types that
// are not CSL types), set_default_type ("entry"), and date_to_date_parts. manubot's schema pruning
// (remove_jsonschema_errors) fetches the CSL schema from GitHub at run time; instead the items
// here are BUILT from an allow-list of CSL variables, so nothing outside the schema is emitted.

import { defang, noColonRuns } from "./schemes.ts";
import { REAL_TAG } from "./credentials.ts";

export type CslItem = Record<string, unknown> & { type: string; title: string };

// manubot CSL_Item.type_mapping
const CROSSREF_TYPE_MAPPING: Record<string, string> = {
  "journal-article": "article-journal",
  "book-chapter": "chapter",
  "posted-content": "manuscript",
  "proceedings-article": "paper-conference",
  "standard": "entry",
  "reference-entry": "entry",
};

// OpenAlex work types (https://docs.openalex.org, the `type` field) -> CSL types.
const OPENALEX_TYPE_MAPPING: Record<string, string> = {
  "article": "article-journal",
  "book-chapter": "chapter",
  "book": "book",
  "dataset": "dataset",
  "dissertation": "thesis",
  "preprint": "article",
  "report": "report",
  "review": "article-journal",
  "standard": "standard",
  "letter": "article-journal",
  "editorial": "article-journal",
  "paratext": "entry",
  "other": "entry",
};

// manubot date_to_date_parts: YYYY-MM-DD, YYYY-MM or YYYY -> [y, m?, d?]; anything else -> null.
export function dateToDateParts(date: string | null | undefined): number[] | null {
  if (!date) return null;
  const m = /^(?<y>[0-9]{4})(?:-(?<m>1[0-2]|0[1-9])(?:-(?<d>[0-3][0-9]))?)?/.exec(date.trim());
  if (!m?.groups) return null;
  const parts = [m.groups.y, m.groups.m, m.groups.d].filter((x) => x !== undefined).map(Number);
  return parts.length ? parts : null;
}

// The markup citeproc itself understands in a CSL string (rich text: italics, bold, super/subscript,
// small caps, nocase). Any other tag - <script>, <a href>, <img onerror> from an upstream record - is
// removed with its brackets (the text between stays text), and so is an HTML comment (attempt 2,
// ADV-1c: nothing from a record may carry raw HTML into an output).
//
// rw-p6a-resolve attempt 3 (tester ADV-3: a key split by an EMPTY `<i></i>` was cached, and citeproc
// dropped the empty tag, printing the key): only the title fields keep citeproc's markup, and there
// an element with nothing in it is removed (repeatedly, so `<i><b></b></i>` goes too); every other
// field is plain text, every tag stripped. An unsafe-scheme string in any field is defanged
// (markdown.ts defang), so no output carries `javascript:` even as text.
//
// rw-p6a-resolve attempt 4 (tester ADV-4: `Angle < KEY > title` and `<1 KEY>` were kept and printed,
// while the credential check had deleted them as tags): a TAG is only what the strict grammar
// (credentials.ts REAL_TAG) calls one - `<` + a letter or `/` + a name + attributes + `>`. Anything
// else between `<` and `>` is TEXT here and in the credential check alike, so the check sees exactly
// what the outputs print, and refuses the record.
const CITEPROC_TAG = /^<\/?(?:i|b|sup|sub|sc)>$|^<span (?:class="nocase"|style="font-variant:\s*small-caps;?")>$|^<\/span>$/i;
const EMPTY_ELEMENT = /<(i|b|sup|sub|sc)>(\s*)<\/\1>|<span [^>]*>(\s*)<\/span>/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
export function cleanMarkup(s: string): string {
  let t = s.replace(COMMENT, "").replace(REAL_TAG, (m) => CITEPROC_TAG.test(m) ? m : "");
  for (let k = 0; k < 8; k++) {
    const n = t.replace(EMPTY_ELEMENT, (_m, _a, w1, w2) => w1 ?? w2 ?? "");
    if (n === t) break;
    t = n;
  }
  return noColonRuns(defang(t));
}
export const plainText = (s: string) => noColonRuns(defang(s.replace(COMMENT, "").replace(REAL_TAG, "")));

// The CSL variables citeproc renders as rich text; every other string is plain.
export const MARKUP_FIELDS = new Set(["title", "container-title", "collection-title", "original-title", "title-short", "container-title-short"]);

function str(v: unknown, markup = false): string | undefined {
  if (typeof v === "string" && v.trim()) return (markup ? cleanMarkup(v) : plainText(v)).replace(/\s+/g, " ").trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

// A CSL item as the renderer hands it to citeproc - also an item cached BEFORE attempt 3: every
// string field cleaned as above, a URL kept only when it is http(s).
export function renderSafeCsl(item: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (key === "URL") return httpUrl(v);
      return (MARKUP_FIELDS.has(key) ? cleanMarkup(v) : plainText(v)).replace(/\s+/g, " ");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]).filter(([, x]) => x !== undefined));
    return v;
  };
  return walk(item, "") as Record<string, unknown>;
}

function first(v: unknown, markup = false): string | undefined {
  return Array.isArray(v) ? str(v[0], markup) : str(v, markup);
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

export class MetadataIncomplete extends Error {}

function finish(item: Record<string, unknown>, from: string): CslItem {
  const out = compact(item);
  if (!out.title) throw new MetadataIncomplete(`${from} returned a record without a title`);
  out.type = (out.type as string) || "entry"; // manubot set_default_type
  return out as CslItem;
}

// A URL a reference may link to: http(s) only (citeproc renders URL as a link).
const httpUrl = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : undefined;
};

const cleanDoi = (d: unknown) => str(d)?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();

// A Crossref /works/{doi} message -> CSL. Crossref's own fields are mostly CSL variables already.
export function crossrefToCsl(msg: Record<string, unknown>): CslItem {
  const t = str(msg.type);
  const issued = (msg.issued ?? msg.published ?? msg["published-print"] ?? msg["published-online"]) as
    | { "date-parts"?: unknown[][] }
    | undefined;
  const dp = Array.isArray(issued?.["date-parts"]?.[0]) ? (issued!["date-parts"]![0] as unknown[]).filter((n) => typeof n === "number") : [];
  const authors = (Array.isArray(msg.author) ? msg.author : []).map((a: Record<string, unknown>) =>
    compact({ family: str(a.family), given: str(a.given), literal: !a.family ? str(a.name) : undefined })
  ).filter((a) => Object.keys(a).length);
  return finish({
    type: t ? (CROSSREF_TYPE_MAPPING[t] ?? t) : undefined,
    title: first(msg.title, true),
    author: authors.length ? authors : undefined,
    "container-title": first(msg["container-title"], true),
    volume: str(msg.volume),
    issue: str(msg.issue),
    page: str(msg.page),
    publisher: str(msg.publisher),
    issued: dp.length ? { "date-parts": [dp] } : undefined,
    DOI: cleanDoi(msg.DOI),
    ISSN: first(msg.ISSN),
    URL: cleanDoi(msg.DOI) ? `https://doi.org/${cleanDoi(msg.DOI)}` : httpUrl(msg.URL),
  }, "Crossref");
}

// An OpenAlex work -> CSL. OpenAlex gives an author's display name only, so the name is kept whole
// (CSL `literal`) rather than split by guesswork.
export function openalexToCsl(work: Record<string, unknown>): CslItem {
  const t = str(work.type);
  const loc = (work.primary_location ?? {}) as Record<string, unknown>;
  const source = (loc.source ?? {}) as Record<string, unknown>;
  const biblio = (work.biblio ?? {}) as Record<string, unknown>;
  const fp = str(biblio.first_page);
  const lp = str(biblio.last_page);
  const dp = dateToDateParts(str(work.publication_date)) ??
    (typeof work.publication_year === "number" ? [work.publication_year] : null);
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map((a: Record<string, unknown>) => str((a.author as Record<string, unknown> | undefined)?.display_name) ?? str(a.raw_author_name))
    .filter((n): n is string => !!n)
    .map((literal) => ({ literal }));
  const doi = cleanDoi(work.doi);
  return finish({
    type: t ? (OPENALEX_TYPE_MAPPING[t] ?? "entry") : undefined,
    title: str(work.title, true) ?? str(work.display_name, true),
    author: authors.length ? authors : undefined,
    "container-title": str(source.display_name, true),
    volume: str(biblio.volume),
    issue: str(biblio.issue),
    page: fp ? (lp && lp !== fp ? `${fp}-${lp}` : fp) : undefined,
    publisher: str(source.host_organization_name),
    issued: dp ? { "date-parts": [dp] } : undefined,
    DOI: doi,
    URL: doi ? `https://doi.org/${doi}` : httpUrl(work.id),
  }, "OpenAlex");
}

// A source with no persistent identifier is cited as what it is: a web page (or a document
// without a URL), from the source record at the pinned revision. Nothing is resolved for it.
export function recordToCsl(r: { title: string | null; url: string | null; accessed: string | null }): CslItem {
  const dp = dateToDateParts(r.accessed ?? undefined);
  return finish({
    type: httpUrl(r.url) ? "webpage" : "document",
    title: plainText(r.title || "").replace(/\s+/g, " ").trim() || httpUrl(r.url) || "Untitled source",
    URL: httpUrl(r.url),
    accessed: dp ? { "date-parts": [dp] } : undefined,
  }, "the source record");
}
