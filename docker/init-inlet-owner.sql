-- ============================================================
-- Existing personal data becomes its owner's, and private (research-workbench rw-inlet-owner, plan 08 PD1). Slot 410.
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
-- Fresh-volume slot 410 (an empty database: nothing to do, no owner needed).
-- ============================================================
\if :{?owner_sub}
\else
\set owner_sub ''
\endif
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '10s';
SELECT set_config('inlet_owner.sub', :'owner_sub', true) AS owner_given \gset

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
                             'inlet_private_claims', 'inlet_private_claim_links'] LOOP
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
  'rw-inlet-owner (slot 410): every row init-inlet-owner.sql changed or moved, as it was. Readable by no app role; revert-inlet-owner.sql restores from it.';
COMMENT ON TABLE public.inlet_private_sources IS
  'rw-inlet-owner (slot 410): the email-body and podcast-transcript sources, private to inlet_owner_sub. Read through inlet_private_source(id, sub).';

-- ── the owner, for the services that act for them (gmail prune: deletes by owner) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.inlet_owner_default()
RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT owner_sub FROM public.inlet_owner WHERE singleton $$;
REVOKE ALL ON FUNCTION public.inlet_owner_default() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inlet_owner_default() TO service_role;

-- the owner's read of a moved source (the workbench's GET /workbench/sources/:id falls back to it): a row only when the
-- subject asking is the source's owner
CREATE OR REPLACE FUNCTION public.inlet_private_source(p_id UUID, p_sub TEXT)
RETURNS TABLE (id UUID, url TEXT, title TEXT, content TEXT, content_type TEXT, notebook TEXT, metadata JSONB,
               created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.id, s.url, s.title, s.content, s.content_type, s.notebook, s.metadata, s.created_at, s.updated_at
      FROM public.inlet_private_sources s
     WHERE s.id = p_id AND coalesce(btrim(p_sub), '') <> '' AND s.inlet_owner_sub = p_sub
$$;
REVOKE ALL ON FUNCTION public.inlet_private_source(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inlet_private_source(UUID, TEXT) TO service_role;

-- ── what a page that presents private data is (the move and the guard) ─────────────────────────────────────────────
-- A page links a PRIVATE thought (one with an owner) - content/thought/<id>, thought/<id>, [[...]], (...), a links[]
-- entry, the slug - anywhere in the slug, title, body or links, the id ending there (380's form); or links a moved
-- source (source/<uuid>); or it is a withheld page's own text coming back (the reconcile repairing a row from its old
-- vault file). The move withholds more (a thought that is no longer in the shared corpus, an entity page by its
-- evidence: below); the guard holds the line on these three.
CREATE OR REPLACE FUNCTION public.inlet_owner_page_private(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
               SELECT 1 FROM regexp_matches(
                   coalesce(p_slug, '') || ' ' || coalesce(p_title, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                   '(?:^|[^[:alnum:]])thought/([0-9]{1,18})(?![0-9])', 'g') AS m
                 JOIN public.thoughts t ON t.id = m[1]::bigint
                WHERE t.user_id IS NOT NULL)
        OR EXISTS (
               SELECT 1 FROM regexp_matches(
                   coalesce(p_slug, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                   'source/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
                 JOIN public.inlet_private_sources s ON s.id = lower(m[1])::uuid)
        OR EXISTS (
               SELECT 1 FROM public.inlet_owner_archive a
                WHERE a.action = 'w' AND a.restored_at IS NULL AND a.ref = p_slug AND a.ref_hash = md5(coalesce(p_body, '')));
$$;
REVOKE ALL ON FUNCTION public.inlet_owner_page_private(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

-- the guard: a compiled or reconciled page is skipped silently (RETURN NULL: one row must not fail the batch; the wiki
-- writer learns it was withheld and leaves its file out); a NOTE is a person's own writing, refused out loud
CREATE OR REPLACE FUNCTION public.trg_inlet_owner_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.inlet_owner_page_private(NEW.slug, NEW.title, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page links private personal data, which is its owner''s alone' USING ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_inlet_owner_wiki_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_inlet_owner_wiki_guard ON public.wiki_pages;
CREATE TRIGGER trg_inlet_owner_wiki_guard BEFORE INSERT OR UPDATE OF slug, title, body, links ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_inlet_owner_wiki_guard();

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
    n_rebuild INT := 0; n_left BIGINT;
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
    -- the jobs that carry a moved source, a private claim or a Gmail URL
    CREATE TEMP TABLE _io_jobs ON COMMIT DROP AS
    SELECT j.id FROM public.research_jobs j
     WHERE (j.options -> 'seed_sources')::text ~* 'mail\.google\.com'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.options -> 'seed_sources') = 'array' THEN j.options -> 'seed_sources' ELSE '[]' END) e
                    WHERE e ->> 'url' IN (SELECT url FROM _io_src WHERE url IS NOT NULL))
        OR j.result::text ~* 'mail\.google\.com'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'cited_sources') = 'array' THEN j.result -> 'cited_sources' ELSE '[]' END) e
                    WHERE e ->> 'url' IN (SELECT url FROM _io_src WHERE url IS NOT NULL))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]' END) e
                    WHERE e ->> 'id' IN (SELECT id::text FROM _io_claims));
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
       AND NOT EXISTS (SELECT 1 FROM _io_meta_src) AND NOT EXISTS (SELECT 1 FROM _io_meta_chunks) AND NOT EXISTS (SELECT 1 FROM _io_meta_claims)
       AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug ~ '^content/thought/[0-9]+$'
                         AND NOT EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id::text = substr(w.slug, 17) AND t.user_id IS NULL))
       AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE public.inlet_owner_page_private(w.slug, w.title, w.body, w.links)) THEN
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

    -- 4 (before the sources go: the jobs are matched by their urls). the jobs: archive (options, result), then strip
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, row_data)
    SELECT v_batch, 'public.research_jobs', 'options,result', 'j', jsonb_build_object('id', j.id, 'options', j.options, 'result', j.result)
      FROM public.research_jobs j JOIN _io_jobs x ON x.id = j.id;
    SELECT coalesce(sum(jsonb_array_length(j.options -> 'seed_sources')), 0) INTO n_seeds
      FROM public.research_jobs j JOIN _io_jobs x ON x.id = j.id WHERE jsonb_typeof(j.options -> 'seed_sources') = 'array';
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.research_jobs j
       SET options = CASE WHEN jsonb_typeof(j.options -> 'seed_sources') = 'array'
                          THEN jsonb_set(j.options, '{seed_sources}', coalesce((
                                 SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(j.options -> 'seed_sources') WITH ORDINALITY AS z(e, o)
                                  WHERE NOT (e::text ~* 'mail\.google\.com' OR coalesce(e ->> 'url', '') IN (SELECT url FROM _io_src WHERE url IS NOT NULL))), '[]'::jsonb))
                          ELSE j.options END,
           result = CASE WHEN j.result IS NULL THEN NULL ELSE regexp_replace((
                      CASE WHEN jsonb_typeof(j.result) <> 'object' THEN j.result ELSE
                        j.result
                        || CASE WHEN jsonb_typeof(j.result -> 'cited_sources') = 'array' THEN jsonb_build_object('cited_sources', coalesce((
                               SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(j.result -> 'cited_sources') WITH ORDINALITY AS z(e, o)
                                WHERE NOT (coalesce(e ->> 'url', '') ~* 'mail\.google\.com' OR coalesce(e ->> 'url', '') IN (SELECT url FROM _io_src WHERE url IS NOT NULL))), '[]'::jsonb))
                               ELSE '{}'::jsonb END
                        || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN jsonb_build_object('reuse_claims', coalesce((
                               SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(j.result -> 'reuse_claims') WITH ORDINALITY AS z(e, o)
                                WHERE NOT coalesce(e ->> 'id', '') IN (SELECT id::text FROM _io_claims)), '[]'::jsonb))
                               ELSE '{}'::jsonb END
                      END)::text, c_mail, 'private-email', 'gi')::jsonb END
      FROM _io_jobs x WHERE x.id = j.id;
    GET DIAGNOSTICS n_jobs = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);
    SELECT n_seeds - coalesce(sum(jsonb_array_length(j.options -> 'seed_sources')), 0) INTO n_seeds
      FROM public.research_jobs j JOIN _io_jobs x ON x.id = j.id WHERE jsonb_typeof(j.options -> 'seed_sources') = 'array';

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
       OR EXISTS (SELECT 1 FROM public.research_jobs j WHERE (j.options -> 'seed_sources')::text ~* 'mail\.google\.com' OR j.result::text ~* 'mail\.google\.com') THEN
        RAISE EXCEPTION 'inlet owner: refused, nothing changed - a Gmail id or URL is still in a shared row after the strip' USING ERRCODE = '55000';
    END IF;

    -- 6. the wiki. Withheld: a thought leaf whose thought is not in the shared corpus (private now, or gone); any page
    --    the guard's predicate matches (links a private thought or a moved source); an entity page whose evidence holds
    --    a private thought or a moved source. Archived first (with md5(body), so the same text cannot come back).
    CREATE TEMP TABLE _io_pages ON COMMIT DROP AS
    SELECT w.slug FROM public.wiki_pages w
     WHERE (w.slug ~ '^content/thought/[0-9]{1,18}$'
            AND NOT EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id = substr(w.slug, 17)::bigint AND t.user_id IS NULL))
        OR public.inlet_owner_page_private(w.slug, w.title, w.body, w.links)
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
    RAISE NOTICE 'inlet owner: % job(s) stripped (% private seed(s)); % shared source(s) lost a Gmail id or URL; % wiki page(s) withheld (move their vault files out: the deploy step); % entit(ies) bumped, % with shared evidence to rebuild from',
        n_jobs, n_seeds, n_meta, n_pages, n_ents, n_rebuild;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
