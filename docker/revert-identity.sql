-- Revert init-identity.sql (rw-identity).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-identity.sql
--
-- THIS DISCARDS the admin audit log, every session and the list of users who signed in. The audit
-- log is the record an admin's impersonations are judged by: export it first
--   psql -U postgres -d openbrain -c "\copy public.admin_audit TO 'admin_audit.csv' CSV HEADER"
-- The pre-rw-identity workbench image must be redeployed with this revert (the rw-identity image
-- refuses to start a sign-in without these tables). Nothing else references them.
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON public.admin_audit;
DROP TRIGGER IF EXISTS trg_admin_audit_no_truncate ON public.admin_audit;
DROP TABLE IF EXISTS public.admin_audit;
DROP FUNCTION IF EXISTS public.admin_audit_append_only();
DROP TABLE IF EXISTS public.workspace_sessions;
DROP TABLE IF EXISTS public.workspace_login_pending;
DROP TABLE IF EXISTS public.workspace_users;
COMMIT;
NOTIFY pgrst, 'reload schema';
