-- Revert init-research-credibility.sql (research-workbench P3a, rw-p3a-entail).
--
-- Run from OB1/docker so the relative include below resolves:
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-credibility.sql
--
-- What it does, in order:
--   1. puts the claim-confidence trigger back on P0's model: the trigger-state table is
--      dropped and recompute_claim_confidence() is restored by re-running P0's migration
--      (idempotent; its CREATE OR REPLACE bodies are P0's), then P2a's when P2a is applied (its
--      source_dependence carries the reference_record branch P0's lacks). If the D15 trigger had been APPLIED
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

-- attempt 2's integrity objects first (the guard would otherwise see the DELETEs below; it lets
-- the owner through, but nothing of P3a should outlive the revert)
DROP TRIGGER IF EXISTS trg_credibility_registry_guard ON public.contract_registry_entries;
DROP FUNCTION IF EXISTS public.trg_credibility_registry_guard();
DROP INDEX IF EXISTS public.uq_credibility_weights_kind_family;
ALTER TABLE public.contract_registry_entries DROP CONSTRAINT IF EXISTS contract_registry_entries_credibility_weight_ok;
-- attempt 3's objects: the registries' owner-only triggers, the one-active-paper index, the
-- pattern CHECK, claims.filed_at (its trigger and the column - nothing outside P3a reads it)
DROP TRIGGER IF EXISTS trg_credibility_registries_guard ON public.contract_registries;
DROP TRIGGER IF EXISTS trg_credibility_registries_truncate ON public.contract_registries;
DROP TRIGGER IF EXISTS trg_credibility_registry_entries_truncate ON public.contract_registry_entries;
DROP INDEX IF EXISTS public.uq_paper_score_versions_one_active;
ALTER TABLE public.contract_registry_entries DROP CONSTRAINT IF EXISTS contract_registry_entries_credibility_patterns_ok;
DROP FUNCTION IF EXISTS public.credibility_patterns_ok(TEXT, JSONB);
DROP TRIGGER IF EXISTS trg_claims_filed_at ON public.claims;
DROP FUNCTION IF EXISTS public.trg_claims_filed_at();
ALTER TABLE public.claims DROP COLUMN IF EXISTS filed_at;
-- attempt 4's objects: the representable-range CHECKs on P0 / init-claims tables (their columns stay)
ALTER TABLE public.claim_sources DROP CONSTRAINT IF EXISTS claim_sources_weight_credibility;
ALTER TABLE public.sources DROP CONSTRAINT IF EXISTS sources_credibility_stamp_ok;

DROP TABLE IF EXISTS public.credibility_trigger_state;
\ir init-research-contract.sql
-- Integration with P2a (rw-p3a-entail, 2026-10-18): re-running P0's migration above also puts back
-- P0's source_dependence, WITHOUT P2a's reference_record branch (init-references.sql redefines it).
-- When P2a is applied (reference_records exists) its migration is re-run too - idempotent, insert-
-- only but for the selector kinds, which converge on its own definitions - so a note's references
-- still block an erase after this revert. When P2a is not applied nothing of it is installed.
SELECT to_regclass('public.reference_records') IS NOT NULL AS p2a_applied \gset
\if :p2a_applied
\ir init-references.sql
\endif

DROP VIEW IF EXISTS public.credibility_before_after;
DROP FUNCTION IF EXISTS public.credibility_apply_d15_trigger(TEXT);
DROP FUNCTION IF EXISTS public.credibility_record_confirmation(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_before_after_digest();
DROP FUNCTION IF EXISTS public.credibility_trigger_model();
DROP FUNCTION IF EXISTS public.claim_confidence_d15(UUID);
DROP FUNCTION IF EXISTS public.claim_kind_of(UUID);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT, JSONB, UUID[]);
DROP FUNCTION IF EXISTS public.source_rolling_total_core(UUID, TEXT, JSONB, UUID[]);
DROP FUNCTION IF EXISTS public.credibility_model_check();
DROP FUNCTION IF EXISTS public.credibility_claim_floor(TEXT);
DROP FUNCTION IF EXISTS public.credibility_store_confidence(DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.credibility_is_positive(JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.credibility_is_order(JSONB);
DROP FUNCTION IF EXISTS public.source_credibility(UUID);
DROP FUNCTION IF EXISTS public.credibility_domain_class(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_fallback_kind();
DROP FUNCTION IF EXISTS public.credibility_weight(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_model_version();
DROP FUNCTION IF EXISTS public.credibility_weight_row_ok(JSONB);
DROP FUNCTION IF EXISTS public.credibility_unit(JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.credibility_stamp_ok(JSONB);
DROP FUNCTION IF EXISTS public.credibility_is_unit(JSONB);
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
DROP FUNCTION IF EXISTS public.trg_credibility_owner_only();   -- after the tables whose TRUNCATE triggers use it
DROP FUNCTION IF EXISTS public.credibility_is_unit_value(DOUBLE PRECISION);   -- after the CHECKs that call it

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                    'entailment_verdicts', 'admission_trail_kinds')
    OR (registry = 'credibility_terms' AND key IN ('corroboration', 'edge_factors'))
    OR (registry = 'trail_event_kinds' AND key IN ('folded', 'found_via'));
DELETE FROM public.contract_registries
 WHERE name IN ('claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                'entailment_verdicts', 'admission_trail_kinds');
UPDATE public.contract_registry_entries SET definition = definition - 'terms'
 WHERE registry = 'source_families' AND key = 'general';
UPDATE public.contract_registry_entries SET definition = definition - 'scorer'
 WHERE registry = 'source_families' AND key = 'scholarly';

COMMIT;
