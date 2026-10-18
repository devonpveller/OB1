-- Revert init-research-credibility.sql (research-workbench P3a, rw-p3a-entail).
--
-- Run from OB1/docker so the relative include below resolves:
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-credibility.sql
--
-- What it does, in order:
--   1. puts the claim-confidence trigger back on P0's model: the trigger-state table is
--      dropped and recompute_claim_confidence() is restored by re-running P0's migration
--      (idempotent; its CREATE OR REPLACE bodies are P0's). If the D15 trigger had been APPLIED
--      (credibility_apply_d15_trigger), claims keep their D15 confidence until each is next
--      recomputed - re-score them with P0's model by hand if that matters:
--        SELECT count(public.recompute_claim_confidence(id)) FROM public.claims WHERE status = 'active';
--   2. drops the P3a functions, the view, the triggers and the four P3a tables. THIS DISCARDS
--      their data (the admission trail, the credibility history, the corroborations, the
--      confirmations) - take a pg_dump first if any of it matters.
--   3. removes the P3a registry entries and registries. sources.metadata.credibility /
--      .scholarly / .found_via stay on the rows (harmless JSON keys nothing reads after this);
--      a source a fold moved out of held_sources STAYS in sources (it is an active source now).
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.credibility_trigger_state;
\ir init-research-contract.sql

DROP VIEW IF EXISTS public.credibility_before_after;
DROP FUNCTION IF EXISTS public.credibility_apply_d15_trigger(TEXT);
DROP FUNCTION IF EXISTS public.credibility_record_confirmation(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_before_after_digest();
DROP FUNCTION IF EXISTS public.credibility_trigger_model();
DROP FUNCTION IF EXISTS public.claim_confidence_d15(UUID);
DROP FUNCTION IF EXISTS public.claim_kind_of(UUID);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT);
DROP FUNCTION IF EXISTS public.source_credibility(UUID);
DROP FUNCTION IF EXISTS public.credibility_domain_class(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_fallback_kind();
DROP FUNCTION IF EXISTS public.credibility_weight(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_model_version();
DROP FUNCTION IF EXISTS public.fold_held_source(UUID, JSONB, UUID);
DROP TRIGGER IF EXISTS trg_source_corroborations_supports_only ON public.source_corroborations;
DROP FUNCTION IF EXISTS public.trg_source_corroborations_supports_only();
DROP TRIGGER IF EXISTS trg_credibility_registry_bump_ins ON public.contract_registry_entries;
DROP TRIGGER IF EXISTS trg_credibility_registry_bump_upd ON public.contract_registry_entries;
DROP FUNCTION IF EXISTS public.trg_credibility_registry_bump();

DROP TABLE IF EXISTS public.credibility_rescore_confirmations;
DROP TABLE IF EXISTS public.source_corroborations;
DROP TABLE IF EXISTS public.source_credibility_history;
DROP TABLE IF EXISTS public.research_admission_trail;

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                    'entailment_verdicts', 'admission_trail_kinds')
    OR (registry = 'credibility_terms' AND key = 'corroboration')
    OR (registry = 'trail_event_kinds' AND key IN ('folded', 'found_via'));
DELETE FROM public.contract_registries
 WHERE name IN ('claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                'entailment_verdicts', 'admission_trail_kinds');
UPDATE public.contract_registry_entries SET definition = definition - 'terms'
 WHERE registry = 'source_families' AND key = 'general';
UPDATE public.contract_registry_entries SET definition = definition - 'scorer'
 WHERE registry = 'source_families' AND key = 'scholarly';

COMMIT;
