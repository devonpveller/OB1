-- revert-intake.sql - undo init-intake.sql (intake I1), back to the exact pre-migration catalogue.
--
-- Removes: the authority trigger on sources/thoughts and its function, the intake RLS policies
-- and column grants, screen_verdict + intake_item_id (with their CHECK / FK / index), the
-- intake schema with bronze + silver, and the intake role.
--
-- IT REFUSES TO DESTROY INTAKE'S DECISIONS SILENTLY. If any intake table holds a row, or any
-- sources/thoughts row carries a verdict only intake can set (clean / suspicious) or an
-- intake_item_id, the revert stops - that is screened state and bronze that no backfill can
-- re-derive. To drop it anyway, say so:
--     psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -v intake_revert_drop_data=1 -f revert-intake.sql
-- The 'internal' / 'unscreened' labels the backfill wrote ARE re-derivable (re-apply
-- init-intake.sql), so they alone never block a revert.
--
-- No other column of any row is touched: dropping a column is a catalogue change.
-- IDEMPOTENT: on a database without intake it is a no-op.

\set ON_ERROR_STOP 1
\if :{?intake_revert_drop_data}
SELECT set_config('intake.revert_drop_data', 'on', false);
\else
SELECT set_config('intake.revert_drop_data', 'off', false);
\endif

BEGIN;

DO $$
DECLARE
  v_force BOOLEAN := current_setting('intake.revert_drop_data', true) = 'on';
  v_msg   TEXT := '';
  v_n     BIGINT;
  v_t     TEXT;
BEGIN
  IF to_regclass('intake.raw_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM intake.raw_items' INTO v_n;
    IF v_n > 0 THEN v_msg := v_msg || format(' intake.raw_items=%s', v_n); END IF;
  END IF;
  IF to_regclass('intake.items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM intake.items' INTO v_n;
    IF v_n > 0 THEN v_msg := v_msg || format(' intake.items=%s', v_n); END IF;
  END IF;
  IF to_regclass('intake.discards') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM intake.discards' INTO v_n;
    IF v_n > 0 THEN v_msg := v_msg || format(' intake.discards=%s', v_n); END IF;
  END IF;
  FOREACH v_t IN ARRAY ARRAY['sources','thoughts'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                AND table_name=v_t AND column_name='screen_verdict') THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE screen_verdict IN (''clean'',''suspicious'')', v_t) INTO v_n;
      IF v_n > 0 THEN v_msg := v_msg || format(' %s.screen_verdict clean/suspicious=%s', v_t, v_n); END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                AND table_name=v_t AND column_name='intake_item_id') THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE intake_item_id IS NOT NULL', v_t) INTO v_n;
      IF v_n > 0 THEN v_msg := v_msg || format(' %s.intake_item_id set=%s', v_t, v_n); END IF;
    END IF;
  END LOOP;
  IF v_msg <> '' AND NOT v_force THEN
    RAISE EXCEPTION 'revert-intake: refusing - intake holds state no backfill can re-derive:%. '
                    'Re-run with psql -v intake_revert_drop_data=1 to drop it.', v_msg;
  END IF;
  IF v_msg <> '' THEN
    RAISE NOTICE 'revert-intake: dropping intake state on request:%', v_msg;
  END IF;
END $$;

DROP TRIGGER IF EXISTS zzz_intake_screen_verdict_authority ON public.sources;
DROP TRIGGER IF EXISTS zzz_intake_screen_verdict_authority ON public.thoughts;
DROP POLICY IF EXISTS thoughts_intake_label_select ON public.thoughts;
DROP POLICY IF EXISTS thoughts_intake_label_update ON public.thoughts;

ALTER TABLE public.sources  DROP CONSTRAINT IF EXISTS sources_screen_verdict_check;
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_screen_verdict_check;
ALTER TABLE public.sources  DROP CONSTRAINT IF EXISTS sources_intake_item_id_fkey;
ALTER TABLE public.thoughts DROP CONSTRAINT IF EXISTS thoughts_intake_item_id_fkey;
DROP INDEX IF EXISTS public.idx_sources_intake_item_id;
DROP INDEX IF EXISTS public.idx_thoughts_intake_item_id;
ALTER TABLE public.sources  DROP COLUMN IF EXISTS screen_verdict;
ALTER TABLE public.sources  DROP COLUMN IF EXISTS intake_item_id;
ALTER TABLE public.thoughts DROP COLUMN IF EXISTS screen_verdict;
ALTER TABLE public.thoughts DROP COLUMN IF EXISTS intake_item_id;

-- Not CASCADE: anything outside this file that came to depend on intake.* makes the revert
-- fail loudly instead of being dropped with it.
DROP FUNCTION IF EXISTS intake.enforce_screen_verdict_authority();
DROP TABLE IF EXISTS intake.discards;
DROP TABLE IF EXISTS intake.items;
DROP TABLE IF EXISTS intake.raw_items;
DROP SCHEMA IF EXISTS intake;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake') THEN
    -- The id column grants survive the dropped columns; table-level REVOKE ALL takes the
    -- column privileges with it.
    REVOKE ALL ON public.sources, public.thoughts FROM intake;
    REVOKE ALL ON SCHEMA public FROM intake;
    DROP ROLE intake;
  END IF;
END $$;

COMMIT;
