-- ============================================================
-- An idea's research report is private to the idea's owner (research-workbench rw-report-isolation). Slot 390.
-- Operator 2026-11-02: "Ideas are completely user isolated. The shared knowledge are the sources and claims. This
-- is the only case where the final reports are user isolated rather than shared like other reports."
--
--   * research_job_report_owner(job): THE rule for "a research job run for an idea" - the job, or the root of its
--     tree, is the idea's branch (branch_kind 'idea'), carries the idea (refinery_id: the idea queue, the
--     idea-revision inlet trigger and a refinery started from a document write it) or is stamped on one of the idea's revisions
--     (idea_revisions.research_job_id). Never the job's text, and never inlet_ref (the caller names that). No row =
--     not an idea job; a row = an idea job, with the idea's current owner (NULL when the idea is gone: then nobody
--     reads the report - fail closed). openbrain-mcp's POST /research/persist and the research curator both ask it.
--   * research_private_reports: where an idea job's final report is filed INSTEAD of a shared `sources` row
--     (content_type research_synthesis). One per (research_key, owner, idea) - round 2, tester F1: two users whose
--     ideas read alike get the SAME research_key, so the key alone never names a private row; a re-run of the same
--     idea supersedes its own row in place, as the shared row did, and nothing else. Nothing
--     shared reads it: not sources / source_chunks / search / the wiki / any contract route - only the owner's
--     idea read in the workbench (owner_sub filter, as every per-user table in this plane: rooms, listings).
--   * research_private_report_claims: which claims were drawn from a private report - the owner's link back. The
--     claims themselves stay SHARED knowledge (claims.synthesis_id NULL: no shared row to point at, so following a
--     claim back yields nothing).
--   * THE MOVE: every existing idea-job synthesis still in `sources` is archived (the row, every row of every table
--     whose foreign key references it, and its wiki leaf page row) into research_report_isolation_archive, copied
--     into research_private_reports, its claims linked, and then deleted from `sources` (the foreign keys cascade or
--     set NULL exactly as they are declared). A synthesis that a NON-idea job also filed is left shared and counted.
--     The columns a foreign key would set NULL are set NULL by the move itself with triggers off, so their rows'
--     touch timestamps do not move (the revert is byte-identical). A dependent the move cannot archive (a foreign key
--     that would refuse the delete, or ANY row - single- or multi-column key - hanging off a row the delete cascades)
--     stops it with nothing moved. Counts only are printed (NOTICE), never content. A second run moves nothing.
--   * THE WIKI (round 2, tester F2): every wiki_pages row that shows a moved report - its leaf content/source/<id>,
--     a page linking that leaf (links, or [[content/source/<id>]] in its body) - is archived and withheld, and a guard
--     on wiki_pages (report_isolation_page_shows_report) keeps such a page from being written back: not by the
--     viewer's reconcile repairing a row from its vault file, not by a compile. The entities whose pages cited a moved
--     report are bumped (entities.updated_at), so the next compile regenerates those pages from what is still shared,
--     and the guard lets that clean page back in. The withheld pages' vault FILES are moved out of the vault by the
--     deploy step; until then the guard holds (the same mechanism as rw-idea-privacy's slot 380).
-- The archive is the superuser's alone (RLS on, no policy, no grant): it holds the reports' text.
-- Fresh-volume slot 390; live: psql -f BEFORE the new openbrain-mcp, research-curator, research and workbench images,
-- with a fresh backup. Revert: revert-report-isolation.sql (restores every archived row byte-identical; drops the
-- guard; keeps the tables).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.research_private_reports (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    research_key       TEXT NOT NULL,
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
-- round 2 (tester F1): the key alone is not unique - one private row per (key, owner, idea)
ALTER TABLE public.research_private_reports DROP CONSTRAINT IF EXISTS research_private_reports_research_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_private_reports_key_owner_idea
    ON public.research_private_reports (research_key, (coalesce(owner_sub, '')), (coalesce(idea_id::text, '')));
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

-- ── the wiki guard (round 2, tester F2) ─────────────────────────────────
-- ONE predicate decides "this page shows a moved report", for the move below and for the guard: the page IS a moved
-- report's leaf, or links it (links, or [[content/source/<id>]] in its body). "Moved" = the archive holds its sources
-- row in a batch the revert has not restored. A page that also holds shared content (an entity page citing the report
-- among others) is WITHHELD, not edited: the text was written around the citation and a textual cut cannot be proven
-- complete; the move bumps those entities, so the next compile regenerates the page and the guard lets it back.
-- (A new private report never has a leaf: it is not a source.)
CREATE OR REPLACE FUNCTION public.report_isolation_page_shows_report(p_slug TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.research_report_isolation_archive a
         WHERE a.action = 's' AND a.restored_at IS NULL
           AND (p_slug = 'content/source/' || a.source_id::text
                OR (jsonb_typeof(p_links) = 'array' AND p_links ? ('content/source/' || a.source_id::text))
                OR (position('content/source/' IN coalesce(p_body, '')) > 0
                    AND coalesce(p_body, '') ~ ('content/source/' || a.source_id::text || '([^0-9a-f-]|$)'))))
        -- round 3: a thread the report named - its old hub page, or a page linking it (the notebook index)
        OR EXISTS (
        SELECT 1 FROM public.research_report_isolation_archive t
         WHERE t.action = 't' AND t.restored_at IS NULL AND (t.row_data ->> '_minted')::boolean
           AND coalesce(t.row_data ->> 'slug', '') <> ''
           AND (p_slug LIKE 'notebooks/' || (t.row_data ->> 'slug') || '/%'
                OR (jsonb_typeof(p_links) = 'array' AND p_links ? ('notebooks/' || (t.row_data ->> 'slug') || '/' || (t.row_data ->> 'slug')))
                OR position('notebooks/' || (t.row_data ->> 'slug') || '/' IN coalesce(p_body, '')) > 0));
$$;
REVOKE ALL ON FUNCTION public.report_isolation_page_shows_report(TEXT, TEXT, JSONB) FROM PUBLIC;

-- a compiled or reconciled page is skipped silently (RETURN NULL: one row must not fail the compile's or the
-- reconcile's whole batch; the reconcile then reports the slug as drift); a NOTE is a person's own writing saved
-- through the workbench, so it is refused out loud
CREATE OR REPLACE FUNCTION public.trg_report_isolation_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.report_isolation_page_shows_report(NEW.slug, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cites an idea''s private research report' USING ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_report_isolation_wiki_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_report_isolation_wiki_guard ON public.wiki_pages;
CREATE TRIGGER trg_report_isolation_wiki_guard BEFORE INSERT OR UPDATE ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_report_isolation_wiki_guard();

-- ── the move ────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_batch   UUID := gen_random_uuid();
    v_now     TIMESTAMPTZ := clock_timestamp();
    v_threads BIGINT;
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
    -- 1b. the private copies (BEFORE step 2 sets the claims' synthesis_id NULL) (owner-readable through the idea), and their claims' link back
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

    -- 2. archive every row that references them, through every foreign key the database declares on sources
    -- (sources' key is one column, so a multi-column foreign key onto it cannot exist; one would stop the move)
    IF EXISTS (SELECT 1 FROM pg_constraint con WHERE con.contype = 'f' AND con.confrelid = 'public.sources'::regclass
                                               AND cardinality(con.conkey) <> 1) THEN
        RAISE EXCEPTION 'rw-report-isolation: a multi-column foreign key references sources - not archived by this move; nothing moved';
    END IF;
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
            -- a cascaded row must not take an un-archived row with it: no second-level dependent may hold one,
            -- through ANY foreign key on the cascaded table - one column or several (round 2: fail closed)
            FOR d IN
                SELECT c2.conrelid::regclass::text AS tbl2,
                       (SELECT string_agg(format('t2.%I = t.%I', ca.attname, pa.attname), ' AND ')
                          FROM unnest(c2.conkey, c2.confkey) k(c, p)
                          JOIN pg_attribute ca ON ca.attrelid = c2.conrelid AND ca.attnum = k.c
                          JOIN pg_attribute pa ON pa.attrelid = c2.confrelid AND pa.attnum = k.p) AS on_clause
                  FROM pg_constraint c2
                 WHERE c2.contype = 'f' AND c2.confrelid = r.tbl::regclass
            LOOP
                EXECUTE format('SELECT count(*) FROM %s t2 WHERE EXISTS (SELECT 1 FROM %s t WHERE t.%I = ANY($1) AND %s)',
                               d.tbl2, r.tbl, r.col, d.on_clause) INTO v_n USING v_ids;
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
        IF r.act IN ('n', 'd') THEN
            -- the move sets the column itself, with triggers off: the foreign key's own SET NULL would fire the
            -- referencing table's touch trigger (claims / ideas updated_at), and the revert could not undo that
            PERFORM set_config('session_replication_role', 'replica', true);
            EXECUTE format('UPDATE %s t SET %I = %s WHERE t.%I = ANY($1)', r.tbl, r.col,
                           CASE r.act WHEN 'n' THEN 'NULL' ELSE 'DEFAULT' END, r.col) USING v_ids;
            PERFORM set_config('session_replication_role', 'origin', true);
        END IF;
    END LOOP;
    -- the entities the moved reports' extraction cited: bumped (their old updated_at archived), so the next compile
    -- regenerates their pages from what is still shared (the guard below lets a clean page back in)
    IF to_regclass('public.source_entities') IS NOT NULL AND to_regclass('public.entities') IS NOT NULL THEN
        INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
        SELECT DISTINCT ON (e.id) v_batch, se.source_id, 'public.entities', 'updated_at', 'u',
               jsonb_build_object('id', e.id, 'updated_at', e.updated_at, 'bumped_to', v_now)
          FROM public.source_entities se JOIN public.entities e ON e.id = se.entity_id
         WHERE se.source_id = ANY(v_ids)
         ORDER BY e.id, se.source_id;
        PERFORM set_config('session_replication_role', 'replica', true);
        UPDATE public.entities e SET updated_at = v_now
          FROM public.research_report_isolation_archive a
         WHERE a.batch = v_batch AND a.action = 'u' AND (a.row_data ->> 'id') = e.id::text;
        PERFORM set_config('session_replication_role', 'origin', true);
    END IF;
    -- 3. out of the shared knowledge: the rows (the foreign keys cascade as declared; the set-NULL columns are done)
    DELETE FROM public.sources s WHERE s.id = ANY(v_ids);

    -- 4. THE THREADS (round 3, tester attempt 2 finding A): the base's curator NAMED and DESCRIBED a new thread from the
    --    report (decision 'new': the resolver's name and description, or the report's first paragraph verbatim), and
    --    REWROTE an existing thread's description from it (refreshThread, every filing) - and the embedding with it. The
    --    threads are every thread an idea job of this move filed into (result -> curator -> thread_id) and every thread
    --    a moved report was linked into. Each is archived whole, then:
    --      minted ('new' by any of those jobs): a neutral name and slug, a description made only of its remaining SHARED
    --        sources' titles (none left: no description, and the thread is archived), no embedding; the shared sources
    --        whose notebook label was the old name are relabelled (else the notebook backfill re-creates the old name);
    --      existing: the same description from its remaining shared sources (the pre-report text is not recorded
    --        anywhere: no history table, and the job data holds only the thread id), no embedding.
    --    The embedding is re-made from the new text by the curator's backfill-thread-embeddings.ts (the deploy step).
    -- round 6 (the coordinator's stopping rule, after tester attempts 3-5 each found a minted thread a timing rule
    -- classed "existing"): EVERY thread tied to a moved idea job is treated as minted - renamed, re-slugged, its notebook
    -- labels relabelled, its hub page withheld, its description re-made from shared material. A genuinely shared thread
    -- an idea job merely filed into gets a neutral name too (the accepted cost). The ties are everything that links a
    -- moved synthesis to a thread: the curator answer of EVERY idea job linked to it (not only the move's one pick), the
    -- thread_id its jobs' typed 'filed' events carry, and every thread link (thread_sources) the move archived.
    CREATE TEMP TABLE _ri_ties ON COMMIT DROP AS
    SELECT DISTINCT t.id AS thread_id
      FROM (SELECT j.result -> 'curator' ->> 'thread_id' AS tid
              FROM public.research_jobs j
             WHERE j.id IN (SELECT l.job_id FROM _ri_links l WHERE l.idea_hit AND l.job_id IS NOT NULL AND l.source_id = ANY(v_ids))
            UNION ALL
            SELECT e.payload ->> 'thread_id' FROM public.research_job_events e
             WHERE e.type = 'filed'
               AND (e.job_id IN (SELECT l.job_id FROM _ri_links l WHERE l.idea_hit AND l.job_id IS NOT NULL AND l.source_id = ANY(v_ids))
                    OR e.payload ->> 'synthesis_id' IN (SELECT x::text FROM unnest(v_ids) x))
            UNION ALL
            SELECT a.row_data ->> 'thread_id' FROM public.research_report_isolation_archive a
             WHERE a.batch = v_batch AND to_regclass(a.tbl) = 'public.thread_sources'::regclass) x
      JOIN public.threads t ON t.id::text = x.tid;
    CREATE TEMP TABLE _ri_threads ON COMMIT DROP AS
    SELECT x.thread_id AS id, true AS minted FROM _ri_ties x;
    INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
    SELECT v_batch, v_ids[1], 'public.threads', 'id', 't', to_jsonb(t) || jsonb_build_object('_minted', rt.minted)
      FROM _ri_threads rt JOIN public.threads t ON t.id = rt.id;
    GET DIAGNOSTICS v_threads = ROW_COUNT;
    -- the shared sources' notebook labels (round 7, tester attempt 6 shape tR: a user renamed a minted notebook, so its
    -- web sources keep the FILING-time name, not the thread's current one). Relabelled by LINKAGE:
    --   * every name a tied thread ever carried that the stack recorded - each tied job's curator thread_name, and its
    --     name now (archived above) - labels a source that is relabelled wherever it is;
    --   * every source LINKED to a tied thread (thread_sources) or filed by a tied job (its sessions' sources) that carries
    --     ANY notebook label is relabelled, matched to a known name or not.
    CREATE TEMP TABLE _ri_tjobs ON COMMIT DROP AS
    SELECT DISTINCT t.id AS thread_id, y.job_id FROM (
        SELECT (j.result -> 'curator' ->> 'thread_id') AS tid, j.id AS job_id FROM public.research_jobs j
         WHERE j.id IN (SELECT l.job_id FROM _ri_links l WHERE l.idea_hit AND l.job_id IS NOT NULL AND l.source_id = ANY(v_ids))
        UNION ALL
        SELECT e.payload ->> 'thread_id', e.job_id FROM public.research_job_events e
         WHERE e.type = 'filed'
           AND (e.job_id IN (SELECT l.job_id FROM _ri_links l WHERE l.idea_hit AND l.job_id IS NOT NULL AND l.source_id = ANY(v_ids))
                OR e.payload ->> 'synthesis_id' IN (SELECT x::text FROM unnest(v_ids) x))) y
      JOIN public.threads t ON t.id::text = y.tid
     WHERE t.id IN (SELECT id FROM _ri_threads);
    CREATE TEMP TABLE _ri_names ON COMMIT DROP AS
    SELECT DISTINCT tj.thread_id, j.result -> 'curator' ->> 'thread_name' AS name
      FROM _ri_tjobs tj JOIN public.research_jobs j ON j.id = tj.job_id
     WHERE coalesce(j.result -> 'curator' ->> 'thread_name', '') <> ''
    UNION
    SELECT t.id, t.name FROM public.threads t WHERE t.id IN (SELECT id FROM _ri_threads);
    CREATE TEMP TABLE _ri_relabel ON COMMIT DROP AS
    SELECT DISTINCT ON (s.id) s.id AS source_id, x.thread_id
      FROM (SELECT ts.source_id, ts.thread_id FROM public.thread_sources ts WHERE ts.thread_id IN (SELECT id FROM _ri_threads)
            UNION ALL
            SELECT ss.source_id, tj.thread_id FROM _ri_tjobs tj
              JOIN public.research_job_events e ON e.job_id = tj.job_id AND e.type = 'filed'
              JOIN public.session_sources ss ON ss.session_id::text = e.payload ->> 'session_id'
            UNION ALL
            SELECT ss.source_id, tj.thread_id FROM _ri_tjobs tj
              JOIN public.research_jobs j ON j.id = tj.job_id
              JOIN public.session_sources ss ON ss.session_id = j.session_id
            UNION ALL
            SELECT s2.id, n.thread_id FROM _ri_names n JOIN public.sources s2 ON s2.notebook = n.name) x
      JOIN public.sources s ON s.id = x.source_id
     WHERE coalesce(s.notebook, '') <> ''
     ORDER BY s.id, x.thread_id;
    INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
    SELECT v_batch, v_ids[1], 'public.sources', 'notebook', 'b',
           jsonb_build_object('id', s.id, 'notebook', s.notebook, 'relabelled_to', 'Research thread ' || left(rl.thread_id::text, 8))
      FROM _ri_relabel rl JOIN public.sources s ON s.id = rl.source_id
     WHERE s.notebook IS DISTINCT FROM 'Research thread ' || left(rl.thread_id::text, 8);
    UPDATE public.threads t
       SET description = (SELECT 'Shared sources: ' || string_agg(x.title, '; ' ORDER BY x.title)
                            FROM (SELECT DISTINCT s.title FROM public.thread_sources ts JOIN public.sources s ON s.id = ts.source_id
                                   WHERE ts.thread_id = t.id AND s.retraction_committed_at IS NULL AND coalesce(s.title, '') <> ''
                                   ORDER BY s.title LIMIT 8) x),
           embedding = NULL,
           name = CASE WHEN rt.minted THEN 'Research thread ' || left(t.id::text, 8) ELSE t.name END,
           slug = CASE WHEN rt.minted AND t.slug IS NOT NULL THEN 'research-thread-' || left(t.id::text, 8) ELSE t.slug END,
           status = CASE WHEN rt.minted AND NOT EXISTS (SELECT 1 FROM public.thread_sources ts WHERE ts.thread_id = t.id)
                              AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.thread_id = t.id)
                         THEN 'archived' ELSE t.status END
      FROM _ri_threads rt WHERE rt.id = t.id;
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.sources s SET notebook = a.row_data ->> 'relabelled_to'
      FROM public.research_report_isolation_archive a
     WHERE a.batch = v_batch AND a.action = 'b' AND (a.row_data ->> 'id') = s.id::text;
    PERFORM set_config('session_replication_role', 'origin', true);
    -- fail closed, over EVERY thread in the tie set (round 6: the same set the move processed): each was archived, is
    -- minted, keeps neither its old name nor its old slug nor its archived description, has no embedding; and no shared
    -- source is still labelled with any of their old names
    SELECT count(*) INTO v_n FROM public.threads t JOIN public.research_report_isolation_archive a
        ON a.batch = v_batch AND a.action = 't' AND (a.row_data ->> 'id') = t.id::text
     WHERE ((a.row_data ->> '_minted')::boolean AND (t.name = a.row_data ->> 'name' OR t.slug IS NOT DISTINCT FROM NULLIF(a.row_data ->> 'slug', '') AND a.row_data ->> 'slug' IS NOT NULL))
        OR NOT (a.row_data ->> '_minted')::boolean
        OR (coalesce(a.row_data ->> 'description', '') <> '' AND t.description IS NOT DISTINCT FROM a.row_data ->> 'description')
        OR t.embedding IS NOT NULL;
    -- round 7: the same linkage set - no linked / labelled source keeps a label other than its thread's new name, and no
    -- source anywhere still carries a name a tied thread carried
    v_n := v_n + (SELECT count(*) FROM _ri_relabel rl JOIN public.sources s ON s.id = rl.source_id
                   WHERE s.notebook IS DISTINCT FROM 'Research thread ' || left(rl.thread_id::text, 8))
               + (SELECT count(*) FROM public.sources s JOIN _ri_names n ON s.notebook = n.name);
    IF v_threads <> (SELECT count(*) FROM _ri_threads) OR v_n <> 0 THEN
        RAISE EXCEPTION 'rw-report-isolation: % thread(s) the moved reports named or described, % archived, % still carry it; nothing moved',
            (SELECT count(*) FROM _ri_threads), v_threads, v_n;
    END IF;

    -- 5. every wiki page that shows a moved report (its leaf, a page linking it, a minted thread's old hub): archived
    --    and withheld - the predicate reads this batch's archive rows
    INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data)
    SELECT v_batch, v_ids[1], 'public.wiki_pages', 'slug', 'w', to_jsonb(w)
      FROM public.wiki_pages w WHERE public.report_isolation_page_shows_report(w.slug, w.body, w.links);
    DELETE FROM public.wiki_pages w USING public.research_report_isolation_archive a
     WHERE a.batch = v_batch AND a.action = 'w' AND a.row_data ->> 'slug' = w.slug;
    IF EXISTS (SELECT 1 FROM public.wiki_pages w WHERE public.report_isolation_page_shows_report(w.slug, w.body, w.links)) THEN
        RAISE EXCEPTION 'rw-report-isolation: a wiki page still shows a moved report; nothing moved';
    END IF;
    RAISE NOTICE 'rw-report-isolation: moved % idea-job syntheses (% dependent rows archived; left shared, also filed by a non-idea job: %); % thread(s) re-described (% minted from a report)',
        cardinality(v_ids), v_total, v_shared, v_threads, (SELECT count(*) FROM _ri_threads WHERE minted);
END $$;

NOTIFY pgrst, 'reload schema';
