-- ============================================================
-- Research workbench P0 - the retrieval contract's storage (rw-p0-contract).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P0, 01-OPEN-ITEMS.md D5 / D12 / D13 / D17 / D18, 06-EXPANSION.md.
--
-- What this file adds, and only this:
--   1. REGISTRIES (D18, expansion by registration): every enumerated kind the contract
--      exposes is a row in contract_registry_entries, declared and versioned. The contract
--      schemas carry these values as plain strings annotated x-registry; nothing switches on
--      a closed list. content_types keeps its own table (P5) and gains a version column.
--   2. Source lifecycle (D5): additive columns on sources (suppression reason/context,
--      unlinked_at); a committed retraction IS the suppressed state, so every consumer that
--      already filters retraction_committed_at excludes it. source_dependence() lists the
--      connections; trail events; page compile marks (pending-compile); named tombstones with
--      every reopen attempt; a BEFORE INSERT gate on sources that refuses a tombstoned URL at
--      every door unless the tombstone is lifted or readmitted.
--   3. Scoring exclusion (D5 stage 1): claim_min_depth / claim_confidence /
--      recompute_claim_confidence are REDEFINED here (superseding init-claims.sql, the same
--      precedent init-source-retract.sql set for match_sources) so an edge to a suppressed
--      source lends no grounding, corroboration, authority or contradiction. The edge itself
--      stays (grounding chain unchanged); severing it is the D5 stage-2 tool.
--   4. Held sources (ingestion model 2026-09-25): user-provided sources live in held_sources
--      until folded, so no database-wide consumer of `sources` can see them; refinery user
--      source list, hidden set, origin and members (D17 item 6).
--   5. User document listing records (D12): title, path, updated, outbound links - never a
--      body column.
--   6. Notifications (D13 item 7): research_notifications + post_research_notification(),
--      the producer API; ideas post an event on capture and on dossier delivery (D17 item 5).
--   7. Origin binding (D17 item 1): research_jobs.origin moves from a CHECK list to the
--      origins registry; caller / origin_claimed / inlet_ref / refinery_id columns; an idea's
--      research job gets the idea id as its inlet reference when the refinery stamps it.
--   8. The configuration store (D6 item 5): contract_settings, defaults declared in the
--      settings registry (the podcast archive default is a NAMED MOUNT, never a path).
--
-- Conventions mirror init-claims.sql / init-ideas.sql: idempotent, additive, RLS on with a
-- service_role FOR ALL policy, no DROP TABLE / TRUNCATE / unqualified DELETE. Mounted in
-- compose as 230-init-research-contract.sql (after intake's 220 slot). Fresh-volume only;
-- the live DB gets it by hand (psql -f, the operator's gated deploy).
-- Revert: revert-research-contract.sql.
-- ============================================================

-- ── 0. helpers ──────────────────────────────────────────────────────────
-- The URL form tombstones are matched on: trimmed, lower-cased scheme+host, no fragment, no
-- trailing slash. Deliberately conservative - two spellings of one page that differ in path
-- case or query order are two URLs here.
CREATE OR REPLACE FUNCTION public.contract_url_norm(p_url TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_url IS NULL OR btrim(p_url) = '' THEN NULL
        ELSE regexp_replace(
               regexp_replace(
                 regexp_replace(btrim(p_url), '#.*$', ''),
                 '^([A-Za-z][A-Za-z0-9+.-]*://[^/?#]*)', lower('\1')),
               '/+$', '')
    END;
$$;
-- regexp_replace cannot lower-case a back-reference, so the scheme+host is lowered in a
-- second pass. Kept as two functions so the IMMUTABLE contract is obvious.
CREATE OR REPLACE FUNCTION public.contract_url_key(p_url TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
    v TEXT := public.contract_url_norm(p_url);
    m TEXT[];
BEGIN
    IF v IS NULL THEN RETURN NULL; END IF;
    m := regexp_match(v, '^([A-Za-z][A-Za-z0-9+.-]*://[^/?#]*)(.*)$');
    IF m IS NULL THEN RETURN v; END IF;
    RETURN lower(m[1]) || m[2];
END;
$$;

-- ── 1. registries (D18) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_registries (
    name        TEXT PRIMARY KEY,
    version     INT  NOT NULL DEFAULT 1,
    owner       TEXT NOT NULL,                 -- the phase/area that owns the registry
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_registry_entries (
    registry      TEXT NOT NULL REFERENCES public.contract_registries(name),
    key           TEXT NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]*$'),
    version       INT  NOT NULL DEFAULT 1,     -- bumped by trigger on any change below
    label         TEXT NOT NULL DEFAULT '',
    definition    JSONB NOT NULL DEFAULT '{}'::jsonb,
    retired_at    TIMESTAMPTZ,                 -- a retired entry stays readable, never reused
    superseded_by TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (registry, key)
);

CREATE OR REPLACE FUNCTION public.contract_registry_entries_bump()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.label, NEW.definition, NEW.retired_at, NEW.superseded_by)
       IS DISTINCT FROM (OLD.label, OLD.definition, OLD.retired_at, OLD.superseded_by) THEN
        NEW.version := OLD.version + 1;
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contract_registry_entries_bump ON public.contract_registry_entries;
CREATE TRIGGER trg_contract_registry_entries_bump
    BEFORE UPDATE ON public.contract_registry_entries
    FOR EACH ROW EXECUTE FUNCTION public.contract_registry_entries_bump();

-- content_types (P5) is already a registry table; it gains the entry version.
ALTER TABLE public.content_types ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('record_states',          'P0',  'state every contract record carries (the API owns states)'),
    ('source_states',          'P0',  'D5 lifecycle plus held: held, active, suppressed, unlinked, erased'),
    ('page_classes',           'P1a', 'wiki_pages.page_class values; one compile rule + one renderer template each'),
    ('notification_classes',   'P0',  'D13 failure classes plus informational events'),
    ('source_families',        'P3a', 'D15 item 10: which signals score a source'),
    ('origins',                'P0',  'D17: where an engagement came from, bound to the caller key'),
    ('learning_record_fidelities', '06-EXPANSION', 'learning-record.schema.json v1 fidelities'),
    ('content_types',          'P5a', 'mirror of public.content_types (its own table since P5)'),
    ('erasure_reasons',        'P0',  'D5 item 6: the tombstone reason type is the reopen path'),
    ('erasers',                'P0',  'D5 item 7: who erased is the gate'),
    ('dependence_kinds',       'P0',  'D5 stage 2: what connects a source to the system'),
    ('claim_edge_types',       'P0',  'claim_sources.edge_type (grounding chain, unchanged)'),
    ('user_source_statuses',   'P0',  'status of a source in a refinery user source list'),
    ('admission_paths',        'P0',  'D5 item 6: the doors a URL can come back through'),
    ('admission_outcomes',     'P0',  'what the admission gate decided'),
    ('job_kinds',              'P0',  'jobs(state): the queues the intake panel shows'),
    ('job_states',             'P0',  'job status values across import and research queues'),
    ('node_kinds',             'P0',  'kinds of node in neighbours / search / context graph'),
    ('graph_link_kinds',       'P0',  'kinds of edge in a refinery context graph'),
    ('refinery_origins',       'P0',  'D17 item 6: a refinery starts from an idea or a document carrying one'),
    ('refinery_member_kinds',  'P0',  'D17 item 6: what a refinery collects'),
    ('idea_states',            'P0',  'ideas.status FSM (init-ideas.sql), mirrored for the contract'),
    ('credibility_terms',      'P3a', 'versioned credibility terms; user_provided is refinery-scoped only'),
    ('trail_event_kinds',      'P0',  'D5: suppression, severance, erasure and reopen events'),
    ('timeline_event_kinds',   'P0',  'timeline(scope, range) event kinds'),
    ('settings',               'P0',  'the configuration store keys and their declared defaults'),
    ('implementation_states',  'P0',  'not_implemented responses: which phase lands the backing')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    -- record states (panel-library appendix + D5 + D13 + ingestion model)
    ('record_states', 'current',         'current',         '{"applies_to":["page","reference","claim","session","idea"]}'),
    ('record_states', 'updated',         'updated',         '{"applies_to":["reference"],"meaning":"a newer revision than the one asked for exists"}'),
    ('record_states', 'loading',         'loading',         '{"applies_to":["session"],"carries":"action"}'),
    ('record_states', 'unreachable',     'unreachable',     '{"applies_to":["session","stream"],"carries":"last_known"}'),
    ('record_states', 'pending_compile', 'pending compile', '{"applies_to":["page"],"decision":"D13"}'),
    ('record_states', 'redaction',       'redaction',       '{"applies_to":["source"],"meaning":"staged retract in progress","carries":"reason"}'),
    ('record_states', 'external',        'held elsewhere',  '{"applies_to":["idea"],"meaning":"the record lives in another system; link given"}'),
    ('record_states', 'held',            'held',            '{"applies_to":["source"],"decision":"ingestion model 2026-09-25"}'),
    ('record_states', 'active',          'active',          '{"applies_to":["source"],"decision":"D5"}'),
    ('record_states', 'suppressed',      'suppressed',      '{"applies_to":["source"],"decision":"D5 stage 1","carries":"reason, context"}'),
    ('record_states', 'unlinked',        'unlinked',        '{"applies_to":["source"],"decision":"D5 stage 2"}'),
    ('record_states', 'erased',          'erased',          '{"applies_to":["source"],"decision":"D5 stage 4","carries":"tombstone"}'),
    ('record_states', 'omitted',         'omitted',         '{"applies_to":["source","chunk"],"meaning":"filtered for an evidence-only caller"}'),
    -- source lifecycle (D5 + held)
    ('source_states', 'held',       'held (pending)', '{"order":0,"database_wide":false}'),
    ('source_states', 'active',     'active',         '{"order":1,"database_wide":true}'),
    ('source_states', 'suppressed', 'suppressed',     '{"order":2,"database_wide":false}'),
    ('source_states', 'unlinked',   'unlinked',       '{"order":3,"database_wide":false}'),
    ('source_states', 'erased',     'erased',         '{"order":4,"database_wide":false}'),
    -- page classes (written by recipes/_shared/wiki-pages.mjs and workbench notes.ts)
    ('page_classes', 'entity',   'entity page',   '{"slug_prefix":"content/<type>/"}'),
    ('page_classes', 'source',   'source leaf',   '{"slug_prefix":"content/source/"}'),
    ('page_classes', 'thought',  'thought leaf',  '{"slug_prefix":"content/thought/"}'),
    ('page_classes', 'notebook', 'notebook hub',  '{"slug_prefix":"content/notebook/"}'),
    ('page_classes', 'note',     'legacy note',   '{"slug_prefix":"notes/","term":"legacy Quartz note class, never a user document (D12)"}'),
    ('page_classes', 'root',     'root page',     '{}'),
    -- notification classes (D13 item 6 + D17 item 5)
    ('notification_classes', 'transient',     'transient',     '{"retries":3,"meaning":"the LLM did not perform"}'),
    ('notification_classes', 'structural',    'structural',    '{"retries":0,"meaning":"not the LLM; loud on first occurrence"}'),
    ('notification_classes', 'informational', 'informational', '{"retries":0,"meaning":"an event for the research front end (new idea, dossier delivered)"}'),
    -- source families (D15 item 10)
    ('source_families', 'scholarly', 'scholarly', '{"signals":["cited_by","author_works_count","age"]}'),
    ('source_families', 'general',   'general',   '{"signals":["author_identity","domain_class","link_structure","semantic_agreement"]}'),
    -- origins (D17 item 1). agent is the pre-P0 value, retired in favour of mattermost.
    ('origins', 'workspace',  'research front end', '{"inlet_ref":"none"}'),
    ('origins', 'owui',       'Open WebUI',         '{"inlet_ref":"chat_id"}'),
    ('origins', 'mattermost', 'Mattermost / agent-org', '{"inlet_ref":"thread_permalink or idea_id"}'),
    ('origins', 'notebook',   'notebook digest/podcast lane', '{"inlet_ref":"notebook_run_id"}'),
    ('origins', 'manual',     'manual',             '{"inlet_ref":"none"}'),
    -- learning-record fidelities (06-EXPANSION §3.3)
    ('learning_record_fidelities', 'iterative',   'iterative (a lesson)',            '{"producer":"harness at merge","schema":"learning-record.schema.json v1"}'),
    ('learning_record_fidelities', 'exploratory', 'exploratory (a research delta)', '{"producer":"job tree (P4a)","schema":"learning-record.schema.json v1"}'),
    -- erasure reasons (D5 item 6): definition.reopen_path names the deterministic path
    ('erasure_reasons', 'debunked',    'debunked',    '{"reopen_path":"rescore_contest"}'),
    ('erasure_reasons', 'credibility', 'credibility', '{"reopen_path":"bar_check"}'),
    ('erasure_reasons', 'deliberate',  'deliberate',  '{"reopen_path":"note_only"}'),
    -- erasers (D5 item 7): definition.gate is the decision key
    ('erasers', 'automation', 'automation', '{"gate":"auto","requires":"run_id"}'),
    ('erasers', 'user',       'user',       '{"gate":"candidate","requires":"user"}'),
    -- dependence kinds (D5 stage 2 + D12 record consideration 2)
    ('dependence_kinds', 'claim_edge',      'claims (by edge type)', '{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'chunk',           'chunks',                '{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'citing_page',     'citing pages',          '{"blocks_erase":true,"severable":true,"sever":"marks the page pending-compile"}'),
    ('dependence_kinds', 'entity_grounding','entity groundings',     '{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'report_session',  'reports (session pool)','{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'report_citation', 'reports (cited)',       '{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'found_via_lead',  'found_via leads',       '{"blocks_erase":true,"severable":true}'),
    ('dependence_kinds', 'document_link',   'user documents linking it', '{"blocks_erase":true,"severable":false,"resolve":"by the user, in the document (D12)"}'),
    ('dependence_kinds', 'trail_event',     'trail events',          '{"blocks_erase":false,"severable":false,"resolve":"carried to the tombstone"}'),
    -- claim edge types (init-claims.sql CHECK, mirrored)
    ('claim_edge_types', 'states',        'states',        '{}'),
    ('claim_edge_types', 'inferred_from', 'inferred from', '{}'),
    ('claim_edge_types', 'corroborates',  'corroborates',  '{}'),
    ('claim_edge_types', 'contradicts',   'contradicts',   '{}'),
    -- refinery user source list statuses
    ('user_source_statuses', 'held',      'held',      '{}'),
    ('user_source_statuses', 'active',    'active',    '{}'),
    ('user_source_statuses', 'lead-only', 'lead only', '{}'),
    -- admission
    ('admission_paths', 'intake',    'intake',    '{}'),
    ('admission_paths', 'watch',     'watch',     '{}'),
    ('admission_paths', 'found_via', 'found_via lead', '{}'),
    ('admission_paths', 'query',     'query hit', '{}'),
    ('admission_outcomes', 'not_tombstoned',      'no tombstone',         '{"admits":"not this gate''s decision"}'),
    ('admission_outcomes', 'lifted',              'tombstone lifted',     '{"admits":true}'),
    ('admission_outcomes', 'refused',             'refused',              '{"admits":false}'),
    ('admission_outcomes', 'candidate',           'candidate for the operator', '{"admits":false}'),
    ('admission_outcomes', 'note_appended',       'reopen note appended', '{"admits":false}'),
    ('admission_outcomes', 'admitted',            'admitted',             '{"admits":true}'),
    ('admission_outcomes', 'admitted_contesting', 'admitted as contesting', '{"admits":true}'),
    -- jobs
    ('job_kinds', 'import',   'import / grounding', '{"table":"import_jobs"}'),
    ('job_kinds', 'research', 'research session',   '{"table":"research_jobs"}'),
    ('job_states', 'queued',     'queued',     '{}'),
    ('job_states', 'extracting', 'extracting', '{}'),
    ('job_states', 'embedding',  'embedding',  '{}'),
    ('job_states', 'linking',    'linking',    '{}'),
    ('job_states', 'running',    'running',    '{}'),
    ('job_states', 'done',       'done',       '{}'),
    ('job_states', 'failed',     'failed',     '{}'),
    ('job_states', 'error',      'error',      '{}'),
    ('job_states', 'cancelled',  'cancelled',  '{}'),
    -- node kinds
    ('node_kinds', 'page',     'wiki page', '{}'),
    ('node_kinds', 'source',   'source',    '{}'),
    ('node_kinds', 'claim',    'claim',     '{}'),
    ('node_kinds', 'document', 'user document (listing only, never a page)', '{}'),
    ('graph_link_kinds', 'grounds',       'claim grounded by a source', '{}'),
    ('graph_link_kinds', 'document_link', 'picked up from the refinery''s document', '{"pin":"mirrors the document"}'),
    -- refinery
    ('refinery_origins', 'captured_idea', 'a captured idea', '{}'),
    ('refinery_origins', 'document',      'a user document carrying an idea', '{}'),
    ('refinery_member_kinds', 'session',  'research session', '{}'),
    ('refinery_member_kinds', 'document', 'its one user document', '{"max":1}'),
    ('refinery_member_kinds', 'podcast',  'podcast', '{}'),
    ('refinery_member_kinds', 'export',   'export',  '{}'),
    ('refinery_member_kinds', 'room',     'the room', '{"max":1}'),
    -- idea FSM (init-ideas.sql CHECK, mirrored)
    ('idea_states', 'new',        'new',        '{}'),
    ('idea_states', 'queued',     'queued',     '{}'),
    ('idea_states', 'researched', 'researched', '{}'),
    ('idea_states', 'engaged',    'engaged',    '{}'),
    ('idea_states', 'dirty',      'dirty',      '{}'),
    ('idea_states', 'dormant',    'dormant',    '{}'),
    ('idea_states', 'promoted',   'promoted',   '{}'),
    ('idea_states', 'archived',   'archived',   '{}'),
    -- credibility terms (ingestion model item 4): zero for admission, by declaration
    ('credibility_terms', 'user_provided', 'user provided', '{"term_version":1,"refinery_weight":0.15,"admission_weight":0}'),
    -- trail events
    ('trail_event_kinds', 'suppressed',     'suppressed',     '{}'),
    ('trail_event_kinds', 'unlinked',       'unlinked',       '{}'),
    ('trail_event_kinds', 'severed',        'connection severed', '{}'),
    ('trail_event_kinds', 'erased',         'erased',         '{}'),
    ('trail_event_kinds', 'reopen_attempt', 'reopen attempt', '{}'),
    ('trail_event_kinds', 'lifted',         'tombstone lifted', '{}'),
    ('trail_event_kinds', 'readmitted',     'readmitted',     '{}'),
    -- the pre-contract restore door returning a suppressed/unlinked source to active (attempt 2, F2)
    ('trail_event_kinds', 'restored',       'restored to active', '{}'),
    -- timeline
    ('timeline_event_kinds', 'source_revision', 'source revision committed', '{}'),
    ('timeline_event_kinds', 'session_started', 'research session started', '{}'),
    ('timeline_event_kinds', 'session_finished','research session finished', '{}'),
    ('timeline_event_kinds', 'claim_created',   'claim created', '{}'),
    ('timeline_event_kinds', 'trail',           'trail event',   '{}'),
    -- settings (D6 item 5): the archive default is a NAMED MOUNT, resolved by the reader
    ('settings', 'podcast.archive_destination', 'podcast archive destination',
        '{"type":"destination","default":{"mount":"podcast-archive"},"read_by":"P7a writer, every render","edited_by":"P7b settings view"}'),
    -- not_implemented: which phase lands each stubbed call
    ('implementation_states', 'watches',    'watches()',          '{"lands_in":"P5b"}'),
    ('implementation_states', 'proposals',  'proposals(watchId)', '{"lands_in":"P5b"}'),
    ('implementation_states', 'stance_map', 'stanceMap(id)',      '{"lands_in":"P7b"}'),
    ('implementation_states', 'podcasts',   'podcasts(scope)',    '{"lands_in":"P7a/P7b"}'),
    ('implementation_states', 'presenters', 'presenters()',       '{"lands_in":"P7a"}'),
    ('implementation_states', 'teams',      'teams()',            '{"lands_in":"P7a"}'),
    ('implementation_states', 'steer',      'steer(sessionId,...)', '{"lands_in":"P4a"}')
ON CONFLICT (registry, key) DO NOTHING;

-- agent: the origin every pre-P0 agent-org / Idea Refinery job carries. Retired, kept readable.
INSERT INTO public.contract_registry_entries (registry, key, label, definition, retired_at, superseded_by)
VALUES ('origins', 'agent', 'agent (pre-P0)', '{"inlet_ref":"none"}', now(), 'mattermost')
ON CONFLICT (registry, key) DO NOTHING;

-- One read path for every registry, content_types included.
CREATE OR REPLACE VIEW public.contract_registry_view AS
    SELECT e.registry, e.key, e.version, e.label, e.definition, e.retired_at, e.superseded_by
      FROM public.contract_registry_entries e
    UNION ALL
    SELECT 'content_types', ct.value, ct.version, COALESCE(ct.label, ct.value),
           jsonb_build_object('category', ct.category), NULL::timestamptz, NULL::text
      FROM public.content_types ct;

CREATE OR REPLACE FUNCTION public.contract_registry_has(p_registry TEXT, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (SELECT 1 FROM public.contract_registry_view v
                    WHERE v.registry = p_registry AND v.key = p_key);
$$;

-- ── 2. source lifecycle (D5) ────────────────────────────────────────────
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS suppression_reason  TEXT;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS suppression_context JSONB;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS unlinked_at         TIMESTAMPTZ;

-- The single derivation of a stored source's lifecycle state. A committed retraction is the
-- suppressed state (D5: "today's committed retract becomes this state"); unlinked is a
-- suppressed source whose blocking dependence reached zero. held and erased sources are not
-- rows of `sources` (held_sources / source_tombstones), so they never reach this function.
CREATE OR REPLACE FUNCTION public.source_lifecycle_state(
    p_retraction_committed_at TIMESTAMPTZ,
    p_unlinked_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_retraction_committed_at IS NULL THEN 'active'
        WHEN p_unlinked_at IS NOT NULL THEN 'unlinked'
        ELSE 'suppressed'
    END;
$$;

CREATE TABLE IF NOT EXISTS public.source_trail_events (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    source_id    UUID NOT NULL,        -- no FK: the event outlives the row (resolves to the tombstone)
    tombstone_id UUID,                 -- set when the source is erased
    kind         TEXT NOT NULL,        -- registry trail_event_kinds
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_trail_events_source ON public.source_trail_events (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_trail_events_tomb   ON public.source_trail_events (tombstone_id);

-- pending-compile (D13): a page whose mark is newer than its row is not presented as current.
-- page_ref is a wiki_pages slug, or 'entity:<id>' for an entity page whose slug the database
-- does not hold. Nothing is deleted: a later compile makes the mark stale by updating the row.
CREATE TABLE IF NOT EXISTS public.page_compile_marks (
    page_ref   TEXT NOT NULL,
    source_id  UUID NOT NULL,
    reason     TEXT NOT NULL,
    marked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (page_ref, source_id)
);
CREATE INDEX IF NOT EXISTS idx_page_compile_marks_ref ON public.page_compile_marks (page_ref);

CREATE TABLE IF NOT EXISTS public.source_tombstones (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id            UUID NOT NULL UNIQUE,   -- the erased row's id (trail, pages resolve to it)
    url                  TEXT NOT NULL,          -- original link; urn:openbrain:source:<id> when it had none
    url_key              TEXT NOT NULL,
    title                TEXT NOT NULL DEFAULT '',
    reason_type          TEXT NOT NULL,          -- registry erasure_reasons (required on every path)
    note                 TEXT,                   -- optional on manual erasure, absent on the bulk run
    batch_run_id         TEXT,
    eraser_kind          TEXT NOT NULL,          -- registry erasers
    eraser_run_id        TEXT,
    eraser_user          TEXT,
    confidence           REAL,                   -- at removal (D5 item 6, credibility path)
    score_version        TEXT,
    fingerprint          TEXT,                   -- sha256 of the content at removal
    original_context     JSONB NOT NULL DEFAULT '{}'::jsonb,
    erased_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    lifted_at            TIMESTAMPTZ,
    lifted_by            TEXT,
    lift_note            TEXT,
    readmitted_source_id UUID,
    readmitted_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_source_tombstones_url_key ON public.source_tombstones (url_key);

CREATE TABLE IF NOT EXISTS public.source_tombstone_attempts (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    tombstone_id UUID NOT NULL REFERENCES public.source_tombstones(id) ON DELETE CASCADE,
    path         TEXT NOT NULL,          -- registry admission_paths
    outcome      TEXT NOT NULL,          -- registry admission_outcomes
    session_id   TEXT,
    note         TEXT,
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_tombstone_attempts_t ON public.source_tombstone_attempts (tombstone_id, attempted_at);

CREATE TABLE IF NOT EXISTS public.source_disputes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
    tombstone_id UUID NOT NULL REFERENCES public.source_tombstones(id),
    kind         TEXT NOT NULL DEFAULT 'debunked_readmission',
    criticism    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The tombstone that refuses this URL, or nothing. Lifted and readmitted tombstones no longer
-- refuse (the readmitted source is then the URL's row; dedup finds it first).
CREATE OR REPLACE FUNCTION public.contract_tombstone_for(p_url TEXT)
RETURNS SETOF public.source_tombstones
LANGUAGE sql STABLE
AS $$
    SELECT t.* FROM public.source_tombstones t
     WHERE t.url_key = public.contract_url_key(p_url)
       AND t.lifted_at IS NULL
       AND t.readmitted_source_id IS NULL
     ORDER BY t.erased_at DESC
     LIMIT 1;
$$;

-- THE GATE AT EVERY DOOR (D5 item 4: "an erased source cannot walk back in through another
-- door"). A tombstoned URL is refused whichever code path inserts it. The admission call that
-- readmits a URL sets openbrain.admission_tombstone to that tombstone's id for its own
-- transaction (SET LOCAL), which is the only way past. SQLSTATE OBT01 + the tombstone id in
-- the message, so a door can name the tombstone in its refusal.
CREATE OR REPLACE FUNCTION public.trg_sources_tombstone_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    t public.source_tombstones;
BEGIN
    IF NEW.url IS NULL OR btrim(NEW.url) = '' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND public.contract_url_key(NEW.url) IS NOT DISTINCT FROM public.contract_url_key(OLD.url) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO t FROM public.contract_tombstone_for(NEW.url);
    IF t.id IS NULL THEN RETURN NEW; END IF;
    IF COALESCE(current_setting('openbrain.admission_tombstone', true), '') = t.id::text THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tombstoned url refused: tombstone=% reason=% url=%', t.id, t.reason_type, t.url
        USING ERRCODE = 'OBT01',
              HINT = 'lift the tombstone, or readmit through the admission call (D5 items 6-7)';
END;
$$;

-- A door that meets a tombstoned URL as a QUERY HIT (a research run's search results) records
-- the attempt here and drops the hit. The reason type picks the outcome without a score: the
-- deliberate path only appends the reopen note; debunked / credibility need the D15
-- pre-ingestion score (P3a), so until it exists they are refused. Returns the tombstone id, or
-- NULL when the URL is not tombstoned (the hit is the caller's to use).
CREATE OR REPLACE FUNCTION public.contract_record_query_hit(p_url TEXT, p_session TEXT, p_note TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    t public.source_tombstones;
    v_path TEXT;
BEGIN
    SELECT * INTO t FROM public.contract_tombstone_for(p_url);
    IF t.id IS NULL THEN RETURN NULL; END IF;
    SELECT e.definition ->> 'reopen_path' INTO v_path
      FROM public.contract_registry_entries e
     WHERE e.registry = 'erasure_reasons' AND e.key = t.reason_type;
    INSERT INTO public.source_tombstone_attempts (tombstone_id, path, outcome, session_id, note)
    VALUES (t.id, 'query', CASE WHEN v_path = 'note_only' THEN 'note_appended' ELSE 'refused' END, p_session, p_note);
    INSERT INTO public.source_trail_events (source_id, tombstone_id, kind, detail)
    VALUES (t.source_id, t.id, 'reopen_attempt', jsonb_build_object('path', 'query', 'session_id', p_session));
    RETURN t.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_sources_tombstone_gate ON public.sources;
CREATE TRIGGER trg_sources_tombstone_gate
    BEFORE INSERT OR UPDATE OF url ON public.sources
    FOR EACH ROW EXECUTE FUNCTION public.trg_sources_tombstone_gate();

-- ── 3. scoring exclusion (D5 stage 1) - supersedes init-claims.sql ─────
-- Bodies identical to init-claims.sql except that a SOURCE edge counts only when its source
-- is not suppressed (retraction_committed_at IS NULL). Parent-claim edges are unchanged.
CREATE OR REPLACE FUNCTION public.claim_edge_counts(p_claim_id UUID)
RETURNS TABLE (edge_id BIGINT, edge_type TEXT, source_id UUID, parent_claim_id UUID)
LANGUAGE sql STABLE
AS $$
    SELECT cs.id, cs.edge_type, cs.source_id, cs.parent_claim_id
      FROM public.claim_sources cs
      LEFT JOIN public.sources s ON s.id = cs.source_id
     WHERE cs.claim_id = p_claim_id
       AND (cs.source_id IS NULL OR s.retraction_committed_at IS NULL);
$$;

CREATE OR REPLACE FUNCTION public.claim_min_depth(p_claim_id UUID)
RETURNS INT
LANGUAGE sql STABLE
AS $$
    WITH RECURSIVE walk(claim_id, depth) AS (
        SELECT p_claim_id, 0
        UNION ALL
        SELECT cs.parent_claim_id, w.depth + 1
        FROM walk w
        JOIN public.claim_sources cs ON cs.claim_id = w.claim_id
        WHERE cs.parent_claim_id IS NOT NULL
          AND cs.edge_type <> 'contradicts'
          AND w.depth < 8
    )
    SELECT MIN(w.depth)
    FROM walk w
    WHERE EXISTS (
        SELECT 1 FROM public.claim_sources cs
        JOIN public.sources s ON s.id = cs.source_id
        WHERE cs.claim_id = w.claim_id
          AND cs.source_id IS NOT NULL
          AND cs.edge_type <> 'contradicts'
          AND s.retraction_committed_at IS NULL      -- D5 stage 1 (rw-p0-contract)
    );
$$;

CREATE OR REPLACE FUNCTION public.claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_depth        INT;
    v_base         REAL := 0.0;
    v_corroborators INT := 0;
    v_authority    REAL := 0.85;
    v_has_strong   BOOLEAN := FALSE;
    v_has_inferred BOOLEAN := FALSE;
    v_contradicted BOOLEAN := FALSE;
    v_stale        BOOLEAN := FALSE;
    v_score        REAL;
BEGIN
    v_depth := public.claim_min_depth(p_claim_id);
    IF v_depth IS NULL THEN
        RETURN 0.0;  -- ungrounded → not knowledge (rule #1)
    END IF;

    SELECT
        bool_or(e.edge_type IN ('states','corroborates')),
        bool_or(e.edge_type = 'inferred_from'),
        bool_or(e.edge_type = 'contradicts')
      INTO v_has_strong, v_has_inferred, v_contradicted
    FROM public.claim_edge_counts(p_claim_id) e;

    IF v_has_strong THEN v_base := 0.90;
    ELSIF v_has_inferred THEN v_base := 0.60;
    ELSE v_base := 0.0; END IF;

    SELECT GREATEST(COUNT(DISTINCT e.source_id) - 1, 0) INTO v_corroborators
    FROM public.claim_edge_counts(p_claim_id) e
    WHERE e.source_id IS NOT NULL
      AND e.edge_type IN ('states','corroborates');

    SELECT MAX(CASE
                 WHEN s.domain ~* '\.(gov|edu|mil)(:|/|$)'
                   OR s.url ~* '://[^/]*\.(gov|edu|mil)(:|/|$)'
                   OR (s.metadata ->> 'authority') = 'primary'
                 THEN 1.0 ELSE 0.85 END)
      INTO v_authority
    FROM public.claim_sources cs
    JOIN public.sources s ON s.id = cs.source_id
    WHERE cs.claim_id = p_claim_id
      AND cs.source_id IS NOT NULL
      AND cs.edge_type <> 'contradicts'
      AND s.retraction_committed_at IS NULL;         -- D5 stage 1 (rw-p0-contract)
    v_authority := COALESCE(v_authority, 0.85);

    SELECT (researched_on + COALESCE(revalidate_days,
              CASE volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180
                              WHEN 'slow' THEN 1095 ELSE 180 END) < CURRENT_DATE)
      INTO v_stale
    FROM public.claims WHERE id = p_claim_id;

    v_score := (v_base + LEAST(0.03 * v_corroborators, 0.10))
               * v_authority
               * power(0.85, v_depth);
    IF COALESCE(v_stale, FALSE) THEN v_score := v_score * 0.5; END IF;
    IF v_contradicted THEN v_score := LEAST(v_score, 0.30); END IF;

    RETURN GREATEST(LEAST(v_score, 1.0), 0.0);
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql
AS $$
DECLARE v_conf REAL; v_contra BOOLEAN;
BEGIN
    v_conf := public.claim_confidence(p_claim_id);
    SELECT bool_or(e.edge_type = 'contradicts') INTO v_contra
    FROM public.claim_edge_counts(p_claim_id) e;
    UPDATE public.claims
       SET confidence = v_conf,
           contradicted = COALESCE(v_contra, FALSE)
     WHERE id = p_claim_id;
    RETURN v_conf;
END;
$$;

-- Re-score every claim with an edge to one source (suppress, restore, sever all call this).
CREATE OR REPLACE FUNCTION public.recompute_claims_for_source(p_source_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE r RECORD; n INT := 0;
BEGIN
    FOR r IN SELECT DISTINCT claim_id FROM public.claim_sources WHERE source_id = p_source_id LOOP
        PERFORM public.recompute_claim_confidence(r.claim_id);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$;

-- ── 4. held sources + the idea refinery (D17 item 6, ingestion model) ───
CREATE TABLE IF NOT EXISTS public.held_sources (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refinery_id  UUID NOT NULL REFERENCES public.ideas(id) ON DELETE RESTRICT,
    url          TEXT,
    title        TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'manual' REFERENCES public.content_types(value),
    revision     INT  NOT NULL DEFAULT 1,     -- always 1 while held, until replaced
    content_hash TEXT,
    embedding    VECTOR(1024),
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    added_by     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_held_sources_refinery ON public.held_sources (refinery_id);

CREATE TABLE IF NOT EXISTS public.held_source_chunks (
    held_source_id UUID NOT NULL REFERENCES public.held_sources(id) ON DELETE CASCADE,
    idx            INT  NOT NULL,
    content        TEXT NOT NULL DEFAULT '',
    embedding      VECTOR(1024),
    PRIMARY KEY (held_source_id, idx)
);

-- The user source list: every user-added source belongs to exactly ONE pre-existing refinery.
-- source_id is a held_sources id while held and the same uuid in `sources` once folded.
CREATE TABLE IF NOT EXISTS public.refinery_user_sources (
    refinery_id UUID NOT NULL REFERENCES public.ideas(id) ON DELETE RESTRICT,
    source_id   UUID NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'held',   -- registry user_source_statuses
    added_by    TEXT,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (refinery_id, source_id)
);

-- Hidden is a view setting stored on the refinery only (D17 item 6); it never touches a node.
CREATE TABLE IF NOT EXISTS public.refinery_hidden (
    refinery_id UUID NOT NULL REFERENCES public.ideas(id) ON DELETE CASCADE,
    node_kind   TEXT NOT NULL,                 -- registry node_kinds
    node_ref    TEXT NOT NULL,
    hidden_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (refinery_id, node_kind, node_ref)
);

CREATE TABLE IF NOT EXISTS public.refinery_state (
    refinery_id        UUID PRIMARY KEY REFERENCES public.ideas(id) ON DELETE CASCADE,
    origin_kind        TEXT NOT NULL DEFAULT 'captured_idea',   -- registry refinery_origins
    origin_document_id UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Podcasts, exports and the room (sessions and the document have their own homes).
CREATE TABLE IF NOT EXISTS public.refinery_members (
    refinery_id UUID NOT NULL REFERENCES public.ideas(id) ON DELETE CASCADE,
    member_kind TEXT NOT NULL,                 -- registry refinery_member_kinds
    member_ref  TEXT NOT NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (refinery_id, member_kind, member_ref)
);

-- ── 5. user document listing records (D12) - NEVER a body ──────────────
-- refinery_id UNIQUE: one document per refinery, and the listing record carries its refinery.
CREATE TABLE IF NOT EXISTS public.user_document_listings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path           TEXT NOT NULL UNIQUE,
    title          TEXT NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    refinery_id    UUID UNIQUE REFERENCES public.ideas(id) ON DELETE SET NULL,
    -- [{"kind": <node_kinds>, "id": "<uuid or slug>", "pin": <revision or null>}]
    outbound_links JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(outbound_links) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_user_document_listings_links
    ON public.user_document_listings USING gin (outbound_links jsonb_path_ops);

-- ── 6. dependence (D5 stage 2) ──────────────────────────────────────────
-- Every connection of one source, listed. Counts are the caller's GROUP BY; which kinds block
-- erasure is declared in the dependence_kinds registry, not here.
CREATE OR REPLACE FUNCTION public.source_dependence(p_source_id UUID)
RETURNS TABLE (kind TEXT, ref TEXT, detail JSONB)
LANGUAGE sql STABLE
AS $$
    SELECT 'claim_edge', cs.id::text,
           jsonb_build_object('claim_id', cs.claim_id, 'edge_type', cs.edge_type, 'claim_text', left(c.text, 200))
      FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
     WHERE cs.source_id = p_source_id
    UNION ALL
    SELECT 'chunk', sc.idx::text, jsonb_build_object('idx', sc.idx)
      FROM public.source_chunks sc WHERE sc.source_id = p_source_id
    UNION ALL
    SELECT 'citing_page', wp.slug, jsonb_build_object('slug', wp.slug, 'page_class', wp.page_class,
               'pending_compile', EXISTS (SELECT 1 FROM public.page_compile_marks m
                                          WHERE m.page_ref = wp.slug AND m.source_id = p_source_id
                                            AND m.marked_at >= wp.updated_at))
      FROM public.wiki_pages wp
     WHERE wp.links @> to_jsonb('content/source/' || p_source_id::text)
       AND wp.slug <> 'content/source/' || p_source_id::text
       AND NOT EXISTS (SELECT 1 FROM public.page_compile_marks m
                        WHERE m.page_ref = wp.slug AND m.source_id = p_source_id
                          AND m.marked_at >= wp.updated_at)
    UNION ALL
    SELECT 'entity_grounding', se.entity_id::text, jsonb_build_object('entity_id', se.entity_id, 'mention_role', se.mention_role)
      FROM public.source_entities se WHERE se.source_id = p_source_id
    UNION ALL
    SELECT 'report_session', ss.session_id::text, jsonb_build_object('session_id', ss.session_id)
      FROM public.session_sources ss WHERE ss.source_id = p_source_id
    UNION ALL
    SELECT 'report_citation', syn.id::text, jsonb_build_object('synthesis_id', syn.id, 'title', syn.title)
      FROM public.sources syn
     WHERE syn.content_type = 'research_synthesis'
       AND syn.metadata ? 'source_ids'
       AND jsonb_typeof(syn.metadata -> 'source_ids') = 'array'
       AND (syn.metadata -> 'source_ids') @> to_jsonb(p_source_id::text)
    UNION ALL
    SELECT 'found_via_lead', s.id::text, jsonb_build_object('source_id', s.id, 'title', s.title)
      FROM public.sources s WHERE s.metadata ->> 'found_via' = p_source_id::text
    UNION ALL
    SELECT 'document_link', d.path, jsonb_build_object('path', d.path, 'title', d.title)
      FROM public.user_document_listings d
     WHERE d.outbound_links @> jsonb_build_array(jsonb_build_object('id', p_source_id::text))
    UNION ALL
    SELECT 'trail_event', te.id::text, jsonb_build_object('kind', te.kind, 'at', te.created_at)
      FROM public.source_trail_events te WHERE te.source_id = p_source_id;
$$;

-- The blocking count, read through the registry declaration.
CREATE OR REPLACE FUNCTION public.source_blocking_dependence(p_source_id UUID)
RETURNS INT
LANGUAGE sql STABLE
AS $$
    SELECT count(*)::int
      FROM public.source_dependence(p_source_id) d
      JOIN public.contract_registry_entries k
        ON k.registry = 'dependence_kinds' AND k.key = d.kind
     WHERE COALESCE((k.definition ->> 'blocks_erase')::boolean, true);
$$;

-- ── 7. notifications (D13 item 7) - read by the research front end ONLY ─
CREATE TABLE IF NOT EXISTS public.research_notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class       TEXT NOT NULL,           -- registry notification_classes
    subject     TEXT NOT NULL,
    slug        TEXT,
    entity      TEXT,
    origin      TEXT,                    -- registry origins, when an engagement raised it
    error       TEXT,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    count       INT NOT NULL DEFAULT 1,
    dedup_key   TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_research_notifications_last ON public.research_notifications (last_seen DESC);

-- The producer API. A repeat of the same (class, subject, slug, entity) increments count and
-- moves last_seen; first_seen and the first error are kept. Refuses an unregistered class.
CREATE OR REPLACE FUNCTION public.post_research_notification(
    p_class   TEXT,
    p_subject TEXT,
    p_slug    TEXT DEFAULT NULL,
    p_entity  TEXT DEFAULT NULL,
    p_origin  TEXT DEFAULT NULL,
    p_error   TEXT DEFAULT NULL
)
RETURNS public.research_notifications
LANGUAGE plpgsql
AS $$
DECLARE
    v_row public.research_notifications;
    v_key TEXT := md5(concat_ws(chr(31), p_class, p_subject, COALESCE(p_slug, ''), COALESCE(p_entity, '')));
BEGIN
    IF NOT public.contract_registry_has('notification_classes', p_class) THEN
        RAISE EXCEPTION 'unregistered notification class %', p_class;
    END IF;
    IF p_origin IS NOT NULL AND NOT public.contract_registry_has('origins', p_origin) THEN
        RAISE EXCEPTION 'unregistered origin %', p_origin;
    END IF;
    IF COALESCE(btrim(p_subject), '') = '' THEN
        RAISE EXCEPTION 'notification subject required';
    END IF;
    INSERT INTO public.research_notifications (class, subject, slug, entity, origin, error, dedup_key)
    VALUES (p_class, p_subject, p_slug, p_entity, p_origin, p_error, v_key)
    ON CONFLICT (dedup_key) DO UPDATE
       SET count = public.research_notifications.count + 1,
           last_seen = now(),
           error = COALESCE(public.research_notifications.error, EXCLUDED.error)
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- D17 item 5: a new idea, and a dossier landing, post an event. Triggers, so the MCP idea
-- tools (the only writers of `ideas`) produce them without knowing this file exists.
CREATE OR REPLACE FUNCTION public.trg_ideas_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.post_research_notification('informational', 'a new idea has been added',
                                                  NULL, 'idea:' || NEW.id::text, NULL, NULL);
    ELSIF NEW.dossier_source_id IS NOT NULL
          AND NEW.dossier_source_id IS DISTINCT FROM OLD.dossier_source_id THEN
        PERFORM public.post_research_notification('informational', 'dossier delivered',
                                                  NULL, 'idea:' || NEW.id::text || ':dossier:' || NEW.dossier_source_id::text,
                                                  NULL, NULL);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ideas_notify ON public.ideas;
CREATE TRIGGER trg_ideas_notify
    AFTER INSERT OR UPDATE OF dossier_source_id ON public.ideas
    FOR EACH ROW EXECUTE FUNCTION public.trg_ideas_notify();

-- ── 8. origin binding (D17 item 1) ──────────────────────────────────────
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS caller         TEXT;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS origin_claimed TEXT;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS inlet_ref      JSONB;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS refinery_id    UUID REFERENCES public.ideas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_research_jobs_refinery ON public.research_jobs (refinery_id);

-- The closed CHECK list becomes the origins registry. A generated constant column lets a
-- plain FK reach the composite registry key; a new origin is one INSERT, no DDL.
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_origin_check;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS origin_registry TEXT
    GENERATED ALWAYS AS ('origins') STORED;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_jobs_origin_registry_fkey') THEN
        ALTER TABLE public.research_jobs
            ADD CONSTRAINT research_jobs_origin_registry_fkey
            FOREIGN KEY (origin_registry, origin)
            REFERENCES public.contract_registry_entries(registry, key);
    END IF;
END $$;

-- ideas.status: the closed CHECK list becomes the idea_states registry the same way (rw-p0-contract
-- attempt 2, tester F4) - a new idea state is one registry INSERT, no DDL. The seeded entries are
-- exactly the old CHECK list, so every existing row satisfies the FK.
ALTER TABLE public.ideas DROP CONSTRAINT IF EXISTS ideas_status_check;
ALTER TABLE public.ideas ADD COLUMN IF NOT EXISTS status_registry TEXT
    GENERATED ALWAYS AS ('idea_states') STORED;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ideas_status_registry_fkey') THEN
        ALTER TABLE public.ideas
            ADD CONSTRAINT ideas_status_registry_fkey
            FOREIGN KEY (status_registry, status)
            REFERENCES public.contract_registry_entries(registry, key);
    END IF;
END $$;

-- The Idea Refinery rides the agent key and sends no idea id; it stamps the job id onto the
-- idea revision right after submitting. That stamp is where the inlet reference comes from.
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_inlet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.research_job_id IS NOT NULL
       AND NEW.research_job_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND (TG_OP = 'INSERT' OR NEW.research_job_id IS DISTINCT FROM OLD.research_job_id) THEN
        UPDATE public.research_jobs j
           SET inlet_ref = COALESCE(NULLIF(j.inlet_ref, 'null'::jsonb), jsonb_build_object('kind', 'idea', 'id', NEW.idea_id::text)),
               refinery_id = COALESCE(j.refinery_id, NEW.idea_id)
         WHERE j.id = NEW.research_job_id::uuid;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_idea_revisions_inlet ON public.idea_revisions;
CREATE TRIGGER trg_idea_revisions_inlet
    AFTER INSERT OR UPDATE OF research_job_id ON public.idea_revisions
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_revisions_inlet();

-- ── 9. the configuration store (D6 item 5) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_settings (
    key        TEXT PRIMARY KEY,         -- registry settings
    value      JSONB NOT NULL,
    version    INT  NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
);

-- ── RLS + grants (mirror init-ideas.sql) ────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'contract_registries', 'contract_registry_entries', 'source_trail_events',
        'page_compile_marks', 'source_tombstones', 'source_tombstone_attempts', 'source_disputes',
        'held_sources', 'held_source_chunks', 'refinery_user_sources', 'refinery_hidden',
        'refinery_state', 'refinery_members', 'user_document_listings', 'research_notifications',
        'contract_settings'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;
GRANT SELECT ON public.contract_registry_view TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
