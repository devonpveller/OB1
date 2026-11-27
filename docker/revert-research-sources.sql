-- ============================================================
-- Revert slot 750 (rwr-research-sources). Put the PREVIOUS research and workbench images back first (they do not
-- send or read `sources`), then psql -f this file. Restores every function slot 750 replaced from the copies it
-- saved (research_sources_saved), drops what it added, removes its registry rows and settings keys (the users'
-- stored values of research.sources_default and the shared research.community_allowed go with them), and
-- re-scores the claims with a community source under the restored formula.
-- Refuses while a queued or running derived job still carries `sources` (the restored allow-list would refuse
-- its branches): let them finish first.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.research_jobs WHERE status IN ('queued', 'running') AND options ? 'sources') THEN
        RAISE EXCEPTION 'revert-research-sources: a queued or running job carries options.sources - let it finish first';
    END IF;
    IF to_regclass('public.research_sources_saved') IS NULL THEN
        RAISE EXCEPTION 'revert-research-sources: research_sources_saved is missing - slot 750 was not applied here';
    END IF;
END $$;

-- the claims to re-score afterwards (read while the classifier still exists)
CREATE TEMP TABLE rs_rescore ON COMMIT DROP AS
SELECT DISTINCT cs.claim_id FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
 WHERE public.source_class_of(s.url, s.domain) IS NOT NULL;

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT fn, def FROM public.research_sources_saved LOOP
        EXECUTE r.def;
    END LOOP;
END $$;

DELETE FROM public.user_settings WHERE key = 'research.sources_default';
DELETE FROM public.contract_settings WHERE key = 'research.community_allowed';
DELETE FROM public.settings_keys WHERE key IN ('research.sources_default', 'research.community_allowed');

-- the restored guard no longer names source_classes, so its rows can be removed by the owner
DELETE FROM public.contract_registry_entries WHERE registry = 'source_classes';
DELETE FROM public.contract_registry_entries WHERE registry = 'credibility_terms' AND key = 'community';
DELETE FROM public.contract_registries WHERE name = 'source_classes';
ALTER TABLE public.contract_registry_entries DROP CONSTRAINT IF EXISTS contract_registry_entries_source_class_ok;

DROP FUNCTION IF EXISTS public.claim_community_consensus(UUID);
DROP FUNCTION IF EXISTS public.claim_community_only(UUID);
DROP FUNCTION IF EXISTS public.claim_has_credible_support(UUID);
DROP FUNCTION IF EXISTS public.source_is_community(UUID);
DROP FUNCTION IF EXISTS public.source_class_of(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.source_url_unwrap(TEXT);
DROP FUNCTION IF EXISTS public.credibility_community_terms();
DROP FUNCTION IF EXISTS public.source_class_def_ok(JSONB);

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT claim_id FROM rs_rescore LOOP
        PERFORM public.recompute_claim_confidence(r.claim_id);
    END LOOP;
END $$;

DROP TABLE public.research_sources_saved;
COMMIT;
