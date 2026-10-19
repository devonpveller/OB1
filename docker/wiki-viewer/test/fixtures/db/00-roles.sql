-- rw-p1a-render test fixtures: the role PostgREST runs as (anon = service_role,
-- the same trust posture as the live openbrain-postgrest). Disposable DB only.
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
