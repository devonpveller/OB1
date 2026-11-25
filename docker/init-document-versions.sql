-- ============================================================
-- Named snapshots of a user document's versions (research-workbench redesign, rwr-doc-versions-api).
--
-- What this file adds, and only this:
--   document_snapshots  one row per named marker a person puts on a version of one of their documents, and per
--                       automatic "Before restoring vN" marker a restore leaves on the version it replaced.
--                       owner_sub is the identity seam's subject (whose snapshot it is) and actor_sub who acted
--                       (an admin while impersonating); neither is ever caller-supplied.
--
-- A version is a commit of the vault that changed the document's text, counted from the oldest (derived from
-- git on every read, never stored here). The marker names the commit and the blob the version had - never a
-- path - so a move, a trash or a restore of the document does not lose or shift it. The name is the person's own
-- text: per-user front-end context that no shared view, function or trail carries, and no log line repeats.
--
-- Depends on nothing but the P0 role service_role (the roles of slots 480 / 490 are members of it); touches no
-- other table. Idempotent (IF NOT EXISTS); re-running it changes nothing. Fresh-volume slot 620; the live DB gets
-- it by hand (psql -f, BEFORE the new workbench image, a fresh backup first). Revert: revert-document-versions.sql.
-- Check: check-document-versions.sql.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.document_snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL,
    actor_sub   TEXT NOT NULL,
    commit_hash TEXT NOT NULL CHECK (commit_hash ~ '^[0-9a-f]{40}$'),   -- the vault commit that is the version
    blob_hash   TEXT NOT NULL CHECK (blob_hash ~ '^[0-9a-f]{40}$'),     -- the document's text in that commit
    name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    kind        TEXT NOT NULL DEFAULT 'named' CHECK (kind IN ('named', 'before_restore')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_snapshots_owner ON public.document_snapshots (owner_sub, commit_hash);

-- -- RLS + grants: read and add only (nothing in OB1 edits or deletes a snapshot) --
ALTER TABLE public.document_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_snapshots_service_role_all ON public.document_snapshots;
CREATE POLICY document_snapshots_service_role_all ON public.document_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
-- The schema's default privileges (init-grants.sql) hand every new table ALL to service_role: take back every direct
-- grant first (PUBLIC, service_role, any other role), then grant exactly what the app needs. Same shape as slot 510.
REVOKE ALL ON public.document_snapshots FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.document_snapshots'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.document_snapshots FROM %I', r.grantee);
    END LOOP;
END $$;
GRANT SELECT, INSERT ON public.document_snapshots TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
