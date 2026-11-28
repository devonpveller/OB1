-- ============================================================
-- Community sources in research (research-workbench redesign, rwr-research-sources). Slot 750.
-- On slot 400 (settings), 540 (research start), 550 (settings tags) and P3a (init-research-credibility.sql).
--
--   * source_classes: a new registry (contract_registry_entries) of the COMMUNITY classes the operator confirmed
--     2026-11-27 (findings/rwr-research-sources.md): Q&A, forums, social, code discussion, self-published. A
--     source is classified by its normalised URL only (host, and path for mixed hosts), never by its content;
--     archive / translate / AMP wrappers are classified as the URL they wrap. No match = not community (scored by
--     the D15 model exactly as before). source_class_of(url, domain) is the SQL twin of source-class.ts.
--     The registry is changed only by the table owner (the P3a guard, re-created here with source_classes added).
--     EDITING THIS REGISTRY STALLS SOURCE WRITES (fix round 3, FU3): every insert, update or delete of a source_classes row
--     re-classifies every source (about 22 s at live size) while holding SHARE ROW EXCLUSIVE on `sources`, so ALL source
--     writers wait (and any with a short statement_timeout or lock_timeout, as the workbench has on some transactions,
--     fails instead of waiting). Edit it off-hours, or with the research, curator and workbench writers stopped.
--   * credibility_terms.community: community evidence is weighted low and never carries the credible rating
--     alone. A claim with at least one non-community grounding source is scored over its NON-community sources
--     only (so its rating is the same whichever mode the run used); a `contradicts` edge that comes from a
--     community-only claim or a community source does not cap such a claim (the edge stays; fix round 3, R1); a claim grounded only in community sources
--     scores weight x its total, capped `floor_margin` under the floor. Applied to all three formula versions:
--     the live legacy claim_confidence (init-claims.sql), claim_confidence_d15 and credibility.ts. Community
--     sources neither give nor receive corroboration (source_rolling_total_core).
--   * sources.community_key: the class STORED per source (source_class_of stays the one definition; triggers keep
--     it current on every write path; source_community_drift() = 0 proves it). The formulas read the column.
--   * claim_community_consensus(claim): two or more INDEPENDENT community sources (different communities: a
--     different site, or a different subreddit / Stack Exchange site / repository) state or corroborate the claim.
--     A separate marker; it never enters a confidence.
--   * request_boundary_options_ok: a derived job's options may carry `sources` = credible | community (root and
--     branch: a gap branch inherits it). Everything else unchanged.
--   * settings: research.sources_default (user: credible | community) and research.community_allowed (admin,
--     default on).
--   * deploy re-score: every claim with a community grounding source is re-scored (recompute_claim_confidence).
-- Every function this file replaces is saved first (research_sources_saved); revert-research-sources.sql puts
-- them back. Re-run THIS file after any re-run of init-claims.sql, init-research-credibility.sql or slot 540,
-- since those files replace these functions with their own bodies.
-- Fresh-volume slot 750; live: psql -f AFTER 540 / 550 (and 730 when it is live), BEFORE the new research and
-- workbench images, a fresh backup first (a gated deploy). One transaction, the whole file.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.research_sources_saved (
    fn       TEXT PRIMARY KEY,
    def      TEXT NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON public.research_sources_saved FROM PUBLIC;
INSERT INTO public.research_sources_saved (fn, def)
SELECT f, pg_get_functiondef(to_regprocedure(f))
  FROM unnest(ARRAY['public.request_boundary_options_ok(jsonb,boolean)', 'public.claim_confidence(uuid)',
                    'public.claim_confidence_d15(uuid)', 'public.source_rolling_total_core(uuid,text,jsonb,uuid[])',
                    'public.trg_credibility_registry_bump()', 'public.trg_credibility_registry_guard()',
                    'public.trg_credibility_owner_only()']) f
 WHERE to_regprocedure(f) IS NOT NULL
ON CONFLICT (fn) DO NOTHING;
-- attempt 2: the allow-list's COMMENT too, so the revert restores it (stored as a 'comment:' row)
INSERT INTO public.research_sources_saved (fn, def)
SELECT 'comment:public.request_boundary_options_ok(jsonb,boolean)',
       COALESCE(obj_description(to_regprocedure('public.request_boundary_options_ok(jsonb,boolean)'), 'pg_proc'), '')
 WHERE to_regprocedure('public.request_boundary_options_ok(jsonb,boolean)') IS NOT NULL
ON CONFLICT (fn) DO NOTHING;

-- ── the registry and its guards ────────────────────────────────────────────────────────────────
INSERT INTO public.contract_registries (name, version, owner, description) VALUES
    ('source_classes', 0, 'rwr-research-sources', 'community source classes (forum, Q&A, social, code discussion, self-published): a URL matched here is a community source')
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
                      'entailment_verdicts', 'source_families', 'credibility_terms', 'source_classes');
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_credibility_registry_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_guarded TEXT[] := ARRAY['claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                              'entailment_verdicts', 'admission_trail_kinds', 'credibility_terms', 'source_classes'];
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

CREATE OR REPLACE FUNCTION public.trg_credibility_owner_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_guarded TEXT[] := ARRAY['claim_kinds', 'credibility_weights', 'domain_classes', 'paper_score_versions',
                              'entailment_verdicts', 'admission_trail_kinds', 'credibility_terms', 'source_classes'];
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

-- A source_classes definition: kind, an integer order, host_patterns (non-empty) and optional path_patterns that
-- compile in both dialects, optional key_host / key_segments (how independent communities are told apart).
CREATE OR REPLACE FUNCTION public.source_class_def_ok(p_def JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE p TEXT;
BEGIN
    IF jsonb_typeof(p_def) <> 'object' OR jsonb_typeof(p_def -> 'kind') <> 'string'
       OR (p_def ->> 'kind') NOT IN ('qa', 'forum', 'social', 'code_discussion', 'self_published')
       OR jsonb_typeof(p_def -> 'order') <> 'number' OR (p_def ->> 'order') !~ '^[0-9]{1,6}$'
       OR jsonb_typeof(p_def -> 'host_patterns') <> 'array' OR jsonb_array_length(p_def -> 'host_patterns') = 0
       OR (p_def ? 'path_patterns' AND jsonb_typeof(p_def -> 'path_patterns') <> 'array')
       OR (p_def ? 'key_host' AND (jsonb_typeof(p_def -> 'key_host') <> 'string' OR (p_def ->> 'key_host') !~ '^[a-z0-9.-]+$'))
       OR (p_def ? 'key_segments' AND (jsonb_typeof(p_def -> 'key_segments') <> 'number' OR (p_def ->> 'key_segments') !~ '^[0-3]$')) THEN
        RETURN FALSE;
    END IF;
    FOR p IN SELECT jsonb_array_elements_text(p_def -> 'host_patterns')
             UNION ALL SELECT jsonb_array_elements_text(COALESCE(p_def -> 'path_patterns', '[]'::jsonb)) LOOP
        PERFORM '' ~* p;    -- an invalid pattern raises: the write is refused
    END LOOP;
    RETURN TRUE;
END;
$$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_registry_entries_source_class_ok'
                     AND conrelid = 'public.contract_registry_entries'::regclass) THEN
        ALTER TABLE public.contract_registry_entries ADD CONSTRAINT contract_registry_entries_source_class_ok
            CHECK (registry <> 'source_classes' OR public.source_class_def_ok(definition));
    END IF;
END $$;

-- The class list (operator-confirmed 2026-11-27). Patterns are matched against the host (lower case, `www.` and a
-- trailing dot stripped, no port) and, where given, the path. POSIX-and-JavaScript compatible on purpose: the
-- research service reads them with `new RegExp(.., "i")`, the SQL below with `~*`. One seeding statement.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('source_classes', 'reddit', 'Reddit', '{"order":10,"kind":"forum","host_patterns":["(^|\\.)reddit\\.com$","^redd\\.it$","(^|\\.)redditapis\\.com$","(^|\\.)redditmedia\\.com$","(^|\\.)teddit\\.","(^|\\.)libreddit\\.","(^|\\.)redlib\\.","^safereddit\\.com$"],"key_host":"reddit.com","key_segments":2}'),
    ('source_classes', 'hacker-news', 'Hacker News', '{"order":20,"kind":"forum","host_patterns":["^news\\.ycombinator\\.com$","^hn\\.algolia\\.com$"],"key_host":"news.ycombinator.com"}'),
    ('source_classes', 'aggregators', 'link aggregators', '{"order":30,"kind":"forum","host_patterns":["^lobste\\.rs$","(^|\\.)slashdot\\.org$","^tildes\\.net$"]}'),
    ('source_classes', 'stack-exchange', 'Stack Overflow and Stack Exchange', '{"order":40,"kind":"qa","host_patterns":["(^|\\.)stackoverflow\\.com$","(^|\\.)stackexchange\\.com$","(^|\\.)superuser\\.com$","(^|\\.)serverfault\\.com$","(^|\\.)askubuntu\\.com$","(^|\\.)mathoverflow\\.net$","(^|\\.)stackapps\\.com$"]}'),
    ('source_classes', 'qa-sites', 'other Q&A sites', '{"order":50,"kind":"qa","host_patterns":["(^|\\.)quora\\.com$","^answers\\.microsoft\\.com$","^discussions\\.apple\\.com$","^answers\\.","(^|\\.)answers\\.com$"]}'),
    ('source_classes', 'forum-hosts', 'forum hosts', '{"order":60,"kind":"forum","host_patterns":["^(forum|forums|community|communities|discuss|discussions|devforum|discourse|talk|board|boards)\\.","^[^.]*forum[^.]*\\.[a-z]","\\.discourse\\.group$","^techcommunity\\.microsoft\\.com$"]}'),
    ('source_classes', 'social', 'social networks', '{"order":70,"kind":"social","host_patterns":["(^|\\.)twitter\\.com$","^x\\.com$","^t\\.co$","(^|\\.)nitter\\.","^xcancel\\.com$","(^|\\.)threads\\.net$","^bsky\\.app$","(^|\\.)facebook\\.com$","^fb\\.com$","(^|\\.)instagram\\.com$","(^|\\.)tiktok\\.com$","(^|\\.)tumblr\\.com$","(^|\\.)mastodon\\.","\\.social$","^lemmy\\."]}'),
    ('source_classes', 'linkedin-posts', 'LinkedIn posts', '{"order":80,"kind":"social","host_patterns":["(^|\\.)linkedin\\.com$"],"path_patterns":["^/(posts|pulse|feed)(/|$)"]}'),
    ('source_classes', 'code-discussion', 'issues, discussions and pull requests', '{"order":90,"kind":"code_discussion","host_patterns":["^github\\.com$","^gitlab\\.com$","^codeberg\\.org$"],"path_patterns":["^/[^/]+/[^/]+/(-/)?(issues|discussions|pull|pulls|merge_requests)(/|$)"],"key_segments":2}'),
    ('source_classes', 'self-published', 'self-published platforms', '{"order":100,"kind":"self_published","host_patterns":["(^|\\.)medium\\.com$","\\.substack\\.com$","^dev\\.to$","(^|\\.)hashnode\\.dev$","\\.github\\.io$","^gist\\.github\\.com$","\\.wordpress\\.com$","\\.blogspot\\.[a-z.]+$"]}'),
    ('source_classes', 'forum-paths', 'forum and fediverse paths on any host', '{"order":200,"kind":"forum","host_patterns":["."],"path_patterns":["^/(forum|forums|community|communities)(/|$)","^/t/[^/]+/[0-9]+","^/@[a-z0-9_.]+/[0-9]+","^/(u|c)/[^/]+/?$"]}')
ON CONFLICT (registry, key) DO NOTHING;

-- The community terms: the weight a community-only claim's total carries, how far under the floor its cap sits,
-- the legacy formula's floor (the reuse gate's default, research.confidence_floor), and how many independent
-- communities make a consensus.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('credibility_terms', 'community', 'community evidence',
        '{"term_version":1,"weight":0.5,"floor_margin":0.01,"legacy_floor":0.5,"consensus_min":2}')
ON CONFLICT (registry, key) DO NOTHING;

-- The community terms, validated (OBC04 when malformed: the gate stops, as credibility_model_check does).
CREATE OR REPLACE FUNCTION public.credibility_community_terms()
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE v JSONB;
BEGIN
    SELECT definition INTO v FROM public.contract_registry_entries
     WHERE registry = 'credibility_terms' AND key = 'community' AND retired_at IS NULL;
    IF v IS NULL OR NOT (public.credibility_is_unit(v -> 'weight') AND public.credibility_is_unit(v -> 'floor_margin')
                         AND public.credibility_is_unit(v -> 'legacy_floor')
                         AND jsonb_typeof(v -> 'consensus_min') = 'number' AND (v ->> 'consensus_min') ~ '^[1-9]$') THEN
        RAISE EXCEPTION 'credibility_terms.community: the terms are missing or malformed (%) - the gate stops', v USING ERRCODE = 'OBC04';
    END IF;
    RETURN v;
END;
$$;

-- ── the classifier (SQL twin of source-class.ts classifySource) ───────────────────────────────
-- attempt 2: ASCII-only lower case (source-class.ts asciiLower; lower() and JS disagree on final sigma and dotted I)
CREATE OR REPLACE FUNCTION public.source_ascii_lower(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$ SELECT translate(p, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') $$;

-- Unwrap: web.archive.org/web/<stamp>/<url>, <host>.translate.goog, <x>.cdn.ampproject.org/c/[s/]<host>/... (up to
-- three levels). Then host = lower case, no `www.`, no trailing dot, no port; path = the path (no query, fragment).
CREATE OR REPLACE FUNCTION public.source_url_unwrap(p_url TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE u TEXT := btrim(COALESCE(p_url, '')); h TEXT; rest TEXT; i INT;
BEGIN
    FOR i IN 1..3 LOOP
        h := public.source_ascii_lower(substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)'));
        h := regexp_replace(COALESCE(h, ''), '^.*@', '');   -- the host follows the LAST @
        h := regexp_replace(h, ':[0-9]+$', '');
        rest := substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+(.*)$');
        IF h IN ('web.archive.org', 'archive.org') AND rest ~ '^/web/[0-9a-z_*]+/.+' THEN
            u := substring(rest from '^/web/[0-9a-z_*]+/(.+)$');
            IF u !~* '^https?://' THEN u := 'https://' || regexp_replace(u, '^https?:/+', ''); END IF;
        ELSIF h ~ '\.translate\.goog$' THEN
            u := 'https://' || replace(replace(replace(regexp_replace(h, '\.translate\.goog$', ''), '--', chr(1)), '-', '.'), chr(1), '-')
                 || COALESCE(substring(rest from '^(/[^?#]*)'), '/');
        ELSIF h ~ '\.cdn\.ampproject\.org$' AND rest ~ '^/[cv]/(s/)?[^/]+' THEN
            u := 'https://' || substring(rest from '^/[cv]/(?:s/)?(.+)$');
        ELSE
            EXIT;
        END IF;
    END LOOP;
    RETURN u;
END;
$$;

CREATE OR REPLACE FUNCTION public.source_class_of(p_url TEXT, p_domain TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE u TEXT := public.source_url_unwrap(p_url); h TEXT; path TEXT; e RECORD; segs TEXT[]; n INT; k TEXT;
BEGIN
    h := public.source_ascii_lower(substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]+)'));
    IF h IS NULL THEN h := public.source_ascii_lower(NULLIF(btrim(COALESCE(p_domain, '')), '')); END IF;
    IF h IS NULL THEN RETURN NULL; END IF;
    h := regexp_replace(regexp_replace(regexp_replace(h, '^.*@', ''), ':[0-9]+$', ''), '\.$', '');
    h := regexp_replace(h, '^www\.', '');
    path := COALESCE(substring(u from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+(/[^?#]*)'), '/');
    FOR e IN SELECT key, definition d FROM public.contract_registry_entries
              WHERE registry = 'source_classes' AND retired_at IS NULL
              ORDER BY (definition ->> 'order')::int, key LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.d -> 'host_patterns') p WHERE h ~* p);
        CONTINUE WHEN e.d ? 'path_patterns'
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.d -> 'path_patterns') p WHERE path ~* p);
        n := COALESCE((e.d ->> 'key_segments')::int, 0);
        segs := ARRAY(SELECT public.source_ascii_lower(s) FROM unnest(string_to_array(btrim(path, '/'), '/')) WITH ORDINALITY t(s, o)
                       WHERE s <> '' ORDER BY o LIMIT n);
        k := COALESCE(e.d ->> 'key_host', h) || CASE WHEN array_length(segs, 1) > 0 THEN '/' || array_to_string(segs, '/') ELSE '' END;
        RETURN jsonb_build_object('kind', e.d ->> 'kind', 'entry', e.key, 'key', k);
    END LOOP;
    RETURN NULL;
END;
$$;


-- ── the stored class (lab 1, 2026-11-27: the lookup in the hot path stalled the twins grid) ───
-- sources.community_key is source_class_of(url, domain) ->> 'key', stored (NULL = not community). source_class_of
-- stays the ONE definition: every writer of the column calls it.
--   * a row trigger sets it on INSERT and on any UPDATE that changes url, domain or the column itself (so a direct
--     write cannot plant a value: it is recomputed from the definition);
--   * statement triggers on contract_registry_entries re-classify every source when a source_classes row is
--     inserted, updated or deleted (owner-only rows: the P3a guard above);
--   * source_community_drift() counts rows whose stored value differs from the definition (0 = never stale).
--   * attempt 2 (tester attempt 1, Case 13 - two sessions left a stale row): the two writers are SERIALISED by one
--     advisory lock. A source write that classifies takes it SHARED (source writes never wait for each other); a
--     re-classification takes it EXCLUSIVE. So a re-classification waits for every open source write to commit (and
--     then sees it), and a source write waits for an open registry change to commit (and then classifies with it).
--     Both sides are plpgsql in READ COMMITTED, so the statement after the lock reads a fresh snapshot. Residual: a
--     source writer in REPEATABLE READ or SERIALIZABLE keeps its older snapshot; every writer here is READ COMMITTED.
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS community_key TEXT;

CREATE OR REPLACE FUNCTION public.trg_sources_community_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.url IS DISTINCT FROM OLD.url OR NEW.domain IS DISTINCT FROM OLD.domain
       OR NEW.community_key IS DISTINCT FROM OLD.community_key THEN
        PERFORM pg_advisory_xact_lock_shared(750750);   -- attempt 2: wait for an open registry change to commit
        NEW.community_key := public.source_class_of(NEW.url, NEW.domain) ->> 'key';
    END IF;
    RETURN NEW;
END;
$$;
-- `zz`: after every other BEFORE row trigger on sources, so it classifies the url and domain that are written
DROP TRIGGER IF EXISTS trg_zz_sources_community_key ON public.sources;
CREATE TRIGGER trg_zz_sources_community_key BEFORE INSERT OR UPDATE ON public.sources
    FOR EACH ROW EXECUTE FUNCTION public.trg_sources_community_key();

CREATE OR REPLACE FUNCTION public.source_classes_reclassify()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE n INT;
BEGIN
    -- fix round 3 (FU1): drain every open writer of `sources` (they hold ROW EXCLUSIVE) BEFORE the advisory lock, and keep new
    -- ones out until this transaction ends. Without it the tester's deadlocks formed: a registry edit holding the registry row
    -- and waiting for a writer's row lock, while that writer waited for the shared advisory lock (40P01, I5a and D-a).
    LOCK TABLE public.sources IN SHARE ROW EXCLUSIVE MODE;
    PERFORM pg_advisory_xact_lock(750750);   -- attempt 2: wait for every open source write to commit
    UPDATE public.sources s SET community_key = public.source_class_of(s.url, s.domain) ->> 'key'
     WHERE s.community_key IS DISTINCT FROM (public.source_class_of(s.url, s.domain) ->> 'key');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.source_community_drift()
RETURNS BIGINT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT count(*) FROM public.sources s WHERE s.community_key IS DISTINCT FROM (public.source_class_of(s.url, s.domain) ->> 'key');
$$;

CREATE OR REPLACE FUNCTION public.trg_source_classes_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE hit BOOLEAN;
BEGIN
    -- one statement per operation: a statement naming a transition table this trigger does not have is never planned
    -- (lab 2: one OR-expression over `changed` and `was` failed on INSERT with 'relation "was" does not exist')
    IF TG_OP = 'INSERT' THEN
        hit := EXISTS (SELECT 1 FROM changed WHERE registry = 'source_classes');
    ELSIF TG_OP = 'UPDATE' THEN
        hit := EXISTS (SELECT 1 FROM changed WHERE registry = 'source_classes') OR EXISTS (SELECT 1 FROM was WHERE registry = 'source_classes');
    ELSE
        hit := EXISTS (SELECT 1 FROM was WHERE registry = 'source_classes');
    END IF;
    IF hit THEN
        PERFORM public.source_classes_reclassify();
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_source_classes_changed_ins ON public.contract_registry_entries;
CREATE TRIGGER trg_source_classes_changed_ins AFTER INSERT ON public.contract_registry_entries
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION public.trg_source_classes_changed();
DROP TRIGGER IF EXISTS trg_source_classes_changed_upd ON public.contract_registry_entries;
CREATE TRIGGER trg_source_classes_changed_upd AFTER UPDATE ON public.contract_registry_entries
    REFERENCING NEW TABLE AS changed OLD TABLE AS was FOR EACH STATEMENT EXECUTE FUNCTION public.trg_source_classes_changed();
DROP TRIGGER IF EXISTS trg_source_classes_changed_del ON public.contract_registry_entries;
CREATE TRIGGER trg_source_classes_changed_del AFTER DELETE ON public.contract_registry_entries
    REFERENCING OLD TABLE AS was FOR EACH STATEMENT EXECUTE FUNCTION public.trg_source_classes_changed();
-- attempt 2: owner-only. The default privileges grant service_role EXECUTE on every new function, so REVOKE FROM PUBLIC
-- is not enough: each helper is a full scan (about 24 s at live size, the tester measured).
REVOKE ALL ON FUNCTION public.trg_sources_community_key(), public.source_classes_reclassify(),
    public.trg_source_classes_changed(), public.source_community_drift() FROM PUBLIC, service_role;

-- the backfill (every existing source; the re-score below reads the column)
SELECT public.source_classes_reclassify();

CREATE OR REPLACE FUNCTION public.source_is_community(p_source_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT s.community_key IS NOT NULL FROM public.sources s WHERE s.id = p_source_id;
$$;

-- A claim has credible support: a non-contradicting edge to a source that is not community class and is not retracted
-- (fix round 3, FU11: a retracted source supports nothing, as in claim_edge_counts and the consensus check below).
CREATE OR REPLACE FUNCTION public.claim_has_credible_support(p_claim_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (SELECT 1 FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                    WHERE cs.claim_id = p_claim_id AND cs.edge_type <> 'contradicts'
                      AND s.community_key IS NULL AND s.retraction_committed_at IS NULL);
$$;

-- fix round 3 (R1): does this `contradicts` edge come from the community? A source edge: the source is community class. A
-- claim edge (the curator's conflict check writes these, both ways): the other claim is community-only. The edge stays in
-- claim_sources, so the contest is visible; it just does not cap a claim that has credible support.
CREATE OR REPLACE FUNCTION public.claim_contradiction_is_community(p_source_id UUID, p_parent_claim_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT CASE WHEN p_source_id IS NOT NULL THEN COALESCE(public.source_is_community(p_source_id), FALSE)
                WHEN p_parent_claim_id IS NOT NULL THEN public.claim_community_only(p_parent_claim_id)
                ELSE FALSE END;
$$;

-- Community only: grounded directly in sources, every one of them community class. (A claim grounded only through
-- parent claims is neither; its parents carry their own rating.)
CREATE OR REPLACE FUNCTION public.claim_community_only(p_claim_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (SELECT 1 FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                    WHERE cs.claim_id = p_claim_id AND cs.edge_type <> 'contradicts' AND s.community_key IS NOT NULL)
       AND NOT public.claim_has_credible_support(p_claim_id);
$$;

CREATE OR REPLACE FUNCTION public.claim_community_consensus(p_claim_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT count(DISTINCT s.community_key)
             >= (public.credibility_community_terms() ->> 'consensus_min')::int
      FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
     WHERE cs.claim_id = p_claim_id AND cs.edge_type IN ('states', 'corroborates')
       AND s.retraction_committed_at IS NULL AND s.community_key IS NOT NULL;
$$;

-- ── the legacy formula (init-claims.sql), with the community rule ─────────────────────────────
-- Unchanged for a claim with no community source. With credible support, the community edges are left out of every
-- term, a community `contradicts` edge included (fix round 3, R1), so the claim scores as it would without them; community-only, the result is x weight and capped
-- floor_margin under legacy_floor.
CREATE OR REPLACE FUNCTION public.claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_depth        INT;
    v_base         REAL := 0.0;
    v_corroborators INT := 0;
    v_authority    REAL := 0.85;
    v_has_strong   BOOLEAN := FALSE;
    v_has_inferred BOOLEAN := FALSE;
    v_contradicted BOOLEAN := FALSE;
    v_stale        BOOLEAN := FALSE;
    v_score        REAL;
    v_credible     BOOLEAN;
    v_comm_only    BOOLEAN;
    v_terms        JSONB;
BEGIN
    v_depth := public.claim_min_depth(p_claim_id);
    IF v_depth IS NULL THEN
        RETURN 0.0;
    END IF;
    v_credible := public.claim_has_credible_support(p_claim_id);
    v_comm_only := public.claim_community_only(p_claim_id);

    -- the counted edges: every edge, minus community-source edges when the claim has credible support
    SELECT bool_or(cs.edge_type IN ('states','corroborates')),
           bool_or(cs.edge_type = 'inferred_from'),
           bool_or(cs.edge_type = 'contradicts')
      INTO v_has_strong, v_has_inferred, v_contradicted
      FROM public.claim_sources cs LEFT JOIN public.sources s ON s.id = cs.source_id
     WHERE cs.claim_id = p_claim_id
       AND (cs.source_id IS NULL OR s.retraction_committed_at IS NULL)   -- D5 stage 1, as claim_edge_counts (base 540)
       AND NOT (v_credible AND CASE WHEN cs.edge_type = 'contradicts'
                                    THEN public.claim_contradiction_is_community(cs.source_id, cs.parent_claim_id)
                                    ELSE s.id IS NOT NULL AND s.community_key IS NOT NULL END);

    IF v_has_strong THEN v_base := 0.90;
    ELSIF v_has_inferred THEN v_base := 0.60;
    ELSE v_base := 0.0; END IF;

    SELECT GREATEST(COUNT(DISTINCT cs.source_id) - 1, 0) INTO v_corroborators
      FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
     WHERE cs.claim_id = p_claim_id
       AND cs.edge_type IN ('states','corroborates')
       AND s.retraction_committed_at IS NULL
       AND NOT (v_credible AND s.community_key IS NOT NULL);

    SELECT MAX(CASE
                 WHEN s.domain ~* '\.(gov|edu|mil)(:|/|$)'
                   OR s.url ~* '://[^/]*\.(gov|edu|mil)(:|/|$)'
                   OR (s.metadata ->> 'authority') = 'primary'
                 THEN 1.0 ELSE 0.85 END)
      INTO v_authority
      FROM public.claim_sources cs
      JOIN public.sources s ON s.id = cs.source_id
     WHERE cs.claim_id = p_claim_id
       AND cs.edge_type <> 'contradicts'
       AND s.retraction_committed_at IS NULL
       AND NOT (v_credible AND s.community_key IS NOT NULL);
    v_authority := COALESCE(v_authority, 0.85);

    SELECT (researched_on + COALESCE(revalidate_days,
              CASE volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180
                              WHEN 'slow' THEN 1095 ELSE 180 END) < CURRENT_DATE)
      INTO v_stale
      FROM public.claims WHERE id = p_claim_id;

    v_score := (v_base + LEAST(0.03 * v_corroborators, 0.10))
               * v_authority
               * power(0.85, v_depth);
    IF COALESCE(v_stale, FALSE) THEN v_score := v_score * 0.5; END IF;
    IF v_contradicted THEN v_score := LEAST(v_score, 0.30); END IF;
    IF v_comm_only THEN
        v_terms := public.credibility_community_terms();
        v_score := LEAST(v_score * (v_terms ->> 'weight')::real,
                         GREATEST((v_terms ->> 'legacy_floor')::real - (v_terms ->> 'floor_margin')::real, 0.0));
    END IF;

    RETURN GREATEST(LEAST(v_score, 1.0), 0.0);
END;
$$;

-- ── D15: corroboration never comes from, or goes to, a community source ──────────────────────
CREATE OR REPLACE FUNCTION public.source_rolling_total_core(p_source_id UUID, p_kind TEXT, p_scope JSONB, p_exclude UUID[])
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
DECLARE c RECORD; w JSONB; v_base DOUBLE PRECISION; v_in DOUBLE PRECISION; v_bad BOOLEAN; v_bonus DOUBLE PRECISION := 0;
        v_comm BOOLEAN;
BEGIN
    SELECT * INTO c FROM public.source_credibility(p_source_id);
    IF c.family IS NULL THEN RETURN 0; END IF;
    w := public.credibility_weight(p_kind, c.family);
    IF c.is_primary AND w ? 'primary_bonus' THEN
        v_bonus := public.credibility_unit(w, 'primary_bonus', 'weight row ' || p_kind || '.' || c.family);
    END IF;
    v_base := public.credibility_unit(w, 'weight', 'weight row ' || p_kind || '.' || c.family) * LEAST(1::float8, c.score + v_bonus);
    v_comm := COALESCE(public.source_is_community(p_source_id), FALSE);
    SELECT COALESCE(sum(sc.amount ORDER BY sc.amount DESC), 0::float8), COALESCE(bool_or(NOT public.credibility_is_unit_value(sc.amount)), FALSE) INTO v_in, v_bad
      FROM public.source_corroborations sc
      JOIN public.sources g ON g.id = sc.from_source_id AND g.retraction_committed_at IS NULL
           AND (p_scope IS NULL OR g.metadata @> p_scope)
     WHERE sc.to_source_id = p_source_id
       AND sc.from_source_id <> p_source_id
       AND (p_exclude IS NULL OR NOT (sc.from_source_id = ANY (p_exclude)))
       AND NOT v_comm
       AND g.community_key IS NULL;
    IF v_bad THEN
        RAISE EXCEPTION 'credibility: a corroboration into source % has an amount that is not 0 or in [1e-9, 1] - the gate stops', p_source_id
            USING ERRCODE = 'OBC04';
    END IF;
    RETURN LEAST(1::float8, v_base + v_in);
END;
$$;

-- ── D15 claim total, with the community rule (the twin of credibility.ts communityClaimTotal) ──
CREATE OR REPLACE FUNCTION public.claim_confidence_d15(p_claim_id UUID)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_kind TEXT; v_basis TEXT; v_depth INT; v_terms JSONB; v_lead DOUBLE PRECISION := 0; v_extra DOUBLE PRECISION := 0;
    v_stale BOOLEAN; v_contra BOOLEAN; v_score DOUBLE PRECISION; r RECORD; i INT := 0; v_grounders UUID[];
    v_per DOUBLE PRECISION; v_cap DOUBLE PRECISION; v_factors JSONB; v_badw BOOLEAN;
    v_credible BOOLEAN; v_comm_only BOOLEAN; v_comm JSONB;
BEGIN
    PERFORM public.credibility_model_check();
    v_comm := public.credibility_community_terms();
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
    v_credible := public.claim_has_credible_support(p_claim_id);
    v_comm_only := public.claim_community_only(p_claim_id);
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
          JOIN public.sources s ON s.id = e.source_id
         WHERE e.source_id IS NOT NULL AND e.edge_type <> 'contradicts'
           AND NOT (v_credible AND s.community_key IS NOT NULL)
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
    -- fix round 3 (R1): a community contradiction does not cap a claim that has credible support (the edge stays)
    SELECT bool_or(e.edge_type = 'contradicts') INTO v_contra FROM public.claim_edge_counts(p_claim_id) e
     WHERE NOT (v_credible AND e.edge_type = 'contradicts'
                AND public.claim_contradiction_is_community(e.source_id, e.parent_claim_id));
    IF COALESCE(v_contra, FALSE) THEN v_score := LEAST(v_score, 0.30::float8); END IF;
    IF v_comm_only THEN
        v_score := LEAST(v_score * (v_comm ->> 'weight')::float8,
                         GREATEST(public.credibility_claim_floor(v_kind) - (v_comm ->> 'floor_margin')::float8, 0::float8));
    END IF;
    RETURN GREATEST(LEAST(v_score, 1::float8), 0::float8);
END;
$$;

-- ── the start door's allow-list: 540's, plus `sources` (root and branch) ─────────────────────
CREATE OR REPLACE FUNCTION public.request_boundary_options_ok(p_options JSONB, p_root BOOLEAN)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_options IS NULL OR (jsonb_typeof(p_options) = 'object' AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(p_options) e(k, v)
         WHERE NOT CASE
             WHEN e.k = 'public_links' AND p_root THEN jsonb_typeof(e.v) = 'array' AND jsonb_array_length(e.v) <= 5
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.v) l(x)
                                   WHERE jsonb_typeof(l.x) <> 'string' OR (l.x #>> '{}') !~ '^https?://[^\s?#]+$' OR length(l.x #>> '{}') > 2000)
             WHEN e.k = 'queue_origin' THEN jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') ~ '^[a-z0-9_-]{1,32}$'
             WHEN e.k = 'model_down_requeues' THEN jsonb_typeof(e.v) = 'number'
             WHEN e.k = 'lane' AND NOT p_root THEN e.v = '"research-branch"'::jsonb
             WHEN e.k = 'mode' AND p_root THEN e.v = '"article"'::jsonb
             WHEN e.k = 'gap_research' AND p_root THEN e.v IN ('"none"'::jsonb, '"preliminary"'::jsonb)
             WHEN e.k = 'dry_run' AND p_root THEN jsonb_typeof(e.v) = 'boolean'
             WHEN e.k = 'deadline_at' AND p_root THEN jsonb_typeof(e.v) = 'string'
                  AND (e.v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
             WHEN e.k = 'contract' THEN jsonb_typeof(e.v) = 'object'
                  AND (SELECT count(*) FROM jsonb_object_keys(e.v)) = 1 AND e.v ? 'budget' AND jsonb_typeof(e.v -> 'budget') = 'object'
                  AND NOT EXISTS (SELECT 1 FROM jsonb_each(e.v -> 'budget') b(k, v)
                                   WHERE NOT (b.k IN ('rounds', 'max_fetch', 'wall_ms') AND jsonb_typeof(b.v) = 'number' AND (b.v #>> '{}') ~ '^[1-9][0-9]{0,8}$'))
             -- rwr-research-sources (slot 750): which sources the run may read - a fixed word, on a root and on a branch
             WHEN e.k = 'sources' THEN e.v IN ('"credible"'::jsonb, '"community"'::jsonb)
             ELSE false END));
$$;
COMMENT ON FUNCTION public.request_boundary_options_ok(jsonb, boolean) IS
    'rw-boundary-core TF8 + rw-boundary-digest (slot 460) + rwr-research-start-api (slot 540) + rwr-research-sources (slot 750): a derived job''s options allow-list - root: public_links, queue_origin, model_down_requeues, mode (article), gap_research (none|preliminary), dry_run (boolean), deadline_at (ISO), contract {budget: {rounds, max_fetch, wall_ms}}, sources (credible|community); branch: lane, queue_origin, model_down_requeues, contract {budget}, sources';
DO $$
DECLARE
    f TEXT := 'public.request_boundary_options_ok(jsonb,boolean)';
    r RECORD;
BEGIN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT DISTINCT ro.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE p.oid = to_regprocedure(f) AND NOT ro.rolsuper AND ro.oid <> p.proowner
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.rolname);
    END LOOP;
END $$;

-- ── settings (registry rows; slot 550's tag set where the key is defined) ────────────────────
INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store, tag) VALUES
    ('research.sources_default', 'user', 'enum', 'research', 120, 'Sources for my research',
        'Credible only: research reads no forums, Q&A sites or social posts. Also community: they are read too, labelled, and never make a claim credible on their own.',
        '"credible"', NULL, 'openbrain-workbench, when the Start research dialog opens (its preset Sources choice)', '{"enum":["credible","community"]}', true, 'settings', 'only_you'),
    ('research.community_allowed', 'admin', 'boolean', 'research', 130, 'Allow community sources',
        'Off: nobody can choose community sources (forums, Q&A sites, social posts); every run reads credible sources only.',
        'true', NULL, 'openbrain-workbench and openbrain-research, on every research start', '{}', true, 'settings', 'admin_all')
ON CONFLICT (key) DO UPDATE SET tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store, tag = EXCLUDED.tag;

-- ── grants: the readers the services call ─────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.source_class_of(TEXT, TEXT), public.source_url_unwrap(TEXT),
    public.source_is_community(UUID), public.claim_has_credible_support(UUID), public.claim_community_only(UUID),
    public.claim_community_consensus(UUID), public.credibility_community_terms(),
    public.claim_contradiction_is_community(UUID, UUID) TO service_role;

-- ── the deploy re-score (operator 2026-11-27): every claim with a community grounding source ─
DO $$
DECLARE r RECORD; n INT := 0;
BEGIN
    FOR r IN SELECT DISTINCT cs.claim_id FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
              WHERE s.community_key IS NOT NULL LOOP
        PERFORM public.recompute_claim_confidence(r.claim_id);
        n := n + 1;
    END LOOP;
    RAISE NOTICE 'rwr-research-sources: re-scored % claim(s) with a community source', n;
END $$;

COMMIT;
