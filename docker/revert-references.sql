-- Revert init-references.sql (research-workbench P2a, rw-p2a-refs).
--
-- Run BEFORE revert-research-contract.sql (P2a sits on P0's registries):
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-references.sql
--
-- What it does, in order:
--   1. restores P0's source_dependence (without the reference_record branch);
--   2. drops the three reference tables, their triggers and functions. THIS DISCARDS every
--      reference row, holder row and migration audit - take a pg_dump first if any of it
--      matters. The vault is not touched by P2a (the migration reads note files, never writes
--      them), so the legacy notes need nothing; but the pre-P2a workbench image must be
--      redeployed with this revert, since the P2a image reads these tables;
--   3. removes the P2a registry entries and registries (P0's are left as they were).
\set ON_ERROR_STOP on
BEGIN;

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
    SELECT 'trail_event', te.id::text, jsonb_build_object('kind', te.kind, 'at', te.created_at)
      FROM public.source_trail_events te WHERE te.source_id = p_source_id;
$$;

DROP TABLE IF EXISTS public.reference_holder_state;
DROP TABLE IF EXISTS public.reference_holders;
DROP TABLE IF EXISTS public.reference_records;
DROP FUNCTION IF EXISTS public.trg_reference_holders_validate();
DROP FUNCTION IF EXISTS public.trg_reference_records_validate();
DROP FUNCTION IF EXISTS public.reference_selectors_problem(JSONB, TEXT);

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('reference_scopes', 'reference_provenances', 'reference_states', 'reference_selector_kinds',
                    'reference_holder_kinds', 'reference_origins', 'reference_anchor_outcomes')
    OR (registry = 'node_kinds' AND key = 'reference')
    OR (registry = 'dependence_kinds' AND key = 'reference_record');
DELETE FROM public.contract_registries
 WHERE name IN ('reference_scopes', 'reference_provenances', 'reference_states', 'reference_selector_kinds',
                'reference_holder_kinds', 'reference_origins', 'reference_anchor_outcomes');

COMMIT;
NOTIFY pgrst, 'reload schema';
