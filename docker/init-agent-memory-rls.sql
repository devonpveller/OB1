-- init-agent-memory-rls.sql
--
-- THE EXPOSURE BOUNDARY, MOVED INTO THE DATABASE.
--
-- WHY THIS FILE EXISTS. dark-factory-unification PLAN.md amendment A2 (2026-08-30) retires
-- the method that five previous rounds used: find every reader of the personal plane, put a
-- predicate in it, then argue the list is complete. It lost five times, and the measurement
-- that ended the argument is this one:
--
--     agent_memories: relrowsecurity = t, relforcerowsecurity = f, owner postgres,
--     and ONE policy - agent_memories_service_role_all | ALL | {service_role} | USING (true)
--     thoughts:       relrowsecurity = f.  RLS off entirely.
--
-- Four rounds guarded readers of a table whose own access policy said ALLOW EVERYTHING, and
-- a table that had no policy at all. This file makes the predicate the DATABASE's, so a
-- reader nobody enumerated is bound by it too.
--
-- ------------------------------------------------------------------------------------------
-- TWO INDEPENDENT AXES, both already native to this database (A2)
-- ------------------------------------------------------------------------------------------
--
-- AXIS 1 - TENANCY IS A COLUMN PLUS A SESSION VARIABLE. user_id = ob_current_user_id(),
--   where that function reads a GUC the caller sets with SET LOCAL ob.user_id = '<uuid>'.
--   SET LOCAL and never plain SET: a pooled connection carries a plain SET into the next
--   request, which is how one tenant's context becomes another's. A Postgres ROLE PER TENANT
--   is the documented anti-pattern and is not used. This database already runs the column
--   pattern one table over - auth.uid() = user_id on household_items, recipes, meal_plans,
--   shopping_lists.
--
-- AXIS 2 - ACCESS CLASS IS A ROLE. service_role IS the general/ops access class: it is the
--   role PostgREST switches into for every anonymous request (PGRST_DB_ANON_ROLE), and it is
--   therefore the role every PostgREST-mediated reader in this stack already runs as - the
--   scheduled wiki compiler, the recipes, rpc/*. Its policy below sees ops content and never
--   personal content, so those readers are bound WITHOUT one line of their code changing and
--   WITHOUT touching PGRST_DB_URI / PGRST_DB_ANON_ROLE / PGRST_DB_SCHEMAS (out of scope: the
--   whole-schema projection is its own item). ob_plane_personal is the second access class,
--   a member of service_role, and it is the ONLY role that can see a personal row - and then
--   only its own tenant's.
--
-- AGENTS ARE NEVER MODELLED AS USERS (operator decision, 2026-08-30). Open Brain must support
-- real multiple humans; pseudo-user identities per agent do not scale. Agents live on axis 2.
--
-- ------------------------------------------------------------------------------------------
-- WHAT THIS FILE CANNOT DO, STATED HERE RATHER THAN DISCOVERED LATER
-- ------------------------------------------------------------------------------------------
--
-- RLS DOES NOT BIND A SUPERUSER. Not with FORCE ROW LEVEL SECURITY, not with any policy:
-- "Superusers and roles with the BYPASSRLS attribute always bypass the row security system."
-- FORCE binds the table OWNER; superusers are exempt from FORCE as well.
--
-- MEASURED 2026-08-30 on the live stack - NINE containers connect to openbrain-db as
-- postgres, which is both the owner and a superuser:
--   openbrain-mcp, openbrain-ext, openbrain-workbench, openbrain-suggestion-worker,
--   openbrain-research, openbrain-curator, openbrain-grounding-backfiller,
--   openbrain-chunk-worker (all DB_USER=postgres), and openbrain-postgrest
--   (PGRST_DB_URI=postgres://postgres:...).
-- Only the last of those is bound by this file, and it is bound because PostgREST SWITCHES
-- ROLE to service_role before it runs the request. The other eight are exempt until their
-- connection stops being a superuser one - either DB_USER changes, or the process issues
-- SET ROLE at its connection chokepoint. That is a follow-on item; see
-- documentation/notes/u5rls-findings.md for the design and the measured obstacle.
--
-- So the honest scope of this file is: EVERY NON-SUPERUSER READER IS BOUND, INCLUDING EVERY
-- READER THAT GOES THROUGH POSTGREST, INCLUDING ONES NOBODY HAS WRITTEN YET. The application
-- guards on OB1's own readers (the round 4-6 work) stay exactly where they are, as defence in
-- depth; they stop being the completeness proof.
--
-- ------------------------------------------------------------------------------------------
-- ADDITIVE AND REVERSIBLE
-- ------------------------------------------------------------------------------------------
-- Adds two columns, five indexes, six functions, one role, two views; replaces policies with
-- narrower ones of the same shape; sets FORCE ROW LEVEL SECURITY; revokes TRUNCATE. It DROPS
-- NOTHING that holds data - no table, no column, no row.
-- REVERT: revert-agent-memory-rls.sql beside this file restores the previous
-- USING (true) policies, clears FORCE, disables RLS on thoughts and re-grants TRUNCATE. The
-- added columns/indexes/functions/views/role are inert once the policies are wide again and
-- are left in place deliberately (dropping a column is not reversible).
--
-- TWO PLACES, ALWAYS: mounted in the initdb chain at 180- for fresh volumes, and applied to
-- the live volume per
-- documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md. A migration
-- that reaches only one place is not deployed - init-agent-memory-embedding.sql reached only
-- the mount, and a fresh database and the live one disagreed about a column the write path
-- needs.

BEGIN;

-- ==========================================================================================
-- 1. AXIS 1 - the tenancy column, added while agent_memories holds 4 rows
-- ==========================================================================================
-- TEXT, not UUID: DEFAULT_USER_ID is a UUID today but workspace/agent identity in this stack
-- is TEXT everywhere else (workspace_id, project_id, task_id), and a type mismatch at the
-- policy boundary is a cast in a hot predicate.
ALTER TABLE public.agent_memories ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.thoughts       ADD COLUMN IF NOT EXISTS user_id TEXT;

-- THE TENANCY COLUMN IS THE LEADING INDEX COLUMN. A policy predicate that is not indexable
-- turns every RLS-filtered query into a sequential scan; thoughts is 12,993 rows today and
-- wiki_pages next door is 48,032, so this is not hypothetical.
CREATE INDEX IF NOT EXISTS idx_agent_memories_tenant
  ON public.agent_memories (user_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_tenant
  ON public.thoughts (user_id, created_at DESC);

-- The exposure label is the OTHER half of every policy below, so it is indexed as an
-- expression. (thoughts.metadata already has a GIN index, but metadata->>'exposure' is not
-- a jsonb containment query and does not use it.)
CREATE INDEX IF NOT EXISTS idx_agent_memories_exposure
  ON public.agent_memories ((metadata->>'exposure'));
CREATE INDEX IF NOT EXISTS idx_thoughts_exposure
  ON public.thoughts ((metadata->>'exposure'));

-- The sidecar policies resolve the parent memory by id; the PK covers that. The one FK
-- without an index of its own is recall_items -> memory.
CREATE INDEX IF NOT EXISTS idx_agent_memory_recall_items_memory
  ON public.agent_memory_recall_items (memory_id);

-- ==========================================================================================
-- 2. AXIS 2 - the access-class role
-- ==========================================================================================
-- NOLOGIN and NOBYPASSRLS, deliberately. NOLOGIN because a plane is something a connection
-- SWITCHES INTO (SET ROLE), exactly as PostgREST does - a login role would need a secret, and
-- a secret is a thing that gets shared. NOBYPASSRLS because a plane role that can bypass RLS
-- is not a plane.
--
-- MEMBER OF service_role, so it inherits every grant and every existing TO service_role
-- policy in this schema (graph, claims, threads, ideas, sessions...). Without that, switching
-- to it would black out two dozen tables that have nothing to do with exposure. RLS policies
-- apply to any role the current user is a MEMBER of, so ob_plane_personal gets the ops
-- policies below by inheritance and its own personal policies by name - permissive policies
-- are OR'd, so the union is "ops content, plus my own tenant's personal content".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_plane_personal') THEN
    CREATE ROLE ob_plane_personal NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT service_role TO ob_plane_personal;

-- ==========================================================================================
-- 3. The predicates, as functions, so there is ONE definition of each
-- ==========================================================================================
-- Each is the same rule as its TypeScript twin in
-- OB1/integrations/kubernetes-deployment/agent-memory-plane.ts. Two copies of a rule are two
-- things that can disagree; these are the copies that cannot be omitted, because the database
-- applies them whether or not the caller remembered to.
--
-- DOLLAR-QUOTED WITH the standard tag AND CLOSED ON ITS OWN LINE, and that is not a style
-- preference: the completeness gate in agent-memory-plane.test.ts extracts a function body as
-- the text up to the first close-tag line. A tag it does not know (fn, body) makes it read the
-- REST OF THE FILE as the body, and every helper here is then reported as an unguarded corpus
-- reader. Measured: 225 passed / 2 failed with a custom tag, 226 / 1 with the standard one
-- (the remaining failure is pre-existing and unrelated - see documentation/notes/u5rls-findings.md).
--
-- SECURITY INVOKER (the default) on every one of them. A SECURITY DEFINER function here would
-- run as the superuser owner and hand back exactly what the policy exists to withhold.

-- The tenant of the current transaction. Empty string is treated as unset so that
-- SET LOCAL ob.user_id = '' cannot match a row whose user_id is somehow ''.
CREATE OR REPLACE FUNCTION public.ob_current_user_id() RETURNS TEXT
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('ob.user_id', true), '')
$$;

-- agent_memories: the twin of planePredicate(). EQUALITY, so an ABSENT label is NOT ops -
-- default-deny, matching mirrorsToUnifiedSearch's `exposure ?? "personal"`. A NULL from the
-- comparison is treated as false by the policy machinery, which is the direction we want.
CREATE OR REPLACE FUNCTION public.ob_memory_on_ops_plane(md JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT md->>'exposure' = 'ops'
$$;

-- thoughts: the twin of corpusPlanePredicate(). An ABSENT label means the row is unclaimed
-- general corpus (12,989 of 12,993 production rows, measured 2026-08-30) and stays visible; a
-- PRESENT label means the agent-memory mirror claimed the row for a plane, and only ops is
-- served. Different default from the memory predicate ON PURPOSE, and that difference is the
-- reason there are two functions rather than one with a flag.
CREATE OR REPLACE FUNCTION public.ob_corpus_on_ops_plane(md JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT md->>'exposure' IS NULL OR md->>'exposure' = 'ops'
$$;

-- recall traces: the twin of tracePlanePredicate(). A trace has no metadata.exposure; it has
-- request_payload.enforced_exposure, a LIST, so this is jsonb containment. COALESCE to
-- ["personal"] is the safe end - a trace written before that field existed is invisible to
-- the ops plane rather than visible to it.
CREATE OR REPLACE FUNCTION public.ob_trace_on_ops_plane(rp JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(rp->'enforced_exposure', '["personal"]'::jsonb) <@ '["ops"]'::jsonb
$$;

-- The sidecars carry a memory's content in fragments (review_actions.before/after are whole
-- row snapshots; recall_items carry the policy snapshot). Rather than restate the exposure
-- rule five times, each sidecar asks whether ITS PARENT MEMORY IS VISIBLE TO THIS CALLER -
-- and because this function is SECURITY INVOKER, the SELECT inside it is itself subject to
-- agent_memories' policies. One predicate, evaluated by the row it belongs to.
CREATE OR REPLACE FUNCTION public.ob_memory_visible(p_memory_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.agent_memories m WHERE m.id = p_memory_id)
$$;

GRANT EXECUTE ON FUNCTION public.ob_current_user_id()          TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_memory_on_ops_plane(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_corpus_on_ops_plane(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_trace_on_ops_plane(JSONB)  TO service_role;
GRANT EXECUTE ON FUNCTION public.ob_memory_visible(UUID)       TO service_role;

-- ==========================================================================================
-- 4. agent_memories - replace USING (true)
-- ==========================================================================================
-- The wide policy is DROPPED rather than joined by a narrow one, because permissive policies
-- are OR'd: leaving USING (true) in place and adding a predicate beside it changes nothing at
-- all. This is the single most important statement in the file.
DROP POLICY IF EXISTS agent_memories_service_role_all ON public.agent_memories;

CREATE POLICY agent_memories_ops_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_on_ops_plane(metadata))
  WITH CHECK (public.ob_memory_on_ops_plane(metadata));

-- ACCESS BOUNDS WRITES, in the database: the WITH CHECK above means an ops-plane connection
-- cannot MINT a personal memory either, which is memory-plane PLAN 1.1's invariant stated as
-- a constraint rather than as a convention. A personal memory is written by a personal-plane
-- connection, which is this policy:
CREATE POLICY agent_memories_personal_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO ob_plane_personal
  USING      (user_id IS NOT NULL AND user_id = public.ob_current_user_id())
  WITH CHECK (user_id IS NOT NULL AND user_id = public.ob_current_user_id());

-- ==========================================================================================
-- 5. The sidecars - visible exactly when their parent memory is
-- ==========================================================================================
DROP POLICY IF EXISTS agent_memory_source_refs_service_role_all    ON public.agent_memory_source_refs;
DROP POLICY IF EXISTS agent_memory_artifacts_service_role_all      ON public.agent_memory_artifacts;
DROP POLICY IF EXISTS agent_memory_relations_service_role_all      ON public.agent_memory_relations;
DROP POLICY IF EXISTS agent_memory_review_actions_service_role_all ON public.agent_memory_review_actions;
DROP POLICY IF EXISTS agent_memory_recall_items_service_role_all   ON public.agent_memory_recall_items;
DROP POLICY IF EXISTS agent_memory_recall_traces_service_role_all  ON public.agent_memory_recall_traces;

CREATE POLICY agent_memory_source_refs_plane ON public.agent_memory_source_refs
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_memory_visible(memory_id)) WITH CHECK (public.ob_memory_visible(memory_id));

CREATE POLICY agent_memory_artifacts_plane ON public.agent_memory_artifacts
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_memory_visible(memory_id)) WITH CHECK (public.ob_memory_visible(memory_id));

-- BOTH ends, because a relation names two memories and the id of an invisible one is itself a
-- disclosure ("a personal memory about X exists and is superseded by this ops one").
CREATE POLICY agent_memory_relations_plane ON public.agent_memory_relations
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_visible(from_memory_id) AND public.ob_memory_visible(to_memory_id))
  WITH CHECK (public.ob_memory_visible(from_memory_id) AND public.ob_memory_visible(to_memory_id));

-- before/after are FULL ROW SNAPSHOTS of the memory. This table is a content home, not
-- bookkeeping.
CREATE POLICY agent_memory_review_actions_plane ON public.agent_memory_review_actions
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_memory_visible(memory_id)) WITH CHECK (public.ob_memory_visible(memory_id));

CREATE POLICY agent_memory_recall_items_plane ON public.agent_memory_recall_items
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_memory_visible(memory_id)) WITH CHECK (public.ob_memory_visible(memory_id));

-- A trace carries the QUERY TEXT and the full request payload of a recall - the envelope
-- naming what a personal-plane agent went looking for. WITH CHECK stays open so that writing
-- a trace never fails; reading one is what this is about.
CREATE POLICY agent_memory_recall_traces_plane ON public.agent_memory_recall_traces
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_trace_on_ops_plane(request_payload)) WITH CHECK (true);

-- agent_memory_audit_events is DELIBERATELY LEFT WIDE. Its payload is {tool, reason} and a
-- memory id (auditRefusal, agent-memory-plane.ts:246-250) - no summary, no content. Narrowing
-- it would hide the access_refused rows that are the drill's evidence that a refusal
-- happened, which trades the visible half of "stopped AND left a mark" for nothing. If audit
-- payloads ever carry content, this decision changes with them.

-- ==========================================================================================
-- 6. thoughts - RLS was OFF ENTIRELY, and thoughts is where the mirrored content lives
-- ==========================================================================================
-- performWriteback mirrors a memory's FULL CONTENT into this table stamped with
-- metadata.exposure, and until now nothing anywhere read that label. This is the floor.
ALTER TABLE public.thoughts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thoughts_ops_plane      ON public.thoughts;
DROP POLICY IF EXISTS thoughts_personal_plane ON public.thoughts;

CREATE POLICY thoughts_ops_plane ON public.thoughts
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_corpus_on_ops_plane(metadata))
  WITH CHECK (public.ob_corpus_on_ops_plane(metadata));

CREATE POLICY thoughts_personal_plane ON public.thoughts
  AS PERMISSIVE FOR ALL TO ob_plane_personal
  USING      (user_id IS NOT NULL AND user_id = public.ob_current_user_id())
  WITH CHECK (user_id IS NOT NULL AND user_id = public.ob_current_user_id());

-- ==========================================================================================
-- 7. FORCE ROW LEVEL SECURITY
-- ==========================================================================================
-- Without it the table OWNER bypasses every policy above. READ THE CAVEAT AT THE TOP OF THIS
-- FILE: these tables are owned by postgres, which is also a SUPERUSER, and a superuser is
-- exempt from FORCE as well as from RLS. FORCE is set here because it is correct, because it
-- costs nothing, and because it makes moving ownership off the superuser a one-line change
-- rather than a redesign - not because it binds anything today. What binds a caller today is
-- being a non-superuser role, which is what PostgREST's SET ROLE service_role makes every
-- PostgREST request.
ALTER TABLE public.agent_memories               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_source_refs     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_artifacts       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_relations       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_review_actions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_traces   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_items    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_audit_events    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.thoughts                     FORCE ROW LEVEL SECURITY;

-- ==========================================================================================
-- 8. Reduce the grants
-- ==========================================================================================
-- service_role holds INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on these
-- tables - not because anything asked for that, but because init-grants.sql's
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES hands every future table the full set.
-- TRUNCATE is not a read-path requirement and it is NOT RLS-FILTERABLE: one statement empties
-- a memory table regardless of every policy above it. REFERENCES and TRIGGER let a caller
-- attach machinery to a table it only needs to read from.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.agent_memories,
  public.agent_memory_source_refs,
  public.agent_memory_artifacts,
  public.agent_memory_relations,
  public.agent_memory_review_actions,
  public.agent_memory_recall_traces,
  public.agent_memory_recall_items,
  public.agent_memory_audit_events,
  public.thoughts
FROM service_role;

-- ==========================================================================================
-- 9. Views, because PostgREST's own advice is to expose views rather than base tables
-- ==========================================================================================
-- WITH (security_invoker = true) IS THE ENTIRE POINT AND IS EASY TO GET FATALLY WRONG. A
-- normal view runs with the permissions of ITS OWNER; these would be owned by postgres, so a
-- view WITHOUT this option would read the base table as the superuser and hand a personal row
-- straight back through PostgREST - a brand-new bypass created by following the advice.
-- PostgreSQL 15+ only; this stack is pg16 (pgvector/pgvector:pg16).
-- There is a RED proof of exactly this in scripts/checks/prove-agent-memory-rls.ps1.
--
-- NAMED `v_` AND NOT `_v`, because the offline harness counts the plane's tables with
-- `information_schema.tables WHERE table_name LIKE 'agent_memor%'` and a VIEW is a row in
-- that view. `agent_memories_v` turned `agent_memory_tables(8)` into 9 and failed the
-- fresh-volume check - measured, not guessed.
DROP VIEW IF EXISTS public.v_agent_memories;
DROP VIEW IF EXISTS public.v_thoughts;

CREATE VIEW public.v_agent_memories WITH (security_invoker = true) AS
  SELECT id, thought_id, workspace_id, project_id, user_id, visibility, memory_type,
         summary, content, lifecycle_status, provenance_status, confidence, created_by,
         review_status, metadata, created_at, updated_at
    FROM public.agent_memories;

CREATE VIEW public.v_thoughts WITH (security_invoker = true) AS
  SELECT id, content, metadata, user_id, created_at, updated_at
    FROM public.thoughts;

GRANT SELECT ON public.v_agent_memories TO service_role;
GRANT SELECT ON public.v_thoughts       TO service_role;

COMMENT ON VIEW public.v_agent_memories IS
  'RLS-invoker view of agent_memories - the intended PostgREST surface. security_invoker=true; without it this view would bypass the exposure boundary.';
COMMENT ON VIEW public.v_thoughts IS
  'RLS-invoker view of thoughts - the intended PostgREST surface. security_invoker=true; without it this view would bypass the exposure boundary.';

NOTIFY pgrst, 'reload schema';

COMMIT;
