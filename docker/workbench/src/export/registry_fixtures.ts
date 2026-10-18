// The P6a registry entries as the image test gate sees them (the migration is outside the image's
// build context). export_test.ts checks, whenever init-export.sql is reachable (the repo), that
// these are EXACTLY the rows the migration seeds - so the gate tests the real definitions.
import type { RegistryEntry } from "../contracts/registry.ts";

const e = (registry: string, key: string, label: string, definition: Record<string, unknown>): RegistryEntry => ({
  registry, key, version: 1, label, definition, retired_at: null, superseded_by: null,
});

const STYLES_REPO = "https://github.com/citation-style-language/styles";
const STYLES_COMMIT = "0e5503bd9a75668c402567a93e20b7327784e4fa";

export const FX_ENTRIES: RegistryEntry[] = [
  e("export_formats", "pdf", "PDF (Typst)", {
    pandoc_to: "pdf", ext: "pdf", mime: "application/pdf", engine: "typst", binary: true, default: true, glyph_check: true,
    metadata: { papersize: "a4", margin: { x: "2.5cm", y: "2.5cm" }, fontsize: "11pt", mainfont: "Noto Serif CJK SC" },
  }),
  e("export_formats", "docx", "Word (DOCX)", {
    pandoc_to: "docx", ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", binary: true,
  }),
  e("export_formats", "md", "Markdown (references rendered)", { pandoc_to: "markdown-citations-native_divs-native_spans-fenced_divs-bracketed_spans-header_attributes-raw_html-raw_attribute-raw_tex", ext: "md", mime: "text/markdown; charset=utf-8" }),
  e("export_formats", "txt", "Plain text", { pandoc_to: "plain", ext: "txt", mime: "text/plain; charset=utf-8", copy: true }),
  e("citation_styles", "ieee", "IEEE Reference Guide version 11.29.2023", {
    file: "ieee.csl", sha256: "b4c7619fc16c45a31e4cc3271eab94ffe83192d3b4c7fc729470a3b459448de3", citation_format: "numeric", default: true,
    licence: "CC-BY-SA-3.0", upstream: { repo: STYLES_REPO, commit: STYLES_COMMIT, path: "ieee.csl" },
    authors: ["Michael Berkowitz"],
    contributors: ["Julian Onions", "Rintze Zelle", "Stephen Frank", "Sebastian Karcher", "Giuseppe Silano", "Patrick O'Brien", "Brenton M. Wiernik", "Oliver Couch", "Andrew Dunning"],
  }),
  e("citation_styles", "elsevier-vancouver", "Elsevier - NLM/Vancouver (citation-sequence)", {
    file: "elsevier-vancouver.csl", sha256: "005e915c3419eb2b84eb2b31bffc411dce3890619d3fd0ed23ac6591ac128335", citation_format: "numeric",
    licence: "CC-BY-SA-3.0", upstream: { repo: STYLES_REPO, commit: STYLES_COMMIT, path: "elsevier-vancouver.csl" },
    authors: ["Richard Karnesky"], contributors: [],
  }),
  e("citation_styles", "apa", "APA Style 7th edition", {
    file: "apa.csl", sha256: "3917def5fc951b104d64216c3373096042368b9704ba269ca83c14ebaba889fc", citation_format: "author-date",
    licence: "CC-BY-SA-3.0", upstream: { repo: STYLES_REPO, commit: STYLES_COMMIT, path: "apa.csl" },
    authors: ["Brenton M. Wiernik", "Andrew Dunning"], contributors: ["Jay Pfaffman"],
  }),
  e("reference_identifier_kinds", "doi", "DOI", {
    prefixes: ["doi"], pattern: "(?!.*\\.\\.)(?!.*//)(?!.+10\\.[0-9]{4,9}/)10\\.[0-9]{4,9}/[-._;()/:<>A-Za-z0-9]+", lower: true, metadata_keys: ["doi", "scholarly.doi"],
    url_rules: [{ host: "doi.org", path: "^/(10\\..+)$" }, { host: "dx.doi.org", path: "^/(10\\..+)$" }],
    openalex_work: "doi:{accession}", crossref_doi: "{accession}",
  }),
  e("reference_identifier_kinds", "arxiv", "arXiv identifier", {
    prefixes: ["arxiv"], metadata_keys: ["arxiv"], pattern: "([0-9]{4}\\.[0-9]{4,5}|[a-z\\-]+(\\.[A-Z]{2})?/[0-9]{7})(v[0-9]+)?",
    url_rules: [{ host: "arxiv.org", path: "^/(?:abs|pdf)/(.+?)(?:\\.pdf)?$" }],
    openalex_work: "doi:10.48550/arxiv.{accession}", crossref_doi: null,
  }),
  e("reference_identifier_kinds", "pubmed", "PubMed id", {
    prefixes: ["pubmed", "pmid"], metadata_keys: ["pmid"], pattern: "[1-9][0-9]{0,7}",
    url_rules: [{ host: "pubmed.ncbi.nlm.nih.gov", path: "^/([1-9][0-9]{0,7})/?$" }, { host: "www.ncbi.nlm.nih.gov", path: "^/pubmed/([1-9][0-9]{0,7})/?$" }],
    openalex_work: "pmid:{accession}", crossref_doi: null,
  }),
  e("reference_identifier_kinds", "pmc", "PubMed Central id", {
    prefixes: ["pmc", "pmcid"], metadata_keys: ["pmcid"], pattern: "PMC[0-9]+",
    url_rules: [{ host: "pmc.ncbi.nlm.nih.gov", path: "^/articles/(PMC[0-9]+)/?$" }, { host: "www.ncbi.nlm.nih.gov", path: "^/pmc/articles/(PMC[0-9]+)/?$" }],
    openalex_work: "pmcid:{accession}", crossref_doi: null,
  }),
  e("reference_identifier_kinds", "openalex", "OpenAlex work id", {
    prefixes: ["openalex"], metadata_keys: ["openalex"], pattern: "W[0-9]+",
    url_rules: [{ host: "openalex.org", path: "^/(W[0-9]+)$" }, { host: "api.openalex.org", path: "^/works/(W[0-9]+)$" }],
    openalex_work: "{accession}", crossref_doi: null,
  }),
];

export const fxEntries = (registry: string) => FX_ENTRIES.filter((x) => x.registry === registry);
