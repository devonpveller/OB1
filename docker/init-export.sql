-- ============================================================
-- Research workbench P6a - resolver, citeproc, Typst (rw-p6a-resolve).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P6a, 01-OPEN-ITEMS.md D9 (licence policy) / D15 (resolver) / D18, 06-EXPANSION.md.
--
-- The export renders a document's numbered references through pandoc --citeproc with a CSL style,
-- from canonical metadata resolved by persistent identifier. Three registries (D18: declared,
-- versioned entries, never a closed list in code) and one cache table:
--   export_formats              what the export can produce. definition: pandoc_to, ext, mime and,
--                               for a PDF, the engine and the page metadata (paper, margins, font)
--                               handed to pandoc as a metadata file. A new format is a row here.
--   citation_styles             the CSL styles a document can be exported in. definition: the file
--                               shipped in the image (workbench/csl/), its sha256 (the file is the
--                               upstream file UNMODIFIED - CC BY-SA 3.0, so never edited), the
--                               upstream repo/commit/path, the style's own author and contributor
--                               listing, its citation format and whether it is the default. A new
--                               style is its .csl file plus a row here.
--   reference_identifier_kinds  persistent identifiers the resolver understands (the manubot citekey
--                               grammar, pinned at manubot 859dd15): the accession pattern, the
--                               prefixes, the URL rules that recognise the identifier in a source
--                               URL, and the OpenAlex work key / Crossref DOI templates the resolver
--                               fills in. A new identifier kind is a row here (no code).
--   reference_resolutions       the CSL-JSON a reference resolved to, cached ON THE REFERENCE RECORD
--                               at its pinned revision, so an export is deterministic offline: the
--                               resolver is called only for a reference that has no row yet.
--
-- The grounding chain (sources -> claims -> reports) is untouched. Conventions mirror
-- init-references.sql: idempotent, additive, RLS on with a service_role FOR ALL policy. Mounted in
-- compose as 250-init-export.sql (after P2a's 240 slot, whose reference_records it caches on).
-- Fresh-volume only; the live DB gets it by hand (psql -f, the operator's gated deploy).
-- Revert: revert-export.sql.
-- ============================================================

-- ── 1. registries ───────────────────────────────────────────────────────
INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('export_formats',             'P6a', 'what GET /workbench/export produces; definition.pandoc_to / ext / mime, and for a PDF the engine and its page metadata'),
    ('citation_styles',            'P6a', 'CSL styles, used unmodified (CC BY-SA 3.0); definition.file / sha256 / upstream / authors / contributors / citation_format / default'),
    ('reference_identifier_kinds', 'P6a', 'persistent identifiers the resolver understands; definition.pattern / prefixes / url_rules / openalex_work / crossref_doi')
ON CONFLICT (name) DO NOTHING;

-- Written as upserts so a re-run converges on the CURRENT definitions.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('export_formats', 'pdf', 'PDF (Typst)',
        '{"pandoc_to":"pdf","ext":"pdf","mime":"application/pdf","engine":"typst","binary":true,"default":true,
          "metadata":{"papersize":"a4","margin":{"x":"2.5cm","y":"2.5cm"},"fontsize":"11pt","mainfont":"Noto Serif CJK SC"}}'),
    ('export_formats', 'docx', 'Word (DOCX)',
        '{"pandoc_to":"docx","ext":"docx","mime":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","binary":true}'),
    -- md: pandoc Markdown with the references rendered as text (citations, divs, spans, header
    -- attributes and raw HTML off), so the file reads as plain Markdown.
    ('export_formats', 'md', 'Markdown (references rendered)',
        '{"pandoc_to":"markdown-citations-native_divs-native_spans-fenced_divs-bracketed_spans-header_attributes-raw_html","ext":"md","mime":"text/markdown; charset=utf-8"}'),
    ('export_formats', 'txt', 'Plain text',
        '{"pandoc_to":"plain","ext":"txt","mime":"text/plain; charset=utf-8"}'),

    ('citation_styles', 'ieee', 'IEEE Reference Guide version 11.29.2023',
        '{"file":"ieee.csl","sha256":"b4c7619fc16c45a31e4cc3271eab94ffe83192d3b4c7fc729470a3b459448de3","citation_format":"numeric","default":true,
          "licence":"CC-BY-SA-3.0","upstream":{"repo":"https://github.com/citation-style-language/styles","commit":"0e5503bd9a75668c402567a93e20b7327784e4fa","path":"ieee.csl"},
          "authors":["Michael Berkowitz"],
          "contributors":["Julian Onions","Rintze Zelle","Stephen Frank","Sebastian Karcher","Giuseppe Silano","Patrick O''Brien","Brenton M. Wiernik","Oliver Couch","Andrew Dunning"]}'),
    ('citation_styles', 'elsevier-vancouver', 'Elsevier - NLM/Vancouver (citation-sequence)',
        '{"file":"elsevier-vancouver.csl","sha256":"005e915c3419eb2b84eb2b31bffc411dce3890619d3fd0ed23ac6591ac128335","citation_format":"numeric",
          "licence":"CC-BY-SA-3.0","upstream":{"repo":"https://github.com/citation-style-language/styles","commit":"0e5503bd9a75668c402567a93e20b7327784e4fa","path":"elsevier-vancouver.csl"},
          "authors":["Richard Karnesky"],"contributors":[]}'),
    ('citation_styles', 'apa', 'APA Style 7th edition',
        '{"file":"apa.csl","sha256":"3917def5fc951b104d64216c3373096042368b9704ba269ca83c14ebaba889fc","citation_format":"author-date",
          "licence":"CC-BY-SA-3.0","upstream":{"repo":"https://github.com/citation-style-language/styles","commit":"0e5503bd9a75668c402567a93e20b7327784e4fa","path":"apa.csl"},
          "authors":["Brenton M. Wiernik","Andrew Dunning"],"contributors":["Jay Pfaffman"]}'),

    -- The citekey grammar of manubot 859dd15 (manubot/cite/doi.py, arxiv.py, pubmed.py,
    -- citekey.py url_to_citekey), plus OpenAlex work ids. `lower` = the accession is
    -- case-insensitive and standardised to lower case (manubot Handler_DOI). Templates take
    -- {accession}; a null template means that service cannot resolve the kind.
    ('reference_identifier_kinds', 'doi', 'DOI',
        '{"prefixes":["doi"],"pattern":"10\\.[0-9]{4,9}/\\S+","lower":true,
          "url_rules":[{"host":"doi.org","path":"^/(10\\..+)$"},{"host":"dx.doi.org","path":"^/(10\\..+)$"}],
          "openalex_work":"doi:{accession}","crossref_doi":"{accession}"}'),
    ('reference_identifier_kinds', 'arxiv', 'arXiv identifier',
        '{"prefixes":["arxiv"],"pattern":"([0-9]{4}\\.[0-9]{4,5}|[a-z\\-]+(\\.[A-Z]{2})?/[0-9]{7})(v[0-9]+)?",
          "url_rules":[{"host":"arxiv.org","path":"^/(?:abs|pdf)/(.+?)(?:\\.pdf)?$"}],
          "openalex_work":"doi:10.48550/arxiv.{accession}","crossref_doi":null}'),
    ('reference_identifier_kinds', 'pubmed', 'PubMed id',
        '{"prefixes":["pubmed","pmid"],"pattern":"[1-9][0-9]{0,7}",
          "url_rules":[{"host":"pubmed.ncbi.nlm.nih.gov","path":"^/([1-9][0-9]{0,7})/?$"},{"host":"www.ncbi.nlm.nih.gov","path":"^/pubmed/([1-9][0-9]{0,7})/?$"}],
          "openalex_work":"pmid:{accession}","crossref_doi":null}'),
    ('reference_identifier_kinds', 'pmc', 'PubMed Central id',
        '{"prefixes":["pmc","pmcid"],"pattern":"PMC[0-9]+",
          "url_rules":[{"host":"pmc.ncbi.nlm.nih.gov","path":"^/articles/(PMC[0-9]+)/?$"},{"host":"www.ncbi.nlm.nih.gov","path":"^/pmc/articles/(PMC[0-9]+)/?$"}],
          "openalex_work":"pmcid:{accession}","crossref_doi":null}'),
    ('reference_identifier_kinds', 'openalex', 'OpenAlex work id',
        '{"prefixes":["openalex"],"pattern":"W[0-9]+",
          "url_rules":[{"host":"openalex.org","path":"^/(W[0-9]+)$"},{"host":"api.openalex.org","path":"^/works/(W[0-9]+)$"}],
          "openalex_work":"{accession}","crossref_doi":null}')
ON CONFLICT (registry, key) DO UPDATE SET label = EXCLUDED.label, definition = EXCLUDED.definition;

-- ── 2. the resolution cache, on the reference record ────────────────────
-- One row per reference and identifier: the reference's pin never moves (P2a), so the metadata it
-- resolved to is fixed with it. `identifier` is the standard citekey (doi:10.1/x, arxiv:2101.00001);
-- a source whose identifier changes resolves anew under the new key. `via` names the service that
-- answered (openalex | crossref); `csl` is the CSL-JSON item without its id (the export assigns ids).
CREATE TABLE IF NOT EXISTS public.reference_resolutions (
    reference_id    UUID NOT NULL REFERENCES public.reference_records(id) ON DELETE CASCADE,
    identifier      TEXT NOT NULL CHECK (identifier ~ '^[a-z][a-z0-9]*:.+$'),
    pinned_revision INT  NOT NULL CHECK (pinned_revision >= 1),
    csl             JSONB NOT NULL CHECK (jsonb_typeof(csl) = 'object' AND csl ? 'type' AND csl ? 'title'),
    via             TEXT NOT NULL CHECK (via IN ('openalex', 'crossref')),
    resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (reference_id, identifier)
);

-- The cached revision is the reference's pin, never another: a row that disagrees is refused.
CREATE OR REPLACE FUNCTION public.reference_resolutions_validate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE pin INT;
BEGIN
    SELECT r.pinned_revision INTO pin FROM public.reference_records r WHERE r.id = NEW.reference_id;
    IF pin IS NULL OR pin <> NEW.pinned_revision THEN
        RAISE EXCEPTION 'a resolution is cached at its reference''s pinned revision (%), not %', pin, NEW.pinned_revision
            USING ERRCODE = 'OBR02';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reference_resolutions_validate ON public.reference_resolutions;
CREATE TRIGGER trg_reference_resolutions_validate
    BEFORE INSERT OR UPDATE ON public.reference_resolutions
    FOR EACH ROW EXECUTE FUNCTION public.reference_resolutions_validate();

-- ── 3. RLS + grants (the P0 shape) ──────────────────────────────────────
ALTER TABLE public.reference_resolutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reference_resolutions_service_role_all ON public.reference_resolutions;
CREATE POLICY reference_resolutions_service_role_all ON public.reference_resolutions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.reference_resolutions TO service_role;

NOTIFY pgrst, 'reload schema';
