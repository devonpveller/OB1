-- ============================================================
-- The owner's reader read of a private (inlet) source: its chunks and the claims drawn from it (research-workbench
-- redesign, rwr-source-reader-api). Slot 520.
--
-- Slot 440 moved the email-body and podcast-transcript sources, their chunks, and the claims drawn only from them
-- into owner-private tables that no app role can read; the one owner read it left is inlet_private_source() (the
-- text, nothing else). The source reader (GET /workbench/contract/sources/{id}/reader) shows a source's chunks in
-- order with the claims drawn from it, so for a moved source it needs the chunks and the claim rows too. This slot
-- adds exactly two read functions, the same shape and the same guard as inlet_private_source():
--   inlet_private_reader_chunks(p_id, p_sub)  the source's chunks, in order
--   inlet_private_reader_claims(p_id, p_sub)  the claims drawn from it: a private claim's edge to it
--                                             (inlet_private_claim_sources) and a shared claim's private link to it
--                                             (inlet_private_claim_links), with the claim's text, tag and status
-- A row comes back only when p_sub is the source's recorded owner (inlet_private_sources.inlet_owner_sub); a blank
-- subject, a service subject or anyone else gets no rows - the same as for a source that does not exist. SECURITY
-- DEFINER with a pinned search_path, EXECUTE for ob_app_memory only (a login role with its own credentials), never
-- PUBLIC, never PostgREST's roles. No table, column, row or grant changes.
-- Requires slot 440 (the private stores); without it (to_regclass) the functions are not created, and the route
-- answers every private source as not found.
--
-- Fresh-volume slot 520: after 470. Live order: after 440 and 470 (psql -f, a fresh backup first; the live apply is a
-- gated deploy, before the new workbench image - an image without the functions reads a private source as not found).
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
        RAISE NOTICE 'source reader: slot 440 is not applied - the private reader functions are not created';
        RETURN;
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
         WHERE s.id = p_id AND coalesce(btrim(p_sub), '') <> '' AND p_sub NOT LIKE 'service:%' AND s.inlet_owner_sub = p_sub
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
                JOIN public.inlet_private_claims pc ON pc.id = e.claim_id
               WHERE e.source_id = p_id AND e.owner_sub = p_sub
              UNION ALL
              SELECT c.id, c.text, c.epistemic_tag, c.status, l.row_data ->> 'edge_type'
                FROM public.inlet_private_claim_links l
                JOIN public.claims c ON c.id = l.claim_id
               WHERE l.source_id = p_id AND l.owner_sub = p_sub
          ) k
         WHERE k.edge_type IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.inlet_private_sources s
                        WHERE s.id = p_id AND coalesce(btrim(p_sub), '') <> '' AND p_sub NOT LIKE 'service:%' AND s.inlet_owner_sub = p_sub)
         ORDER BY k.claim_id, k.edge_type
    $b$ $f$;

    -- no EXECUTE for anyone but the owner role and ob_app_memory (PUBLIC and every default-granted role revoked)
    DECLARE f TEXT; r RECORD;
    BEGIN
        FOREACH f IN ARRAY ARRAY['public.inlet_private_reader_chunks(uuid,text)', 'public.inlet_private_reader_claims(uuid,text)'] LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
            FOR r IN SELECT DISTINCT ro.rolname AS grantee
                       FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                      WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner LOOP
                EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
            END LOOP;
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_app_memory', f);
            END IF;
        END LOOP;
    END;
END $$;

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'source reader: the owner reads of a private source''s chunks and claims are in place'; END $$;
COMMIT;
