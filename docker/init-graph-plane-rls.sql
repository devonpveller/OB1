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
-- THE ROOT CLASS THIS FILE IS NOW BUILT AROUND: ABSENCE MUST DENY
-- ==========================================================================================
-- Three separate leaks were found in the second version of this file and they were one
-- defect written three ways. Every one of them was a policy arm that PERMITTED when the
-- row's plane could not be established:
--
--   * `idea_revisions`: `(thought_id IS NULL OR ob_thought_visible(thought_id))`. Omit the
--     column and the NULL arm passes, so RLS never refuses - and the primary key
--     `(idea_id, revision)`, which no policy binds, answers instead. Section 2.
--   * `agent_memory_audit_events`: the same shape twice, armed by `ON DELETE SET NULL`. Fix
--     the policy and it holds only while the parent is alive; delete the memory and the
--     audit row orphans to `(NULL, NULL)` and becomes readable, carrying its payload free
--     text with it. Section 2b.
--   * `agent_memory_recall_traces`: `WITH CHECK (true)`, which is the same hole written
--     shorter, and which nobody had read as an absence arm. Section 2c. It was not found by
--     reading the schema; it was found by asserting the property. Section 7(h).
--
-- ROUND 1 SWEPT TABLES. ROUND 2 SWEPT RELKINDS. THE LEAKS CAME FROM MECHANISMS: unique
-- indexes, foreign-key triggers, `ON DELETE SET NULL`, and transitive dependency. A reviewer
-- put it exactly: enumerating WHAT to protect will always trail the mechanisms; defaulting to
-- deny does not. So this version states the rule and asserts it:
--
--   A ROW WHOSE PLANE CANNOT BE ESTABLISHED IS NOT VISIBLE AND IS NOT WRITABLE,
--   AND NO RELATION REACHES A GOVERNED ONE AROUND THE BOUNDARY.
--
-- and section 7 stops re-deriving a LIST of the state and asserts the PROPERTIES instead:
-- (h) no policy arm permits a row whose every column is NULL; (i) no unique constraint on a
-- governed relation is an existence oracle; (j) no foreign key into a governed parent is
-- unguarded by WITH CHECK; (k) the SECURITY DEFINER set is exactly the classified one;
-- (l) nothing reaches a FORCE-RLS table transitively without being bound by it.
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

-- ==========================================================================================
-- 1b. THE OTHER PREDICATE THIS FILE HAS TO FINISH: ABSENCE-AS-EMPTY-SET
-- ==========================================================================================
-- 180 defines ob_trace_on_ops_plane as
--
--     COALESCE(rp->'enforced_exposure', '["personal"]') <@ '["ops"]'
--
-- and the COALESCE was written to make ABSENCE deny. It does. What it does not make deny is
-- the EMPTY ARRAY: `[] <@ anything` is TRUE for every containment test, because the empty set
-- is a subset of every set. So a recall trace that recorded `enforced_exposure: []` - a recall
-- that enforced NOTHING - reads back through the unauthenticated door WITH ITS QUERY TEXT,
-- which is the one column on that table this boundary exists to hold.
--
-- MEASURED on the throwaway, as service_role, against the round 3 file:
--
--     enforced_exposure   query
--     []                  U5G4-TRACE-EMPTY secret query text     <- returned. LEAK.
--     ["ops"]             U5G4-TRACE-OPS control query           <- returned. CONTROL.
--     ["personal"]        (not returned)
--     (key absent)        (not returned)
--
-- Round 3 read this arm and called it safe because `ob_trace_on_ops_plane(NULL)` is FALSE.
-- That is true and it is the wrong question: absence was covered and vacuity was not. This is
-- the same error as `X IS NULL OR visible(X)` in a different vocabulary - a value that means
-- "nothing was established" evaluating to PERMIT.
--
-- THE FIX IS THE PROPERTY: a trace is on the ops plane when it ENFORCED something and
-- everything it enforced was `ops`. Absent, non-array and empty all deny. A CASE rather than
-- an `AND` chain because Postgres does not guarantee short-circuit evaluation and
-- jsonb_array_length() raises on a non-array.
--
-- OPS IMPACT, MEASURED ON THE LIVE DATABASE BEFORE THE CHANGE, not after: all 78 live
-- recall traces carry NO `enforced_exposure` key at all, so 0 are readable through the door
-- today and 0 are readable after this change. Nothing that works today is narrowed.
CREATE OR REPLACE FUNCTION public.ob_trace_on_ops_plane(rp JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
           CASE
             WHEN jsonb_typeof(rp->'enforced_exposure') <> 'array' THEN false
             WHEN jsonb_array_length(rp->'enforced_exposure') = 0  THEN false
             ELSE rp->'enforced_exposure' <@ '["ops"]'::jsonb
           END, false)
$$;

GRANT EXECUTE ON FUNCTION public.ob_trace_on_ops_plane(JSONB) TO service_role;

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

-- --- idea_revisions: ON NOBODY'S LIST, and the NULL arm here was AN UNAUTHENTICATED
--     EXISTENCE ORACLE. `thought_id BIGINT REFERENCES thoughts(id) ON DELETE SET NULL`, plus
--     `summary TEXT NOT NULL` (real content, not a hash) and `content_hash TEXT`.
--
--     WHAT THE FIRST VERSION SAID, AND WHY IT WAS WRONG. It said: "the NULL arm is a FOREIGN
--     KEY being absent, not a LABEL being absent - a revision with no thought_id is not
--     derived from the corpus and there is nothing to hide." Both halves fail.
--
--     (1) OMIT the column and the NULL arm passes WITH CHECK, so RLS never refuses - and the
--         PRIMARY KEY `(idea_id, revision)`, which no policy binds, answers instead.
--         `ideas` is ungoverned BY DESIGN (section 0 registers it as a separate corpus), so
--         a caller gets the ids for free from GET /ideas. Measured as `service_role` on a
--         throwaway built from the 28-file chain, with an ops control on BOTH arms:
--
--           INSERT (personal idea, revision 1)  -> 23505 duplicate key   (a revision EXISTS)
--           INSERT (personal idea, revision 99) -> OK                    (none)
--           INSERT (ops idea,      revision 1)  -> 23505 duplicate key   [CONTROL]
--           INSERT (ops idea,      revision 98) -> OK                    [CONTROL]
--
--         while the READ side of the same table correctly returned 0 personal / 1 ops. The
--         policy was doing its job and the unique index was undoing it.
--
--     (2) "A revision with no thought_id is not derived from the corpus" is not something
--         this schema can tell you. The foreign key is `ON DELETE SET NULL`: delete the
--         thought and a revision that WAS derived from it orphans to `thought_id IS NULL` -
--         and its `summary`, which is the content, becomes readable. Absence does not mean
--         "never had one". It means "cannot be established".
--
--     THE FIX IS THE PROPERTY, NOT THE INSTANCE: a row whose plane cannot be established is
--     not visible and not writable. `thought_id IS NOT NULL AND ob_thought_visible(...)` in
--     BOTH halves of BOTH policies. WITH CHECK now refuses an INSERT that omits the column,
--     at 42501, BEFORE the primary key is consulted - which is what makes the two answers
--     one answer. Section 7(h) asserts this as a property over every governed policy rather
--     than trusting this one line.
--
--     OPS IMPACT, MEASURED BEFORE THE CHANGE: all 37 live `idea_revisions` rows carry a
--     `thought_id` (0 NULL), so no row that is readable today becomes unreadable. The write
--     path is `openbrain-idea-refinery`, which connects as `postgres` - DB_USER is unset in
--     its container, and the code defaults to `postgres` (integrations/openbrain-idea-refinery
--     /index.ts:39) - so it is a superuser and no policy here binds it.
DROP POLICY IF EXISTS idea_revisions_service_role_all     ON public.idea_revisions;
DROP POLICY IF EXISTS idea_revisions_authenticated_select ON public.idea_revisions;

CREATE POLICY idea_revisions_plane ON public.idea_revisions
  AS PERMISSIVE FOR ALL TO service_role
  USING      (thought_id IS NOT NULL AND public.ob_thought_visible(thought_id))
  WITH CHECK (thought_id IS NOT NULL AND public.ob_thought_visible(thought_id));

CREATE POLICY idea_revisions_plane_read ON public.idea_revisions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (thought_id IS NOT NULL AND public.ob_thought_visible(thought_id));

-- ==========================================================================================
-- 2b. THE 180 TABLE THIS FILE HAS TO FINISH - AND IT CLOSES, IT DOES NOT NARROW
-- ==========================================================================================
-- `agent_memory_audit_events` is a CLOSURE MEMBER (it carries `memory_id REFERENCES
-- agent_memories(id)`), it was classified as "already governed", and it was not. See section
-- 0a for the measurement of what it disclosed.
--
-- ROUND 2 GAVE IT PARENT VISIBILITY WITH TWO NULL ARMS, AND THAT WAS THE SAME DEFECT AGAIN.
-- The policy was `(memory_id IS NULL OR ob_memory_visible(memory_id)) AND (trace_id IS NULL
-- OR EXISTS(...))`, defended on the grounds that "a row whose parent has been deleted has
-- nothing left to protect" and that "12 of the 67 live audit rows have never had a memory_id
-- at all". BOTH CLAIMS WERE WRONG, and the second was mis-measured:
--
--   * At the same snapshot 21 of the rows have a NULL `memory_id`, not 12 - and their
--     `event_type` values are `memory_written` (12), `memory_confirmed` (5) and `memory_used`
--     (4), every one of which NAMES a memory by definition. They are ORPHANS, not rows that
--     never had a parent. Both foreign keys are `ON DELETE SET NULL`.
--   * The orphan still carries `payload`, which is operator free text - one live row reads
--     `{"note": "synthetic fixture, confirmed to prove the review gate"}` - plus the event
--     history and the timestamps that section 0a names as the disclosure.
--
--   Measured on the throwaway, service_role, with an ops control on both phases:
--     PHASE 1, live parent:  personal 0 / ops 1     <- the round 2 policy working
--     RESET ROLE; DELETE FROM agent_memories WHERE summary = 'U5G3-MEM-PERSONAL';
--     PHASE 2, orphaned:     personal 1 / ops 1     <- LEAK, laundered by ON DELETE SET NULL
--
-- SO THIS TABLE IS CLOSED TO THE UNAUTHENTICATED DOOR, not narrowed. `USING (false)` is the
-- honest predicate here, and it is arrived at rather than assumed:
--
--   * NOTHING DEPLOYED READS IT THROUGH THAT DOOR. `authenticated` holds no grant on it at
--     all (measured). The only code in this repo that reads or writes it over PostgREST is
--     `integrations/agent-memory-api/index.ts`, a Supabase Edge Function that appears in NO
--     compose file in either repository - it is not deployed here.
--   * THE DRILL EVIDENCE SURVIVES. 180 left this table wide to keep the `access_refused`
--     rows readable as proof that a refusal happened. Both readers of that evidence -
--     `scripts/checks/smoke-agent-memory.ps1` and `scripts/checks/dfu-done.ps1` - reach it
--     with `docker exec ... psql`, as `postgres`, a superuser no policy binds. The reason 180
--     gave for the wide policy is not a reason that involves this door.
--   * THE WRITER IS A SUPERUSER TOO: `openbrain-mcp` runs `DB_USER=postgres`, verified on the
--     live container.
--
-- A closed policy also ends the whole class here rather than one arm of it: with no row
-- visible and no write privilege (section 6), the NULL arms, the primary key and both
-- foreign-key triggers all stop being reachable at once. That is the difference between
-- fixing an instance and removing a mechanism.
DROP POLICY IF EXISTS agent_memory_audit_events_service_role_all ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_plane            ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_plane_read       ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_closed           ON public.agent_memory_audit_events;

CREATE POLICY agent_memory_audit_events_closed ON public.agent_memory_audit_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (false) WITH CHECK (false);

COMMENT ON POLICY agent_memory_audit_events_closed ON public.agent_memory_audit_events IS
  'DELIBERATELY CLOSED. The audit trail is written and read by superuser connections (openbrain-mcp as postgres; the drill checks via docker exec psql). No deployed component reaches it through PostgREST, so the unauthenticated service_role door gets no row rather than a predicate with NULL arms an ON DELETE SET NULL can launder. See init-graph-plane-rls.sql section 2b.';

-- ==========================================================================================
-- 2c. THE SAME ABSENCE, ONE TABLE OVER: agent_memory_recall_traces
-- ==========================================================================================
-- Found by writing section 7(h) rather than by reading the schema, which is the point of an
-- assertion that tests a PROPERTY. 180 gives this table
-- `USING (ob_trace_on_ops_plane(request_payload)) WITH CHECK (true)`, with the comment
-- "WITH CHECK stays open so that writing a trace never fails". An open WITH CHECK is an arm
-- that permits unconditionally - absence included - and a trace carries the QUERY TEXT of a
-- recall. Combined with the unique `request_id`, a caller could write a trace naming any
-- request_id and read back from 23505 whether a hidden one already had it.
--
-- WITH CHECK is narrowed to the USING predicate. `ob_trace_on_ops_plane(NULL)` is FALSE (it
-- COALESCEs a missing `enforced_exposure` to `["personal"]`), so absence denies here without
-- a further arm. The write it "must not fail" is not through this door: every deployed writer
-- of a recall trace is `openbrain-mcp` as `postgres`, and section 6 withdraws the door's write
-- privilege on the corpus anyway.
DROP POLICY IF EXISTS agent_memory_recall_traces_plane ON public.agent_memory_recall_traces;

CREATE POLICY agent_memory_recall_traces_plane ON public.agent_memory_recall_traces
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_trace_on_ops_plane(request_payload))
  WITH CHECK (public.ob_trace_on_ops_plane(request_payload));

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

-- --- AND THE ARM IS DISPOSITIONED, BECAUSE IT IS THE SHAPE THIS FILE CALLS A HOLE ---------
-- `thought_id IS NULL OR ob_thought_visible(thought_id)` is, letter for letter, the shape
-- section 7(h) exists to refuse. It stays, and round 3's defence of it was the WRONG defence:
-- it said the arm is contained because section 6a withdraws the door's write. That is
-- CONTAINMENT - true today, undone by one GRANT - and not the property.
--
-- THE ACTUAL ARGUMENT, and it turns on what the absent value MEANS on THIS table. Everywhere
-- else this file touched, the NULL column WAS the plane: `idea_revisions.thought_id` absent
-- meant "this revision's plane cannot be established", so permitting was permitting the
-- unknown. On `agent_memories` the plane is established by a DIFFERENT column - `metadata`,
-- through ob_memory_on_ops_plane, which is fail-closed - and it is checked in the same
-- conjunction. `thought_id` absent is not an unestablished plane; it is a memory that was
-- never derived from a thought, which is the ordinary case (all 21 live rows that carry one
-- point at ops thoughts; the rest carry none).
--
-- AND THE ORACLE IS CLOSED INDEPENDENTLY OF THE ARM, which is the half that is checkable:
-- naming a HIDDEN thought_id and naming a NONEXISTENT one both fail at 42501, because the
-- visible() half of the OR refuses before the foreign-key trigger is consulted. Omitting the
-- column succeeds - and tells the caller nothing about any thought, which is the difference
-- between this arm and the idea_revisions one it looks identical to.
--
-- The disposition is written into the DATABASE, where section 7(h2) reads it, for the same
-- reason as ORACLE-DISPOSITION: a decision a gate can see is a decision, and a decision only
-- in a comment block is a habit. Removing either COMMENT turns the next apply RED.
COMMENT ON POLICY agent_memories_ops_plane ON public.agent_memories IS
  'NULL-ARM-DISPOSITION: WITH CHECK carries `thought_id IS NULL OR ob_thought_visible(thought_id)`. The plane of this row is established by metadata (ob_memory_on_ops_plane, fail-closed) in the same conjunction, NOT by thought_id; an absent thought_id is a memory not derived from a thought, not an unestablished plane. Hidden and nonexistent thought_id both fail 42501, so the arm is not an FK oracle. See init-graph-plane-rls.sql section 2c.';
COMMENT ON POLICY agent_memories_personal_plane ON public.agent_memories IS
  'NULL-ARM-DISPOSITION: same arm, same reason - the plane is established by user_id = ob_current_user_id() in the same conjunction, not by thought_id. See init-graph-plane-rls.sql section 2c.';

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
-- 4b. EVERY TRIGGER ON A GOVERNED RELATION IS DISPOSITIONED - AND prosecdef IS NOT THE TEST
-- ==========================================================================================
-- A DEFECT REPORT AGAINST ROUND 3'S SECTION 7(k). That assertion enumerated the SECURITY
-- DEFINER functions in `public` and called the definer-rights mechanism closed. The mechanism
-- it actually closes is narrower than the mechanism that leaks, and the difference was
-- measured, not argued:
--
--     CREATE FUNCTION u5g4_mirror_fn() RETURNS TRIGGER SECURITY INVOKER ...
--       INSERT INTO u5g4_mirror (thought_id, body, fp)
--       VALUES (NEW.id, NEW.content, encode(digest(NEW.content,'sha256'),'hex'));
--     CREATE TRIGGER trg_u5g4_mirror AFTER INSERT ON public.thoughts ...
--
--     -- the real writer of `thoughts` is openbrain-mcp, connecting as `postgres`
--     INSERT INTO thoughts (content, metadata) VALUES ('...secret', '{"exposure":"personal"}');
--     SET ROLE service_role;
--     SELECT body, left(fp,16) FROM u5g4_mirror;
--       U5G4-PERSONAL trigger-copied secret | 45dbdbebc164c338   <- content AND fingerprint
--       U5G4-OPS trigger-copied control     | 7b062dcc530803a4   <- the positive control
--
-- `prosecdef` is FALSE on that function. Round 3's file re-applied over exactly this state
-- and printed "post-conditions hold on 9 table(s), and the four mechanism sweeps ... are
-- clean". Flip that one attribute to TRUE and the same file goes RED - which is the proof
-- that the attribute is a PROXY and not the property. THE MECHANISM IS THE SESSION: a trigger
-- function runs with the authority of whoever wrote the row, and the writers of this corpus
-- are superuser sessions that no policy in this file binds. SECURITY DEFINER only adds a
-- second way to get there.
--
-- So the assertion is moved off the attribute and onto the SET: every non-internal trigger on
-- a relation in the derived governed population must be DISPOSITIONED, whatever its function's
-- prosecdef, whatever its timing, whatever its events. Section 7(m) reads these comments; a
-- trigger created tomorrow has none and turns the migration RED.
--
-- WHAT THIS DOES AND DOES NOT ESTABLISH, and the second half is the important one. It
-- establishes that no trigger is attached to a governed relation without somebody having
-- written down what it moves. It does NOT read the function body, and it does NOT see a
-- trigger on an UNGOVERNED relation that reads a governed one. Both are in the verdict's
-- not-covered census at the end of this file, and both are why that verdict no longer says
-- "clean".
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  -- Each disposition names what the trigger MOVES, because that is the only thing that
  -- decides whether it can carry a row across the boundary.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_queue_entity_extraction'
                                        AND tgrelid='public.thoughts'::regclass) THEN
    COMMENT ON TRIGGER trg_queue_entity_extraction ON public.thoughts IS
      'TRIGGER-DISPOSITION: MOVES sha256(thoughts.content) into entity_extraction_queue. SECURITY DEFINER, and GATED by section 4 of init-graph-plane-rls.sql - an off-plane or unlabelled thought produces no queue row and an ops-to-personal transition deletes the existing one. The queue is itself governed (tier A).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_thoughts_fingerprint'
                                        AND tgrelid='public.thoughts'::regclass) THEN
    COMMENT ON TRIGGER trg_thoughts_fingerprint ON public.thoughts IS
      'TRIGGER-DISPOSITION: MOVES NOTHING out of the row. Sets NEW.content_fingerprint on the same row it fires for; no INSERT, UPDATE or DELETE of any other relation in the body (read 2026-08-31). SECURITY INVOKER.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_touch_entities_on_thought_delete'
                                        AND tgrelid='public.thoughts'::regclass) THEN
    COMMENT ON TRIGGER trg_touch_entities_on_thought_delete ON public.thoughts IS
      'TRIGGER-DISPOSITION: MOVES a timestamp only. UPDATEs entities.updated_at for the entities the deleted thought cited; carries no content and no fingerprint. Flipped to SECURITY INVOKER by section 4, so as invoker each plane touches exactly what it cites.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_agent_memories_updated_at'
                                        AND tgrelid='public.agent_memories'::regclass) THEN
    COMMENT ON TRIGGER trg_agent_memories_updated_at ON public.agent_memories IS
      'TRIGGER-DISPOSITION: MOVES NOTHING. Sets NEW.updated_at on the same row. SECURITY INVOKER.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_thought_edges_updated_at'
                                        AND tgrelid='public.thought_edges'::regclass) THEN
    COMMENT ON TRIGGER trg_thought_edges_updated_at ON public.thought_edges IS
      'TRIGGER-DISPOSITION: MOVES NOTHING. Sets NEW.updated_at on the same row. SECURITY INVOKER.';
  END IF;

  SELECT string_agg(c.relname || '.' || t.tgname, ', ' ORDER BY c.relname || '.' || t.tgname)
    INTO v_missing
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r','p')
     AND c.relrowsecurity AND c.relforcerowsecurity
     AND COALESCE(obj_description(t.oid, 'pg_trigger'), '') NOT LIKE 'TRIGGER-DISPOSITION:%';
  IF v_missing IS NOT NULL THEN
    RAISE NOTICE 'init-graph-plane-rls: trigger(s) % on governed relations carry no '
                 'TRIGGER-DISPOSITION comment yet; section 7(m) will decide.', v_missing;
  END IF;
END $$;

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
-- 6a. THE WRITE DOOR CLOSES ON WHAT NOTHING WRITES THROUGH IT
-- ==========================================================================================
-- A POLICY IS NOT THE ONLY THING A WRITER CONSULTS. Postgres checks unique indexes and
-- foreign keys with internal machinery that RLS does not bind, and it checks them AFTER
-- WITH CHECK has passed. Section 7(i) and 7(j) assert that as a property; this section is
-- what makes it hold, and it holds by DEFAULT-DENY rather than by enumerating oracles:
-- a caller that cannot write a table cannot provoke any constraint on it.
--
-- WHO ACTUALLY WRITES, MEASURED, not assumed:
--   * The agent-memory corpus is written by `openbrain-mcp`, which connects as `postgres`
--     (verified on the live container; rolsuper = t). Nothing in either repository writes it
--     through PostgREST except `integrations/agent-memory-api/index.ts`, which is a Supabase
--     Edge Function present in no compose file here.
--   * `idea_revisions` is written by `openbrain-idea-refinery`, also as `postgres` (DB_USER
--     unset in the container; the code defaults to it).
--   * The tables that DO need a service_role write - `thought_entities`,
--     `entity_extraction_queue`, `thought_edges`, `entities` - keep every privilege they had.
--     The entity-extraction worker reaches them through PostgREST, and
--     `recipes/typed-edge-classifier/classify-edges.mjs` calls `thought_edges_upsert` (now
--     SECURITY INVOKER) as service_role.
--
-- SELECT IS UNTOUCHED EVERYWHERE. This withdraws INSERT/UPDATE/DELETE only, and only from
-- `service_role` and `authenticated`; revert-graph-plane-rls.sql re-grants them verbatim.
DO $$
DECLARE
  v_corpus TEXT[];
  v_t      TEXT;
BEGIN
  -- THE CORPUS IS DERIVED, not listed: `agent_memories`, every table with a FOREIGN KEY into
  -- it, and every GOVERNED parent of one of those children - which is how
  -- `agent_memory_recall_traces` joins the set, being a parent and never a child, the same
  -- blind spot section 0's referenced-by arm exists for. Add a sidecar tomorrow and it is
  -- closed on the next replay without anybody remembering to add it here.
  SELECT array_agg(DISTINCT t ORDER BY t) INTO v_corpus FROM (
    SELECT 'agent_memories'::text AS t
    UNION
    -- Children of agent_memories - EXCEPT any that is also part of the thought-derived graph.
    -- That exclusion is load-bearing and it was written after breaking things: while testing,
    -- a probe added a `uuid REFERENCES agent_memories(id)` column to `thought_entities`, which
    -- made it a child, and the loop below then stripped INSERT/UPDATE/DELETE from
    -- `thought_entities` AND from `thoughts` (reached by the parent arm) - the ingestion path
    -- and the entity worker, silently, on the next apply. A table that carries a foreign key
    -- into `thoughts` belongs to the corpus sections 2 and 3 govern, which HAS a live
    -- service_role write path, and this section must not walk into it.
    SELECT c.conrelid::regclass::text
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
       AND c.confrelid = 'public.agent_memories'::regclass
       AND NOT EXISTS (SELECT 1 FROM pg_constraint g
                        WHERE g.contype = 'f' AND g.connamespace = 'public'::regnamespace
                          AND g.conrelid = c.conrelid
                          AND g.confrelid = 'public.thoughts'::regclass)
    UNION
    SELECT p.confrelid::regclass::text
      FROM pg_constraint p
     WHERE p.contype = 'f' AND p.connamespace = 'public'::regnamespace
       AND p.conrelid IN (SELECT c.conrelid FROM pg_constraint c
                           WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
                             AND c.confrelid = 'public.agent_memories'::regclass
                             AND NOT EXISTS (SELECT 1 FROM pg_constraint g
                                              WHERE g.contype = 'f'
                                                AND g.connamespace = 'public'::regnamespace
                                                AND g.conrelid = c.conrelid
                                                AND g.confrelid = 'public.thoughts'::regclass))
       AND public.ob_relation_governed(p.confrelid::regclass::text)
  ) s;

  IF v_corpus IS NULL OR NOT ('agent_memories' = ANY (v_corpus)) OR array_length(v_corpus,1) < 3 THEN
    RAISE EXCEPTION 'init-graph-plane-rls: the agent-memory corpus derivation returned %, '
                    'which cannot be right - a derivation that finds only its own seed has '
                    'broken and would silently leave the corpus writable.',
                    COALESCE(array_to_string(v_corpus, ', '), '<nothing>');
  END IF;

  -- AND THE GATE ON THE GATE. A derivation that reaches a relation this file has already
  -- decided keeps its write path is a derivation that has walked out of its corpus, and the
  -- consequence is a production write path revoked by a migration nobody expected to touch
  -- it. This raises instead. It is stated as the eight relations sections 2 and 3 govern
  -- plus the seed, because those are exactly the ones whose write path this file has
  -- deliberately preserved.
  IF v_corpus && ARRAY['thoughts','thought_entities','entity_extraction_queue','thought_edges',
                       'entities','edges','source_entities','consolidation_log'] THEN
    RAISE EXCEPTION 'init-graph-plane-rls: the agent-memory corpus derivation reached %, which '
                    'this file governs with its write path INTACT. Revoking there would break '
                    'the ingestion and entity-extraction paths. Something grew a foreign key '
                    'into agent_memories; classify it before this runs again.',
                    array_to_string(v_corpus, ', ');
  END IF;

  FOREACH v_t IN ARRAY v_corpus || ARRAY['idea_revisions'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM service_role', v_t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM authenticated', v_t);
  END LOOP;

  RAISE NOTICE 'init-graph-plane-rls: write door closed on % relation(s): %, idea_revisions',
               array_length(v_corpus,1) + 1, array_to_string(v_corpus, ', ');
END $$;

-- ==========================================================================================
-- 6a2. THE TWO ORACLES THIS FILE DOES *NOT* CLOSE, RECORDED WHERE THE GATE READS THEM
-- ==========================================================================================
-- `thoughts` and `thought_edges` must stay writable through the door, and both have a
-- surrogate `id` primary key that no policy predicate mentions. A caller that supplies an
-- explicit `id` therefore learns from 23505-versus-success whether a row with that id exists,
-- including a row its policy hides. Section 7(i) FINDS this on every replay; it is
-- dispositioned here rather than fixed, and the disposition is a database COMMENT this file
-- writes and its own gate reads. Delete these two statements and the next apply goes RED
-- naming both constraints - measured, not asserted - which is what makes a unique constraint
-- that appears TOMORROW, with nobody to write it a comment, stop the migration.
--
-- WHY NOT FIXED, stated as a trade rather than a shrug. The fix is to withdraw the caller's
-- ability to NAME the column - `REVOKE INSERT ON t FROM service_role` followed by
-- `GRANT INSERT (every other column)` - because a table-level grant subsumes column grants.
-- That breaks, silently and at runtime, every service_role writer of any column added to the
-- table LATER; columns are added here (`init-agent-memory-embedding.sql` adds one to
-- `agent_memories`), so this is a live hazard, not a hypothetical. Bounded honestly: what
-- leaks is the EXISTENCE of an id, not any column of the row, and on `thoughts` the id space
-- is a shared sequence a caller can already read the watermark of.
COMMENT ON CONSTRAINT thoughts_pkey ON public.thoughts IS
  'ORACLE-DISPOSITION: (id) does not contain this table''s plane columns (metadata, user_id) and service_role can supply it, so 23505-vs-success is an existence oracle over hidden rows. NOT FIXED: the fix (column-level INSERT grants) breaks every writer of any column added later. Discloses existence of an id only. See init-graph-plane-rls.sql section 6a2; deleting that COMMENT statement re-raises section 7(i).';
COMMENT ON CONSTRAINT thought_edges_pkey ON public.thought_edges IS
  'ORACLE-DISPOSITION: same shape as thoughts_pkey - a surrogate (id) no policy mentions, on a table service_role must be able to write. NOT FIXED, same trade. See init-graph-plane-rls.sql section 6a2; deleting that COMMENT statement re-raises section 7(i).';

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
  --
  -- THE WALK IS TRANSITIVE, and the first version was not. It joined pg_rewrite to pg_depend
  -- ONCE, so it saw a matview sitting directly on a table and nothing else. Put ONE ordinary
  -- view in between and the migration COMMITted while the matview served the hidden row.
  -- Measured on the throwaway, at the round 2 file, with an ops control:
  --
  --     CREATE MATERIALIZED VIEW u5g3_transitive_mv AS SELECT * FROM ideas_owed_research;
  --       (ideas_owed_research JOINs idea_revisions, which is force-RLS and governed above)
  --     re-apply 200                                  -> COMMIT, "post-conditions hold"
  --     SET ROLE service_role; SELECT ... FROM u5g3_transitive_mv  -> 1 personal / 1 ops
  --     SET ROLE service_role; SELECT ... FROM ideas_owed_research -> 0 personal / 1 ops
  --
  -- One hop was all it took, and "a materialized view over a force-RLS relation is refused
  -- outright" was true only of a DIRECT pg_depend edge. Dependencies compose; a gate that
  -- walks one edge measures adjacency, not reachability.
  WITH RECURSIVE dep_edge AS (
    -- R depends on B when R's rewrite rule references B. Column-level (refobjsubid > 0) and
    -- whole-relation (refobjsubid = 0, as `count(*)` produces) deps both count.
    SELECT DISTINCT rw.ev_class AS rel, d.refobjid AS base
      FROM pg_rewrite rw
      JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass
                      AND d.refclassid = 'pg_class'::regclass
     WHERE rw.ev_class <> d.refobjid
  ), reach AS (
    SELECT rel, base FROM dep_edge
    UNION
    SELECT r.rel, e.base FROM reach r JOIN dep_edge e ON e.rel = r.base
  )
  SELECT array_agg(DISTINCT mv.relname || ' -> ' || base.relname ORDER BY mv.relname || ' -> ' || base.relname)
    INTO v_matview
    FROM reach r
    JOIN pg_class mv   ON mv.oid = r.rel
    JOIN pg_class base ON base.oid = r.base
   WHERE mv.relkind = 'm'
     AND base.relkind = 'r'
     AND base.relrowsecurity AND base.relforcerowsecurity;
  IF v_matview IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: materialized view(s) reach a FORCE-RLS relation: '
                    '%. A matview stores rows its owner computed; security_invoker does not '
                    'exist for it and RLS cannot reach them. The path may run through any '
                    'number of ordinary views. Classify it - drop it, or move it behind a '
                    'governed view - and re-run.',
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
  -- TIER B, named once so the exclusion below has a name rather than a filter.
  v_tier_b TEXT[] := ARRAY['entities','edges','source_entities','consolidation_log'];
  -- THE FLOOR: the relations this file and 180 are SPECIFIED to govern with a row-level
  -- predicate. Not the population - the minimum the population must contain.
  v_floor  TEXT[];
  -- THE POPULATION of the mechanism sweeps (h) (i) (j), DERIVED from the catalogue.
  v_scope  TEXT[];
  v_absent TEXT[] := ARRAY[]::TEXT[];
  v_permits BOOLEAN;
  v_rec    RECORD;
  -- THE VERDICT'S CENSUS COUNTERS. Declared here because the verdict at the end of this
  -- block is not a summary of the sweeps - it is a separate accounting that must BALANCE
  -- against pg_class, pg_constraint, pg_trigger and pg_proc.
  v_n_rel     INT; v_n_gov     INT; v_n_tierb  INT; v_n_plain INT; v_n_view INT;
  v_n_foreign INT; v_n_con_ok  INT; v_n_con_no INT; v_n_trg   INT; v_n_trg_out INT;
  v_n_fn_def  INT; v_n_fn_inv  INT; v_n_super  INT; v_n_pol   INT; v_n_disp    INT;
BEGIN
  -- THE POPULATION OF THE MECHANISM SWEEPS, AND WHY IT IS NOT A LIST IN THIS FILE.
  -- It was a list, until the recall seam handed back class 13/16 - "a checker deriving its
  -- population from the document under test: the artifact decides how much of itself is
  -- audited, and coverage still reads N of N because N shrank". A hardcoded scope array has
  -- exactly that shape one step removed: govern a new table in 180 tomorrow, or here, and the
  -- absence/uniqueness/foreign-key sweeps would report clean while never having looked at it.
  -- So the population is DERIVED - every FORCE-RLS table in public - and tier B is subtracted
  -- BY NAME, with its reason, so the exclusion is a decision on the record rather than a
  -- filter nobody re-reads. Its remedy for the class is applied too: a FLOOR taken from what
  -- this file and 180 are specified to govern is checked back against the derived population,
  -- so a subject that leaves the population is a FAILURE and not a smaller N.
  -- RELKIND, AND WHY IT IS A PAIR AND NOT A LETTER. Round 3 wrote `relkind = 'r'` here and
  -- called the population derived. `'r'` is ORDINARY TABLE; a PARTITIONED table is `'p'`, and
  -- a partitioned relation carries its own RLS flags and its own policies. Measured: a
  -- FORCE-RLS partitioned relation with `USING (true)` was live and readable through the door
  -- (1 personal / 1 ops) while round 3's file re-applied over it, COMMITted, and printed that
  -- the mechanism sweeps were clean. That is the third catalogue proxy this effort has been
  -- caught by, after `relkind='r'`'s cousins `indisunique` and `prosecdef`, and it is why the
  -- verdict at the end of this file now CENSUSES the relkinds it did not look at instead of
  -- summarising the ones it did.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_scope
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r','p')
     AND c.relrowsecurity AND c.relforcerowsecurity
     AND NOT (c.relname = ANY (v_tier_b));

  SELECT array_agg(DISTINCT t ORDER BY t) INTO v_floor
    FROM unnest(v_tier_a || v_governed || ARRAY['agent_memories','thoughts']) AS t;
  SELECT array_agg(t ORDER BY t) INTO v_bad
    FROM unnest(v_floor) AS t WHERE NOT (t = ANY (COALESCE(v_scope, ARRAY[]::TEXT[])));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: relation(s) % are in the FLOOR this file is '
                    'specified to govern and are NOT in the derived population of the '
                    'mechanism sweeps. A subject leaving the population is a failure, not a '
                    'smaller N.', array_to_string(v_bad, ', ');
  END IF;
  RAISE NOTICE 'init-graph-plane-rls: mechanism sweeps run over % derived relation(s), floor '
               'of % satisfied', array_length(v_scope, 1), array_length(v_floor, 1);

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

  -- (h) ABSENCE DENIES. THE PROPERTY, not a list of the places it was violated.
  --     Every leak this round closed was one shape: a policy arm of the form
  --     `X IS NULL OR visible(X)`, which permits exactly when the row's plane cannot be
  --     established. Enumerating the columns that must not be NULL would trail the schema
  --     forever, so this asserts the behaviour instead: take a row of the relation's own
  --     type with EVERY column NULL, evaluate each permissive policy expression against it,
  --     and require that no arm returns TRUE.
  --
  --     ROUND 3 WROTE HERE: "A policy that denies the all-absent row cannot have an arm that
  --     permits on absence." THAT SENTENCE IS FALSE and one policy in this very file
  --     disproves it. `agent_memories_ops_plane` WITH CHECK is
  --         ob_memory_on_ops_plane(metadata) AND (thought_id IS NULL OR visible(thought_id))
  --     Against the all-NULL probe row the FIRST conjunct is false, so the whole arm is
  --     false and this sweep passes it - while a real row with `metadata->>'exposure'='ops'`
  --     and `thought_id` absent is PERMITTED. The all-NULL row tests the CONJUNCTION, and an
  --     absence hole lives in a DISJUNCT. This probe is a real test that found a real leak
  --     (section 2c); it is not a decision procedure, and (h2) below exists because it is
  --     not. Neither of them is complete - see the verdict at the end of this file.
  --     It found agent_memory_recall_traces' `WITH CHECK (true)` - see section 2c - which no
  --     one had read as an absence arm, because it does not look like one.
  --     SCOPE is the relations that carry a row-level predicate: tier A, tier A2, the seven
  --     180 tables, `agent_memories` and `thoughts`. TIER B IS EXCLUDED and that is not an
  --     oversight: section 3 decides, names and COMMENTs that tier B is deliberately wide on
  --     the read side and contained at the WRITE, so asserting the opposite here would
  --     assert against this file's own decision.
  FOR v_rec IN
    SELECT p.tablename, p.policyname, p.qual, p.with_check
      FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
       AND p.tablename = ANY (v_scope)
     ORDER BY p.tablename, p.policyname
  LOOP
    IF v_rec.qual IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE((%s), false) FROM (SELECT (NULL::public.%I).*) AS %I',
                     v_rec.qual, v_rec.tablename, v_rec.tablename) INTO v_permits;
      IF v_permits THEN
        v_absent := v_absent || (v_rec.tablename || '.' || v_rec.policyname || ' USING');
      END IF;
    END IF;
    IF v_rec.with_check IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE((%s), false) FROM (SELECT (NULL::public.%I).*) AS %I',
                     v_rec.with_check, v_rec.tablename, v_rec.tablename) INTO v_permits;
      IF v_permits THEN
        v_absent := v_absent || (v_rec.tablename || '.' || v_rec.policyname || ' WITH CHECK');
      END IF;
    END IF;
  END LOOP;
  IF array_length(v_absent, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: policy arm(s) % PERMIT a row whose every column is '
                    'NULL. A row whose plane cannot be established must not be visible and '
                    'must not be writable; `X IS NULL OR visible(X)` is a hole, and an '
                    'unconditional WITH CHECK is the same hole written shorter. If the width '
                    'is DELIBERATE, subtract the relation into v_tier_b with its reason and a '
                    'COMMENT ON POLICY, the way sections 3 and 7 already treat tier B - the '
                    'one thing that must not happen is a wide policy on a FORCE-RLS table '
                    'that nobody decided.',
                    array_to_string(v_absent, ', ');
  END IF;

  -- (h2) EVERY LITERAL ABSENCE ARM IS DISPOSITIONED. (h) evaluates the all-NULL row and
  --     therefore cannot see an absence hole that sits in a DISJUNCT beside a conjunct the
  --     probe row already falsifies - which is exactly where `agent_memories`' surviving
  --     `thought_id IS NULL OR visible(thought_id)` sits. So the SHAPE is censused too, and
  --     every occurrence must carry a `NULL-ARM-DISPOSITION:` COMMENT ON POLICY saying why
  --     the absent value is not an unestablished plane. Section 2c writes the two that exist.
  --
  --     THIS ARM IS SYNTACTIC AND IT IS NOT COMPLETE. It matches the text `X IS NULL OR`
  --     and `OR X IS NULL` in a policy expression. `COALESCE(x, <permitting value>)`,
  --     `x IS NOT DISTINCT FROM NULL`, `NOT (x IS NOT NULL)` and a function that returns TRUE
  --     for its own absent input all mean the same thing and none of them matches. The one
  --     this round actually found - ob_trace_on_ops_plane permitting the EMPTY ARRAY, section
  --     1b - would not have matched either. It is a census that forces a decision on the
  --     instances of a known shape, not a proof that the shape is absent; that distinction is
  --     the whole content of the verdict at the end of this file.
  SELECT array_agg(DISTINCT p.tablename || '.' || p.policyname
                   ORDER BY p.tablename || '.' || p.policyname) INTO v_bad
    FROM pg_policies p
    JOIN pg_policy pol ON pol.polname = p.policyname
                      AND pol.polrelid = ('public.' || quote_ident(p.tablename))::regclass
   WHERE p.schemaname = 'public'
     AND p.permissive = 'PERMISSIVE'
     AND p.tablename = ANY (v_scope)
     -- THE PATTERN IS MATCHED AGAINST THE DEPARSED EXPRESSION, NOT AGAINST WHAT WAS
     -- TYPED, and pg_get_expr fully parenthesises: the arm written
     -- `thought_id IS NULL OR visible(thought_id)` reads back as
     -- `((thought_id IS NULL) OR visible(thought_id))`. The first version of this scan
     -- required whitespace between `null` and `or`, matched nothing, and passed the very
     -- two policies it was written for - caught by adversarial case J, which deleted a
     -- disposition and expected RED and got COMMIT. A gate that cannot go red for the
     -- instance it was written for is the effort's own class 1, one file on.
     AND (COALESCE(p.qual,'')       ~* '\mis\s+null[\s)]*or\M'
          OR COALESCE(p.qual,'')       ~* '\mor[\s(]*[a-z0-9_."]+\s+is\s+null\M'
          OR COALESCE(p.with_check,'') ~* '\mis\s+null[\s)]*or\M'
          OR COALESCE(p.with_check,'') ~* '\mor[\s(]*[a-z0-9_."]+\s+is\s+null\M')
     AND COALESCE(obj_description(pol.oid, 'pg_policy'), '') NOT LIKE 'NULL-ARM-DISPOSITION:%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: policy/policies % carry a literal `X IS NULL OR` '
                    'arm with no NULL-ARM-DISPOSITION comment. Either the absent value means '
                    'the row''s plane cannot be established - in which case remove the arm - '
                    'or it means something else, in which case say what, in a COMMENT ON '
                    'POLICY this gate can read.', array_to_string(v_bad, ', ');
  END IF;

  -- (i) NO KEY-CONSTRAINT ORACLE. A key constraint is not RLS-filtered and it is consulted
  --     AFTER WITH CHECK, so `error versus success` answers "does a row you cannot see
  --     exist?". That is how `idea_revisions_pkey (idea_id, revision)` answered for a hidden
  --     revision while the table's own read policy correctly returned nothing.
  --
  --     ROUND 3 KEYED THIS SWEEP ON `pg_index.indisunique` AND THAT IS A PROXY, NOT THE
  --     PROPERTY. An EXCLUSION constraint has `indisunique = false` on its index and refuses
  --     identically. Measured, on thought_entities carrying
  --     `EXCLUDE USING btree (entity_id WITH =, mention_role WITH =)` - which does NOT
  --     contain the plane column `thought_id` - as service_role, with the read control in the
  --     same session showing the read policy WORKING:
  --
  --       read thought_entities                       -> 0 personal / 1 ops   (policy holds)
  --       INSERT colliding with the HIDDEN row        -> 23P01 exclusion violation
  --       INSERT into a free slot, same statement     -> INSERT 0 1
  --
  --     The `idea_revisions` shape verbatim, one SQLSTATE over. And `x` was already in this
  --     file's own `contype IN ('p','u','x')` join filter, so the intent was there and the
  --     population could never deliver it. THE POPULATION IS NOW TAKEN FROM pg_constraint -
  --     every `p`, `u` and `x` on an in-scope relation - UNION the bare unique indexes that no
  --     constraint owns, because `CREATE UNIQUE INDEX` with no constraint is the same oracle
  --     with no catalogue row to hang a comment on.
  --
  --     A candidate is SAFE if any of three things is true, and all three are DERIVED:
  --       1. its columns CONTAIN the relation's plane columns (taken from pg_depend, which
  --          records exactly which columns each policy reads) - then a collision can only be
  --          with a row the caller may already see. FOR AN EXCLUSION CONSTRAINT this escape
  --          applies only when EVERY operator is `=`: with `&&` or `<>` a collision is not a
  --          duplicate and containing the plane column proves nothing about visibility.
  --       2. no role behind the door holds INSERT or UPDATE on the table - section 6a makes
  --          this true for the agent-memory corpus and idea_revisions;
  --       3. every column of it is a uuid defaulted to gen_random_uuid(), which cannot be
  --          collided with by guessing.
  --     Anything else must carry an `ORACLE-DISPOSITION:` COMMENT saying why (section 6a2).
  --
  --     STILL NOT COMPLETE, and the verdict says so: a CHECK constraint calling a function
  --     that reads a governed table, a deferred constraint trigger, and a domain constraint
  --     are all the same mechanism and none of them is in this population.
  WITH cand AS (
    SELECT c.relname AS tbl, c.oid AS reloid, con.oid AS objoid,
           'pg_constraint'::text AS objcat, con.conname AS objname, con.contype AS kind,
           (SELECT array_agg(a.attname ORDER BY a.attname)
              FROM unnest(con.conkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS cols,
           (SELECT count(*) FROM unnest(con.conkey) AS k(attnum) WHERE k.attnum = 0) AS expr_cols,
           (con.contype <> 'x'
            OR NOT EXISTS (SELECT 1 FROM unnest(con.conexclop) AS ex(opoid)
                             JOIN pg_operator o ON o.oid = ex.opoid
                            WHERE o.oprname <> '=')) AS equality_only
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
     WHERE con.contype IN ('p','u','x')
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (v_scope)
    UNION ALL
    -- a bare unique index: no constraint owns it, so obj_description reads pg_class instead
    SELECT c.relname, c.oid, i.oid, 'pg_class'::text, i.relname, 'i'::"char",
           (SELECT array_agg(a.attname ORDER BY a.attname)
              FROM unnest(x.indkey::int2[]) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum),
           (SELECT count(*) FROM unnest(x.indkey::int2[]) AS k(attnum) WHERE k.attnum = 0),
           true
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class c ON c.oid = x.indrelid
     WHERE x.indisunique
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (v_scope)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                        WHERE con.conindid = i.oid AND con.conrelid = c.oid
                          AND con.contype IN ('p','u','x'))
  ), planecols AS (
    SELECT pol.polrelid AS reloid, array_agg(DISTINCT a.attname) AS cols
      FROM pg_depend d
      JOIN pg_policy pol ON pol.oid = d.objid AND d.classid = 'pg_policy'::regclass
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
       AND d.refobjid = pol.polrelid
     GROUP BY 1
  )
  SELECT array_agg(cand.tbl || '.' || cand.objname ORDER BY cand.tbl || '.' || cand.objname)
    INTO v_bad
    FROM cand
    LEFT JOIN planecols pc ON pc.reloid = cand.reloid
   WHERE EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                  WHERE g.table_schema = 'public' AND g.table_name = cand.tbl
                    AND g.grantee IN ('service_role','authenticated')
                    AND g.privilege_type IN ('INSERT','UPDATE'))
     AND NOT (cand.expr_cols = 0
              AND cand.equality_only
              AND COALESCE(array_length(pc.cols, 1), 0) > 0
              AND pc.cols <@ cand.cols)
     AND NOT (cand.expr_cols = 0
              AND NOT EXISTS (
                    SELECT 1 FROM unnest(cand.cols) AS cn(attname)
                      JOIN pg_attribute a ON a.attrelid = cand.reloid AND a.attname = cn.attname
                      LEFT JOIN pg_attrdef ad ON ad.adrelid = cand.reloid AND ad.adnum = a.attnum
                     WHERE NOT (a.atttypid = 'uuid'::regtype
                                AND COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '')
                                    LIKE '%gen_random_uuid%')))
     AND COALESCE(obj_description(cand.objoid, cand.objcat), '') NOT LIKE 'ORACLE-DISPOSITION:%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: key constraint(s) % are an existence oracle on a '
                    'governed relation: their columns do not contain the plane columns, the '
                    'door can write the table, and they are not unguessable. Contain them, '
                    'withdraw the write, or record an ORACLE-DISPOSITION comment.',
                    array_to_string(v_bad, ', ');
  END IF;

  -- (j) NO FOREIGN-KEY ORACLE, derived. (g) above closes the one instance round 2 found by
  --     naming `agent_memories` and `thought_id` in the assertion itself; this is the same
  --     rule with nothing named. A foreign key is enforced by an internal trigger RLS does
  --     not bind, firing AFTER WITH CHECK, so `23503 versus success` separates a HIDDEN
  --     parent from a NONEXISTENT one - unless WITH CHECK already refused the row for naming
  --     an invisible parent. So: for every FK from an in-scope, door-writable relation into a
  --     GOVERNED parent, every referencing column must appear in the WITH CHECK of every
  --     permissive write policy on the child. A parent that is not governed (tier B's
  --     `entities`, the ungoverned `ideas`) is excluded, because a parent whose rows are all
  --     visible cannot be a hidden one.
  SELECT array_agg(DISTINCT con.conrelid::regclass::text || '.' || con.conname
                   ORDER BY con.conrelid::regclass::text || '.' || con.conname) INTO v_bad
    FROM pg_constraint con
   WHERE con.contype = 'f'
     AND con.connamespace = 'public'::regnamespace
     AND con.conrelid::regclass::text = ANY (v_scope)
     AND public.ob_relation_governed(con.confrelid::regclass::text)
     AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                  WHERE g.table_schema = 'public'
                    AND g.table_name = con.conrelid::regclass::text
                    AND g.grantee IN ('service_role','authenticated')
                    AND g.privilege_type IN ('INSERT','UPDATE'))
     AND EXISTS (
           SELECT 1
             FROM pg_policies p
             CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            WHERE p.schemaname = 'public'
              AND p.tablename = con.conrelid::regclass::text
              AND p.permissive = 'PERMISSIVE'
              AND p.cmd IN ('ALL','INSERT','UPDATE')
              AND (p.with_check IS NULL OR p.with_check !~ ('\m' || a.attname || '\M')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: foreign key(s) % point into a governed parent from '
                    'a table the door can write, and a write policy on that table does not '
                    'constrain the referencing column in WITH CHECK. The FK trigger answers '
                    'where the policy would not.', array_to_string(v_bad, ', ');
  END IF;

  -- (k) THE SECURITY DEFINER SET IS EXACTLY THE ONE SECTION 4 ACCOUNTS FOR - AND THIS IS ONE
  --     MECHANISM, NOT THE MECHANISM. Round 3's comment here said definer rights are "the
  --     fourth mechanism that walks around a policy" and treated asserting the SET as closing
  --     it. What actually walks around a policy is CODE RUNNING IN A SESSION THE POLICY DOES
  --     NOT BIND, and `prosecdef` is one of two ways to get there; the other is simply being
  --     written by a superuser, which every deployed writer of this corpus is. Section 4b
  --     records the measurement: an INVOKER trigger copying thought content and its sha256
  --     into a door-readable table leaked identically, and flipping `prosecdef` to true on
  --     the very same function is what turned this assertion red. So (k) still asserts the
  --     definer set - it is worth asserting - and (m) below asserts the set this one is a
  --     subset of.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosecdef
     AND p.proname NOT IN ('queue_entity_extraction','queue_source_extraction');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: unclassified SECURITY DEFINER function(s) in '
                    'public: %. A definer function runs as its superuser owner and no policy '
                    'in this file binds it. Classify it in section 4 - or drop the definer '
                    'rights - and re-run.', array_to_string(v_bad, ', ');
  END IF;

  -- (m) EVERY TRIGGER ON A GOVERNED RELATION IS DISPOSITIONED, WHATEVER ITS ATTRIBUTES. The
  --     assertion (k) could not make: a trigger fires inside the writer's transaction with
  --     the writer's authority, so on this database - where the writers are superuser
  --     sessions - it is not bound by any policy in this file whether its function is DEFINER
  --     or INVOKER, BEFORE or AFTER, ROW or STATEMENT. There is no attribute that separates a
  --     safe one from a leaking one, so nothing is inferred from an attribute: the SET is
  --     censused and each member must carry a `TRIGGER-DISPOSITION:` COMMENT ON TRIGGER
  --     naming what it MOVES. Section 4b writes the five that exist on this schema.
  --
  --     WHAT THIS PROVES: that no trigger is attached to a governed relation without somebody
  --     having written down what it moves, and that one appearing tomorrow stops the
  --     migration. WHAT IT DOES NOT PROVE: that any disposition is TRUE - this reads a
  --     comment, not a function body - and it does not see a trigger on an UNGOVERNED
  --     relation that READS a governed one. Both are counted in the verdict's not-covered
  --     census below.
  SELECT array_agg(c.relname || '.' || t.tgname ORDER BY c.relname || '.' || t.tgname)
    INTO v_bad
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND c.relnamespace = 'public'::regnamespace
     AND c.relname = ANY (v_scope)
     AND COALESCE(obj_description(t.oid, 'pg_trigger'), '') NOT LIKE 'TRIGGER-DISPOSITION:%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: trigger(s) % are attached to a governed relation '
                    'and carry no TRIGGER-DISPOSITION comment. A trigger runs in the writer''s '
                    'session, and the writers of this corpus are superuser sessions no policy '
                    'binds - SECURITY INVOKER is not a defence. Say what it moves, in a '
                    'COMMENT ON TRIGGER this gate can read, or drop it.',
                    array_to_string(v_bad, ', ');
  END IF;

  -- (n) A PARTITIONED RELATION IS GOVERNED ONLY WHERE ITS LEAVES ARE. Policies on a
  --     partitioned parent apply to a query THROUGH THE PARENT; a query naming a leaf
  --     partition directly is bound by the LEAF's own RLS state, which is a separate set of
  --     catalogue flags and a separate set of policies. PostgREST addresses relations by
  --     name, so a leaf is a door of its own. Every leaf of an in-scope partitioned relation
  --     must therefore be RLS-enabled and FORCED itself, or hold no privilege for either door
  --     role. No partitioned relation exists in this schema today; this assertion is here
  --     because `relkind='r'` was believed to be the population until 2026-08-31, and the
  --     next person to add one should not have to rediscover which half of it is governed.
  SELECT array_agg(DISTINCT ch.relname ORDER BY ch.relname) INTO v_bad
    FROM pg_inherits inh
    JOIN pg_class par ON par.oid = inh.inhparent
    JOIN pg_class ch  ON ch.oid  = inh.inhrelid
   WHERE par.relnamespace = 'public'::regnamespace
     AND par.relname = ANY (v_scope)
     AND par.relkind = 'p'
     AND NOT (ch.relrowsecurity AND ch.relforcerowsecurity)
     AND EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                  WHERE g.table_schema = 'public' AND g.table_name = ch.relname
                    AND g.grantee IN ('service_role','authenticated'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: partition(s) % of a governed partitioned relation '
                    'are reachable by a door role and are not themselves RLS-enabled and '
                    'FORCED. A query naming a partition directly is bound by the partition, '
                    'not by its parent.', array_to_string(v_bad, ', ');
  END IF;

  -- (l) NOTHING REACHES A GOVERNED RELATION AROUND THE BOUNDARY, TRANSITIVELY. (f) asserts
  --     the flag on views in `public`; this asserts REACHABILITY, over any number of hops
  --     and in any schema, for the two relkinds that can carry rows past a policy: a
  --     materialized view (stored rows, no security_invoker option at all) and an ordinary
  --     view still running as its owner. The one-edge version of this walk COMMITted while
  --     a matview one hop from `idea_revisions` served the hidden row.
  WITH RECURSIVE dep_edge AS (
    SELECT DISTINCT rw.ev_class AS rel, d.refobjid AS base
      FROM pg_rewrite rw
      JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass
                      AND d.refclassid = 'pg_class'::regclass
     WHERE rw.ev_class <> d.refobjid
  ), reach AS (
    SELECT rel, base FROM dep_edge
    UNION
    SELECT r.rel, e.base FROM reach r JOIN dep_edge e ON e.rel = r.base
  )
  SELECT array_agg(DISTINCT rl.relname || ' -> ' || bs.relname
                   ORDER BY rl.relname || ' -> ' || bs.relname) INTO v_bad
    FROM reach r
    JOIN pg_class rl ON rl.oid = r.rel
    JOIN pg_class bs ON bs.oid = r.base
   WHERE bs.relkind IN ('r','p') AND bs.relrowsecurity AND bs.relforcerowsecurity
     AND (rl.relkind = 'm'
          OR (rl.relkind = 'v'
              AND COALESCE((SELECT option_value FROM pg_options_to_table(rl.reloptions)
                             WHERE option_name = 'security_invoker'), 'false') <> 'true'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-graph-plane-rls: relation(s) % reach a FORCE-RLS table without '
                    'being bound by it. A stored matview or an owner-rights view is a read '
                    'path around every policy above, however many views it goes through.',
                    array_to_string(v_bad, ', ');
  END IF;

  -- ========================================================================================
  -- THE VERDICT. WHAT WAS CHECKED, AND WHAT WAS NOT.
  -- ========================================================================================
  -- ROUND 3 PRINTED HERE: "post-conditions hold on 9 table(s), and the four mechanism sweeps
  -- (absence, uniqueness, foreign keys, reachability) are clean". IT PRINTED THAT THREE TIMES
  -- - once per round - and on 2026-08-31 it printed it, on a COMMITted apply, over a database
  -- that simultaneously carried an exclusion-constraint existence oracle on `thought_entities`,
  -- a FORCE-RLS PARTITIONED relation with `USING (true)`, and an INVOKER trigger copying
  -- thought content and its sha256 into a door-readable table. All three were measured through
  -- the door in the same session, each with a live ops positive control. THAT SENTENCE WAS THE
  -- DEFECT: it reported the absence of a finding as the presence of a property.
  --
  -- Three rounds, three sweeps, each keyed on a CATALOGUE PROXY rather than on the property -
  -- `relkind='r'`, `indisunique`, `prosecdef` - and each time widening the alphabet bought one
  -- round. A gate that enumerates dangerous patterns cannot be complete, because the next
  -- catalogue attribute is always there. What CAN be complete is the accounting: every
  -- relation, constraint, trigger and function in this schema lands in exactly one bucket -
  -- examined by a named sweep, or NOT examined with the reason - and the buckets must BALANCE
  -- against the catalogue's own totals or this migration fails. A member that falls outside
  -- every bucket is unaccounted, and unaccounted is a FAILURE, not a smaller N. That is the
  -- shape scripts/agent-harness/andon.ps1 already uses to make the word `clear` mean something,
  -- and it is borrowed here on purpose.
  --
  -- SO THE POLICIES DENY BY DEFAULT AND THE VERDICT DOES NOT CLAIM THEY ARE PROVEN TO. Those
  -- are two different deliverables, and conflating them is what produced three false clean
  -- verdicts.
  SELECT count(*) INTO v_n_rel FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','f','m','v');
  SELECT count(*) INTO v_n_gov FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')
     AND relname = ANY (v_scope);
  SELECT count(*) INTO v_n_tierb FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relname = ANY (v_tier_b);
  SELECT count(*) INTO v_n_plain FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')
     AND NOT (relname = ANY (v_scope)) AND NOT (relname = ANY (v_tier_b));
  SELECT count(*) INTO v_n_view FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind IN ('v','m');
  SELECT count(*) INTO v_n_foreign FROM pg_class
   WHERE relnamespace='public'::regnamespace AND relkind = 'f';
  IF v_n_gov + v_n_tierb + v_n_plain + v_n_view <> v_n_rel THEN
    RAISE EXCEPTION 'init-graph-plane-rls: the relation census does not balance - % relations '
                    'in public, % governed + % tier B + % ungoverned + % views/matviews = %. '
                    'A relation outside every bucket is unaccounted, and unaccounted is a '
                    'failure, not a smaller N.',
                    v_n_rel, v_n_gov, v_n_tierb, v_n_plain, v_n_view,
                    v_n_gov + v_n_tierb + v_n_plain + v_n_view;
  END IF;
  IF v_n_foreign > 0 THEN
    RAISE EXCEPTION 'init-graph-plane-rls: % FOREIGN TABLE(s) exist in public. RLS on a '
                    'foreign table constrains nothing about the remote side, and no sweep in '
                    'this file looks at one. Classify them before this runs again.',
                    v_n_foreign;
  END IF;

  SELECT count(*) INTO v_n_con_ok
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY (v_scope)
     AND con.contype IN ('p','u','x');
  SELECT count(*) INTO v_n_con_no
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY (v_scope)
     AND con.contype NOT IN ('p','u','x','f');
  SELECT count(*) INTO v_n_trg
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
     AND c.relname = ANY (v_scope);
  SELECT count(*) INTO v_n_trg_out
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
     AND NOT (c.relname = ANY (v_scope));
  SELECT count(*) INTO v_n_fn_def FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND prosecdef;
  SELECT count(*) INTO v_n_fn_inv FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND NOT prosecdef;
  SELECT count(*) INTO v_n_super FROM pg_roles WHERE rolsuper OR rolbypassrls;
  SELECT count(*) INTO v_n_pol
    FROM pg_policies WHERE schemaname='public' AND tablename = ANY (v_scope);
  SELECT count(*) INTO v_n_disp
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
   WHERE c.relnamespace='public'::regnamespace
     AND COALESCE(obj_description(con.oid,'pg_constraint'),'') LIKE 'ORACLE-DISPOSITION:%';

  RAISE NOTICE '=== init-graph-plane-rls VERDICT: what was checked ===';
  RAISE NOTICE '  relations in public: % total = % governed (relkind r,p; RLS enabled+forced) '
               '+ % tier B (deliberately wide on read, contained at the write, section 3) '
               '+ % ungoverned + % views/matviews. Census BALANCES.',
               v_n_rel, v_n_gov, v_n_tierb, v_n_plain, v_n_view;
  RAISE NOTICE '  swept: (h) % permissive policy arm(s) EXECUTED against an all-NULL row; '
               '(h2) the same arms scanned for a literal absence arm; (i) % key constraint(s) '
               'of contype p,u,x plus bare unique indexes; (j) foreign keys into governed '
               'parents; (k) % SECURITY DEFINER function(s); (m) % trigger(s) on governed '
               'relations, all attributes; (n) partitions of governed parents; (l) transitive '
               'view/matview reachability, any schema.',
               v_n_pol, v_n_con_ok, v_n_fn_def, v_n_trg;
  RAISE NOTICE '=== NOT checked, and each one is a way this boundary could still be open ===';
  RAISE NOTICE '  * SUPERUSER SESSIONS. % role(s) hold rolsuper or rolbypassrls. RLS binds '
               'none of them, FORCE included, and nine deployed OB1 clients connect as '
               '`postgres`. Every sweep above is a statement about non-superuser door roles '
               'only. This is U5 steps 2-3 (SET ROLE, then dedicated credentials), DEFERRED '
               'by the operator - not closed here.', v_n_super;
  RAISE NOTICE '  * CONSTRAINT-VIOLATION ORACLES that remain BY DECISION: % ORACLE-DISPOSITION '
               'comment(s) in this database record a constraint the door can still provoke. '
               'They leak EXISTENCE, not content. Closing them properly means the door not '
               'being able to write the table, or the plane column being in the constraint.',
               v_n_disp;
  RAISE NOTICE '  * OTHER CONSTRAINT TYPES: % constraint(s) of contype other than p,u,x,f on '
               'governed relations were NOT examined as oracles - a CHECK calling a function '
               'that reads a governed table, or a constraint trigger, refuses on exactly the '
               'same evidence.', v_n_con_no;
  RAISE NOTICE '  * TRIGGER AND FUNCTION BODIES. (m) reads a COMMENT, not code: a '
               'TRIGGER-DISPOSITION that is WRONG passes. % trigger(s) on UNGOVERNED '
               'relations in public were not examined at all, and any of them may READ a '
               'governed one. % SECURITY INVOKER function(s) in public were not examined.',
               v_n_trg_out, v_n_fn_inv;
  RAISE NOTICE '  * OTHER SCHEMAS. Only public is censused, except (l), which walks '
               'reachability across schemas. Objects elsewhere are outside every other sweep.';
  RAISE NOTICE '  * ABSENCE ARMS THAT DO NOT LOOK LIKE ONE. (h) tests the all-NULL row and '
               'therefore cannot see a hole in a disjunct beside a false conjunct; (h2) is a '
               'TEXT scan for one spelling. COALESCE(x, <permitting value>), an empty-set '
               'containment - which is what section 1b actually fixed - and a function that '
               'returns TRUE for its own absent input all evade both.';
  RAISE NOTICE '=== ABSENCE OF A FINDING ABOVE IS NOT A PROOF OF THE PROPERTY. This file  ===';
  RAISE NOTICE '=== makes the policies deny by default; the sweeps are evidence that some  ===';
  RAISE NOTICE '=== named ways around them are closed, over a population that BALANCES.    ===';
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
