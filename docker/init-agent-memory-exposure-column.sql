-- init-agent-memory-exposure-column.sql
--
-- H3: THE EXPOSURE LABEL BECOMES A TYPED COLUMN, AND THE PREDICATES READ IT.
--
-- ==========================================================================================
-- WHY THIS FILE EXISTS (dark-factory-unification PLAN.md section C.9, item H3;
-- OPERATOR DECISION 2026-08-31 - OPTION A, TYPED COLUMN)
-- ==========================================================================================
-- The exposure boundary shipped with its two halves at DIFFERENT STRENGTHS. Tenancy is a
-- typed column (`user_id`); exposure was a jsonb key (`metadata->>'exposure'`). A jsonb key
-- cannot be constrained, so "unlabelled" and "misspelled" were both reachable states, and
-- both were resolved at READ time by a fail-closed predicate. Fail-closed is the right error
-- direction and it is not a write contract: a producer that forgot the label got a row that
-- silently vanished from the plane it meant to write to. That is an availability and
-- write-discipline defect, and C.9 records it as one.
--
-- The operator's ruling, from PLAN.md section C.9: "exposure is a security discriminator and
-- the two halves of one access model must not live at different strengths; a jsonb key beside
-- a typed tenancy column is an inconsistency, not a design. The one-time migration cost and
-- the changed write contract are accepted deliberately - forcing every producer to state
-- exposure explicitly is the intent, not a side effect."
--
-- So after this file:
--   * `agent_memories.exposure` and `thoughts.exposure` are
--     `TEXT NOT NULL CHECK (exposure IN ('ops','personal'))`.
--   * THE COLUMN IS THE SOURCE OF TRUTH. `ob_memory_on_ops_plane` and
--     `ob_corpus_on_ops_plane` read the COLUMN. `metadata->>'exposure'` is kept as a
--     MIRROR for readers that already parse it and is NON-AUTHORITATIVE: nothing in the
--     database makes a trust decision on it any more.
--   * A write that OMITS exposure is rejected by NOT NULL. A write that MALFORMS it is
--     rejected by the CHECK. Neither is defaulted, because a default is exactly the
--     "unlabelled defaults to fine" class this effort has already paid for twice.
--
-- ==========================================================================================
-- NO DEFAULT. THIS IS THE DECISION, NOT AN OMISSION.
-- ==========================================================================================
-- `DEFAULT 'ops'` would make the NOT NULL unreachable and would hand a forgetful producer a
-- silent success on the WIDER plane. `DEFAULT 'personal'` would hand it a silent success on
-- the narrower one - safer, and still silent, and still a guess about a plane the writer
-- never stated. The operator chose Option A precisely so that the producer states it. A DOOR
-- may stamp its own forced value (section 7 below does exactly that for `upsert_thought`,
-- and `stampExposure()` does it for the agent-memory doors) - that is PLAN section 1.1's
-- "lane stamping happens at doors, not by writers" and it is not a column default: the door
-- KNOWS its plane, the column does not.
--
-- ==========================================================================================
-- WHAT AN ABSENT KEY BACKFILLS TO, AND WHY - the one judgement call in this file
-- ==========================================================================================
-- ABSENT -> 'ops'. MALFORMED -> the migration REFUSES.
--
-- Absent is not ambiguous here, because it was already RULED ON and already EXECUTED.
-- 190-init-agent-memory-corpus-failclosed.sql (DFU C.8 clause 3, operator 2026-08-30) took
-- every unlabelled thought, stamped it `exposure='ops'`, and only THEN closed the predicate -
-- deliberately, so the existing corpus stayed readable. Measured on the live database
-- 2026-08-31 BEFORE this migration:
--
--     thoughts total                         13001
--     thoughts metadata->>'exposure' IS NULL     0   <- 190 has run; nothing is unlabelled
--     thoughts metadata->>'exposure' = 'ops'  13001
--     thoughts labelled 'personal'               0
--     thoughts carrying 190's backfill stamp  12980
--     agent_memories total                      21   (all 'ops', none unlabelled)
--
-- So on the live database the absent branch touches ZERO rows and this migration changes NO
-- row's visibility: 13001 ops thoughts before, 13001 ops thoughts after. The branch is not
-- decoration - it is reachable on any database where 190 has not run, and it is reachable on
-- a database where it HAS, because the openbrain-* containers connect as `postgres`
-- (superuser) and their writes are not bound by the WITH CHECK that would otherwise refuse an
-- unlabelled row. Backfilling those to 'ops' reproduces the decision 190 already made rather
-- than re-opening it, and it is the only choice that does not silently change the visibility
-- of the ~13,000 rows C.9 and the H3 brief both forbid moving.
--
-- MALFORMED IS DIFFERENT AND IS NOT BACKFILLED. An absent label is a row written before the
-- boundary existed. A malformed label is a producer that TRIED to state a plane and stated a
-- non-plane; its intent is unknown, no prior decision covers it, and assigning it one would be
-- this file inventing a plane for a row. It fails the migration, naming the rows, with both
-- remedies. Measured live: 0 such rows.
--
-- ==========================================================================================
-- THE CUTOVER IS FAIL-CLOSED THROUGHOUT. THE ORDER IS THE ARGUMENT.
-- ==========================================================================================
-- Statement order, and why each step cannot open a window:
--
--   0. ASSERT the preconditions. An assertion cannot open a window; it can only refuse.
--   1. ADD COLUMN, NULLABLE, NO DEFAULT. No predicate reads it yet, so no row's visibility
--      changes. If the transaction aborted here the database would be exactly as before,
--      plus one column nothing reads.
--   2. BACKFILL. Still a write to a column no predicate reads. Every reader in the database
--      is still bound by the jsonb predicate, which 190 already made fail-closed. Visibility
--      is unchanged for every caller during this step, by construction.
--   3. VERIFY ZERO NULL AND ZERO ILLEGAL, and RAISE otherwise. This is the gate that makes
--      step 4 safe; if it fails the whole transaction rolls back and NOTHING happened.
--   4. NOT NULL, then CHECK. Both are needed and neither is sufficient:
--      `CHECK (exposure IN ('ops','personal'))` is NULL-PERMISSIVE on its own (NULL IN (...)
--      is NULL, and a CHECK passes on anything that is not FALSE), so the CHECK alone would
--      admit an unlabelled row. NOT NULL first, CHECK second, both inside this transaction.
--      The predicates STILL read jsonb at this point: the column is now total but unread.
--   5. DEFINE the column-reading predicates. Defining a function changes no visibility.
--   6. SWAP THE POLICIES to the column predicates. This is the only step that changes what a
--      predicate reads, and it is the one place a window could exist - so note what the
--      transient state inside the transaction actually is: between DROP POLICY and CREATE
--      POLICY the table has RLS ENABLED and NO permissive policy for the role, which is
--      DEFAULT DENY. The intermediate state of this step is strictly more closed than either
--      end of it. There is no ordering of these two statements that permits a row.
--   7. Re-point the corpus DOOR (`upsert_thought`) at the column.
--   8. POST-CONDITIONS, including the migration attacking itself: an absent write and a
--      malformed write are attempted and both must be rejected BY THE DATABASE, or this
--      migration fails.
--
-- AND THE WHOLE FILE IS ONE TRANSACTION. DDL in PostgreSQL is transactional, and ALTER TABLE
-- takes ACCESS EXCLUSIVE, so no other session observes any of the intermediate states above:
-- a concurrent reader sees either the pre-migration world (jsonb predicate, fail-closed and
-- complete) or the post-migration world (column predicate, NOT NULL + CHECK). There is no
-- committed state in between, which is the strongest form of "no window" available here.
--
-- ==========================================================================================
-- ADDITIVE AND REVERSIBLE
-- ==========================================================================================
-- Adds two columns, two indexes, two functions and two constraints; replaces two policies
-- with narrower-or-equal ones of the same shape; redefines one function body
-- (`upsert_thought`). It DROPS NOTHING that holds data - no table, no column, no row, and no
-- function. The jsonb predicates `ob_memory_on_ops_plane(jsonb)` and
-- `ob_corpus_on_ops_plane(jsonb)` are DELIBERATELY LEFT IN PLACE and COMMENTed as retired:
-- `revert-graph-plane-rls.sql` recreates a policy that calls one of them, so dropping them
-- would break a revert path that already ships. 200's section 9 asserts instead that NOTHING
-- calls them - which is the completeness proof, without the fragility.
-- REVERT: revert-agent-memory-exposure-column.sql beside this file.
--
-- IDEMPOTENT. Re-running is a no-op: ADD COLUMN IF NOT EXISTS, the backfill's WHERE matches
-- nothing the second time, the constraints are added only if absent, and every function and
-- policy is CREATE OR REPLACE / DROP IF EXISTS + CREATE.
--
-- TWO PLACES, ALWAYS: mounted in the initdb chain at 195- for fresh volumes, AND applied to
-- the live volume per
-- documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md. A migration
-- that reaches only one place is not deployed.
--
-- ORDERING: 195, AFTER 190-init-agent-memory-corpus-failclosed.sql (whose backfill this file
-- depends on and whose ruling it reproduces) and BEFORE 200-init-graph-plane-rls.sql (whose
-- policies, sweeps and write gate read the column this file creates, and which would fail at
-- CREATE POLICY if the column did not exist yet).

BEGIN;

-- ==========================================================================================
-- 0. PRECONDITIONS - asserted, because every count below is meaningless without them
-- ==========================================================================================
DO $$
BEGIN
  IF to_regclass('public.thoughts') IS NULL OR to_regclass('public.agent_memories') IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: thoughts and/or agent_memories do not '
                    'exist. Apply 100-init-agent-memory.sql first.';
  END IF;

  IF to_regprocedure('public.ob_corpus_on_ops_plane(jsonb)') IS NULL
     OR to_regprocedure('public.ob_memory_on_ops_plane(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: the jsonb exposure predicates are not '
                    'defined. Apply 180-init-agent-memory-rls.sql first - this file MIGRATES '
                    'that boundary, it does not create one from nothing.';
  END IF;

  -- 190 MUST have run. If the jsonb corpus predicate is still fail-OPEN then an unlabelled
  -- row is currently VISIBLE, and this file's absent->'ops' backfill would be preserving a
  -- fail-open semantic into a column - which is correct - but the 190 ruling that says so
  -- would not have been recorded, and step 4 would then close the predicate as a SIDE
  -- EFFECT of a migration that never said it was going to. Refuse rather than do that
  -- quietly.
  IF public.ob_corpus_on_ops_plane('{}'::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: ob_corpus_on_ops_plane() still returns '
                    'TRUE for an UNLABELLED row, so 190-init-agent-memory-corpus-failclosed.sql '
                    'has not been applied. Apply it first: its backfill is the decision this '
                    'file reproduces into the column, and making that decision here instead '
                    'would hide it inside an unrelated migration.';
  END IF;
END $$;

-- ==========================================================================================
-- 1. THE COLUMN - nullable and DEFAULT-LESS on purpose (see the header)
-- ==========================================================================================
ALTER TABLE public.agent_memories ADD COLUMN IF NOT EXISTS exposure TEXT;
ALTER TABLE public.thoughts       ADD COLUMN IF NOT EXISTS exposure TEXT;

-- ==========================================================================================
-- 2. BACKFILL - from the jsonb key, which is the authority UNTIL step 6
-- ==========================================================================================
-- Only rows whose column is still NULL are touched, so re-running changes nothing and a
-- row an operator has already corrected by hand is not overwritten.
UPDATE public.agent_memories
   SET exposure = COALESCE(metadata, '{}'::jsonb)->>'exposure'
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IN ('ops','personal');

UPDATE public.thoughts
   SET exposure = COALESCE(metadata, '{}'::jsonb)->>'exposure'
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IN ('ops','personal');

-- THE ABSENT BRANCH. 'ops', per 190's ruling, and STAMPED so a revert can find exactly the
-- rows this file labelled and no others - the same discipline 190 used, and for the same
-- reason: a revert that guessed "everything ops" would also strip rows a writer labelled
-- deliberately. The jsonb mirror is written in the same statement so the column and the
-- mirror never disagree.
UPDATE public.agent_memories
   SET exposure = 'ops',
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('exposure','ops','exposure_backfill','dfu-h3-exposure-column')
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IS NULL;

UPDATE public.thoughts
   SET exposure = 'ops',
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('exposure','ops','exposure_backfill','dfu-h3-exposure-column')
 WHERE exposure IS NULL
   AND COALESCE(metadata, '{}'::jsonb)->>'exposure' IS NULL;

-- ==========================================================================================
-- 3. VERIFY - zero NULL and zero ILLEGAL, or the whole transaction rolls back
-- ==========================================================================================
-- Anything still NULL here carries a jsonb label that is neither 'ops' nor 'personal'. It is
-- NOT backfilled; see the header. The message names the rows so the operator can decide,
-- because this file cannot.
DO $$
DECLARE
  v_m_null INT; v_t_null INT; v_bad TEXT;
BEGIN
  SELECT count(*) INTO v_m_null FROM public.agent_memories WHERE exposure IS NULL;
  SELECT count(*) INTO v_t_null FROM public.thoughts       WHERE exposure IS NULL;

  IF v_m_null > 0 OR v_t_null > 0 THEN
    SELECT string_agg(s, '; ') INTO v_bad FROM (
      (SELECT 'agent_memories#' || id::text || ' exposure=' ||
              quote_nullable(COALESCE(metadata,'{}'::jsonb)->>'exposure') AS s
         FROM public.agent_memories WHERE exposure IS NULL LIMIT 10)
      UNION ALL
      (SELECT 'thoughts#' || id::text || ' exposure=' ||
              quote_nullable(COALESCE(metadata,'{}'::jsonb)->>'exposure') AS s
         FROM public.thoughts WHERE exposure IS NULL LIMIT 10)
    ) q;
    RAISE EXCEPTION 'init-agent-memory-exposure-column: % agent_memories and % thoughts row(s) '
                    'carry an exposure label that is neither ''ops'' nor ''personal''. A '
                    'MALFORMED label is not backfilled - a producer stated a plane and stated '
                    'a non-plane, and this migration will not invent one for it. Fix each row '
                    '(set metadata->>''exposure'' to ops or personal, or set the column '
                    'directly) and re-run. First few: %',
                    v_m_null, v_t_null, COALESCE(v_bad,'(none listed)');
  END IF;

  RAISE NOTICE 'init-agent-memory-exposure-column: backfill complete - 0 NULL exposure in '
               'agent_memories and thoughts';
END $$;

-- ==========================================================================================
-- 4. THE CONSTRAINTS - NOT NULL first, then the CHECK. Both. See the header.
-- ==========================================================================================
ALTER TABLE public.agent_memories ALTER COLUMN exposure SET NOT NULL;
ALTER TABLE public.thoughts       ALTER COLUMN exposure SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'agent_memories_exposure_check'
                    AND conrelid = 'public.agent_memories'::regclass) THEN
    ALTER TABLE public.agent_memories
      ADD CONSTRAINT agent_memories_exposure_check CHECK (exposure IN ('ops','personal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'thoughts_exposure_check'
                    AND conrelid = 'public.thoughts'::regclass) THEN
    ALTER TABLE public.thoughts
      ADD CONSTRAINT thoughts_exposure_check CHECK (exposure IN ('ops','personal'));
  END IF;
END $$;

-- The exposure column is half of every policy below, so it is indexed - as a real column
-- now, rather than as the jsonb expression 180 had to index.
CREATE INDEX IF NOT EXISTS idx_agent_memories_exposure_col ON public.agent_memories (exposure);
CREATE INDEX IF NOT EXISTS idx_thoughts_exposure_col       ON public.thoughts (exposure);

COMMENT ON COLUMN public.agent_memories.exposure IS
  'PLAN 1.1 exposure plane. TYPED COLUMN and the SOURCE OF TRUTH (DFU C.9 H3, operator 2026-08-31, option A). metadata->>''exposure'' is a non-authoritative mirror; nothing may make a trust decision on it.';
COMMENT ON COLUMN public.thoughts.exposure IS
  'PLAN 1.1 exposure plane. TYPED COLUMN and the SOURCE OF TRUTH (DFU C.9 H3, operator 2026-08-31, option A). metadata->>''exposure'' is a non-authoritative mirror; nothing may make a trust decision on it.';

-- ==========================================================================================
-- 5. THE PREDICATES, RE-POINTED AT THE COLUMN
-- ==========================================================================================
-- OVERLOADS, not replacements. The jsonb-argument versions stay defined so that
-- revert-graph-plane-rls.sql - which ships today and recreates a policy calling
-- ob_memory_on_ops_plane(metadata) - still works. They are COMMENTed as retired below and
-- 200's section 9 asserts that NOTHING in the database calls them.
--
-- They stay TWO functions rather than one with a flag for the same reason 180 gave: each
-- policy site keeps naming which corpus it is talking about. What has changed is that the
-- two rules are now IDENTICAL, because the difference between them - the corpus predicate's
-- `IS NULL OR` arm - was the absence hole 190 closed and this column makes unreachable.
--
-- TOTAL, because the column is NOT NULL and CHECKed: there is no third value and no NULL, so
-- these cannot return NULL for any row that exists. They can still be handed NULL by a
-- probe (section 7(h) of 200 does exactly that), and `NULL = 'ops'` is NULL, which every
-- policy coerces to false. Fail-closed at both ends.
--
-- SECURITY INVOKER (the default) on both. A SECURITY DEFINER function here would run as the
-- superuser owner and hand back exactly what the policy exists to withhold.
CREATE OR REPLACE FUNCTION public.ob_memory_on_ops_plane(exposure TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT exposure = 'ops'
$$;

CREATE OR REPLACE FUNCTION public.ob_corpus_on_ops_plane(exposure TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT exposure = 'ops'
$$;

GRANT EXECUTE ON FUNCTION public.ob_memory_on_ops_plane(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_corpus_on_ops_plane(TEXT) TO service_role;

COMMENT ON FUNCTION public.ob_memory_on_ops_plane(TEXT) IS
  'DFU C.9 H3: the authoritative memory-plane predicate. Reads agent_memories.exposure (NOT NULL, CHECKed).';
COMMENT ON FUNCTION public.ob_corpus_on_ops_plane(TEXT) IS
  'DFU C.9 H3: the authoritative corpus-plane predicate. Reads thoughts.exposure (NOT NULL, CHECKed).';
COMMENT ON FUNCTION public.ob_memory_on_ops_plane(JSONB) IS
  'RETIRED by DFU C.9 H3 (2026-08-31). Reads the NON-AUTHORITATIVE metadata mirror. Retained ONLY because revert-graph-plane-rls.sql recreates a policy that calls it. Nothing may call it; init-graph-plane-rls.sql section 9 asserts nothing does.';
COMMENT ON FUNCTION public.ob_corpus_on_ops_plane(JSONB) IS
  'RETIRED by DFU C.9 H3 (2026-08-31). Reads the NON-AUTHORITATIVE metadata mirror. Retained ONLY because the 190 revert path recreates it. Nothing may call it; init-graph-plane-rls.sql section 9 asserts nothing does.';

-- ==========================================================================================
-- 6. THE POLICY SWAP - the only step that changes what a predicate reads
-- ==========================================================================================
-- DROP-then-CREATE inside this transaction. The transient state between the two statements
-- is RLS ENABLED WITH NO PERMISSIVE POLICY = DEFAULT DENY, which is strictly more closed
-- than either end. There is no ordering of these statements that permits a row, and no
-- session outside this transaction sees either state.
--
-- 200-init-graph-plane-rls.sql REPLACES both agent_memories policies again (it adds the
-- thought_id arm that closes the FK existence oracle). This file still writes them, because
-- a database on which 200 has not been applied must not be left reading the jsonb key.
DROP POLICY IF EXISTS agent_memories_ops_plane ON public.agent_memories;
CREATE POLICY agent_memories_ops_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_on_ops_plane(exposure))
  WITH CHECK (public.ob_memory_on_ops_plane(exposure));

DROP POLICY IF EXISTS thoughts_ops_plane ON public.thoughts;
CREATE POLICY thoughts_ops_plane ON public.thoughts
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_corpus_on_ops_plane(exposure))
  WITH CHECK (public.ob_corpus_on_ops_plane(exposure));

-- The two personal-plane policies are NOT touched here: they discriminate on tenancy
-- (user_id = ob_current_user_id()), not on exposure, and 180 created them TO
-- ob_plane_personal, which is where they belong.

-- ==========================================================================================
-- 7. THE CORPUS DOOR - upsert_thought stamps the column
-- ==========================================================================================
-- `upsert_thought(p_content, p_payload)` is the shared write door for the wiki synthesis,
-- entity-wiki dossiers and every import recipe (grok, instagram, blogger, gmail), all of
-- which reach it over PostgREST rpc as `service_role`. It inserts into `thoughts`, so under
-- NOT NULL it MUST supply the column or every one of those callers breaks - which is the
-- write-contract change C.9 says is the intent, delivered at the door rather than as a
-- column default.
--
-- ITS LANE IS 'ops', and that is the same ruling as the backfill: this door writes the
-- general corpus, which 190 already decided is ops-plane content. It is NOT a fallback for
-- a missing value - the door KNOWS its plane. What a caller may do is DEMOTE: an explicit
-- `metadata.exposure = 'personal'` is honoured, because narrowing is always allowed and
-- widening never is (PLAN 1.1, and the same asymmetry as stampExposure()). Anything else is
-- REFUSED here rather than silently coerced, so a typo is a loud failure at the door instead
-- of a row on a plane nobody chose.
--
-- The UPDATE branch is deliberately left alone on this column: an existing row's plane is
-- not re-decided by a content-fingerprint match. Widening by re-upsert would be a widening
-- path, and PLAN 1.1 puts the only widening path behind human review (`promote_exposure`).
--
-- The body is otherwise IDENTICAL to init-graph.sql's, which is where this function is
-- created; see the pointer comment there.
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
  v_exp  TEXT;
  v_row  public.thoughts;
BEGIN
  v_exp := COALESCE(NULLIF(v_meta->>'exposure', ''), 'ops');
  IF v_exp NOT IN ('ops','personal') THEN
    RAISE EXCEPTION 'upsert_thought: metadata.exposure = % is not a plane. Use ''ops'' or '
                    '''personal'', or omit it to write on this door''s own plane (ops).', v_exp
      USING ERRCODE = 'check_violation';
  END IF;
  -- The mirror is kept in step with the column at the door, so the two never disagree.
  v_meta := v_meta || jsonb_build_object('exposure', v_exp);

  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp LIMIT 1;
  IF FOUND THEN
    UPDATE public.thoughts
       SET metadata = metadata || v_meta, updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata, exposure)
      VALUES (p_content, v_meta, v_exp)
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
-- 8. POST-CONDITIONS - and the migration ATTACKS ITSELF before it commits
-- ==========================================================================================
-- A migration that only asserts what it wrote is a migration that reports on itself. These
-- assert the PROPERTY the operator asked for: the DATABASE, not application code, rejects an
-- absent and a malformed exposure. Each attempt runs inside a plpgsql BEGIN...EXCEPTION
-- block, which is an implicit savepoint, so a rejected statement leaves nothing behind; the
-- migration FAILS if any of them succeeds, and section 8b proves nothing was written.
DO $$
DECLARE
  v_t  TEXT;
  v_ok BOOLEAN;
BEGIN
  -- (a) the constraints exist and say what they are supposed to say
  FOREACH v_t IN ARRAY ARRAY['agent_memories','thoughts'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=v_t
                      AND column_name='exposure' AND is_nullable='NO') THEN
      RAISE EXCEPTION 'init-agent-memory-exposure-column: %.exposure is not NOT NULL', v_t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = ('public.'||v_t)::regclass AND contype='c'
                      AND pg_get_constraintdef(oid) LIKE '%exposure%'
                      AND pg_get_constraintdef(oid) LIKE '%ops%'
                      AND pg_get_constraintdef(oid) LIKE '%personal%') THEN
      RAISE EXCEPTION 'init-agent-memory-exposure-column: %.exposure has no CHECK constraint '
                      'restricting it to ops/personal', v_t;
    END IF;
    -- (b) NO DEFAULT. A default would make the NOT NULL unreachable from a writer that
    --     omits the column, which is the entire failure mode H3 exists to remove.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name=v_t
                  AND column_name='exposure' AND column_default IS NOT NULL) THEN
      RAISE EXCEPTION 'init-agent-memory-exposure-column: %.exposure has a DEFAULT. A writer '
                      'that omits the column would then succeed silently on a plane it never '
                      'stated - see the header.', v_t;
    END IF;
  END LOOP;

  -- (c) the policies read the COLUMN and no longer read the jsonb key
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='public' AND tablename IN ('agent_memories','thoughts')
                AND permissive='PERMISSIVE'
                AND (COALESCE(qual,'') LIKE '%metadata%' OR COALESCE(with_check,'') LIKE '%metadata%')) THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: a policy on agent_memories or thoughts '
                    'still reads metadata. The column is the source of truth; the mirror is '
                    'not a trust decision.';
  END IF;

  -- (d) THE ABSENT WRITE IS REJECTED BY THE DATABASE
  BEGIN
    INSERT INTO public.thoughts (content, metadata)
      VALUES ('H3-SELFTEST-ABSENT (rolled back)', '{"exposure":"ops"}'::jsonb);
    v_ok := TRUE;
  EXCEPTION WHEN not_null_violation THEN
    v_ok := FALSE;
  END;
  IF v_ok THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: an INSERT that OMITS exposure was '
                    'ACCEPTED. The label is not enforced at write time and H3 is not met. '
                    '(Note the jsonb mirror said ops - a mirror is not a constraint.)';
  END IF;

  -- (e) THE MALFORMED WRITE IS REJECTED BY THE DATABASE
  BEGIN
    INSERT INTO public.thoughts (content, exposure)
      VALUES ('H3-SELFTEST-MALFORMED (rolled back)', 'opsy');
    v_ok := TRUE;
  EXCEPTION WHEN check_violation THEN
    v_ok := FALSE;
  END;
  IF v_ok THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: an INSERT with exposure=''opsy'' was '
                    'ACCEPTED. The CHECK is not doing anything and H3 is not met.';
  END IF;

  -- (f) the same on agent_memories, because two tables are two places a rule can be missing
  BEGIN
    INSERT INTO public.agent_memories (workspace_id, memory_type, summary, content, metadata)
      VALUES ('h3-selftest','decision','H3-SELFTEST-ABSENT (rolled back)',
              'H3-SELFTEST-ABSENT (rolled back)','{"exposure":"ops"}'::jsonb);
    v_ok := TRUE;
  EXCEPTION WHEN not_null_violation THEN
    v_ok := FALSE;
  END;
  IF v_ok THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: an agent_memories INSERT that OMITS '
                    'exposure was ACCEPTED.';
  END IF;
  BEGIN
    INSERT INTO public.agent_memories (workspace_id, memory_type, summary, content, exposure)
      VALUES ('h3-selftest','decision','H3-SELFTEST-MALFORMED (rolled back)',
              'H3-SELFTEST-MALFORMED (rolled back)','PERSONAL');
    v_ok := TRUE;
  EXCEPTION WHEN check_violation THEN
    v_ok := FALSE;
  END;
  IF v_ok THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: an agent_memories INSERT with '
                    'exposure=''PERSONAL'' was ACCEPTED - the CHECK is case-insensitive or '
                    'absent, and ''PERSONAL'' is not ''personal''.';
  END IF;

  RAISE NOTICE 'init-agent-memory-exposure-column: self-test passed - the DATABASE rejects an '
               'absent exposure (not_null_violation) and a malformed one (check_violation) on '
               'BOTH tables';
END $$;

-- 8b. Nothing above wrote a row. Asserted rather than assumed, because "it must have rolled
--     back" is exactly the class of belief this effort keeps paying for.
DO $$
DECLARE v_n INT;
BEGIN
  SELECT (SELECT count(*) FROM public.thoughts       WHERE content LIKE 'H3-SELFTEST-%')
       + (SELECT count(*) FROM public.agent_memories WHERE summary LIKE 'H3-SELFTEST-%')
    INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: % self-test row(s) survived. The '
                    'migration wrote fixtures into a real table.', v_n;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
