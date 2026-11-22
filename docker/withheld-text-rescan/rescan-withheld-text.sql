-- ============================================================
-- The stored wiki rows that already carry withheld text are withheld (research-workbench rw-withheld-text-rescan).
-- A one-off operator step after slot 440 (init-inlet-owner.sql); no initdb slot (a fresh volume has no withheld text:
-- the rule answers false for every row, so there is nothing for a chain slot to do).
--
-- Why: 440's move scanned every page by its LINKS only ("the text rule ... is for the guard, which sees one write at a
-- time"), so a row written before the guard's text rule existed, whose body is a withheld page's text come back, was
-- never withheld (found 2026-11-21: 2 of 318 note rows; entity and source rows were never scanned).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f rescan-withheld-text.sql [-v chunk=100]
--
-- What one run does, and ONLY this:
--   * every wiki_pages row, in slug order, in chunks of :chunk rows (default 100), each chunk its own transaction:
--     the EXISTING text rule public.inlet_owner_text_withheld(body) - unchanged, no new matching - is asked of each
--     row, and the row image it was asked of is kept for each row it answers true for; each such row is withheld
--     EXACTLY as 440's step 6 withholds: archived first into public.inlet_owner_archive (action 'w', ref = slug,
--     ref_hash = md5(body), row_data = to_jsonb(row), the image the rule judged), then the row leaves wiki_pages only
--     where it is still byte-for-byte that image (a row changed since is not withheld: the chunk is refused and rolled
--     back, run again). No row is lost: the archive keeps it, and revert-withheld-text-rescan.sql (or 440's own
--     revert) puts it back.
--   * row locks: the rule runs WITHOUT a lock (it costs a store lookup per 8-word window: about 0.5 s for one 470k-char
--     body against a live-sized store in the lab, and a chunk holding long sources costs the sum); only the DELETE of
--     the chunk's flagged rows locks rows, those rows only, until the chunk commits (12 ms at most in the lab; the
--     finish notice prints the run's longest hold, so the live run reports its own).
--   * what 440's step 6 also does and this does NOT: add the withheld text to the guard's chunk store (the row's text
--     already matches a stored page - that is why it was flagged - so the guard already refuses it coming back; adding
--     it would widen what the rule matches, the very thing this item may not change) and bump entities (the recompile
--     concern, out of scope).
--   * progress is recorded per chunk (public.inlet_owner_rescan_runs / _chunks): an interrupted run (Ctrl-C, a killed
--     backend, a refusal) keeps every committed chunk, and the next run CONTINUES that run from its cursor - no row is
--     scanned twice. A run that finished leaves nothing open: running again starts a new run, which on a clean
--     database withholds nothing.
--   * a run records the guard's state when it starts (the newest inlet_owner_archive id outside the rescan's own
--     batches; the count, newest page_ref and chunk total of inlet_owner_withheld_pages). The cursor is only valid while
--     that state holds, so an open run is NOT continued, and is closed (abandoned_at), when any of its archive rows has
--     been restored since (440's revert run alone restores them) or the guard's state differs (440 reverted, re-applied
--     or re-run): a fresh full run starts instead. The same check is made before every chunk and before a run is
--     marked finished: a change while it runs closes the run and refuses (run again: a fresh full run).
--   * output: counts and md5(slug) prefixes only - never a title, body or slug. The finish notice counts the run's
--     archive rows still unrestored (what it withheld that is still withheld), not a running total.
-- Rows written or changed while the scan runs are the guard's (trg_inlet_owner_wiki_guard asks the same rule of every
-- INSERT and every UPDATE OF slug/title/body/links), so a row behind the cursor is covered by it; a row behind the
-- cursor that changes WITHOUT the guard (440's revert, triggers off) or that a grown store newly flags (440 re-run)
-- is why the guard-state check above exists.
-- The procedure:
--   1. Before: stop (do not pause) the wiki compile and the viewer's reconcile, as for 440.
--   2. Run this file until it prints "finished" (a refusal or an interruption: run it again; it continues, or starts
--      a fresh full run when the guard's state changed).
--   3. Verify: run count-withheld-text.sql (read-only) and expect rows_flagged = 0 in every row. Anything else: run
--      this file again, then count again.
--   4. After: move the withheld rows' vault files out and restart the viewer (440's deploy step), else a reconcile
--      retries them (a note is refused out loud).
-- Live size (2026-11-22, count-withheld-text.sql): 68,508 rows, ~250 MB of body, 38 flagged (3 entity, 2 note, 33
-- source); the rule over every row took about 21 min read-only, so expect about 21 min plus the writes. The long
-- statement is the DO block below: it sets statement_timeout = 0 for itself (a server or role default must not cut it
-- mid-run).
-- ============================================================
\set ON_ERROR_STOP on
\if :{?chunk}
\else
\set chunk 100
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
-- the scan is ONE top-level statement (the DO below, ~21 min live): no statement_timeout, whatever the server or the
-- role defaults to (a cut mid-run would only be resumed, but the run must not depend on it)
SET statement_timeout = 0;
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
-- round 2: the guard's state a run began under (its cursor is valid only while it holds), why a run was closed
-- unfinished, and per chunk how long the rule ran and how long the chunk held row locks
ALTER TABLE public.inlet_owner_rescan_runs ADD COLUMN IF NOT EXISTS guard_state TEXT;
ALTER TABLE public.inlet_owner_rescan_runs ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
ALTER TABLE public.inlet_owner_rescan_runs ADD COLUMN IF NOT EXISTS abandoned_why TEXT;
ALTER TABLE public.inlet_owner_rescan_chunks ADD COLUMN IF NOT EXISTS rule_ms INT;
ALTER TABLE public.inlet_owner_rescan_chunks ADD COLUMN IF NOT EXISTS lock_ms INT;
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

-- -- the guard's state (numbers only) and a run's staleness ----------------------------------------------------------
-- what the text rule matches against (the withheld pages: count, newest page_ref, chunk total) and 440's own archive
-- (its newest row outside the rescan's batches): 440 run again, reverted or re-applied changes it; the rescan does not
CREATE OR REPLACE FUNCTION pg_temp.rs_guard_state() RETURNS TEXT LANGUAGE sql STABLE AS $f$
    SELECT 'archive ' || coalesce((SELECT a.id FROM public.inlet_owner_archive a
                                    WHERE NOT EXISTS (SELECT 1 FROM public.inlet_owner_rescan_runs r WHERE r.batch = a.batch)
                                    ORDER BY a.id DESC LIMIT 1), 0)
           || ' pages ' || p.n || '/' || p.newest || '/' || p.chunks
      FROM (SELECT count(*) AS n, coalesce(max(page_ref), 0) AS newest, coalesce(sum(n_chunks), 0) AS chunks
              FROM public.inlet_owner_withheld_pages) p
$f$;
-- NULL while the run's cursor can be trusted; else why not (counts only): any of its archive rows restored since it
-- began, or the guard's state differs from the one it began under
CREATE OR REPLACE FUNCTION pg_temp.rs_stale(p_batch UUID) RETURNS TEXT LANGUAGE sql STABLE AS $f$
    SELECT CASE WHEN x.restored > 0 OR r.guard_state IS DISTINCT FROM g.now
                THEN x.restored || ' of its ' || x.archived || ' archive row(s) restored since it began, the guard''s state '
                     || CASE WHEN r.guard_state IS DISTINCT FROM g.now THEN 'changed' ELSE 'unchanged' END END
      FROM public.inlet_owner_rescan_runs r
     CROSS JOIN (SELECT pg_temp.rs_guard_state() AS now) g
     CROSS JOIN LATERAL (SELECT count(*) AS archived, count(*) FILTER (WHERE a.restored_at IS NOT NULL) AS restored
                           FROM public.inlet_owner_archive a WHERE a.batch = r.batch AND a.action = 'w') x
     WHERE r.batch = p_batch
$f$;

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
    v_why     TEXT;
    v_t0      TIMESTAMPTZ;
    v_rule_ms INT;
    v_lock_ms INT;
BEGIN
    SELECT r.batch, r.cursor_slug, r.n_chunks INTO v_batch, v_cursor, v_no
      FROM public.inlet_owner_rescan_runs r WHERE r.finished_at IS NULL AND r.reverted_at IS NULL AND r.abandoned_at IS NULL
     ORDER BY r.started_at DESC LIMIT 1;
    -- an open run is continued only while its cursor can be trusted: nothing it withheld was put back, and the guard's
    -- state is the one it began under; else it is closed (what it withheld stays withheld) and a fresh full run starts
    IF v_batch IS NOT NULL THEN
        v_why := pg_temp.rs_stale(v_batch);
        IF v_why IS NOT NULL THEN
            UPDATE public.inlet_owner_rescan_runs SET abandoned_at = now(), abandoned_why = v_why WHERE batch = v_batch;
            RAISE NOTICE 'withheld-text rescan: open run % closed, not continued (%); starting a fresh full run',
                left(v_batch::text, 8), v_why;
            v_batch := NULL;
        END IF;
    END IF;
    IF v_batch IS NULL THEN
        v_batch := gen_random_uuid();
        v_no := 0;
        v_cursor := NULL;
        INSERT INTO public.inlet_owner_rescan_runs (batch, guard_state) VALUES (v_batch, pg_temp.rs_guard_state());
        RAISE NOTICE 'withheld-text rescan: new run % (chunk %)', left(v_batch::text, 8), v_chunk;
    ELSE
        v_resumed := true;
        RAISE NOTICE 'withheld-text rescan: continuing run % after % chunk(s) (cursor %)', left(v_batch::text, 8), v_no,
            coalesce(left(md5(v_cursor), 12), 'start');
    END IF;
    COMMIT;

    CREATE TEMP TABLE _rs_chunk (slug TEXT PRIMARY KEY, flagged BOOLEAN NOT NULL, img JSONB) ON COMMIT DELETE ROWS;
    LOOP
        -- the guard's state must still be the run's (a change under a running scan: close it and refuse)
        v_why := pg_temp.rs_stale(v_batch);
        IF v_why IS NOT NULL THEN
            UPDATE public.inlet_owner_rescan_runs SET abandoned_at = now(), abandoned_why = v_why WHERE batch = v_batch;
            COMMIT;
            RAISE EXCEPTION 'withheld-text rescan: refused - run % closed after % chunk(s) (%); what it withheld stays withheld; run again (a fresh full run starts)',
                left(v_batch::text, 8), v_no, v_why USING ERRCODE = '55000';
        END IF;
        -- the chunk: the next rows after the cursor; the rule is the existing one, asked of the row's body exactly as
        -- the guard asks it of a write, WITHOUT a row lock (it is slow on long pages); the image it judged is kept for
        -- each row it answers true for
        v_t0 := clock_timestamp();
        INSERT INTO _rs_chunk (slug, flagged, img)
        SELECT x.slug, x.flagged, CASE WHEN x.flagged THEN to_jsonb(x.w) END
          FROM (SELECT w.slug, w, public.inlet_owner_text_withheld(w.body) AS flagged
                  FROM public.wiki_pages w
                 WHERE v_cursor IS NULL OR w.slug > v_cursor
                 ORDER BY w.slug LIMIT v_chunk) x;
        v_rule_ms := round(extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int;
        SELECT count(*), count(*) FILTER (WHERE flagged), min(slug), max(slug) INTO v_n, v_flag, v_first, v_last FROM _rs_chunk;
        EXIT WHEN v_n = 0;
        -- [archive-pages] (440's step 6, the same row image: the one the rule judged)
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, ref_hash, row_data)
        SELECT v_batch, 'public.wiki_pages', 'slug', 'w', c.slug, md5(coalesce(c.img ->> 'body', '')), c.img
          FROM _rs_chunk c WHERE c.flagged;
        -- [/archive-pages]
        -- the only row locks: the flagged rows, from this DELETE to the chunk's COMMIT; a row is withheld only where it
        -- is still byte-for-byte the archived image (a row changed since the rule read it stays, and the chunk is refused)
        v_t0 := clock_timestamp();
        WITH gone AS (
            DELETE FROM public.wiki_pages w
             USING public.inlet_owner_archive a, _rs_chunk c
             WHERE c.flagged AND c.slug = w.slug
               AND a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug AND a.restored_at IS NULL
               AND to_jsonb(w) = a.row_data
            RETURNING w.slug)
        SELECT count(*) INTO v_gone FROM gone;
        IF v_gone <> v_flag THEN
            RAISE EXCEPTION 'withheld-text rescan: refused at chunk % - % row(s) flagged, % archived and withheld (a row changed since the rule read it); this chunk rolled back, % earlier chunk(s) kept (run again to continue)',
                v_no + 1, v_flag, v_gone, v_no USING ERRCODE = '55000';
        END IF;
        v_no := v_no + 1;
        v_lock_ms := CASE WHEN v_gone > 0 THEN round(extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int ELSE 0 END;
        INSERT INTO public.inlet_owner_rescan_chunks (batch, chunk_no, first_slug, last_slug, n_scanned, n_withheld, rule_ms, lock_ms)
        VALUES (v_batch, v_no, v_first, v_last, v_n, v_flag, v_rule_ms, v_lock_ms);
        UPDATE public.inlet_owner_rescan_runs
           SET cursor_slug = v_last, n_scanned = n_scanned + v_n, n_withheld = n_withheld + v_flag, n_chunks = v_no
         WHERE batch = v_batch;
        -- (lab only: lock_ms above is measured before this pause; an operator run has pause_ms = 0)
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
    COMMIT;

    -- finished only if the guard's state held to the end
    v_why := pg_temp.rs_stale(v_batch);
    IF v_why IS NOT NULL THEN
        UPDATE public.inlet_owner_rescan_runs SET abandoned_at = now(), abandoned_why = v_why WHERE batch = v_batch;
        COMMIT;
        RAISE EXCEPTION 'withheld-text rescan: refused - run % closed at its end, not finished (%); what it withheld stays withheld; run again (a fresh full run starts)',
            left(v_batch::text, 8), v_why USING ERRCODE = '55000';
    END IF;
    UPDATE public.inlet_owner_rescan_runs SET finished_at = now() WHERE batch = v_batch;
    COMMIT;
    -- the summary is the archive's, not a running total: the run's rows that are withheld now
    RAISE NOTICE 'withheld-text rescan: run % finished%: % chunk(s), % row(s) scanned, % withheld (its archive rows still unrestored); longest row-lock hold % ms, longest rule time of a chunk % ms; now run count-withheld-text.sql and expect rows_flagged = 0',
        left(v_batch::text, 8), CASE WHEN v_resumed THEN ' (continued)' ELSE '' END, v_no,
        (SELECT n_scanned FROM public.inlet_owner_rescan_runs WHERE batch = v_batch),
        (SELECT count(*) FROM public.inlet_owner_archive a WHERE a.batch = v_batch AND a.action = 'w' AND a.restored_at IS NULL),
        (SELECT coalesce(max(lock_ms), 0) FROM public.inlet_owner_rescan_chunks WHERE batch = v_batch),
        (SELECT coalesce(max(rule_ms), 0) FROM public.inlet_owner_rescan_chunks WHERE batch = v_batch);
END $$;

-- the run's withheld rows: counts per class and the slugs' md5 prefixes (never text)
SELECT 'withheld' AS what, a.row_data ->> 'page_class' AS page_class, count(*) AS n,
       string_agg(left(md5(a.ref), 12), ' ' ORDER BY md5(a.ref)) AS slug_md5
  FROM public.inlet_owner_archive a
  JOIN public.inlet_owner_rescan_runs r ON r.batch = a.batch
 WHERE r.started_at = (SELECT max(started_at) FROM public.inlet_owner_rescan_runs) AND a.action = 'w' AND a.restored_at IS NULL
 GROUP BY 2 ORDER BY 2;
SELECT pg_advisory_unlock(hashtext('rw-withheld-text-rescan')) AS unlocked \gset
