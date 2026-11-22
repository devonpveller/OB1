-- ============================================================
-- The stored wiki rows that already carry withheld text are withheld (research-workbench rw-withheld-text-rescan).
-- A one-off operator step after slot 440 (init-inlet-owner.sql); no initdb slot (a fresh volume has no withheld text:
-- the rule answers false for every row, so there is nothing for a chain slot to do).
--
-- Why: 440's move scanned every page by its LINKS only ("the text rule ... is for the guard, which sees one write at a
-- time"), so a row written before the guard's text rule existed, whose body is a withheld page's text come back, was
-- never withheld (found 2026-11-21: 2 of 318 note rows; entity and source rows were never scanned).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f rescan-withheld-text.sql [-v chunk=500]
--
-- What one run does, and ONLY this:
--   * every wiki_pages row, in slug order, in chunks of :chunk rows (default 500), each chunk its own transaction:
--     the rows are locked (FOR UPDATE), the EXISTING text rule public.inlet_owner_text_withheld(body) - unchanged, no
--     new matching - is asked of each, and each row it answers true for is withheld EXACTLY as 440's step 6 withholds:
--     archived first into public.inlet_owner_archive (action 'w', ref = slug, ref_hash = md5(body), row_data =
--     to_jsonb(row)), then the row leaves wiki_pages only where it is still byte-for-byte the archived image. No row is
--     lost: the archive keeps it, and revert-withheld-text-rescan.sql (or 440's own revert) puts it back.
--   * what 440's step 6 also does and this does NOT: add the withheld text to the guard's chunk store (the row's text
--     already matches a stored page - that is why it was flagged - so the guard already refuses it coming back; adding
--     it would widen what the rule matches, the very thing this item may not change) and bump entities (the recompile
--     concern, out of scope).
--   * progress is recorded per chunk (public.inlet_owner_rescan_runs / _chunks): an interrupted run (Ctrl-C, a killed
--     backend, a refusal) keeps every committed chunk, and the next run CONTINUES that run from its cursor - no row is
--     scanned twice. A run that finished leaves nothing open: running again starts a new run, which on a clean
--     database withholds nothing.
--   * output: counts and md5(slug) prefixes only - never a title, body or slug.
-- Rows written or changed while the scan runs are the guard's (trg_inlet_owner_wiki_guard asks the same rule of every
-- INSERT and every UPDATE OF slug/title/body/links), so a row behind the cursor is covered by it.
-- Before: stop (do not pause) the wiki compile and the viewer's reconcile, as for 440. After: move the withheld rows'
-- vault files out and restart the viewer (440's deploy step), else a reconcile retries them (a note is refused out loud).
-- Live size (2026-11-21, count-withheld-text.sql): 67,864 rows, ~250 MB of body, 38 flagged (3 entity, 2 note, 33 source);
-- the rule over every row took 20 min 48 s read-only, so expect about 21 min plus the writes. A chunk holds its rows'
-- locks while the rule reads them (seconds for a chunk of long sources): run it with the writers stopped.
-- ============================================================
\set ON_ERROR_STOP on
\if :{?chunk}
\else
\set chunk 500
\endif
-- lab only: a pause per chunk (ms), so a lab can kill the run between and inside chunks; 0 in an operator run
\if :{?pause_ms}
\else
\set pause_ms 0
\endif
-- lab only: stop (cleanly) after this many chunks; 0 = no limit
\if :{?max_chunks}
\else
\set max_chunks 0
\endif
SET client_min_messages = notice;
SET lock_timeout = '10s';
SELECT set_config('rescan.chunk', :'chunk', false) AS chunk_set,
       set_config('rescan.pause_ms', :'pause_ms', false) AS pause_set,
       set_config('rescan.max_chunks', :'max_chunks', false) AS max_set \gset

-- one scan at a time (a session lock: it goes with the connection, a killed run frees it)
SELECT pg_try_advisory_lock(hashtext('rw-withheld-text-rescan')) AS got_lock \gset
\if :got_lock
\else
\echo 'withheld-text rescan: refused - another rescan holds the lock; nothing changed'
\quit 3
\endif

DO $$
BEGIN
    IF to_regprocedure('public.inlet_owner_text_withheld(text)') IS NULL OR to_regclass('public.inlet_owner_archive') IS NULL THEN
        RAISE EXCEPTION 'withheld-text rescan: slot 440 (init-inlet-owner.sql) must be applied first; nothing changed' USING ERRCODE = '55000';
    END IF;
END $$;

-- -- the progress stores (readable by no app role, as 440's) ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inlet_owner_rescan_runs (
    batch       UUID PRIMARY KEY,            -- the inlet_owner_archive batch this run's withheld rows are in
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cursor_slug TEXT,                        -- the last slug a committed chunk scanned (NULL: none yet)
    n_scanned   BIGINT NOT NULL DEFAULT 0,
    n_withheld  BIGINT NOT NULL DEFAULT 0,
    n_chunks    INT NOT NULL DEFAULT 0,
    finished_at TIMESTAMPTZ,
    reverted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS public.inlet_owner_rescan_chunks (
    batch      UUID NOT NULL REFERENCES public.inlet_owner_rescan_runs (batch),
    chunk_no   INT NOT NULL,
    first_slug TEXT NOT NULL,
    last_slug  TEXT NOT NULL,
    n_scanned  INT NOT NULL,
    n_withheld INT NOT NULL,
    done_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch, chunk_no)
);
DO $$
DECLARE t TEXT; r RECORD;
BEGIN
    FOREACH t IN ARRAY ARRAY['inlet_owner_rescan_runs', 'inlet_owner_rescan_chunks'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE cl.oid = ('public.' || t)::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner LOOP
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r.grantee);
        END LOOP;
    END LOOP;
END $$;
COMMENT ON TABLE public.inlet_owner_rescan_runs IS
  'rw-withheld-text-rescan: one row per scan of wiki_pages by 440''s text rule; its withheld rows are inlet_owner_archive batch = batch. Readable by no app role.';

-- -- the scan: one transaction per chunk (COMMIT inside DO: psql runs this outside a transaction block) --------------
DO $$
DECLARE
    v_batch   UUID;
    v_cursor  TEXT;
    v_chunk   INT := greatest(1, current_setting('rescan.chunk')::int);
    v_pause   INT := greatest(0, current_setting('rescan.pause_ms')::int);
    v_max     INT := greatest(0, current_setting('rescan.max_chunks')::int);
    v_no      INT;
    v_first   TEXT;
    v_last    TEXT;
    v_n       INT;
    v_flag    INT;
    v_gone    INT;
    v_done    INT := 0;
    v_resumed BOOLEAN := false;
BEGIN
    SELECT r.batch, r.cursor_slug, r.n_chunks INTO v_batch, v_cursor, v_no
      FROM public.inlet_owner_rescan_runs r WHERE r.finished_at IS NULL AND r.reverted_at IS NULL
     ORDER BY r.started_at DESC LIMIT 1;
    IF v_batch IS NULL THEN
        v_batch := gen_random_uuid();
        v_no := 0;
        INSERT INTO public.inlet_owner_rescan_runs (batch) VALUES (v_batch);
        RAISE NOTICE 'withheld-text rescan: new run % (chunk %)', left(v_batch::text, 8), v_chunk;
    ELSE
        v_resumed := true;
        RAISE NOTICE 'withheld-text rescan: continuing run % after % chunk(s) (cursor %)', left(v_batch::text, 8), v_no,
            coalesce(left(md5(v_cursor), 12), 'start');
    END IF;
    COMMIT;

    CREATE TEMP TABLE _rs_chunk (slug TEXT PRIMARY KEY, flagged BOOLEAN NOT NULL) ON COMMIT DELETE ROWS;
    LOOP
        -- the chunk: the next rows after the cursor, locked so nothing changes them between the rule and the delete;
        -- the rule is the existing one, asked of the row's body exactly as the guard asks it of a write
        INSERT INTO _rs_chunk (slug, flagged)
        SELECT w.slug, public.inlet_owner_text_withheld(w.body)
          FROM public.wiki_pages w
         WHERE v_cursor IS NULL OR w.slug > v_cursor
         ORDER BY w.slug LIMIT v_chunk
           FOR UPDATE;
        SELECT count(*), count(*) FILTER (WHERE flagged), min(slug), max(slug) INTO v_n, v_flag, v_first, v_last FROM _rs_chunk;
        EXIT WHEN v_n = 0;
        -- [archive-pages] (440's step 6, the same row image)
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, ref_hash, row_data)
        SELECT v_batch, 'public.wiki_pages', 'slug', 'w', w.slug, md5(coalesce(w.body, '')), to_jsonb(w)
          FROM public.wiki_pages w JOIN _rs_chunk c ON c.slug = w.slug AND c.flagged;
        -- [/archive-pages]
        WITH gone AS (
            DELETE FROM public.wiki_pages w
             USING public.inlet_owner_archive a, _rs_chunk c
             WHERE c.flagged AND c.slug = w.slug
               AND a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug AND a.restored_at IS NULL
               AND to_jsonb(w) = a.row_data
            RETURNING w.slug)
        SELECT count(*) INTO v_gone FROM gone;
        IF v_gone <> v_flag THEN
            RAISE EXCEPTION 'withheld-text rescan: refused at chunk % - % row(s) flagged, % archived and withheld; this chunk rolled back, % earlier chunk(s) kept (run again to continue)',
                v_no + 1, v_flag, v_gone, v_no USING ERRCODE = '55000';
        END IF;
        v_no := v_no + 1;
        INSERT INTO public.inlet_owner_rescan_chunks (batch, chunk_no, first_slug, last_slug, n_scanned, n_withheld)
        VALUES (v_batch, v_no, v_first, v_last, v_n, v_flag);
        UPDATE public.inlet_owner_rescan_runs
           SET cursor_slug = v_last, n_scanned = n_scanned + v_n, n_withheld = n_withheld + v_flag, n_chunks = v_no
         WHERE batch = v_batch;
        IF v_pause > 0 THEN PERFORM pg_sleep(v_pause / 1000.0); END IF;
        COMMIT;
        v_cursor := v_last;
        v_done := v_done + 1;
        IF v_flag > 0 OR v_no % 20 = 0 THEN
            RAISE NOTICE 'withheld-text rescan: chunk % - % scanned, % withheld', v_no, v_n, v_flag;
        END IF;
        IF v_max > 0 AND v_done >= v_max THEN
            RAISE NOTICE 'withheld-text rescan: stopped after % chunk(s) this session (max_chunks); run again to continue', v_done;
            RETURN;
        END IF;
    END LOOP;

    UPDATE public.inlet_owner_rescan_runs SET finished_at = now() WHERE batch = v_batch;
    COMMIT;
    RAISE NOTICE 'withheld-text rescan: run % finished%: % chunk(s), % row(s) scanned, % withheld',
        left(v_batch::text, 8), CASE WHEN v_resumed THEN ' (continued)' ELSE '' END, v_no,
        (SELECT n_scanned FROM public.inlet_owner_rescan_runs WHERE batch = v_batch),
        (SELECT n_withheld FROM public.inlet_owner_rescan_runs WHERE batch = v_batch);
END $$;

-- the run's withheld rows: counts per class and the slugs' md5 prefixes (never text)
SELECT 'withheld' AS what, a.row_data ->> 'page_class' AS page_class, count(*) AS n,
       string_agg(left(md5(a.ref), 12), ' ' ORDER BY md5(a.ref)) AS slug_md5
  FROM public.inlet_owner_archive a
  JOIN public.inlet_owner_rescan_runs r ON r.batch = a.batch
 WHERE r.started_at = (SELECT max(started_at) FROM public.inlet_owner_rescan_runs) AND a.action = 'w' AND a.restored_at IS NULL
 GROUP BY 2 ORDER BY 2;
SELECT pg_advisory_unlock(hashtext('rw-withheld-text-rescan')) AS unlocked \gset
