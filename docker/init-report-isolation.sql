-- ============================================================
-- An idea's research report is private to the idea's owner (research-workbench rw-report-isolation). Slot 390.
-- Operator 2026-11-02: "Ideas are completely user isolated. The shared knowledge are the sources and claims. This
-- is the only case where the final reports are user isolated rather than shared like other reports."
--
--   * research_job_report_owner(job): THE rule for "a research job run for an idea" - the job, or the root of its
--     tree, is the idea's branch (branch_kind 'idea'), carries the idea (refinery_id, set only by
--     research_idea_queue and the idea-revision inlet trigger) or is stamped on one of the idea's revisions
--     (idea_revisions.research_job_id). Never the job's text, and never inlet_ref (the caller names that). No row =
--     not an idea job; a row = an idea job, with the idea's current owner (NULL when the idea is gone: then nobody
--     reads the report - fail closed). openbrain-mcp's POST /research/persist and the research curator both ask it.
--   * research_private_reports: where an idea job's final report is filed INSTEAD of a shared `sources` row
--     (content_type research_synthesis). One per research_key (supersede in place, as the shared row did). Nothing
--     shared reads it: not sources / source_chunks / search / the wiki / any contract route - only the owner's
--     idea read in the workbench (owner_sub filter, as every per-user table in this plane: rooms, listings).
--   * research_private_report_claims: which claims were drawn from a private report - the owner's link back. The
--     claims themselves stay SHARED knowledge (claims.synthesis_id NULL: no shared row to point at, so following a
--     claim back yields nothing).
--   * THE MOVE: every existing idea-job synthesis still in `sources` is archived (the row, every row of every table
--     whose foreign key references it, and its wiki leaf page row) into research_report_isolation_archive, copied
--     into research_private_reports, its claims linked, and then deleted from `sources` (the foreign keys cascade or
--     set NULL exactly as they are declared). A synthesis that a NON-idea job also filed is left shared and counted.
--     Counts only are printed (NOTICE), never content. A second run moves nothing (idempotent).
-- The archive is the superuser's alone (RLS on, no policy, no grant): it holds the reports' text.
-- Fresh-volume slot 390; live: psql -f BEFORE the new openbrain-mcp and research-curator images, with a fresh backup;
-- the moved reports' wiki leaf FILES (content/source/<id>.md in the vault) are moved out by hand first (the viewer's
-- reconcile would rewrite a leaf row from its file). Revert: revert-report-isolation.sql (restores every archived
-- row; keeps the tables).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.research_private_reports (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    research_key       TEXT NOT NULL UNIQUE,
    -- the idea's owner when it was filed; NULL = no owner to read it (the idea is gone): nobody reads it
    owner_sub          TEXT,
    idea_id            UUID REFERENCES public.ideas(id) ON DELETE SET NULL,
    job_id             UUID REFERENCES public.research_jobs(id) ON DELETE SET NULL,
    title              TEXT NOT NULL DEFAULT '',
    content            TEXT NOT NULL,
    claim              TEXT,
    research_query     TEXT,
    run_kind           TEXT,
    volatility         TEXT,
    revalidate_days    INT,
    researched_on      DATE,
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    -- the shared sources row slot 390 moved this report out of (the revert's key); a later filing that
    -- supersedes the report clears it (the copy is no longer the moved row)
    migrated_source_id UUID UNIQUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_private_reports_owner ON public.research_private_reports (owner_sub, idea_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_private_reports_job ON public.research_private_reports (job_id);

CREATE TABLE IF NOT EXISTS public.research_private_report_claims (
    report_id UUID NOT NULL REFERENCES public.research_private_reports(id) ON DELETE CASCADE,
    claim_id  UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
    PRIMARY KEY (report_id, claim_id)
);
CREATE INDEX IF NOT EXISTS idx_research_private_report_claims_claim ON public.research_private_report_claims (claim_id);

ALTER TABLE public.research_private_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_private_report_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_private_reports_service_role_all ON public.research_private_reports;
CREATE POLICY research_private_reports_service_role_all ON public.research_private_reports
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS research_private_report_claims_service_role_all ON public.research_private_report_claims;
CREATE POLICY research_private_report_claims_service_role_all ON public.research_private_report_claims
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.research_private_reports FROM PUBLIC;
REVOKE ALL ON public.research_private_report_claims FROM PUBLIC;
GRANT ALL ON public.research_private_reports TO service_role;
GRANT ALL ON public.research_private_report_claims TO service_role;

-- the move's archive: every row the move deleted or changed, as it was (the revert re-inserts / re-points them)
CREATE TABLE IF NOT EXISTS public.research_report_isolation_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    source_id   UUID NOT NULL,           -- the moved synthesis this row belongs to
    tbl         TEXT NOT NULL,           -- the table the row is from (schema-qualified)
    col         TEXT NOT NULL,           -- the column that referenced the synthesis ('id' for the sources row itself)
    action      TEXT NOT NULL,           -- 's' the sources row, 'w' its wiki leaf row, else the FK's confdeltype (c / n / d)
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_research_report_isolation_archive_batch ON public.research_report_isolation_archive (batch, restored_at);
ALTER TABLE public.research_report_isolation_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_report_isolation_archive FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.research_report_isolation_archive_id_seq FROM PUBLIC;
-- the schema's default privileges grant every new table to the app roles (service_role, ...): take those back too
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.research_report_isolation_archive'::regclass, 'public.research_report_isolation_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_report_isolation_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.research_report_isolation_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;

-- ── the rule ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.research_job_report_owner(p_job UUID)
RETURNS TABLE (idea_id UUID, owner_sub TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_jobs   UUID[];
    v_hit    BOOLEAN;
    v_idea   UUID;
BEGIN
    IF p_job IS NULL THEN RETURN; END IF;
    -- the job and the root of its tree (a steer / gap branch of an idea's research is the idea's research)
    SELECT array_agg(x) INTO v_jobs FROM (
        SELECT j.id AS x FROM public.research_jobs j WHERE j.id = p_job
        UNION SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job AND j.root_job_id IS NOT NULL) s;
    IF v_jobs IS NULL THEN RETURN; END IF;
    SELECT bool_or(j.branch_kind = 'idea' OR j.refinery_id IS NOT NULL),
           (array_agg(j.refinery_id ORDER BY (j.id = p_job) DESC) FILTER (WHERE j.refinery_id IS NOT NULL))[1]
      INTO v_hit, v_idea
      FROM public.research_jobs j WHERE j.id = ANY(v_jobs);
    IF v_idea IS NULL THEN
        SELECT r.idea_id INTO v_idea FROM public.idea_revisions r
         WHERE lower(r.research_job_id) = ANY(SELECT x::text FROM unnest(v_jobs) x)
         ORDER BY r.created_at DESC LIMIT 1;
        v_hit := coalesce(v_hit, false) OR FOUND;
    END IF;
    IF NOT coalesce(v_hit, false) THEN RETURN; END IF;
    idea_id := v_idea;
    owner_sub := (SELECT NULLIF(i.owner_sub, '') FROM public.ideas i WHERE i.id = v_idea);
    RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.research_job_report_owner(UUID) IS
    'rw-report-isolation: no row = not an idea job (its report is shared); a row = an idea job, its report private to owner_sub (NULL: to nobody)';
REVOKE ALL ON FUNCTION public.research_job_report_owner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.research_job_report_owner(UUID) TO service_role;

-- ── the move ────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_batch   UUID := gen_random_uuid();
    v_ids     UUID[];
    v_shared  INT;
    v_n       BIGINT;
    v_total   BIGINT := 0;
    r         RECORD;
    d         RECORD;
BEGIN
    -- every (synthesis, job) link the stack records: the job result's curator hand-off, the typed 'filed' event,
    -- the job's session; and every idea's dossier pointer (the idea's own report, whatever job filed it)
    CREATE TEMP TABLE _ri_links (source_id UUID, job_id UUID, idea_hit BOOLEAN, idea_id UUID, owner_sub TEXT, at TIMESTAMPTZ) ON COMMIT DROP;
    INSERT INTO _ri_links
    SELECT s.id, l.job_id, o.hit IS NOT NULL, o.idea_id, o.owner_sub, l.at
      FROM (SELECT j.id AS job_id, j.result -> 'curator' -> 'persist' ->> 'synthesis_id' AS sid, j.created_at AS at FROM public.research_jobs j
            UNION ALL
            SELECT e.job_id, e.payload ->> 'synthesis_id', e.created_at FROM public.research_job_events e WHERE e.type = 'filed'
            UNION ALL
            SELECT j.id, ss.source_id::text, j.created_at FROM public.research_jobs j JOIN public.session_sources ss ON ss.session_id = j.session_id) l
      JOIN public.sources s ON s.id = (CASE WHEN l.sid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN l.sid::uuid END)
                           AND s.content_type = 'research_synthesis'
      LEFT JOIN LATERAL (SELECT true AS hit, f.idea_id, f.owner_sub FROM public.research_job_report_owner(l.job_id) f) o ON true;
    INSERT INTO _ri_links
    SELECT s.id, NULL, true, i.id, NULLIF(i.owner_sub, ''), i.updated_at
      FROM public.ideas i JOIN public.sources s ON s.id = i.dossier_source_id AND s.content_type = 'research_synthesis';

    CREATE TEMP TABLE _ri_move ON COMMIT DROP AS
    SELECT DISTINCT ON (l.source_id) l.source_id, l.job_id, l.idea_id, l.owner_sub
      FROM _ri_links l
     WHERE l.idea_hit
       AND NOT EXISTS (SELECT 1 FROM _ri_links x WHERE x.source_id = l.source_id AND NOT x.idea_hit)
     ORDER BY l.source_id, (l.job_id IS NOT NULL) DESC, l.at DESC NULLS LAST;
    SELECT count(DISTINCT l.source_id) INTO v_shared FROM _ri_links l
     WHERE l.idea_hit AND EXISTS (SELECT 1 FROM _ri_links x WHERE x.source_id = l.source_id AND NOT x.idea_hit);
    SELECT array_agg(source_id) INTO v_ids FROM _ri_move;
    IF v_ids IS NULL THEN
        RAISE NOTICE 'rw-report-isolation: moved 0 idea-job syntheses (left shared, also filed by a non-idea job: %)', v_shared;
        RETURN;
    END IF;

    -- 1. archive the sources rows themselves
    INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
    SELECT v_batch, s.id, 'public.sources', 'id', 's', to_jsonb(s) FROM public.sources s WHERE s.id = ANY(v_ids);
    -- 2. archive every row that references them, through every foreign key the database declares on sources
    FOR r IN
        SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, con.confdeltype::text AS act
          FROM pg_constraint con
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
         WHERE con.contype = 'f' AND con.confrelid = 'public.sources'::regclass AND cardinality(con.conkey) = 1
    LOOP
        EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = ANY($1)', r.tbl, r.col) INTO v_n USING v_ids;
        IF v_n = 0 THEN CONTINUE; END IF;
        IF r.act NOT IN ('c', 'n', 'd') THEN
            RAISE EXCEPTION 'rw-report-isolation: % rows of % reference a moved synthesis through a foreign key that would refuse the delete (%); nothing moved', v_n, r.tbl, r.act;
        END IF;
        IF r.act = 'c' THEN
            -- a cascaded row must not take an un-archived row with it: no second-level dependent may hold one
            FOR d IN
                SELECT c2.conrelid::regclass::text AS tbl2, a2.attname AS col2, ra.attname AS refcol
                  FROM pg_constraint c2
                  JOIN pg_attribute a2 ON a2.attrelid = c2.conrelid AND a2.attnum = c2.conkey[1]
                  JOIN pg_attribute ra ON ra.attrelid = c2.confrelid AND ra.attnum = c2.confkey[1]
                 WHERE c2.contype = 'f' AND c2.confrelid = r.tbl::regclass AND cardinality(c2.conkey) = 1
            LOOP
                EXECUTE format('SELECT count(*) FROM %s t2 WHERE t2.%I IN (SELECT t.%I FROM %s t WHERE t.%I = ANY($1))',
                               d.tbl2, d.col2, d.refcol, r.tbl, r.col) INTO v_n USING v_ids;
                IF v_n > 0 THEN
                    RAISE EXCEPTION 'rw-report-isolation: % rows of % hang off % rows the move would cascade; nothing moved', v_n, d.tbl2, r.tbl;
                END IF;
            END LOOP;
        END IF;
        EXECUTE format('INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
                        SELECT $1, t.%I, %L, %L, %L, to_jsonb(t) FROM %s t WHERE t.%I = ANY($2)', r.col, r.tbl, r.col, r.act, r.tbl, r.col)
            USING v_batch, v_ids;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_total := v_total + v_n;
    END LOOP;
    -- 3. archive the moved reports' wiki leaf rows (no foreign key: keyed by slug)
    INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
    SELECT v_batch, m.source_id, 'public.wiki_pages', 'slug', 'w', to_jsonb(w)
      FROM _ri_move m JOIN public.wiki_pages w ON w.slug = 'content/source/' || m.source_id::text;

    -- 4. the private copies (owner-readable through the idea), and their claims' link back
    INSERT INTO public.research_private_reports
        (research_key, owner_sub, idea_id, job_id, title, content, claim, research_query, run_kind, volatility,
         revalidate_days, researched_on, metadata, migrated_source_id, created_at, updated_at)
    SELECT coalesce(s.research_key, 'migrated:' || s.id::text), m.owner_sub, m.idea_id, m.job_id, coalesce(s.title, ''),
           coalesce(s.content, ''), s.metadata ->> 'claim', s.research_query, s.run_kind, s.volatility, s.revalidate_days,
           s.researched_on, coalesce(s.metadata, '{}'::jsonb), s.id, s.created_at, now()
      FROM _ri_move m JOIN public.sources s ON s.id = m.source_id
    ON CONFLICT DO NOTHING;
    INSERT INTO public.research_private_report_claims (report_id, claim_id)
    SELECT p.id, c.id FROM public.claims c JOIN public.research_private_reports p ON p.migrated_source_id = c.synthesis_id
     WHERE c.synthesis_id = ANY(v_ids)
    ON CONFLICT DO NOTHING;

    -- 5. out of the shared knowledge: the leaf rows, then the rows (the foreign keys cascade / set NULL as declared)
    DELETE FROM public.wiki_pages w USING _ri_move m WHERE w.slug = 'content/source/' || m.source_id::text;
    DELETE FROM public.sources s WHERE s.id = ANY(v_ids);
    RAISE NOTICE 'rw-report-isolation: moved % idea-job syntheses (% dependent rows archived; left shared, also filed by a non-idea job: %)',
        cardinality(v_ids), v_total, v_shared;
END $$;

NOTIFY pgrst, 'reload schema';
