-- Revert init-report-isolation.sql (rw-report-isolation, slot 390).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-report-isolation.sql
-- Run it only after the openbrain-mcp and research-curator images without the private filing are back in place.
--   1. Every archived batch not yet restored goes back as it was: the sources rows, then every row the move's
--      cascade deleted, then every column it set NULL (only where it is still NULL), then the wiki leaf rows. The
--      rows are written with triggers off (session_replication_role = replica) so they come back exactly, and then
--      every foreign key on every restored table is checked: a row whose parent is gone stops the revert (nothing
--      is restored half-way).
--   2. The private copies of the restored rows are removed (a copy a later filing superseded is kept: it holds a
--      newer report the archive does not).
--   3. research_job_report_owner() and the wiki guard (trg_report_isolation_wiki_guard) are dropped; an entity the
--      move bumped gets its old updated_at back (only where nothing touched it since).
--   (3.) The tables and the archive are KEPT: nothing reads them once the
--      old images are back, and a report filed privately after 390 is not thrown away (fail closed).
-- Runs twice cleanly (a second run finds no batch to restore).
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
    v_batch    UUID;
    v_ids      UUID[];
    v_cols     TEXT;
    v_pk       TEXT;
    v_n        BIGINT;
    v_restored BIGINT := 0;
    v_batches  INT := 0;
    r          RECORD;
    f          RECORD;
BEGIN
    IF to_regclass('public.research_report_isolation_archive') IS NULL THEN
        RAISE NOTICE 'rw-report-isolation revert: no archive (slot 390 never ran) - nothing to restore';
        RETURN;
    END IF;
    FOR v_batch IN
        SELECT a.batch FROM public.research_report_isolation_archive a WHERE a.restored_at IS NULL
         GROUP BY a.batch ORDER BY min(a.id)
    LOOP
        v_batches := v_batches + 1;
        SELECT array_agg(DISTINCT a.source_id) INTO v_ids FROM public.research_report_isolation_archive a WHERE a.batch = v_batch;
        PERFORM set_config('session_replication_role', 'replica', true);
        -- parents first (the sources rows), then the cascaded rows, then the set-NULL columns, then the wiki rows
        FOR r IN
            SELECT a.tbl, a.col, a.action FROM public.research_report_isolation_archive a WHERE a.batch = v_batch
             GROUP BY a.tbl, a.col, a.action
             ORDER BY CASE a.action WHEN 's' THEN 0 WHEN 'c' THEN 1 WHEN 'n' THEN 2 WHEN 'd' THEN 2 WHEN 'w' THEN 3 ELSE 4 END, a.tbl
        LOOP
            IF to_regclass(r.tbl) IS NULL THEN
                RAISE EXCEPTION 'rw-report-isolation revert: table % is gone; nothing restored', r.tbl;
            END IF;
            IF r.action = 'u' THEN
                -- an entity the move bumped (so its page recompiled): its old updated_at, unless something touched it since
                EXECUTE format('UPDATE %s t SET %I = (a.row_data ->> %L)::timestamptz
                                  FROM public.research_report_isolation_archive a
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.col = $3 AND a.action = ''u''
                                   AND t.id::text = a.row_data ->> ''id''
                                   AND t.%I = (a.row_data ->> ''bumped_to'')::timestamptz',
                               r.tbl, r.col, r.col, r.col)
                    USING v_batch, r.tbl, r.col;
            ELSIF r.action IN ('s', 'c', 'w') THEN
                SELECT string_agg(quote_ident(at.attname), ', ' ORDER BY at.attnum) INTO v_cols
                  FROM pg_attribute at
                 WHERE at.attrelid = r.tbl::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attgenerated = '';
                EXECUTE format('INSERT INTO %s (%s) OVERRIDING SYSTEM VALUE
                                SELECT %s FROM public.research_report_isolation_archive a, jsonb_populate_record(NULL::%s, a.row_data) x
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.col = $3 AND a.action = $4
                                ON CONFLICT DO NOTHING',
                               r.tbl, v_cols, regexp_replace(v_cols, '([^, ]+)', 'x.\1', 'g'), r.tbl)
                    USING v_batch, r.tbl, r.col, r.action;
            ELSE
                -- a column the move's delete set NULL (or to its default): point it back, only where nothing re-pointed it since
                SELECT string_agg(format('t.%1$I = x.%1$I', at.attname), ' AND ') INTO v_pk
                  FROM pg_index i JOIN pg_attribute at ON at.attrelid = i.indrelid AND at.attnum = ANY(i.indkey)
                 WHERE i.indrelid = r.tbl::regclass AND i.indisprimary;
                IF v_pk IS NULL THEN
                    RAISE EXCEPTION 'rw-report-isolation revert: % has no primary key to re-point %; nothing restored', r.tbl, r.col;
                END IF;
                EXECUTE format('UPDATE %s t SET %I = a.source_id
                                  FROM public.research_report_isolation_archive a, jsonb_populate_record(NULL::%s, a.row_data) x
                                 WHERE a.batch = $1 AND a.tbl = $2 AND a.col = $3 AND a.action = $4 AND %s
                                   AND t.%I IS DISTINCT FROM a.source_id
                                   AND (t.%I IS NULL OR %L = ''d'')',
                               r.tbl, r.col, r.tbl, v_pk, r.col, r.col, r.action)
                    USING v_batch, r.tbl, r.col, r.action;
            END IF;
            GET DIAGNOSTICS v_n = ROW_COUNT;
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
               AND con.conrelid IN (SELECT DISTINCT a.tbl::regclass FROM public.research_report_isolation_archive a WHERE a.batch = v_batch)
        LOOP
            EXECUTE format('SELECT count(*) FROM %s t WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
                           f.tbl, f.not_null, f.parent, f.on_clause) INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'rw-report-isolation revert: % rows of % name a % row that no longer exists; nothing restored', v_n, f.tbl, f.parent;
            END IF;
        END LOOP;

        -- the private copies of what came back (a superseded copy has migrated_source_id NULL and stays)
        DELETE FROM public.research_private_reports p WHERE p.migrated_source_id = ANY(v_ids);
        UPDATE public.research_report_isolation_archive a SET restored_at = now() WHERE a.batch = v_batch;
    END LOOP;
    RAISE NOTICE 'rw-report-isolation revert: % batch(es) restored, % rows written back', v_batches, v_restored;
END $$;
DROP TRIGGER IF EXISTS trg_report_isolation_wiki_guard ON public.wiki_pages;
DROP FUNCTION IF EXISTS public.trg_report_isolation_wiki_guard();
DROP FUNCTION IF EXISTS public.report_isolation_page_shows_report(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.research_job_report_owner(UUID);
COMMIT;
NOTIFY pgrst, 'reload schema';
