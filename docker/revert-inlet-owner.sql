-- Revert init-inlet-owner.sql (rw-inlet-owner, slot 440).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-inlet-owner.sql
-- Run it only with the images that do not read the private stores back in place (openbrain-mcp, the workbench, the
-- wiki compile, the gmail prune), and the withheld pages' vault files moved BACK into the vault first (else the
-- writer's orphan handling could drop restored rows); restart the wiki viewer after. Order: revert 440, then 430, 390, 380.
--   Every archived batch not yet restored goes back, the newest first, with triggers off (session_replication_role =
--   replica: nothing is re-fingerprinted, re-queued, re-judged or touched): the moved sources, the private claims and
--   every row the deletes cascaded; every column set NULL (only where still NULL); every whole-row image (the shared
--   claims that lost a link, the sources / chunks / claims a Gmail id or URL was stripped from); the jobs' options and
--   result; the thoughts' owner (only where still the stamp); the entities' updated_at (only where still the bump);
--   the withheld wiki pages (a page the compile rebuilt since is kept, and counted). A batch whose sources, claims or
--   pages do not all come back, or whose restored rows name a parent that is gone, stops the revert: nothing restored.
--   Then the private copies of what came back are removed, and the guard, the owner's read functions and the owner
--   scope of match_thoughts go (match_thoughts is the definition the first run found). The tables and the archive are
--   kept (a second run finds nothing to restore; init again starts a new batch).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    v_batch    UUID;
    v_cols     TEXT;
    v_set      TEXT;
    v_pk       TEXT;
    v_n        BIGINT;
    v_want     BIGINT;
    v_restored BIGINT := 0;
    v_kept     BIGINT := 0;
    v_batches  INT := 0;
    v_owner    TEXT;
    r          RECORD;
    f          RECORD;
BEGIN
    IF to_regclass('public.inlet_owner_archive') IS NULL THEN
        RAISE NOTICE 'inlet owner revert: no archive (slot 410 never ran) - nothing to restore';
        RETURN;
    END IF;
    SELECT owner_sub INTO v_owner FROM public.inlet_owner WHERE singleton;
    FOR v_batch IN
        SELECT a.batch FROM public.inlet_owner_archive a WHERE a.restored_at IS NULL
         GROUP BY a.batch ORDER BY min(a.id) DESC
    LOOP
        v_batches := v_batches + 1;
        PERFORM set_config('session_replication_role', 'replica', true);
        FOR r IN
            SELECT a.tbl, a.col, a.action, count(*) AS n FROM public.inlet_owner_archive a WHERE a.batch = v_batch
             GROUP BY a.tbl, a.col, a.action
             ORDER BY CASE a.action WHEN 's' THEN 0 WHEN 'k' THEN 1 WHEN 'c' THEN 2 WHEN 'p' THEN 2 WHEN 'n' THEN 3 WHEN 'd' THEN 3
                                    WHEN 'm' THEN 4 WHEN 'j' THEN 5 WHEN 'o' THEN 6 WHEN 'u' THEN 7 WHEN 'w' THEN 8 ELSE 9 END, a.tbl
        LOOP
            IF to_regclass(r.tbl) IS NULL THEN
                RAISE EXCEPTION 'inlet owner revert: table % is gone; nothing restored', r.tbl;
            END IF;
            SELECT string_agg(format('t.%1$I = x.%1$I', at.attname), ' AND ') INTO v_pk
              FROM pg_index i JOIN pg_attribute at ON at.attrelid = i.indrelid AND at.attnum = ANY(i.indkey)
             WHERE i.indrelid = r.tbl::regclass AND i.indisprimary;
            IF r.action IN ('s', 'k', 'c', 'p', 'w') THEN   -- (round 5: 'p' a row that hung on a seeded tree's job, moved private)
                -- whole rows back (generated columns recompute)
                SELECT string_agg(quote_ident(at.attname), ', ' ORDER BY at.attnum) INTO v_cols
                  FROM pg_attribute at
                 WHERE at.attrelid = r.tbl::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attgenerated = '';
                EXECUTE format('INSERT INTO %s (%s) OVERRIDING SYSTEM VALUE
                                SELECT %s FROM public.inlet_owner_archive a, jsonb_populate_record(NULL::%s, a.row_data) x
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.col = $3 AND a.action = $4
                                ON CONFLICT DO NOTHING',
                               r.tbl, v_cols, regexp_replace(v_cols, '([^, ]+)', 'x.\1', 'g'), r.tbl)
                    USING v_batch, r.tbl, r.col, r.action;
                GET DIAGNOSTICS v_n = ROW_COUNT;
                IF r.action = 'w' THEN
                    v_kept := v_kept + (r.n - v_n);      -- a page the compile rebuilt clean since: kept
                ELSIF v_n <> r.n THEN
                    -- a moved source / claim / cascaded row that cannot come back (its key taken since): refuse
                    RAISE EXCEPTION 'inlet owner revert: % of % archived % row(s) of % could be written back (a key was taken since); nothing restored',
                        v_n, r.n, r.action, r.tbl;
                END IF;
            ELSIF r.action IN ('n', 'd') THEN
                IF v_pk IS NULL THEN
                    RAISE EXCEPTION 'inlet owner revert: % has no primary key to re-point %; nothing restored', r.tbl, r.col;
                END IF;
                EXECUTE format('UPDATE %s t SET %I = a.ref::uuid
                                  FROM public.inlet_owner_archive a, jsonb_populate_record(NULL::%s, a.row_data) x
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.col = $3 AND a.action = $4 AND %s
                                   AND (t.%I IS NULL OR $4 = ''d'')',
                               r.tbl, r.col, r.tbl, v_pk, r.col)
                    USING v_batch, r.tbl, r.col, r.action;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            ELSIF r.action = 'm' THEN
                -- a whole-row image of a shared row this file changed: every column back
                IF v_pk IS NULL THEN
                    RAISE EXCEPTION 'inlet owner revert: % has no primary key to restore a row image; nothing restored', r.tbl;
                END IF;
                SELECT string_agg(format('%1$I = x.%1$I', at.attname), ', ' ORDER BY at.attnum) INTO v_set
                  FROM pg_attribute at
                 WHERE at.attrelid = r.tbl::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attgenerated = '';
                EXECUTE format('UPDATE %s t SET %s
                                  FROM public.inlet_owner_archive a, jsonb_populate_record(NULL::%s, a.row_data) x
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.action = ''m'' AND %s',
                               r.tbl, v_set, r.tbl, v_pk)
                    USING v_batch, r.tbl;
                GET DIAGNOSTICS v_n = ROW_COUNT;
                IF v_n <> r.n THEN
                    RAISE EXCEPTION 'inlet owner revert: % of % row image(s) of % found their row; nothing restored', v_n, r.n, r.tbl;
                END IF;
            ELSIF r.action = 'j' THEN
                UPDATE public.research_jobs j
                   SET options = CASE WHEN jsonb_typeof(a.row_data -> 'options') = 'null' THEN NULL ELSE a.row_data -> 'options' END,
                       result  = CASE WHEN jsonb_typeof(a.row_data -> 'result') = 'null' THEN NULL ELSE a.row_data -> 'result' END,
                       -- round 2: the question, anchor, topic and tree report (a round-1 archive row has none: kept as is)
                       query = CASE WHEN a.row_data ? 'query' THEN a.row_data ->> 'query' ELSE j.query END,
                       anchor = CASE WHEN a.row_data ? 'anchor' THEN a.row_data ->> 'anchor' ELSE j.anchor END,
                       topic_estimate = CASE WHEN a.row_data ? 'topic_estimate' THEN a.row_data ->> 'topic_estimate' ELSE j.topic_estimate END,
                       tree_report = CASE WHEN NOT (a.row_data ? 'tree_report') THEN j.tree_report
                                          WHEN jsonb_typeof(a.row_data -> 'tree_report') = 'null' THEN NULL ELSE a.row_data -> 'tree_report' END,
                       -- round 3: the seeded trees' progress, error and gap reference
                       progress = CASE WHEN NOT (a.row_data ? 'progress') THEN j.progress
                                       WHEN jsonb_typeof(a.row_data -> 'progress') = 'null' THEN NULL ELSE a.row_data -> 'progress' END,
                       error = CASE WHEN a.row_data ? 'error' THEN a.row_data ->> 'error' ELSE j.error END,
                       gap_ref = CASE WHEN a.row_data ? 'gap_ref' THEN a.row_data ->> 'gap_ref' ELSE j.gap_ref END,
                       -- round 4: the metrics and the inlet reference
                       metrics = CASE WHEN NOT (a.row_data ? 'metrics') THEN j.metrics
                                      WHEN jsonb_typeof(a.row_data -> 'metrics') = 'null' THEN NULL ELSE a.row_data -> 'metrics' END,
                       inlet_ref = CASE WHEN NOT (a.row_data ? 'inlet_ref') THEN j.inlet_ref
                                        WHEN jsonb_typeof(a.row_data -> 'inlet_ref') = 'null' THEN NULL ELSE a.row_data -> 'inlet_ref' END,
                       -- round 5: a seeded branch's rooted step id
                       rooted_step_id = CASE WHEN a.row_data ? 'rooted_step_id' THEN a.row_data ->> 'rooted_step_id' ELSE j.rooted_step_id END
                  FROM public.inlet_owner_archive a
                 WHERE a.batch = v_batch AND a.action = 'j' AND (a.row_data ->> 'id')::uuid = j.id;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            ELSIF r.action = 'o' THEN
                UPDATE public.thoughts t SET user_id = a.row_data ->> 'user_id'
                  FROM public.inlet_owner_archive a
                 WHERE a.batch = v_batch AND a.action = 'o' AND (a.row_data ->> 'id')::bigint = t.id
                   AND t.user_id IS NOT DISTINCT FROM v_owner;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            ELSIF r.action = 'u' THEN
                UPDATE public.entities e SET updated_at = (a.row_data ->> 'updated_at')::timestamptz
                  FROM public.inlet_owner_archive a
                 WHERE a.batch = v_batch AND a.action = 'u' AND a.ref = e.id::text
                   AND e.updated_at = (a.row_data ->> 'bumped_to')::timestamptz;
                GET DIAGNOSTICS v_n = ROW_COUNT;
            END IF;
            v_restored := v_restored + v_n;
        END LOOP;
        PERFORM set_config('session_replication_role', 'origin', true);

        -- every foreign key on every table this batch wrote must hold (triggers were off while writing)
        FOR f IN
            SELECT DISTINCT con.conrelid::regclass::text AS tbl, con.confrelid::regclass::text AS parent,
                   (SELECT string_agg(format('p.%I = t.%I', pa.attname, ca.attname), ' AND ')
                      FROM unnest(con.conkey, con.confkey) k(c, p)
                      JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.c
                      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.p) AS on_clause,
                   (SELECT string_agg(format('t.%I IS NOT NULL', ca.attname), ' AND ')
                      FROM unnest(con.conkey) k(c) JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.c) AS not_null
              FROM pg_constraint con
             WHERE con.contype = 'f'
               AND con.conrelid IN (SELECT DISTINCT to_regclass(a.tbl) FROM public.inlet_owner_archive a WHERE a.batch = v_batch)
        LOOP
            EXECUTE format('SELECT count(*) FROM %s t WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
                           f.tbl, f.not_null, f.parent, f.on_clause) INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'inlet owner revert: % row(s) of % name a % row that no longer exists; nothing restored', v_n, f.tbl, f.parent;
            END IF;
        END LOOP;

        -- the private copies of what came back, and the withheld text the guard kept for this batch's pages
        IF to_regclass('public.inlet_owner_withheld_chunks') IS NOT NULL THEN
            DELETE FROM public.inlet_owner_withheld_chunks c USING public.inlet_owner_archive a WHERE a.batch = v_batch AND a.action = 'w' AND c.page_ref = a.id;
            DELETE FROM public.inlet_owner_withheld_pages p USING public.inlet_owner_archive a WHERE a.batch = v_batch AND a.action = 'w' AND p.page_ref = a.id;
        END IF;
        DELETE FROM public.inlet_private_claim_links WHERE batch = v_batch;
        IF to_regclass('public.inlet_private_rows') IS NOT NULL THEN
            DELETE FROM public.inlet_private_rows WHERE batch = v_batch;
            DELETE FROM public.inlet_private_claim_sources WHERE batch = v_batch;
        END IF;
        IF to_regclass('public.inlet_private_jobs') IS NOT NULL THEN
            DELETE FROM public.inlet_private_jobs WHERE batch = v_batch;
            DELETE FROM public.inlet_private_job_events WHERE batch = v_batch;
        END IF;
        DELETE FROM public.inlet_private_source_chunks WHERE inlet_batch = v_batch;
        DELETE FROM public.inlet_private_claims WHERE inlet_batch = v_batch;
        DELETE FROM public.inlet_private_sources WHERE inlet_batch = v_batch;
        UPDATE public.inlet_owner_archive a SET restored_at = now() WHERE a.batch = v_batch;
    END LOOP;
    IF v_batches = 0 THEN
        RAISE NOTICE 'inlet owner revert: no batch to restore - nothing to restore';
    ELSE
        RAISE NOTICE 'inlet owner revert: % batch(es) restored, % row(s) written back, % withheld page(s) kept (rebuilt since)', v_batches, v_restored, v_kept;
    END IF;
END $$;
SET LOCAL client_min_messages = warning;
DROP TRIGGER IF EXISTS trg_inlet_owner_wiki_guard ON public.wiki_pages;
DROP FUNCTION IF EXISTS public.trg_inlet_owner_wiki_guard();
DROP FUNCTION IF EXISTS public.inlet_owner_page_private(TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.inlet_owner_page_links_private(TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.inlet_owner_text_withheld(TEXT);
DROP FUNCTION IF EXISTS public.inlet_owner_linked_source_ids(TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.inlet_owner_norm(TEXT);
DROP FUNCTION IF EXISTS public.inlet_private_source(UUID, TEXT);
DROP FUNCTION IF EXISTS public.inlet_private_job(UUID, TEXT);
DROP FUNCTION IF EXISTS public.inlet_owner_default();
-- the prune's view and its role (the gmail prune then deletes nothing until 440 runs again)
DROP VIEW IF EXISTS public.inlet_owner_mail;
DO $$
BEGIN
    IF to_regclass('public.inlet_owner') IS NOT NULL THEN
        DROP POLICY IF EXISTS inlet_owner_view_read ON public.inlet_owner;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_inlet_owner_view') THEN
        IF to_regclass('public.inlet_owner') IS NOT NULL THEN
            REVOKE ALL ON public.inlet_owner FROM ob_inlet_owner_view;
        END IF;
        -- (round 5: a role is cluster-wide; when ANOTHER database of the cluster still holds 440's view or grants - a lab
        -- clones one database into several - the role stays, with nothing left of it in this one)
        IF NOT EXISTS (SELECT 1 FROM pg_shdepend d JOIN pg_database x ON x.oid = d.dbid
                        WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'ob_inlet_owner_view')
                          AND x.datname <> current_database()) THEN
            REVOKE service_role FROM ob_inlet_owner_view;
            DROP ROLE ob_inlet_owner_view;
        END IF;
    END IF;
END $$;
-- match_thoughts as the first run found it
DO $$
DECLARE v_def TEXT;
BEGIN
    IF to_regclass('public.inlet_owner_prior') IS NOT NULL THEN
        SELECT def INTO v_def FROM public.inlet_owner_prior WHERE name = 'match_thoughts';
        IF v_def IS NOT NULL THEN EXECUTE v_def; END IF;
    END IF;
END $$;
COMMIT;
NOTIFY pgrst, 'reload schema';
