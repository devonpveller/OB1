-- count-private-report-claim-reuse.sql - rw-private-report-claims round 2, the OPERATOR DECISION P2 (tester F6).
-- READ-ONLY (it creates one pg_temp helper, gone with the session). Counts only: never a claim's text, id or title.
--   psql -X -A -t -q -f count-private-report-claim-reuse.sql
-- Works before slot 570 (the claims are still in public.claims) and after it (in the owner's store).
-- The question: how many SHARED outputs carry the text of a claim drawn from a PRIVATE report (a "generated series" in
-- the operator's words)? Slot 570 leaves all of these as they are (the developer default "mixed stays shared"):
--   mixed claims        - a private-report claim a shared synthesis ALSO filed (claims.synthesis_id set; 570 keeps it
--                         shared, in public.claims, readable by everyone);
--   shared syntheses    - a shared research_synthesis source whose content carries a private-report claim's sentence
--                         (the claim was recalled and restated, or the same sentence came out of a shared run);
--   shared job reports  - a shared research job (no private report owns its tree) whose result synthesis / prose / the
--                         line credibility carries one (the job reused it: 570 strips the reuse LIST, not the report);
--   gap-branch reports  - of those, the ones that are a gap branch asking to verify such a claim (its own research
--                         about the private sentence).
-- A sentence counts after 570's normalisation (case, whitespace, citation markers, emphasis); sentences under 24
-- characters are not matched.
CREATE OR REPLACE FUNCTION pg_temp.prc_norm(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT rtrim(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             lower(coalesce(p_text, '')),
             '\[([^]\[]*)\]\([^)]*\)', '\1', 'g'),
             '\[\s*(\^|(source|src|ref|cite|citation|note)\s*)?[0-9]+([\s,;-]+[0-9]+)*\s*\]', ' ', 'g'),
             '</?[a-z][a-z0-9]*[^>]*>', ' ', 'g'),
             '[*_~`]+', '', 'g'),
             '\s+', ' ', 'g'),
             ' ([.,;:!?)])', '\1', 'g')), ' .,;:!?')
$$;
WITH
linked AS (SELECT DISTINCT pc.claim_id AS id FROM public.research_private_report_claims pc),
mixed AS (SELECT c.id FROM public.claims c JOIN linked l ON l.id = c.id WHERE c.synthesis_id IS NOT NULL),
texts AS (
    SELECT DISTINCT pg_temp.prc_norm(x.text) AS n FROM (
        SELECT c.text FROM public.claims c JOIN linked l ON l.id = c.id
        UNION ALL
        SELECT c.text FROM public.inlet_private_claims c JOIN linked l ON l.id = c.id) x
     WHERE length(pg_temp.prc_norm(x.text)) >= 24),
syn AS (
    SELECT DISTINCT s.id FROM public.sources s, texts t
     WHERE s.content_type = 'research_synthesis'
       AND position(t.n IN pg_temp.prc_norm(coalesce(s.title, '') || ' ' || coalesce(s.content, ''))) > 0),
shared_jobs AS (
    SELECT j.id, j.gap_ref,
           pg_temp.prc_norm(coalesce(j.result ->> 'synthesis', '') || ' ' || coalesce(j.result ->> 'prose', '') || ' '
                            || coalesce(j.result -> 'line_credibility', '[]'::jsonb)::text) AS body
      FROM public.research_jobs j
     WHERE jsonb_typeof(j.result) = 'object'
       AND NOT EXISTS (SELECT 1 FROM public.research_job_report_owner(coalesce(j.root_job_id, j.id)))),
jobs AS (SELECT DISTINCT j.id, j.gap_ref FROM shared_jobs j, texts t WHERE position(t.n IN j.body) > 0),
claims_reused AS (
    SELECT DISTINCT t.n FROM texts t
     WHERE EXISTS (SELECT 1 FROM syn s JOIN public.sources x ON x.id = s.id WHERE position(t.n IN pg_temp.prc_norm(coalesce(x.title, '') || ' ' || coalesce(x.content, ''))) > 0)
        OR EXISTS (SELECT 1 FROM jobs j JOIN shared_jobs b ON b.id = j.id WHERE position(t.n IN b.body) > 0))
SELECT line FROM (
    SELECT 1 AS o, 'reuse: private-report claims (any store)=' || (SELECT count(*) FROM linked) AS line
    UNION ALL SELECT 2, 'reuse: mixed claims (a shared synthesis also filed them; shared)=' || (SELECT count(*) FROM mixed)
    UNION ALL SELECT 3, 'reuse: shared syntheses carrying a private-report claim''s sentence=' || (SELECT count(*) FROM syn)
    UNION ALL SELECT 4, 'reuse: shared job reports carrying one=' || (SELECT count(*) FROM jobs)
    UNION ALL SELECT 5, 'reuse: of those, gap branches verifying a claim=' || (SELECT count(*) FROM jobs WHERE gap_ref LIKE 'claim:%')
    UNION ALL SELECT 6, 'reuse: distinct private-report sentences restated in a shared output=' || (SELECT count(*) FROM claims_reused)
) x ORDER BY o;
