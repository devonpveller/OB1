-- ============================================================
-- Research workbench P3a - the D15 credibility model's storage (rw-p3a-entail).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P3a, 01-OPEN-ITEMS.md D15 items 1-10, D10, D5 items 6-7, 06-EXPANSION.md §1.
--
-- What this file adds, and only this (it runs after 230-init-research-contract.sql):
--   1. REGISTRIES (D18): claim kinds (with their cues), the weight table keyed by claim kind
--      AND source family, the domain credibility classes, the versioned paper score, the
--      entailment verdicts and what each does to a line, the general family's signal terms and
--      the corroboration terms, the admission-trail kinds. A statement-level trigger bumps a
--      credibility registry's version on every change, so "weights vN" names one table.
--   2. RECORDS: research_admission_trail (every hit the pre-ingestion stage judged - a lead lives
--      here and NEVER as a sources row), source_credibility_history (the per-reference rolling
--      total with reasons, appended), source_corroborations (entailment-gated, bidirectional,
--      asymmetric transfers between sources).
--   3. THE MODEL'S CLAIM TOTAL in SQL: claim_confidence_d15() and its reasons, failing loud on a
--      claim kind or family with no weight row (SQLSTATE OBC01).
--   4. THE GATE (D15 item 6): credibility_before_after (the view the operator reads), its digest,
--      credibility_record_confirmation() and credibility_apply_d15_trigger(). The trigger -
--      recompute_claim_confidence(), redefined here - keeps P0's claim_confidence() until a
--      confirmation whose digest matches the CURRENT view is recorded; nothing in this file
--      re-scores a claim.
--   5. THE FOLD: fold_held_source() moves a held source into `sources` with its uuid (the
--      tombstone gate on `sources` still fires: a tombstoned URL raises OBT01 and the caller
--      routes the D5 reopening path).
--   6. INTEGRITY (attempt 2, tester t-rw-p3a finding 2 and the near-misses): every number the
--      model reads is a JSON number in [0, 1] or the gate stops (OBC04) - the SQL twin refuses
--      exactly what credibility.ts buildModel refuses; the weight table has a CHECK and one
--      active row per kind x family; the credibility registries are written only by their owner
--      (an app role reads them and cannot change a weight, before or after the trigger flip); a
--      corroboration is in [0, 1], never from a source to itself, and one row per giver ->
--      receiver -> line whatever the model version; within one claim total a co-grounding
--      source counts once (the fold rule, claim_confidence_d15); a claim filed after the P3a
--      cutover without a claim kind stops the gate (OBC01) instead of taking the fallback.
--   7. ONE SCORING RULE (attempt 3, tester t-rw-p3a-2 finding: credibility.ts rounded each source
--      total and the line total to 3 decimals and this file did not, so a claim at 0.49955 was
--      below the 0.50 floor here and at it in the pipeline). No number that feeds a total, an
--      amount or a floor comparison is rounded in either twin; both compute in IEEE-754 double
--      precision (DOUBLE PRECISION here, never REAL) with the same operations in the same order
--      (received amounts summed in descending order; claim totals in descending order), and the
--      floor is the highest claim_floor of the kind's family rows in both. Rounding is display
--      only. A credibility number is 0 or in [1e-9, 1] in both twins; registry keys inside a weight
--      row follow P0's key pattern; flags are JSON true; orders are JSON integers; one active paper
--      score version; credibility_model_check() refuses every table credibility.ts buildModel
--      refuses. The model's registry versions, the registries' TRUNCATE and a claim's filing time
--      (filed_at, server-set) are out of the app roles' reach. The re-score gate records one
--      confirmation per view digest and applies it once.
--   8. THE REPRESENTABLE RANGE AND ONE LINE FORMULA (attempt 4, tester t-rw-p3a-3 findings F1/F2).
--      Every credibility number either twin reads as an input - registry numbers, a source's stamped
--      score, a corroboration amount, a claim edge's weight - is 0 or in [1e-9, 1] (CHECKs on all
--      four; credibility.ts refuses the same and flushes a number it forms below 1e-9 to 0), and
--      credibility_store_confidence stores a total below the smallest normal float4 as 0 (always on
--      the total's side of a floor, which is 0 or >= 1e-9) instead of raising 22003. A grounding
--      edge's type factor (inferred_from 0.67) is the registry row credibility_terms.edge_factors,
--      read here and by credibility.ts, and the pipeline scores each line through the edges the
--      curator files for it (claim-edges.ts), so a line's total IS the filed claim's total. The
--      gate's digest binds the view exactly (the bits of every after-score and its verdict).
--
-- Conventions mirror init-research-contract.sql: idempotent, additive, RLS on with a
-- service_role FOR ALL policy, no DROP TABLE / TRUNCATE / unqualified DELETE. Mounted in
-- compose as 245-init-research-credibility.sql (after P2a's 240-init-references.sql; the two are
-- independent). Fresh-volume only; the live DB gets it by hand
-- (psql -f, the operator's gated deploy). Applying it changes no claim's confidence.
-- Revert: revert-research-credibility.sql.
-- ============================================================

-- Attempt 3: these functions' result types moved from REAL to DOUBLE PRECISION, which CREATE OR
-- REPLACE cannot do; on a database that ran an earlier version of this file they are dropped
-- first (the view that calls them is re-created below; plpgsql callers resolve by name at call
-- time). On a fresh volume every statement here is a no-op.
DROP VIEW IF EXISTS public.credibility_before_after;
DROP FUNCTION IF EXISTS public.claim_confidence_d15(UUID);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.source_rolling_total(UUID, TEXT, JSONB, UUID[]);
DROP FUNCTION IF EXISTS public.source_credibility(UUID);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.credibility_unit(jsonb,text,text)')
                 AND prorettype = 'real'::regtype) THEN
        DROP FUNCTION public.credibility_unit(JSONB, TEXT, TEXT);
    END IF;
END $$;

-- ── 1. registries ───────────────────────────────────────────────────────
-- Seeded at version 0 so the seeding statement itself lands them at version 1.
INSERT INTO public.contract_registries (name, version, owner, description) VALUES
    ('claim_kinds',           0, 'P3a', 'D15 item 4: what a claim validates; cues classify a question, one fallback'),
    ('credibility_weights',   0, 'P3a', 'D15 items 4, 9, 10: the weight table keyed by claim kind AND source family'),
    ('domain_classes',        0, 'P3a', 'D15 item 10: the domain credibility classes the general family reads'),
    ('paper_score_versions',  0, 'P3a', 'D15 item 2: the deterministic paper score; exactly one active'),
    ('entailment_verdicts',   0, 'P3a', 'D10: verdict per cited line and what it does to the line and to corroboration'),
    ('admission_trail_kinds', 0, 'P3a', 'D15 items 7-8: what the pre-ingestion stage recorded about a hit')
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.trg_credibility_registry_bump()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE public.contract_registries r
       SET version = r.version + 1
     WHERE r.name IN (SELECT DISTINCT n.registry FROM changed n)
       AND r.name IN ('claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                      'entailment_verdicts', 'source_families', 'credibility_terms');
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_credibility_registry_bump_ins ON public.contract_registry_entries;
CREATE TRIGGER trg_credibility_registry_bump_ins
    AFTER INSERT ON public.contract_registry_entries
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_credibility_registry_bump();
DROP TRIGGER IF EXISTS trg_credibility_registry_bump_upd ON public.contract_registry_entries;
CREATE TRIGGER trg_credibility_registry_bump_upd
    AFTER UPDATE ON public.contract_registry_entries
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_credibility_registry_bump();

-- â”€â”€ 1b. integrity: what a credibility number is (attempt 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- A credibility number is a JSON number that is 0 or in [1e-9, 1]. JSON has no NaN or Infinity,
-- so a jsonb `number` is finite; a string ("NaN", "abc", "-Infinity"), a null or a missing key is
-- NOT a number and is never cast. This is the one definition the SQL twin reads every registry
-- number and every stamped score through; credibility.ts `unit()` is its TS side (same rule).
-- Attempt 3: the range is judged on the float8 value - the same IEEE double JSON.parse gives the
-- TS twin for the same text (1.0000000000000000001 is 1 in both) - and a non-zero number below
-- 1e-9 is refused in both (the tester's 1e-50 raised 22003 in REAL here and read 0 in TS; 1e-400
-- is a non-zero numeric here and 0 in JSON.parse, so "below 1e-9" is the rule both can apply).
-- The numeric guards keep the float8 cast from underflowing or overflowing.
CREATE OR REPLACE FUNCTION public.credibility_is_unit(p JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(CASE
        WHEN jsonb_typeof(p) IS DISTINCT FROM 'number' THEN FALSE
        WHEN (p #>> '{}')::numeric = 0 THEN TRUE
        WHEN (p #>> '{}')::numeric < 1e-300 OR (p #>> '{}')::numeric > 2 THEN FALSE
        ELSE (p #>> '{}')::float8 >= 1e-9::float8 AND (p #>> '{}')::float8 <= 1::float8
    END, FALSE);
$$;

-- THE REPRESENTABLE RANGE for a stored number (attempt 4, tester finding F1): a corroboration amount
-- (DOUBLE), a claim edge's weight (REAL, judged as the float8 it reads as) and a stamped score are 0
-- or in [1e-9, 1] - the rule credibility_is_unit applies to registry text, applied to a column value.
-- NaN, Infinity and -1 are refused (NaN sorts above every number in Postgres, so `<= 1` refuses it).
-- Attempt 3 let an amount be any double in [0, 1]: 5e-324 was stored, both twins computed a 5e-324
-- claim total, and credibility_store_confidence's REAL cast raised 22003. credibility.ts amountUnit /
-- edgeWeightOk / unit are the TS side; the pipeline flushes a number it forms below 1e-9 to 0.
CREATE OR REPLACE FUNCTION public.credibility_is_unit_value(p DOUBLE PRECISION)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(p = 0::float8 OR (p >= 1e-9::float8 AND p <= 1::float8), FALSE);
$$;

-- A stored credibility stamp (sources.metadata.credibility) is well formed (attempt 4): when it has a
-- score, the score is a credibility number (0 or in [1e-9, 1]); when its signals carry `primary`, it
-- is the JSON boolean (tester near-miss: "true" / 1 were read as true by credibility.ts and as not
-- true here). The CHECK sources_credibility_stamp_ok holds the table to it; the read path
-- (source_credibility) still refuses a bad score (OBC04) and reads only `primary = true`.
CREATE OR REPLACE FUNCTION public.credibility_stamp_ok(p_meta JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(CASE
        WHEN p_meta IS NULL OR NOT (p_meta ? 'credibility') THEN TRUE
        WHEN jsonb_typeof(p_meta -> 'credibility') IS DISTINCT FROM 'object' THEN TRUE
        ELSE (NOT ((p_meta -> 'credibility') ? 'score') OR public.credibility_is_unit(p_meta #> '{credibility,score}'))
         AND (p_meta #> '{credibility,signals,primary}' IS NULL
              OR jsonb_typeof(p_meta #> '{credibility,signals,primary}') = 'boolean')
    END, FALSE);
$$;

-- A saturation half-point (> 0) or a grace period (>= 0, p_allow_zero): 0 or in [1e-9, 1e9]
-- (credibility.ts `positive`, the same bounds for the same reason).
CREATE OR REPLACE FUNCTION public.credibility_is_positive(p JSONB, p_allow_zero BOOLEAN)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(CASE
        WHEN jsonb_typeof(p) IS DISTINCT FROM 'number' THEN FALSE
        WHEN (p #>> '{}')::numeric = 0 THEN p_allow_zero
        WHEN (p #>> '{}')::numeric < 1e-300 OR (p #>> '{}')::numeric > 1e300 THEN FALSE
        ELSE (p #>> '{}')::float8 >= 1e-9::float8 AND (p #>> '{}')::float8 <= 1e9::float8
    END, FALSE);
$$;

-- An ORDER (claim kinds, domain classes): absent (SQL NULL) = 100; present, a JSON integer of at
-- most 1e9 in magnitude, judged on the float8 value (credibility.ts `order`).
CREATE OR REPLACE FUNCTION public.credibility_is_order(p JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(CASE
        WHEN p IS NULL THEN TRUE
        WHEN jsonb_typeof(p) <> 'number' THEN FALSE
        WHEN (p #>> '{}')::numeric = 0 THEN TRUE
        WHEN abs((p #>> '{}')::numeric) < 1e-300 OR abs((p #>> '{}')::numeric) > 1e10 THEN FALSE
        ELSE (p #>> '{}')::float8 = trunc((p #>> '{}')::float8) AND abs((p #>> '{}')::float8) <= 1e9::float8
    END, FALSE);
$$;

-- Read one number or stop the gate, naming where and what (OBC04). Never a default.
CREATE OR REPLACE FUNCTION public.credibility_unit(p_def JSONB, p_field TEXT, p_where TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    IF NOT public.credibility_is_unit(p_def -> p_field) THEN
        RAISE EXCEPTION 'credibility: % % is not a number in [0, 1] (%) - the gate stops (D15 item 9)',
            p_where, p_field, COALESCE((p_def -> p_field)::text, 'missing')
            USING ERRCODE = 'OBC04';
    END IF;
    RETURN (p_def ->> p_field)::double precision;
END;
$$;

-- A weight row is well formed: kind and family are registry keys (attempt 3: P0's key pattern,
-- the one contract_registry_entries.key CHECKs and credibility.ts REGISTRY_KEY_PATTERN - so
-- 'practical ' and 'Practical' are refused, not stored beside 'practical'); weight,
-- admission_floor and claim_floor are credibility numbers; primary_bonus, the one optional
-- field, is one when present (absent = 0 in both twins). The CHECK below holds the table to it.
CREATE OR REPLACE FUNCTION public.credibility_weight_row_ok(p_def JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(jsonb_typeof(p_def -> 'kind') = 'string' AND (p_def ->> 'kind') ~ '^[a-z0-9][a-z0-9._-]*$'
       AND jsonb_typeof(p_def -> 'family') = 'string' AND (p_def ->> 'family') ~ '^[a-z0-9][a-z0-9._-]*$'
       AND public.credibility_is_unit(p_def -> 'weight')
       AND public.credibility_is_unit(p_def -> 'admission_floor')
       AND public.credibility_is_unit(p_def -> 'claim_floor')
       AND (NOT (p_def ? 'primary_bonus') OR public.credibility_is_unit(p_def -> 'primary_bonus')), FALSE);
$$;

-- One seeding statement per registry, so each registry's first version is v1.
-- Regex strings are POSIX-and-JavaScript compatible on purpose: the research service reads
-- them with `new RegExp(.., "i")`, the SQL below with `~*`.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('claim_kinds', 'general_theory', 'general theory / mechanism / study',
        '{"order":1,"papers_outrank":true,"cues":["\\b(mechanism|mechanisms|theory|theories|theoretical|hypothes[ie]s|study|studies|research on|evidence (for|that|on)|effect of|efficacy|clinical|peer[- ]reviewed|literature|meta-analysis|randomi[sz]ed)\\b"],"description":"a claim about how the world works; papers outrank every other type"}'),
    ('claim_kinds', 'release', 'a release or version',
        '{"order":2,"cues":["\\b(release|released|releases|version|changelog|launch|launched|roadmap)\\b"],"description":"a primary non-paper source may rank higher"}'),
    ('claim_kinds', 'price', 'a price or cost',
        '{"order":3,"cues":["\\b(price|prices|priced|pricing|cost|costs|how much)\\b"],"description":"a primary non-paper source may rank higher"}'),
    ('claim_kinds', 'outage', 'an outage or incident',
        '{"order":4,"cues":["\\b(outage|outages|downtime|incident|incidents|status page)\\b"],"description":"a primary non-paper source may rank higher"}'),
    ('claim_kinds', 'product_change', 'a product change',
        '{"order":5,"cues":["\\b(deprecated|deprecation|discontinued|new feature|policy change|changed|breaking change)\\b"],"description":"a primary non-paper source may rank higher"}'),
    ('claim_kinds', 'practical', 'practical / everything else',
        '{"order":99,"fallback":true,"cues":[],"description":"how-to, troubleshooting, buying, general facts: the declared fallback when no cue matches"}')
ON CONFLICT (registry, key) DO NOTHING;

-- The weight table (D15 items 4, 9, 10). Every kind has one row per family; a missing row
-- stops the gate. Numbers are the first version, tuned through this table and the
-- before/after view (item 10). claim_floor is the per-claim threshold (the reuse floor today).
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('credibility_weights', 'general_theory.scholarly', 'general theory / scholarly', '{"kind":"general_theory","family":"scholarly","weight":1.0,"admission_floor":0.15,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'general_theory.general',   'general theory / general',   '{"kind":"general_theory","family":"general","weight":0.5,"admission_floor":0.15,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'release.scholarly',        'release / scholarly',        '{"kind":"release","family":"scholarly","weight":0.45,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'release.general',          'release / general',          '{"kind":"release","family":"general","weight":1.0,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0.02}'),
    ('credibility_weights', 'price.scholarly',          'price / scholarly',          '{"kind":"price","family":"scholarly","weight":0.45,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'price.general',            'price / general',            '{"kind":"price","family":"general","weight":1.0,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0.02}'),
    ('credibility_weights', 'outage.scholarly',         'outage / scholarly',         '{"kind":"outage","family":"scholarly","weight":0.45,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'outage.general',           'outage / general',           '{"kind":"outage","family":"general","weight":1.0,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0.02}'),
    ('credibility_weights', 'product_change.scholarly', 'product change / scholarly', '{"kind":"product_change","family":"scholarly","weight":0.45,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'product_change.general',   'product change / general',   '{"kind":"product_change","family":"general","weight":1.0,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0.02}'),
    ('credibility_weights', 'practical.scholarly',      'practical / scholarly',      '{"kind":"practical","family":"scholarly","weight":0.8,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}'),
    ('credibility_weights', 'practical.general',        'practical / general',        '{"kind":"practical","family":"general","weight":1.0,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}')
ON CONFLICT (registry, key) DO NOTHING;

-- Domain credibility classes (D15 item 10: academic, government, news, general; commerce added
-- by registration for the retail pool filtering.ts already sinks). The highest class plus an
-- author stays under the claim floor: a single uncorroborated general source starts below it.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('domain_classes', 'government', 'government', '{"order":1,"score":0.42,"host_patterns":["\\.gov$","\\.mil$","\\.gov\\.[a-z]{2}$","(^|\\.)europa\\.eu$","(^|\\.)who\\.int$"]}'),
    ('domain_classes', 'academic',   'academic',   '{"order":2,"score":0.40,"host_patterns":["\\.edu$","\\.ac\\.[a-z]{2}$","\\.edu\\.[a-z]{2}$","(^|\\.)arxiv\\.org$","(^|\\.)nature\\.com$","(^|\\.)science\\.org$","(^|\\.)sciencedirect\\.com$","(^|\\.)springer\\.com$","(^|\\.)wiley\\.com$","(^|\\.)frontiersin\\.org$","(^|\\.)plos\\.org$","(^|\\.)pnas\\.org$","(^|\\.)ieee\\.org$","(^|\\.)acm\\.org$","(^|\\.)jstor\\.org$","(^|\\.)biorxiv\\.org$","(^|\\.)medrxiv\\.org$","(^|\\.)semanticscholar\\.org$","(^|\\.)doi\\.org$","(^|\\.)ncbi\\.nlm\\.nih\\.gov$"]}'),
    ('domain_classes', 'news',       'news',       '{"order":3,"score":0.32,"host_patterns":["(^|\\.)reuters\\.com$","(^|\\.)apnews\\.com$","(^|\\.)bbc\\.(co\\.uk|com)$","(^|\\.)nytimes\\.com$","(^|\\.)theguardian\\.com$","(^|\\.)washingtonpost\\.com$","(^|\\.)ft\\.com$","(^|\\.)bloomberg\\.com$","(^|\\.)economist\\.com$","(^|\\.)arstechnica\\.com$","(^|\\.)theverge\\.com$","(^|\\.)wired\\.com$","(^|\\.)cnn\\.com$","(^|\\.)npr\\.org$"]}'),
    ('domain_classes', 'commerce',   'commerce',   '{"order":4,"score":0.05,"host_patterns":["(^|\\.)amazon\\.[a-z.]+$","(^|\\.)ebay\\.[a-z.]+$","(^|\\.)walmart\\.com$","(^|\\.)lowes\\.com$","(^|\\.)homedepot\\.com$","(^|\\.)bestbuy\\.com$","(^|\\.)target\\.com$","(^|\\.)etsy\\.com$","(^|\\.)aliexpress\\.[a-z.]+$","(^|\\.)alibaba\\.com$","(^|\\.)temu\\.com$","(^|\\.)wayfair\\.com$","(^|\\.)pinterest\\.[a-z.]+$","(^|\\.)groupon\\.com$","(^|\\.)wish\\.com$"]}'),
    ('domain_classes', 'general',    'general',    '{"order":99,"score":0.22,"fallback":true,"host_patterns":[]}')
ON CONFLICT (registry, key) DO NOTHING;

-- The paper score (D15 item 2), versioned. p1: credible on publication (base); citations read
-- as a RATE against age after a grace period in which a new paper gets grace_credit of the
-- citation term; the best-published author adds the author term. Saturating terms x/(x+half).
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('paper_score_versions', 'p1', 'paper score p1',
        '{"active":true,"base":0.6,"cite_weight":0.25,"cite_rate_half":10,"grace_years":2,"grace_credit":0.5,"author_weight":0.15,"author_half":50}')
ON CONFLICT (registry, key) DO NOTHING;

-- Entailment verdicts (D10): one per cited line. tag_effect is what the stage does to the line;
-- transfers is whether corroboration may move between sources on it (D15 item 3).
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('entailment_verdicts', 'supports',    'supports',    '{"order":1,"tag_effect":"keep","transfers":true}'),
    ('entailment_verdicts', 'partial',     'partial',     '{"order":2,"tag_effect":"uncertain","transfers":false}'),
    ('entailment_verdicts', 'unsupported', 'unsupported', '{"order":3,"tag_effect":"gap","transfers":false}')
ON CONFLICT (registry, key) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('admission_trail_kinds', 'admitted',     'admitted before fetch',       '{"sources_row":"allowed"}'),
    ('admission_trail_kinds', 'lead',         'below floor: a lead',         '{"sources_row":"never"}'),
    ('admission_trail_kinds', 'lead_path',    'a lead reached a credible source', '{"sources_row":"never","sets":"found_via on the target"}'),
    ('admission_trail_kinds', 'lead_dropped', 'a lead that reached nothing', '{"sources_row":"never"}'),
    ('admission_trail_kinds', 'held_folded',  'a held source folded in',     '{"sources_row":"moved from held_sources"}'),
    ('admission_trail_kinds', 'held_kept',    'a held source stays held',    '{"sources_row":"never"}'),
    ('admission_trail_kinds', 'tombstoned',   'a tombstoned URL met the stage', '{"sources_row":"per the D5 reopening path"}')
ON CONFLICT (registry, key) DO NOTHING;

-- The general family's signal terms (D15 item 10) and the corroboration terms (item 3). The
-- source_families rows were seeded by P0; their definitions gain the terms here (a versioned
-- change: the entry and the registry versions move).
UPDATE public.contract_registry_entries
   SET definition = definition || '{"terms":{"author_identity":0.05,"link_per":0.05,"link_cap":0.15,"agreement_per":0.05,"agreement_cap":0.10}}'::jsonb
 WHERE registry = 'source_families' AND key = 'general' AND NOT (definition ? 'terms');
UPDATE public.contract_registry_entries
   SET definition = definition || '{"scorer":"paper_score_versions"}'::jsonb
 WHERE registry = 'source_families' AND key = 'scholarly' AND NOT (definition ? 'scorer');
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('credibility_terms', 'corroboration', 'corroboration',
        '{"term_version":1,"strong_factor":0.5,"weak_factor":0.1,"claim_per":0.5,"claim_cap":0.35}'),
    -- attempt 4 (tester finding F2): what a grounding edge's TYPE multiplies a source's total by in a
    -- claim - attempt 3 wrote the 0.67 as a literal here and credibility.ts had none. One row, read by
    -- claim_confidence_d15 and by credibility.ts buildModel (edgeFactors); contradicts edges never count.
    ('credibility_terms', 'edge_factors', 'claim edge factors',
        '{"term_version":1,"states":1.0,"corroborates":1.0,"inferred_from":0.67}')
ON CONFLICT (registry, key) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('trail_event_kinds', 'folded',     'folded from held', '{}'),
    ('trail_event_kinds', 'found_via',  'reached through a lead', '{}')
ON CONFLICT (registry, key) DO NOTHING;

-- The weight table's own constraints (attempt 2). A malformed row is refused at write time, so
-- neither twin ever meets one; both twins still refuse one at read time (credibility_weight /
-- buildModel) in case the constraint is ever dropped. One ACTIVE row per kind x family: the
-- version is registry-wide, so "per version" is "among the rows not retired".
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_registry_entries_credibility_weight_ok'
                     AND conrelid = 'public.contract_registry_entries'::regclass) THEN
        ALTER TABLE public.contract_registry_entries ADD CONSTRAINT contract_registry_entries_credibility_weight_ok
            CHECK (registry <> 'credibility_weights' OR public.credibility_weight_row_ok(definition));
    END IF;
END $$;
-- Attempt 3: a claim kind's cues and a domain class's host patterns are arrays of patterns that
-- compile (credibility.ts builds each with `new RegExp(.., "i")`, this file matches with `~*`). An
-- invalid pattern raises here, so the write is refused; the seeded patterns are in the subset both
-- dialects read the same way.
CREATE OR REPLACE FUNCTION public.credibility_patterns_ok(p_registry TEXT, p_def JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE v JSONB := p_def -> CASE p_registry WHEN 'claim_kinds' THEN 'cues' ELSE 'host_patterns' END; p TEXT;
BEGIN
    IF v IS NULL THEN RETURN TRUE; END IF;
    IF jsonb_typeof(v) <> 'array' THEN RETURN FALSE; END IF;
    FOR p IN SELECT jsonb_array_elements_text(v) LOOP
        PERFORM '' ~* p;    -- raises invalid_regular_expression for a pattern that does not compile
    END LOOP;
    RETURN TRUE;
END;
$$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_registry_entries_credibility_patterns_ok'
                     AND conrelid = 'public.contract_registry_entries'::regclass) THEN
        ALTER TABLE public.contract_registry_entries ADD CONSTRAINT contract_registry_entries_credibility_patterns_ok
            CHECK (registry NOT IN ('claim_kinds', 'domain_classes') OR public.credibility_patterns_ok(registry, definition));
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credibility_weights_kind_family
    ON public.contract_registry_entries ((definition ->> 'kind'), (definition ->> 'family'))
 WHERE registry = 'credibility_weights' AND retired_at IS NULL;
-- Attempt 3 (tester near-miss: two ACTIVE paper score versions were accepted; this file labelled
-- one with LIMIT 1, TS refused): exactly one active version is the rule in both twins, and a
-- second one is refused at write time. `active` is the JSON value true (TS: `=== true`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_score_versions_one_active
    ON public.contract_registry_entries ((registry))
 WHERE registry = 'paper_score_versions' AND retired_at IS NULL AND definition -> 'active' = 'true'::jsonb;

-- Who may change the model (attempt 2, tester finding 2 / 4f). The credibility registries are
-- rows in P0's shared contract_registry_entries, which service_role may write (FOR ALL policy) -
-- so a GRANT cannot single them out. This trigger does: an INSERT, UPDATE or DELETE of a row in
-- a registry the D15 model reads is refused unless the caller is (a member of) the table's
-- owner - the migration and the operator's tuning session. An app role (service_role, its
-- member ob_app_memory) READS every row and cannot change a weight, a floor, a paper score, a
-- domain class, a verdict or a corroboration term - before the trigger flip or after it.
-- source_families (P0's registry, read by the model) refuses UPDATE / DELETE the same way; an
-- INSERT stays open (P0's expansion by registration): a new family has no weight rows, so it can
-- only stop the gate loudly (OBC01), never change a number.
CREATE OR REPLACE FUNCTION public.trg_credibility_registry_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_guarded TEXT[] := ARRAY['claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                              'entailment_verdicts', 'admission_trail_kinds', 'credibility_terms'];
    v_regs TEXT[];
    v_owner OID;
BEGIN
    v_regs := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.registry]
                         WHEN 'DELETE' THEN ARRAY[OLD.registry]
                         ELSE ARRAY[OLD.registry, NEW.registry] END;
    IF v_regs && v_guarded OR (TG_OP <> 'INSERT' AND 'source_families' = ANY (v_regs)) THEN
        SELECT c.relowner INTO v_owner FROM pg_class c WHERE c.oid = TG_RELID;
        IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
            RAISE EXCEPTION 'permission denied: % of a % row by role % - the D15 model''s registries are changed only by their owner (D15 items 9-10)',
                TG_OP, array_to_string(v_regs, '/'), current_user
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_credibility_registry_guard ON public.contract_registry_entries;
CREATE TRIGGER trg_credibility_registry_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.contract_registry_entries
    FOR EACH ROW EXECUTE FUNCTION public.trg_credibility_registry_guard();

-- Attempt 3 (tester (2b)): an app role could `UPDATE contract_registries SET version = 77 WHERE
-- name = 'credibility_weights'` and relabel the model ("d15 weights v77"), or move a version to
-- stale a confirmation's digest. The D15 registries' rows in P0's contract_registries (the
-- version counter the label reads) are changed only by their owner - the bump trigger above
-- runs as the caller, and only the owner can change an entry of these registries, so only the
-- owner's writes bump them. source_families stays P0's (an app role's family INSERT bumps it).
-- TRUNCATE (statement level; row triggers never see it) of the registries and of every
-- credibility table is refused for any role but the owner; the grants below also REVOKE it, so
-- an app role is refused by privilege first and by this trigger if a later GRANT ALL
-- (init-grants.sql re-run) hands TRUNCATE back.
CREATE OR REPLACE FUNCTION public.trg_credibility_owner_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_guarded TEXT[] := ARRAY['claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                              'entailment_verdicts', 'admission_trail_kinds', 'credibility_terms'];
    v_owner OID;
    v_hit BOOLEAN;
BEGIN
    v_hit := CASE WHEN TG_OP = 'TRUNCATE' THEN TRUE
                  WHEN TG_OP = 'INSERT' THEN NEW.name = ANY (v_guarded)
                  WHEN TG_OP = 'DELETE' THEN OLD.name = ANY (v_guarded)
                  ELSE OLD.name = ANY (v_guarded) OR NEW.name = ANY (v_guarded) END;
    IF v_hit THEN
        SELECT c.relowner INTO v_owner FROM pg_class c WHERE c.oid = TG_RELID;
        IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
            RAISE EXCEPTION 'permission denied: % of %.% by role % - the D15 model is changed only by its owner (D15 items 9-10)',
                TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'TRUNCATE' THEN NULL WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_credibility_registries_guard ON public.contract_registries;
CREATE TRIGGER trg_credibility_registries_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.contract_registries
    FOR EACH ROW EXECUTE FUNCTION public.trg_credibility_owner_only();
DROP TRIGGER IF EXISTS trg_credibility_registries_truncate ON public.contract_registries;
CREATE TRIGGER trg_credibility_registries_truncate
    BEFORE TRUNCATE ON public.contract_registries
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_credibility_owner_only();
DROP TRIGGER IF EXISTS trg_credibility_registry_entries_truncate ON public.contract_registry_entries;
CREATE TRIGGER trg_credibility_registry_entries_truncate
    BEFORE TRUNCATE ON public.contract_registry_entries
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_credibility_owner_only();

-- ── 2. records ──────────────────────────────────────────────────────────
-- Every hit the pre-ingestion stage judged. A below-floor hit is a lead and lives ONLY here
-- (never a sources row, D15 item 8); source_id is set only for a hit that became a source.
CREATE TABLE IF NOT EXISTS public.research_admission_trail (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id        UUID,
    session_id    UUID,
    url           TEXT NOT NULL,
    url_key       TEXT NOT NULL,
    kind          TEXT NOT NULL,            -- registry admission_trail_kinds
    claim_kind    TEXT,                     -- registry claim_kinds
    family        TEXT,                     -- registry source_families
    score         DOUBLE PRECISION,         -- attempt 3: the TS twin's doubles, stored as they are
    total         DOUBLE PRECISION,
    floor         DOUBLE PRECISION,
    model_version TEXT,
    signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
    reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
    found_via     UUID,                     -- the lead's trail id, or the held source id
    path          JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_id     UUID,                     -- no FK: the trail outlives the row
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_admission_trail_job ON public.research_admission_trail (job_id);
CREATE INDEX IF NOT EXISTS idx_research_admission_trail_url ON public.research_admission_trail (url_key);
CREATE INDEX IF NOT EXISTS idx_research_admission_trail_src ON public.research_admission_trail (source_id);

-- The per-reference rolling total with reasons, appended on every scoring (the "history").
CREATE TABLE IF NOT EXISTS public.source_credibility_history (
    id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    source_id     UUID NOT NULL,
    family        TEXT NOT NULL,
    claim_kind    TEXT,
    score         DOUBLE PRECISION NOT NULL,
    total         DOUBLE PRECISION,
    model_version TEXT NOT NULL,
    signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
    reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
    job_id        UUID,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_credibility_history_src ON public.source_credibility_history (source_id, computed_at DESC);

-- Entailment-gated transfers (D15 item 3). A row exists only for a `supports` verdict; the
-- paper -> source row is the strong one, the source -> paper row the weak one.
-- Attempt 2 (tester near-misses): an amount is a credibility number in [0, 1] (it is a factor
-- <= 1 of a total <= 1; NaN and negatives are refused - REAL NaN sorts above every number, so
-- `amount <= 1` refuses it); a source never corroborates itself; and ONE row per giver ->
-- receiver -> line: the key no longer includes model_version, so re-running a line after the
-- weights are tuned REPLACES the pair's row (kb.ts recordCorroboration upserts) instead of
-- adding a second one that the rolling total would sum.
CREATE TABLE IF NOT EXISTS public.source_corroborations (
    id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    from_source_id UUID NOT NULL,
    to_source_id   UUID NOT NULL,
    strength       TEXT NOT NULL CHECK (strength IN ('strong', 'weak')),
    amount         DOUBLE PRECISION NOT NULL,   -- attempt 3: REAL stored 1.00000001 as 1 and refused 1e-50
    claim_text     TEXT NOT NULL,
    claim_kind     TEXT NOT NULL,
    verdict        TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    job_id         UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
DECLARE c TEXT;
BEGIN
    -- attempt 1's key (from, to, claim_text, model_version) let a weight change double a pair
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'public.source_corroborations'::regclass AND contype = 'u'
                AND conname <> 'source_corroborations_one_per_line' LOOP
        EXECUTE format('ALTER TABLE public.source_corroborations DROP CONSTRAINT %I', c);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.source_corroborations'::regclass
                     AND conname = 'source_corroborations_one_per_line') THEN
        ALTER TABLE public.source_corroborations ADD CONSTRAINT source_corroborations_one_per_line
            UNIQUE (from_source_id, to_source_id, claim_text);
    END IF;
    -- attempt 4 (tester finding F1): the representable range, 0 or [1e-9, 1] (attempt 3: [0, 1],
    -- which let 5e-324 in); an earlier definition of the constraint is replaced
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.source_corroborations'::regclass
                 AND conname = 'source_corroborations_amount_unit'
                 AND pg_get_constraintdef(oid) NOT LIKE '%credibility_is_unit_value%') THEN
        ALTER TABLE public.source_corroborations DROP CONSTRAINT source_corroborations_amount_unit;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.source_corroborations'::regclass
                     AND conname = 'source_corroborations_amount_unit') THEN
        ALTER TABLE public.source_corroborations ADD CONSTRAINT source_corroborations_amount_unit
            CHECK (public.credibility_is_unit_value(amount));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.source_corroborations'::regclass
                     AND conname = 'source_corroborations_not_self') THEN
        ALTER TABLE public.source_corroborations ADD CONSTRAINT source_corroborations_not_self
            CHECK (from_source_id <> to_source_id);
    END IF;
END $$;
-- attempt 3: a database that ran an earlier version of this file has these columns as REAL
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND data_type = 'real'
                AND (table_name, column_name) IN (('source_corroborations', 'amount'),
                     ('source_credibility_history', 'score'), ('source_credibility_history', 'total'),
                     ('research_admission_trail', 'score'), ('research_admission_trail', 'total'),
                     ('research_admission_trail', 'floor')) LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE DOUBLE PRECISION', c.table_name, c.column_name);
    END LOOP;
END $$;
-- Attempt 4 (tester finding F1 and near-miss P4): claim_sources.weight (init-claims.sql's REAL, written
-- by the app roles through link_claim_to_source) had no CHECK - NaN, Infinity and 5 scored a claim 1.0
-- under D15, and 1e-45 gave a total the stored twin could not hold. Now 0 or in [1e-9, 1]
-- (credibility_is_unit_value of the stored value; research-curator claim-edges.ts edgeWeightOk is the
-- writer's twin). And a stamp (sources.metadata.credibility) is well formed (credibility_stamp_ok).
-- Both are added NOT VALID and then validated: on a database whose existing rows already satisfy
-- them (every pre-P3a row: weights 1.0 / 0.5, no stamps) they end validated; if an existing row does
-- not, the constraint still holds every new write and a NOTICE names the table (the read path refuses
-- such a row loudly, OBC04).
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('claim_sources', 'claim_sources_weight_credibility', 'public.credibility_is_unit_value(weight::double precision)'),
        ('sources', 'sources_credibility_stamp_ok', 'public.credibility_stamp_ok(metadata)')) AS v(tb, con, expr) LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.con AND conrelid = ('public.' || c.tb)::regclass) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID', c.tb, c.con, c.expr);
        END IF;
        BEGIN
            EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tb, c.con);
        EXCEPTION WHEN check_violation THEN
            RAISE NOTICE 'rw-p3a-entail: existing rows of public.% do not satisfy % - it holds new writes; the read path refuses those rows (OBC04)', c.tb, c.con;
        END;
    END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_source_corroborations_to   ON public.source_corroborations (to_source_id);
CREATE INDEX IF NOT EXISTS idx_source_corroborations_from ON public.source_corroborations (from_source_id);

CREATE OR REPLACE FUNCTION public.trg_source_corroborations_supports_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- attempt 3: the JSON value true, as credibility.ts reads it (`=== true`), never "true"
    IF NOT COALESCE((SELECT e.definition -> 'transfers' = 'true'::jsonb
                       FROM public.contract_registry_entries e
                      WHERE e.registry = 'entailment_verdicts' AND e.key = NEW.verdict AND e.retired_at IS NULL), FALSE) THEN
        RAISE EXCEPTION 'corroboration refused: verdict % does not transfer (D15 item 3)', NEW.verdict
            USING ERRCODE = 'OBC02';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_source_corroborations_supports_only ON public.source_corroborations;
CREATE TRIGGER trg_source_corroborations_supports_only
    BEFORE INSERT OR UPDATE ON public.source_corroborations
    FOR EACH ROW EXECUTE FUNCTION public.trg_source_corroborations_supports_only();

-- Which model the claim-confidence trigger uses. NOT a contract setting (the workbench's settings
-- PUT would be a way around the gate): one row, readable by the app roles, changed only by
-- credibility_apply_d15_trigger() run by the table owner (the operator's rescore-gate.ts).
CREATE TABLE IF NOT EXISTS public.credibility_trigger_state (
    singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    model           TEXT NOT NULL DEFAULT 'legacy',
    confirmation_id UUID,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The P3a CUTOVER marker (attempt 2, tester near-miss "a claim filed after P3a without a kind"):
-- the moment this migration was applied. A claim created before it carries no claim_kind
-- because nothing recorded one then - it takes the registry's declared fallback kind and says
-- so. A claim created at or after it was filed by a curator that stamps the kind (research-
-- curator claimMetadataFor refuses a package without one), so a kindless one is a defect: the
-- gate stops naming it (OBC01, D15 item 9), never the fallback. Read-only to the app roles with
-- the rest of the row (the grants below), so an app cannot move it.
ALTER TABLE public.credibility_trigger_state ADD COLUMN IF NOT EXISTS kind_required_from TIMESTAMPTZ NOT NULL DEFAULT now();
INSERT INTO public.credibility_trigger_state (singleton, model) VALUES (TRUE, 'legacy') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.credibility_rescore_confirmations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    view_digest       TEXT NOT NULL,
    model_version     TEXT NOT NULL,
    confirmed_by      TEXT NOT NULL,
    findings_ref      TEXT NOT NULL,     -- the findings-sink file the confirmation is recorded in
    confirmation_line TEXT NOT NULL,     -- the line, verbatim
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at        TIMESTAMPTZ,
    applied_claims    INT
);
-- Attempt 3 (tester (7): a second `rescore-gate.ts --apply` re-minted the spent confirmation): one
-- confirmation per view digest. credibility_record_confirmation returns the existing row's id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credibility_rescore_confirmations_digest
    ON public.credibility_rescore_confirmations (view_digest);

-- ── the claim's filing time (attempt 3, tester near-miss: a writer that set created_at to 2020
-- made a kindless claim filed now take the pre-P3a fallback). claims.filed_at is SET BY THE SERVER
-- on INSERT (now(), whatever the writer sends - the owner included) and changed afterwards only by
-- the table's owner (the operator's deploy remedy, the tests' "this claim predates P3a"). A claim
-- that existed when this column was added has filed_at NULL: it predates P3a. claim_kind_of reads
-- filed_at, never created_at (a column every writer may set).
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS filed_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION public.trg_claims_filed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE v_owner OID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.filed_at := now();
    ELSIF NEW.filed_at IS DISTINCT FROM OLD.filed_at THEN
        SELECT c.relowner INTO v_owner FROM pg_class c WHERE c.oid = TG_RELID;
        IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
            RAISE EXCEPTION 'permission denied: claims.filed_at is set by the server when a claim is filed (role %)', current_user
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_claims_filed_at ON public.claims;
CREATE TRIGGER trg_claims_filed_at
    BEFORE INSERT OR UPDATE ON public.claims
    FOR EACH ROW EXECUTE FUNCTION public.trg_claims_filed_at();

-- ── 3. the model's claim total ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credibility_model_version()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT 'd15 weights v' || COALESCE((SELECT version FROM public.contract_registries WHERE name = 'credibility_weights'), 0)
        || ' paper ' || COALESCE((SELECT key FROM public.contract_registry_entries
                                   WHERE registry = 'paper_score_versions' AND retired_at IS NULL
                                     AND definition -> 'active' = 'true'::jsonb ORDER BY key LIMIT 1), '?');
$$;

CREATE OR REPLACE FUNCTION public.credibility_weight(p_kind TEXT, p_family TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE d JSONB; n INT;
BEGIN
    SELECT count(*), min(e.definition::text)::jsonb INTO n, d FROM public.contract_registry_entries e
     WHERE e.registry = 'credibility_weights' AND e.retired_at IS NULL
       AND e.definition ->> 'kind' = p_kind AND e.definition ->> 'family' = p_family;
    IF n = 0 THEN
        RAISE EXCEPTION 'the weight table (%) has no row for claim kind ''%'' and family ''%'' - the gate stops (D15 item 9)',
            public.credibility_model_version(), p_kind, p_family
            USING ERRCODE = 'OBC01';
    END IF;
    -- attempt 2: never one of two rows "arbitrarily", never a malformed row (the unique index and
    -- the CHECK make both impossible; this is the read-time half, buildModel's twin)
    IF n > 1 THEN
        RAISE EXCEPTION 'the weight table (%) has % active rows for claim kind ''%'' and family ''%'' - the gate stops',
            public.credibility_model_version(), n, p_kind, p_family
            USING ERRCODE = 'OBC04';
    END IF;
    IF NOT public.credibility_weight_row_ok(d) THEN
        RAISE EXCEPTION 'the weight table (%) row for claim kind ''%'' and family ''%'' is malformed (%) - weight, admission_floor and claim_floor must be numbers in [0, 1]; the gate stops',
            public.credibility_model_version(), p_kind, p_family, d
            USING ERRCODE = 'OBC04';
    END IF;
    RETURN d;
END;
$$;

-- The claim floor of a kind (attempt 3): the HIGHEST claim_floor among the kind's family rows -
-- credibility.ts lineCredibility's floor. Attempt 2's view read the general row's alone.
CREATE OR REPLACE FUNCTION public.credibility_claim_floor(p_kind TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
DECLARE f RECORD; v DOUBLE PRECISION;
BEGIN
    -- the SCORED families (attempt 3): those with at least one active weight row
    FOR f IN SELECT e.key FROM public.contract_registry_entries e WHERE e.registry = 'source_families' AND e.retired_at IS NULL
                AND EXISTS (SELECT 1 FROM public.contract_registry_entries w WHERE w.registry = 'credibility_weights'
                           AND w.retired_at IS NULL AND w.definition ->> 'family' = e.key) LOOP
        v := GREATEST(v, public.credibility_unit(public.credibility_weight(p_kind, f.key), 'claim_floor',
                                                 'weight row ' || p_kind || '.' || f.key));
    END LOOP;
    RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.credibility_fallback_kind()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT key FROM public.contract_registry_entries
     WHERE registry = 'claim_kinds' AND retired_at IS NULL AND definition -> 'fallback' = 'true'::jsonb
     ORDER BY key LIMIT 1;
$$;

-- The domain class of a URL, from the registry's host patterns (first match by order).
CREATE OR REPLACE FUNCTION public.credibility_domain_class(p_url TEXT, p_domain TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    WITH h AS (
        SELECT lower(regexp_replace(COALESCE(NULLIF(p_domain, ''),
                     substring(COALESCE(p_url, '') from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#:]+)')), '^www\.', '')) AS host
    )
    SELECT COALESCE(
        (SELECT e.key FROM public.contract_registry_entries e, h
          WHERE e.registry = 'domain_classes' AND e.retired_at IS NULL
            AND e.definition -> 'fallback' IS DISTINCT FROM 'true'::jsonb
            AND h.host IS NOT NULL
            AND jsonb_typeof(e.definition -> 'host_patterns') = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.definition -> 'host_patterns') p WHERE h.host ~* p)
          ORDER BY COALESCE((e.definition ->> 'order')::float8, 100) LIMIT 1),
        (SELECT key FROM public.contract_registry_entries
          WHERE registry = 'domain_classes' AND retired_at IS NULL AND definition -> 'fallback' = 'true'::jsonb ORDER BY key LIMIT 1));
$$;

-- THE WHOLE-MODEL CHECK (attempt 3): the SQL twin refuses every registry table credibility.ts
-- buildModel / validateTable refuses, so the two never compute from a table one of them rejects
-- (tester: 'practical ' rows and two active paper versions were computed here and refused there).
-- The write-time CHECK / unique indexes make most of these impossible; this is the read-time half
-- for a constraint the owner dropped. Raised: OBC01 for a missing kind x family row (as
-- credibility_weight), OBC04 for everything malformed. Each check's TS line is named.
CREATE OR REPLACE FUNCTION public.credibility_model_check()
RETURNS VOID
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    r RECORD; n INT; v_bad TEXT; v_def JSONB; v_gen JSONB; v_corr JSONB; v_best DOUBLE PRECISION;
    v_maxgen DOUBLE PRECISION; v_paper DOUBLE PRECISION; v_general DOUBLE PRECISION; v_g JSONB; v_s JSONB;
BEGIN
    -- claim kinds: orders are integers (TS `order`), cues compile, exactly one fallback
    SELECT string_agg(key, ', ' ORDER BY key) INTO v_bad FROM public.contract_registry_entries
     WHERE registry = 'claim_kinds' AND retired_at IS NULL AND NOT public.credibility_is_order(definition -> 'order');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'credibility registry: claim_kinds % order is not an integer - the gate stops', v_bad USING ERRCODE = 'OBC04';
    END IF;
    SELECT count(*) INTO n FROM public.contract_registry_entries
     WHERE registry = 'claim_kinds' AND retired_at IS NULL AND definition -> 'fallback' = 'true'::jsonb;
    IF n <> 1 THEN
        RAISE EXCEPTION 'claim_kinds: exactly one entry must be declared fallback (% are) - the gate stops', n USING ERRCODE = 'OBC04';
    END IF;
    -- weight rows (TS buildModel's loop): well formed, naming a registered kind and family, one per pair
    FOR r IN SELECT key, definition FROM public.contract_registry_entries
              WHERE registry = 'credibility_weights' AND retired_at IS NULL ORDER BY key LOOP
        IF NOT public.credibility_weight_row_ok(r.definition) THEN
            RAISE EXCEPTION 'credibility_weights.%: the row is malformed (%) - the gate stops', r.key, r.definition USING ERRCODE = 'OBC04';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.contract_registry_entries k WHERE k.registry = 'claim_kinds'
                         AND k.retired_at IS NULL AND k.key = r.definition ->> 'kind') THEN
            RAISE EXCEPTION 'credibility_weights.%: claim kind ''%'' is not registered - the gate stops', r.key, r.definition ->> 'kind'
                USING ERRCODE = 'OBC04';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.contract_registry_entries f WHERE f.registry = 'source_families'
                         AND f.retired_at IS NULL AND f.key = r.definition ->> 'family') THEN
            RAISE EXCEPTION 'credibility_weights.%: source family ''%'' is not registered - the gate stops', r.key, r.definition ->> 'family'
                USING ERRCODE = 'OBC04';
        END IF;
    END LOOP;
    SELECT definition ->> 'kind' AS kind, definition ->> 'family' AS family, count(*) AS n INTO r
      FROM public.contract_registry_entries WHERE registry = 'credibility_weights' AND retired_at IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1 ORDER BY 1, 2 LIMIT 1;
    IF r.kind IS NOT NULL THEN
        RAISE EXCEPTION 'credibility_weights: two active rows for claim kind ''%'' and family ''%'' - the gate stops', r.kind, r.family
            USING ERRCODE = 'OBC04';
    END IF;
    -- domain classes: integer orders, distinct, scores are credibility numbers, exactly one fallback
    SELECT string_agg(key, ', ' ORDER BY key) INTO v_bad FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND retired_at IS NULL
       AND (NOT public.credibility_is_order(definition -> 'order') OR NOT public.credibility_is_unit(definition -> 'score'));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'credibility registry: domain_classes % has a malformed order or score - the gate stops', v_bad USING ERRCODE = 'OBC04';
    END IF;
    SELECT COALESCE((definition ->> 'order')::float8, 100) AS o, count(*) AS n INTO r FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND retired_at IS NULL GROUP BY 1 HAVING count(*) > 1 LIMIT 1;
    IF r.n IS NOT NULL THEN
        RAISE EXCEPTION 'domain_classes: % classes share order % - the gate stops', r.n, r.o USING ERRCODE = 'OBC04';
    END IF;
    SELECT count(*) INTO n FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND retired_at IS NULL AND definition -> 'fallback' = 'true'::jsonb;
    IF n <> 1 THEN
        RAISE EXCEPTION 'domain_classes: exactly one entry must be declared fallback (% are) - the gate stops', n USING ERRCODE = 'OBC04';
    END IF;
    -- (regex patterns: compiled at WRITE time by contract_registry_entries_credibility_patterns_ok,
    -- below - a pattern that does not compile is refused when it is written, as `new RegExp` refuses
    -- it when the TS model is built; a pattern valid in one regex dialect only is a named residual)
    -- the paper score: exactly one active version, every number in range
    SELECT count(*), min(definition::text)::jsonb INTO n, v_def FROM public.contract_registry_entries
     WHERE registry = 'paper_score_versions' AND retired_at IS NULL AND definition -> 'active' = 'true'::jsonb;
    IF n <> 1 THEN
        RAISE EXCEPTION 'paper_score_versions: % active versions (exactly one required) - the gate stops', n USING ERRCODE = 'OBC04';
    END IF;
    IF NOT (public.credibility_is_unit(v_def -> 'base') AND public.credibility_is_unit(v_def -> 'cite_weight')
            AND public.credibility_is_positive(v_def -> 'cite_rate_half', FALSE) AND public.credibility_is_positive(v_def -> 'grace_years', TRUE)
            AND public.credibility_is_unit(v_def -> 'grace_credit') AND public.credibility_is_unit(v_def -> 'author_weight')
            AND public.credibility_is_positive(v_def -> 'author_half', FALSE)) THEN
        RAISE EXCEPTION 'paper_score_versions: the active version is malformed (%) - the gate stops', v_def USING ERRCODE = 'OBC04';
    END IF;
    -- the general family's terms (TS: required, no `?? 0`)
    SELECT definition -> 'terms' INTO v_gen FROM public.contract_registry_entries
     WHERE registry = 'source_families' AND key = 'general' AND retired_at IS NULL;
    IF NOT COALESCE(public.credibility_is_unit(v_gen -> 'author_identity') AND public.credibility_is_unit(v_gen -> 'link_per')
            AND public.credibility_is_unit(v_gen -> 'link_cap') AND public.credibility_is_unit(v_gen -> 'agreement_per')
            AND public.credibility_is_unit(v_gen -> 'agreement_cap'), FALSE) THEN
        RAISE EXCEPTION 'source_families.general: the terms are missing or malformed (%) - the gate stops', v_gen USING ERRCODE = 'OBC04';
    END IF;
    -- entailment verdicts: tag_effect keep|uncertain|gap
    SELECT string_agg(key, ', ' ORDER BY key) INTO v_bad FROM public.contract_registry_entries
     WHERE registry = 'entailment_verdicts' AND retired_at IS NULL
       AND (jsonb_typeof(definition -> 'tag_effect') IS DISTINCT FROM 'string' OR definition ->> 'tag_effect' NOT IN ('keep', 'uncertain', 'gap'));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'entailment_verdicts.%: tag_effect is not keep|uncertain|gap - the gate stops', v_bad USING ERRCODE = 'OBC04';
    END IF;
    -- the corroboration terms
    SELECT definition INTO v_corr FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'corroboration' AND retired_at IS NULL;
    IF NOT COALESCE(public.credibility_is_unit(v_corr -> 'strong_factor') AND public.credibility_is_unit(v_corr -> 'weak_factor')
            AND public.credibility_is_unit(v_corr -> 'claim_per') AND public.credibility_is_unit(v_corr -> 'claim_cap'), FALSE) THEN
        RAISE EXCEPTION 'credibility_terms.corroboration: the terms are missing or malformed (%) - the gate stops', v_corr USING ERRCODE = 'OBC04';
    END IF;
    -- the edge factors (attempt 4; TS buildModel edgeFactors): states, corroborates, inferred_from
    SELECT definition INTO v_corr FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'edge_factors' AND retired_at IS NULL;
    IF NOT COALESCE(public.credibility_is_unit(v_corr -> 'states') AND public.credibility_is_unit(v_corr -> 'corroborates')
            AND public.credibility_is_unit(v_corr -> 'inferred_from'), FALSE) THEN
        RAISE EXCEPTION 'credibility_terms.edge_factors: the factors are missing or malformed (%) - the gate stops', v_corr USING ERRCODE = 'OBC04';
    END IF;
    -- every kind has a row for every SCORED family (TS validateTable over scoredFamilies): a family
    -- registered without any weight row (P0's expansion by registration) is not in the model yet and
    -- stops nothing until a source of it is scored (credibility_weight then stops the gate, naming it)
    SELECT k.key AS kind, f.key AS family INTO r
      FROM public.contract_registry_entries k CROSS JOIN public.contract_registry_entries f
     WHERE k.registry = 'claim_kinds' AND k.retired_at IS NULL AND f.registry = 'source_families' AND f.retired_at IS NULL
       AND EXISTS (SELECT 1 FROM public.contract_registry_entries w WHERE w.registry = 'credibility_weights'
                           AND w.retired_at IS NULL AND w.definition ->> 'family' = f.key)
       AND NOT EXISTS (SELECT 1 FROM public.contract_registry_entries w WHERE w.registry = 'credibility_weights' AND w.retired_at IS NULL
                         AND w.definition ->> 'kind' = k.key AND w.definition ->> 'family' = f.key)
     ORDER BY 1, 2 LIMIT 1;
    IF r.kind IS NOT NULL THEN
        RAISE EXCEPTION 'the weight table (%) has no row for claim kind ''%'' and family ''%'' - the gate stops (D15 item 9)',
            public.credibility_model_version(), r.kind, r.family USING ERRCODE = 'OBC01';
    END IF;
    -- papers_outrank (TS validateTable): the weakest paper above the strongest general source
    SELECT max((definition ->> 'score')::float8) INTO v_best FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND retired_at IS NULL;
    v_maxgen := LEAST(1::float8, v_best + (v_gen ->> 'author_identity')::float8 + (v_gen ->> 'link_cap')::float8 + (v_gen ->> 'agreement_cap')::float8);
    FOR r IN SELECT key FROM public.contract_registry_entries
              WHERE registry = 'claim_kinds' AND retired_at IS NULL AND definition -> 'papers_outrank' = 'true'::jsonb ORDER BY key LOOP
        v_s := public.credibility_weight(r.key, 'scholarly');
        v_g := public.credibility_weight(r.key, 'general');
        v_paper := (v_s ->> 'weight')::float8 * (v_def ->> 'base')::float8;
        v_general := (v_g ->> 'weight')::float8 * LEAST(1::float8, v_maxgen + COALESCE((v_g ->> 'primary_bonus')::float8, 0));
        IF NOT (v_paper > v_general) THEN
            RAISE EXCEPTION 'claim kind ''%'' declares papers_outrank but the weakest paper scores % and the strongest general source % - the gate stops',
                r.key, round(v_paper::numeric, 3), round(v_general::numeric, 3) USING ERRCODE = 'OBC04';
        END IF;
    END LOOP;
END;
$$;

-- A source's family score and how it was obtained. The research service stamps
-- metadata.credibility at admission (family, signals, score, model_version); a source without
-- that record (every source stored before P3a) is DERIVED here from what the row holds - the
-- general family's domain class and nothing else - and says so in `basis`.
CREATE OR REPLACE FUNCTION public.source_credibility(p_source_id UUID)
RETURNS TABLE (family TEXT, score DOUBLE PRECISION, is_primary BOOLEAN, basis TEXT)
LANGUAGE plpgsql STABLE
AS $$
DECLARE s RECORD; v_class TEXT; v_score DOUBLE PRECISION; v_def JSONB;
BEGIN
    SELECT id, url, domain, metadata INTO s FROM public.sources WHERE id = p_source_id;
    IF s.id IS NULL THEN RETURN; END IF;
    IF s.metadata ? 'credibility' AND (s.metadata -> 'credibility') ? 'score' THEN
        -- attempt 2: a stamped score is a credibility number and the stamp names its family, or
        -- the gate stops (a "NaN" stamp read 1.0 and a -3 read -3 in attempt 1)
        v_score := public.credibility_unit(s.metadata -> 'credibility', 'score', 'source ' || p_source_id || ' stamped credibility');
        IF jsonb_typeof(s.metadata #> '{credibility,family}') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'credibility: source % carries a stamped score without a family - the gate stops', p_source_id
                USING ERRCODE = 'OBC04';
        END IF;
        RETURN QUERY SELECT s.metadata #>> '{credibility,family}',
                            v_score,
                            (s.metadata #> '{credibility,signals,primary}') = 'true'::jsonb,
                            'admission record ' || COALESCE(s.metadata #>> '{credibility,model_version}', '?');
        RETURN;
    END IF;
    IF s.metadata #>> '{scholarly,state}' = 'resolved' THEN
        -- Resolved but never scored (not written by any path today): the weakest paper score,
        -- stated, rather than a guess at the citation curve in a second implementation.
        SELECT definition INTO v_def FROM public.contract_registry_entries
         WHERE registry = 'paper_score_versions' AND retired_at IS NULL AND definition -> 'active' = 'true'::jsonb ORDER BY key LIMIT 1;
        v_score := public.credibility_unit(v_def, 'base', 'the active paper score');
        RETURN QUERY SELECT 'scholarly'::text, v_score, FALSE, 'derived: resolved but unscored - the paper base'::text;
        RETURN;
    END IF;
    v_class := public.credibility_domain_class(s.url, s.domain);
    SELECT definition INTO v_def FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND key = v_class;
    v_score := public.credibility_unit(v_def, 'score', 'domain class ' || COALESCE(v_class, '?'));
    RETURN QUERY SELECT 'general'::text, v_score, (s.metadata ->> 'authority') = 'primary',
                        ('derived: domain class ' || v_class || ' only (no admission record)')::text;
END;
$$;

-- The per-reference rolling total for one claim kind: family score (+ primary bonus) x the
-- weight row, plus every corroboration this source RECEIVED (strong from papers it links,
-- weak from posts that link it), capped at 1. Suppressed givers lend nothing (D5 stage 1).
-- p_scope is a metadata filter (NULL = unconstrained): under it only givers whose metadata
-- contains it lend, so a scoped caller's total says nothing about out-of-scope sources
-- (the cloud door's forced filter, rw-p0-contract2 attempt 2 N2, applied to D15).
-- p_exclude (attempt 2, the FOLD RULE): givers whose corroboration does not count in this total
-- - claim_confidence_d15 passes the claim's own grounding sources, so a co-grounding source
-- counts ONCE in a claim (through the claim's claim_per term), never again as corroboration
-- received by its co-grounder. The two- and three-argument forms are the unexcluded ones; there
-- is one implementation. Every number it reads is validated (credibility_unit, OBC04) and the
-- result is in [0, 1] by construction: base = weight x min(1, score + bonus), each in [0, 1];
-- each received amount in [0, 1] (CHECKed, and re-checked here); capped at 1.
-- Attempt 3: DOUBLE PRECISION throughout and the received amounts summed in DESCENDING order
-- (sum(... ORDER BY amount DESC), credibility.ts foldReceived's order), so this and the TS twin
-- give the same double for the same rows. `_core` is the one implementation; the public forms
-- run credibility_model_check() first (claim_confidence_d15 runs it once per claim instead).
CREATE OR REPLACE FUNCTION public.source_rolling_total_core(p_source_id UUID, p_kind TEXT, p_scope JSONB, p_exclude UUID[])
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
DECLARE c RECORD; w JSONB; v_base DOUBLE PRECISION; v_in DOUBLE PRECISION; v_bad BOOLEAN; v_bonus DOUBLE PRECISION := 0;
BEGIN
    SELECT * INTO c FROM public.source_credibility(p_source_id);
    IF c.family IS NULL THEN RETURN 0; END IF;
    w := public.credibility_weight(p_kind, c.family);
    IF c.is_primary AND w ? 'primary_bonus' THEN
        v_bonus := public.credibility_unit(w, 'primary_bonus', 'weight row ' || p_kind || '.' || c.family);
    END IF;
    v_base := public.credibility_unit(w, 'weight', 'weight row ' || p_kind || '.' || c.family) * LEAST(1::float8, c.score + v_bonus);
    SELECT COALESCE(sum(sc.amount ORDER BY sc.amount DESC), 0::float8), COALESCE(bool_or(NOT public.credibility_is_unit_value(sc.amount)), FALSE) INTO v_in, v_bad
      FROM public.source_corroborations sc
      JOIN public.sources g ON g.id = sc.from_source_id AND g.retraction_committed_at IS NULL
           AND (p_scope IS NULL OR g.metadata @> p_scope)
     WHERE sc.to_source_id = p_source_id
       AND sc.from_source_id <> p_source_id
       AND (p_exclude IS NULL OR NOT (sc.from_source_id = ANY (p_exclude)));
    IF v_bad THEN
        RAISE EXCEPTION 'credibility: a corroboration into source % has an amount that is not 0 or in [1e-9, 1] - the gate stops', p_source_id
            USING ERRCODE = 'OBC04';
    END IF;
    RETURN LEAST(1::float8, v_base + v_in);
END;
$$;

CREATE OR REPLACE FUNCTION public.source_rolling_total(p_source_id UUID, p_kind TEXT, p_scope JSONB, p_exclude UUID[])
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    PERFORM public.credibility_model_check();
    RETURN public.source_rolling_total_core(p_source_id, p_kind, p_scope, p_exclude);
END;
$$;

CREATE OR REPLACE FUNCTION public.source_rolling_total(p_source_id UUID, p_kind TEXT, p_scope JSONB)
RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE
AS $$ SELECT public.source_rolling_total(p_source_id, p_kind, p_scope, NULL::uuid[]) $$;

CREATE OR REPLACE FUNCTION public.source_rolling_total(p_source_id UUID, p_kind TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql STABLE
AS $$ SELECT public.source_rolling_total(p_source_id, p_kind, NULL::jsonb, NULL::uuid[]) $$;

CREATE OR REPLACE FUNCTION public.claim_kind_of(p_claim_id UUID)
RETURNS TABLE (kind TEXT, basis TEXT)
LANGUAGE sql STABLE
AS $$
    -- attempt 2: the fallback is for claims filed BEFORE the cutover (nothing recorded a kind
    -- then); a kindless claim filed at or after it gets kind NULL, and claim_confidence_d15 stops
    -- the gate naming it (D15 item 9: fail loud on an unknown kind)
    -- attempt 3: filed_at (server-set, NULL for a claim that predates the column), never created_at
    SELECT CASE WHEN c.metadata ? 'claim_kind' THEN c.metadata ->> 'claim_kind'
                WHEN c.filed_at IS NULL OR c.filed_at < cut.at THEN public.credibility_fallback_kind()
                ELSE NULL END,
           CASE WHEN c.metadata ? 'claim_kind' THEN 'recorded at filing'
                WHEN c.filed_at IS NULL OR c.filed_at < cut.at THEN 'not recorded (filed before P3a): the registry''s declared fallback kind'
                ELSE 'MISSING: filed after the P3a cutover (' || cut.at || ') without a claim kind' END
      FROM public.claims c
      CROSS JOIN (SELECT COALESCE((SELECT kind_required_from FROM public.credibility_trigger_state WHERE singleton),
                                  '-infinity'::timestamptz) AS at) cut
     WHERE c.id = p_claim_id;
$$;

-- The D15 claim total (the stored twin of credibility.ts filedLineCredibility / lineCredibility). Per
-- non-suppressed, non-contradicting source edge: the source's rolling total x the edge's weight x the
-- edge type's factor - attempt 4: the registry row credibility_terms.edge_factors (inferred_from 0.67
-- = the 0.60/0.90 ratio init-claims.sql uses), which credibility.ts reads too; a weight that is not 0
-- or in [1e-9, 1] stops the gate (OBC04; the CHECK refuses it at write). The best source leads; each
-- further distinct source adds claim_per x its total up to claim_cap. Then the legacy rules that
-- are not about source credibility: ungrounded 0, depth 0.85^d, stale x0.5, contradicted <=0.30.
-- THE FOLD RULE (attempt 2, tester adversarial (3) "mutual corroboration counts B twice"): each
-- source's rolling total here EXCLUDES corroboration received from the claim's other grounding
-- sources. A co-grounding source already counts in this claim once, through claim_per x its own
-- total; its corroboration of the lead would count it a second time (A<->B on a claim both state
-- read 0.83 against 0.63 one way). Corroboration from a source that does NOT ground the claim
-- still counts in full. credibility.ts foldReceived applies the same rule to the run's lines.
-- Attempt 3: DOUBLE PRECISION throughout, unrounded, in credibility.ts lineCredibility's order
-- (source totals descending; the extra summed from 0 in that order; capped; added to the lead);
-- the whole-model check runs first, once.
CREATE OR REPLACE FUNCTION public.claim_confidence_d15(p_claim_id UUID)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_kind TEXT; v_basis TEXT; v_depth INT; v_terms JSONB; v_lead DOUBLE PRECISION := 0; v_extra DOUBLE PRECISION := 0;
    v_stale BOOLEAN; v_contra BOOLEAN; v_score DOUBLE PRECISION; r RECORD; i INT := 0; v_grounders UUID[];
    v_per DOUBLE PRECISION; v_cap DOUBLE PRECISION; v_factors JSONB; v_badw BOOLEAN;
BEGIN
    PERFORM public.credibility_model_check();
    SELECT k.kind, k.basis INTO v_kind, v_basis FROM public.claim_kind_of(p_claim_id) k;
    IF v_kind IS NULL THEN
        RAISE EXCEPTION 'claim % has no claim kind (%) - the gate stops (D15 item 9: no default kind for a claim filed after P3a)',
            p_claim_id, COALESCE(v_basis, 'and the claim_kinds registry declares no fallback')
            USING ERRCODE = 'OBC01';
    END IF;
    PERFORM public.credibility_weight(v_kind, f.key)
       FROM public.contract_registry_entries f WHERE f.registry = 'source_families' AND f.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM public.contract_registry_entries w WHERE w.registry = 'credibility_weights'
                           AND w.retired_at IS NULL AND w.definition ->> 'family' = f.key);
    v_depth := public.claim_min_depth(p_claim_id);
    IF v_depth IS NULL THEN RETURN 0::float8; END IF;
    SELECT definition INTO v_terms FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'corroboration';
    v_per := public.credibility_unit(v_terms, 'claim_per', 'corroboration terms');
    v_cap := public.credibility_unit(v_terms, 'claim_cap', 'corroboration terms');
    SELECT definition INTO v_factors FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'edge_factors' AND retired_at IS NULL;
    SELECT bool_or(NOT public.credibility_is_unit_value(cs.weight::float8)) INTO v_badw
      FROM public.claim_edge_counts(p_claim_id) e JOIN public.claim_sources cs ON cs.id = e.edge_id
     WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts';
    IF COALESCE(v_badw, FALSE) THEN
        RAISE EXCEPTION 'credibility: claim % has an edge weight that is not 0 or in [1e-9, 1] - the gate stops', p_claim_id
            USING ERRCODE = 'OBC04';
    END IF;
    SELECT array_agg(DISTINCT e.source_id) INTO v_grounders
      FROM public.claim_edge_counts(p_claim_id) e
     WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts';
    FOR r IN
        SELECT e.source_id, max(public.source_rolling_total_core(e.source_id, v_kind, NULL::jsonb, v_grounders)
                   * cs.weight::float8
                   * public.credibility_unit(v_factors, e.edge_type, 'credibility_terms.edge_factors')) AS t
          FROM public.claim_edge_counts(p_claim_id) e
          JOIN public.claim_sources cs ON cs.id = e.edge_id
         WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts'
         GROUP BY e.source_id
         ORDER BY 2 DESC
    LOOP
        IF i = 0 THEN v_lead := r.t; ELSE v_extra := v_extra + v_per * r.t; END IF;
        i := i + 1;
    END LOOP;
    v_score := (v_lead + LEAST(v_extra, v_cap)) * power(0.85::float8, v_depth::float8);
    SELECT (researched_on + COALESCE(revalidate_days,
              CASE volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180 WHEN 'slow' THEN 1095 ELSE 180 END) < CURRENT_DATE)
      INTO v_stale FROM public.claims WHERE id = p_claim_id;
    IF COALESCE(v_stale, FALSE) THEN v_score := v_score * 0.5::float8; END IF;
    SELECT bool_or(e.edge_type = 'contradicts') INTO v_contra FROM public.claim_edge_counts(p_claim_id) e;
    IF COALESCE(v_contra, FALSE) THEN v_score := LEAST(v_score, 0.30::float8); END IF;
    RETURN GREATEST(LEAST(v_score, 1::float8), 0::float8);
END;
$$;

-- ── 4. the gate: before/after, confirmation, apply ──────────────────────
CREATE OR REPLACE VIEW public.credibility_before_after AS
    WITH c AS (
        SELECT cl.id, cl.text, cl.confidence AS before_confidence, k.kind, k.basis AS kind_basis
          FROM public.claims cl, LATERAL public.claim_kind_of(cl.id) k
         WHERE cl.status = 'active'
    ), s AS (
        SELECT e.claim_id,
               count(DISTINCT e.source_id) AS sources,
               count(DISTINCT e.source_id) FILTER (WHERE sc.family = 'scholarly') AS paper_sources
          FROM public.claim_sources e
          JOIN public.sources src ON src.id = e.source_id AND src.retraction_committed_at IS NULL
          LEFT JOIN LATERAL public.source_credibility(e.source_id) sc ON TRUE
         WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts'
         GROUP BY e.claim_id
    )
    SELECT c.id AS claim_id, c.text, c.kind, c.kind_basis,
           c.before_confidence::real AS before_confidence,
           d.after_confidence,
           COALESCE(s.sources, 0)::int AS sources,
           COALESCE(s.paper_sources, 0)::int AS paper_sources,
           (COALESCE(s.sources, 0) = 1 AND COALESCE(s.paper_sources, 0) = 0) AS single_source_non_paper,
           (c.before_confidence < f.claim_floor) AS below_floor_before,
           (d.after_confidence < f.claim_floor) AS below_floor_after,
           public.credibility_model_version() AS model_version,
           'claim_confidence (P0, init-research-contract.sql)'::text AS before_model
      FROM c
      LEFT JOIN s ON s.claim_id = c.id
      CROSS JOIN LATERAL (SELECT public.claim_confidence_d15(c.id) AS after_confidence) d
      -- a kindless claim's row raises in claim_confidence_d15 (naming the claim), not here
      CROSS JOIN LATERAL (SELECT CASE WHEN c.kind IS NULL THEN NULL
                                      ELSE public.credibility_claim_floor(c.kind) END AS claim_floor) f;

-- The digest the operator confirms: the model version plus every claim's row of the view. Any
-- change to the table, the paper score, a source's record or the claim set changes it, so a
-- confirmation can only ever apply to the view that was read.
-- Attempt 4 (tester near-miss: each after-score was rounded to 4 decimals, so a stamp change moving
-- a claim from 0.50003 to 0.49997 flipped below_floor_after and left the digest unchanged): each
-- row binds its kind, the exact bits of the after-score (float8send), its floor verdict and the
-- source counts - independent of extra_float_digits. NULLs are spelled, so no row drops out of
-- string_agg. The BEFORE side is not bound: applying the view re-scores every claim, which changes
-- before_confidence, and the digest must still name the applied view (the gate's idempotency).
CREATE OR REPLACE FUNCTION public.credibility_before_after_digest()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT md5(public.credibility_model_version() || '|' ||
               COALESCE(string_agg(concat_ws(':', b.claim_id::text, COALESCE(b.kind, '~'),
                            COALESCE(encode(float8send(b.after_confidence), 'hex'), '~'),
                            COALESCE(b.below_floor_after::text, '~'),
                            b.sources::text, b.paper_sources::text), ',' ORDER BY b.claim_id), ''))
      FROM public.credibility_before_after b;
$$;

CREATE OR REPLACE FUNCTION public.credibility_record_confirmation(
    p_digest TEXT, p_confirmed_by TEXT, p_findings_ref TEXT, p_line TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE v_now TEXT := public.credibility_before_after_digest(); v_id UUID;
BEGIN
    IF p_digest IS DISTINCT FROM v_now THEN
        RAISE EXCEPTION 'confirmation refused: digest % is not the current before/after view (%)', p_digest, v_now
            USING ERRCODE = 'OBC03';
    END IF;
    IF COALESCE(btrim(p_confirmed_by), '') = '' OR COALESCE(btrim(p_findings_ref), '') = '' OR COALESCE(btrim(p_line), '') = '' THEN
        RAISE EXCEPTION 'confirmation refused: who confirmed, the findings file and the line are all required'
            USING ERRCODE = 'OBC03';
    END IF;
    -- attempt 3: one confirmation per view digest - a second call returns the first row, it never
    -- mints another (tester (7): a second --apply recorded confirmations=2 from the same line)
    SELECT id INTO v_id FROM public.credibility_rescore_confirmations WHERE view_digest = p_digest;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    INSERT INTO public.credibility_rescore_confirmations (view_digest, model_version, confirmed_by, findings_ref, confirmation_line)
    VALUES (p_digest, public.credibility_model_version(), p_confirmed_by, p_findings_ref, p_line)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.credibility_trigger_model()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((SELECT model FROM public.credibility_trigger_state WHERE singleton), 'legacy');
$$;

-- The ONLY way the trigger changes model. Refused unless a confirmation for exactly the current
-- view digest is recorded; then the setting flips and every active claim is re-scored.
CREATE OR REPLACE FUNCTION public.credibility_apply_d15_trigger(p_digest TEXT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE v_conf UUID; r RECORD; n INT := 0;
BEGIN
    IF p_digest IS DISTINCT FROM public.credibility_before_after_digest() THEN
        RAISE EXCEPTION 're-score refused: digest % is not the current before/after view', p_digest
            USING ERRCODE = 'OBC03';
    END IF;
    -- attempt 3: already applied for exactly this view -> nothing to do, nothing recorded
    IF EXISTS (SELECT 1 FROM public.credibility_trigger_state t
                 JOIN public.credibility_rescore_confirmations c ON c.id = t.confirmation_id
                WHERE t.singleton AND t.model = 'd15' AND c.view_digest = p_digest AND c.applied_at IS NOT NULL) THEN
        RETURN 0;
    END IF;
    -- the view's one confirmation (attempt 3: one per digest, unique), applied or not
    SELECT id INTO v_conf FROM public.credibility_rescore_confirmations WHERE view_digest = p_digest;
    IF v_conf IS NULL THEN
        RAISE EXCEPTION 're-score refused: no operator confirmation is recorded for view digest % (D15 item 6)', p_digest
            USING ERRCODE = 'OBC03';
    END IF;
    INSERT INTO public.credibility_trigger_state (singleton, model, confirmation_id, changed_at)
    VALUES (TRUE, 'd15', v_conf, now())
    ON CONFLICT (singleton) DO UPDATE SET model = 'd15', confirmation_id = v_conf, changed_at = now();
    FOR r IN SELECT id FROM public.claims WHERE status = 'active' LOOP
        PERFORM public.recompute_claim_confidence(r.id);
        n := n + 1;
    END LOOP;
    UPDATE public.credibility_rescore_confirmations SET applied_at = now(), applied_claims = n WHERE id = v_conf;
    RETURN n;
END;
$$;

-- The stored confidence keeps the D15 verdict (attempt 3). claims.confidence is init-claims.sql's
-- REAL (float4) column, which the reuse gate (reusable_claims, >= 0.50) reads; a DOUBLE total
-- within half a float4 step of a floor would round onto the other side of it (0.49999999 stores
-- as 0.5). This returns the float4 nearest the total that is on the SAME side of the kind's claim
-- floor - the nearest float4 unless that one crosses the floor, then one step back.
-- Attempt 4 (tester finding F1: `p_total::real` raised 22003 underflow for a total below ~7e-46,
-- aborting recompute_claim_confidence, the operator's whole credibility_apply_d15_trigger and, after
-- the flip, the app's link_claim_to_source): a total below the smallest NORMAL float4 (2^-126) is
-- stored as 0. 0 is always on the total's side of the floor: a floor is 0 or >= 1e-9, so such a
-- total is below any non-zero floor (as 0 is) and at or above a 0 floor (as 0 is).
-- credibility.ts storeConfidence is the TS twin, op for op.
CREATE OR REPLACE FUNCTION public.credibility_store_confidence(p_total DOUBLE PRECISION, p_floor DOUBLE PRECISION)
RETURNS REAL
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE v REAL; i INT := 0;
BEGIN
    IF p_total IS NULL THEN RETURN NULL; END IF;
    IF p_total < power(2::float8, -126) THEN RETURN 0::real; END IF;
    v := p_total::real;
    IF p_floor IS NULL THEN RETURN v; END IF;
    WHILE i < 4 AND ((p_total < p_floor AND v::float8 >= p_floor) OR (p_total >= p_floor AND v::float8 < p_floor)) LOOP
        v := CASE WHEN p_total < p_floor THEN (v::float8 - abs(v::float8) * power(2::float8, -23))::real
                  ELSE (v::float8 + abs(v::float8) * power(2::float8, -23))::real END;
        i := i + 1;
    END LOOP;
    IF (p_total < p_floor) <> (v::float8 < p_floor) THEN
        RAISE EXCEPTION 'credibility: no float4 on the floor side of % (floor %)', p_total, p_floor USING ERRCODE = 'OBC04';
    END IF;
    RETURN v;
END;
$$;

-- The trigger's writer, redefined (supersedes 230-init-research-contract.sql's body, which it
-- keeps verbatim for the legacy model). It changes model only through the function above.
CREATE OR REPLACE FUNCTION public.recompute_claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql
AS $$
DECLARE v_conf REAL; v_contra BOOLEAN; v_kind TEXT; v_total DOUBLE PRECISION;
BEGIN
    IF public.credibility_trigger_model() = 'd15' THEN
        v_total := public.claim_confidence_d15(p_claim_id);   -- raises first for a kindless claim
        SELECT k.kind INTO v_kind FROM public.claim_kind_of(p_claim_id) k;
        v_conf := public.credibility_store_confidence(v_total, public.credibility_claim_floor(v_kind));
    ELSE
        v_conf := public.claim_confidence(p_claim_id);
    END IF;
    SELECT bool_or(e.edge_type = 'contradicts') INTO v_contra
    FROM public.claim_edge_counts(p_claim_id) e;
    UPDATE public.claims
       SET confidence = v_conf,
           contradicted = COALESCE(v_contra, FALSE)
     WHERE id = p_claim_id;
    RETURN v_conf;
END;
$$;

-- ── 5. the fold (ingestion model item 2) ────────────────────────────────
-- Move a held source into `sources` keeping its uuid (a document's pin survives), with its
-- chunks, and mark it active in its refinery's user source list. The caller has already decided
-- (floor cleared AND entailment supports a specific claim); this only performs the move. The
-- tombstone gate on `sources` still fires: a tombstoned URL raises OBT01 here, and the caller
-- routes the D5 reopening path instead (a held source never bypasses it).
CREATE OR REPLACE FUNCTION public.fold_held_source(p_held_id UUID, p_credibility JSONB, p_job UUID)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE h public.held_sources;
BEGIN
    SELECT * INTO h FROM public.held_sources WHERE id = p_held_id FOR UPDATE;
    IF h.id IS NULL THEN
        RAISE EXCEPTION 'held source % does not exist (already folded or removed)', p_held_id USING ERRCODE = 'OBF01';
    END IF;
    INSERT INTO public.sources (id, url, title, content, content_type, domain, fetched_at, embedding, metadata, content_hash)
    VALUES (h.id, h.url, h.title, h.content,
            CASE WHEN h.content_type IN ('web_article','pdf','youtube_transcript','podcast_transcript','paper','manual')
                 THEN h.content_type ELSE 'manual' END,
            NULLIF(regexp_replace(lower(COALESCE(substring(COALESCE(h.url, '') from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#:]+)'), '')), '^www\.', ''), ''),
            now(), h.embedding,
            h.metadata || jsonb_build_object('credibility', p_credibility, 'folded_from', 'held',
                                             'refinery_id', h.refinery_id, 'folded_job', p_job),
            h.content_hash);
    INSERT INTO public.source_chunks (source_id, idx, content, embedding)
    SELECT h.id, c.idx, c.content, c.embedding FROM public.held_source_chunks c WHERE c.held_source_id = h.id;
    UPDATE public.refinery_user_sources SET status = 'active' WHERE source_id = h.id;
    DELETE FROM public.held_sources WHERE id = h.id;   -- chunks cascade; the row now lives in sources
    INSERT INTO public.source_trail_events (source_id, kind, detail)
    VALUES (h.id, 'folded', jsonb_build_object('refinery_id', h.refinery_id, 'job_id', p_job, 'credibility', p_credibility));
    RETURN h.id;
END;
$$;

-- ── RLS + grants (mirror init-research-contract.sql) ───────────────────
-- The gate's two tables are READ-ONLY to the app roles: a confirmation row or a trigger-model
-- change written by the research service, the workbench or any service_role caller would be a
-- way around the findings-sink check. Only the owner (the operator, via rescore-gate.ts) writes.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['credibility_rescore_confirmations', 'credibility_trigger_state'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_read', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO service_role USING (true)', t || '_service_role_read', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
        EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY[
        'research_admission_trail', 'source_credibility_history', 'source_corroborations'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        -- attempt 3: the rows, not TRUNCATE (not RLS-filterable; empties a record table at once)
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    END LOOP;
    -- attempt 3 (tester (2b): an app role's TRUNCATE of the registries was stopped only by P0's
    -- foreign keys; has_table_privilege(..., 'TRUNCATE') was true): TRUNCATE, REFERENCES and
    -- TRIGGER are revoked from the app roles on the registries and every credibility table. The
    -- statement triggers (trg_credibility_owner_only) refuse a non-owner TRUNCATE as well, should
    -- a later GRANT ALL hand the privilege back.
    FOREACH t IN ARRAY ARRAY[
        'contract_registries', 'contract_registry_entries', 'research_admission_trail', 'source_credibility_history',
        'source_corroborations', 'credibility_rescore_confirmations', 'credibility_trigger_state'
    ] LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM PUBLIC, service_role', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY[
        'research_admission_trail', 'source_credibility_history', 'source_corroborations',
        'credibility_rescore_confirmations', 'credibility_trigger_state'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || t || '_truncate', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.trg_credibility_owner_only()',
                       'trg_' || t || '_truncate', t);
    END LOOP;
END $$;
GRANT SELECT ON public.credibility_before_after TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
