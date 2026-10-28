-- ============================================================
-- Research workbench P2b - the workspace's storage (rw-p2b-workspace).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P2b, 01-OPEN-ITEMS.md D1 / D12 / D13 / D17 items 5-6, the ingestion model
--   (held sources, 2026-09-25 19:59-20:13), D18 (expansion by registration).
--
-- What this file adds, and only this (P0's user_document_listings, held_sources and refinery
-- tables, and P2a's reference records, are used as they are):
--   1. Registries: progress_indicators (the title bar's bell: compiling, ingesting, held - each
--      declares which jobs(state) kind and states it counts); job_kinds gains `compile` (pages
--      marked pending-compile) and `held` (held user sources waiting for a fold), so jobs(state)
--      can answer them; refinery_member_kinds gains `user_source` (the same file added again in
--      ANOTHER refinery is deduped onto the one held source, and that refinery lists it as a
--      member); node_kinds gains `report`.
--   2. Notification acknowledgement (D13 item 7, the bell): notification_acks, one row per
--      (owner, notification) - read state is the user's own and survives a reload.
--   2b. Owners (operator 2026-10-28): user_document_listings.owner_sub; every P2b table of user
--      front-end state carries owner_sub (indexed); the knowledge tables carry none.
--   3. Refinery archive (D17 archive, 19:07): refinery_state.archived_at / archived_from. The
--      idea's status moves to the idea_states key `archived` and back to archived_from when the
--      refinery is reopened from its document; nothing is deleted.
--   4. Pick-up (D17 item 6): refinery_picked_links - the links the refinery picked up from its
--      document. Written only by the documents API while the refinery is not archived, so a link
--      added while archived is not picked up until the refinery is reopened. A row carries the
--      reference record the document placed (its pin); a refinery-only link has none.
--   5. Held-source revisions (replace, 20:09-20:13): every revision a held source has had,
--      snapshotted by trigger, so a document that pinned v1 keeps a v1 to point at after
--      another document's replace or re-add produced v2.
--
-- The grounding chain (sources -> claims -> reports) is untouched. User document bodies are
-- never stored in any table (D12): the listing record keeps title, path, updated and links.
-- Conventions mirror init-references.sql: idempotent, additive, RLS on with a service_role FOR
-- ALL policy. Mounted in compose as 270-init-documents.sql (after P4a's 260 slot). Fresh-volume
-- only; the live DB gets it by hand (psql -f, the operator's gated deploy).
-- Revert: revert-documents.sql.
-- ============================================================

-- ── 1. registries ───────────────────────────────────────────────────────
INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('progress_indicators', 'P2b', 'the title bar bell''s progress indicators: definition.job_kind (+ states) names the jobs(state) rows each counts')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('job_kinds', 'compile', 'pages waiting for a compile', '{"table":"page_compile_marks","meaning":"a page marked pending-compile (D13)"}'),
    ('job_kinds', 'held',    'held user sources',            '{"table":"refinery_user_sources","meaning":"a user source held in its refinery until folded"}'),
    ('job_states', 'pending', 'pending', '{"applies_to":["compile"]}'),
    ('job_states', 'held',    'held',    '{"applies_to":["held"]}'),
    ('progress_indicators', 'compiling', 'compiling', '{"job_kind":"compile","states":["pending"],"order":1}'),
    ('progress_indicators', 'ingesting', 'ingesting', '{"job_kind":"import","states":["queued","extracting","embedding","linking"],"order":2}'),
    ('progress_indicators', 'held',      'held',      '{"job_kind":"held","states":["held"],"order":3}'),
    ('refinery_member_kinds', 'user_source', 'a user source another refinery holds (deduped re-add)', '{}'),
    ('node_kinds', 'report', 'research report', '{}')
ON CONFLICT (registry, key) DO NOTHING;

-- ── 2. notification acknowledgement, PER USER ─────────────────────────────
-- The events themselves (research_notifications, P0) are produced by the research side and carry no
-- owner; what a user has read is front-end state, so it is one row per (owner, notification).
-- A repeat of an acknowledged event (post_research_notification moves last_seen) is unread again:
-- unread = no ack row, or last_seen after the ack.
CREATE TABLE IF NOT EXISTS public.notification_acks (
    owner_sub       TEXT NOT NULL,                 -- the identity seam's subject (rw-p2b-workspace)
    actor_sub       TEXT NOT NULL,                 -- who acted (the subject, until impersonation lands)
    notification_id UUID NOT NULL REFERENCES public.research_notifications(id) ON DELETE CASCADE,
    acked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_sub, notification_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_acks_owner ON public.notification_acks (owner_sub);

-- ── 2b. the owner of user front-end state ───────────────────────────────
-- Operator 2026-10-28: the knowledge database (what research produces) is shared by every user; the
-- front-end context (user documents, layouts, notifications read state, ...) is isolated per user.
-- The workbench's identity seam (src/middleware/identity.ts) is the only reader of who the user is;
-- it writes owner_sub and every read of user state filters by it. Rows written before P2b belong to
-- the seam's default identity (WORKSPACE_DEFAULT_SUB, operator-set; the back-fill below).
-- owner_sub holds the SUBJECT: the Authentik subject id whose data a row is (operator 2026-10-28: the
-- same id Open WebUI stores for its SSO users, so one person is one owner across OWUI and the research
-- front end) - an OPAQUE string, no format assumed. actor_sub holds who ACTED (equal to the subject
-- until admin impersonation lands with its append-only audit log, rw-identity). Per user: user
-- documents, ideas (refineries), the bell's read state, refinery pick-ups, the original text a user
-- typed to start research. Shared (no owner): everything research produces - sources (a user-added
-- one too: `held` is a quality gate, not privacy), chunks, claims, references, reports, wiki pages.
-- The back-fill subject (operator 2026-10-28: every existing private context row belongs to ONE user
-- today) is the OPERATOR-SET WORKSPACE_DEFAULT_SUB - that user's Authentik subject, read from Open
-- WebUI's user record - handed to this file as the session setting workspace.default_sub:
--     PGOPTIONS='-c workspace.default_sub=<the WORKSPACE_DEFAULT_SUB value>' psql ... -f init-documents.sql
-- The value is never written into code or docs. Unset (a fresh database, the lab), the seam's shipped
-- placeholder 'operator'. It is also the column DEFAULT, so a row a writer outside the seam inserts
-- (the MCP idea tools, until sign-on lands) belongs to the same subject; a re-run WITH the setting
-- re-owns rows still on the placeholder (never a real Authentik subject).
DO $$
DECLARE
  sub TEXT := COALESCE(NULLIF(btrim(current_setting('workspace.default_sub', true)), ''), 'operator');
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_document_listings', 'ideas'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS owner_sub TEXT NOT NULL DEFAULT %L', t, sub);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN owner_sub SET DEFAULT %L', t, sub);
    IF sub <> 'operator' THEN
      EXECUTE format('UPDATE public.%I SET owner_sub = %L WHERE owner_sub = %L', t, sub, 'operator');
    END IF;
  END LOOP;
  IF sub = 'operator' AND EXISTS (SELECT 1 FROM public.ideas) THEN
    RAISE NOTICE 'init-documents: workspace.default_sub is not set - existing rows are owned by the placeholder ''operator''; re-run with WORKSPACE_DEFAULT_SUB as workspace.default_sub';
  END IF;
END $$;
ALTER TABLE public.user_document_listings ADD COLUMN IF NOT EXISTS actor_sub TEXT;
CREATE INDEX IF NOT EXISTS idx_user_document_listings_owner ON public.user_document_listings (owner_sub, updated_at DESC);
ALTER TABLE public.ideas ADD COLUMN IF NOT EXISTS actor_sub TEXT;
CREATE INDEX IF NOT EXISTS idx_ideas_owner ON public.ideas (owner_sub, updated_at DESC);

-- The original text a user typed to start research from the workspace: the user's own (operator
-- 2026-10-28). The research job row keeps running on it (research rewrites it; what it produces is
-- shared); the contract's session/jobs reads show it only to its owner.
CREATE TABLE IF NOT EXISTS public.research_prompts (
    job_id     UUID PRIMARY KEY REFERENCES public.research_jobs(id) ON DELETE CASCADE,
    owner_sub  TEXT NOT NULL,
    actor_sub  TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_prompts_owner ON public.research_prompts (owner_sub, created_at DESC);

-- ── 3. refinery archive ─────────────────────────────────────────────────
ALTER TABLE public.refinery_state ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ;
ALTER TABLE public.refinery_state ADD COLUMN IF NOT EXISTS archived_from TEXT;   -- registry idea_states

-- ── 4. pick-up ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refinery_picked_links (
    refinery_id  UUID NOT NULL REFERENCES public.ideas(id) ON DELETE CASCADE,
    node_kind    TEXT NOT NULL,                 -- registry node_kinds
    node_ref     TEXT NOT NULL,
    -- the reference record the DOCUMENT placed for this link (its pin); NULL for a link with no pin
    reference_id UUID REFERENCES public.reference_records(id) ON DELETE SET NULL,
    -- the pin as picked up, for a link whose pin is not (or no longer) a record of this database's
    -- P2a era (listings written before P2a carried the pin inline); a record's pin wins
    pin          INT CHECK (pin IS NULL OR pin >= 1),
    owner_sub    TEXT NOT NULL,                 -- the document's owner (front-end context, per user)
    actor_sub    TEXT NOT NULL,                 -- who acted
    picked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (refinery_id, node_kind, node_ref)
);
CREATE INDEX IF NOT EXISTS idx_refinery_picked_links_owner ON public.refinery_picked_links (owner_sub, refinery_id);

-- ── 5. held-source revisions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.held_source_revisions (
    held_source_id UUID NOT NULL REFERENCES public.held_sources(id) ON DELETE CASCADE,
    revision       INT  NOT NULL CHECK (revision >= 1),
    title          TEXT NOT NULL DEFAULT '',
    url            TEXT,
    content        TEXT NOT NULL DEFAULT '',
    content_hash   TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (held_source_id, revision)
);

CREATE OR REPLACE FUNCTION public.trg_held_sources_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.revision IS DISTINCT FROM OLD.revision THEN
        INSERT INTO public.held_source_revisions (held_source_id, revision, title, url, content, content_hash)
        VALUES (NEW.id, NEW.revision, NEW.title, NEW.url, NEW.content, NEW.content_hash)
        ON CONFLICT (held_source_id, revision) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_held_sources_snapshot ON public.held_sources;
CREATE TRIGGER trg_held_sources_snapshot
    AFTER INSERT OR UPDATE OF revision ON public.held_sources
    FOR EACH ROW EXECUTE FUNCTION public.trg_held_sources_snapshot();

-- Held sources added before this file have revision 1 and no snapshot: take it now.
INSERT INTO public.held_source_revisions (held_source_id, revision, title, url, content, content_hash)
SELECT h.id, h.revision, h.title, h.url, h.content, h.content_hash FROM public.held_sources h
ON CONFLICT (held_source_id, revision) DO NOTHING;

-- ── RLS + grants (the P0 shape) ─────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['refinery_picked_links', 'held_source_revisions', 'notification_acks', 'research_prompts'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
