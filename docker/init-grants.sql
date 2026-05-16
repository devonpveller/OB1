-- Schema-wide grants so PostgREST can authenticate as `service_role`
-- and reach every table/function (thoughts, sources, graph layer).
--
-- The wiki-compiler scripts speak PostgREST; the openbrain-postgrest
-- container connects with anon-role = service_role (local, obnet-only,
-- single-user — same app-layer-trust posture as the MCP server running
-- as superuser). RLS is still enabled on the graph tables but
-- service_role has FOR ALL policies (from 40-init-graph.sql), so reads
-- and writes pass. Idempotent; safe to re-run.

GRANT USAGE ON SCHEMA public TO service_role, authenticated, anon;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Future objects created by the superuser are reachable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
