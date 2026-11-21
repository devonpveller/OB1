-- ============================================================
-- The owner's reader read of a private (inlet) source: its chunks and the claims drawn from it (research-workbench
-- redesign, rwr-source-reader-api). Slot 520.
--
-- Slot 440 moved the email-body and podcast-transcript sources, their chunks, and the claims drawn only from them
-- into owner-private tables that no app role can read; the owner read it left is inlet_private_source() (the text,
-- nothing else), and slot 480 (rw-owner-private-view) moved that read to the workbench's own login role ob_workbench.
-- The source reader (GET /workbench/contract/sources/{id}/reader) shows a source's chunks in order with the claims drawn
-- from it, so for a moved source it needs the chunks and the claim rows too. This slot adds exactly two read functions,
-- built the way 480 builds owner_private_*: SECURITY DEFINER, STABLE, search_path = public, pg_temp, the subject rule is
-- 480's owner_private_subject_ok() (a usable subject's shape; never service: / system: / anonymous:, never the literal
-- 'operator'), every row filtered on its own owner column, EXECUTE revoked from PUBLIC and from every other role and
-- granted to ob_workbench ALONE (ten services log in as ob_app_memory; an owner-argument function executable by it would
-- be executable, with any subject, by all of them):
--   inlet_private_reader_chunks(p_id, p_sub)  the source's chunks, in order
--   inlet_private_reader_claims(p_id, p_sub)  the claims drawn from it: a private claim's edge to it
--                                             (inlet_private_claim_sources) and a shared claim's private link to it
--                                             (inlet_private_claim_links), with the claim's text, tag and status
-- A row comes back only when p_sub is the source's recorded owner (inlet_private_sources.inlet_owner_sub); anyone else
-- gets no rows - the same as for a source that does not exist. No table, column, row or other grant changes.
-- Refused (nothing changed) unless slot 440 (the private stores) and slot 480 (ob_workbench, owner_private_subject_ok) are
-- applied.
--
-- Fresh-volume slot 520: after 480. LIVE ORDER: after 440, 470 and 480 (psql -f, a fresh backup first; the live apply is a
-- gated deploy, before the new workbench image, which must log in as ob_workbench - 480's image). If 480 is re-run later it
-- does not touch these two functions; the ownership/grant check check-source-reader.sql (read-only) reports a stray grant.
-- Revert: revert-source-reader.sql (drops the two functions; nothing else changed).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-source-reader.sql
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    IF to_regclass('public.inlet_private_sources') IS NULL OR to_regclass('public.inlet_private_source_chunks') IS NULL
       OR to_regclass('public.inlet_private_claims') IS NULL OR to_regclass('public.inlet_private_claim_sources') IS NULL
       OR to_regclass('public.inlet_private_claim_links') IS NULL THEN
        RAISE EXCEPTION 'source reader: slot 440 (init-inlet-owner.sql, round 5 or later) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF to_regprocedure('public.owner_private_subject_ok(text)') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'source reader: slot 480 (init-owner-private-view.sql: ob_workbench, owner_private_subject_ok) must be applied first' USING ERRCODE = '55000';
    END IF;

    EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.inlet_private_reader_chunks(p_id UUID, p_sub TEXT)
    RETURNS TABLE (idx INT, content TEXT)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $b$
        SELECT c.idx, c.content
          FROM public.inlet_private_source_chunks c
          JOIN public.inlet_private_sources s ON s.id = c.source_id
         WHERE s.id = p_id AND public.owner_private_subject_ok(p_sub) AND s.inlet_owner_sub = p_sub
         ORDER BY c.idx
    $b$ $f$;

    EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.inlet_private_reader_claims(p_id UUID, p_sub TEXT)
    RETURNS TABLE (claim_id UUID, text TEXT, epistemic_tag TEXT, status TEXT, edge_type TEXT)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $b$
        SELECT DISTINCT ON (k.claim_id, k.edge_type) k.claim_id, k.text, k.epistemic_tag, k.status, k.edge_type
          FROM (
              SELECT pc.id AS claim_id, pc.text, pc.epistemic_tag, pc.status, e.row_data ->> 'edge_type' AS edge_type
                FROM public.inlet_private_claim_sources e
                JOIN public.inlet_private_claims pc ON pc.id = e.claim_id AND pc.inlet_owner_sub = p_sub
               WHERE e.source_id = p_id AND e.owner_sub = p_sub
              UNION ALL
              SELECT c.id, c.text, c.epistemic_tag, c.status, l.row_data ->> 'edge_type'
                FROM public.inlet_private_claim_links l
                JOIN public.claims c ON c.id = l.claim_id
               WHERE l.source_id = p_id AND l.owner_sub = p_sub
          ) k
         WHERE k.edge_type IS NOT NULL
           AND public.owner_private_subject_ok(p_sub)
           AND EXISTS (SELECT 1 FROM public.inlet_private_sources s WHERE s.id = p_id AND s.inlet_owner_sub = p_sub)
         ORDER BY k.claim_id, k.edge_type
    $b$ $f$;

    -- who may run them: ob_workbench alone (480's pattern): PUBLIC and every other non-superuser, non-owner role revoked
    DECLARE f TEXT; r RECORD;
    BEGIN
        FOREACH f IN ARRAY ARRAY['public.inlet_private_reader_chunks(uuid,text)', 'public.inlet_private_reader_claims(uuid,text)'] LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
            FOR r IN SELECT DISTINCT ro.rolname AS grantee
                       FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                      WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner AND ro.rolname <> 'ob_workbench' LOOP
                EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
            END LOOP;
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_workbench', f);
        END LOOP;
    END;
END $$;

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'source reader: the owner reads of a private source''s chunks and claims are in place (ob_workbench alone executes them)'; END $$;
COMMIT;
