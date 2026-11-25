-- ============================================================
-- The document's "to place" queue (research-workbench redesign, rwr-doc-toplace-api; plan 02-BUILD-PLAN.md phase 1).
--
-- What this file adds, and only this:
--   document_pending_refs   one row per cite a person gathered for a document and has not placed yet: the document's
--                           vault path, ONE of a source id or a claim id, an optional section label and quote, a short
--                           label of where it was gathered (added_from), and when. owner_sub is the identity seam's
--                           subject_sub (whose queue it is) and actor_sub who acted (an admin impersonating); neither is
--                           ever caller-supplied. Placing a row calls the existing place-reference path and deletes the
--                           row in the same transaction (POST /workbench/contract/documents/pending-refs/{id}/place).
--
-- A queue row is per-user front-end context (07-MULTI-USER): it exists only here, no shared view, function, trail or
-- search carries it, and nothing here reads or writes sources / claims / reference_records.
--
-- The queue follows its document by the database, not by a code path: path is a FOREIGN KEY to the document's listing
-- record (user_document_listings.path) with ON UPDATE CASCADE ON DELETE CASCADE. A move, a trash, a restore, an archive
-- and an unarchive all rename the listing's path, so the queue is carried with it in the same statement; delete forever,
-- empty trash, the nightly 30-day removal and the reconcile pass all delete the listing row, so the queue goes with it
-- and no orphan row can remain (the listing is the one thing every removal path already deletes).
--
-- Roles: it depends on the roles of slots 480 (ob_workbench, the workbench's own login role) and 490 / 500 (service_role,
-- the role the app's tables are granted to) and on nothing else of the chain but the listing table. The workbench logs in
-- as ob_workbench, a member of ob_app_memory, a member of service_role (slot 480): it holds these rights through service_role.
-- Rights: exactly SELECT, INSERT and DELETE (a queue row is never edited: remove it and add another); every other direct
-- grant, PUBLIC's and the schema default privileges' included, is taken back first. RLS on, one service_role policy.
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-document-toplace.sql
-- Refused (nothing changed) unless the listing table, service_role and ob_workbench exist. Idempotent: a second run has
-- nothing to do. One transaction, lock_timeout 10s. Fresh-volume slot 630; the live DB gets it by hand (psql -f, BEFORE the
-- new workbench image, a fresh DB backup first). Revert: revert-document-toplace.sql. Check: check-document-toplace.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;

DO $$
BEGIN
    IF to_regclass('public.user_document_listings') IS NULL THEN
        RAISE EXCEPTION 'document to-place queue: the document listing table (slot 270) must exist first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        RAISE EXCEPTION 'document to-place queue: the service_role role must exist first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'document to-place queue: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.document_pending_refs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL,                  -- whose queue it is: the identity seam's subject_sub
    actor_sub   TEXT NOT NULL,                  -- who acted (an admin while impersonating)
    path        TEXT NOT NULL REFERENCES public.user_document_listings (path) ON UPDATE CASCADE ON DELETE CASCADE,
    source_id   UUID,                           -- the cited source (a source or a held source) ...
    claim_id    UUID,                           -- ... or the cited claim: exactly one of the two
    section     TEXT NOT NULL DEFAULT '',       -- an optional label of the section it cites
    quote       TEXT NOT NULL DEFAULT '',       -- an optional quote (the span the reference will pin)
    added_from  TEXT NOT NULL,                  -- where it was gathered: a short label (source, search, chat, ...)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_pending_refs_one_target CHECK ((source_id IS NOT NULL) <> (claim_id IS NOT NULL)),
    CONSTRAINT document_pending_refs_added_from CHECK (added_from ~ '^[a-z][a-z0-9_.:-]{0,63}$')
);
-- a cite waits once per document: the same source (or claim) and quote added again is the same row
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_pending_refs_cite
    ON public.document_pending_refs (owner_sub, path, (COALESCE(source_id::text, 'claim:' || claim_id::text)), quote);
CREATE INDEX IF NOT EXISTS idx_document_pending_refs_doc ON public.document_pending_refs (owner_sub, path, created_at, id);
CREATE INDEX IF NOT EXISTS idx_document_pending_refs_path ON public.document_pending_refs (path);

-- -- RLS + grants (the P0 shape, then exactly what the app needs) ---------------------------------------------
ALTER TABLE public.document_pending_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_pending_refs_service_role_all ON public.document_pending_refs;
CREATE POLICY document_pending_refs_service_role_all ON public.document_pending_refs FOR ALL TO service_role USING (true) WITH CHECK (true);
-- The schema's default privileges (init-grants.sql) hand every new table ALL to service_role: take every direct grant
-- back first (PUBLIC, service_role, any other role), then grant read, add and remove. Re-running converges to the same ACL.
REVOKE ALL ON public.document_pending_refs FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.document_pending_refs'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.document_pending_refs FROM %I', r.grantee);
    END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON public.document_pending_refs TO service_role;

COMMENT ON TABLE public.document_pending_refs IS
  'rwr-doc-toplace-api (slot 630): a person''s own "to place" queue per document (cites gathered, not yet placed). Per user; follows its document by FK (path ON UPDATE/DELETE CASCADE).';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'document to-place queue: document_pending_refs is in place (SELECT, INSERT, DELETE to service_role; the queue follows its document by FK)'; END $$;
COMMIT;
NOTIFY pgrst, 'reload schema';
