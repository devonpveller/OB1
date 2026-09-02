-- revert-agent-memory-column-authority.sql
--
-- Undoes init-agent-memory-column-authority.sql: the boundary decides on the jsonb MIRROR
-- again, the column goes back to being an unconstrained mirror of it, and the door and the
-- graph gate go back to the bodies they had before.
--
-- ==========================================================================================
-- THE ORDER IS THE WHOLE FILE
-- ==========================================================================================
-- 1a. REPAIR THE MIRROR FROM THE COLUMN, and REFUSE if any row still disagrees.
--     This step exists because the obvious version of this file does not have it, and the
--     obvious version is a SILENT WIDENING. Re-pointing the policies at a mirror that
--     disagrees with the column publishes every row whose column says `personal` and whose
--     mirror says `ops`. The column is the source of truth, so it is copied INTO the mirror
--     first - which changes no visibility, because at that moment the policies still read the
--     column - and then zero disagreement is asserted.
-- 1b. RE-OPEN NOTHING BY ACCIDENT: refuse if the jsonb corpus predicate has been made
--     fail-OPEN, because every unlabelled row would become visible the moment step 2 runs.
-- 2.  The policies go back to the jsonb predicate - surgically, the same way the forward file
--     moved them, so 200's arms and its NULL-ARM-DISPOSITION comments survive the round trip.
-- 3.  `upsert_thought` goes back to init-graph.sql's body, verbatim.
-- 3b. `queue_entity_extraction()` goes back on the mirror and the trigger's column list is
--     narrowed again, so the state after a revert is the state before the apply and not a
--     third thing.
-- 4.  The column is DE-CONSTRAINED. NOT NULL and the CHECK come off.
-- 5.  Exactly the rows this migration stamped are unstamped.
--
-- THE COLUMN IS NOT DROPPED. Dropping a column is not reversible and PLAN class 4 forbids it.
-- It is left in place, populated and inert, so a re-apply is idempotent and no data is lost.
--
-- ORDER AGAINST THE CODE HALF: this file makes the database accept the OLD contract again. It
-- does NOT make it reject the new one - a writer that states both halves keeps working, which
-- is why the forward file insists producers keep stamping both. So a revert needs no code
-- rollback and no container recreate. Revert the schema first if you are also rolling back
-- images; the reverse order leaves a window where a rebuilt-and-then-rolled-back door writes
-- the mirror only into a column-authoritative database, which fails closed but is an outage.

BEGIN;

-- ==========================================================================================
-- 1a. REPAIR THE MIRROR FROM THE COLUMN - BEFORE anything trusts the mirror again
-- ==========================================================================================
UPDATE public.thoughts
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('exposure', exposure)
 WHERE exposure IS NOT NULL
   AND (COALESCE(metadata, '{}'::jsonb)->>'exposure') IS DISTINCT FROM exposure;

UPDATE public.agent_memories
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('exposure', exposure)
 WHERE exposure IS NOT NULL
   AND (COALESCE(metadata, '{}'::jsonb)->>'exposure') IS DISTINCT FROM exposure;

DO $$
DECLARE v_n INT;
BEGIN
  SELECT (SELECT count(*) FROM public.thoughts
           WHERE COALESCE(metadata,'{}'::jsonb)->>'exposure' IS DISTINCT FROM exposure)
       + (SELECT count(*) FROM public.agent_memories
           WHERE COALESCE(metadata,'{}'::jsonb)->>'exposure' IS DISTINCT FROM exposure)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: % row(s) still disagree between the '
                    'column and the mirror after the repair (rows whose column is NULL cannot '
                    'be repaired from). Re-pointing the policies at the mirror now would be a '
                    'silent widening. Fix those rows and re-run.', v_n;
  END IF;

  IF to_regprocedure('public.ob_corpus_on_ops_plane(jsonb)') IS NULL
     OR to_regprocedure('public.ob_memory_on_ops_plane(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: the jsonb plane predicates are gone. '
                    'There is nothing to point the policies back at; re-apply 180/190 first.';
  END IF;
  IF public.ob_corpus_on_ops_plane('{}'::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: ob_corpus_on_ops_plane(jsonb) is '
                    'FAIL-OPEN. Reverting onto it would put every unlabelled row on the ops '
                    'plane. Re-apply 190-init-agent-memory-corpus-failclosed.sql first.';
  END IF;
END $$;

-- ==========================================================================================
-- 2. THE POLICIES GO BACK ON THE MIRROR - surgically, as they were moved
-- ==========================================================================================
DO $$
DECLARE
  r          RECORD;
  v_qual     TEXT;
  v_check    TEXT;
  v_sql      TEXT;
  v_cmd      TEXT;
  v_comment  TEXT;
  v_n        INT := 0;
BEGIN
  FOR r IN
    SELECT pol.oid                                       AS pol_oid,
           pol.polname                                   AS polname,
           cls.relname                                   AS relname,
           pol.polpermissive                             AS permissive,
           pol.polcmd                                    AS cmd,
           pg_get_expr(pol.polqual,      pol.polrelid)   AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid)   AS wcheck,
           COALESCE((SELECT string_agg(quote_ident(rol.rolname), ', ' ORDER BY rol.rolname)
                       FROM pg_roles rol WHERE rol.oid = ANY (pol.polroles)), 'PUBLIC') AS roles
      FROM pg_policy pol
      JOIN pg_class  cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND cls.relname IN ('thoughts','agent_memories')
       AND (   replace(COALESCE(pg_get_expr(pol.polqual,      pol.polrelid), ''), ' ', '')
                 LIKE '%on_ops_plane(exposure)%'
            OR replace(COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), ''), ' ', '')
                 LIKE '%on_ops_plane(exposure)%' )
     ORDER BY cls.relname, pol.polname
  LOOP
    v_qual  := r.qual;
    v_check := r.wcheck;
    IF v_qual IS NOT NULL THEN
      v_qual := replace(v_qual, 'public.ob_corpus_on_ops_plane(exposure)', 'ob_corpus_on_ops_plane(exposure)');
      v_qual := replace(v_qual, 'public.ob_memory_on_ops_plane(exposure)', 'ob_memory_on_ops_plane(exposure)');
      v_qual := replace(v_qual, 'ob_corpus_on_ops_plane(exposure)', 'public.ob_corpus_on_ops_plane(metadata)');
      v_qual := replace(v_qual, 'ob_memory_on_ops_plane(exposure)', 'public.ob_memory_on_ops_plane(metadata)');
    END IF;
    IF v_check IS NOT NULL THEN
      v_check := replace(v_check, 'public.ob_corpus_on_ops_plane(exposure)', 'ob_corpus_on_ops_plane(exposure)');
      v_check := replace(v_check, 'public.ob_memory_on_ops_plane(exposure)', 'ob_memory_on_ops_plane(exposure)');
      v_check := replace(v_check, 'ob_corpus_on_ops_plane(exposure)', 'public.ob_corpus_on_ops_plane(metadata)');
      v_check := replace(v_check, 'ob_memory_on_ops_plane(exposure)', 'public.ob_memory_on_ops_plane(metadata)');
    END IF;

    v_cmd := CASE r.cmd
               WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
               WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
             END;
    IF v_cmd IS NULL THEN
      RAISE EXCEPTION 'revert-agent-memory-column-authority: policy %.% has an unrecognised '
                      'command code %; refusing to rebuild it rather than guessing.',
                      r.relname, r.polname, r.cmd;
    END IF;

    SELECT obj_description(r.pol_oid, 'pg_policy') INTO v_comment;

    EXECUTE format('DROP POLICY %I ON public.%I', r.polname, r.relname);

    v_sql := format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
                    r.polname, r.relname,
                    CASE WHEN r.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                    v_cmd, r.roles);
    IF v_qual  IS NOT NULL THEN v_sql := v_sql || format(' USING (%s)', v_qual); END IF;
    IF v_check IS NOT NULL THEN v_sql := v_sql || format(' WITH CHECK (%s)', v_check); END IF;
    EXECUTE v_sql;

    IF v_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON POLICY %I ON public.%I IS %L', r.polname, r.relname, v_comment);
    END IF;

    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'revert-agent-memory-column-authority: % policy/policies put back on the jsonb '
               'mirror.', v_n;
END $$;

-- ==========================================================================================
-- 3. upsert_thought goes back to init-graph.sql's body, VERBATIM
-- ==========================================================================================
-- The pre-H3 door: no plane check, mirror-only INSERT, merge-without-touching-the-column
-- UPDATE. It is restored exactly, not improved, because a revert that leaves behind a
-- half-forward door is a third state nobody has tested.
CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS public.thoughts
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_fp   TEXT := encode(digest(p_content, 'sha256'), 'hex');
  v_meta JSONB := COALESCE(p_payload->'metadata', '{}'::jsonb);
  v_row  public.thoughts;
BEGIN
  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp LIMIT 1;
  IF FOUND THEN
    UPDATE public.thoughts
       SET metadata = metadata || v_meta, updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata)
      VALUES (p_content, v_meta)
      RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.upsert_thought(TEXT, JSONB) TO service_role;
  END IF;
END $$;

-- ==========================================================================================
-- 3b. THE GRAPH GATE GOES BACK ON THE MIRROR, AND THE TRIGGER NARROWS AGAIN
-- ==========================================================================================
-- With the mirror authoritative again, a gate reading the COLUMN would be the desync in the
-- other direction. The trigger's column list drops `exposure` for the same reason: after this
-- file the plane moves by writing `metadata`, which is a column the narrow list already names.
CREATE OR REPLACE FUNCTION public.queue_entity_extraction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.metadata->>'generated_by' IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- THE GATE. Off-plane content never enters the graph.
  IF NOT COALESCE(public.ob_corpus_on_ops_plane(NEW.metadata), false) THEN
    -- ...and if it was ON the plane a moment ago, its fingerprint LEAVES.
    DELETE FROM public.entity_extraction_queue WHERE thought_id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO public.entity_extraction_queue (thought_id, status, source_fingerprint, source_updated_at)
  VALUES (NEW.id, 'pending', NEW.content_fingerprint, NEW.updated_at)
  ON CONFLICT (thought_id) DO UPDATE SET
    status = 'pending',
    attempt_count = 0,
    last_error = NULL,
    queued_at = now(),
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_updated_at = EXCLUDED.source_updated_at
  WHERE entity_extraction_queue.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint;
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE v_c TEXT;
BEGIN
  SELECT obj_description(oid, 'pg_trigger') INTO v_c
    FROM pg_trigger
   WHERE tgname = 'trg_queue_entity_extraction' AND tgrelid = 'public.thoughts'::regclass;

  DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
  CREATE TRIGGER trg_queue_entity_extraction
    AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts
    FOR EACH ROW
    EXECUTE FUNCTION public.queue_entity_extraction();

  IF v_c IS NOT NULL THEN
    EXECUTE format('COMMENT ON TRIGGER trg_queue_entity_extraction ON public.thoughts IS %L', v_c);
  END IF;
END $$;

-- ==========================================================================================
-- 4. DE-CONSTRAIN THE COLUMN - but do NOT drop it
-- ==========================================================================================
ALTER TABLE public.thoughts       ALTER COLUMN exposure DROP NOT NULL;
ALTER TABLE public.agent_memories ALTER COLUMN exposure DROP NOT NULL;
ALTER TABLE public.thoughts       DROP CONSTRAINT IF EXISTS thoughts_exposure_check;
ALTER TABLE public.agent_memories DROP CONSTRAINT IF EXISTS agent_memories_exposure_check;

COMMENT ON COLUMN public.thoughts.exposure IS
  'PLAN 1.1 exposure plane. NON-AUTHORITATIVE while revert-agent-memory-column-authority.sql is in force: the policies read metadata->>''exposure''. Kept populated so a re-apply is idempotent.';
COMMENT ON COLUMN public.agent_memories.exposure IS
  'PLAN 1.1 exposure plane. NON-AUTHORITATIVE while revert-agent-memory-column-authority.sql is in force: the policies read metadata->>''exposure''. Kept populated so a re-apply is idempotent.';

-- ==========================================================================================
-- 5. UNSTAMP EXACTLY THE ROWS THE FORWARD FILE STAMPED
-- ==========================================================================================
-- Matched on the marker, not on a date and not on "everything ops" - a revert that guessed
-- would also strip rows a producer labelled deliberately.
UPDATE public.thoughts
   SET metadata = metadata - 'exposure_backfill'
 WHERE metadata->>'exposure_backfill' = 'dfu-s-column-authority';

UPDATE public.agent_memories
   SET metadata = metadata - 'exposure_backfill'
 WHERE metadata->>'exposure_backfill' = 'dfu-s-column-authority';

-- ==========================================================================================
-- 6. POST-CONDITIONS - the revert proves it reverted
-- ==========================================================================================
DO $$
DECLARE v_n INT; v_bad TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name IN ('thoughts','agent_memories')
                AND column_name='exposure' AND is_nullable='NO') THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: exposure is still NOT NULL.';
  END IF;

  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_bad
    FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('thoughts','agent_memories')
     AND replace(COALESCE(qual,'') || COALESCE(with_check,''), ' ', '')
         LIKE '%on_ops_plane(exposure)%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: policy/policies still read the '
                    'column: %.', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='thoughts'
                    AND policyname='thoughts_ops_plane'
                    AND replace(COALESCE(qual,''),' ','') LIKE '%on_ops_plane(metadata)%') THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: thoughts_ops_plane does not read the '
                    'mirror. A policy with NEITHER predicate is not a revert, it is an outage.';
  END IF;

  SELECT count(*) INTO v_n FROM public.thoughts
   WHERE metadata->>'exposure_backfill' = 'dfu-s-column-authority';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'revert-agent-memory-column-authority: % stamped row(s) remain.', v_n;
  END IF;

  RAISE NOTICE 'revert-agent-memory-column-authority: reverted - policies read the mirror, the '
               'column is populated and unconstrained, no row was deleted.';
END $$;

COMMIT;
