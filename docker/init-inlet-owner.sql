-- ============================================================
-- Existing personal data becomes its owner's, and private (research-workbench rw-inlet-owner, plan 08 PD1). Slot 440
-- (after rw-privacy-hardening's 430, whose link helper and withheld-row marker it uses).
-- Operator 2026-11-04, "all private": every existing thought is the operator's and private - Gmail, Google activity,
-- the ChatGPT import and the operator's own captures. The email-body sources (url mail.google.com) and the podcast
-- transcripts (metadata.source daily-digest-podcast) and the claims drawn ONLY from them are private too (decision D,
-- D6). Claims and topics otherwise stay shared.
--
-- The owner is the operator's subject (WORKSPACE_DEFAULT_SUB today, mapped to the Authentik sub by the identity seam):
--   psql -v ON_ERROR_STOP=1 -v owner_sub="<subject>" -U postgres -d openbrain -f init-inlet-owner.sql
-- It is recorded (public.inlet_owner) on the first run that has something to do; a later run without -v uses it, and a
-- run naming a DIFFERENT subject is refused. A run with something to do and no subject is refused (nothing changed).
--
-- What one run does, as one batch in public.inlet_owner_archive (archive first, always; readable by no app role):
--   1. thoughts: every thought with no owner (except a dossier the wiki compile wrote after the first run: compiled from
--      shared material only) gets user_id = the owner. Only user_id changes; the archive keeps (id, user_id). Readers
--      that serve someone else read shared rows only: the wiki compiler (recipes/entity-wiki/generate-wiki.mjs),
--      match_thoughts (below: owner_scope / ob.user_id), openbrain-mcp's thought tools (the lane's subject).
--   2. the email-body and podcast-transcript sources move out of `sources` into public.inlet_private_sources (their
--      chunks into public.inlet_private_source_chunks), so no shared reader (contract search, the claims ledger, the
--      source routes, chunk context, the room's KNN, the research knowledge base, the wiki) can reach them: by
--      construction, not by a filter each reader must remember. Every row a foreign key ties to them is archived first
--      and goes as the keys declare (cascade / set NULL, the latter done here with triggers off).
--   3. claims: a claim grounded ONLY on moved sources (and on claims that are themselves private) moves to
--      public.inlet_private_claims; a claim also grounded on a shared source stays shared and loses only the private
--      link (kept, for its owner, in public.inlet_private_claim_links). Every touched shared claim is archived whole.
--   4. research_jobs: the email-body / podcast seeds leave options.seed_sources; the moved sources leave
--      result.cited_sources, the private claims leave result.reuse_claims, and every Gmail URL in the result text
--      becomes the word private-email. The whole (options, result) is archived first.
--   5. shared sources' metadata loses gmail_id, gmail_thread_id, gmail_labels; a Gmail URL in a shared source's metadata
--      or content, a chunk or a claim's text becomes private-email. Every such row is archived whole first.
--   6. the wiki: every page presenting a private (or no longer shared) thought or a moved source - its leaf, a page
--      linking one in any form - and every entity page whose evidence holds a private thought or a moved source, is
--      archived and withheld; those entities are bumped, so the next compile rebuilds the ones with shared evidence from
--      shared material only. A guard (trg_inlet_owner_wiki_guard) refuses the leaf, the link, and the withheld text
--      coming back (the viewer's reconcile from a vault file, a compile, an app role); a NOTE is refused out loud. The
--      generic withheld-row writer (recipes/_shared/wiki-pages.mjs, rw-idea-privacy round 4) leaves the file out.
-- Re-runnable: a second run picks up what arrived since (an unowned thought, a new email body, a new seed, a page) as a
-- new batch, and has nothing to do otherwise. Revert: revert-inlet-owner.sql, byte-identical from the archive.
-- One transaction with lock_timeout 10s: a refusal or a lock not granted leaves everything as it was. Stop (do not
-- pause) the writers that hold transactions first: the research curator, the wiki compile, the gmail pull / prune.
-- Fresh-volume slot 440 (an empty database: nothing to do, no owner needed). Revert order: 440, 430, 390, 380.
-- Round 2 (tester attempt 1): every research job is stripped whoever owns it (a service-owned digest job is read in full by
-- everyone): events (payload, trail), the seeded trees' query / anchor / topic / prompt, result arrays naming a moved
-- source or a private claim; the new functions execute for ob_app_memory only (or nobody); the prune reads the owner
-- through a view owned by its own role; the guard matches links case-insensitively with %2F decoded (430's helper),
-- refuses withheld text that comes back nearly whole at any slug (8-word chunks), marks every withheld row for 430's
-- writer and refuses a note with 430's one message.
-- Round 3 (tester attempt 2): in a SEEDED tree (a job seeded with an email body or a podcast transcript, and its
-- branches) every text the job carries was derived from the private seed - the synthesis, the summaries, the error,
-- progress messages, event notes - so it is the owner's: archived, copied to an owner-only store
-- (inlet_private_jobs / inlet_private_job_events, read through inlet_private_job(id, sub)), and replaced in the shared
-- row by neutral system text. Round 4 (tester attempt 3, 4a): the rows are REBUILT, neutral by default - only known
-- key paths, each value strictly checked (an enumerated code, a number, a shared row's id or exact url); no key text
-- survives.
-- ============================================================
\if :{?owner_sub}
\else
\set owner_sub ''
\endif
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '10s';
SELECT set_config('inlet_owner.sub', :'owner_sub', true) AS owner_given \gset
DO $$
BEGIN
    IF to_regprocedure('public.idea_privacy_linked_thought_ids(text,text,text,jsonb)') IS NULL
       OR to_regprocedure('public.wiki_guard_mark_withheld()') IS NULL THEN
        RAISE EXCEPTION 'inlet owner: slot 430 (init-privacy-hardening.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;
-- round 3 (the live run, ~14 minutes): every table the run writes is locked HERE, at once, under the 10 s lock_timeout.
-- SHARE ROW EXCLUSIVE blocks writes and lets reads through. Once held, a writer the stack's watchdog starts again during
-- the run queues behind it (and its own statement times out or waits) - it cannot take a lock the run needs later and
-- bounce the run half-way; the bounce can only happen here, in the first 10 s, with nothing changed.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['thoughts', 'sources', 'source_chunks', 'claims', 'claim_sources', 'research_jobs', 'research_job_events',
                             'research_prompts', 'wiki_pages', 'entities', 'thread_sources', 'session_sources', 'source_entities',
                             'source_extraction_queue', 'research_private_report_claims', 'import_jobs', 'ideas', 'source_revisions',
                             'source_disputes'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE', t);
        END IF;
    END LOOP;
END $$;

-- ── the stores ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- the owner, recorded once (and the match_thoughts this file replaced, for the revert)
CREATE TABLE IF NOT EXISTS public.inlet_owner (
    singleton             BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    owner_sub             TEXT NOT NULL CHECK (btrim(owner_sub) <> '' AND owner_sub NOT LIKE 'service:%'),
    first_run_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the match_thoughts definition this file replaced (kept on the first run, whatever it finds), for the revert
CREATE TABLE IF NOT EXISTS public.inlet_owner_prior (
    name TEXT PRIMARY KEY,
    def  TEXT NOT NULL
);
-- the archive (the revert's only input): one row per archived row
CREATE TABLE IF NOT EXISTS public.inlet_owner_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,           -- schema-qualified table the row is from
    col         TEXT NOT NULL,           -- the column that tied it to the move ('*' a whole-row image)
    action      TEXT NOT NULL,           -- o thought owner | s source | k claim | c cascaded | n/d set-null/default column
                                         -- m whole-row image of a changed shared row | j job options+result | u entity bump | w wiki page
    ref         TEXT,                    -- the moved source / claim id (c, n, d), the slug (w)
    ref_hash    TEXT,                    -- w: md5(body) of the withheld page (the guard refuses it coming back)
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inlet_owner_archive_batch ON public.inlet_owner_archive (batch, restored_at);
CREATE INDEX IF NOT EXISTS idx_inlet_owner_archive_page ON public.inlet_owner_archive (ref) WHERE action = 'w' AND restored_at IS NULL;
-- round 2: the withheld pages' text as 8-word chunks (md5 of the normalised words), for the guard's "the withheld text
-- came back" rule at ANY slug; page_ref = the archive row of the page
CREATE TABLE IF NOT EXISTS public.inlet_owner_withheld_pages (
    page_ref   BIGINT PRIMARY KEY,
    n_chunks   INT NOT NULL,
    whole_hash TEXT NOT NULL            -- md5 of the whole normalised body (a page under 8 words is matched whole)
);
CREATE TABLE IF NOT EXISTS public.inlet_owner_withheld_chunks (
    h        TEXT NOT NULL,
    page_ref BIGINT NOT NULL,
    PRIMARY KEY (h, page_ref)
);
CREATE INDEX IF NOT EXISTS idx_inlet_owner_withheld_whole ON public.inlet_owner_withheld_pages (whole_hash);
-- round 3: a seeded tree's own text, as it was, for its owner (the shared rows carry neutral text)
CREATE TABLE IF NOT EXISTS public.inlet_private_jobs (
    job_id    UUID NOT NULL,
    batch     UUID NOT NULL,
    owner_sub TEXT NOT NULL,
    row_data  JSONB NOT NULL,             -- the job's text columns before this file: query, anchor, topic_estimate, options, result, tree_report, progress, error, gap_ref
    PRIMARY KEY (job_id, batch)
);
CREATE TABLE IF NOT EXISTS public.inlet_private_job_events (
    event_id  BIGINT NOT NULL,
    batch     UUID NOT NULL,
    owner_sub TEXT NOT NULL,
    job_id    UUID NOT NULL,
    row_data  JSONB NOT NULL,             -- the event row before this file
    PRIMARY KEY (event_id, batch)
);
-- the owner-private stores: the shared tables' own columns (LIKE) + the owner and the batch
CREATE TABLE IF NOT EXISTS public.inlet_private_sources (LIKE public.sources);
CREATE TABLE IF NOT EXISTS public.inlet_private_source_chunks (LIKE public.source_chunks);
CREATE TABLE IF NOT EXISTS public.inlet_private_claims (LIKE public.claims);
CREATE TABLE IF NOT EXISTS public.inlet_private_claim_links (
    claim_id  UUID NOT NULL,
    source_id UUID NOT NULL,
    owner_sub TEXT NOT NULL,
    batch     UUID NOT NULL,
    row_data  JSONB NOT NULL,           -- the claim_sources row as it was
    PRIMARY KEY (claim_id, source_id, batch)
);
DO $$
DECLARE
    t TEXT; c RECORD; r RECORD;
BEGIN
    FOREACH t IN ARRAY ARRAY['inlet_private_sources', 'inlet_private_source_chunks', 'inlet_private_claims'] LOOP
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS inlet_owner_sub TEXT NOT NULL DEFAULT ''''', t);
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS inlet_batch UUID', t);
        -- a column the shared table gained since is carried too
        FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
                   FROM pg_attribute a
                  WHERE a.attrelid = ('public.' || replace(t, 'inlet_private_', ''))::regclass
                    AND a.attnum > 0 AND NOT a.attisdropped
                    AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = ('public.' || t)::regclass AND b.attname = a.attname AND NOT b.attisdropped) LOOP
            EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', t, c.attname, c.typ);
        END LOOP;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inlet_private_sources'::regclass AND contype = 'p') THEN
        ALTER TABLE public.inlet_private_sources ADD PRIMARY KEY (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inlet_private_source_chunks'::regclass AND contype = 'p') THEN
        ALTER TABLE public.inlet_private_source_chunks ADD PRIMARY KEY (source_id, idx);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inlet_private_claims'::regclass AND contype = 'p') THEN
        ALTER TABLE public.inlet_private_claims ADD PRIMARY KEY (id);
    END IF;
    -- nobody but the table owner (the migration's role): RLS on and forced, no policy, every grant taken back (the
    -- schema's default privileges hand new tables to the app roles). The owner reads a private source through
    -- inlet_private_source(id, sub) below, never the table.
    FOREACH t IN ARRAY ARRAY['inlet_owner', 'inlet_owner_prior', 'inlet_owner_archive', 'inlet_private_sources', 'inlet_private_source_chunks',
                             'inlet_private_claims', 'inlet_private_claim_links', 'inlet_owner_withheld_pages', 'inlet_owner_withheld_chunks',
                             'inlet_private_jobs', 'inlet_private_job_events'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE cl.oid = ('public.' || t)::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner LOOP
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r.grantee);
        END LOOP;
    END LOOP;
    REVOKE ALL ON SEQUENCE public.inlet_owner_archive_id_seq FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.inlet_owner_archive_id_seq'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner LOOP
        EXECUTE format('REVOKE ALL ON SEQUENCE public.inlet_owner_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;
COMMENT ON TABLE public.inlet_owner_archive IS
  'rw-inlet-owner (slot 440): every row init-inlet-owner.sql changed or moved, as it was. Readable by no app role; revert-inlet-owner.sql restores from it.';
COMMENT ON TABLE public.inlet_private_sources IS
  'rw-inlet-owner (slot 440): the email-body and podcast-transcript sources, private to inlet_owner_sub. Read through inlet_private_source(id, sub), which only ob_app_memory may execute.';

-- ── the owner, for the services that act for them ───────────────────────────────────────────────────────────────────
-- Round 2 (tester 2): no function reachable without credentials names the owner or opens the private store. PostgREST's
-- anon role is service_role, so nothing here is executable by service_role, anon, authenticated or PUBLIC.
-- The gmail prune (PostgREST, no credentials of its own) deletes by owner through a VIEW owned by its own role, which
-- alone reads the owner record: it shows the owner's gmail thoughts (no owner column) and nothing it could not already
-- read and delete in thoughts itself.
DROP FUNCTION IF EXISTS public.inlet_owner_default();   -- round 1's anonymous-callable owner read
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_inlet_owner_view') THEN
        CREATE ROLE ob_inlet_owner_view NOLOGIN NOBYPASSRLS;
    END IF;
END $$;
GRANT service_role TO ob_inlet_owner_view;       -- the ops plane's policy on thoughts, and its table grants
GRANT SELECT ON public.inlet_owner TO ob_inlet_owner_view;
DROP POLICY IF EXISTS inlet_owner_view_read ON public.inlet_owner;
CREATE POLICY inlet_owner_view_read ON public.inlet_owner AS PERMISSIVE FOR SELECT TO ob_inlet_owner_view USING (true);
CREATE OR REPLACE VIEW public.inlet_owner_mail WITH (security_barrier = true) AS
    SELECT t.id, t.content, t.metadata, t.created_at
      FROM public.thoughts t
     WHERE t.user_id = (SELECT o.owner_sub FROM public.inlet_owner o WHERE o.singleton)
       AND t.metadata ->> 'source' = 'gmail';
ALTER VIEW public.inlet_owner_mail OWNER TO ob_inlet_owner_view;
REVOKE ALL ON public.inlet_owner_mail FROM PUBLIC;
GRANT SELECT, DELETE ON public.inlet_owner_mail TO service_role;
COMMENT ON VIEW public.inlet_owner_mail IS
  'rw-inlet-owner (slot 440): the owner''s gmail thoughts, for prune-short-term.ts (deletes by owner). Owned by ob_inlet_owner_view, the only reader of inlet_owner.';

-- the owner's read of a moved source (the workbench's GET /workbench/sources/:id falls back to it): a row only when the
-- subject is the source's owner. EXECUTE for ob_app_memory only - a login role with its own credentials (the workbench
-- names the subject from its verified identity); never PostgREST's anon role
CREATE OR REPLACE FUNCTION public.inlet_private_source(p_id UUID, p_sub TEXT)
RETURNS TABLE (id UUID, url TEXT, title TEXT, content TEXT, content_type TEXT, notebook TEXT, metadata JSONB,
               created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.id, s.url, s.title, s.content, s.content_type, s.notebook, s.metadata, s.created_at, s.updated_at
      FROM public.inlet_private_sources s
     WHERE s.id = p_id AND coalesce(btrim(p_sub), '') <> '' AND p_sub NOT LIKE 'service:%' AND s.inlet_owner_sub = p_sub
$$;

-- round 3: the owner's read of a seeded job's own text (the workbench's session read overlays it for the owner); the
-- newest copy. EXECUTE for ob_app_memory only, as inlet_private_source
CREATE OR REPLACE FUNCTION public.inlet_private_job(p_job UUID, p_sub TEXT)
RETURNS TABLE (query TEXT, result JSONB, progress JSONB, error TEXT)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.row_data ->> 'query',
           CASE WHEN jsonb_typeof(p.row_data -> 'result') = 'null' THEN NULL ELSE p.row_data -> 'result' END,
           CASE WHEN jsonb_typeof(p.row_data -> 'progress') = 'null' THEN NULL ELSE p.row_data -> 'progress' END,
           p.row_data ->> 'error'
      FROM public.inlet_private_jobs p
      JOIN public.inlet_owner_archive a ON a.batch = p.batch AND a.action = 'j' AND (a.row_data ->> 'id')::uuid = p.job_id AND a.restored_at IS NULL
     WHERE p.job_id = p_job AND coalesce(btrim(p_sub), '') <> '' AND p_sub NOT LIKE 'service:%' AND p.owner_sub = p_sub
     ORDER BY a.id ASC
     LIMIT 1
$$;

-- ── what a page that presents private data is (the move and the guard) ─────────────────────────────────────────────
-- normalised text: lower case, every run of characters that is not a letter or a digit one space (case, markup, links)
CREATE OR REPLACE FUNCTION public.inlet_owner_norm(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g')) $$;

-- every source/<uuid> link form, case-insensitive, %2F decoded (the same decoding as 430's thought-link helper)
CREATE OR REPLACE FUNCTION public.inlet_owner_linked_source_ids(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(array_agg(DISTINCT lower(m[1])), ARRAY[]::text[])
      FROM regexp_matches(
               regexp_replace(
                   coalesce(p_slug, '') || ' ' || coalesce(p_title, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                   '%2[fF]', '/', 'g'),
               'source/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'gi') AS m;
$$;

-- "the withheld text came back": the page's normalised body holds at least half (and at least min(2, all)) of the kept
-- 8-word windows of ONE withheld page, at any slug (a page of up to 64 words keeps every window, a longer one every 8th);
-- a withheld page of fewer than 8 words is matched whole. Limit: a rewrite that keeps less than half of a withheld page's
-- 8-word runs verbatim (after normalisation: case, markup and punctuation do not count) is not caught.
CREATE OR REPLACE FUNCTION public.inlet_owner_text_withheld(p_body TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    w TEXT[]; n INT; i INT; hs TEXT[] := ARRAY[]::text[]; norm TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.inlet_owner_withheld_pages) THEN RETURN false; END IF;
    norm := public.inlet_owner_norm(p_body);
    IF norm = '' THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public.inlet_owner_withheld_pages p WHERE p.n_chunks = 0 AND p.whole_hash = md5(norm)) THEN
        RETURN true;
    END IF;
    w := string_to_array(norm, ' ');
    n := coalesce(array_length(w, 1), 0);
    IF n < 8 THEN RETURN false; END IF;
    FOR i IN 1 .. n - 7 LOOP
        hs := hs || md5(w[i] || ' ' || w[i+1] || ' ' || w[i+2] || ' ' || w[i+3] || ' ' || w[i+4] || ' ' || w[i+5] || ' ' || w[i+6] || ' ' || w[i+7]);
    END LOOP;
    RETURN EXISTS (
        SELECT 1 FROM (SELECT c.page_ref, count(DISTINCT c.h) AS hit
                         FROM public.inlet_owner_withheld_chunks c WHERE c.h = ANY(hs) GROUP BY c.page_ref) x
          JOIN public.inlet_owner_withheld_pages p ON p.page_ref = x.page_ref
         WHERE p.n_chunks > 0 AND x.hit * 2 >= p.n_chunks AND x.hit >= least(2, p.n_chunks));
END;
$$;

-- A page links a PRIVATE thought (one with an owner; 430's helper reads every link form, any case, %2F decoded), or a
-- moved source (the same forms), or its body is a withheld page's text come back (above). The move withholds more (a
-- thought that is no longer in the shared corpus, an entity page by its evidence: below).
-- (the links alone: what the move scans every page with - the text rule costs a lookup per 8-word window and is for
-- the guard, which sees one write at a time)
CREATE OR REPLACE FUNCTION public.inlet_owner_page_links_private(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
               SELECT 1 FROM unnest(public.idea_privacy_linked_thought_ids(p_slug, p_title, p_body, p_links)) AS x
                 JOIN public.thoughts t ON t.id = CASE WHEN length(x) <= 18 THEN x::bigint END
                WHERE t.user_id IS NOT NULL)
        OR EXISTS (
               SELECT 1 FROM unnest(public.inlet_owner_linked_source_ids(p_slug, p_title, p_body, p_links)) AS x
                 JOIN public.inlet_private_sources s ON s.id = x::uuid);
$$;
CREATE OR REPLACE FUNCTION public.inlet_owner_page_private(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.inlet_owner_page_links_private(p_slug, p_title, p_body, p_links)
        OR public.inlet_owner_text_withheld(p_body);
$$;
-- the guard: a compiled or reconciled page is skipped silently (RETURN NULL: one row must not fail the batch) and
-- MARKED (430's wiki_guard_mark_withheld: the X-Wiki-Withheld header, so the writer counts it withheld, not hidden); a
-- NOTE is a person's own writing, refused with 430's one message (it names no guard and no reason)
CREATE OR REPLACE FUNCTION public.trg_inlet_owner_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.inlet_owner_page_private(NEW.slug, NEW.title, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
-- CREATE OR REPLACE: a re-run never DROPs the trigger (DROP TRIGGER takes ACCESS EXCLUSIVE, which would block the wiki's
-- readers for the whole run)
CREATE OR REPLACE TRIGGER trg_inlet_owner_wiki_guard BEFORE INSERT OR UPDATE OF slug, title, body, links ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_inlet_owner_wiki_guard();

-- every function this file creates: no EXECUTE for anyone but its owner (PUBLIC, and every role the schema's default
-- privileges handed it to - service_role included), then the one grant: the owner read, for ob_app_memory
DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY['public.inlet_private_source(uuid,text)', 'public.inlet_private_job(uuid,text)', 'public.inlet_owner_norm(text)',
                             'public.inlet_owner_linked_source_ids(text,text,text,jsonb)', 'public.inlet_owner_text_withheld(text)',
                             'public.inlet_owner_page_links_private(text,text,text,jsonb)',
                             'public.inlet_owner_page_private(text,text,text,jsonb)', 'public.trg_inlet_owner_wiki_guard()'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
        END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        GRANT EXECUTE ON FUNCTION public.inlet_private_source(UUID, TEXT) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.inlet_private_job(UUID, TEXT) TO ob_app_memory;
    END IF;
END $$;

-- ── match_thoughts: shared rows plus the caller's own ──────────────────────────────────────────────────────────────
-- Same signature and result as slot 010's. The caller names whose it is: filter->>'owner_scope' = 'shared' (the wiki
-- compile: shared rows only) or a subject (shared rows plus that subject's); else ob.user_id (ob_current_user_id())
-- when the session set it; else, as before, every row the caller's RLS shows (the services acting for the operator).
-- The first run keeps the definition it replaces, for the revert.
INSERT INTO public.inlet_owner_prior (name, def)
SELECT 'match_thoughts', pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.match_thoughts(vector,double precision,integer,jsonb)')
   AND position('owner_scope' IN pg_get_functiondef(p.oid)) = 0
ON CONFLICT (name) DO NOTHING;
CREATE OR REPLACE FUNCTION public.match_thoughts(
    query_embedding vector(1024),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id BIGINT,
    content TEXT,
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_scope TEXT := NULLIF(btrim(coalesce(filter ->> 'owner_scope', '')), '');
BEGIN
    IF v_scope IS NULL THEN v_scope := public.ob_current_user_id(); END IF;
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
        t.created_at
    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
      AND (v_scope IS NULL OR t.user_id IS NULL OR (v_scope <> 'shared' AND t.user_id = v_scope))
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ── the move ───────────────────────────────────────────────────────────────────────────────────────────────────────
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    v_batch   UUID := gen_random_uuid();
    v_now     TIMESTAMPTZ := clock_timestamp();
    -- -v owner_sub=..., else the session setting init-identity.sql's back-fill uses (PGOPTIONS='-c workspace.default_sub=...')
    v_given   TEXT := coalesce(NULLIF(btrim(current_setting('inlet_owner.sub', true)), ''),
                               NULLIF(btrim(current_setting('workspace.default_sub', true)), ''));
    v_owner   TEXT;
    v_first   TIMESTAMPTZ;
    v_src     UUID[];
    v_cl      UUID[];
    v_n       BIGINT;
    v_dep     BIGINT := 0;
    n_thoughts BIGINT := 0; n_src_mail INT := 0; n_src_pod INT := 0; n_chunks BIGINT := 0; n_claims INT := 0;
    n_mixed   INT := 0; n_jobs INT := 0; n_seeds BIGINT := 0; n_meta INT := 0; n_pages INT := 0; n_ents INT := 0;
    n_rebuild INT := 0; n_left BIGINT; n_prompts INT := 0; n_events INT := 0; n_chunk_pages INT := 0;
    r RECORD; d RECORD;
    c_mail CONSTANT TEXT := '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*';
BEGIN
    SELECT owner_sub, first_run_at INTO v_owner, v_first FROM public.inlet_owner WHERE singleton;
    IF v_owner IS NOT NULL AND v_given IS NOT NULL AND v_given <> v_owner THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - this database''s personal data already belongs to another subject (recorded by the first run); a run may not name a different one'
            USING ERRCODE = '55000';
    END IF;
    v_owner := coalesce(v_owner, v_given);
    v_first := coalesce(v_first, v_now);

    -- the scopes
    CREATE TEMP TABLE _io_thoughts ON COMMIT DROP AS
    SELECT t.id FROM public.thoughts t
     WHERE t.user_id IS NULL
       AND NOT (lower(coalesce(t.metadata ->> 'type', '')) = 'dossier' AND t.created_at > v_first);
    CREATE TEMP TABLE _io_src ON COMMIT DROP AS
    SELECT s.id, (s.url ILIKE '%mail.google.com%') AS mail, s.url FROM public.sources s
     WHERE s.url ILIKE '%mail.google.com%'
        OR s.metadata ->> 'source' = 'daily-digest-podcast'
        OR s.content_type = 'podcast_transcript';
    ALTER TABLE _io_src ADD PRIMARY KEY (id);
    SELECT array_agg(id) INTO v_src FROM _io_src;
    -- the private claims: grounded on at least one edge, and every edge a moved source or a private claim (a least
    -- fixed point: a cycle of claims with no moved source stays shared)
    CREATE TEMP TABLE _io_claims (id UUID PRIMARY KEY) ON COMMIT DROP;
    LOOP
        INSERT INTO _io_claims
        SELECT DISTINCT cs.claim_id FROM public.claim_sources cs
         WHERE (cs.source_id IN (SELECT id FROM _io_src) OR cs.parent_claim_id IN (SELECT id FROM _io_claims))
           AND cs.claim_id NOT IN (SELECT id FROM _io_claims)
           -- (EXISTS, never IN: an edge's other terminal is NULL, and NOT (false OR NULL) would let a mixed claim through)
           AND NOT EXISTS (SELECT 1 FROM public.claim_sources x
                            WHERE x.claim_id = cs.claim_id
                              AND NOT EXISTS (SELECT 1 FROM _io_src s WHERE s.id = x.source_id)
                              AND NOT EXISTS (SELECT 1 FROM _io_claims p WHERE p.id = x.parent_claim_id));
        GET DIAGNOSTICS v_n = ROW_COUNT;
        EXIT WHEN v_n = 0;
    END LOOP;
    SELECT array_agg(id) INTO v_cl FROM _io_claims;
    -- the shared claims that lose a link (an edge to a moved source or to a private claim): archived whole
    CREATE TEMP TABLE _io_kept ON COMMIT DROP AS
    SELECT DISTINCT cs.claim_id AS id FROM public.claim_sources cs
     WHERE (cs.source_id IN (SELECT id FROM _io_src) OR cs.parent_claim_id IN (SELECT id FROM _io_claims))
       AND cs.claim_id NOT IN (SELECT id FROM _io_claims);
    -- the research jobs (round 2, tester 1: a SERVICE-owned job - the digest's - is read in full by every user, so every
    -- job is stripped, whoever owns it). What names private data: a moved source's id or url, a private claim's id, a
    -- Gmail URL (_io_ids: matched as a token; dropping the array element that carries one), and a moved source's title
    -- (_io_vals: replaced where a string equals it).
    CREATE TEMP TABLE _io_ids (v TEXT PRIMARY KEY) ON COMMIT DROP;
    INSERT INTO _io_ids SELECT DISTINCT x FROM (SELECT id::text AS x FROM _io_src UNION SELECT url FROM _io_src WHERE coalesce(url, '') <> ''
                                                UNION SELECT id::text FROM _io_claims) y ON CONFLICT DO NOTHING;
    CREATE TEMP TABLE _io_vals (v TEXT PRIMARY KEY) ON COMMIT DROP;
    INSERT INTO _io_vals SELECT v FROM _io_ids;
    INSERT INTO _io_vals SELECT DISTINCT s.title FROM public.sources s JOIN _io_src x ON x.id = s.id WHERE length(coalesce(s.title, '')) >= 6
    ON CONFLICT DO NOTHING;
    -- does a text name private data (a token of _io_ids, or a Gmail URL)?
    CREATE FUNCTION pg_temp.io_hits(t TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$
        SELECT coalesce(t, '') ~* 'mail\.google\.com'
            OR EXISTS (SELECT 1 FROM regexp_matches(coalesce(t, ''), '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'g') m
                         JOIN pg_temp._io_ids i ON i.v = lower(m[1]))
            OR EXISTS (SELECT 1 FROM regexp_matches(coalesce(t, ''), 'https?://[^][:space:]"<>\\]+', 'g') m JOIN pg_temp._io_ids i ON i.v = m[1])
    $f$;
    -- does a json value carry one anywhere (any nested string)?
    CREATE FUNCTION pg_temp.io_refs(e JSONB) RETURNS BOOLEAN LANGUAGE sql STABLE AS $f$
        SELECT EXISTS (SELECT 1 FROM jsonb_path_query(e, 'strict $.**') x
                        WHERE jsonb_typeof(x) = 'string'
                          AND (EXISTS (SELECT 1 FROM pg_temp._io_ids i WHERE i.v = (x #>> '{}') OR i.v = lower(x #>> '{}'))
                               OR (x #>> '{}') ~* 'mail\.google\.com'))
    $f$;
    -- the strip: an array element (an object) that names private data goes; a string equal to a private value becomes
    -- private-source; the tree's own old texts (subs: its query, anchor, topic, prompt, its moved seeds' titles) are
    -- cut out of every string; every Gmail URL becomes private-email
    CREATE FUNCTION pg_temp.io_scrub(j JSONB, subs TEXT[]) RETURNS JSONB LANGUAGE plpgsql STABLE AS $f$
    DECLARE
        k TEXT; v JSONB; e JSONB; s TEXT; t TEXT; o JSONB; a JSONB;
    BEGIN
        IF j IS NULL THEN RETURN NULL; END IF;
        IF jsonb_typeof(j) = 'string' THEN
            s := j #>> '{}';
            IF EXISTS (SELECT 1 FROM pg_temp._io_vals x WHERE x.v = s) THEN RETURN to_jsonb('private-source'::text); END IF;
            IF subs IS NOT NULL THEN
                FOREACH t IN ARRAY subs LOOP
                    IF length(coalesce(t, '')) >= 6 THEN s := replace(s, t, 'private-source'); END IF;
                END LOOP;
            END IF;
            RETURN to_jsonb(regexp_replace(s, '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*', 'private-email', 'gi'));
        ELSIF jsonb_typeof(j) = 'array' THEN
            a := '[]'::jsonb;
            FOR e IN SELECT x FROM jsonb_array_elements(j) x LOOP
                IF jsonb_typeof(e) = 'object' AND pg_temp.io_refs(e) THEN CONTINUE; END IF;
                a := a || jsonb_build_array(pg_temp.io_scrub(e, subs));
            END LOOP;
            RETURN a;
        ELSIF jsonb_typeof(j) = 'object' THEN
            o := '{}'::jsonb;
            FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
                o := o || jsonb_build_object(k, pg_temp.io_scrub(v, subs));
            END LOOP;
            RETURN o;
        END IF;
        RETURN j;
    END;
    $f$;
    -- round 4 (tester attempt 3, 4a): a seeded tree's rows are REBUILT, never filtered. Neutral by default: a value is kept
    -- only at a known key path, and only when it passes a strict check - an enumerated code (the research service's own
    -- report-type ids in templates.ts, its job outcomes and progress phases), a number, a boolean, a uuid that is an
    -- existing shared row's id, or a url that is EXACTLY a shared sources row's url with no query and no fragment. Every
    -- other value is 'private-text' or dropped, and no key the row carried survives unless it is one of these known keys,
    -- so no key text survives either. The events keep only the keys their CHECK constraints need.
    CREATE TEMP TABLE _io_codes (k TEXT, v TEXT, PRIMARY KEY (k, v)) ON COMMIT DROP;
    INSERT INTO _io_codes
    SELECT 'report_type', x FROM unnest(ARRAY['buyers-guide', 'scientific-paper', 'technical-proposal', 'nontechnical-proposal',
           'programming-doc', 'engineering-doc', 'product-comparison', 'market-analysis', 'value-proposition', 'general-report', 'explainer']) x
    UNION ALL SELECT 'outcome', x FROM unnest(ARRAY['ok', 'complete', 'error', 'no_relevant_sources', 'cancelled', 'timeout', 'reuse', 'paused']) x
    UNION ALL SELECT 'phase', x FROM unnest(ARRAY['queued', 'running', 'request', 'plan', 'reuse', 'gather', 'fetch', 'screen', 'synthesize',
           'persist', 'done', 'cancelled', 'error']) x;
    -- a code: kept only when it is one of the enumerated values for its key
    CREATE FUNCTION pg_temp.io_code(p_k TEXT, p_v JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE WHEN jsonb_typeof(p_v) = 'string' AND EXISTS (SELECT 1 FROM pg_temp._io_codes c WHERE c.k = p_k AND c.v = (p_v #>> '{}'))
                    THEN p_v END
    $f$;
    -- a shared source by its exact url (no query, no fragment, never a private one): its own url and title
    CREATE FUNCTION pg_temp.io_shared_source(u JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT jsonb_build_object('url', s.url, 'title', regexp_replace(coalesce(s.title, ''), '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*', 'private-email', 'gi'))
          FROM public.sources s
         WHERE jsonb_typeof(u) = 'string' AND s.url = (u #>> '{}')
           AND position('?' IN s.url) = 0 AND position('#' IN s.url) = 0 AND s.url ~* '^https?://'
           AND s.url !~* 'mail\.google\.com' AND NOT EXISTS (SELECT 1 FROM pg_temp._io_ids i WHERE i.v = s.url)
         ORDER BY s.created_at LIMIT 1
    $f$;
    -- a shared claim by its id: its id and its own (shared) text
    CREATE FUNCTION pg_temp.io_shared_claim(i JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        -- (the shared claim's text, with any Gmail url cut as step 5 cuts it from the claims row itself)
        SELECT jsonb_build_object('id', c.id, 'text', regexp_replace(coalesce(c.text, ''), '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*', 'private-email', 'gi'))
          FROM public.claims c
         WHERE jsonb_typeof(i) = 'string' AND (i #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND c.id = (i #>> '{}')::uuid AND NOT EXISTS (SELECT 1 FROM pg_temp._io_ids x WHERE x.v = c.id::text)
    $f$;
    -- result: outcome, report_type (codes), synthesis (private-text), cited_sources (shared sources only, rebuilt from the
    -- sources rows), claims / reuse_claims (shared claims only, rebuilt from the claims rows). Nothing else
    CREATE FUNCTION pg_temp.io_result(j JSONB) RETURNS JSONB LANGUAGE plpgsql STABLE AS $f$
    DECLARE o JSONB := '{}'::jsonb; a JSONB; e JSONB; x JSONB;
    BEGIN
        IF j IS NULL OR jsonb_typeof(j) <> 'object' THEN RETURN CASE WHEN j IS NULL THEN NULL ELSE '{}'::jsonb END; END IF;
        IF pg_temp.io_code('outcome', j -> 'outcome') IS NOT NULL THEN o := o || jsonb_build_object('outcome', j -> 'outcome'); END IF;
        IF pg_temp.io_code('report_type', j -> 'report_type') IS NOT NULL THEN o := o || jsonb_build_object('report_type', j -> 'report_type'); END IF;
        IF j ? 'synthesis' THEN o := o || jsonb_build_object('synthesis', 'private-text'); END IF;
        IF jsonb_typeof(j -> 'cited_sources') = 'array' THEN
            a := '[]'::jsonb;
            FOR e IN SELECT y FROM jsonb_array_elements(j -> 'cited_sources') y LOOP
                x := CASE WHEN jsonb_typeof(e) = 'object' THEN pg_temp.io_shared_source(e -> 'url') END;
                IF x IS NOT NULL AND NOT a @> jsonb_build_array(x) THEN a := a || jsonb_build_array(x); END IF;
            END LOOP;
            o := o || jsonb_build_object('cited_sources', a);
        END IF;
        FOREACH x IN ARRAY ARRAY[to_jsonb('claims'::text), to_jsonb('reuse_claims'::text)] LOOP
            IF jsonb_typeof(j -> (x #>> '{}')) = 'array' THEN
                a := '[]'::jsonb;
                FOR e IN SELECT y FROM jsonb_array_elements(j -> (x #>> '{}')) y LOOP
                    IF jsonb_typeof(e) = 'object' THEN
                        e := pg_temp.io_shared_claim(e -> 'id');
                        IF e IS NOT NULL AND NOT a @> jsonb_build_array(e) THEN a := a || jsonb_build_array(e); END IF;
                    END IF;
                END LOOP;
                o := o || jsonb_build_object(x #>> '{}', a);
            END IF;
        END LOOP;
        RETURN o;
    END;
    $f$;
    -- progress: the phase (a code) and, where there was one, a neutral message
    CREATE FUNCTION pg_temp.io_progress(j JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE WHEN j IS NULL THEN NULL WHEN jsonb_typeof(j) <> 'object' THEN '{}'::jsonb ELSE
               jsonb_strip_nulls(jsonb_build_object('phase', pg_temp.io_code('phase', j -> 'phase'),
                                                    'message', CASE WHEN j ? 'message' THEN to_jsonb('private-text'::text) END)) END
    $f$;
    -- tree report: a neutral summary only
    CREATE FUNCTION pg_temp.io_tree_report(j JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE WHEN j IS NULL THEN NULL ELSE jsonb_build_object('summary', 'private-text') END
    $f$;
    -- metrics: the three numbers research_run_metrics reads (the nested credibility / entailment / admission objects go)
    CREATE FUNCTION pg_temp.io_metrics(j JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE WHEN j IS NULL THEN NULL WHEN jsonb_typeof(j) <> 'object' THEN '{}'::jsonb ELSE
               jsonb_strip_nulls(jsonb_build_object(
                   'claims_reused', CASE WHEN jsonb_typeof(j -> 'claims_reused') = 'number' THEN j -> 'claims_reused' END,
                   'claims_freshly_gathered', CASE WHEN jsonb_typeof(j -> 'claims_freshly_gathered') = 'number' THEN j -> 'claims_freshly_gathered' END,
                   'gap_ratio', CASE WHEN jsonb_typeof(j -> 'gap_ratio') = 'number' THEN j -> 'gap_ratio' END)) END
    $f$;
    -- an event's payload: only the keys its type's CHECK needs, each value neutral, a number, or a shared row's id
    CREATE FUNCTION pg_temp.io_event_payload(typ TEXT, step TEXT, j JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE typ
            WHEN 'human_steer' THEN jsonb_build_object('topic_estimate', 'private-text', 'anchor', 'private-text', 'step_id', to_jsonb(step))
            WHEN 'gap' THEN jsonb_build_object(
                'claim_id', (pg_temp.io_shared_claim(j -> 'claim_id')) -> 'id',
                'score', CASE WHEN jsonb_typeof(j -> 'score') = 'number' THEN j -> 'score' END,
                'threshold', CASE WHEN jsonb_typeof(j -> 'threshold') = 'number' THEN j -> 'threshold' END)
            WHEN 'interhub_gap' THEN jsonb_build_object('a', NULL, 'b', NULL,
                'density', CASE WHEN jsonb_typeof(j -> 'density') = 'number' THEN j -> 'density' END)
            WHEN 'filed' THEN jsonb_build_object(
                'synthesis_id', (SELECT to_jsonb(s.id) FROM public.sources s
                                  WHERE jsonb_typeof(j -> 'synthesis_id') = 'string'
                                    AND (j ->> 'synthesis_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    AND s.id = (j ->> 'synthesis_id')::uuid),
                'research_key', 'private-text')
            ELSE '{}'::jsonb END
    $f$;
    -- an event's trail: a source event must keep a non-empty object (its CHECK); any other trail goes neutral or stays NULL
    CREATE FUNCTION pg_temp.io_event_trail(typ TEXT, j JSONB) RETURNS JSONB LANGUAGE sql STABLE AS $f$
        SELECT CASE WHEN j IS NULL AND typ <> 'source' THEN NULL ELSE jsonb_build_object('text', 'private-text') END
    $f$;
    -- the SEEDED trees: a job seeded with an email body or a moved source (the digest's body fallback) carries the
    -- email's subject in its question; the whole tree (root and branches) gets a neutral question, anchor and topic,
    -- and so does its prompt row
    CREATE TEMP TABLE _io_roots ON COMMIT DROP AS
    SELECT DISTINCT coalesce(j.root_job_id, j.id) AS root
      FROM public.research_jobs j
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.options -> 'seed_sources') = 'array' THEN j.options -> 'seed_sources' ELSE '[]' END) e
                    WHERE e::text ~* 'mail\.google\.com' OR coalesce(e ->> 'url', '') IN (SELECT url FROM _io_src WHERE url IS NOT NULL))
    -- round 3: a tree an earlier batch already made private (a branch or event added to it since is its text too)
    UNION
    SELECT DISTINCT coalesce(j.root_job_id, j.id) FROM public.research_jobs j JOIN public.inlet_private_jobs p ON p.job_id = j.id;
    CREATE TEMP TABLE _io_tree ON COMMIT DROP AS
    SELECT j.id, rr.root, 'Research job ' || left(rr.root::text, 8) AS neutral,
           (SELECT array_agg(DISTINCT x) FILTER (WHERE length(coalesce(x, '')) >= 6) FROM (
                SELECT rj.query AS x FROM public.research_jobs rj WHERE rj.id = rr.root
                UNION ALL SELECT rj.anchor FROM public.research_jobs rj WHERE coalesce(rj.root_job_id, rj.id) = rr.root
                UNION ALL SELECT rj.topic_estimate FROM public.research_jobs rj WHERE coalesce(rj.root_job_id, rj.id) = rr.root
                UNION ALL SELECT rj.query FROM public.research_jobs rj WHERE coalesce(rj.root_job_id, rj.id) = rr.root
                UNION ALL SELECT p.prompt FROM public.research_prompts p JOIN public.research_jobs rj ON rj.id = p.job_id WHERE coalesce(rj.root_job_id, rj.id) = rr.root
                UNION ALL SELECT e ->> 'title' FROM public.research_jobs rj, jsonb_array_elements(CASE WHEN jsonb_typeof(rj.options -> 'seed_sources') = 'array' THEN rj.options -> 'seed_sources' ELSE '[]' END) e
                           WHERE coalesce(rj.root_job_id, rj.id) = rr.root AND (e::text ~* 'mail\.google\.com' OR coalesce(e ->> 'url', '') IN (SELECT url FROM _io_src WHERE url IS NOT NULL))) q) AS subs
      FROM _io_roots rr JOIN public.research_jobs j ON coalesce(j.root_job_id, j.id) = rr.root;
    ALTER TABLE _io_tree ADD PRIMARY KEY (id);
    -- every job, prompt and event that names private data, or belongs to a seeded tree
    -- (a tree job counts while its text is not yet neutral: a second run over an already-private tree has nothing to do)
    CREATE TEMP TABLE _io_jobs ON COMMIT DROP AS
    SELECT j.id FROM public.research_jobs j
     WHERE (j.id IN (SELECT id FROM _io_tree)
            AND (j.query IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id)
                 OR (j.anchor IS NOT NULL AND j.anchor IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id))
                 OR (j.topic_estimate IS NOT NULL AND j.topic_estimate IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id))
                 OR pg_temp.io_result(j.result) IS DISTINCT FROM j.result OR pg_temp.io_progress(j.progress) IS DISTINCT FROM j.progress
                 OR (j.options IS NOT NULL AND j.options <> '{}'::jsonb) OR pg_temp.io_tree_report(j.tree_report) IS DISTINCT FROM j.tree_report
                 OR pg_temp.io_metrics(j.metrics) IS DISTINCT FROM j.metrics OR j.inlet_ref IS NOT NULL
                 OR (j.error IS NOT NULL AND j.error <> 'private-text') OR (j.gap_ref IS NOT NULL AND j.gap_ref <> 'private-text')))
        OR pg_temp.io_hits(coalesce(j.options::text, '') || ' ' || coalesce(j.result::text, '') || ' ' || coalesce(j.tree_report::text, '')
                           || ' ' || coalesce(j.query, '') || ' ' || coalesce(j.anchor, '') || ' ' || coalesce(j.topic_estimate, ''));
    CREATE TEMP TABLE _io_prompts ON COMMIT DROP AS
    SELECT p.job_id FROM public.research_prompts p
     WHERE (p.job_id IN (SELECT id FROM _io_tree) AND p.prompt IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = p.job_id))
        OR pg_temp.io_hits(p.prompt);
    CREATE TEMP TABLE _io_events ON COMMIT DROP AS
    SELECT e.id FROM public.research_job_events e
     WHERE ((e.job_id IN (SELECT id FROM _io_tree) OR e.root_job_id IN (SELECT root FROM _io_roots))
            AND (pg_temp.io_event_payload(e.type, e.step_id, e.payload) IS DISTINCT FROM e.payload OR pg_temp.io_event_trail(e.type, e.trail) IS DISTINCT FROM e.trail))
        OR pg_temp.io_hits(coalesce(e.payload::text, '') || ' ' || coalesce(e.trail::text, ''));
    -- the shared rows that carry a Gmail id or URL
    CREATE TEMP TABLE _io_meta_src ON COMMIT DROP AS
    SELECT s.id FROM public.sources s
     WHERE s.id NOT IN (SELECT id FROM _io_src)
       AND (s.metadata ?| ARRAY['gmail_id', 'gmail_thread_id', 'gmail_labels']
            OR s.metadata::text ~* 'mail\.google\.com' OR coalesce(s.content, '') ~* 'mail\.google\.com');
    CREATE TEMP TABLE _io_meta_chunks ON COMMIT DROP AS
    SELECT c.source_id, c.idx FROM public.source_chunks c
     WHERE c.source_id NOT IN (SELECT id FROM _io_src) AND coalesce(c.content, '') ~* 'mail\.google\.com';
    CREATE TEMP TABLE _io_meta_claims ON COMMIT DROP AS
    SELECT c.id FROM public.claims c
     WHERE c.id NOT IN (SELECT id FROM _io_claims) AND coalesce(c.text, '') ~* 'mail\.google\.com';

    IF NOT EXISTS (SELECT 1 FROM _io_thoughts) AND v_src IS NULL AND NOT EXISTS (SELECT 1 FROM _io_jobs)
       AND NOT EXISTS (SELECT 1 FROM _io_prompts) AND NOT EXISTS (SELECT 1 FROM _io_events)
       AND NOT EXISTS (SELECT 1 FROM _io_meta_src) AND NOT EXISTS (SELECT 1 FROM _io_meta_chunks) AND NOT EXISTS (SELECT 1 FROM _io_meta_claims)
       AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug ~ '^content/thought/[0-9]+$'
                         AND NOT EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id::text = substr(w.slug, 17) AND t.user_id IS NULL))
       AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE public.inlet_owner_page_links_private(w.slug, w.title, w.body, w.links)) THEN
        RAISE NOTICE 'inlet owner: no unowned thought, private source, job seed, Gmail id or private page - nothing to do';
        RETURN;
    END IF;
    IF v_owner IS NULL OR v_owner LIKE 'service:%' THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - there is personal data to make private and no owner subject (run it with -v owner_sub=<the operator''s subject, WORKSPACE_DEFAULT_SUB>; never a service:)'
            USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.inlet_owner (singleton, owner_sub, first_run_at) VALUES (true, v_owner, v_first)
    ON CONFLICT (singleton) DO NOTHING;

    -- 1. the thoughts: archive (id, user_id), then stamp with triggers off (only user_id changes: no fingerprint, no
    --    re-extraction, no intake re-judgement)
    -- [archive-thoughts]
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, row_data)
    SELECT v_batch, 'public.thoughts', 'user_id', 'o', jsonb_build_object('id', t.id, 'user_id', t.user_id)
      FROM public.thoughts t JOIN _io_thoughts x ON x.id = t.id;
    -- [/archive-thoughts]
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.thoughts t SET user_id = v_owner
      FROM public.inlet_owner_archive a
     WHERE a.batch = v_batch AND a.action = 'o' AND (a.row_data ->> 'id')::bigint = t.id AND t.user_id IS NULL;
    GET DIAGNOSTICS n_thoughts = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF n_thoughts <> (SELECT count(*) FROM _io_thoughts) THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - % unowned thought(s) in scope, % archived and stamped', (SELECT count(*) FROM _io_thoughts), n_thoughts
            USING ERRCODE = '55000';
    END IF;

    -- 4 (before the sources go: the jobs are matched by their ids and urls). the jobs, their prompts and their events:
    --    the new values computed first; every row that changes is archived whole (j: the job's changed columns; m: a prompt
    --    or an event row), then written with triggers off
    CREATE TEMP TABLE _io_jobs_new ON COMMIT DROP AS
    SELECT j.id, (t.id IS NOT NULL) AS tree,
           CASE WHEN t.id IS NOT NULL THEN t.neutral ELSE j.query END AS query,
           CASE WHEN t.id IS NOT NULL AND j.anchor IS NOT NULL THEN t.neutral ELSE j.anchor END AS anchor,
           CASE WHEN t.id IS NOT NULL AND j.topic_estimate IS NOT NULL THEN t.neutral ELSE j.topic_estimate END AS topic_estimate,
           CASE WHEN t.id IS NOT NULL THEN (CASE WHEN j.options IS NULL THEN NULL ELSE '{}'::jsonb END) ELSE pg_temp.io_scrub(j.options, NULL) END AS options,
           CASE WHEN t.id IS NOT NULL THEN pg_temp.io_result(j.result) ELSE pg_temp.io_scrub(j.result, NULL) END AS result,
           CASE WHEN t.id IS NOT NULL THEN pg_temp.io_tree_report(j.tree_report) ELSE pg_temp.io_scrub(j.tree_report, NULL) END AS tree_report,
           CASE WHEN t.id IS NOT NULL THEN pg_temp.io_progress(j.progress) ELSE pg_temp.io_scrub(j.progress, NULL) END AS progress,
           CASE WHEN t.id IS NOT NULL THEN pg_temp.io_metrics(j.metrics) ELSE j.metrics END AS metrics,
           CASE WHEN t.id IS NOT NULL THEN NULL ELSE j.inlet_ref END AS inlet_ref,
           CASE WHEN j.error IS NULL THEN NULL
                WHEN t.id IS NOT NULL THEN 'private-text'
                ELSE regexp_replace(j.error, '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*', 'private-email', 'gi') END AS error,
           CASE WHEN t.id IS NOT NULL AND j.gap_ref IS NOT NULL THEN 'private-text' ELSE j.gap_ref END AS gap_ref
      FROM public.research_jobs j JOIN _io_jobs x ON x.id = j.id LEFT JOIN _io_tree t ON t.id = j.id;
    DELETE FROM _io_jobs_new n USING public.research_jobs j
     WHERE j.id = n.id AND n.query IS NOT DISTINCT FROM j.query AND n.anchor IS NOT DISTINCT FROM j.anchor
       AND n.topic_estimate IS NOT DISTINCT FROM j.topic_estimate AND n.options IS NOT DISTINCT FROM j.options
       AND n.result IS NOT DISTINCT FROM j.result AND n.tree_report IS NOT DISTINCT FROM j.tree_report
       AND n.progress IS NOT DISTINCT FROM j.progress AND n.error IS NOT DISTINCT FROM j.error AND n.gap_ref IS NOT DISTINCT FROM j.gap_ref
       AND n.metrics IS NOT DISTINCT FROM j.metrics AND n.inlet_ref IS NOT DISTINCT FROM j.inlet_ref;
    -- [archive-jobs]
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, row_data)
    SELECT v_batch, 'public.research_jobs', 'query,anchor,topic_estimate,options,result,tree_report,progress,error,gap_ref,metrics,inlet_ref', 'j',
           jsonb_build_object('id', j.id, 'query', j.query, 'anchor', j.anchor, 'topic_estimate', j.topic_estimate,
                              'options', j.options, 'result', j.result, 'tree_report', j.tree_report,
                              'progress', j.progress, 'error', j.error, 'gap_ref', j.gap_ref,
                              'metrics', j.metrics, 'inlet_ref', j.inlet_ref)
      FROM public.research_jobs j JOIN _io_jobs_new n ON n.id = j.id;
    -- [/archive-jobs]
    -- the seeded trees' own text, for the owner
    INSERT INTO public.inlet_private_jobs (job_id, batch, owner_sub, row_data)
    SELECT n.id, v_batch, v_owner, a.row_data
      FROM _io_jobs_new n JOIN public.inlet_owner_archive a ON a.batch = v_batch AND a.action = 'j' AND (a.row_data ->> 'id')::uuid = n.id
     WHERE n.tree;
    SELECT coalesce(sum(jsonb_array_length(j.options -> 'seed_sources')), 0) INTO n_seeds
      FROM public.research_jobs j JOIN _io_jobs_new n ON n.id = j.id WHERE jsonb_typeof(j.options -> 'seed_sources') = 'array';
    CREATE TEMP TABLE _io_prompts_new ON COMMIT DROP AS
    SELECT p.job_id, CASE WHEN t.id IS NOT NULL THEN t.neutral
                          ELSE regexp_replace(p.prompt, '(https?://)?mail\.google\.com[^][:space:]"<>()\\]*', 'private-email', 'gi') END AS prompt
      FROM public.research_prompts p JOIN _io_prompts x ON x.job_id = p.job_id LEFT JOIN _io_tree t ON t.id = p.job_id;
    DELETE FROM _io_prompts_new n USING public.research_prompts p WHERE p.job_id = n.job_id AND p.prompt = n.prompt;
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.research_prompts', '*', 'm', p.job_id::text, to_jsonb(p)
      FROM public.research_prompts p JOIN _io_prompts_new n ON n.job_id = p.job_id;
    CREATE TEMP TABLE _io_events_new ON COMMIT DROP AS
    SELECT e.id, e.job_id, (t.subs IS NOT NULL OR t.hit) AS tree,
           CASE WHEN t.hit THEN pg_temp.io_event_payload(e.type, e.step_id, e.payload) ELSE pg_temp.io_scrub(e.payload, NULL) END AS payload,
           CASE WHEN t.hit THEN pg_temp.io_event_trail(e.type, e.trail) ELSE pg_temp.io_scrub(e.trail, NULL) END AS trail
      FROM public.research_job_events e JOIN _io_events x ON x.id = e.id
      LEFT JOIN LATERAL (SELECT tt.subs, true AS hit FROM _io_tree tt WHERE tt.root = e.root_job_id OR tt.id = e.job_id LIMIT 1) t ON true;
    DELETE FROM _io_events_new n USING public.research_job_events e
     WHERE e.id = n.id AND n.payload IS NOT DISTINCT FROM e.payload AND n.trail IS NOT DISTINCT FROM e.trail;
    -- [archive-events]
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.research_job_events', '*', 'm', e.id::text, to_jsonb(e)
      FROM public.research_job_events e JOIN _io_events_new n ON n.id = e.id;
    -- [/archive-events]
    INSERT INTO public.inlet_private_job_events (event_id, batch, owner_sub, job_id, row_data)
    SELECT e.id, v_batch, v_owner, e.job_id, to_jsonb(e)
      FROM public.research_job_events e JOIN _io_events_new n ON n.id = e.id WHERE n.tree;
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.research_jobs j
       SET query = n.query, anchor = n.anchor, topic_estimate = n.topic_estimate, options = n.options, result = n.result, tree_report = n.tree_report,
           progress = n.progress, error = n.error, gap_ref = n.gap_ref, metrics = n.metrics, inlet_ref = n.inlet_ref
      FROM _io_jobs_new n, public.inlet_owner_archive a
     WHERE n.id = j.id AND a.batch = v_batch AND a.action = 'j' AND (a.row_data ->> 'id')::uuid = j.id;
    GET DIAGNOSTICS n_jobs = ROW_COUNT;
    UPDATE public.research_prompts p SET prompt = n.prompt
      FROM _io_prompts_new n, public.inlet_owner_archive a
     WHERE n.job_id = p.job_id AND a.batch = v_batch AND a.action = 'm' AND a.tbl = 'public.research_prompts' AND a.ref = p.job_id::text;
    GET DIAGNOSTICS n_prompts = ROW_COUNT;
    UPDATE public.research_job_events e SET payload = n.payload, trail = n.trail
      FROM _io_events_new n, public.inlet_owner_archive a
     WHERE n.id = e.id AND a.batch = v_batch AND a.action = 'm' AND a.tbl = 'public.research_job_events' AND a.ref = e.id::text;
    GET DIAGNOSTICS n_events = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF n_jobs <> (SELECT count(*) FROM _io_jobs_new) OR n_prompts <> (SELECT count(*) FROM _io_prompts_new)
       OR n_events <> (SELECT count(*) FROM _io_events_new) THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - % job(s), % prompt(s), % event(s) to strip; % / % / % archived and written',
            (SELECT count(*) FROM _io_jobs_new), (SELECT count(*) FROM _io_prompts_new), (SELECT count(*) FROM _io_events_new), n_jobs, n_prompts, n_events
            USING ERRCODE = '55000';
    END IF;
    SELECT n_seeds - coalesce(sum(jsonb_array_length(j.options -> 'seed_sources')), 0) INTO n_seeds
      FROM public.research_jobs j JOIN _io_jobs_new n ON n.id = j.id WHERE jsonb_typeof(j.options -> 'seed_sources') = 'array';
    -- fail closed: no job, prompt or event names private data any more, and every seeded tree carries only its neutral question
    IF EXISTS (SELECT 1 FROM public.research_jobs j
                WHERE pg_temp.io_hits(coalesce(j.options::text, '') || ' ' || coalesce(j.result::text, '') || ' ' || coalesce(j.tree_report::text, '')
                                      || ' ' || coalesce(j.query, '') || ' ' || coalesce(j.anchor, '') || ' ' || coalesce(j.topic_estimate, '')))
       OR EXISTS (SELECT 1 FROM public.research_prompts p WHERE pg_temp.io_hits(p.prompt))
       OR EXISTS (SELECT 1 FROM public.research_job_events e WHERE pg_temp.io_hits(coalesce(e.payload::text, '') || ' ' || coalesce(e.trail::text, '')))
       OR EXISTS (SELECT 1 FROM _io_tree t JOIN public.research_jobs j ON j.id = t.id
                   WHERE j.query IS DISTINCT FROM t.neutral OR (j.anchor IS NOT NULL AND j.anchor IS DISTINCT FROM t.neutral)
                      OR (j.topic_estimate IS NOT NULL AND j.topic_estimate IS DISTINCT FROM t.neutral))
       OR EXISTS (SELECT 1 FROM _io_tree t JOIN public.research_prompts p ON p.job_id = t.id WHERE p.prompt IS DISTINCT FROM t.neutral)
       -- round 4: every row of a seeded tree is its rebuild (the rebuild changes nothing more)
       OR EXISTS (SELECT 1 FROM _io_tree t JOIN public.research_jobs j ON j.id = t.id WHERE (j.query IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id)
                 OR (j.anchor IS NOT NULL AND j.anchor IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id))
                 OR (j.topic_estimate IS NOT NULL AND j.topic_estimate IS DISTINCT FROM (SELECT t.neutral FROM _io_tree t WHERE t.id = j.id))
                 OR pg_temp.io_result(j.result) IS DISTINCT FROM j.result OR pg_temp.io_progress(j.progress) IS DISTINCT FROM j.progress
                 OR (j.options IS NOT NULL AND j.options <> '{}'::jsonb) OR pg_temp.io_tree_report(j.tree_report) IS DISTINCT FROM j.tree_report
                 OR pg_temp.io_metrics(j.metrics) IS DISTINCT FROM j.metrics OR j.inlet_ref IS NOT NULL
                 OR (j.error IS NOT NULL AND j.error <> 'private-text') OR (j.gap_ref IS NOT NULL AND j.gap_ref <> 'private-text')))
       OR EXISTS (SELECT 1 FROM public.research_job_events e
                   WHERE (e.root_job_id IN (SELECT root FROM _io_roots) OR e.job_id IN (SELECT id FROM _io_tree))
                     AND (pg_temp.io_event_payload(e.type, e.step_id, e.payload) IS DISTINCT FROM e.payload OR pg_temp.io_event_trail(e.type, e.trail) IS DISTINCT FROM e.trail)) THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - a research job, prompt or event still names private data after the strip' USING ERRCODE = '55000';
    END IF;

    IF v_src IS NOT NULL THEN
        SELECT count(*) FILTER (WHERE mail), count(*) FILTER (WHERE NOT mail) INTO n_src_mail, n_src_pod FROM _io_src;
        -- 2. the sources: archive the rows, copy them (and their chunks) into the owner's private store
        -- [archive-sources]
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
        SELECT v_batch, 'public.sources', 'id', 's', s.id::text, to_jsonb(s) FROM public.sources s WHERE s.id = ANY(v_src);
        -- [/archive-sources]
        EXECUTE format('INSERT INTO public.inlet_private_sources (%s, inlet_owner_sub, inlet_batch) SELECT %s, $1, $2 FROM public.sources s WHERE s.id = ANY($3) ON CONFLICT (id) DO NOTHING',
                       (SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.sources'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''),
                       (SELECT string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.sources'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_owner, v_batch, v_src;
        EXECUTE format('INSERT INTO public.inlet_private_source_chunks (%s, inlet_owner_sub, inlet_batch) SELECT %s, $1, $2 FROM public.source_chunks s WHERE s.source_id = ANY($3) ON CONFLICT DO NOTHING',
                       (SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.source_chunks'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''),
                       (SELECT string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.source_chunks'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_owner, v_batch, v_src;
        SELECT count(*) INTO n_chunks FROM public.source_chunks WHERE source_id = ANY(v_src);
        -- 3. the claims: the private ones archived and copied; the private links of shared claims kept for the owner;
        --    every shared claim that loses a link archived whole (its confidence is recomputed when the link goes)
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
        SELECT v_batch, 'public.claims', 'id', 'k', c.id::text, to_jsonb(c) FROM public.claims c WHERE c.id IN (SELECT id FROM _io_claims);
        GET DIAGNOSTICS n_claims = ROW_COUNT;
        EXECUTE format('INSERT INTO public.inlet_private_claims (%s, inlet_owner_sub, inlet_batch) SELECT %s, $1, $2 FROM public.claims s WHERE s.id IN (SELECT id FROM _io_claims) ON CONFLICT (id) DO NOTHING',
                       (SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''),
                       (SELECT string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_owner, v_batch;
        INSERT INTO public.inlet_private_claim_links (claim_id, source_id, owner_sub, batch, row_data)
        SELECT cs.claim_id, cs.source_id, v_owner, v_batch, to_jsonb(cs) FROM public.claim_sources cs
         WHERE cs.source_id = ANY(v_src) AND cs.claim_id IN (SELECT id FROM _io_kept)
        ON CONFLICT DO NOTHING;
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
        SELECT v_batch, 'public.claims', '*', 'm', c.id::text, to_jsonb(c) FROM public.claims c WHERE c.id IN (SELECT id FROM _io_kept);
        GET DIAGNOSTICS n_mixed = ROW_COUNT;
        -- every claim_sources row the deletes take (a source edge to a moved source, any edge of a private claim, an
        -- edge to a private claim as parent): archived once
        INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
        SELECT v_batch, 'public.claim_sources', 'source_id|claim_id|parent_claim_id', 'c', coalesce(cs.source_id, cs.claim_id)::text, to_jsonb(cs)
          FROM public.claim_sources cs
         WHERE cs.source_id = ANY(v_src) OR cs.claim_id IN (SELECT id FROM _io_claims) OR cs.parent_claim_id IN (SELECT id FROM _io_claims);
        GET DIAGNOSTICS v_n = ROW_COUNT; v_dep := v_dep + v_n;
        -- every other row a foreign key ties to a moved source or a private claim (discovered, so a key added later is
        -- covered): archived; a cascaded row may not take an unarchived row with it
        FOR r IN
            SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, con.confdeltype::text AS act, con.confrelid::regclass::text AS parent,
                   cardinality(con.conkey) AS n_cols
              FROM pg_constraint con
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
             WHERE con.contype = 'f' AND con.confrelid IN ('public.sources'::regclass, 'public.claims'::regclass)
               AND con.conrelid <> 'public.claim_sources'::regclass
        LOOP
            IF r.n_cols <> 1 THEN
                RAISE EXCEPTION 'inlet owner: refused, nothing changed - a multi-column foreign key onto % (%), not archived by this move', r.parent, r.tbl USING ERRCODE = '55000';
            END IF;
            EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = ANY($1)', r.tbl, r.col) INTO v_n
                USING CASE WHEN r.parent = 'sources' OR r.parent = 'public.sources' THEN v_src ELSE coalesce(v_cl, '{}'::uuid[]) END;
            IF v_n = 0 THEN CONTINUE; END IF;
            IF r.act NOT IN ('c', 'n', 'd') THEN
                RAISE EXCEPTION 'inlet owner: refused, nothing changed - % row(s) of % reference a moved row through a foreign key that would refuse the delete (%)', v_n, r.tbl, r.act USING ERRCODE = '55000';
            END IF;
            IF r.act = 'c' THEN
                FOR d IN
                    SELECT c2.conrelid::regclass::text AS tbl2,
                           (SELECT string_agg(format('t2.%I = t.%I', ca.attname, pa.attname), ' AND ')
                              FROM unnest(c2.conkey, c2.confkey) k(c, p)
                              JOIN pg_attribute ca ON ca.attrelid = c2.conrelid AND ca.attnum = k.c
                              JOIN pg_attribute pa ON pa.attrelid = c2.confrelid AND pa.attnum = k.p) AS on_clause
                      FROM pg_constraint c2 WHERE c2.contype = 'f' AND c2.confrelid = r.tbl::regclass
                LOOP
                    EXECUTE format('SELECT count(*) FROM %s t2 WHERE EXISTS (SELECT 1 FROM %s t WHERE t.%I = ANY($1) AND %s)', d.tbl2, r.tbl, r.col, d.on_clause)
                        INTO v_n USING CASE WHEN r.parent IN ('sources', 'public.sources') THEN v_src ELSE coalesce(v_cl, '{}'::uuid[]) END;
                    IF v_n > 0 THEN
                        RAISE EXCEPTION 'inlet owner: refused, nothing changed - % row(s) of % hang off % rows the move would cascade', v_n, d.tbl2, r.tbl USING ERRCODE = '55000';
                    END IF;
                END LOOP;
            END IF;
            EXECUTE format('INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
                            SELECT $1, %L, %L, %L, t.%I::text, to_jsonb(t) FROM %s t WHERE t.%I = ANY($2)', r.tbl, r.col, r.act, r.col, r.tbl, r.col)
                USING v_batch, CASE WHEN r.parent IN ('sources', 'public.sources') THEN v_src ELSE coalesce(v_cl, '{}'::uuid[]) END;
            GET DIAGNOSTICS v_n = ROW_COUNT; v_dep := v_dep + v_n;
            IF r.act IN ('n', 'd') THEN
                PERFORM set_config('session_replication_role', 'replica', true);
                EXECUTE format('UPDATE %s t SET %I = %s WHERE t.%I = ANY($1)', r.tbl, r.col, CASE r.act WHEN 'n' THEN 'NULL' ELSE 'DEFAULT' END, r.col)
                    USING CASE WHEN r.parent IN ('sources', 'public.sources') THEN v_src ELSE coalesce(v_cl, '{}'::uuid[]) END;
                PERFORM set_config('session_replication_role', 'origin', true);
            END IF;
        END LOOP;
        -- out of the shared knowledge: the private claims first (their edges cascade; a shared claim that grounded on
        -- one has its confidence recomputed), then the sources (chunks, links, thread and session rows cascade)
        DELETE FROM public.claims c WHERE c.id IN (SELECT id FROM _io_claims);
        DELETE FROM public.sources s WHERE s.id = ANY(v_src);
        SELECT count(*) INTO n_left FROM public.sources s WHERE s.id = ANY(v_src);
        IF n_left <> 0 OR (SELECT count(*) FROM public.inlet_owner_archive WHERE batch = v_batch AND action = 's') <> cardinality(v_src)
           OR (SELECT count(*) FROM public.inlet_private_sources WHERE id = ANY(v_src)) <> cardinality(v_src) THEN
            RAISE EXCEPTION 'inlet owner: refused, nothing changed - % private source(s), not every one archived, copied and removed (% left)', cardinality(v_src), n_left
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- 5. Gmail ids and URLs out of the shared rows (whole rows archived first; triggers off: nothing else moves)
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.sources', '*', 'm', s.id::text, to_jsonb(s) FROM public.sources s WHERE s.id IN (SELECT id FROM _io_meta_src);
    GET DIAGNOSTICS n_meta = ROW_COUNT;
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.source_chunks', '*', 'm', c.source_id::text, to_jsonb(c)
      FROM public.source_chunks c JOIN _io_meta_chunks x ON x.source_id = c.source_id AND x.idx = c.idx;
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.claims', '*', 'm', c.id::text, to_jsonb(c) FROM public.claims c
     WHERE c.id IN (SELECT id FROM _io_meta_claims) AND c.id NOT IN (SELECT id FROM _io_kept);
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.sources s
       SET metadata = regexp_replace((s.metadata - ARRAY['gmail_id', 'gmail_thread_id', 'gmail_labels'])::text, c_mail, 'private-email', 'gi')::jsonb,
           content = CASE WHEN s.content IS NULL THEN NULL ELSE regexp_replace(s.content, c_mail, 'private-email', 'gi') END
     WHERE s.id IN (SELECT id FROM _io_meta_src);
    UPDATE public.source_chunks c SET content = regexp_replace(c.content, c_mail, 'private-email', 'gi')
      FROM _io_meta_chunks x WHERE x.source_id = c.source_id AND x.idx = c.idx;
    UPDATE public.claims c SET text = regexp_replace(c.text, c_mail, 'private-email', 'gi') WHERE c.id IN (SELECT id FROM _io_meta_claims);
    PERFORM set_config('session_replication_role', 'origin', true);
    IF EXISTS (SELECT 1 FROM public.sources s WHERE s.metadata ?| ARRAY['gmail_id', 'gmail_thread_id', 'gmail_labels'] OR s.metadata::text ~* 'mail\.google\.com' OR coalesce(s.content, '') ~* 'mail\.google\.com')
       OR EXISTS (SELECT 1 FROM public.source_chunks c WHERE coalesce(c.content, '') ~* 'mail\.google\.com')
       OR EXISTS (SELECT 1 FROM public.claims c WHERE coalesce(c.text, '') ~* 'mail\.google\.com')
       THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - a Gmail id or URL is still in a shared row after the strip' USING ERRCODE = '55000';
    END IF;

    -- 6. the wiki. Withheld: a thought leaf whose thought is not in the shared corpus (private now, or gone); any page
    --    the guard's predicate matches (links a private thought or a moved source); an entity page whose evidence holds
    --    a private thought or a moved source. Archived first (with md5(body), so the same text cannot come back).
    CREATE TEMP TABLE _io_pages ON COMMIT DROP AS
    SELECT w.slug FROM public.wiki_pages w
     WHERE (w.slug ~ '^content/thought/[0-9]{1,18}$'
            AND NOT EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id = substr(w.slug, 17)::bigint AND t.user_id IS NULL))
        OR public.inlet_owner_page_links_private(w.slug, w.title, w.body, w.links)
        OR (w.page_class = 'entity' AND (w.frontmatter ->> 'entity_id') IN (
               -- the evidence THIS batch made private (a re-run must not withhold a page rebuilt from shared material)
               SELECT te.entity_id::text FROM public.thought_entities te JOIN _io_thoughts x ON x.id = te.thought_id
               UNION
               SELECT a.row_data ->> 'entity_id' FROM public.inlet_owner_archive a
                WHERE a.batch = v_batch AND a.action = 'c' AND to_regclass(a.tbl) = 'public.source_entities'::regclass));
    ALTER TABLE _io_pages ADD PRIMARY KEY (slug);
    -- [archive-pages]
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, ref_hash, row_data)
    SELECT v_batch, 'public.wiki_pages', 'slug', 'w', w.slug, md5(coalesce(w.body, '')), to_jsonb(w)
      FROM public.wiki_pages w JOIN _io_pages p USING (slug);
    -- [/archive-pages]
    WITH gone AS (
        DELETE FROM public.wiki_pages w
         USING public.inlet_owner_archive a
         WHERE a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug
           AND to_jsonb(w) = a.row_data
        RETURNING w.slug)
    SELECT count(*) INTO n_pages FROM gone;
    IF n_pages <> (SELECT count(*) FROM _io_pages)
       OR EXISTS (SELECT 1 FROM public.wiki_pages w JOIN _io_pages p USING (slug)) THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - % wiki page(s) present private data, % archived and withheld', (SELECT count(*) FROM _io_pages), n_pages
            USING ERRCODE = '55000';
    END IF;
    -- the withheld pages' text, for the guard's "came back" rule (at any slug): the normalised body as 8-word chunks
    CREATE TEMP TABLE _io_norm ON COMMIT DROP AS
    SELECT a.id AS page_ref, string_to_array(NULLIF(public.inlet_owner_norm(a.row_data ->> 'body'), ''), ' ') AS w,
           md5(public.inlet_owner_norm(a.row_data ->> 'body')) AS whole
      FROM public.inlet_owner_archive a WHERE a.batch = v_batch AND a.action = 'w';
    -- a page of up to 64 words keeps EVERY 8-word window (a one-word change then breaks at most 8 of them); a longer page
    -- keeps every 8th window (aligned chunks: storage stays near one hash per 8 words; the guard reads every window of the
    -- page it judges, so alignment does not matter there)
    INSERT INTO public.inlet_owner_withheld_chunks (h, page_ref)
    SELECT DISTINCT md5(array_to_string(n.w[k + 1 : k + 8], ' ')), n.page_ref
      FROM _io_norm n,
           generate_series(0, coalesce(array_length(n.w, 1), 0) - 8,
                           CASE WHEN coalesce(array_length(n.w, 1), 0) <= 64 THEN 1 ELSE 8 END) k
    ON CONFLICT DO NOTHING;
    INSERT INTO public.inlet_owner_withheld_pages (page_ref, n_chunks, whole_hash)
    SELECT n.page_ref, (SELECT count(*) FROM public.inlet_owner_withheld_chunks c WHERE c.page_ref = n.page_ref), n.whole FROM _io_norm n
    ON CONFLICT (page_ref) DO NOTHING;
    GET DIAGNOSTICS n_chunk_pages = ROW_COUNT;
    -- the entities of the withheld entity pages and of the moved sources: bumped (old updated_at archived), so the next
    -- compile rebuilds the ones that still have shared evidence, from shared material only
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    SELECT v_batch, 'public.entities', 'updated_at', 'u', e.id::text, jsonb_build_object('id', e.id, 'updated_at', e.updated_at, 'bumped_to', v_now)
      FROM public.entities e
     WHERE e.id::text IN (SELECT a.row_data -> 'frontmatter' ->> 'entity_id' FROM public.inlet_owner_archive a
                           WHERE a.batch = v_batch AND a.action = 'w' AND a.row_data ->> 'page_class' = 'entity'
                          UNION
                          SELECT a.row_data ->> 'entity_id' FROM public.inlet_owner_archive a
                           WHERE a.batch = v_batch AND a.action = 'c' AND to_regclass(a.tbl) = 'public.source_entities'::regclass)
       AND e.updated_at IS DISTINCT FROM v_now;
    GET DIAGNOSTICS n_ents = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.entities e SET updated_at = v_now
      FROM public.inlet_owner_archive a WHERE a.batch = v_batch AND a.action = 'u' AND a.ref = e.id::text;
    PERFORM set_config('session_replication_role', 'origin', true);
    SELECT count(*) INTO n_rebuild FROM public.inlet_owner_archive a
     WHERE a.batch = v_batch AND a.action = 'u'
       AND EXISTS (SELECT 1 FROM public.source_entities se JOIN public.sources s ON s.id = se.source_id
                    WHERE se.entity_id::text = a.ref AND s.retraction_committed_at IS NULL);

    RAISE NOTICE 'inlet owner: % thought(s) now the owner''s; % email-body + % podcast-transcript source(s) and % chunk(s) moved private; % claim(s) private, % shared claim(s) lost a private link; % dependent row(s) archived',
        n_thoughts, n_src_mail, n_src_pod, n_chunks, n_claims, n_mixed, v_dep;
    RAISE NOTICE 'inlet owner: % job(s) stripped (% private seed(s); % seeded tree(s), % job(s) in them, their text the owner''s: % job(s) and % event(s) copied private), % prompt(s), % event(s); % shared source(s) lost a Gmail id or URL',
        n_jobs, n_seeds, (SELECT count(*) FROM _io_roots), (SELECT count(*) FROM _io_tree),
        (SELECT count(*) FROM public.inlet_private_jobs WHERE batch = v_batch), (SELECT count(*) FROM public.inlet_private_job_events WHERE batch = v_batch),
        n_prompts, n_events, n_meta;
    RAISE NOTICE 'inlet owner: % wiki page(s) withheld (move their vault files out, restart the viewer: the deploy step), their text kept as chunks for the guard (% page(s)); % entit(ies) bumped, % with shared evidence to rebuild from',
        n_pages, n_chunk_pages, n_ents, n_rebuild;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
