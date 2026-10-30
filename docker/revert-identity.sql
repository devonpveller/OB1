-- Revert init-identity.sql (rw-identity).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-identity.sql
--
-- THIS DISCARDS the admin audit log, every live impersonation and the list of users seen signed in. The audit
-- log is the record an admin's impersonations are judged by: export it first
--   psql -U postgres -d openbrain -c "\copy public.admin_audit TO 'admin_audit.csv' CSV HEADER"
-- The pre-rw-identity workbench image must be redeployed with this revert (the rw-identity image
-- needs these tables once forward-auth is configured). Nothing else references them.
\set ON_ERROR_STOP on
BEGIN;
-- round 4 (tester F5): the research_prompts rows rw-identity wrote that the pre-rw-identity code would
-- misread - the back-fill's (actor system:backfill) and the service owners (service:<caller>; the old
-- code treats any other owner as a foreign user). The rows of real users (Open WebUI on-behalf-of, the
-- workspace) stay: they are those users' prompts.
DO $$ BEGIN
    IF to_regclass('public.research_prompts') IS NOT NULL THEN
        DELETE FROM public.research_prompts WHERE actor_sub = 'system:backfill' OR owner_sub LIKE 'service:%';
    END IF;
END $$;
DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON public.admin_audit;
DROP TRIGGER IF EXISTS trg_admin_audit_no_truncate ON public.admin_audit;
DROP TABLE IF EXISTS public.admin_audit;
DROP FUNCTION IF EXISTS public.admin_audit_append_only();
DROP TABLE IF EXISTS public.workspace_impersonation;
DROP TABLE IF EXISTS public.workspace_users;
COMMIT;
NOTIFY pgrst, 'reload schema';
