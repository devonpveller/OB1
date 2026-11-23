-- count-private-report-claim-reuse.sql - rw-private-report-claims round 2, the OPERATOR DECISION P2 (tester F6).
-- READ-ONLY (it creates one pg_temp helper, gone with the session). Counts only: never a claim's text, id or title.
--   psql -X -A -t -q -f count-private-report-claim-reuse.sql
-- Works before slot 570 (the claims are still in public.claims) and after it (in the owner's store).
-- The question: how many SHARED outputs carry the text of a claim drawn from a PRIVATE report (a "generated series" in
-- the operator's words)? Operator decision P2 (2026-11-22, fix item rw-private-report-claims-fix): slot 570 moves every
-- one of these private to the claim's owner, or withholds it when it restated claims of several owners (or of nobody),
-- so after 570 lines 2-5 read 0 (run it BEFORE 570 for the live figures - the deploy window's first step):
--   mixed claims        - a private-report claim a shared synthesis ALSO filed (claims.synthesis_id set; 570 moves it
--                         like every other private-report claim);
--   shared syntheses    - a shared research_synthesis source whose content carries a private-report claim's sentence
--                         (the claim was recalled and restated, or the same sentence came out of a shared run);
--   shared job reports  - a shared research job (no private report owns its tree) whose result synthesis / prose / the
--                         line credibility carries one (the job reused it);
--   gap-branch reports  - of those, the ones that are a gap branch asking to verify such a claim (its own research
--                         about the private sentence);
--   threads             - (round 2) a thread whose name or description carries one (minted / refreshed from a report);
--   other shared claims - (round 2) a shared claim, not a private report's own, carrying one (a synthesis filed it).
-- A sentence counts after 570's normalisation (case, whitespace, citation markers, emphasis); sentences under 24
-- characters are not matched.
CREATE OR REPLACE FUNCTION pg_temp.prc_norm(p_text TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
    t TEXT := coalesce(p_text, '');
    m TEXT[];
    v INT;
    n INT := 0;
BEGIN
    -- 1. HTML entities: numeric (&#233; &#xE9;) decoded; a named letter entity (&eacute; &Ouml;) to its letter;
    --    &szlig; to ss; every other named one (&nbsp; &amp; ...) to a space
    LOOP
        m := regexp_match(t, '&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});');
        EXIT WHEN m IS NULL OR n > 500;
        n := n + 1;
        v := CASE WHEN lower(left(m[1], 1)) = 'x' THEN ('x' || lpad(substr(m[1], 2), 8, '0'))::bit(32)::int ELSE m[1]::int END;
        t := replace(t, '&#' || m[1] || ';', CASE WHEN v BETWEEN 1 AND 1114111 AND v NOT BETWEEN 55296 AND 57343 THEN chr(v) ELSE ' ' END);
    END LOOP;
    t := regexp_replace(t, '&([A-Za-z])(acute|grave|circ|uml|tilde|cedil|ring|slash|caron);', '\1', 'g');
    t := regexp_replace(t, '&szlig;', 'ss', 'g');
    t := regexp_replace(t, '&[A-Za-z][A-Za-z0-9]{1,31};', ' ', 'g');
    -- 2. links: the text a reader sees - [[target|label]] -> label, [[target]] -> target, [label](url) -> label
    t := regexp_replace(t, '\[\[(?:[^]|]*\|)?([^]]*)\]\]', '\1', 'g');
    t := regexp_replace(t, '\[([^]\[]*)\]\([^)]*\)', '\1', 'g');
    -- 3. markers and tags: footnotes ([^1] [^note-a], mid-word too), numeric / named citations ([3] [Source 2] [1, 2]),
    --    <sup>..</sup> and <ref>..</ref> with their content, every other tag (its content kept)
    t := regexp_replace(t, '\[\^[^]]*\]', '', 'g');
    t := regexp_replace(t, '\[\s*((source|src|ref|cite|citation|note)\s*)?[0-9]+([\s,;-]+[0-9]+)*\s*\]', '', 'gi');
    t := regexp_replace(t, '<sup([\s/][^>]*)?>.*?</sup\s*>', '', 'gi');
    t := regexp_replace(t, '<ref([\s/][^>]*)?>.*?</ref\s*>', '', 'gi');
    t := regexp_replace(t, '<[^>]*>', '', 'g');
    -- 4. the skeleton: NFKC (full-width / compatibility forms folded), lower case, accents removed (NFKD, the marks
    --    dropped), LETTERS ONLY - every digit, space, punctuation and hyphen gone (attempt 3: a citation number such as
    --    ^1^ or (1) mid-sentence, or a full-width digit, split the substring while digits were kept). A shared page that
    --    happens to carry a private claim's letters with other numbers is withheld too: conservative, accepted.
    t := lower(normalize(t, NFKC));
    t := replace(replace(replace(replace(t, 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'ø', 'o');
    t := translate(t, 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿāăąćĉčďđēĕėęěĝğġģĥĩīĭįıĵķĺļľłńņňōŏőŕŗřśŝşšţťũūŭůűųŵŷźżž',
                      'aaaaaaceeeeiiiinooooouuuuyyaaacccddeeeeegggghiiiiijkllllnnnooorrrssssttuuuuuuwyzzz');
    RETURN regexp_replace(normalize(t, NFKD), '[^[:alpha:]]+', '', 'g');
END;
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
-- fix item round 2: threads whose name / description carries one, and other shared claims (not a private report's
-- own) carrying one (a synthesis filed its sentence into another thread)
threads AS (
    SELECT DISTINCT th.id FROM public.threads th, texts t
     WHERE position(t.n IN pg_temp.prc_norm(coalesce(th.name, '') || ' ' || coalesce(th.description, ''))) > 0),
dup_claims AS (
    SELECT DISTINCT c.id FROM public.claims c, texts t
     WHERE c.id NOT IN (SELECT id FROM linked) AND position(t.n IN pg_temp.prc_norm(c.text)) > 0),
claims_reused AS (
    SELECT DISTINCT t.n FROM texts t
     WHERE EXISTS (SELECT 1 FROM syn s JOIN public.sources x ON x.id = s.id WHERE position(t.n IN pg_temp.prc_norm(coalesce(x.title, '') || ' ' || coalesce(x.content, ''))) > 0)
        OR EXISTS (SELECT 1 FROM jobs j JOIN shared_jobs b ON b.id = j.id WHERE position(t.n IN b.body) > 0))
SELECT line FROM (
    SELECT 1 AS o, 'reuse: private-report claims (any store)=' || (SELECT count(*) FROM linked) AS line
    UNION ALL SELECT 2, 'reuse: mixed claims (a shared synthesis also filed them, still in the shared table)=' || (SELECT count(*) FROM mixed)
    UNION ALL SELECT 3, 'reuse: shared syntheses carrying a private-report claim''s sentence=' || (SELECT count(*) FROM syn)
    UNION ALL SELECT 4, 'reuse: shared job reports carrying one=' || (SELECT count(*) FROM jobs)
    UNION ALL SELECT 5, 'reuse: of those, gap branches verifying a claim=' || (SELECT count(*) FROM jobs WHERE gap_ref LIKE 'claim:%')
    UNION ALL SELECT 6, 'reuse: distinct private-report sentences restated in a shared output=' || (SELECT count(*) FROM claims_reused)
    UNION ALL SELECT 7, 'reuse: threads whose name or description carries one=' || (SELECT count(*) FROM threads)
    UNION ALL SELECT 8, 'reuse: other shared claims carrying one (filed into another thread)=' || (SELECT count(*) FROM dup_claims)
) x ORDER BY o;
