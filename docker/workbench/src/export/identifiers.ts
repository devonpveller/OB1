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
// each with its pattern, prefixes and URL rules. A new kind is a row, not code.

export interface IdentifierKind {
  key: string; // the standard prefix, a key of reference_identifier_kinds
  prefixes: string[];
  pattern: string; // the accession, matched in full
  lower?: boolean;
  url_rules?: { host: string; path: string }[];
  openalex_work?: string | null; // template over {accession}
  crossref_doi?: string | null; // template over {accession}
}

export interface Identifier {
  kind: string;
  accession: string;
  citekey: string; // `${kind}:${accession}` - the cache key
}

export class IdentifierError extends Error {}

function standardize(kind: IdentifierKind, accession: string): Identifier {
  const acc = kind.lower ? accession.toLowerCase() : accession;
  if (!new RegExp(`^(?:${kind.pattern})$`).test(acc)) {
    throw new IdentifierError(`'${accession}' is not a valid ${kind.key} identifier`);
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
  return standardize(kind, citekey.slice(i + 1).trim());
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// manubot url_to_citekey, data-driven: the first kind whose URL rule matches the host and path.
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
      try {
        return standardize(k, m[1]);
      } catch {
        // manubot: a URL whose citekey fails inspection stays a URL
      }
    }
  }
  return null;
}

// The source's OWN identifier: declared metadata first (metadata.doi / arxiv / pmid / pmcid /
// openalex, or the P3a scholarly record's doi), then its URL. A DOI LINKED in the body is never
// the source's identifier (D15 item 3).
export function sourceIdentifier(
  kinds: IdentifierKind[],
  src: { url: string | null; metadata: Record<string, unknown> | null },
): Identifier | null {
  const md = src.metadata ?? {};
  const scholarly = (md.scholarly ?? {}) as Record<string, unknown>;
  const declared: [string, unknown][] = [
    ["doi", md.doi ?? scholarly.doi],
    ["arxiv", md.arxiv],
    ["pubmed", md.pmid],
    ["pmc", md.pmcid],
    ["openalex", md.openalex],
  ];
  for (const [prefix, value] of declared) {
    if (typeof value !== "string" || !value.trim()) continue;
    const v = value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^https?:\/\/openalex\.org\//i, "");
    if (!kinds.some((k) => k.prefixes.includes(prefix))) continue;
    return parseCitekey(kinds, `${prefix}:${v}`); // a declared but malformed identifier throws
  }
  return identifierFromUrl(kinds, src.url);
}

export function fill(template: string, id: Identifier): string {
  return template.replaceAll("{accession}", id.accession);
}
