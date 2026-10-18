-- ============================================================
-- Research workbench P2a - references as first-class records (rw-p2a-refs).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P2a, 01-OPEN-ITEMS.md D12 / D17 / D5 / D18, 06-EXPANSION.md.
--
-- A reference is held ONCE, here, and a note or user document holds its id - never a copy of
-- its pointer, anchor or pin:
--   reference_records       one reference: the source pointer, the anchor selectors (text quote
--                           with prefix/suffix, text position, and page+quad for the content
--                           types the selector registry names), provenance (user | assistant),
--                           the pinned revision of the source and the chunk of it, and a state.
--   reference_holders       who holds which reference, in which order and with which citation
--                           number. A legacy note holds one row per cited source id; a citation
--                           that resolves to no source keeps its row (reference_id NULL) so the
--                           numbering the legacy export printed stays whole - it is not a
--                           reference and nothing lists it as one.
--   reference_holder_state  per holder: when it was migrated, the file hash it was last
--                           reconciled against, the before-counts of the migration (audit), and
--                           removed_at once the note was hard-removed (its pins survive a recover).
-- The pin is set when the reference is placed and never moves: a new revision of the source makes
-- the pin out of date (diffCheck), it does not rewrite it (D17: the document alone defines a pin;
-- pins are per document, so two holders of one source keep two rows).
--
-- Every enumerated kind is a registry (D18): scopes, provenances, states, selector kinds (whose
-- definitions say which fields each needs and for which content types it is required), holder
-- kinds, origins and diffCheck anchor outcomes. The selector rule is enforced HERE, by trigger,
-- so no writer (the API, the migration, a hand INSERT) can store a reference without a quote.
--
-- The grounding chain (sources -> claims -> reports, evidence by chunk) is untouched: nothing in
-- this file reads or writes claims, claim_sources or reports.
--
-- Conventions mirror init-research-contract.sql: idempotent, additive, RLS on with a
-- service_role FOR ALL policy. Mounted in compose as 240-init-references.sql (after the P0
-- contract's 230 slot, whose registries it extends). Fresh-volume only; the live DB gets it by
-- hand (psql -f, the operator's gated deploy), then the legacy notes are migrated with
--   deno run --allow-net --allow-env --allow-read src/contracts/migrate-references.ts
-- inside the workbench container. Revert: revert-references.sql.
-- ============================================================

-- ── 1. registries ───────────────────────────────────────────────────────
INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('reference_scopes',          'P2a', 'what a reference anchors: a span, or the source as a whole; definition.reanchor names the rule diffCheck follows when the pin is out of date'),
    ('reference_provenances',     'P2a', 'who placed a reference'),
    ('reference_states',          'P2a', 'the state a reference row is in (the freshness of its pin is computed, never stored)'),
    ('reference_selector_kinds',  'P2a', 'anchor selectors; definition.required / required_for_content_types / fields / non_empty are enforced by trigger'),
    ('reference_holder_kinds',    'P2a', 'what holds references by id'),
    ('reference_origins',         'P2a', 'how a holder came to hold a reference'),
    ('reference_anchor_outcomes', 'P2a', 'diffCheck: how the equivalent current chunk was found')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('reference_scopes', 'span',   'a quoted span',  '{"reanchor":"quote"}'),
    ('reference_scopes', 'source', 'the whole source', '{"reanchor":"first_chunk","meaning":"cites the source as a whole (every legacy note reference); the quote is the opening of the pinned revision, so the anchor exists and can be checked"}'),
    ('reference_provenances', 'user',      'placed by the user',      '{}'),
    ('reference_provenances', 'assistant', 'placed by an assistant',  '{}'),
    ('reference_states', 'pinned', 'pinned', '{"meaning":"anchored to its pinned revision; out of date is computed by diffCheck"}'),
    ('reference_selector_kinds', 'quote', 'text quote (W3C TextQuoteSelector)',
        '{"required":"always","fields":{"exact":"string","prefix":"string","suffix":"string"},"non_empty":["exact"]}'),
    ('reference_selector_kinds', 'position', 'text position (W3C TextPositionSelector, offsets into the pinned revision)',
        '{"required":"always","fields":{"start":"integer","end":"integer"}}'),
    ('reference_selector_kinds', 'pdf', 'PDF page and quads',
        '{"required_for_content_types":["pdf"],"fields":{"page":"integer","quads":"array"},"units":"page-normalized 0..1, 8 numbers per quad (x1,y1..x4,y4)"}'),
    ('reference_holder_kinds', 'legacy_note', 'legacy Quartz note (vault notes/ tree)',
        '{"path_prefix":"notes/","one_per_source":true,"dependence":true,"term":"notes = the legacy Quartz note class (D12)"}'),
    ('reference_holder_kinds', 'user_document', 'user document (P2b documents tree)',
        '{"one_per_source":false,"dependence":false,"counted_by":"document_link (the listing record, D12)"}'),
    ('reference_origins', 'cited', 'cited in the body',           '{}'),
    ('reference_origins', 'added', 'added deliberately',          '{}'),
    ('reference_anchor_outcomes', 'pinned',      'the pinned chunk, unchanged', '{}'),
    ('reference_anchor_outcomes', 'requoted',    'the current chunk that contains the quote', '{}'),
    ('reference_anchor_outcomes', 'first_chunk', 'the first chunk of the current revision (whole-source scope)', '{}'),
    ('reference_anchor_outcomes', 'same_idx',    'the same chunk index (a pin given without a reference record)', '{}'),
    ('reference_anchor_outcomes', 'lost',        'no current chunk stands for the pin; the user re-pins', '{}'),
    ('reference_anchor_outcomes', 'none',        'nothing to anchor (no chunk pinned, or the source is gone)', '{}'),
    ('reference_anchor_outcomes', 'omitted',     'filtered for the caller''s scope', '{}'),
    -- the contract's existing registries gain the reference
    ('node_kinds', 'reference', 'reference record', '{}'),
    ('dependence_kinds', 'reference_record', 'references held by notes', '{"blocks_erase":true,"severable":false,"resolve":"by the user, in the note: remove the citation or the added reference"}')
ON CONFLICT (registry, key) DO NOTHING;

-- ── 2. the records ──────────────────────────────────────────────────────
-- `references` is an SQL reserved word; the table is reference_records.
CREATE TABLE IF NOT EXISTS public.reference_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- the source pointer: a sources id, or a held_sources id (the same uuid once folded, P3a)
    source_id       UUID NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'span',   -- registry reference_scopes
    -- {"quote":{"exact","prefix","suffix"},"position":{"start","end"},"pdf":{"page","quads"}, ...}
    selectors       JSONB NOT NULL,
    provenance      TEXT NOT NULL,                  -- registry reference_provenances
    pinned_revision INT  NOT NULL CHECK (pinned_revision >= 1),
    chunk_idx       INT  CHECK (chunk_idx IS NULL OR chunk_idx >= 0),
    state           TEXT NOT NULL DEFAULT 'pinned', -- registry reference_states
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reference_records_source ON public.reference_records (source_id);

-- The selector rule, read from the registry. NULL = valid, else the reason.
CREATE OR REPLACE FUNCTION public.reference_selectors_problem(p_selectors JSONB, p_content_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    k        RECORD;
    f        RECORD;
    kname    TEXT;
    part     JSONB;
    required BOOLEAN;
    fname    TEXT;
BEGIN
    IF p_selectors IS NULL OR jsonb_typeof(p_selectors) <> 'object' THEN
        RETURN 'selectors must be a JSON object';
    END IF;
    FOR kname IN SELECT jsonb_object_keys(p_selectors) LOOP
        IF NOT public.contract_registry_has('reference_selector_kinds', kname) THEN
            RETURN format('''%s'' is not a key of the reference_selector_kinds registry', kname);
        END IF;
    END LOOP;
    FOR k IN SELECT e.key, e.definition FROM public.contract_registry_entries e
              WHERE e.registry = 'reference_selector_kinds' AND e.retired_at IS NULL ORDER BY e.key LOOP
        required := (k.definition ->> 'required') = 'always'
                 OR (p_content_type IS NOT NULL
                     AND COALESCE(k.definition -> 'required_for_content_types', '[]'::jsonb) ? p_content_type);
        part := p_selectors -> k.key;
        IF part IS NULL OR jsonb_typeof(part) = 'null' THEN
            IF required THEN
                RETURN format('a %s selector is required%s', k.key,
                              CASE WHEN (k.definition ->> 'required') = 'always' THEN ''
                                   ELSE format(' for content type %s', p_content_type) END);
            END IF;
            CONTINUE;
        END IF;
        IF jsonb_typeof(part) <> 'object' THEN
            RETURN format('the %s selector must be an object', k.key);
        END IF;
        FOR f IN SELECT key, value FROM jsonb_each_text(COALESCE(k.definition -> 'fields', '{}'::jsonb)) LOOP
            IF NOT part ? f.key THEN
                RETURN format('the %s selector lacks %s', k.key, f.key);
            END IF;
            -- CASE, not OR: the numeric cast must only run on a JSON number
            IF (CASE f.value
                 WHEN 'string'  THEN jsonb_typeof(part -> f.key) <> 'string'
                 WHEN 'array'   THEN jsonb_typeof(part -> f.key) <> 'array'
                 WHEN 'integer' THEN CASE WHEN jsonb_typeof(part -> f.key) = 'number'
                                          THEN (part ->> f.key)::numeric <> trunc((part ->> f.key)::numeric)
                                          ELSE true END
                 ELSE false
               END) THEN
                RETURN format('the %s selector''s %s must be a %s', k.key, f.key, f.value);
            END IF;
        END LOOP;
        FOR fname IN SELECT jsonb_array_elements_text(COALESCE(k.definition -> 'non_empty', '[]'::jsonb)) LOOP
            IF length(COALESCE(part ->> fname, '')) = 0 THEN
                RETURN format('the %s selector''s %s must not be empty', k.key, fname);
            END IF;
        END LOOP;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_reference_records_validate()
RETURNS TRIGGER AS $$
DECLARE
    ct      TEXT;
    problem TEXT;
BEGIN
    SELECT s.content_type INTO ct FROM public.sources s WHERE s.id = NEW.source_id;
    IF NOT FOUND THEN
        SELECT h.content_type INTO ct FROM public.held_sources h WHERE h.id = NEW.source_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'OBR01',
                MESSAGE = format('reference target %s is not a source or a held source', NEW.source_id);
        END IF;
    END IF;
    problem := public.reference_selectors_problem(NEW.selectors, ct);
    IF problem IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = problem;
    END IF;
    IF NOT public.contract_registry_has('reference_scopes', NEW.scope) THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = format('''%s'' is not a key of the reference_scopes registry', NEW.scope);
    END IF;
    IF NOT public.contract_registry_has('reference_provenances', NEW.provenance) THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = format('''%s'' is not a key of the reference_provenances registry', NEW.provenance);
    END IF;
    IF NOT public.contract_registry_has('reference_states', NEW.state) THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = format('''%s'' is not a key of the reference_states registry', NEW.state);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reference_records_validate ON public.reference_records;
CREATE TRIGGER trg_reference_records_validate
    BEFORE INSERT OR UPDATE ON public.reference_records
    FOR EACH ROW EXECUTE FUNCTION public.trg_reference_records_validate();

-- ── 3. holders ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reference_holders (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    holder_kind  TEXT NOT NULL,                 -- registry reference_holder_kinds
    holder_ref   TEXT NOT NULL,                 -- the vault path of the note / document
    -- NULL: the cited id resolved to no source when the holder was last reconciled. Such a row is
    -- not a reference; it keeps the citation number the legacy export gave it.
    reference_id UUID REFERENCES public.reference_records(id) ON DELETE RESTRICT,
    -- the id as the holder writes it (legacy notes: the uuid in the link, case kept, because the
    -- legacy resolver matched it case-sensitively)
    cited_ref    TEXT NOT NULL
        CHECK (cited_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
    origin       TEXT NOT NULL,                 -- registry reference_origins
    seq          INT  NOT NULL,                 -- listing order (added first, then cited)
    number       INT,                           -- the citation number on export; NULL = not numbered
    -- set by trigger from the holder kind's one_per_source declaration: one row per cited id
    source_key   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (holder_kind, holder_ref, reference_id),
    UNIQUE (holder_kind, holder_ref, source_key)
);
CREATE INDEX IF NOT EXISTS idx_reference_holders_holder ON public.reference_holders (holder_kind, holder_ref, seq);
CREATE INDEX IF NOT EXISTS idx_reference_holders_reference ON public.reference_holders (reference_id);

CREATE OR REPLACE FUNCTION public.trg_reference_holders_validate()
RETURNS TRIGGER AS $$
DECLARE
    def    JSONB;
    target UUID;
BEGIN
    SELECT e.definition INTO def FROM public.contract_registry_entries e
     WHERE e.registry = 'reference_holder_kinds' AND e.key = NEW.holder_kind;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = format('''%s'' is not a key of the reference_holder_kinds registry', NEW.holder_kind);
    END IF;
    IF NOT public.contract_registry_has('reference_origins', NEW.origin) THEN
        RAISE EXCEPTION USING ERRCODE = 'OBR01', MESSAGE = format('''%s'' is not a key of the reference_origins registry', NEW.origin);
    END IF;
    IF NEW.reference_id IS NOT NULL THEN
        SELECT r.source_id INTO target FROM public.reference_records r WHERE r.id = NEW.reference_id;
        IF target::text <> lower(NEW.cited_ref) THEN
            RAISE EXCEPTION USING ERRCODE = 'OBR01',
                MESSAGE = format('holder cites %s but reference %s points at %s', NEW.cited_ref, NEW.reference_id, target);
        END IF;
    END IF;
    NEW.source_key := CASE WHEN COALESCE((def ->> 'one_per_source')::boolean, false) THEN NEW.cited_ref END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reference_holders_validate ON public.reference_holders;
CREATE TRIGGER trg_reference_holders_validate
    BEFORE INSERT OR UPDATE ON public.reference_holders
    FOR EACH ROW EXECUTE FUNCTION public.trg_reference_holders_validate();

CREATE TABLE IF NOT EXISTS public.reference_holder_state (
    holder_kind    TEXT NOT NULL,
    holder_ref     TEXT NOT NULL,
    content_sha256 TEXT,                        -- the file the holder rows were reconciled against
    migrated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reconciled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at     TIMESTAMPTZ,                 -- hard-removed (empty trash); cleared by recover
    -- the migration's audit: what the legacy reader listed before, what the records list after
    migration      JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (holder_kind, holder_ref)
);

-- ── 4. dependence (D5): references held by notes count, and block erasure ─
-- Redefines P0's source_dependence (init-research-contract.sql) with ONE added branch,
-- reference_record; every P0 branch is unchanged. Which holder kinds count is declared in the
-- reference_holder_kinds registry (user documents are counted through the listing record by
-- P0's document_link, so they are not counted twice). A hard-removed note no longer counts.
CREATE OR REPLACE FUNCTION public.source_dependence(p_source_id UUID)
RETURNS TABLE (kind TEXT, ref TEXT, detail JSONB)
LANGUAGE sql STABLE
AS $$
    SELECT 'claim_edge', cs.id::text,
           jsonb_build_object('claim_id', cs.claim_id, 'edge_type', cs.edge_type, 'claim_text', left(c.text, 200))
      FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
     WHERE cs.source_id = p_source_id
    UNION ALL
    SELECT 'chunk', sc.idx::text, jsonb_build_object('idx', sc.idx)
      FROM public.source_chunks sc WHERE sc.source_id = p_source_id
    UNION ALL
    SELECT 'citing_page', wp.slug, jsonb_build_object('slug', wp.slug, 'page_class', wp.page_class,
               'pending_compile', EXISTS (SELECT 1 FROM public.page_compile_marks m
                                          WHERE m.page_ref = wp.slug AND m.source_id = p_source_id
                                            AND m.marked_at >= wp.updated_at))
      FROM public.wiki_pages wp
     WHERE wp.links @> to_jsonb('content/source/' || p_source_id::text)
       AND wp.slug <> 'content/source/' || p_source_id::text
       AND NOT EXISTS (SELECT 1 FROM public.page_compile_marks m
                        WHERE m.page_ref = wp.slug AND m.source_id = p_source_id
                          AND m.marked_at >= wp.updated_at)
    UNION ALL
    SELECT 'entity_grounding', se.entity_id::text, jsonb_build_object('entity_id', se.entity_id, 'mention_role', se.mention_role)
      FROM public.source_entities se WHERE se.source_id = p_source_id
    UNION ALL
    SELECT 'report_session', ss.session_id::text, jsonb_build_object('session_id', ss.session_id)
      FROM public.session_sources ss WHERE ss.source_id = p_source_id
    UNION ALL
    SELECT 'report_citation', syn.id::text, jsonb_build_object('synthesis_id', syn.id, 'title', syn.title)
      FROM public.sources syn
     WHERE syn.content_type = 'research_synthesis'
       AND syn.metadata ? 'source_ids'
       AND jsonb_typeof(syn.metadata -> 'source_ids') = 'array'
       AND (syn.metadata -> 'source_ids') @> to_jsonb(p_source_id::text)
    UNION ALL
    SELECT 'found_via_lead', s.id::text, jsonb_build_object('source_id', s.id, 'title', s.title)
      FROM public.sources s WHERE s.metadata ->> 'found_via' = p_source_id::text
    UNION ALL
    SELECT 'document_link', d.path, jsonb_build_object('path', d.path, 'title', d.title)
      FROM public.user_document_listings d
     WHERE d.outbound_links @> jsonb_build_array(jsonb_build_object('id', p_source_id::text))
    UNION ALL
    SELECT 'reference_record', h.holder_kind || ':' || h.holder_ref || '#' || r.id::text,
           jsonb_build_object('holder_kind', h.holder_kind, 'holder_ref', h.holder_ref,
                              'reference_id', r.id, 'origin', h.origin, 'pinned_revision', r.pinned_revision)
      FROM public.reference_records r
      JOIN public.reference_holders h ON h.reference_id = r.id
      JOIN public.contract_registry_entries k
        ON k.registry = 'reference_holder_kinds' AND k.key = h.holder_kind
      LEFT JOIN public.reference_holder_state st
        ON st.holder_kind = h.holder_kind AND st.holder_ref = h.holder_ref
     WHERE r.source_id = p_source_id
       AND COALESCE((k.definition ->> 'dependence')::boolean, false)
       AND st.removed_at IS NULL
    UNION ALL
    SELECT 'trail_event', te.id::text, jsonb_build_object('kind', te.kind, 'at', te.created_at)
      FROM public.source_trail_events te WHERE te.source_id = p_source_id;
$$;

-- ── 5. RLS + grants (the P0 shape) ──────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['reference_records', 'reference_holders', 'reference_holder_state'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
