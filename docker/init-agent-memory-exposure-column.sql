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
-- never stated. The operator chose Option A precisely so that the producer states it.
--
-- AND NEITHER DOES THE DOOR (corrected 2026-08-31). An earlier version of this file said "a
-- DOOR may stamp its own forced value" and had `upsert_thought` COALESCE an absent, empty or
-- null exposure to 'ops'. That is a column default wearing a different hat: it hands a
-- forgetful producer a silent success on the wider plane, one layer up, which is exactly what
-- section 8(b) below FAILS this migration for when the column carries a DEFAULT - the file
-- contradicted itself, and C.9 H3 sides with 8(b) ("a writer that does not supply the column
-- is rejected by the CHECK, which is the point"). Section 7 now REFUSES absent/null/empty and
-- every non-plane string, and every producer THAT WAS FOUND states its plane at its own call
-- site. That qualifier is load-bearing and is not decoration: the found set is ten RPC callers
-- (grep) plus twelve direct-table producers (the pre-commit check, within the shapes it
-- recognises), and neither method can return a producer it cannot see - which is the whole
-- lesson of this section. The completeness that matters is section 7's REFUSAL, which does not
-- depend on anybody having found the caller.
--
-- PLAN section 1.1's "lane stamping happens at doors, not by writers" still holds and is not
-- what was wrong here. A stamping door is one that KNOWS its caller's plane and FORCES it
-- regardless of what the caller asked for - `stampExposure()` on the agent-memory doors, whose
-- unstated default is 'personal', the NARROW end, and which can only ever demote. A door that
-- fills in the WIDE plane for a caller that said nothing is not stamping; it is guessing.
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
--   7. Re-point the corpus DOOR (`upsert_thought`) at the column, and make it REQUIRE the
--      plane rather than default one.
--  7b. Re-point the LAST READER of the jsonb mirror - `queue_entity_extraction()`, the
--      SECURITY DEFINER trigger that carries a content fingerprint out of the corpus - at the
--      column too, and widen its trigger's column list to fire on `exposure`. Neither changes
--      what any caller can SEE; both change what a desynced mirror could do.
--   8. POST-CONDITIONS, including the migration attacking itself: an absent write and a
--      malformed write are attempted and both must be rejected BY THE DATABASE; the DOOR is
--      attacked with twelve non-plane payloads; and the database is scanned for any remaining
--      reader of the mirror. Any of them failing fails this migration.
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
-- with narrower-or-equal ones of the same shape; redefines two function bodies
-- (`upsert_thought`, `queue_entity_extraction`) and re-creates one trigger with a WIDER column
-- list (`trg_queue_entity_extraction`, which fires more often, never less). It DROPS NOTHING
-- that holds data - no table, no column, no row, and no function. The jsonb predicates `ob_memory_on_ops_plane(jsonb)` and
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
-- 7. THE CORPUS DOOR - upsert_thought REQUIRES the plane and never invents one
-- ==========================================================================================
-- `upsert_thought(p_content, p_payload)` is the shared write door for the wiki synthesis,
-- entity-wiki dossiers and every import recipe (grok, instagram, blogger, x/twitter, gmail),
-- all of which reach it over PostgREST rpc as `service_role`. It inserts into `thoughts`, so
-- under NOT NULL it MUST supply the column or every one of those callers breaks - which is
-- the write-contract change C.9 says is the intent.
--
-- IT USED TO COERCE, AND THAT WAS THIS FILE CONTRADICTING ITSELF. The first version of this
-- section read
--
--     v_exp := COALESCE(NULLIF(v_meta->>'exposure', ''), 'ops');
--
-- so `{}`, `{"exposure":""}` and `{"exposure":null}` all silently became 'ops'. Measured on a
-- throwaway built from this exact initdb chain, 2026-08-31: all three wrote a row, all three
-- landed on the WIDER plane, and the header's claim that "anything else is REFUSED here
-- rather than silently coerced, so a typo is a loud failure at the door" was half false -
-- `' '` and `'PERSONAL'` were refused, absent/empty/null were not.
--
-- Section 8(b) below FAILS this migration if the COLUMN carries a DEFAULT, on the stated
-- grounds that "a writer that omits the column would then succeed silently on a plane it
-- never stated". The COALESCE implemented that exact semantics one layer up, at the door.
-- C.9 H3 sides with 8(b): "a writer that does not supply the column is rejected by the CHECK,
-- which is the point", and the operator's ruling is "forcing every producer to state exposure
-- explicitly is the intent, not a side effect". So the door no longer defaults.
--
-- WHAT IS REFUSED NOW, ALL OF IT LOUDLY AND AT THE DOOR:
--   absent, JSON null      -> not_null_violation ("state it at the call site")
--   '', ' ', 'ops ', 'OPS' -> check_violation    (a non-plane string is a typo, not a default)
--   'personal'             -> check_violation, with the reason, see below
-- and 'ops' is the only accepted value.
--
-- THE RPC CALLERS STATE THEIR PLANE, IN THEIR OWN CODE. Every caller OF THIS FUNCTION was
-- found and given an explicit `exposure: 'ops'` in the metadata it passes, so the choice is
-- visible where the producer lives instead of hidden in a COALESCE here.
--
-- SAY WHAT WAS SWEPT, NOT WHAT WAS HOPED. This paragraph used to open "Every caller of this
-- rpc in the tree was found", and then the section read as if that were the producer set. It
-- is not: the sweep was `grep -rn 'rpc("upsert_thought"' OB1`, so it could only ever return
-- RPC callers, and the DIRECT-table producers were never searched for. There are twelve of
-- them - they POST at `/rest/v1/thoughts` or call `supabase.from("thoughts").insert()`, and
-- this door is not in front of any of them. `openbrain-gmail-pull` is one, it runs daily, and
-- it had been refused `42501 new row violates row-level security policy` by U5's already-live
-- ops-plane policy since the day that policy landed (measured 2026-08-31). The same alphabet
-- error as A2's `.ts`-only scan root: THE SEARCH TERM DEFINED THE FINDING.
--
-- The direct producers now state their plane at their own call sites, and the set is no
-- longer kept by hand: `scripts/checks/check-corpus-exposure-producers.ps1` (ai-stack
-- pre-commit) DERIVES the corpus-insert sites from the tree on every commit - WITHIN THE
-- SHAPES IT RECOGNISES, which is the whole of its scope - and fails on one that omits
-- `exposure`. See documentation/notes/u5-live-producer-rls-regression.md.
--
-- BUT THAT CHECK IS NOT THE ENFORCEMENT, AND THIS PARAGRAPH USED TO SAY IT WAS. It said
-- "producer thirteen breaks the build rather than production", which is FALSE, and false in
-- the same shape as the sweep two paragraphs up: it presented what a search could see as
-- what exists. Two verifiers planted producers the check did not recognise - a table name
-- held in a variable, a concatenated path, a helper wrapper, a `.tsx` copy, a `curl -X POST`
-- in a `.sh`, supabase-py `.table().insert()` - and none of them was flagged or even counted.
--
-- THE CHECK HAS SINCE BEEN WIDENED AND THAT SENTENCE MUST BE DATED, NOT REPEATED. Those
-- verdicts were true at ai-stack `819b5fe`; the widening landed in `c192041`. Re-measured
-- 2026-08-31 at `5c81f97`, one unlabelled fixture per shape: the helper wrapper, both
-- byte-identical copies, the `curl -X POST` in a `.sh` and supabase-py `.table().insert()`
-- are all now FLAGGED and COUNTED. What is still missed is the table name held in a VALUE -
-- a variable or a concatenation - and even that is decided by LAYOUT, not by shape: the check
-- resolves no values, so it sees the literal only when it lands within two lines of a verb
-- (flagged adjacent, ZERO SITES at three to five lines apart - measured both ways).
--
-- NONE OF WHICH CHANGES THE CONCLUSION, WHICH IS THE POINT. Producer thirteen, written in a
-- shape that check cannot see, still breaks PRODUCTION. A wider alphabet moves the boundary;
-- it does not remove one. The check also prints, on every run, the CATEGORY of text that can
-- clear a site it DID count - any occurrence of the key that is not that statement's own
-- declaration, of which type annotations, sibling objects, string literals, SQL text and
-- comment continuations are measured instances and not an exhaustive list.
--
-- THE ENFORCEMENT IS THIS FILE. Sections 5 and 6 make `exposure` NOT NULL with no default
-- and CHECKed, and section 7 makes this function refuse a payload that omits it. Those
-- refuse an unlabelled write in every shape, from every language, forever. The pre-commit
-- check is authoring-time convenience that moves SOME of those refusals earlier, and it
-- prints its own blind spots on every run so nobody has to take its coverage on trust.
--
-- AND THE REFUSAL IS QUIET, WHICH IS WHY THE CONVENIENCE IS WORTH HAVING. Both producers
-- that were failing CAUGHT the 42501 and carried on: `openbrain-gmail-pull` logged
-- `Ingested: 0 email(s)` and exited 0 for a day. Fail-closed is not fail-visibly.
--
-- THE RPC CALL SITES (`grep -rn 'rpc("upsert_thought"' OB1` - ten, 2026-08-31):
--   recipes/entity-wiki/generate-wiki.mjs          - the ONLY scheduled producer (openbrain-wiki)
--   recipes/wiki-synthesis/scripts/backfill-gmail-wikis.mjs
--   recipes/grok-export-import/import-grok.mjs
--   recipes/instagram-import/import-instagram.mjs
--   recipes/journals-blogger-import/import-blogger.mjs
--   recipes/x-twitter-import/import-x-twitter.mjs
--   recipes/repo-learning-coach/server/brain.ts
--   integrations/open-brain-rest/index.ts          - not built by any compose service
--   integrations/agent-memory-api/index.ts         - not built by any compose service
--   server/index.ts                                - not built by any compose service
--
-- AND IT WRITES ONE PLANE. `'personal'` used to be honoured here as a "demotion", on the
-- grounds that narrowing is always allowed. Measured on the throwaway, that is not something
-- this door can deliver: `thoughts_personal_plane` is granted TO `ob_plane_personal` and
-- requires `user_id = ob_current_user_id()`, and this door has neither. A BOUND connection's
-- personal insert through it is refused 42501 by the WITH CHECK ("new row violates row-level
-- security policy for table thoughts"); a SUPERUSER connection's succeeds only by bypassing
-- the boundary, and writes a row with `user_id IS NULL` that no personal-plane session can
-- ever read. Both outcomes are worse than a refusal, and the refusal is the one that names
-- the real path. Narrowing an EXISTING corpus row is not an `upsert_thought` operation at all
-- and this door no longer implies that it is - see the findings note for that gap.
--
-- THE MIRROR CANNOT DISAGREE WITH THE COLUMN, ON EITHER BRANCH. The previous version's
-- UPDATE branch merged `jsonb_build_object('exposure', v_exp)` into `metadata` while
-- deliberately NOT touching the column, which desynced them in BOTH directions (measured):
-- re-upserting a personal row with no exposure key gave column='personal', mirror='ops', and
-- demoting an ops row gave column='ops', mirror='personal'. Now the INSERT branch writes both
-- from one value, and the UPDATE branch forces the mirror to the row's ACTUAL column value in
-- the same statement - which also REPAIRS a row that arrived here already disagreeing.
--
-- The UPDATE branch still does not re-decide the plane: an existing row's plane is not
-- changed by a content-fingerprint match. Widening by re-upsert would be a widening path, and
-- PLAN 1.1 puts the only widening path behind human review (`promote_exposure`).
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
  v_exp  TEXT  := v_meta->>'exposure';
  v_row  public.thoughts;
BEGIN
  -- STATE YOUR PLANE. An absent key and a JSON null both arrive here as SQL NULL; '' and
  -- ' ' arrive as themselves. None of them is a plane, and none of them is defaulted.
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
    -- The caller's own `exposure` key is stripped from the merge and the mirror is written
    -- from `v_row.exposure` - the COLUMN, the source of truth - so this statement cannot
    -- leave the two disagreeing whatever the caller sent or whatever the row arrived as.
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
-- 7b. THE LAST READER OF THE MIRROR, AND THE TRIGGER THAT MISSED THE TRANSITION
-- ==========================================================================================
-- THE MIRROR IS NOT A TRUST DECISION, SO NOTHING MAY READ IT. Section 6 moved the two
-- POLICIES onto the column. It left one reader behind, and it is the one that matters most:
--
--   `queue_entity_extraction()` - AFTER INSERT OR UPDATE ON thoughts, SECURITY DEFINER -
--   gates entity extraction on `ob_corpus_on_ops_plane(NEW.metadata)`. Measured on the LIVE
--   openbrain-db 2026-08-31, it is the ONLY function body in the database that reads the
--   mirror (a pg_proc scan over prosrc for 'metadata%exposure' and for 'on_ops_plane': one
--   hit, this one). PROMOTION-RUNBOOK.md's argument for why 195- does not conflict with the
--   round-1 200- still on the live volume rested on "the round-1 write gate reads the jsonb
--   mirror, which every writer keeps in step with the column" - a premise about writer
--   discipline, falsified by the door this very file was shipping. A gate that reads a mirror
--   is a gate a desync can fool, and the desync in the direction column='personal' /
--   mirror='ops' would have QUEUED a personal-plane thought's content fingerprint for entity
--   extraction, which is a carry across the boundary.
--
-- So the argument stops being a premise and becomes a property: the gate reads the COLUMN,
-- here, in the same transaction that creates it, and section 8(d) asserts that no function
-- body and no policy in the database reads the mirror for a trust decision afterwards. The
-- body below is IDENTICAL to 200-init-graph-plane-rls.sql section 4's, so applying 200- after
-- this is a no-op on this function rather than a second opinion. (COALESCE(..., false) is
-- load-bearing, and the reasoning is 200's: the predicate is three-valued and `NOT NULL` is
-- NULL, which an IF treats as not-taken.)
--
-- AND THE TRIGGER'S COLUMN LIST WAS WRONG THE MOMENT THE COLUMN EXISTED. init-graph.sql
-- declares it `AFTER INSERT OR UPDATE OF content, metadata`. 200-'s own TRIGGER-DISPOSITION
-- comment claims "an ops-to-personal transition deletes the existing one" - but once the
-- plane lives in a COLUMN, the only way to make that transition is `UPDATE thoughts SET
-- exposure='personal'`, which touches NEITHER content NOR metadata and therefore does not
-- fire the trigger at all. RED, measured on the throwaway 2026-08-31: insert an ops thought
-- (1 queue row), demote it by updating only the column, and the queue row is STILL THERE,
-- carrying sha256 of a now-personal thought's content. Adding `exposure` to the column list
-- is what makes 200's claim true; without it, re-pointing the gate at the column would have
-- made this file's gate weaker than the one it replaced.
DO $$
BEGIN
  IF to_regprocedure('public.queue_entity_extraction()') IS NULL THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: queue_entity_extraction() is missing. '
                    'It is created by 040-init-graph.sql; this file re-points it and does not '
                    'invent it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_queue_entity_extraction'
                    AND tgrelid = 'public.thoughts'::regclass) THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: trg_queue_entity_extraction is missing '
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

DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
CREATE TRIGGER trg_queue_entity_extraction
  AFTER INSERT OR UPDATE OF content, metadata, exposure ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_entity_extraction();

-- ==========================================================================================
-- 8. POST-CONDITIONS - and the migration ATTACKS ITSELF before it commits
-- ==========================================================================================
-- A migration that only asserts what it wrote is a migration that reports on itself. These
-- assert the PROPERTY the operator asked for: the DATABASE, not application code, rejects an
-- absent and a malformed exposure. Each attempt runs inside a plpgsql BEGIN...EXCEPTION
-- block, which is an implicit savepoint, so a rejected statement leaves nothing behind; the
-- migration FAILS if any of them succeeds, and section 8e proves nothing was written.
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

-- 8c. THE DOOR ATTACKS ITSELF TOO, because section 8 above attacks the TABLE and the door is
--     a second place the same rule can be missing - and was. Every case below is a call to
--     the real `upsert_thought`, not a restatement of its body; each runs inside its own
--     plpgsql BEGIN...EXCEPTION (an implicit savepoint), so a refusal leaves nothing behind,
--     and the accepted case is UNWOUND deliberately by raising a private errcode after the
--     assertions have been read into variables. 8e then proves nothing survived.
DO $$
DECLARE
  v_ok   BOOLEAN;
  v_col  TEXT;
  v_mir  TEXT;
  v_id   BIGINT;
  v_case TEXT;
BEGIN
  -- (a) EVERY WAY OF NOT STATING A PLANE IS REFUSED. The first three are the ones the
  --     COALESCE used to swallow; the rest are the ones it already refused, kept so a future
  --     edit that re-introduces a default has to break all of them, not just one.
  FOREACH v_case IN ARRAY ARRAY[
      '{}',                                   -- absent
      '{"metadata":{}}',                      -- absent, with a metadata object
      '{"metadata":{"exposure":null}}',       -- JSON null
      '{"metadata":{"exposure":""}}',         -- empty string
      '{"metadata":{"exposure":" "}}',        -- whitespace
      '{"metadata":{"exposure":"ops "}}',     -- trailing space: NOT trimmed
      '{"metadata":{"exposure":" ops"}}',     -- leading space
      '{"metadata":{"exposure":"OPS"}}',      -- case: NOT folded
      '{"metadata":{"exposure":"Ops"}}',
      '{"metadata":{"exposure":"opsy"}}',     -- a prefix is not a plane
      '{"metadata":{"exposure":"\"ops\""}}',  -- quoted: a JSON-encoding mistake, not a plane
      '{"metadata":{"exposure":"personal"}}'  -- a plane, but NOT this door's
  ] LOOP
    BEGIN
      PERFORM public.upsert_thought('H3-SELFTEST-DOOR (rolled back) ' || v_case, v_case::jsonb);
      v_ok := TRUE;
    EXCEPTION WHEN not_null_violation OR check_violation THEN
      v_ok := FALSE;
    END;
    IF v_ok THEN
      RAISE EXCEPTION 'init-agent-memory-exposure-column: the corpus door ACCEPTED payload %. '
                      'upsert_thought is defaulting or coercing a plane the caller never '
                      'stated, which is the failure H3 exists to remove - and the same '
                      'failure section 8(b) rejects a column DEFAULT for.', v_case;
    END IF;
  END LOOP;

  -- (b) AND 'ops' IS ACCEPTED, or the door is not a door. The row's COLUMN and its MIRROR
  --     must both read 'ops' - one value, written by one statement.
  BEGIN
    SELECT r.id, r.exposure, r.metadata->>'exposure'
      INTO v_id, v_col, v_mir
      FROM public.upsert_thought('H3-SELFTEST-DOOR-OPS (rolled back)',
                                 '{"metadata":{"exposure":"ops","probe":"h3"}}'::jsonb) r;
    RAISE EXCEPTION 'H3-SELFTEST-UNWIND' USING ERRCODE = '22023';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF v_id IS NULL OR v_col IS DISTINCT FROM 'ops' OR v_mir IS DISTINCT FROM 'ops' THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: the corpus door did not write a clean '
                    'ops row (id=%, column=%, mirror=%). A door that refuses everything is '
                    'not containment, it is an outage.', v_id, v_col, v_mir;
  END IF;

  -- (c) THE TWO DESYNC CASES, RED-PROVEN AND NOW CLOSED. Both were measured against the
  --     previous body on a throwaway built from this chain:
  --       re-upsert a PERSONAL row with no exposure key -> column='personal', mirror='ops'
  --       demote an OPS row through the door             -> column='ops',      mirror='personal'
  --     The first is the dangerous direction: the round-1 entity-extraction gate reads the
  --     mirror on the live volume, so a personal row whose mirror says 'ops' gets its content
  --     fingerprint queued. Section 7b re-points that gate at the column; this asserts the
  --     door can no longer produce the disagreement in the first place.
  BEGIN
    INSERT INTO public.thoughts (content, metadata, exposure)
      VALUES ('H3-SELFTEST-DESYNC (rolled back)',
              '{"exposure":"personal"}'::jsonb, 'personal')
      RETURNING id INTO v_id;
    -- the ops producer re-upserts the same content, stating its own plane
    SELECT r.exposure, r.metadata->>'exposure' INTO v_col, v_mir
      FROM public.upsert_thought('H3-SELFTEST-DESYNC (rolled back)',
                                 '{"metadata":{"exposure":"ops"}}'::jsonb) r;
    -- and the demotion attempt, which must be REFUSED rather than half-applied
    BEGIN
      PERFORM public.upsert_thought('H3-SELFTEST-DESYNC (rolled back)',
                                    '{"metadata":{"exposure":"personal"}}'::jsonb);
      v_ok := TRUE;
    EXCEPTION WHEN check_violation THEN
      v_ok := FALSE;
    END;
    RAISE EXCEPTION 'H3-SELFTEST-UNWIND' USING ERRCODE = '22023';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF v_col IS DISTINCT FROM 'personal' OR v_mir IS DISTINCT FROM 'personal' THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: re-upserting a PERSONAL row through '
                    'the ops door left column=% mirror=%. The plane must not be re-decided by '
                    'a fingerprint match, and the mirror must follow the COLUMN - not the '
                    'caller.', v_col, v_mir;
  END IF;
  IF v_ok THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: the corpus door ACCEPTED a demotion to '
                    'the personal plane. It cannot deliver one (no ob_plane_personal role, no '
                    'user_id), so accepting it means desyncing the mirror or writing an '
                    'unreadable row - see section 7.';
  END IF;

  RAISE NOTICE 'init-agent-memory-exposure-column: door self-test passed - upsert_thought '
               'refuses 12 non-plane payloads including absent/null/empty, accepts only ops, '
               'and cannot leave the column and the mirror disagreeing';
END $$;

-- 8d. NOTHING IN THE DATABASE READS THE MIRROR FOR A TRUST DECISION. This is the assertion
--     that turns "the column is the source of truth" from a sentence in a header into a
--     property of the database - and it is the assertion whose absence let the runbook argue
--     from "every writer keeps the mirror in step", which was false.
--
--     Both surfaces are checked, because they fail differently: a POLICY's expression is
--     visible in pg_policies, while a plpgsql body is an opaque STRING to the planner and
--     records no pg_depend edge on the function it calls (200's section 9 pays for exactly
--     this). So the function scan is over prosrc TEXT, which is the only thing that sees a
--     caller inside a body.
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  -- WHITESPACE-INSENSITIVE AND ANCHORED ON THE ACTUAL READ, not on the two words appearing
  -- somewhere in the same expression. A loose `%metadata%exposure%` matched the re-pointed
  -- gate's own body on the first run of this scan (it reads metadata->>'generated_by' on one
  -- line and NEW.exposure twenty lines later) - a check that fires on code that is correct is
  -- a check nobody will keep.
  SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (SELECT replace(COALESCE(qual, '') || COALESCE(with_check, ''), ' ', ''))
         LIKE ANY (ARRAY['%metadata->>''exposure''%',
                         '%metadata->''exposure''%',
                         '%on_ops_plane(metadata)%',
                         '%on_ops_plane(NEW.metadata)%',
                         '%on_ops_plane(OLD.metadata)%']);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: policy/policies still read the jsonb '
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
    RAISE EXCEPTION 'init-agent-memory-exposure-column: function body/bodies still read the '
                    'jsonb mirror: %. Section 7b re-points the one this file knew about '
                    '(queue_entity_extraction); a new one has to be re-pointed too, not '
                    'exempted here.', v_bad;
  END IF;

  -- upsert_thought is the ONE deliberate exception, and only as a WRITER: it writes the
  -- mirror from the column and reads the caller's key to refuse it. Asserted, so the
  -- exemption above cannot quietly cover a body that starts making a decision on it.
  IF (SELECT COALESCE(prosrc, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'upsert_thought' LIMIT 1)
     LIKE '%on_ops_plane%' THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: upsert_thought now calls a plane '
                    'predicate. It is exempted from the mirror scan as a WRITER of the '
                    'mirror; it may not become a reader of it.';
  END IF;

  -- ...and the trigger that carries content out of the corpus fires on the COLUMN, or the
  -- ops-to-personal transition leaves its fingerprint behind (RED measured, section 7b).
  IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
         WHERE t.tgname = 'trg_queue_entity_extraction'
           AND t.tgrelid = 'public.thoughts'::regclass
           AND pg_get_triggerdef(t.oid) LIKE '%exposure%') THEN
    RAISE EXCEPTION 'init-agent-memory-exposure-column: trg_queue_entity_extraction does not '
                    'fire on UPDATE OF exposure, so demoting a thought by updating only the '
                    'column leaves its content fingerprint in entity_extraction_queue.';
  END IF;

  -- SAY WHAT THE SCAN PROVED, WHICH IS NARROWER THAN "ZERO READERS". The two RETIRED jsonb
  -- overloads - ob_memory_on_ops_plane(md jsonb) and ob_corpus_on_ops_plane(md jsonb) - read
  -- the mirror BY CONSTRUCTION (their bodies ARE `md->>''exposure''`), and they are kept on
  -- purpose because the 190/200 revert paths recreate policies that call them. They are
  -- invisible to the scan above: its anchors are the literal `metadata->>''exposure''` and
  -- `on_ops_plane(metadata)`, and `md->>''exposure''` matches neither. So "the mirror has
  -- zero readers" was a claim the scan could not make, printed as if it had.
  --
  -- The SUBSTANCE is covered - init-graph-plane-rls.sql section 9 asserts over pg_depend AND
  -- over every function body that NOTHING CALLS those two, with a positive control that they
  -- still exist so the sweep cannot pass vacuously. That is the property that matters; this
  -- notice now states its own scope instead of borrowing section 9's conclusion.
  RAISE NOTICE 'init-agent-memory-exposure-column: no POLICY and no function body other than '
               'the two retired jsonb predicates reads the mirror for a trust decision. Those '
               'two read it by construction and are kept for the revert paths; that NOTHING '
               'CALLS them is asserted by init-graph-plane-rls.sql section 9, not here';
END $$;

-- 8e. Nothing above wrote a row - LAST, so it covers 8, 8c and 8d. Asserted rather than
--     assumed, because "it must have rolled back" is exactly the class of belief this
--     effort keeps paying for.
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
