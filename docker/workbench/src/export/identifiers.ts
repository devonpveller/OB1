// Persistent identifiers of a source (research-workbench P6a). PURE: no DB, no network.
//
// The grammar is manubot's citekey grammar at its pinned trunk commit 859dd15 (2026-08-02),
// PORTED to TypeScript rather than run: manubot's own retrievers call doi.org, shortdoi.org, NCBI
// E-utilities and a Zotero translation-server (AGPL, design-only under D9) with a User-Agent that
// carries its author's address, none of which this product may call (acceptance 3, POSTURE.md).
// What is ported, from manubot/cite at 859dd15 (BSD-2-Clause-Plus-Patent, Copyright (c) 2017-2020,
// Contributors & the Greene Lab at the University of Pennsylvania; notice in THIRD-PARTY-NOTICES.md):
//   - citekey.py CiteKey: `prefix:accession`, the prefix matched case-insensitively against each
//     handler's prefixes and replaced by its standard prefix (_set_prefix_accession,
//     standard_prefix);
//   - doi.py Handler_DOI.inspect / standardize_prefix_accession: the DOI regex, lower-cased;
//   - arxiv.py / pubmed.py accession patterns;
//   - citekey.py url_to_citekey: an identifier recognised in a source URL (doi.org, arxiv.org
//     abs/pdf, PubMed, PMC).
// The kinds themselves are DATA: rows of the reference_identifier_kinds registry (init-export.sql),
// each with its pattern, prefixes, URL rules and the metadata keys a source declares it under. A new
// kind is a row, not code.
//
// rw-p6a-resolve attempt 2 (tester ADV-2c): manubot's DOI grammar `10\.[0-9]{4,9}/\S+` accepted `@`,
// `..`, a query, a second DOI after a comma, non-ASCII and 2 KB of text, all of which were sent. The
// registry's DOI pattern is now Crossref's recommended character class (plus SICI's `<>`), with no
// `..`, no `//` and no second `10.NNNN/`; and every kind passes the guard below (<= 256 characters,
// no whitespace or control character) BEFORE anything is requested. A URL whose host and path match
// a kind's URL rule CLAIMS that kind: an accession there that fails the grammar is malformed (the
// export names it), not silently a web page - a deliberate departure from manubot's url_to_citekey.

export interface IdentifierKind {
  key: string; // the standard prefix, a key of reference_identifier_kinds
  prefixes: string[];
  pattern: string; // the accession, matched in full
  lower?: boolean;
  url_rules?: { host: string; path: string }[];
  metadata_keys?: string[]; // source metadata fields (dotted paths) that declare this kind
  openalex_work?: string | null; // template over {accession}
  crossref_doi?: string | null; // template over {accession}
}

export interface Identifier {
  kind: string;
  accession: string;
  citekey: string; // `${kind}:${accession}` - the cache key
}

export class IdentifierError extends Error {}

export const MAX_ACCESSION = 256;

// The grammar check every identifier passes before it is cached, rendered or requested: the kind's
// pattern in full, at most 256 characters, no whitespace and no control character.
export function accessionOk(kind: IdentifierKind, acc: string): boolean {
  return acc.length > 0 && acc.length <= MAX_ACCESSION && !/[\s\x00-\x1f\x7f]/.test(acc) &&
    new RegExp(`^(?:${kind.pattern})$`).test(acc);
}

// What an error message may quote of an accession: short, printable ASCII only.
const quoted = (s: string) => s.length > 80 || /[^\x20-\x7e]/.test(s) ? `${s.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")}... (${s.length} characters)` : s;

function standardize(kind: IdentifierKind, accession: string): Identifier {
  const acc = kind.lower ? accession.toLowerCase() : accession;
  if (!accessionOk(kind, acc)) {
    throw new IdentifierError(`'${quoted(accession)}' is not a valid ${kind.key} identifier`);
  }
  return { kind: kind.key, accession: acc, citekey: `${kind.key}:${acc}` };
}

// A citekey as written (`doi:10.1/X`, `PMID:123`) -> the standard identifier. An unknown prefix or
// an accession that fails the kind's pattern throws (manubot's inspect()).
export function parseCitekey(kinds: IdentifierKind[], citekey: string): Identifier {
  const i = citekey.indexOf(":");
  if (i <= 0) throw new IdentifierError(`'${citekey}' has no identifier prefix`);
  const prefix = citekey.slice(0, i).toLowerCase();
  const kind = kinds.find((k) => k.prefixes.includes(prefix));
  if (!kind) throw new IdentifierError(`'${prefix}' is not a known identifier prefix`);
  return standardize(kind, citekey.slice(i + 1).trim()); // inner whitespace still fails the guard
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// manubot url_to_citekey, data-driven: the first kind whose URL rule matches the host and path. A
// rule that matches with an accession outside the grammar throws (the URL claims the kind).
export function identifierFromUrl(kinds: IdentifierKind[], url: string | null | undefined): Identifier | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = decode(u.pathname);
  for (const k of kinds) {
    for (const r of k.url_rules ?? []) {
      if (host !== r.host && !host.endsWith(`.${r.host}`)) continue;
      const m = new RegExp(r.path).exec(path);
      if (!m) continue;
      return standardize(k, m[1]); // the path is the claim (a query or fragment is not part of an id)
    }
  }
  return null;
}

// A dotted metadata path (`scholarly.doi`) read from a source's metadata.
function at(md: Record<string, unknown>, path: string): unknown {
  let v: unknown = md;
  for (const part of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

// The source's OWN identifier: declared metadata first - the fields each kind's registry row names
// in `metadata_keys` (doi + the P3a scholarly record's scholarly.doi, arxiv, pmid, pmcid, openalex),
// kinds in registry order - then its URL. A declared value written as a URL is read through that
// kind's own URL rules. A DOI LINKED in the body is never the source's identifier (D15 item 3). A
// declared but malformed identifier throws.
export function sourceIdentifier(
  kinds: IdentifierKind[],
  src: { url: string | null; metadata: Record<string, unknown> | null },
): Identifier | null {
  const md = src.metadata ?? {};
  for (const k of kinds) {
    for (const key of k.metadata_keys ?? []) {
      const value = at(md, key);
      if (typeof value !== "string" || !value.trim()) continue;
      const v = value.trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
        const id = identifierFromUrl([k], v);
        if (!id) throw new IdentifierError(`metadata ${key} is a URL that is not a ${k.key} URL`);
        return id;
      }
      return standardize(k, v);
    }
  }
  return identifierFromUrl(kinds, src.url);
}

export function fill(template: string, id: Identifier): string {
  return template.replaceAll("{accession}", id.accession);
}
