-- ============================================================
-- open_notebook's least-privilege role `ob_notebook` (security-hardening-2026-10, item
-- intake-notebook-role: DESIGN-intake section 12 item 1, the first part of card M6 / D30).
--
-- Before this, open_notebook (the IKS fork's open_notebook/database/ob1_repository.py) connected
-- as the `postgres` SUPERUSER. Intake's deploy precondition is that it does not. This file creates
-- `ob_notebook` with EXACTLY the privileges that code needs - each one below is cited to the fork
-- function that needs it; notebook-role/inventory.json is the machine-readable list, and
-- notebook-role/test_static.py asserts this file's grants equal it. Nothing else changes: no
-- table, column, function or other role is touched.
--
-- Scope of "exactly": tables, columns, sequences (none: every key it writes is a uuid default),
-- the schema, and the OB1-defined functions in schema public (EXECUTE is PUBLIC's by default;
-- the explicit grants below are the inventory and keep working if PUBLIC's EXECUTE is ever
-- revoked). Extension functions (pgvector's operators) stay PUBLIC's. Writes the code makes
-- through a SECURITY DEFINER trigger (queue_source_extraction -> source_extraction_queue) and
-- foreign-key checks (content_types, threads, sources) run as the table owner and need no grant.
--
-- IDEMPOTENT: every run re-asserts the role's attributes, revokes everything it holds, and
-- grants the list again. Fresh volume: mounted as 310-init-notebook-role.sql. Live DB: by hand,
-- the operator's gated deploy:
--     psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -f init-notebook-role.sql
-- The role is created WITHOUT a password (it cannot log in). The password is a FILE,
-- OB1/docker/notebook-secrets/ob_notebook_db_password (gitignored; never OB1/docker/.env, which
-- open_notebook loads whole). Set it from that file with notebook-role/scram_verifier.py, which
-- pipes `ALTER ROLE ob_notebook PASSWORD '<SCRAM verifier>'` into psql's stdin: the plaintext
-- never reaches the server, a command line or a log (log_min_error_statement would print a
-- failed statement - with the verifier, never the password).
--
-- Requires (all live): init-sources (sources), init-threads (threads, thread_sources and their
-- RLS), init-source-chunks, init-research-contract (source_tombstones and the url gate trigger),
-- init-research-credibility (the sources_credibility_stamp_ok CHECK). Revert:
-- revert-notebook-role.sql.
-- ============================================================

-- 1. THE ROLE (attributes re-asserted on every run)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_notebook') THEN
        CREATE ROLE ob_notebook LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
    ELSE
        ALTER ROLE ob_notebook LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
    END IF;
END $$;

-- 2. START FROM NOTHING: no membership in any role, no privilege on anything in public.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = 'ob_notebook'::regrole LOOP
        EXECUTE format('REVOKE %I FROM ob_notebook', r.rolname);
    END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ob_notebook;     -- column privileges go with it
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ob_notebook;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ob_notebook;
REVOKE ALL ON SCHEMA public FROM ob_notebook;

-- 3. THE INVENTORY (fork: open_notebook/database/ob1_repository.py; function names below)
GRANT USAGE ON SCHEMA public TO ob_notebook;

-- reads: test_connection, list_sources, get_source, get_thread_sources, get_thread_notes,
-- get_suggestions, get_hidden_suggestions, explain_suggestion, search_*_chunks,
-- unlink_source_all_threads; find_or_create_source() looks a source up by url / content_hash
GRANT SELECT ON public.sources TO ob_notebook;
-- create_thread (RETURNING), get_thread, get_suggestions, get_*_suggestions
GRANT SELECT ON public.threads TO ob_notebook;
-- get_thread_sources, count_thread_sources, get_thread_notes, the suggestion reads, explain_suggestion,
-- search_thread_chunks; link_source_to_thread() / set_thread_source_status() (RETURNING *, ON CONFLICT)
GRANT SELECT ON public.thread_sources TO ob_notebook;
-- search_source_chunks, source_chunk_spread, search_all_chunks, search_thread_chunks
GRANT SELECT ON public.source_chunks TO ob_notebook;
-- the BEFORE INSERT trigger trg_sources_tombstone_gate (SECURITY INVOKER) reads it through
-- contract_tombstone_for() when find_or_create_source() inserts a source with a url
GRANT SELECT ON public.source_tombstones TO ob_notebook;

-- find_or_create_source() (from capture_source_into_thread, sync_extracted_source): the new row
GRANT INSERT (url, title, content, content_type, notebook, domain, content_hash, embedding, metadata)
    ON public.sources TO ob_notebook;
-- sync_extracted_source's UPDATE; content_hash also find_or_create_source()'s back-fill
GRANT UPDATE (content, content_hash, title, embedding, content_type, domain, metadata)
    ON public.sources TO ob_notebook;
-- create_thread (Notebook.ensure_ob_thread)
GRANT INSERT (name, description) ON public.threads TO ob_notebook;
-- link_source_to_thread() (from link_source_to_thread, capture_source_into_thread, sync_extracted_source)
GRANT INSERT (thread_id, source_id, link_type, status, suggestion_reason, confirmed_at)
    ON public.thread_sources TO ob_notebook;
-- link_source_to_thread()'s ON CONFLICT DO UPDATE; set_thread_source_status() (status, confirmed_at);
-- unlink_source_all_threads (status)
GRANT UPDATE (status, link_type, suggestion_reason, confirmed_at) ON public.thread_sources TO ob_notebook;

GRANT EXECUTE ON FUNCTION
    -- the three write helpers the code calls
    public.find_or_create_source(text, text, text, text, text, text, text, public.vector, jsonb),
    public.link_source_to_thread(uuid, uuid, text, text, text),
    public.set_thread_source_status(uuid, uuid, text),
    -- trg_sources_tombstone_gate (SECURITY INVOKER) on a source insert with a url
    public.contract_tombstone_for(text),
    public.contract_url_key(text),
    public.contract_url_norm(text),
    -- the CHECK sources_credibility_stamp_ok on every sources INSERT/UPDATE
    public.credibility_stamp_ok(jsonb),
    public.credibility_is_unit(jsonb)
  TO ob_notebook;

-- 4. ROW LEVEL SECURITY. threads, thread_sources and source_tombstones have RLS with policies for
-- service_role (and authenticated) only, so a role outside them sees no row and can write none.
-- One policy per command the code uses, for ob_notebook only; every other role and policy is
-- unchanged. Row scoping stays where it is today (open_notebook is single-tenant; it saw every row
-- as postgres). source_tombstones matters most: without its SELECT policy the url gate trigger
-- would find no tombstone and SILENTLY readmit an erased url (D5) instead of refusing it.
-- (session_sources: RLS too, but no reachable code path writes it - see inventory.json.)
DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN SELECT * FROM (VALUES
            ('threads',        'ob_notebook_select', 'SELECT', 'USING (true)'),
            ('threads',        'ob_notebook_insert', 'INSERT', 'WITH CHECK (true)'),
            ('thread_sources', 'ob_notebook_select', 'SELECT', 'USING (true)'),
            ('thread_sources', 'ob_notebook_insert', 'INSERT', 'WITH CHECK (true)'),
            ('thread_sources', 'ob_notebook_update', 'UPDATE', 'USING (true) WITH CHECK (true)'),
            ('source_tombstones', 'ob_notebook_select', 'SELECT', 'USING (true)')
        ) AS v(tbl, pol, cmd, expr) LOOP
        -- a re-run leaves an identical policy alone (CREATE/DROP POLICY lock the table) and
        -- replaces one that was changed by hand
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM pg_policies x
             WHERE x.schemaname = 'public' AND x.tablename = p.tbl AND x.policyname = p.pol
               AND x.permissive = 'PERMISSIVE' AND x.cmd = p.cmd AND x.roles = ARRAY['ob_notebook']::name[]
               AND x.qual IS NOT DISTINCT FROM (CASE WHEN p.cmd = 'INSERT' THEN NULL ELSE 'true' END)
               AND x.with_check IS NOT DISTINCT FROM (CASE WHEN p.cmd = 'SELECT' THEN NULL ELSE 'true' END));
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.pol, p.tbl);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR %s TO ob_notebook %s',
                       p.pol, p.tbl, p.cmd, p.expr);
    END LOOP;
END $$;
