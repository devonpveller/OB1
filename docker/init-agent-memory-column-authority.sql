-- init-agent-memory-column-authority.sql
--
-- THE BOUNDARY READS THE COLUMN H3 MADE AUTHORITATIVE.
--
-- ==========================================================================================
-- WHY THIS FILE EXISTS (dark-factory-unification PLAN.md section C.9 H3, item S, 2026-09-02)
-- ==========================================================================================
-- H3 is binding: `thoughts.exposure` / `agent_memories.exposure` are the SOURCE OF TRUTH and
-- `metadata->>'exposure'` is a NON-AUTHORITATIVE MIRROR - nothing may make a trust decision
-- on the mirror. `195-init-agent-memory-exposure-column.sql` implements that, and on a FRESH
-- volume the chain already ends in the intended state.
--
-- THE LIVE DATABASE IS NOT IN THAT STATE. 195 was applied on 2026-08-31, verified, and
-- REVERTED in the same window because the deployed openbrain-mcp image could not satisfy the
-- new write contract. The revert left the column populated and de-constrained and put the
-- POLICIES back on the mirror. So the live boundary decides on the mirror while every
-- document, comment and producer says the column is authoritative. MEASURED on the live
-- openbrain-db, 2026-09-02, before this file was written:
--
--   thoughts_ops_plane        USING/WITH CHECK  ob_corpus_on_ops_plane(metadata)     <- MIRROR
--   agent_memories_ops_plane  USING/WITH CHECK  ob_memory_on_ops_plane(metadata)     <- MIRROR
--   queue_entity_extraction() gate              ob_corpus_on_ops_plane(NEW.metadata) <- MIRROR
--   thoughts.exposure        nullable=YES, no default, NO CHECK constraint
--   agent_memories.exposure  nullable=YES, no default, NO CHECK constraint
--
-- That is not a design choice, it is an H3 COMPLIANCE GAP, and it has already been paid for
-- once: on 2026-09-02 the promotion of a non-superuser door (H1, `ob_app_memory`) was
-- reverted at step 2 because `capture_thought` was refused by the mirror-reading policy.
-- Measured then, as ob_app_memory:
--
--   INSERT exposure='ops' column only, no mirror  ->  ERROR: violates RLS policy
--   INSERT exposure='ops' + metadata mirror       ->  INSERT 0 1
--
-- A writer that satisfies the DOCUMENTED contract is refused, and a writer that satisfies the
-- RETIRED one is accepted. This file makes the database agree with its own documentation.
--
-- ==========================================================================================
-- WHY A NEW FILE AT 205 RATHER THAN RE-APPLYING 195
-- ==========================================================================================
-- 195 sits BEFORE 200-init-graph-plane-rls.sql, and 200's later rounds ADD ARMS to the
-- policies 195 created (`thought_id IS NULL OR ob_thought_visible(thought_id)` on both
-- agent_memories policies) and carry `NULL-ARM-DISPOSITION` policy COMMENTs that 200's own
-- section 7(h2) reads back out of the catalogue. A file that re-issued 195's `CREATE POLICY`
-- verbatim at the END of the chain would SILENTLY DELETE those arms and those comments -
-- re-opening the foreign-key existence oracle 200 closed, and turning 200's next apply red.
--
-- So this file runs AFTER 200 and is SURGICAL: section 4 rewrites only the sub-expression that
-- names the mirror, preserving every other arm, the policy's roles, its command and its
-- comment. On a fresh volume nothing matches and section 4 is a no-op; on the live volume it
-- moves exactly two policies. Both paths end in the same state, which is what the two-place
-- invariant asks for.
--
-- THE SLOT IS 205, NOT 210. `210-init-app-role.sql` and `215-init-app-role-passwords.sh` are
-- already claimed by H1's application-role cutover (staged, not yet mounted -
-- documentation/implementation-guide/dark-factory-unification/H1-APP-ROLE-PROMOTION.md), and
-- two drills stage their own fixtures at those numbers. 205 is free, sorts unambiguously
-- between 200 and 210 (equal width, digits only), and encodes the ORDER THAT MATTERS: the
-- boundary must read the column BEFORE the door stops being a bypassrls superuser. Doing it
-- the other way round is exactly what was reverted on 2026-09-02.
--
-- ==========================================================================================
-- WHAT IT CHANGES, AND WHAT IT DOES NOT
-- ==========================================================================================
--   1. The two ops-plane policies decide on the COLUMN.
--   2. `thoughts.exposure` and `agent_memories.exposure` become NOT NULL + CHECK IN
--      ('ops','personal'), with NO DEFAULT. A writer that omits the plane is REFUSED, loudly,
--      instead of writing a row that vanishes from the plane it meant to write to.
--   3. `upsert_thought` - the shared rpc door - states the plane on INSERT and repairs the
--      mirror from the column on UPDATE, so neither branch can desync the two.
--   4. `queue_entity_extraction()` - the SECURITY DEFINER write gate on the derived graph -
--      reads the column, and its trigger fires on a change to the column.
--   5. Nothing else in the database reads the mirror for a trust decision; section 7 asserts
--      that over pg_policies AND pg_proc.prosrc rather than asserting it in prose.
--
-- IT DOES NOT change which rows are visible. That is a MEASURED property, not a hope: on the
-- live database, 2026-09-02, `exposure IS DISTINCT FROM metadata->>'exposure'` = 0 on both
-- tables, 0 NULL columns, 0 NULL mirrors, and the 1,129 rows relabelled `personal` by the
-- 2026-09-01 incident resolution agree on both halves (col_personal=1129, mirror_personal=1129).
-- Section 1 RE-MEASURES it and REFUSES to continue if it is not still true, because a
-- migration that moves authority between two fields that disagree moves rows across a security
-- boundary as a side effect.
--
-- WRITERS KEEP STAMPING BOTH HALVES. The mirror is not dropped and no producer stops writing
-- it. That is deliberate: it is what makes the revert safe, and it is what lets this file be
-- rolled back without a second code deployment.
--
-- ==========================================================================================
-- ORDER OF DEPLOYMENT - THE CODE HALF LANDS FIRST
-- ==========================================================================================
-- Section 2 makes `exposure` NOT NULL. Any deployed writer that does not state it stops
-- working AT THAT MOMENT. Measured on the running stack, 2026-09-02:
--
--   openbrain-mcp   image openbrain-mcp-server:local, built 2026-08-30. Its /app/index.ts
--                   lines 869, 967, 1037 are `INSERT INTO thoughts (content, embedding,
--                   metadata)` - NEITHER the column NOR the mirror. capture_thought,
--                   capture_idea and update_idea all break. The tree this repo's gitlink pins
--                   fixes all three; the IMAGE has to be rebuilt.
--   openbrain-wiki  image openbrain-wiki:local. Its baked /app/wiki-service.mjs note-ingest
--                   POSTs `thoughts` with neither half (line 473) and PATCHes `metadata`
--                   wholesale without the key (line 471). The tree fixes both; the IMAGE has
--                   to be rebuilt. (Its `/recipes` are BIND-MOUNTED and are already correct.)
--
-- Every other live corpus producer runs from the bind-mounted host tree (gmail-pull,
-- entity-wiki/generate-wiki.mjs, the import recipes) and already states the column.
--
-- So: BUILD AND RECREATE THOSE TWO CONTAINERS FIRST, THEN APPLY THIS FILE. Swapping the two
-- steps produces a window in which the deployed corpus door cannot write at all. It fails
-- CLOSED - refused writes, nothing disclosed - but it is an outage, and it is the exact shape
-- of the gmail outage the consumer registry exists to prevent.
--
-- REVERT: revert-agent-memory-column-authority.sql, beside this file. It puts the policies,
-- the door and the gate back on the mirror after REPAIRING the mirror from the column, and
-- de-constrains the column without dropping it.
--
-- IDEMPOTENT. Re-running is a no-op in every section.

BEGIN;

-- ==========================================================================================
-- 0. PRECONDITIONS
-- ==========================================================================================
-- This file MOVES authority. It does not create the column, the predicates or the policies,
-- and on a database where those are missing it must refuse rather than invent a boundary.
DO $$
DECLARE
  v_t TEXT;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['thoughts','agent_memories'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: public.% does not exist. This file '
                      'moves an existing boundary onto an existing column; it does not build '
                      'either.', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=v_t AND column_name='exposure') THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: public.%.exposure does not exist. '
                      'It is added by 195-init-agent-memory-exposure-column.sql; apply that '
                      'first - its backfill is the step that makes this one visibility-neutral.',
                      v_t;
    END IF;
  END LOOP;

  -- The jsonb corpus predicate must already be fail-CLOSED (190). It is what the REVERT path
  -- puts back, and a revert onto a fail-OPEN predicate would silently publish every unlabelled
  -- row. Refusing here keeps the round trip safe in both directions.
  IF to_regprocedure('public.ob_corpus_on_ops_plane(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: ob_corpus_on_ops_plane(jsonb) is '
                    'missing. 180/190 have not been applied; this file has nothing to move.';
  END IF;
  IF public.ob_corpus_on_ops_plane('{}'::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: ob_corpus_on_ops_plane(jsonb) is still '
                    'FAIL-OPEN (an unlabelled row is on the ops plane). Apply '
                    '190-init-agent-memory-corpus-failclosed.sql first - the revert path for '
                    'this file re-points the policies at that predicate.';
  END IF;
END $$;

-- ==========================================================================================
-- 1. THE GATE THAT MAKES THIS VISIBILITY-NEUTRAL
-- ==========================================================================================
-- Backfill first, and ONLY where the column is absent and the mirror names a real plane. Rows
-- whose column is already set are never touched, so an operator's hand correction survives and
-- a re-run changes nothing. Stamped with THIS file's marker so its revert can find exactly the
-- rows it wrote - a revert that guessed "everything ops" would also strip rows a producer
-- labelled deliberately (190's lesson, reused).
UPDATE public.thoughts
   SET exposure = COALESCE(metadata, '{}'::jsonb)->>'exposure',
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('exposure_backfill','dfu-s-column-authority')
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IN ('ops','personal');

UPDATE public.agent_memories
   SET exposure = COALESCE(metadata, '{}'::jsonb)->>'exposure',
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('exposure_backfill','dfu-s-column-authority')
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IN ('ops','personal');

-- NO ABSENT-LABEL BRANCH, and that is the difference between this file and 195. 195 ran while
-- the mirror was still the authority, so it could reproduce 190's already-executed ruling
-- ("absent means ops") without moving a row. Here the column is the thing about to BECOME
-- authoritative and the mirror is about to stop mattering: a row with neither is a row whose
-- plane nobody has decided, and inventing 'ops' for it would be this effort's own "unlabelled
-- defaults to fine" class, committed by the file that exists to close it. Such a row makes
-- this migration REFUSE.
DO $$
DECLARE
  v_t_null INT; v_m_null INT; v_bad_val TEXT; v_disagree TEXT; v_n INT;
BEGIN
  SELECT count(*) INTO v_t_null FROM public.thoughts       WHERE exposure IS NULL;
  SELECT count(*) INTO v_m_null FROM public.agent_memories WHERE exposure IS NULL;
  IF v_t_null > 0 OR v_m_null > 0 THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: % thoughts and % agent_memories row(s) '
                    'have NO exposure column and no usable mirror to backfill from. Their plane '
                    'has never been decided, and this file will not decide it for them - label '
                    'them (ops or personal) and re-run.', v_t_null, v_m_null;
  END IF;

  SELECT string_agg(DISTINCT s, ', ') INTO v_bad_val FROM (
    SELECT 'thoughts=' || quote_literal(exposure) AS s FROM public.thoughts
      WHERE exposure NOT IN ('ops','personal')
    UNION ALL
    SELECT 'agent_memories=' || quote_literal(exposure) AS s FROM public.agent_memories
      WHERE exposure NOT IN ('ops','personal')
  ) q;
  IF v_bad_val IS NOT NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the exposure column holds value(s) that '
                    'are not a plane: %. Nothing here is coerced, trimmed or case-folded.',
                    v_bad_val;
  END IF;

  -- THE ONE THAT MATTERS. Authority is about to move from the mirror to the column. Every row
  -- where the two DISAGREE would change plane at that instant - silently, as a side effect of a
  -- migration whose whole claim is that it moves no row. On the live database this is 0 on both
  -- tables (measured 2026-09-02); if it is ever not 0, the disagreement is a decision for a
  -- human, not a rounding error for a migration.
  SELECT count(*) INTO v_n FROM public.thoughts
   WHERE exposure IS DISTINCT FROM (COALESCE(metadata,'{}'::jsonb)->>'exposure');
  IF v_n > 0 THEN
    SELECT string_agg('thoughts#' || id::text || ' col=' || quote_literal(exposure) ||
                      ' mirror=' || quote_nullable(COALESCE(metadata,'{}'::jsonb)->>'exposure'),
                      '; ')
      INTO v_disagree
      FROM (SELECT id, exposure, metadata FROM public.thoughts
             WHERE exposure IS DISTINCT FROM (COALESCE(metadata,'{}'::jsonb)->>'exposure')
             ORDER BY id LIMIT 10) q;
    RAISE EXCEPTION 'init-agent-memory-column-authority: % thoughts row(s) DISAGREE between the '
                    'exposure column and the metadata mirror. Moving authority to the column '
                    'would move them across the plane boundary. Reconcile them first (the '
                    'COLUMN is the source of truth, so the ordinary repair is to write the '
                    'column value into the mirror). First few: %', v_n, v_disagree;
  END IF;

  SELECT count(*) INTO v_n FROM public.agent_memories
   WHERE exposure IS DISTINCT FROM (COALESCE(metadata,'{}'::jsonb)->>'exposure');
  IF v_n > 0 THEN
    SELECT string_agg('agent_memories#' || id::text || ' col=' || quote_literal(exposure) ||
                      ' mirror=' || quote_nullable(COALESCE(metadata,'{}'::jsonb)->>'exposure'),
                      '; ')
      INTO v_disagree
      FROM (SELECT id, exposure, metadata FROM public.agent_memories
             WHERE exposure IS DISTINCT FROM (COALESCE(metadata,'{}'::jsonb)->>'exposure')
             ORDER BY id LIMIT 10) q;
    RAISE EXCEPTION 'init-agent-memory-column-authority: % agent_memories row(s) DISAGREE '
                    'between the exposure column and the metadata mirror. First few: %',
                    v_n, v_disagree;
  END IF;

  RAISE NOTICE 'init-agent-memory-column-authority: column and mirror agree on every row; '
               'moving authority changes no row visibility.';
END $$;

-- ==========================================================================================
-- 2. THE WRITE CONTRACT - NOT NULL, then CHECK, and NO DEFAULT
-- ==========================================================================================
-- Both, in this order. `CHECK (exposure IN (...))` is NULL-permissive on its own, so the CHECK
-- alone would still admit an unlabelled row. NO DEFAULT, ever: a default makes the NOT NULL
-- unreachable from a writer that omits the column, which is the failure H3 exists to remove.
--
-- The policy swap in section 4 already fails such a write CLOSED (NULL = 'ops' is NULL, which
-- a policy coerces to false), so these constraints are not what makes the boundary safe. They
-- are what makes it DIAGNOSABLE, and they are what binds the connections RLS does not: a
-- bypassrls superuser omitting the column would otherwise write a row visible to nobody.
ALTER TABLE public.thoughts       ALTER COLUMN exposure SET NOT NULL;
ALTER TABLE public.agent_memories ALTER COLUMN exposure SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'thoughts_exposure_check'
                    AND conrelid = 'public.thoughts'::regclass) THEN
    ALTER TABLE public.thoughts
      ADD CONSTRAINT thoughts_exposure_check CHECK (exposure IN ('ops','personal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'agent_memories_exposure_check'
                    AND conrelid = 'public.agent_memories'::regclass) THEN
    ALTER TABLE public.agent_memories
      ADD CONSTRAINT agent_memories_exposure_check CHECK (exposure IN ('ops','personal'));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name IN ('thoughts','agent_memories')
                AND column_name='exposure' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: exposure has a DEFAULT. A writer that '
                    'omits the column would then succeed silently on a plane it never stated.';
  END IF;
END $$;

-- Half of every policy below is this column. 195 creates these indexes; re-asserted so this
-- file is also correct on a database where they were never created.
CREATE INDEX IF NOT EXISTS idx_thoughts_exposure_col       ON public.thoughts (exposure);
CREATE INDEX IF NOT EXISTS idx_agent_memories_exposure_col ON public.agent_memories (exposure);

COMMENT ON COLUMN public.thoughts.exposure IS
  'PLAN 1.1 exposure plane. TYPED COLUMN and the SOURCE OF TRUTH (DFU C.9 H3, operator 2026-08-31, option A). metadata->>''exposure'' is a non-authoritative mirror; nothing may make a trust decision on it.';
COMMENT ON COLUMN public.agent_memories.exposure IS
  'PLAN 1.1 exposure plane. TYPED COLUMN and the SOURCE OF TRUTH (DFU C.9 H3, operator 2026-08-31, option A). metadata->>''exposure'' is a non-authoritative mirror; nothing may make a trust decision on it.';

-- ==========================================================================================
-- 3. THE COLUMN-READING PREDICATES
-- ==========================================================================================
-- OVERLOADS, not replacements: the jsonb versions stay defined because the 190 and 200 revert
-- paths recreate policies that call them. 200's section 9 is what asserts nothing CALLS them.
-- SECURITY INVOKER (the default) on both - a SECURITY DEFINER predicate here would run as the
-- superuser owner and hand back exactly what the policy exists to withhold.
CREATE OR REPLACE FUNCTION public.ob_corpus_on_ops_plane(exposure TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT exposure = 'ops'
$$;
CREATE OR REPLACE FUNCTION public.ob_memory_on_ops_plane(exposure TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT exposure = 'ops'
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.ob_corpus_on_ops_plane(TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION public.ob_memory_on_ops_plane(TEXT) TO service_role;
  END IF;
END $$;

-- ==========================================================================================
-- 4. THE SWAP - SURGICAL, so an arm this file did not write is not an arm this file deletes
-- ==========================================================================================
-- Every policy on `thoughts` / `agent_memories` whose expression names the mirror is rebuilt
-- with ONLY that sub-expression rewritten. Roles, command, permissiveness, the other arms of
-- the conjunction and the policy COMMENT are all carried across verbatim - the comment because
-- 200 section 7(h2) reads `NULL-ARM-DISPOSITION` back out of it and RAISEs if it is gone, so
-- losing it here would turn 200's next apply red for a reason nobody could find.
--
-- DROP-then-CREATE inside this transaction. The transient state between them is "RLS enabled,
-- no permissive policy", i.e. default DENY. There is no ordering here that permits a row.
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
                 LIKE '%on_ops_plane(metadata)%'
            OR replace(COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), ''), ' ', '')
                 LIKE '%on_ops_plane(metadata)%' )
     ORDER BY cls.relname, pol.polname
  LOOP
    -- Normalise first (the renderer may or may not schema-qualify), then rewrite to the
    -- explicitly qualified TEXT overload. Two steps, so `public.public.` is unreachable.
    v_qual  := r.qual;
    v_check := r.wcheck;
    IF v_qual IS NOT NULL THEN
      v_qual := replace(v_qual, 'public.ob_corpus_on_ops_plane(metadata)', 'ob_corpus_on_ops_plane(metadata)');
      v_qual := replace(v_qual, 'public.ob_memory_on_ops_plane(metadata)', 'ob_memory_on_ops_plane(metadata)');
      v_qual := replace(v_qual, 'ob_corpus_on_ops_plane(metadata)', 'public.ob_corpus_on_ops_plane(exposure)');
      v_qual := replace(v_qual, 'ob_memory_on_ops_plane(metadata)', 'public.ob_memory_on_ops_plane(exposure)');
    END IF;
    IF v_check IS NOT NULL THEN
      v_check := replace(v_check, 'public.ob_corpus_on_ops_plane(metadata)', 'ob_corpus_on_ops_plane(metadata)');
      v_check := replace(v_check, 'public.ob_memory_on_ops_plane(metadata)', 'ob_memory_on_ops_plane(metadata)');
      v_check := replace(v_check, 'ob_corpus_on_ops_plane(metadata)', 'public.ob_corpus_on_ops_plane(exposure)');
      v_check := replace(v_check, 'ob_memory_on_ops_plane(metadata)', 'public.ob_memory_on_ops_plane(exposure)');
    END IF;

    v_cmd := CASE r.cmd
               WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
               WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
             END;
    IF v_cmd IS NULL THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: policy %.% has an unrecognised '
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
    RAISE NOTICE 'init-agent-memory-column-authority: %.% now decides on the exposure COLUMN',
                 r.relname, r.polname;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE 'init-agent-memory-column-authority: no policy on thoughts/agent_memories read '
                 'the mirror - already column-authoritative (the fresh-volume path).';
  END IF;
END $$;

-- ==========================================================================================
-- 5. upsert_thought - THE SHARED DOOR, ON THE COLUMN, ON BOTH BRANCHES
-- ==========================================================================================
-- This is the rpc door for the wiki compiler (recipes/entity-wiki/generate-wiki.mjs) and the
-- import recipes. Its LIVE body writes `INSERT INTO public.thoughts (content, metadata)` - the
-- MIRROR ONLY - so it is refused the instant authority moves, and with section 2 applied it is
-- refused as a not_null_violation whatever role it runs as. It is exactly the shape the
-- consumer registry exists to catch: a producer still satisfying the retired contract.
--
-- AND ITS UPDATE BRANCH IS A LIVE DESYNC TODAY, in the other direction. It merges the caller's
-- metadata - including an `exposure` key - into the row while never touching the column. With
-- the MIRROR authoritative, re-upserting an existing PERSONAL row with `metadata.exposure:
-- 'ops'` publishes it to the ops plane while the column still reads `personal`. Moving
-- authority to the column closes that; writing the mirror FROM the column closes it from the
-- other side as well, and repairs a row that arrives already disagreeing.
--
-- Body identical to 195 section 8, which is identical to init-graph.sql's apart from the plane
-- handling. It writes ONE plane: `personal` is refused because this door cannot deliver it
-- (thoughts_personal_plane is granted TO ob_plane_personal and requires user_id =
-- ob_current_user_id(); this door has neither, so a bound connection is refused 42501 and a
-- superuser connection writes a row with user_id NULL that no personal-plane session can read).
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
  v_exp  TEXT  := v_meta->>'exposure';
  v_row  public.thoughts;
BEGIN
  -- STATE YOUR PLANE. An absent key and a JSON null both arrive as SQL NULL; '' and ' ' arrive
  -- as themselves. None of them is a plane, and none of them is defaulted.
  IF v_exp IS NULL THEN
    RAISE EXCEPTION 'upsert_thought: metadata.exposure is absent (or JSON null). This door '
                    'does not default it - state "ops" explicitly at the call site. '
                    '(DFU C.9 H3: the column is NOT NULL with no default, and neither is '
                    'this door.)'
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF v_exp = 'personal' THEN
    RAISE EXCEPTION 'upsert_thought: this door writes the OPS-plane corpus and cannot write '
                    'the personal plane. thoughts_personal_plane is granted TO '
                    'ob_plane_personal and requires user_id = ob_current_user_id(); this door '
                    'has neither, so a bound connection would be refused 42501 and a '
                    'superuser connection would write a row with user_id NULL that no '
                    'personal-plane session can read. Refused rather than half-written.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_exp <> 'ops' THEN
    RAISE EXCEPTION 'upsert_thought: metadata.exposure = % is not a plane this door writes. '
                    'Use "ops". Nothing here is coerced, trimmed or case-folded - a value '
                    'that is not exactly "ops" is a typo, and a typo is a loud failure at the '
                    'door instead of a row on a plane nobody chose.', quote_literal(v_exp)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp LIMIT 1;
  IF FOUND THEN
    -- The caller's own `exposure` key is STRIPPED from the merge and the mirror is written
    -- from `v_row.exposure` - the COLUMN, the source of truth - so this statement cannot leave
    -- the two disagreeing whatever the caller sent, and it REPAIRS a row that arrived that
    -- way. The plane of an existing row is not re-decided by a content-fingerprint match:
    -- widening by re-upsert would be a widening path, and PLAN 1.1 puts the only widening path
    -- behind human review (`promote_exposure`).
    UPDATE public.thoughts
       SET metadata = (metadata || (v_meta - 'exposure'))
                      || jsonb_build_object('exposure', v_row.exposure),
           updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata, exposure)
      VALUES (p_content, v_meta || jsonb_build_object('exposure', v_exp), v_exp)
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
-- 6. queue_entity_extraction() - THE WRITE GATE ON THE DERIVED GRAPH
-- ==========================================================================================
-- SECURITY DEFINER, AFTER INSERT OR UPDATE ON thoughts. It decides whether a thought's content
-- FINGERPRINT enters `entity_extraction_queue` - the table whose `source_fingerprint` IS
-- sha256(content), i.e. a disclosure of content the reader cannot see. On the live database it
-- gates on `ob_corpus_on_ops_plane(NEW.metadata)`: a trust decision on the mirror, and the last
-- one outside the policies.
--
-- AND ITS TRIGGER MISSES THE TRANSITION. Live it fires on `UPDATE OF content, metadata`. With
-- the plane in a COLUMN, the only way to demote a thought is `UPDATE thoughts SET
-- exposure='personal'`, which touches neither - so the gate never runs and the fingerprint of
-- now-personal content STAYS in the queue. The column list is widened here for that reason.
--
-- The body is verbatim what BOTH 195 section 7b and 200 carry, so this file cannot regress a
-- fresh volume back to an earlier round.
DO $$
BEGIN
  IF to_regprocedure('public.queue_entity_extraction()') IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: queue_entity_extraction() is missing. '
                    'It is created by 040-init-graph.sql; this file re-points it and does not '
                    'invent it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_queue_entity_extraction'
                    AND tgrelid = 'public.thoughts'::regclass) THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: trg_queue_entity_extraction is missing '
                    'from public.thoughts. It is created by 040-init-graph.sql; this file '
                    'widens its column list and does not invent it.';
  END IF;
END $$;

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

  -- THE GATE. Off-plane content never enters the graph. Reads the COLUMN (DFU C.9 H3).
  -- COALESCE, because the column can be NULL for exactly one statement's worth of trigger on a
  -- writer that omitted it; the constraint rejects that statement a moment later, but the gate
  -- has to refuse it in the meantime.
  IF NOT COALESCE(public.ob_corpus_on_ops_plane(NEW.exposure), false) THEN
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

-- The trigger's COMMENT is captured and re-applied, because DROP TRIGGER takes it with it and
-- 200's TRIGGER-DISPOSITION assertion reads it back out of the catalogue.
DO $$
DECLARE v_c TEXT;
BEGIN
  SELECT obj_description(oid, 'pg_trigger') INTO v_c
    FROM pg_trigger
   WHERE tgname = 'trg_queue_entity_extraction' AND tgrelid = 'public.thoughts'::regclass;

  DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
  CREATE TRIGGER trg_queue_entity_extraction
    AFTER INSERT OR UPDATE OF content, metadata, exposure ON public.thoughts
    FOR EACH ROW
    EXECUTE FUNCTION public.queue_entity_extraction();

  IF v_c IS NOT NULL THEN
    EXECUTE format('COMMENT ON TRIGGER trg_queue_entity_extraction ON public.thoughts IS %L', v_c);
  END IF;
END $$;

-- ==========================================================================================
-- 7. NOTHING READS THE MIRROR FOR A TRUST DECISION - ASSERTED, NOT CLAIMED
-- ==========================================================================================
-- Over pg_policies for declarative readers AND over pg_proc.prosrc for opaque plpgsql bodies,
-- with the same five anchors 195 uses. Whitespace is stripped first, and the anchors name the
-- actual READ rather than the two words appearing somewhere in one expression - a loose
-- `%metadata%exposure%` matches the re-pointed gate's own CORRECT body (it reads
-- metadata->>'generated_by' on one line and NEW.exposure twenty lines later), and a check that
-- fires on correct code is a check nobody keeps.
--
-- `on_ops_plane(NEW.metadata)` is in the list because that is the form the LIVE gate actually
-- had; an anchor list holding only `on_ops_plane(metadata)` would have scanned straight past it.
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND replace(COALESCE(qual, '') || COALESCE(with_check, ''), ' ', '')
         LIKE ANY (ARRAY['%metadata->>''exposure''%',
                         '%metadata->''exposure''%',
                         '%on_ops_plane(metadata)%',
                         '%on_ops_plane(NEW.metadata)%',
                         '%on_ops_plane(OLD.metadata)%']);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: policy/policies still read the jsonb '
                    'mirror: %. The column is the source of truth; the mirror is not a trust '
                    'decision.', v_bad;
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname || '/' || p.pronargs, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname <> 'upsert_thought'
     AND replace(COALESCE(p.prosrc, ''), ' ', '')
         LIKE ANY (ARRAY['%metadata->>''exposure''%',
                         '%metadata->''exposure''%',
                         '%on_ops_plane(metadata)%',
                         '%on_ops_plane(NEW.metadata)%',
                         '%on_ops_plane(OLD.metadata)%']);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: function body/bodies still read the '
                    'jsonb mirror: %. Section 6 re-points the one this file knew about '
                    '(queue_entity_extraction); a new one has to be re-pointed too, not '
                    'exempted here.', v_bad;
  END IF;

  -- upsert_thought is the ONE exemption above, and only as a WRITER of the mirror. Asserted,
  -- so the exemption cannot quietly come to cover a body that DECIDES on it.
  IF (SELECT COALESCE(prosrc, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'upsert_thought' LIMIT 1)
     LIKE '%on_ops_plane%' THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: upsert_thought now calls a plane '
                    'predicate. It is exempted from the mirror scan as a WRITER of the '
                    'mirror; it may not become a reader of it.';
  END IF;

  RAISE NOTICE 'init-agent-memory-column-authority: no policy and no function body reads the '
               'mirror for a trust decision.';
END $$;

-- ==========================================================================================
-- 8. THE MIGRATION ATTACKS ITSELF BEFORE IT COMMITS
-- ==========================================================================================
-- A migration that only asserts what it wrote is a migration reporting on itself. These assert
-- the PROPERTIES: the boundary accepts a column-only write, refuses an absent and a malformed
-- one, still separates the planes, and the graph gate follows the column. Each attempt is
-- inside a plpgsql BEGIN...EXCEPTION block (an implicit savepoint), so a rejected statement
-- leaves nothing behind; 8(e) proves nothing survived.
DO $$
DECLARE
  v_t   TEXT;
  v_ok  BOOLEAN;
  v_id  BIGINT;
  v_n   INT;
BEGIN
  -- (a) the constraints exist and say what they are supposed to say
  FOREACH v_t IN ARRAY ARRAY['thoughts','agent_memories'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=v_t
                      AND column_name='exposure' AND is_nullable='NO') THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: %.exposure is not NOT NULL', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = ('public.'||v_t)::regclass AND contype='c'
                      AND pg_get_constraintdef(oid) LIKE '%exposure%'
                      AND pg_get_constraintdef(oid) LIKE '%ops%'
                      AND pg_get_constraintdef(oid) LIKE '%personal%') THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: %.exposure has no CHECK constraint '
                      'restricting it to ops/personal', v_t;
    END IF;
  END LOOP;

  -- (b) the ops policies read the COLUMN. Positive control: the expression must actually NAME
  --     `exposure`, so a policy that lost its predicate entirely does not pass as "not mirror".
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='thoughts'
                    AND policyname='thoughts_ops_plane'
                    AND replace(COALESCE(qual,''),' ','') LIKE '%on_ops_plane(exposure)%') THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: thoughts_ops_plane does not read the '
                    'exposure column.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='agent_memories'
                    AND policyname='agent_memories_ops_plane'
                    AND replace(COALESCE(qual,''),' ','') LIKE '%on_ops_plane(exposure)%') THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: agent_memories_ops_plane does not read '
                    'the exposure column.';
  END IF;

  -- (c) THE DATABASE refuses an absent plane and a malformed one, on both tables.
  FOREACH v_t IN ARRAY ARRAY['thoughts','agent_memories'] LOOP
    v_ok := FALSE;
    BEGIN
      IF v_t = 'thoughts' THEN
        INSERT INTO public.thoughts (content, metadata)
          VALUES ('S-SELFTEST-ABSENT', '{}'::jsonb);
      ELSE
        INSERT INTO public.agent_memories (workspace_id, memory_type, summary, content, metadata)
          VALUES ('S-SELFTEST', 'lesson', 'S-SELFTEST-ABSENT', 'S-SELFTEST-ABSENT', '{}'::jsonb);
      END IF;
    EXCEPTION WHEN not_null_violation THEN v_ok := TRUE;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: % accepted a write with NO exposure. '
                      'The write contract is not in force.', v_t;
    END IF;

    v_ok := FALSE;
    BEGIN
      IF v_t = 'thoughts' THEN
        INSERT INTO public.thoughts (content, metadata, exposure)
          VALUES ('S-SELFTEST-BAD', '{}'::jsonb, 'OPS');
      ELSE
        INSERT INTO public.agent_memories (workspace_id, memory_type, summary, content, metadata, exposure)
          VALUES ('S-SELFTEST', 'lesson', 'S-SELFTEST-BAD', 'S-SELFTEST-BAD', '{}'::jsonb, 'OPS');
      END IF;
    EXCEPTION WHEN check_violation THEN v_ok := TRUE;
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'init-agent-memory-column-authority: % accepted exposure=''OPS''. Nothing '
                      'here is case-folded; the CHECK is not in force.', v_t;
    END IF;
  END LOOP;

  -- (d) THE POSITIVE HALF, and the one the 2026-09-02 revert was about: a COLUMN-ONLY write,
  --     with NO mirror at all, is ACCEPTED. Under the predicate this file replaces the same
  --     statement was `ERROR: new row violates row-level security policy`.
  INSERT INTO public.thoughts (content, metadata, exposure)
    VALUES ('S-SELFTEST-COLUMN-ONLY', '{}'::jsonb, 'ops')
    RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: a column-only ops write did not return '
                    'an id.';
  END IF;

  --     ...and the boundary still SEPARATES the planes. Checked through the predicate itself,
  --     because this transaction runs as the table owner and cannot observe its own policies.
  --     A predicate that hides everything also passes a careless test, so both directions are
  --     asserted, and NULL is asserted to be non-permitting.
  IF public.ob_corpus_on_ops_plane('personal') IS NOT FALSE THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the corpus predicate admits '
                    '''personal''. This would publish the personal plane.';
  END IF;
  IF public.ob_corpus_on_ops_plane('ops') IS NOT TRUE THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the corpus predicate refuses ''ops''.';
  END IF;
  IF public.ob_corpus_on_ops_plane(NULL) IS TRUE THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the corpus predicate admits NULL.';
  END IF;
  IF public.ob_memory_on_ops_plane('personal') IS NOT FALSE
     OR public.ob_memory_on_ops_plane('ops') IS NOT TRUE THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the memory predicate does not separate '
                    'the planes.';
  END IF;

  --     ...and the plane gate on the DERIVED graph followed the column, not the mirror: the
  --     probe row above is ops, so its fingerprint IS queued; demoting it by COLUMN ALONE
  --     (which the old trigger column list never saw) must remove it again.
  SELECT count(*) INTO v_n FROM public.entity_extraction_queue WHERE thought_id = v_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: the ops probe thought was not queued '
                    'for extraction (found % row(s)). The gate is refusing ops content.', v_n;
  END IF;
  UPDATE public.thoughts SET exposure = 'personal' WHERE id = v_id;
  SELECT count(*) INTO v_n FROM public.entity_extraction_queue WHERE thought_id = v_id;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: demoting a thought by COLUMN left its '
                    'content fingerprint in entity_extraction_queue (% row(s)). The trigger '
                    'column list does not include exposure.', v_n;
  END IF;

  -- (e) NOTHING SURVIVES. Delete the probes and PROVE it - a self-test that leaves rows behind
  --     has changed the corpus it was measuring.
  DELETE FROM public.thoughts WHERE content LIKE 'S-SELFTEST-%';
  DELETE FROM public.agent_memories WHERE workspace_id = 'S-SELFTEST';
  SELECT count(*) INTO v_n FROM public.thoughts WHERE content LIKE 'S-SELFTEST-%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: % self-test thought row(s) survived.', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.agent_memories WHERE workspace_id = 'S-SELFTEST';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'init-agent-memory-column-authority: % self-test memory row(s) survived.', v_n;
  END IF;

  RAISE NOTICE 'init-agent-memory-column-authority: self-test passed - column-only write '
               'accepted, absent and malformed refused, planes separated, graph gate follows '
               'the column, no probe row left behind.';
END $$;

COMMIT;
