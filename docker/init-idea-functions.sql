-- ============================================================
-- The idea writes as owner-checked functions (research-workbench rw-p8a4-ideas, D17 items 5-6). Slot 370.
-- Operator decisions 2026-11-01: idea edit, research-now and promote are SQL functions that BOTH the
-- openbrain-mcp idea tools (update_idea / research_idea / promote_idea) and the workbench call, each with the
-- caller's owner subject (the identity seam's subject_sub in the workbench; WORKSPACE_DEFAULT_SUB in
-- openbrain-mcp). Another owner's idea answers exactly like an idea that does not exist ('not_found').
-- The refinery writes its dossier into the idea's room (idea_room(), slot 340) AND keeps posting to Mattermost.
--   * idea_edit(idea, owner, actor, summary, title, embedding, thought)   a new revision (the research trigger
--       queues it, slot 260/300); identical text is 'unchanged'; an archived idea is 'archived' (engagement
--       skips a resting refinery). The thought row, when there is one, is the DOOR's (openbrain-mcp writes
--       none any more): operator decision 2026-11-02 - "ideas are completely user isolated" - so a revision is
--       PRIVATE (idea_revisions.private_owner = the idea's owner, no corpus thought) and is read through its own
--       owner-established policy below, never through the shared thought corpus.
--   * idea_capture(owner, actor, title, summary, domain, embedding)  capture_idea's write: the idea and its private
--       revision 1, no corpus thought (the same reason).
--   * idea_research(idea, owner, actor)       research now, owner-checked, over idea_research_now() (slot 300).
--   * idea_promote(idea, owner, actor, path)  `create document` = PROMOTE: the idea moves to promoted with a
--       pointer to its ONE tethered user document (the listing's refinery_id + metadata.promoted).
--   * idea_deliver_dossier(idea, job, body, meta)  the refinery's delivery into the idea's ONE room: one
--       'dossier' entry per research job (idempotent - a retried pass adds nothing), the dossier source
--       recorded on the idea; an archived idea gets nothing ('archived') and no notification.
--   * idea_resurface(idea, max_dist, limit)   the dormant ideas OF THE SAME OWNER near this one (the refinery's
--       cross-link, IR §8); each is stamped metadata.resurfaced so the ideas panel can list it as resurfaced.
--   * refinery_engage(refinery, owner, kind, ref)  record a member engaged from inside a refinery (a podcast);
--       an archived refinery is 'archived' and records nothing.
--   * trg_ideas_write_guard: an UPDATE of ideas.title / summary / current_revision / owner_sub or of the promotion
--       pointer (metadata.promoted), a move to `promoted`, an INSERT promoted or carrying a pointer, a revision
--       after the first, or an UPDATE of a revision other than its research_job_id, is REFUSED unless it runs inside
--       one of these functions (their owner: the
--       migration's role). An app role (service_role, ob_app_memory) writing them directly fails - an edit that
--       bypasses the shared function, or a promotion the refinery performs on its own, cannot happen.
--   * trg_ideas_notify (replaced): no "dossier delivered" notification for an archived idea.
-- Additive and idempotent; no table is dropped. Fresh-volume slot 370; live: psql -f BEFORE the new workbench
-- and openbrain-mcp images and the refinery restart. Revert: revert-idea-functions.sql.
-- ============================================================

-- ── a private revision plane (operator decision 2026-11-02: ideas are completely user isolated) ──────────
-- Slot 200 shows an app role a revision only through its corpus thought (`thought_id IS NOT NULL AND
-- ob_thought_visible(...)`). An idea's text must not be in the shared thought corpus, so a revision written by the idea
-- functions carries NO thought and names its plane instead: private_owner = the idea's owner, written only by the
-- SECURITY DEFINER functions here (the guard below refuses an app role that sets or changes it). The read policy
-- requires that name AND that it is the idea's owner today: an orphaned corpus revision (its thought deleted, ON DELETE
-- SET NULL) has no private_owner and stays invisible, exactly as slot 200 decided; the all-NULL row is denied. It is
-- FOR SELECT only - it widens no write (INSERT / UPDATE keep slot 200's WITH CHECK). Owner scoping per user is the
-- workbench's (every read filters ideas.owner_sub = the seam's subject).
ALTER TABLE public.idea_revisions ADD COLUMN IF NOT EXISTS private_owner TEXT;
DROP POLICY IF EXISTS idea_revisions_owner_private ON public.idea_revisions;
CREATE POLICY idea_revisions_owner_private ON public.idea_revisions
  AS PERMISSIVE FOR SELECT TO service_role
  USING (private_owner IS NOT NULL AND thought_id IS NULL
         AND EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea_revisions.idea_id AND i.owner_sub = idea_revisions.private_owner));
COMMENT ON POLICY idea_revisions_owner_private ON public.idea_revisions IS
  'rw-p8a4-ideas (operator 2026-11-02, ideas are completely user isolated): a revision the idea functions wrote names '
  'its plane (private_owner = the idea''s owner) instead of a corpus thought. Not an absence arm: private_owner IS NOT NULL '
  'is required, an orphaned corpus revision has none, and the all-NULL row is denied. SELECT only.';

-- ── who may write the guarded columns: a function owned by the table's owner, or the owner itself ──
CREATE OR REPLACE FUNCTION public.ideas_door_open()
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.ideas'::regclass), 'MEMBER');
$$;

CREATE OR REPLACE FUNCTION public.trg_ideas_write_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.ideas_door_open() THEN RETURN NEW; END IF;
    -- round 2 (tester F2): the promotion and its pointer are idea_promote()'s alone, whatever the order of steps:
    -- an app role can neither INSERT an idea promoted (or carrying a pointer) nor write the pointer, so no sequence
    -- of its own statements can forge one and then "reopen" into promoted.
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'promoted' OR coalesce(NEW.metadata, '{}'::jsonb) ? 'promoted' THEN
            RAISE EXCEPTION 'ideas: an idea is promoted only through idea_promote()' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.current_revision IS DISTINCT FROM OLD.current_revision THEN
        RAISE EXCEPTION 'ideas: an idea is edited only through idea_edit()' USING ERRCODE = '42501';
    END IF;
    -- an idea moves between users only through the identity seam's own writers (never an app role's UPDATE)
    IF NEW.owner_sub IS DISTINCT FROM OLD.owner_sub THEN
        RAISE EXCEPTION 'ideas: an idea''s owner is not rewritten' USING ERRCODE = '42501';
    END IF;
    IF (coalesce(NEW.metadata, '{}'::jsonb) -> 'promoted') IS DISTINCT FROM (coalesce(OLD.metadata, '{}'::jsonb) -> 'promoted') THEN
        RAISE EXCEPTION 'ideas: the promotion pointer is written only by idea_promote()' USING ERRCODE = '42501';
    END IF;
    -- reopening an archived refinery may restore the promotion idea_promote() recorded, while its document is
    -- still the refinery's (the pointer is unforgeable above)
    IF NEW.status = 'promoted' AND OLD.status IS DISTINCT FROM 'promoted'
       AND NOT (coalesce(OLD.status = 'archived' AND coalesce(OLD.metadata, '{}'::jsonb) ? 'promoted', false)
                AND EXISTS (SELECT 1 FROM public.user_document_listings d
                             WHERE d.refinery_id = OLD.id AND d.owner_sub = OLD.owner_sub
                               AND d.path = OLD.metadata -> 'promoted' ->> 'document_path')) THEN
        RAISE EXCEPTION 'ideas: an idea is promoted only through idea_promote()' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ideas_write_guard ON public.ideas;
CREATE TRIGGER trg_ideas_write_guard BEFORE INSERT OR UPDATE ON public.ideas
    FOR EACH ROW EXECUTE FUNCTION public.trg_ideas_write_guard();

-- revision 1 is the capture's (capture_idea); every later revision is an edit
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_write_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.ideas_door_open() THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.revision > 1 THEN
            RAISE EXCEPTION 'idea_revisions: a revision after the first is written only by idea_edit()' USING ERRCODE = '42501';
        END IF;
        IF NEW.private_owner IS NOT NULL THEN
            RAISE EXCEPTION 'idea_revisions: a private revision is written only by idea_capture() / idea_edit()' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    -- review RV2: a revision is history - an app role rewrites nothing of it in place (summary, content_hash,
    -- thought_id, idea_id, revision, metadata, created_at); only research_job_id, the run that researched it, stays
    -- writable (research_idea_queue / idea_research_now stamp it)
    IF (to_jsonb(NEW) - 'research_job_id') IS DISTINCT FROM (to_jsonb(OLD) - 'research_job_id') THEN
        RAISE EXCEPTION 'idea_revisions: a revision is not rewritten (only its research_job_id is stamped)' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_idea_revisions_write_guard ON public.idea_revisions;
CREATE TRIGGER trg_idea_revisions_write_guard BEFORE INSERT OR UPDATE ON public.idea_revisions
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_revisions_write_guard();

-- ── edit ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idea_edit(
    p_idea UUID, p_owner TEXT, p_actor TEXT, p_summary TEXT, p_title TEXT DEFAULT NULL,
    p_embedding TEXT DEFAULT NULL, p_thought_id BIGINT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v RECORD; v_body TEXT := btrim(coalesce(p_summary, '')); v_title TEXT; v_rev INT; v_hash TEXT;
BEGIN
    IF v_body = '' THEN RAISE EXCEPTION 'idea text is required' USING ERRCODE = '22023'; END IF;
    IF coalesce(btrim(p_owner), '') = '' THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    SELECT i.id, i.title, i.status, i.current_revision,
           (SELECT r.content_hash FROM public.idea_revisions r WHERE r.idea_id = i.id AND r.revision = i.current_revision) AS hash
      INTO v FROM public.ideas i WHERE i.id = p_idea AND i.owner_sub = p_owner FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v.status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    v_title := left(coalesce(nullif(btrim(p_title), ''), v.title), 120);
    v_hash := md5(lower(v_body));
    IF v_hash = v.hash AND v_title = v.title THEN
        RETURN jsonb_build_object('outcome', 'unchanged', 'revision', v.current_revision, 'title', v.title);
    END IF;
    v_rev := v.current_revision + 1;
    -- no corpus thought = a private revision of its owner (both doors pass none: ideas are user isolated)
    INSERT INTO public.idea_revisions (idea_id, revision, summary, thought_id, content_hash, metadata, private_owner)
    VALUES (p_idea, v_rev, v_body, p_thought_id, v_hash, jsonb_build_object('edited_by', coalesce(p_actor, 'system:outside-seam')),
            CASE WHEN p_thought_id IS NULL THEN p_owner END);
    UPDATE public.ideas
       SET summary = v_body, title = v_title, current_revision = v_rev, status = 'dirty',
           embedding = coalesce(p_embedding::vector, embedding), actor_sub = coalesce(p_actor, actor_sub)
     WHERE id = p_idea;
    RETURN jsonb_build_object('outcome', 'changed', 'revision', v_rev, 'title', v_title);
END;
$$;

-- ── capture (capture_idea's write) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idea_capture(
    p_owner TEXT, p_actor TEXT, p_title TEXT, p_summary TEXT, p_domain TEXT DEFAULT NULL, p_embedding TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID; v_body TEXT := btrim(coalesce(p_summary, ''));
BEGIN
    IF v_body = '' THEN RAISE EXCEPTION 'idea text is required' USING ERRCODE = '22023'; END IF;
    IF coalesce(btrim(p_owner), '') = '' THEN RAISE EXCEPTION 'an idea has an owner' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.ideas (title, summary, domain, embedding, status, current_revision, owner_sub, actor_sub)
    VALUES (left(coalesce(nullif(btrim(p_title), ''), split_part(v_body, E'\n', 1)), 120), v_body, coalesce(p_domain, 'ai-stack'),
            p_embedding::vector, 'new', 1, p_owner, coalesce(p_actor, 'system:outside-seam'))
    RETURNING id INTO v_id;
    -- the private revision 1 (the capture trigger queues its research, slots 260 / 300)
    INSERT INTO public.idea_revisions (idea_id, revision, summary, content_hash, private_owner)
    VALUES (v_id, 1, v_body, md5(lower(v_body)), p_owner);
    RETURN v_id;
END;
$$;

-- ── research now ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idea_research(p_idea UUID, p_owner TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status TEXT; v_job UUID;
BEGIN
    SELECT status INTO v_status FROM public.ideas WHERE id = p_idea AND owner_sub = p_owner AND coalesce(btrim(p_owner), '') <> '';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v_status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    v_job := public.idea_research_now(p_idea);
    IF v_job IS NULL THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    RETURN jsonb_build_object('outcome', 'queued', 'job_id', v_job::text);
END;
$$;

-- ── promote (`create document`) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idea_promote(p_idea UUID, p_owner TEXT, p_actor TEXT, p_document_path TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT id, status, metadata INTO v FROM public.ideas
     WHERE id = p_idea AND owner_sub = p_owner AND coalesce(btrim(p_owner), '') <> '' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v.status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    -- the pointer: the refinery's ONE document, the caller's own, tethered to this idea
    IF NOT EXISTS (SELECT 1 FROM public.user_document_listings d
                    WHERE d.path = p_document_path AND d.refinery_id = p_idea AND d.owner_sub = p_owner) THEN
        RETURN jsonb_build_object('outcome', 'no_document');
    END IF;
    IF v.status = 'promoted' AND v.metadata -> 'promoted' ->> 'document_path' = p_document_path THEN
        RETURN jsonb_build_object('outcome', 'unchanged', 'document_path', p_document_path);
    END IF;
    UPDATE public.ideas
       SET status = 'promoted', actor_sub = coalesce(p_actor, actor_sub),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('promoted',
               jsonb_build_object('document_path', p_document_path, 'at', now()))
     WHERE id = p_idea;
    RETURN jsonb_build_object('outcome', 'promoted', 'document_path', p_document_path);
END;
$$;

-- ── the refinery's dossier, into the idea's one room ───────────────────
-- one dossier entry per research job: a retried delivery pass adds nothing
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_room_entries_dossier_job
    ON public.workspace_room_entries (room_id, (meta ->> 'job_id')) WHERE kind = 'dossier';

CREATE OR REPLACE FUNCTION public.idea_deliver_dossier(p_idea UUID, p_job TEXT, p_body TEXT, p_meta JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status TEXT; v_room UUID; v_entry UUID; v_src UUID;
BEGIN
    IF coalesce(btrim(p_job), '') = '' THEN RAISE EXCEPTION 'a dossier names its research job' USING ERRCODE = '22023'; END IF;
    SELECT status INTO v_status FROM public.ideas WHERE id = p_idea;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v_status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    v_room := public.idea_room(p_idea);
    IF v_room IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    INSERT INTO public.workspace_room_entries (room_id, actor_sub, kind, body, meta)
    VALUES (v_room, 'system:idea-refinery', 'dossier', left(coalesce(p_body, ''), 200000),
            coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('job_id', p_job))
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_entry;
    IF v_entry IS NULL THEN
        SELECT id INTO v_entry FROM public.workspace_room_entries
         WHERE room_id = v_room AND kind = 'dossier' AND meta ->> 'job_id' = p_job;
        RETURN jsonb_build_object('outcome', 'already', 'room_id', v_room, 'entry_id', v_entry);
    END IF;
    UPDATE public.workspace_rooms SET updated_at = now() WHERE id = v_room;
    -- the dossier source: the job's persisted synthesis (its session's research_synthesis source)
    SELECT s.id INTO v_src FROM public.research_jobs j
      JOIN public.session_sources ss ON ss.session_id = j.session_id
      JOIN public.sources s ON s.id = ss.source_id AND s.content_type = 'research_synthesis'
     WHERE j.id::text = p_job ORDER BY s.created_at DESC LIMIT 1;
    IF v_src IS NOT NULL THEN
        UPDATE public.ideas SET dossier_source_id = v_src WHERE id = p_idea AND dossier_source_id IS DISTINCT FROM v_src;
    END IF;
    RETURN jsonb_build_object('outcome', 'delivered', 'room_id', v_room, 'entry_id', v_entry, 'dossier_source_id', v_src);
END;
$$;

-- ── resurface (IR §8): only the same owner's parked ideas, never another user's ────
CREATE OR REPLACE FUNCTION public.idea_resurface(p_idea UUID, p_max_dist DOUBLE PRECISION, p_limit INT DEFAULT 2)
RETURNS TABLE (id UUID, title TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner TEXT; v_emb vector;
BEGIN
    SELECT i.owner_sub, i.embedding INTO v_owner, v_emb FROM public.ideas i WHERE i.id = p_idea;
    IF v_emb IS NULL OR coalesce(v_owner, '') = '' THEN RETURN; END IF;
    RETURN QUERY
    WITH near AS (
        SELECT d.id, d.title FROM public.ideas d
         WHERE d.status = 'dormant' AND d.id <> p_idea AND d.owner_sub = v_owner AND d.embedding IS NOT NULL
           AND d.embedding <=> v_emb <= p_max_dist
         ORDER BY d.embedding <=> v_emb LIMIT greatest(1, least(p_limit, 10))
    ), stamped AS (
        UPDATE public.ideas x SET metadata = coalesce(x.metadata, '{}'::jsonb)
               || jsonb_build_object('resurfaced', jsonb_build_object('at', now(), 'by', p_idea::text))
          FROM near WHERE x.id = near.id RETURNING x.id
    )
    SELECT near.id, near.title FROM near;
END;
$$;

-- ── a member engaged from inside a refinery ─────────────────────────────
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('refinery_member_kinds', 'podcast_request', 'a podcast requested from inside the refinery', '{}')
ON CONFLICT (registry, key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refinery_engage(p_refinery UUID, p_owner TEXT, p_kind TEXT, p_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM public.ideas WHERE id = p_refinery AND owner_sub = p_owner AND coalesce(btrim(p_owner), '') <> '';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v_status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    IF NOT public.contract_registry_has('refinery_member_kinds', p_kind) THEN
        RAISE EXCEPTION 'unregistered refinery member kind %', p_kind USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.refinery_members (refinery_id, member_kind, member_ref) VALUES (p_refinery, p_kind, p_ref)
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome', 'engaged');
END;
$$;

-- ── no notification lands while a refinery is archived ──────────────────
CREATE OR REPLACE FUNCTION public.trg_ideas_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.post_research_notification('informational', 'a new idea has been added',
                                                  NULL, 'idea:' || NEW.id::text, NULL, NULL);
    ELSIF NEW.dossier_source_id IS NOT NULL
          AND NEW.dossier_source_id IS DISTINCT FROM OLD.dossier_source_id
          AND NEW.status <> 'archived' THEN
        PERFORM public.post_research_notification('informational', 'dossier delivered',
                                                  NULL, 'idea:' || NEW.id::text || ':dossier:' || NEW.dossier_source_id::text,
                                                  NULL, NULL);
    END IF;
    RETURN NEW;
END;
$$;

-- ── the promotions made before this file: their pointer (the tethered document) ────────
-- (status untouched: the guard does not run for the migration's own role)
UPDATE public.ideas i
   SET metadata = coalesce(i.metadata, '{}'::jsonb) || jsonb_build_object('promoted',
       jsonb_build_object('document_path', d.path, 'at', i.updated_at, 'backfill', 'init-idea-functions'))
  FROM public.user_document_listings d
 WHERE d.refinery_id = i.id AND NOT (coalesce(i.metadata, '{}'::jsonb) ? 'promoted')
   AND (i.status = 'promoted'
        OR (i.status = 'archived' AND EXISTS (SELECT 1 FROM public.refinery_state rs
                                               WHERE rs.refinery_id = i.id AND rs.archived_from = 'promoted')));

-- ── grants (service_role only, like slots 300 / 340) ────────────────────
REVOKE ALL ON FUNCTION public.ideas_door_open() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_edit(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_capture(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_research(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_promote(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_deliver_dossier(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_resurface(UUID, DOUBLE PRECISION, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refinery_engage(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ideas_door_open() TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_edit(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_capture(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_research(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_promote(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_deliver_dossier(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_resurface(UUID, DOUBLE PRECISION, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refinery_engage(UUID, TEXT, TEXT, TEXT) TO service_role;
NOTIFY pgrst, 'reload schema';
