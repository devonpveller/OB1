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
--
-- Conventions mirror init-research-contract.sql: idempotent, additive, RLS on with a
-- service_role FOR ALL policy, no DROP TABLE / TRUNCATE / unqualified DELETE. Mounted in
-- compose as 240-init-research-credibility.sql. Fresh-volume only; the live DB gets it by hand
-- (psql -f, the operator's gated deploy). Applying it changes no claim's confidence.
-- Revert: revert-research-credibility.sql.
-- ============================================================

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
        '{"term_version":1,"strong_factor":0.5,"weak_factor":0.1,"claim_per":0.5,"claim_cap":0.35}')
ON CONFLICT (registry, key) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('trail_event_kinds', 'folded',     'folded from held', '{}'),
    ('trail_event_kinds', 'found_via',  'reached through a lead', '{}')
ON CONFLICT (registry, key) DO NOTHING;

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
    score         REAL,
    total         REAL,
    floor         REAL,
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
    score         REAL NOT NULL,
    total         REAL,
    model_version TEXT NOT NULL,
    signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
    reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
    job_id        UUID,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_credibility_history_src ON public.source_credibility_history (source_id, computed_at DESC);

-- Entailment-gated transfers (D15 item 3). A row exists only for a `supports` verdict; the
-- paper -> source row is the strong one, the source -> paper row the weak one.
CREATE TABLE IF NOT EXISTS public.source_corroborations (
    id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    from_source_id UUID NOT NULL,
    to_source_id   UUID NOT NULL,
    strength       TEXT NOT NULL CHECK (strength IN ('strong', 'weak')),
    amount         REAL NOT NULL,
    claim_text     TEXT NOT NULL,
    claim_kind     TEXT NOT NULL,
    verdict        TEXT NOT NULL,
    model_version  TEXT NOT NULL,
    job_id         UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_source_id, to_source_id, claim_text, model_version)
);
CREATE INDEX IF NOT EXISTS idx_source_corroborations_to   ON public.source_corroborations (to_source_id);
CREATE INDEX IF NOT EXISTS idx_source_corroborations_from ON public.source_corroborations (from_source_id);

CREATE OR REPLACE FUNCTION public.trg_source_corroborations_supports_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT COALESCE((SELECT (e.definition ->> 'transfers')::boolean
                       FROM public.contract_registry_entries e
                      WHERE e.registry = 'entailment_verdicts' AND e.key = NEW.verdict), FALSE) THEN
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

-- ── 3. the model's claim total ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credibility_model_version()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT 'd15 weights v' || COALESCE((SELECT version FROM public.contract_registries WHERE name = 'credibility_weights'), 0)
        || ' paper ' || COALESCE((SELECT key FROM public.contract_registry_entries
                                   WHERE registry = 'paper_score_versions' AND retired_at IS NULL
                                     AND (definition ->> 'active')::boolean IS TRUE LIMIT 1), '?');
$$;

CREATE OR REPLACE FUNCTION public.credibility_weight(p_kind TEXT, p_family TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE d JSONB;
BEGIN
    SELECT e.definition INTO d FROM public.contract_registry_entries e
     WHERE e.registry = 'credibility_weights' AND e.retired_at IS NULL
       AND e.definition ->> 'kind' = p_kind AND e.definition ->> 'family' = p_family;
    IF d IS NULL THEN
        RAISE EXCEPTION 'the weight table (%) has no row for claim kind ''%'' and family ''%'' - the gate stops (D15 item 9)',
            public.credibility_model_version(), p_kind, p_family
            USING ERRCODE = 'OBC01';
    END IF;
    RETURN d;
END;
$$;

CREATE OR REPLACE FUNCTION public.credibility_fallback_kind()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT key FROM public.contract_registry_entries
     WHERE registry = 'claim_kinds' AND retired_at IS NULL AND (definition ->> 'fallback')::boolean IS TRUE
     LIMIT 1;
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
            AND NOT COALESCE((e.definition ->> 'fallback')::boolean, FALSE)
            AND h.host IS NOT NULL
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.definition -> 'host_patterns') p WHERE h.host ~* p)
          ORDER BY (e.definition ->> 'order')::int LIMIT 1),
        (SELECT key FROM public.contract_registry_entries
          WHERE registry = 'domain_classes' AND retired_at IS NULL AND (definition ->> 'fallback')::boolean IS TRUE LIMIT 1));
$$;

-- A source's family score and how it was obtained. The research service stamps
-- metadata.credibility at admission (family, signals, score, model_version); a source without
-- that record (every source stored before P3a) is DERIVED here from what the row holds - the
-- general family's domain class and nothing else - and says so in `basis`.
CREATE OR REPLACE FUNCTION public.source_credibility(p_source_id UUID)
RETURNS TABLE (family TEXT, score REAL, is_primary BOOLEAN, basis TEXT)
LANGUAGE plpgsql STABLE
AS $$
DECLARE s RECORD; v_class TEXT; v_score REAL;
BEGIN
    SELECT id, url, domain, metadata INTO s FROM public.sources WHERE id = p_source_id;
    IF s.id IS NULL THEN RETURN; END IF;
    IF s.metadata ? 'credibility' AND (s.metadata -> 'credibility') ? 'score' THEN
        RETURN QUERY SELECT s.metadata #>> '{credibility,family}',
                            (s.metadata #>> '{credibility,score}')::real,
                            COALESCE((s.metadata #>> '{credibility,signals,primary}')::boolean, FALSE),
                            'admission record ' || COALESCE(s.metadata #>> '{credibility,model_version}', '?');
        RETURN;
    END IF;
    IF s.metadata #>> '{scholarly,state}' = 'resolved' THEN
        -- Resolved but never scored (not written by any path today): the weakest paper score,
        -- stated, rather than a guess at the citation curve in a second implementation.
        SELECT (definition ->> 'base')::real INTO v_score FROM public.contract_registry_entries
         WHERE registry = 'paper_score_versions' AND (definition ->> 'active')::boolean IS TRUE LIMIT 1;
        RETURN QUERY SELECT 'scholarly'::text, v_score, FALSE, 'derived: resolved but unscored - the paper base'::text;
        RETURN;
    END IF;
    v_class := public.credibility_domain_class(s.url, s.domain);
    SELECT (definition ->> 'score')::real INTO v_score FROM public.contract_registry_entries
     WHERE registry = 'domain_classes' AND key = v_class;
    RETURN QUERY SELECT 'general'::text, v_score, (s.metadata ->> 'authority') = 'primary',
                        ('derived: domain class ' || v_class || ' only (no admission record)')::text;
END;
$$;

-- The per-reference rolling total for one claim kind: family score (+ primary bonus) x the
-- weight row, plus every corroboration this source RECEIVED (strong from papers it links,
-- weak from posts that link it), capped at 1. Suppressed givers lend nothing (D5 stage 1).
-- p_scope is a metadata filter (NULL = unconstrained): under it only givers whose metadata
-- contains it lend, so a scoped caller's total says nothing about out-of-scope sources
-- (the cloud door's forced filter, rw-p0-contract2 attempt 2 N2, applied to D15). The two-argument
-- form is the unscoped one; there is one implementation.
CREATE OR REPLACE FUNCTION public.source_rolling_total(p_source_id UUID, p_kind TEXT, p_scope JSONB)
RETURNS REAL
LANGUAGE plpgsql STABLE
AS $$
DECLARE c RECORD; w JSONB; v_base REAL; v_in REAL;
BEGIN
    SELECT * INTO c FROM public.source_credibility(p_source_id);
    IF c.family IS NULL THEN RETURN 0; END IF;
    w := public.credibility_weight(p_kind, c.family);
    v_base := (w ->> 'weight')::real * LEAST(1.0, c.score + CASE WHEN c.is_primary THEN COALESCE((w ->> 'primary_bonus')::real, 0) ELSE 0 END);
    SELECT COALESCE(sum(sc.amount), 0) INTO v_in
      FROM public.source_corroborations sc
      JOIN public.sources g ON g.id = sc.from_source_id AND g.retraction_committed_at IS NULL
           AND (p_scope IS NULL OR g.metadata @> p_scope)
     WHERE sc.to_source_id = p_source_id;
    RETURN LEAST(1.0, v_base + v_in);
END;
$$;

CREATE OR REPLACE FUNCTION public.source_rolling_total(p_source_id UUID, p_kind TEXT)
RETURNS REAL
LANGUAGE sql STABLE
AS $$ SELECT public.source_rolling_total(p_source_id, p_kind, NULL::jsonb) $$;

CREATE OR REPLACE FUNCTION public.claim_kind_of(p_claim_id UUID)
RETURNS TABLE (kind TEXT, basis TEXT)
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(c.metadata ->> 'claim_kind', public.credibility_fallback_kind()),
           CASE WHEN c.metadata ? 'claim_kind' THEN 'recorded at filing'
                ELSE 'not recorded (filed before P3a): the registry''s declared fallback kind' END
      FROM public.claims c WHERE c.id = p_claim_id;
$$;

-- The D15 claim total (the stored twin of credibility.ts lineCredibility). Per non-suppressed,
-- non-contradicting source edge: the source's rolling total x the edge's weight x the tag factor
-- (inferred_from 0.67 = the 0.60/0.90 ratio init-claims.sql uses). The best source leads; each
-- further distinct source adds claim_per x its total up to claim_cap. Then the legacy rules that
-- are not about source credibility: ungrounded 0, depth 0.85^d, stale x0.5, contradicted <=0.30.
CREATE OR REPLACE FUNCTION public.claim_confidence_d15(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_kind TEXT; v_depth INT; v_terms JSONB; v_lead REAL := 0; v_extra REAL := 0;
    v_stale BOOLEAN; v_contra BOOLEAN; v_score REAL; r RECORD; i INT := 0;
BEGIN
    SELECT k.kind INTO v_kind FROM public.claim_kind_of(p_claim_id) k;
    IF v_kind IS NULL THEN
        RAISE EXCEPTION 'claim % has no kind and the claim_kinds registry declares no fallback - the gate stops', p_claim_id
            USING ERRCODE = 'OBC01';
    END IF;
    PERFORM public.credibility_weight(v_kind, f.key)
       FROM public.contract_registry_entries f WHERE f.registry = 'source_families' AND f.retired_at IS NULL;
    v_depth := public.claim_min_depth(p_claim_id);
    IF v_depth IS NULL THEN RETURN 0.0; END IF;
    SELECT definition INTO v_terms FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'corroboration';
    FOR r IN
        SELECT e.source_id, max(public.source_rolling_total(e.source_id, v_kind)
                   * COALESCE(cs.weight, 1.0)
                   * CASE e.edge_type WHEN 'inferred_from' THEN 0.67 ELSE 1.0 END) AS t
          FROM public.claim_edge_counts(p_claim_id) e
          JOIN public.claim_sources cs ON cs.id = e.edge_id
         WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts'
         GROUP BY e.source_id
         ORDER BY 2 DESC
    LOOP
        IF i = 0 THEN v_lead := r.t; ELSE v_extra := v_extra + (v_terms ->> 'claim_per')::real * r.t; END IF;
        i := i + 1;
    END LOOP;
    v_score := (v_lead + LEAST(v_extra, (v_terms ->> 'claim_cap')::real)) * power(0.85, v_depth);
    SELECT (researched_on + COALESCE(revalidate_days,
              CASE volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180 WHEN 'slow' THEN 1095 ELSE 180 END) < CURRENT_DATE)
      INTO v_stale FROM public.claims WHERE id = p_claim_id;
    IF COALESCE(v_stale, FALSE) THEN v_score := v_score * 0.5; END IF;
    SELECT bool_or(e.edge_type = 'contradicts') INTO v_contra FROM public.claim_edge_counts(p_claim_id) e;
    IF COALESCE(v_contra, FALSE) THEN v_score := LEAST(v_score, 0.30); END IF;
    RETURN GREATEST(LEAST(v_score, 1.0), 0.0);
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
      CROSS JOIN LATERAL (SELECT (public.credibility_weight(c.kind, 'general') ->> 'claim_floor')::real AS claim_floor) f;

-- The digest the operator confirms: the model version plus every claim's after-score. Any
-- change to the table, the paper score, a source's record or the claim set changes it, so a
-- confirmation can only ever apply to the view that was read.
CREATE OR REPLACE FUNCTION public.credibility_before_after_digest()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT md5(public.credibility_model_version() || '|' ||
               COALESCE(string_agg(b.claim_id::text || ':' || round(b.after_confidence::numeric, 4)::text, ',' ORDER BY b.claim_id), ''))
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
    SELECT id INTO v_conf FROM public.credibility_rescore_confirmations
     WHERE view_digest = p_digest AND applied_at IS NULL ORDER BY recorded_at DESC LIMIT 1;
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

-- The trigger's writer, redefined (supersedes 230-init-research-contract.sql's body, which it
-- keeps verbatim for the legacy model). It changes model only through the function above.
CREATE OR REPLACE FUNCTION public.recompute_claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql
AS $$
DECLARE v_conf REAL; v_contra BOOLEAN;
BEGIN
    IF public.credibility_trigger_model() = 'd15' THEN
        v_conf := public.claim_confidence_d15(p_claim_id);
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
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;
GRANT SELECT ON public.credibility_before_after TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

NOTIFY pgrst, 'reload schema';
