-- check-private-report-claims-scope.sql - slot 575 (init-private-report-claims-scope.sql, research-workbench
-- rw-570-hub-note-scope): is slot 575 in place, and is any notebook-tree page or fragment claim still on a shared surface?
-- Read-only on the data (it creates three pg_temp helpers, gone with the session); counts only, never a text or an id.
--   psql -X -A -t -q -f check-private-report-claims-scope.sql
-- Lines "scope: <what>=<value>", then "scope: OK" or "scope: FAIL". OK = slot 570 and 575 applied, 575's two guard
-- functions in place (a 570 re-run puts 570's back: re-run 575), no class-'note' page outside notes/ carrying a
-- private-report claim's text, no fragment claim (pg_temp.prc_frag) left shared. The page and fragment rules are
-- check-private-report-claims.sql's (and count-private-report-claim-reuse.sql's), verbatim; that script stays the
-- verdict for every other surface.
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
-- the texts slot 570 withheld (no single owner): in its archive only, which may not exist yet
CREATE OR REPLACE FUNCTION pg_temp.prc_withheld() RETURNS TABLE (text TEXT)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN RETURN; END IF;
    RETURN QUERY EXECUTE $q$SELECT a.row_data ->> 'text' FROM public.private_report_claims_archive a
                             WHERE a.action = 'x' AND a.restored_at IS NULL$q$;
END;
$$;
-- slot 575 (R2): the FRAGMENT rule, as init-private-report-claims-scope.sql moves them - a SHARED claim a synthesis slot
-- 570 moved had filed (570's archive: the synthesis's 's' row, the claim's 'd' row for the synthesis_id it set NULL), not
-- a private report's own, whose skeleton (24+ letters) is inside the skeleton of a private-report claim that synthesis
-- restated (its text carried it, or it filed it: 570's k / x row); and a shared claim carrying such a fragment's
-- sentence. Nothing before 570 (no archive). The same text in check-private-report-claims.sql,
-- count-private-report-claim-reuse.sql and check-private-report-claims-scope.sql.
CREATE OR REPLACE FUNCTION pg_temp.prc_frag() RETURNS TABLE (id UUID)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    q TEXT := $q$
    WITH p AS (
        SELECT x.id, x.n FROM (
            SELECT c.id, pg_temp.prc_norm(c.text) AS n FROM public.inlet_private_claims c
             WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
            UNION ALL
            SELECT c.id, pg_temp.prc_norm(c.text) FROM public.claims c
             WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
            UNION ALL
            SELECT a.ref::uuid, pg_temp.prc_norm(a.row_data ->> 'text') FROM public.private_report_claims_archive a
             WHERE a.action = 'x' AND a.restored_at IS NULL) x
         WHERE length(x.n) >= 24),
    s AS (
        SELECT DISTINCT ON (a.ref) a.ref AS sid,
               pg_temp.prc_norm(coalesce(a.row_data ->> 'title', '') || ' ' || coalesce(a.row_data ->> 'content', '')) AS n
          FROM public.private_report_claims_archive a
         WHERE a.action = 's' AND a.tbl = 'public.sources' AND a.restored_at IS NULL
         ORDER BY a.ref, a.id DESC),
    sp AS (
        SELECT s.sid, p.n FROM s JOIN p ON position(p.n IN s.n) > 0
        UNION
        SELECT a.row_data ->> 'synthesis_id', p.n FROM public.private_report_claims_archive a JOIN p ON p.id::text = a.ref
         WHERE a.action IN ('k', 'x') AND a.restored_at IS NULL AND a.row_data ->> 'synthesis_id' IN (SELECT sid FROM s)),
    f AS (
        SELECT DISTINCT cn.id, cn.n FROM (
            SELECT c.id, a.ref AS sid, pg_temp.prc_norm(c.text) AS n
              FROM public.private_report_claims_archive a JOIN public.claims c ON c.id::text = a.row_data ->> 'id'
             WHERE a.action = 'd' AND a.tbl = 'public.claims' AND a.row_data ->> '_col' = 'synthesis_id' AND a.restored_at IS NULL
               AND a.ref IN (SELECT sid FROM s)
               AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)) cn
          JOIN sp ON sp.sid = cn.sid
         WHERE length(cn.n) >= 24 AND position(cn.n IN sp.n) > 0)
    $q$;
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN RETURN; END IF;
    RETURN QUERY EXECUTE q || ' SELECT f.id FROM f';
    IF NOT FOUND THEN RETURN; END IF;
    -- a shared claim carrying a fragment's sentence (only when there is a fragment: this reads every shared claim)
    RETURN QUERY EXECUTE q || $d$
    SELECT c.id FROM public.claims c
     WHERE c.id NOT IN (SELECT f.id FROM f)
       AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
       AND EXISTS (SELECT 1 FROM f WHERE position(f.n IN pg_temp.prc_norm(c.text)) > 0)$d$;
END;
$$;
WITH
s570 AS (SELECT to_regclass('public.private_report_claims_archive') IS NOT NULL AS applied),
scope AS (
    SELECT to_regprocedure('public.private_report_claims_person_note(text,text)') IS NOT NULL AS applied,
           coalesce((SELECT p.prosrc LIKE '%private_report_claims_person_note(%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.trg_private_report_claims_wiki_guard()')), false) AS wiki_in_place,
           coalesce((SELECT p.prosrc LIKE '%coalesce(NEW.branch_kind, '''')%' AND p.prosrc LIKE '%coalesce(NEW.steer_kind, '''')%' AND p.prosrc LIKE '%coalesce(NEW.type, '''')%'
                       FROM pg_proc p WHERE p.oid = to_regprocedure('public.trg_private_report_claims_gap_guard()')), false) AS gap_in_place,
           (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_private_report_claims_wiki_guard', 'trg_private_report_claims_gap_guard') AND NOT tgisinternal AND tgenabled <> 'D') AS triggers),
texts AS (
    SELECT DISTINCT x.n FROM (
        SELECT pg_temp.prc_norm(c.text) AS n FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT pg_temp.prc_norm(c.text) FROM public.claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT pg_temp.prc_norm(w.text) FROM pg_temp.prc_withheld() w) x
     WHERE length(x.n) >= 24),
note_pages AS (
    SELECT DISTINCT w.slug FROM public.wiki_pages w, texts t
     WHERE coalesce(w.page_class, '') = 'note' AND left(coalesce(w.slug, ''), 6) <> 'notes/'
       AND position(t.n IN pg_temp.prc_norm(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, ''))) > 0),
frag AS (SELECT DISTINCT f.id FROM pg_temp.prc_frag() f),
counts AS (
    SELECT (SELECT applied FROM s570) AS s570, (SELECT applied FROM scope) AS s575,
           (SELECT wiki_in_place FROM scope) AS wiki_in_place, (SELECT gap_in_place FROM scope) AS gap_in_place,
           (SELECT triggers FROM scope) AS triggers,
           (SELECT count(*) FROM note_pages) AS note_pages, (SELECT count(*) FROM frag) AS frag,
           (SELECT count(*) FROM public.wiki_pages w WHERE coalesce(w.page_class, '') = 'note' AND left(coalesce(w.slug, ''), 6) = 'notes/') AS person_notes)
SELECT line FROM (
    SELECT 1 AS o, 'scope: slot 570 applied=' || s570 AS line FROM counts
    UNION ALL SELECT 2, 'scope: slot 575 applied=' || s575 FROM counts
    UNION ALL SELECT 3, 'scope: the wiki guard judges only notes/... as a person''s note=' || wiki_in_place FROM counts
    UNION ALL SELECT 4, 'scope: the gap guard treats a NULL kind as a non-matching kind=' || gap_in_place FROM counts
    UNION ALL SELECT 5, 'scope: the wiki and gap guard triggers on=' || triggers || ' (4 once applied)' FROM counts
    UNION ALL SELECT 6, 'scope: notebook hub / index / AI-note pages (class note, not under notes/) carrying a private-report claim''s text=' || note_pages FROM counts
    UNION ALL SELECT 7, 'scope: shared claims holding a fragment of one (filed by a moved synthesis) or its sentence=' || frag FROM counts
    UNION ALL SELECT 8, 'scope: person notes (notes/..., judged by their author only)=' || person_notes FROM counts
    UNION ALL SELECT 9, CASE WHEN s570 AND s575 AND wiki_in_place AND gap_in_place AND triggers = 4 AND note_pages = 0 AND frag = 0
                             THEN 'scope: OK' ELSE 'scope: FAIL' END FROM counts
) x ORDER BY o;
