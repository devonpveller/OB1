-- init-graph-plane-rls.sql
--
-- THE EXPOSURE BOUNDARY, EXTENDED TO THE DERIVED GRAPH.
--
-- ==========================================================================================
-- WHY THIS FILE EXISTS
-- ==========================================================================================
-- 180-init-agent-memory-rls.sql moved the exposure boundary into the database for
-- `agent_memories`, `thoughts` and the eight `agent_memory_*` sidecars. It did not reach the
-- tables the graph layer DERIVES from `thoughts`, and those were still carrying the wide
-- policies init-graph.sql / init-source-graph.sql / init-ideas.sql shipped:
--
--     relname                  rls  force  policies  permissive USING(true)
--     consolidation_log        t    f      2         2
--     edges                    t    f      2         2
--     entities                 t    f      2         2
--     entity_extraction_queue  t    f      2         2
--     source_entities          t    f      2         2
--     thought_edges            t    f      1         1
--     thought_entities         t    f      2         2
--     idea_revisions           t    f      2         2      <- FK to thoughts; on nobody's list
--
-- (measured on the live database 2026-08-31, pg_class + pg_policies)
--
-- THE PROVEN DISCLOSURE, and it is precise. `entity_extraction_queue.source_fingerprint` is
-- `encode(digest(thoughts.content,'sha256'),'hex')` - the trigger in section 4 copies it
-- verbatim. Measured on the live database 2026-08-31 inside a rolled-back transaction:
--
--     INSERT a thought with metadata.exposure='personal'
--     SET ROLE service_role;
--     SELECT count(*) FROM thoughts WHERE content LIKE 'U5GRAPH-RED-PROBE%'  ->  0
--     SELECT thought_id, source_fingerprint FROM entity_extraction_queue ...  ->  13633 |
--         99f36c82857e72d9f5a68194ce87ab898e0f5e3dabbc9c1c02877608253a4472
--     SELECT encode(digest('<that content>','sha256'),'hex')                 ->  the same hex
--
-- So the agent plane - and every unauthenticated caller on `open-brain_obnet`, because
-- PostgREST's PGRST_DB_ANON_ROLE IS `service_role` - could enumerate the EXISTENCE of a
-- personal thought, read a CONTENT HASH of it, and confirm any guess by hashing it. A hash
-- is a disclosure.
--
-- WHAT IS *NOT* CLAIMED, because the difference matters. The content-shaped columns on these
-- tables - `thought_entities.evidence` (jsonb), `source_entities.evidence` (text),
-- `consolidation_log.details` (jsonb), `entity_extraction_queue.last_error` and `.metadata` -
-- are EMPTY in current production data. Today's measured disclosure is the fingerprint, the
-- row's existence, and its timestamps. Those columns are content-shaped BY DESIGN, which is
-- why governance must cover them; they are not leaking verbatim content today and this file
-- does not say they are.
--
-- ==========================================================================================
-- THE TARGET SET IS DERIVED FROM THE SCHEMA, AND AN UNCLASSIFIED TABLE IS A FAILURE
-- ==========================================================================================
-- A hand-written list is a list with a spell-checker - this effort's own ruling, and it has
-- already been paid twice on this very set. The operator's list named SIX tables; the schema
-- said SEVEN (`source_entities` has the identical shape and was not on it); deriving it here
-- said EIGHT (`idea_revisions` carries `thought_id REFERENCES thoughts(id)`, a `summary TEXT`
-- and a `content_hash TEXT`, and appeared on nobody's list).
--
-- Section 0 therefore COMPUTES its target set from pg_constraint at apply time and RAISES if
-- the computed set contains a table this file does not classify. Add a foreign key into
-- `thoughts` or `agent_memories` tomorrow and this migration goes RED on its next replay
-- instead of quietly leaving the new table ungoverned.
--
-- ==========================================================================================
-- WHAT THIS FILE CANNOT DO, STATED HERE RATHER THAN DISCOVERED LATER
-- ==========================================================================================
-- RLS DOES NOT BIND A SUPERUSER, with or without FORCE. Eight openbrain-* containers connect
-- to openbrain-db as `postgres`, which is both owner and superuser, and they are exempt.
-- What IS bound is every caller arriving through PostgREST, because PostgREST SETs ROLE to
-- `service_role` before it runs the request - and that is the whole unauthenticated surface
-- on `open-brain_obnet`, which is where the disclosure above was measured. The superuser
-- connections are a named follow-on; see documentation/notes/u5graph-findings.md.
--
-- ==========================================================================================
-- ADDITIVE AND REVERSIBLE
-- ==========================================================================================
-- Replaces fifteen wide `USING (true)` policies with narrower ones of the same shape, sets
-- FORCE ROW LEVEL SECURITY on eight tables, revokes TRUNCATE/REFERENCES/TRIGGER from the read
-- path, adds one function, and changes three function BODIES. It DROPS NOTHING that holds
-- data - no table, no column, no row. REVERT: revert-graph-plane-rls.sql beside this file
-- restores the previous policies, clears FORCE, re-grants, and restores the three function
-- bodies verbatim from init-graph.sql.
--
-- TWO PLACES, ALWAYS: mounted in the initdb chain at 200- for fresh volumes, AND applied to
-- the live volume per
-- documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md. A migration
-- that reaches only one place is not deployed.
--
-- ORDERING: 200, after 190-init-agent-memory-corpus-failclosed.sql, because the policies
-- below call `ob_corpus_on_ops_plane` and the write gate in section 4 is only a gate if that
-- predicate is FAIL-CLOSED. Section 0 refuses to run if it is still fail-open.

BEGIN;

-- ==========================================================================================
-- 0a. THE GOVERNED-NESS PREDICATE - ONE definition, and every arm below calls IT
-- ==========================================================================================
-- WHY THIS FUNCTION EXISTS, and it is a defect report against the FIRST version of this file.
-- Section 0 presents its target set as DERIVED and says an unclassified table is a failure.
-- That was half true. The REFERENCED-BY arm applied a real predicate to the tables it found
-- (RLS enabled AND forced AND no permissive USING(true) policy), but the CLOSURE arm
-- classified eight members by membership of a hardcoded name array, `v_governed_180`, and
-- never tested one of them. A reviewer's formulation is exact: "the gate is derived for
-- tables OUTSIDE the closure and a spell-checked list for tables INSIDE it."
--
-- Apply the referenced-by arm's own predicate to its own closure and it turns RED:
-- `agent_memory_audit_events` is rls=true, force=true, AND carries a policy whose USING is
-- literally `true`. FORCE was on and the policy still permitted everything, which is why
-- reading `relforcerowsecurity` alone did not catch it.
--
-- MEASURED on the live database 2026-08-31, in a rolled-back transaction, with an ops
-- positive control at every step:
--
--     SET ROLE service_role;   -- = PGRST_DB_ANON_ROLE, the unauthenticated obnet caller
--     SELECT summary FROM agent_memories WHERE summary LIKE 'U5GRAPH-R1-%';
--        -> 1 row, the OPS control only            (the boundary HOLDS on the base table)
--     SELECT memory_id, event_type, payload, created_at
--       FROM agent_memory_audit_events WHERE memory_id IN (<personal>, <ops>);
--        -> BOTH rows                              (the boundary does NOT hold here)
--
-- WHAT IS AND IS NOT DISCLOSED, because the difference decides the fix and a claim wider
-- than its evidence is its own defect class. The audit row hands an unauthenticated caller
-- the hidden memory's ID, its event history, its timestamps, and whatever free text a writer
-- put in `payload` - this repo's own scripts/checks/recall-sibling-class.ps1 writes an
-- operator-authored `note` there. It does NOT hand over `summary` or `content`: those are
-- columns of `agent_memories`, and the same probe's LEFT JOIN back to them returned NULL for
-- the personal row while returning both values for the ops control. Existence, identity, and
-- an operator's note - not the memory's text.
--
-- THE MECHANISM, not just the instance. Before writing this, the round asked the memory plane
-- (scripts/checks/recall-sibling-class.ps1, trace 65f57a92-74a5-4711-b2ba-27c5c87d40f4) and
-- was handed exactly this class: memory b6af0900-8fb9-43e9-a315-9572949e155a - "a defect is
-- not fixed when its instance is fixed; it is fixed when the artifact has been SWEPT for its
-- shape" - whose fifth recorded instance is "a normaliser written for ONE reader, three
-- readers left raw IN THE SAME FILE". That is this file, precisely. So the predicate is
-- EXTRACTED here and all three readers call it: the closure arm, the referenced-by arm, and
-- the section 7 post-condition. A fourth reader that re-implements it is the next instance.
--
-- CONSERVATISM IS DELIBERATE. `qual IS NULL` counts as wide, which also flags a FOR INSERT
-- policy (whose qual is always NULL). No such policy exists on these tables today, and a
-- predicate that fails CLOSED is the correct error direction for a boundary gate.
CREATE OR REPLACE FUNCTION public.ob_relation_governed(p_relname TEXT) RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
           SELECT 1 FROM pg_class c
            WHERE c.oid = to_regclass('public.' || p_relname)
              AND c.relrowsecurity AND c.relforcerowsecurity)
     AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = p_relname
              AND p.permissive = 'PERMISSIVE'
              AND (p.qual IS NULL OR btrim(p.qual) = 'true'))
$$;

-- ==========================================================================================
-- 0. DERIVE THE TARGET SET, AND REFUSE TO PROCEED IF ANYTHING IN IT IS UNCLASSIFIED
-- ==========================================================================================
-- THE DERIVATION, in two arms, because the graph is reached two different ways:
--
--   ARM 1 - FK DESCENDANTS OF THE PROTECTED CORPUS. Start from {thoughts, agent_memories}
--     and repeatedly add every table with a FOREIGN KEY pointing INTO the set. CHILDREN
--     only: a PARENT of an in-scope table is not pulled in, or the closure walks out through
--     `sources` and swallows the whole schema.
--
--   ARM 2 - CONTENT DERIVED WITHOUT A FOREIGN KEY. `entities` rows do not reference
--     `thoughts`; they are MANUFACTURED from `thoughts.content` by the entity-extraction
--     worker and joined back through `thought_entities`. That is derivation with no
--     constraint to detect it, so it is DECLARED here with its reason and its own FK
--     descendants are then closed over. Each declared entry is checked to EXIST, because a
--     typo in this list must not silently shrink the set.
--
-- Every member of the union is then classified into exactly one bucket, and a member in no
-- bucket RAISES. That is the difference between a derived gate and a list with a
-- spell-checker: this one goes red when the schema grows a case nobody told it about.
DO $$
DECLARE
  v_seed         TEXT[] := ARRAY['thoughts','agent_memories'];
  -- ARM 2, declared with a reason each. The reason is not decoration: an entry nobody can
  -- justify is an entry that should be removed rather than carried.
  --   entities          - rows manufactured from thoughts.content by the extraction worker
  --   consolidation_log - entity merge journal; survivor_id/loser_id ARE entities.id with no
  --                       FK to enforce it, and `details` is content-shaped jsonb
  v_declared     TEXT[] := ARRAY['entities','consolidation_log'];
  v_closure      TEXT[];
  v_prev_count   INT := -1;
  -- GOVERNED BY 180 - and now VERIFIED to be, not assumed. `agent_memory_audit_events` was
  -- the eighth member of this array and is deliberately NOT here any more: it FAILS
  -- ob_relation_governed(), so this file governs it itself in section 2b and classifies it
  -- as v_tier_a2. Being named in a list was never evidence of being governed.
  v_governed_180 TEXT[] := ARRAY[
      'agent_memories','agent_memory_source_refs','agent_memory_artifacts',
      'agent_memory_relations','agent_memory_review_actions','agent_memory_recall_traces',
      'agent_memory_recall_items'];
  -- Closure members that 180 left wide and THIS file closes (section 2b).
  v_tier_a2      TEXT[] := ARRAY['agent_memory_audit_events'];
  v_tier_a       TEXT[] := ARRAY[
      'thought_entities','entity_extraction_queue','thought_edges','idea_revisions'];
  v_tier_b       TEXT[] := ARRAY['entities','edges','source_entities','consolidation_log'];
  v_unclassified TEXT[];
  v_missing      TEXT[];
  v_t            TEXT;
BEGIN
  SELECT array_agg(d ORDER BY d) INTO v_missing
    FROM unnest(v_declared) AS d
   WHERE to_regclass('public.' || d) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: declared derived table(s) do not exist: %. The '
                    'declaration list is wrong, and a wrong list makes the target set '
                    'smaller without saying so.', array_to_string(v_missing, ', ');
  END IF;

  IF to_regprocedure('public.ob_corpus_on_ops_plane(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: public.ob_corpus_on_ops_plane(jsonb) is not '
                    'defined. Apply 180-init-agent-memory-rls.sql and '
                    '190-init-agent-memory-corpus-failclosed.sql first.';
  END IF;
  IF public.ob_corpus_on_ops_plane('{}'::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'init-graph-plane-rls: ob_corpus_on_ops_plane() still returns TRUE for an '
                    'UNLABELLED row, so it is fail-OPEN. Apply '
                    '190-init-agent-memory-corpus-failclosed.sql first: the write gate in '
                    'section 4 would otherwise admit every unlabelled thought by default.';
  END IF;

  v_closure := v_seed || v_declared;
  WHILE array_length(v_closure, 1) IS DISTINCT FROM v_prev_count LOOP
    v_prev_count := array_length(v_closure, 1);
    SELECT array_agg(DISTINCT t) INTO v_closure
      FROM (
        SELECT unnest(v_closure) AS t
        UNION
        SELECT c.conrelid::regclass::text
          FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.connamespace = 'public'::regnamespace
           AND c.confrelid::regclass::text = ANY (v_closure)
      ) s;
  END LOOP;

  -- THE ARM THAT WAS A SPELL-CHECKED LIST, now a measurement. Every table this file
  -- classifies as "already governed by 180" must satisfy the SAME predicate the
  -- referenced-by arm applies to tables outside the closure. Until this block existed,
  -- `agent_memory_audit_events` sat in v_governed_180 carrying a USING(true) policy and was
  -- waved straight through the gate that exists to catch exactly that.
  SELECT array_agg(t ORDER BY t) INTO v_unclassified
    FROM unnest(v_governed_180) AS t
   WHERE NOT public.ob_relation_governed(t);
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: table(s) classified here as ALREADY GOVERNED by '
                    '180 do not satisfy the governed-ness predicate: %. A name in a list is '
                    'not a governed table. Either 180 regressed, or this file is classifying '
                    'a table it should be governing itself - as it was doing for '
                    'agent_memory_audit_events.', array_to_string(v_unclassified, ', ');
  END IF;

  SELECT array_agg(t ORDER BY t) INTO v_unclassified
    FROM unnest(v_closure) AS t
   WHERE NOT (t = ANY (v_seed))
     AND NOT (t = ANY (v_governed_180))
     AND NOT (t = ANY (v_tier_a2))
     AND NOT (t = ANY (v_tier_a))
     AND NOT (t = ANY (v_tier_b));
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: % table(s) derive from the protected corpus and '
                    'this migration does not classify them: %. This is the failure this '
                    'section exists to cause. Classify each one - govern it here, or register '
                    'it with a reason - and re-run. Do not delete this check.',
                    array_length(v_unclassified, 1), array_to_string(v_unclassified, ', ');
  END IF;

  SELECT array_agg(t ORDER BY t) INTO v_missing
    FROM unnest(v_tier_a || v_tier_a2 || v_tier_b) AS t
   WHERE NOT (t = ANY (v_closure));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: this migration governs %, which the schema-derived '
                    'closure does NOT contain. The list and the schema disagree, and the '
                    'schema is the authority.', array_to_string(v_missing, ', ');
  END IF;

  -- THE OTHER DIRECTION, which the closure above deliberately does not walk. The closure
  -- follows CHILD -> PARENT-in-set, so a table that a closure member REFERENCES is outside
  -- it - and `agent_memory_recall_traces` is exactly that shape: it is a parent of
  -- agent_memory_recall_items, it holds a recall's query text, and no child-closure would
  -- ever find it. It happens to be governed by 180. The next one might not be.
  --
  -- So every referenced-but-outside table must be EITHER already governed (RLS forced, no
  -- permissive USING(true)) OR registered below as a separate corpus with a reason. A new
  -- parent that is neither turns this migration RED.
  --   sources - the research corpus. No exposure label, no agent-memory mirror, no FK into
  --             thoughts/agent_memories. Its own governance is a separate item; see
  --             documentation/notes/u5graph-findings.md.
  --   ideas   - the idea refinery's own table. Same reasoning; its DERIVED half
  --             (idea_revisions, which carries thought_id) IS governed here.
  SELECT array_agg(DISTINCT parent ORDER BY parent) INTO v_unclassified
    FROM (
      SELECT c.confrelid::regclass::text AS parent
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.connamespace = 'public'::regnamespace
         AND c.conrelid::regclass::text = ANY (v_closure)
         AND NOT (c.confrelid::regclass::text = ANY (v_closure))
    ) q
   WHERE parent NOT IN ('sources','ideas')
     -- SAME predicate as the closure arm above and the section 7 post-condition. It used to
     -- be spelled out inline right here, which is how the closure arm was able to drift away
     -- from it without anyone noticing.
     AND NOT public.ob_relation_governed(parent);
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: % table(s) are REFERENCED BY the derived closure, '
                    'are outside it, and are neither governed nor registered as a separate '
                    'corpus: %. A parent of a governed table is a content home the child '
                    'closure cannot see.',
                    array_length(v_unclassified, 1), array_to_string(v_unclassified, ', ');
  END IF;

  RAISE NOTICE 'init-graph-plane-rls: derived closure = % table(s): %',
               array_length(v_closure, 1), array_to_string(v_closure, ', ');
  FOREACH v_t IN ARRAY v_tier_a LOOP
    RAISE NOTICE '  tier A (thought-linked, parent-visibility predicate): %', v_t;
  END LOOP;
  FOREACH v_t IN ARRAY v_tier_b LOOP
    RAISE NOTICE '  tier B (entity-level, contained at the write): %', v_t;
  END LOOP;
END $$;

-- ==========================================================================================
-- 1. THE PREDICATE - one definition, and it is SECURITY INVOKER
-- ==========================================================================================
-- The twin of `ob_memory_visible` in 180: a derived row is visible exactly when the row it is
-- derived FROM is visible to this caller. SECURITY INVOKER (the default) is the entire point
-- - the SELECT inside is itself subject to `thoughts`' policies, so there is ONE definition
-- of the corpus rule and this file does not restate it. A SECURITY DEFINER function here
-- would run as the superuser owner and hand back exactly what the policy exists to withhold.
--
-- LANGUAGE sql + STABLE so the planner can inline it into the policy expression; the lookup
-- is on thoughts' primary key.
CREATE OR REPLACE FUNCTION public.ob_thought_visible(p_thought_id BIGINT) RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id = p_thought_id)
$$;

GRANT EXECUTE ON FUNCTION public.ob_thought_visible(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_thought_visible(BIGINT) TO authenticated;

-- IDEMPOTENCE. Every policy this file creates is dropped by ITS OWN name first, not just
-- by the name it replaces. Measured on the throwaway: without these lines a SECOND apply
-- died on `policy "thought_entities_plane" ... already exists` at statement 1 of 15,
-- leaving the tier A tables half-migrated. The promotion runbook re-applies this file, and
-- a retry after a partial apply is exactly when that matters.
DROP POLICY IF EXISTS thought_entities_plane ON public.thought_entities;
DROP POLICY IF EXISTS thought_entities_plane_read ON public.thought_entities;
DROP POLICY IF EXISTS entity_extraction_queue_plane ON public.entity_extraction_queue;
DROP POLICY IF EXISTS entity_extraction_queue_plane_read ON public.entity_extraction_queue;
DROP POLICY IF EXISTS thought_edges_plane ON public.thought_edges;
DROP POLICY IF EXISTS idea_revisions_plane ON public.idea_revisions;
DROP POLICY IF EXISTS idea_revisions_plane_read ON public.idea_revisions;
DROP POLICY IF EXISTS entities_shared_vocabulary_all ON public.entities;
DROP POLICY IF EXISTS entities_shared_vocabulary_read ON public.entities;
DROP POLICY IF EXISTS edges_shared_vocabulary_all ON public.edges;
DROP POLICY IF EXISTS edges_shared_vocabulary_read ON public.edges;
DROP POLICY IF EXISTS source_entities_shared_vocabulary_all ON public.source_entities;
DROP POLICY IF EXISTS source_entities_shared_vocabulary_read ON public.source_entities;
DROP POLICY IF EXISTS consolidation_log_shared_vocabulary_all ON public.consolidation_log;
DROP POLICY IF EXISTS consolidation_log_shared_vocabulary_read ON public.consolidation_log;

-- ==========================================================================================
-- 2. TIER A - the thought-linked tables. Each row NAMES a thought, so its existence is the
--    thought's existence.
-- ==========================================================================================
-- The wide policy is DROPPED rather than joined by a narrow one: permissive policies are
-- OR'd, so leaving `USING (true)` in place and adding a predicate beside it changes nothing
-- at all. Same statement as 180's, and it is just as load-bearing here.

-- --- thought_entities: (thought_id, entity_id) - existence, plus what the thought is ABOUT,
--     and `evidence` jsonb is content-shaped by design.
DROP POLICY IF EXISTS thought_entities_service_role_all     ON public.thought_entities;
DROP POLICY IF EXISTS thought_entities_authenticated_select ON public.thought_entities;

CREATE POLICY thought_entities_plane ON public.thought_entities
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_thought_visible(thought_id))
  WITH CHECK (public.ob_thought_visible(thought_id));

CREATE POLICY thought_entities_plane_read ON public.thought_entities
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.ob_thought_visible(thought_id));

-- --- entity_extraction_queue: THE MEASURED LEAK. thought_id + sha256(content).
DROP POLICY IF EXISTS entity_extraction_queue_service_role_all     ON public.entity_extraction_queue;
DROP POLICY IF EXISTS entity_extraction_queue_authenticated_select ON public.entity_extraction_queue;

CREATE POLICY entity_extraction_queue_plane ON public.entity_extraction_queue
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_thought_visible(thought_id))
  WITH CHECK (public.ob_thought_visible(thought_id));

CREATE POLICY entity_extraction_queue_plane_read ON public.entity_extraction_queue
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.ob_thought_visible(thought_id));

-- --- thought_edges: BOTH ends, because the id of an invisible thought is itself a
--     disclosure ("something you cannot see supports this ops thought"). Same reasoning as
--     180's agent_memory_relations policy.
DROP POLICY IF EXISTS "service_role full access" ON public.thought_edges;
DROP POLICY IF EXISTS "authenticated read"       ON public.thought_edges;

CREATE POLICY thought_edges_plane ON public.thought_edges
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_thought_visible(from_thought_id) AND public.ob_thought_visible(to_thought_id))
  WITH CHECK (public.ob_thought_visible(from_thought_id) AND public.ob_thought_visible(to_thought_id));

-- --- idea_revisions: ON NOBODY'S LIST. `thought_id BIGINT REFERENCES thoughts(id) ON DELETE
--     SET NULL`, plus `summary TEXT NOT NULL` (real content, not a hash) and `content_hash
--     TEXT` (the same fingerprint shape as the queue's).
--     The NULL arm is a FOREIGN KEY being absent, not a LABEL being absent: a revision with
--     no thought_id is not derived from the corpus and there is nothing to hide. That is a
--     different thing from "unlabelled defaults to fine", and the distinction is why this
--     predicate is allowed a NULL arm and `ob_corpus_on_ops_plane` is not.
DROP POLICY IF EXISTS idea_revisions_service_role_all     ON public.idea_revisions;
DROP POLICY IF EXISTS idea_revisions_authenticated_select ON public.idea_revisions;

CREATE POLICY idea_revisions_plane ON public.idea_revisions
  AS PERMISSIVE FOR ALL TO service_role
  USING      (thought_id IS NULL OR public.ob_thought_visible(thought_id))
  WITH CHECK (thought_id IS NULL OR public.ob_thought_visible(thought_id));

CREATE POLICY idea_revisions_plane_read ON public.idea_revisions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (thought_id IS NULL OR public.ob_thought_visible(thought_id));

-- ==========================================================================================
-- 2b. THE 180 TABLE THIS FILE HAS TO FINISH, AND THE FK ORACLE BESIDE IT
-- ==========================================================================================
-- `agent_memory_audit_events` is a CLOSURE MEMBER (it carries `memory_id REFERENCES
-- agent_memories(id)`), it was classified as "already governed", and it was not. See section
-- 0a for the measurement and for what is and is not disclosed.
--
-- WHY PARENT VISIBILITY IS THE RIGHT PREDICATE HERE. An audit row's whole purpose is to name
-- a memory and say what happened to it, so its existence IS the memory's existence - the same
-- reasoning tier A applies to `thought_entities`. Both foreign keys get the treatment,
-- because `trace_id` names a recall trace which carries the caller's QUERY TEXT.
--
-- THE NULL ARMS ARE FOREIGN KEYS BEING ABSENT, NOT LABELS BEING ABSENT - the distinction
-- section 2 draws for `idea_revisions`, and it is load-bearing twice over here. Both FKs are
-- `ON DELETE SET NULL`, so a row whose parent has been deleted has nothing left to protect;
-- and 12 of the 67 live audit rows have never had a `memory_id` at all.
--
-- THIS DOES NOT BREAK THE REFUSAL RECORD, and that was checked rather than assumed, because
-- an `access_refused` audit necessarily names a memory the REFUSED caller cannot see. It
-- survives because the writer is not that caller: openbrain-mcp connects with
-- `DB_USER=postgres` (verified on the live container), a superuser, and RLS does not bind a
-- superuser with or without FORCE. What this policy binds is the PostgREST/service_role
-- surface - the unauthenticated obnet door - which never writes refusal audits and has no
-- business reading them.
DROP POLICY IF EXISTS agent_memory_audit_events_service_role_all ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_plane            ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_plane_read       ON public.agent_memory_audit_events;

CREATE POLICY agent_memory_audit_events_plane ON public.agent_memory_audit_events
  AS PERMISSIVE FOR ALL TO service_role
  USING      ((memory_id IS NULL OR public.ob_memory_visible(memory_id))
              AND (trace_id IS NULL OR EXISTS (
                     SELECT 1 FROM public.agent_memory_recall_traces t WHERE t.id = trace_id)))
  WITH CHECK ((memory_id IS NULL OR public.ob_memory_visible(memory_id))
              AND (trace_id IS NULL OR EXISTS (
                     SELECT 1 FROM public.agent_memory_recall_traces t WHERE t.id = trace_id)));

-- The trace arm is an EXISTS against the table itself rather than a call to
-- ob_trace_on_ops_plane(), for the same reason ob_thought_visible is SECURITY INVOKER: the
-- inner SELECT is itself bound by `agent_memory_recall_traces`' own policies, so the corpus
-- rule has ONE definition and this file does not restate it.

-- --- R3: THE REFERENTIAL-INTEGRITY EXISTENCE ORACLE ON agent_memories.
-- Postgres checks a FOREIGN KEY with an internal trigger that RLS does not bind, and it runs
-- AFTER the row has passed WITH CHECK. So on the live database an unauthenticated caller
-- could separate a HIDDEN thought from a NONEXISTENT one by the error it got back:
--
--     POST /agent_memories {thought_id: <hidden>}       -> 201 Created
--     POST /agent_memories {thought_id: <nonexistent>}  -> 23503 "Key is not present in
--                                                          table thoughts"
--
-- The four tier A tables are immune because their WITH CHECK names `thought_id` and
-- therefore fires FIRST; `agent_memories` was not, because its WITH CHECK only looked at
-- `metadata` and `user_id`. Adding the thought_id arm makes both cases fail identically at
-- 42501 before the FK is ever consulted, which is the whole fix: the two answers become one.
--
-- BOTH POLICIES GET THE ARM, not just the ops one. Two policies on one table are two readers
-- of the same rule - the exact shape of the "fixed one, left the sibling" class this round
-- was warned about - and permissive policies are OR-ed, so an arm added to one of them and
-- not the other closes nothing at all.
--
-- OPS IMPACT, MEASURED not assumed: all 21 live `agent_memories` rows carrying a
-- `thought_id` point at thoughts that ARE on the ops plane, so this narrows nothing that
-- currently works. And the writeback path is superuser, as above.
DROP POLICY IF EXISTS agent_memories_ops_plane      ON public.agent_memories;
DROP POLICY IF EXISTS agent_memories_personal_plane ON public.agent_memories;

CREATE POLICY agent_memories_ops_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_on_ops_plane(metadata))
  WITH CHECK (public.ob_memory_on_ops_plane(metadata)
              AND (thought_id IS NULL OR public.ob_thought_visible(thought_id)));

CREATE POLICY agent_memories_personal_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (user_id IS NOT NULL AND user_id = public.ob_current_user_id())
  WITH CHECK (user_id IS NOT NULL AND user_id = public.ob_current_user_id()
              AND (thought_id IS NULL OR public.ob_thought_visible(thought_id)));

-- The USING halves are UNCHANGED from 180, verbatim. Only WITH CHECK gains the arm: a
-- caller's ability to READ a memory it already owns must not depend on whether the thought
-- behind it is on its plane, or a plane change would strand rows their owner cannot see.

-- ==========================================================================================
-- 3. TIER B - the entity-level tables, and an HONEST account of what governs them
-- ==========================================================================================
-- `entities`, `edges`, `source_entities` and `consolidation_log` carry NO thought id and NO
-- thought content. An entity is a canonical shared node - "PostgreSQL", "Docker" - cited by
-- many thoughts and many sources. There is no per-row predicate available to them:
--
--   * A predicate on citations ("visible if I can see one of its thought_entities rows")
--     COLLAPSES under RLS. An invoker cannot distinguish "no citation exists" from "every
--     citation is hidden from me", so the expression reduces to TRUE with extra steps.
--   * A denormalised exposure LABEL on `entities` would be the "unlabelled defaults to fine"
--     class again, one table over, and would need a second write path to keep it in step.
--   * An EXISTS subquery per row is not viable at this size: 69,730 entities, 92,800 edges,
--     81,238 source_entities, read in batches by the wiki compiler on a schedule.
--
-- SO TIER B IS CONTAINED AT THE WRITE, which is amendment A2's own reframe applied one layer
-- down: with the gate in section 4, an off-plane thought is never extracted, so no entity,
-- edge, source link or consolidation row is ever DERIVED from off-plane content. That claim
-- is not asserted here - it is MEASURED at apply time, immediately below, and it FAILS the
-- migration if it is false.
--
-- What tier B still gets: FORCE ROW LEVEL SECURITY, reduced grants, and a policy NAMED for
-- what it is instead of an anonymous `USING (true)` nobody re-reads. Renaming a wide policy
-- is not narrowing it, and this file does not pretend otherwise.
DO $$
DECLARE
  v_bad_te INT;
  v_bad_en INT;
BEGIN
  SELECT count(*) INTO v_bad_te
    FROM public.thought_entities te
    JOIN public.thoughts t ON t.id = te.thought_id
   WHERE NOT COALESCE(public.ob_corpus_on_ops_plane(t.metadata), false);

  SELECT count(*) INTO v_bad_en
    FROM public.entities e
   WHERE EXISTS (SELECT 1 FROM public.thought_entities te WHERE te.entity_id = e.id)
     AND NOT EXISTS (
           SELECT 1 FROM public.thought_entities te
             JOIN public.thoughts t ON t.id = te.thought_id
            WHERE te.entity_id = e.id
              AND COALESCE(public.ob_corpus_on_ops_plane(t.metadata), false));

  IF v_bad_te > 0 OR v_bad_en > 0 THEN
    RAISE EXCEPTION 'init-graph-plane-rls: tier B containment claim is FALSE on this database '
                    '- % thought_entities row(s) cite an off-plane thought and % entity/'
                    'entities are cited ONLY by off-plane thoughts. Tier B is contained at '
                    'the WRITE, so a non-zero count here means off-plane content is already '
                    'in the graph and a read-side policy is needed before this migration is '
                    'honest.', v_bad_te, v_bad_en;
  END IF;
  RAISE NOTICE 'init-graph-plane-rls: tier B containment measured - 0 off-plane citations, '
               '0 entities cited only off-plane';
END $$;

DROP POLICY IF EXISTS entities_service_role_all              ON public.entities;
DROP POLICY IF EXISTS entities_authenticated_select          ON public.entities;
DROP POLICY IF EXISTS edges_service_role_all                 ON public.edges;
DROP POLICY IF EXISTS edges_authenticated_select             ON public.edges;
DROP POLICY IF EXISTS source_entities_service_role_all       ON public.source_entities;
DROP POLICY IF EXISTS source_entities_authenticated_select   ON public.source_entities;
DROP POLICY IF EXISTS consolidation_log_service_role_all     ON public.consolidation_log;
DROP POLICY IF EXISTS consolidation_log_authenticated_select ON public.consolidation_log;

-- Named `_shared_vocabulary_` so a reader who greps for a wide policy finds a SENTENCE
-- rather than a shrug.
CREATE POLICY entities_shared_vocabulary_all ON public.entities
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY entities_shared_vocabulary_read ON public.entities
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY edges_shared_vocabulary_all ON public.edges
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY edges_shared_vocabulary_read ON public.edges
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY source_entities_shared_vocabulary_all ON public.source_entities
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY source_entities_shared_vocabulary_read ON public.source_entities
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

CREATE POLICY consolidation_log_shared_vocabulary_all ON public.consolidation_log
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY consolidation_log_shared_vocabulary_read ON public.consolidation_log
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

COMMENT ON POLICY entities_shared_vocabulary_all ON public.entities IS
  'DELIBERATELY WIDE. entities holds canonical shared nodes with no thought id and no thought content; its exposure is contained at the WRITE by the queue_entity_extraction() plane gate, not by this policy. See init-graph-plane-rls.sql section 3.';
COMMENT ON POLICY consolidation_log_shared_vocabulary_all ON public.consolidation_log IS
  'DELIBERATELY WIDE, same reason as entities_shared_vocabulary_all. The details column is content-shaped jsonb and is EMPTY in current data; if it ever carries content this decision changes with it.';

-- ==========================================================================================
-- 4. THE SECURITY DEFINER FUNCTIONS - the ones that CARRIED content across the boundary
-- ==========================================================================================
-- Four SECURITY DEFINER functions exist in this schema (pg_proc.prosecdef, measured
-- 2026-08-31): queue_entity_extraction, queue_source_extraction, thought_edges_upsert,
-- touch_entities_for_deleted_thought. Every one is accounted for below.
--
-- --- queue_entity_extraction: THE CARRIER ------------------------------------------------
-- It fires AFTER INSERT OR UPDATE ON thoughts and writes NEW.content_fingerprint - sha256 of
-- the thought's content - into a table the ops plane could read. The definer rights are what
-- made the boundary irrelevant: the row was written as the superuser owner, so no policy on
-- the target table was consulted.
--
-- TWO OPTIONS WERE ON THE TABLE:
--   (a) make the queue row CARRY the source thought's exposure, so the same predicate governs
--       it. Rejected as the PRIMARY fix: it duplicates the label into a second place that a
--       second write path must keep in step, and a copied label is a thing that can disagree
--       with its original. It is also strictly weaker - the row, its timestamps and its
--       fingerprint would still EXIST, and existence was half the disclosure.
--   (b) DO NOT WRITE a content-derived fingerprint for an off-plane row at all.
--
-- (b) IS WHAT THIS DOES, and (a)'s effect comes for free without a copied label: the policy
-- in section 2 resolves the queue row's plane THROUGH ITS FOREIGN KEY, so a row written
-- before this gate existed is bound anyway. One label, one place, both properties.
--
-- AND THE TRANSITION CASE, which is the one that is easy to miss: a thought that is ops today
-- and personal tomorrow ALREADY HAS a queue row carrying its fingerprint. The UPDATE branch
-- must REMOVE it, or the boundary closes around a row still sitting there in the open. This
-- deletes a derived bookkeeping row whose source has left the plane - not corpus data - and
-- the row is regenerated by the next ops-plane update if the thought comes back.
--
-- WHY IT STAYS SECURITY DEFINER. It is a trigger on `thoughts` that must succeed for every
-- writer of `thoughts`, including planes that hold no grant on the queue table. Dropping the
-- definer rights here would make a `thoughts` INSERT fail for those writers - a live
-- behaviour change this migration is not for. The definer was not the defect; the defect was
-- a definer that copied content-derived data ACROSS a boundary, and that is what is fixed.
--
-- THREE-VALUED LOGIC, AND IT NEARLY SHIPPED. `ob_corpus_on_ops_plane` is
-- `md->>'exposure' = 'ops'`, so for an UNLABELLED row it returns NULL, not FALSE - and
-- `NOT NULL` is NULL, which an IF treats as not-taken. Written as `IF NOT
-- ob_corpus_on_ops_plane(...)` the gate would have let every unlabelled thought straight
-- through to the INSERT, while the fail-closed policy on `thoughts` made that same row
-- INVISIBLE to the ops plane: the exact leak this file closes, reintroduced by an operator
-- precedence nobody looks at. Measured on the throwaway: `ob_corpus_on_ops_plane('{}')` IS
-- NULL, `NOT ob_corpus_on_ops_plane('{}')` IS NULL, `COALESCE(..., false)` = f. A policy
-- coerces NULL to false for you; plpgsql does not.
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

-- --- thought_edges_upsert: a SECURITY DEFINER ORACLE, flipped to INVOKER ------------------
-- It is INSERT ... ON CONFLICT DO UPDATE ... RETURNING *, called over PostgREST rpc by
-- recipes/typed-edge-classifier/classify-edges.mjs. As DEFINER it ran as the superuser owner,
-- so a caller could (1) WRITE an edge pointing at a thought it cannot see and (2) learn from
-- the returned row that such an edge ALREADY EXISTED, with its support_count, confidence,
-- classifier_version and merged metadata. That is a read of hidden state through a write.
--
-- It needs no elevation: service_role already holds SELECT/INSERT/UPDATE/DELETE on
-- thought_edges, and the PostgREST caller IS service_role. As INVOKER the section-2 policy
-- binds it - both endpoints must be visible - and the ops path is unchanged, because both
-- endpoints of an ops edge are ops thoughts. The eight superuser connections are unaffected,
-- as they are by every policy in this file.
--
-- The body is otherwise IDENTICAL to init-graph.sql's; only SECURITY DEFINER is gone.
CREATE OR REPLACE FUNCTION public.thought_edges_upsert(
  p_from_thought_id BIGINT,
  p_to_thought_id BIGINT,
  p_relation TEXT,
  p_confidence NUMERIC,
  p_support_count INT,
  p_classifier_version TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_metadata JSONB
)
RETURNS public.thought_edges
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_row public.thought_edges;
BEGIN
  INSERT INTO public.thought_edges (
    from_thought_id, to_thought_id, relation,
    confidence, support_count, classifier_version,
    valid_from, valid_until, metadata
  )
  VALUES (
    p_from_thought_id, p_to_thought_id, p_relation,
    p_confidence, COALESCE(p_support_count, 1), p_classifier_version,
    p_valid_from, p_valid_until, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (from_thought_id, to_thought_id, relation)
  DO UPDATE SET
    support_count = public.thought_edges.support_count + COALESCE(EXCLUDED.support_count, 1),
    confidence = GREATEST(public.thought_edges.confidence, EXCLUDED.confidence),
    valid_until = CASE
      WHEN public.thought_edges.valid_until IS NULL OR EXCLUDED.valid_until IS NULL THEN NULL
      ELSE GREATEST(public.thought_edges.valid_until, EXCLUDED.valid_until)
    END,
    valid_from = CASE
      WHEN public.thought_edges.valid_from IS NULL THEN EXCLUDED.valid_from
      WHEN EXCLUDED.valid_from IS NULL THEN public.thought_edges.valid_from
      ELSE LEAST(public.thought_edges.valid_from, EXCLUDED.valid_from)
    END,
    classifier_version = EXCLUDED.classifier_version,
    metadata = public.thought_edges.metadata || EXCLUDED.metadata,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$fn$;

-- --- touch_entities_for_deleted_thought: flipped to INVOKER too ---------------------------
-- It READS thought_entities (a tier A table) as the definer and bumps entities.updated_at so
-- the wiki compiler regenerates pages that cited a deleted thought. It moves no content - a
-- timestamp is all that changes - but as DEFINER it reads governed rows, and it needs no
-- elevation: service_role holds SELECT on thought_entities and UPDATE on entities, and the
-- superuser deleters are unaffected. As INVOKER each caller touches exactly the entities its
-- own plane cites, which is the correct behaviour rather than merely the safe one.
CREATE OR REPLACE FUNCTION public.touch_entities_for_deleted_thought()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.entities
     SET updated_at = now()
   WHERE id IN (
     SELECT entity_id FROM public.thought_entities
      WHERE thought_id = OLD.id
   );
  RETURN OLD;
END;
$fn$;

-- --- queue_source_extraction is DELIBERATELY UNCHANGED, and here is why --------------------
-- It is the same SHAPE one corpus over - SECURITY DEFINER, writes md5(sources.content) into
-- source_extraction_queue - but `sources` is the research corpus: it carries no exposure
-- label, holds no agent-memory mirror, and has no foreign key into `thoughts` or
-- `agent_memories`, so it is not in the closure section 0 computes. Changing it would be
-- governing a corpus this migration has not analysed. IF `sources` ever carries
-- plane-labelled content this is the identical defect one table over and must be fixed with
-- it - recorded in documentation/notes/u5graph-findings.md rather than left as a comment
-- nobody reads.

-- ==========================================================================================
-- 5. FORCE ROW LEVEL SECURITY
-- ==========================================================================================
-- Without it the table OWNER bypasses every policy above. These tables are owned by
-- `postgres`, which is also a SUPERUSER, and a superuser is exempt from FORCE as well - so
-- read the caveat at the top of this file. FORCE is set because it is correct, because it
-- costs nothing, and because it makes moving ownership off the superuser a one-line change
-- rather than a redesign. What binds a caller TODAY is being a non-superuser role, which is
-- what PostgREST's SET ROLE service_role makes every PostgREST request.
ALTER TABLE public.thought_entities        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.entity_extraction_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE public.thought_edges           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.idea_revisions          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.entities                FORCE ROW LEVEL SECURITY;
ALTER TABLE public.edges                   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.source_entities         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_log       FORCE ROW LEVEL SECURITY;

-- ==========================================================================================
-- 6. REDUCE THE GRANTS
-- ==========================================================================================
-- service_role holds INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on all
-- eight - not because anything asked for it, but because init-grants.sql's
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES hands every future table the full set.
-- TRUNCATE is NOT RLS-FILTERABLE: one statement empties a table regardless of every policy
-- above it, and it is not a read-path requirement. REFERENCES and TRIGGER let a caller attach
-- machinery to a table it only needs to read from. No code in OB1 truncates any of these -
-- checked, 2026-08-31.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.thought_entities,
  public.entity_extraction_queue,
  public.thought_edges,
  public.idea_revisions,
  public.entities,
  public.edges,
  public.source_entities,
  public.consolidation_log
FROM service_role;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.thought_entities,
  public.entity_extraction_queue,
  public.thought_edges,
  public.idea_revisions,
  public.entities,
  public.edges,
  public.source_entities,
  public.consolidation_log
FROM authenticated;

-- ==========================================================================================
-- 6b. VIEWS - the same boundary, a different relkind, and the hazard was documented one file
--     over
-- ==========================================================================================
-- A view owned by `postgres` WITHOUT `security_invoker` executes with its OWNER's privileges,
-- and the owner is a superuser, so RLS on the base tables does not apply to anyone reading
-- through it. Every policy this file and 180 install is bypassable by any view that projects
-- the protected columns.
--
-- MEASURED on a fresh volume, with ops positive controls at 1 on both arms:
--     base table `idea_revisions`, personal row, as service_role  -> 0 rows
--     view `public.ideas_owed_research`, same row, same role      -> 1 row
-- `ideas_owed_research` JOINs `idea_revisions` - the tier A table section 2 governs - and is
-- served unauthenticated on open-brain_obnet.
--
-- BOUNDED HONESTLY, because this is smaller than the base-table leak and saying otherwise
-- would be a claim wider than its evidence. The view projects `i.*` only: it returns columns
-- of `ideas`, so `idea_revisions.summary`, `.thought_id` and `.content_hash` are NOT
-- returned. What leaks is the EXISTENCE of a governed revision - an idea appears in the
-- "owed research" list because of a revision the caller may not see - not its content and
-- not a fingerprint.
--
-- THE CLASS WAS KNOWN ONE FILE OVER. init-agent-memory-rls.sql:343 already documents this
-- exact hazard IN CAPITALS for the two views IT creates ("without it this view would bypass
-- the exposure boundary"), and sets security_invoker on both. `v_agent_memories` and
-- `v_thoughts` are correct today for precisely that reason. The four views that predate it
-- were never revisited. That is the "fixed one, left the sibling" class again, one relkind
-- across - and section 7's post-condition could not see it, because pg_policies and
-- `relrowsecurity` describe TABLES and a view has neither.
--
-- THE SWEEP IS THE FIX, NOT THE INSTANCE. Only `ideas_owed_research` touches the governed
-- corpus today; `research_run_metrics`, `reusable_claims` and `ungrounded_claims` read
-- `research_jobs` and `claims`, which are outside this closure. All four are fixed anyway,
-- derived from the catalogue rather than named, so that governing `claims` tomorrow is not
-- silently bypassed by a view written years ago. Setting the flag on the other three is
-- MEASURED to be inert today, not assumed to be: both `service_role` and `authenticated`
-- hold SELECT on every base table involved and on `claim_min_depth()`, and every one of
-- those base tables carries a permissive USING(true) policy for both roles, so the visible
-- row set through the view is unchanged.
DO $$
DECLARE
  v_rel     RECORD;
  v_fixed   TEXT[] := ARRAY[]::TEXT[];
  v_matview TEXT[];
BEGIN
  -- A MATERIALIZED view cannot be fixed this way: it has no `security_invoker` option at all
  -- and its rows were computed and STORED by its owner, so RLS can never apply to them. If
  -- one ever reads a force-RLS relation, that is a containment failure this file cannot
  -- repair, and it must stop the migration rather than be silently skipped by a filter.
  SELECT array_agg(DISTINCT mv.relname ORDER BY mv.relname) INTO v_matview
    FROM pg_rewrite rw
    JOIN pg_class mv ON mv.oid = rw.ev_class
    JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_class base ON base.oid = d.refobjid
   WHERE mv.relkind = 'm'
     AND mv.relnamespace = 'public'::regnamespace
     AND base.relkind = 'r'
     AND base.relrowsecurity AND base.relforcerowsecurity
     AND base.oid <> mv.oid;
  IF v_matview IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: materialized view(s) % read a FORCE-RLS relation. '
                    'A matview stores rows its owner computed; security_invoker does not '
                    'exist for it and RLS cannot reach them. Classify it - drop it, or move '
                    'it behind a governed view - and re-run.',
                    array_to_string(v_matview, ', ');
  END IF;

  -- THE SWEEP. Derived from pg_class, never hand-listed: any ordinary view in `public` whose
  -- reloptions do not already say security_invoker=true.
  FOR v_rel IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relkind = 'v'
       AND c.relnamespace = 'public'::regnamespace
       AND COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'false') <> 'true'
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v_rel.relname);
    v_fixed := v_fixed || v_rel.relname;
  END LOOP;

  IF array_length(v_fixed, 1) IS NULL THEN
    RAISE NOTICE 'init-graph-plane-rls: all public views already run as SECURITY INVOKER';
  ELSE
    RAISE NOTICE 'init-graph-plane-rls: security_invoker set on % view(s): %',
                 array_length(v_fixed, 1), array_to_string(v_fixed, ', ');
  END IF;
END $$;

-- ==========================================================================================
-- 7. POST-CONDITION - measured, not assumed
-- ==========================================================================================
-- Everything above can be typed correctly and still not take: a policy DROP naming a policy
-- that had already been renamed leaves the wide one standing, and this file would still exit
-- 0. So the state is RE-DERIVED and asserted here, inside the same transaction, and a failure
-- rolls the whole migration back.
DO $$
DECLARE
  v_tier_a TEXT[] := ARRAY['thought_entities','entity_extraction_queue','thought_edges',
                           'idea_revisions','agent_memory_audit_events'];
  v_all    TEXT[] := ARRAY['thought_entities','entity_extraction_queue','thought_edges',
                           'idea_revisions','entities','edges','source_entities',
                           'consolidation_log','agent_memory_audit_events'];
  -- the 180 tables section 0 CLASSIFIES rather than governs; asserted here for the same
  -- reason section 0 now tests them - a classification is not a measurement.
  v_governed TEXT[] := ARRAY[
      'agent_memories','agent_memory_source_refs','agent_memory_artifacts',
      'agent_memory_relations','agent_memory_review_actions','agent_memory_recall_traces',
      'agent_memory_recall_items'];
  v_bad    TEXT[];
BEGIN
  -- (a) every governed table has RLS ENABLED and FORCED.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = ANY (v_all)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: RLS is not enabled+forced on: %',
                    array_to_string(v_bad, ', ');
  END IF;

  -- (b) NO tier A table retains a permissive USING(true) policy. This is the assertion that
  --     catches a mis-named DROP, and it is the one that matters: a narrow policy beside a
  --     wide one IS a wide policy.
  SELECT array_agg(DISTINCT p.tablename || '.' || p.policyname
                   ORDER BY p.tablename || '.' || p.policyname) INTO v_bad
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename = ANY (v_tier_a)
     AND p.permissive = 'PERMISSIVE'
     AND (p.qual IS NULL OR btrim(p.qual) = 'true');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: tier A still carries permissive USING(true) '
                    'policy/policies: %. Permissive policies are OR-ed, so this leaves the '
                    'boundary open.', array_to_string(v_bad, ', ');
  END IF;

  -- (c) TRUNCATE/REFERENCES/TRIGGER are gone from the read path.
  SELECT array_agg(DISTINCT table_name || '/' || grantee || '/' || privilege_type
                   ORDER BY table_name || '/' || grantee || '/' || privilege_type) INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = ANY (v_all)
     AND grantee IN ('service_role','authenticated')
     AND privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: TRUNCATE/REFERENCES/TRIGGER still granted: %',
                    array_to_string(v_bad, ', ');
  END IF;

  -- (d) the two functions that no longer need definer rights do not have them, and the one
  --     that keeps them still has its search_path pinned.
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('thought_edges_upsert','touch_entities_for_deleted_thought')
                AND p.prosecdef) THEN
    RAISE EXCEPTION 'init-graph-plane-rls: thought_edges_upsert / '
                    'touch_entities_for_deleted_thought are still SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname = 'queue_entity_extraction'
                    AND p.prosecdef
                    AND p.proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'init-graph-plane-rls: queue_entity_extraction lost SECURITY DEFINER or '
                    'its pinned search_path';
  END IF;

  -- (e) THE GOVERNED-NESS PREDICATE, applied to every table this file claims to govern AND
  --     to the 180 tables it merely classified. Assertions (a) and (b) were written as two
  --     hand-rolled halves of exactly this predicate, and being hand-rolled is how they came
  --     to disagree with the arm in section 0. There is now ONE definition, and this is its
  --     third caller.
  --     SCOPE, and it is not v_all. TIER B is deliberately wide on the READ side - it is
  --     contained at the WRITE and section 3 names and COMMENTs that choice - so applying
  --     the predicate to it asserts the opposite of what this file decided. The predicate
  --     belongs to tier A (a real row-level USING) and to the 180 tables section 0
  --     classifies. Tier B's own guarantees are (a) above plus section 3's measured
  --     containment. This scoping error was caught by this very assertion on its first run.
  SELECT array_agg(t ORDER BY t) INTO v_bad
    FROM unnest(v_tier_a || v_governed) AS t
   WHERE NOT public.ob_relation_governed(t);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: relation(s) % do not satisfy '
                    'ob_relation_governed() after this migration ran. RLS enabled+forced '
                    'with a permissive USING(true) policy still standing is the exact state '
                    'agent_memory_audit_events was in before this round.',
                    array_to_string(v_bad, ', ');
  END IF;

  -- (f) NO VIEW BYPASSES ANY OF IT. Assertions (a) through (e) all read `pg_class` and
  --     `pg_policies` for TABLES, so every one of them was structurally blind to a view -
  --     which is how `ideas_owed_research` served a governed row to an unauthenticated
  --     caller while this section reported that the post-conditions held. A view without
  --     security_invoker runs as its superuser owner and RLS does not apply to it.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_bad
    FROM pg_class c
   WHERE c.relkind = 'v'
     AND c.relnamespace = 'public'::regnamespace
     AND COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name = 'security_invoker'), 'false') <> 'true';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: view(s) % still run as their owner. A view is a '
                    'read path around every policy above.', array_to_string(v_bad, ', ');
  END IF;

  -- (g) THE FK EXISTENCE ORACLE IS CLOSED. Both agent_memories policies must NAME
  --     thought_id in WITH CHECK, or a referential-integrity trigger - which RLS does not
  --     bind - answers "does this hidden thought exist?" with 201 versus 23503.
  SELECT array_agg(p.policyname ORDER BY p.policyname) INTO v_bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'agent_memories'
     AND p.permissive = 'PERMISSIVE'
     AND (p.with_check IS NULL OR p.with_check NOT LIKE '%thought_id%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: agent_memories policy/policies % do not constrain '
                    'thought_id in WITH CHECK, so the FK existence oracle is open through '
                    'them. Permissive policies are OR-ed: one unguarded arm is enough.',
                    array_to_string(v_bad, ', ');
  END IF;

  RAISE NOTICE 'init-graph-plane-rls: post-conditions hold on % table(s)',
               array_length(v_all, 1);
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
