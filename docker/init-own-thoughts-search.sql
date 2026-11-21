-- ============================================================
-- The owner's own-thoughts search (research-workbench redesign, rwr-own-thoughts-search-api, round 2). Slot 530.
-- LIVE ORDER: AFTER slot 480 (rw-owner-private-view, round 2 or later) - this file uses 480's ob_workbench role and its subject
-- rule owner_private_subject_ok(text), and is refused (nothing changed) without them. Deploy rw-owner-private-view FIRST.
--
-- Why a function: thoughts a user saved with metadata.exposure = 'personal' are invisible to the workbench's own table
-- grant (the row-level policy thoughts_ops_plane shows service_role members only the unlabelled / ops plane; the personal
-- plane is thoughts_personal_plane, TO ob_plane_personal, user_id = ob_current_user_id()). The workbench must find its
-- signed-in person's own saved thoughts in BOTH planes, and only theirs, so the read is one owner-scoped function, exactly
-- the shape of 480's owner_private_* reads:
--
--   owner_private_thoughts_search(p_sub, p_q, p_limit) -> (thought_id, title, snippet_src, created_at)
--     * SECURITY DEFINER, STABLE, search_path public, pg_temp; runs as the migration owner (RLS is not what bounds it:
--       the WHERE clause is, on the thought's OWN owner column).
--     * the subject is the argument the workbench's identity seam resolved, and only that: it answers NOTHING unless the
--       subject passes 480's owner_private_subject_ok (a subject's shape; never service: / system: / anonymous:, never the
--       literal 'operator'). Rows are filtered `user_id = p_sub` - an unowned (user_id NULL, shared) thought is nobody's own.
--     * text only: the first line (title, 120 characters), a 600-character window around the first match (the workbench
--       puts the highlight markers on it), the save time. No embedding, no metadata, no link, no count, no total.
--     * the query must be at least 2 characters; the limit is clamped to 1..50 inside.
--     * EXECUTE: ob_workbench ALONE (480's rule: ten services log in as ob_app_memory, and a function that takes the subject
--       as an argument is executable, with any subject, by every one of them - so not ob_app_memory, not service_role, not
--       PUBLIC). Any other grant is reported by check-own-thoughts-search.sql.
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-own-thoughts-search.sql
-- It writes and moves NO row (nothing to archive). Idempotent. One transaction, lock_timeout 10s. Fresh volume: slot 530
-- (after 480 by name). Revert: revert-own-thoughts-search.sql (byte-identical to the state before: the function, its comment
-- and its grants are the only things added). Re-run this file after any re-run of 480 only if check-own-thoughts-search.sql
-- says so (480's revert drops owner_private_subject_ok and with it this function's dependency).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF to_regprocedure('public.owner_private_subject_ok(text)') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'own thoughts search: slot 480 (init-owner-private-view.sql, rw-owner-private-view) must be applied first: it creates ob_workbench and owner_private_subject_ok' USING ERRCODE = '55000';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.owner_private_thoughts_search(p_sub TEXT, p_q TEXT, p_limit INT DEFAULT 25)
RETURNS TABLE (thought_id BIGINT, title TEXT, snippet_src TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH q AS (SELECT btrim(coalesce(p_q, '')) AS t
                WHERE public.owner_private_subject_ok(p_sub) AND length(btrim(coalesce(p_q, ''))) >= 2)
    SELECT th.id,
           left(btrim(split_part(btrim(th.content, E' \t\r\n'), E'\n', 1), E' \t\r'), 120),
           substr(th.content, greatest(1, strpos(lower(th.content), lower(q.t)) - 250), 600),
           th.created_at
      FROM public.thoughts th CROSS JOIN q
     WHERE th.user_id = p_sub
       AND strpos(lower(th.content), lower(q.t)) > 0
     ORDER BY th.created_at DESC, th.id DESC
     LIMIT least(greatest(coalesce(p_limit, 25), 1), 50)
$$;

DO $$
DECLARE f CONSTANT TEXT := 'public.owner_private_thoughts_search(text,text,integer)'; r RECORD;
BEGIN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner AND ro.rolname <> 'ob_workbench' LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.owner_private_thoughts_search(TEXT, TEXT, INT) TO ob_workbench;
END $$;
COMMENT ON FUNCTION public.owner_private_thoughts_search(TEXT, TEXT, INT) IS
  'rwr-own-thoughts-search-api (slot 530): the subject''s own thoughts (both planes) matching a text; nothing for any other subject or an unusable one. ob_workbench only.';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'own thoughts search: owner_private_thoughts_search is in place (ob_workbench alone executes it)'; END $$;
COMMIT;
