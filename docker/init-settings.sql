-- ============================================================
-- The settings store (research-workbench rw-settings-store, plan 08 PD3). Slot 400.
-- The workspace Settings panel is the one place a user changes their own settings and an admin the
-- shared ones. Later items only ADD KEYS (a row in settings_keys); nothing else changes.
--   * settings_keys: the registry. One row per key: its tier (user = per owner_sub; admin = shared,
--     changed by an admin only), its type, the code default and the env variable the reading service
--     falls back to, which service reads it and when, its validation, and whether it is editable here
--     (research tuning is listed read-only). A key of type `secret` - or a key named like a credential -
--     is REFUSED by the table itself: no secret is stored here until PD4/PD5 add an encrypted store.
--   * user_settings: the user tier, one row per (owner_sub, key), versioned. Written only through
--     user_setting_set() (the workbench's route) and judged by a trigger on every write, whoever writes.
--   * the ADMIN tier is the existing global store public.contract_settings (slot 230); this file adds
--     no table for it and does not change it. podcast.archive_destination (slot 230's settings registry)
--     is registered here as an admin key whose store is that contract store.
--   * setting_get(owner, key): THE read function every service uses. It returns the stored value (the
--     owner's for a user key, the shared one for an admin key) or NULL - and NULL means the service
--     keeps its env value / code default, so nothing changes until a value is stored.
--   * setting_problem(owner, key, value): the registry's validation (NULL = acceptable).
-- Additive and idempotent; no existing table, row or function is changed. Fresh-volume slot 400; live:
-- psql -f BEFORE the new workbench image. Revert: revert-settings.sql (discards every user's settings).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.settings_keys (
    key           TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    tier          TEXT NOT NULL CHECK (tier IN ('user', 'admin')),
    type          TEXT NOT NULL CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination')),
    section       TEXT NOT NULL CHECK (section IN ('refinery', 'digest', 'research')),
    position      INT  NOT NULL DEFAULT 0,
    label         TEXT NOT NULL,
    help          TEXT NOT NULL DEFAULT '',
    default_value JSONB,                  -- the code default (what the service uses with no env and no stored value)
    env_name      TEXT,                   -- the env variable the reading service falls back to (NULL = none)
    read_by       TEXT NOT NULL,          -- which service reads it, and when
    validation    JSONB NOT NULL DEFAULT '{}'::jsonb, -- min, max, max_len, enum, max_items, ref
    editable      BOOLEAN NOT NULL DEFAULT true,
    store         TEXT NOT NULL DEFAULT 'settings' CHECK (store IN ('settings', 'contract')),
    CONSTRAINT settings_keys_store_tier CHECK (store = 'settings' OR tier = 'admin'),
    CONSTRAINT settings_keys_no_secret_type CHECK (type <> 'secret')
);
-- no secrets (anchor): neither a secret type nor a key named like a credential, until PD4/PD5's encrypted store.
-- Round 2 (review A2): any `key` / `*_key` segment (api_key, access_key, private_key, ssh_key, cloud.key), apikey,
-- bearer, passphrase. Dropped and re-added so a re-run brings an existing table to this rule.
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_no_secret;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_no_secret CHECK (
    type <> 'secret'
    AND key !~* '(secret|token|passw(or)?d|passphrase|bearer|credential|apikey|(^|[._])key($|[._])|_key($|[._]))');

CREATE TABLE IF NOT EXISTS public.user_settings (
    owner_sub  TEXT NOT NULL CHECK (btrim(owner_sub) <> ''),
    key        TEXT NOT NULL REFERENCES public.settings_keys (key),
    value      JSONB NOT NULL,
    version    INT  NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT,
    PRIMARY KEY (owner_sub, key)
);

ALTER TABLE public.settings_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settings_keys_service_role_read ON public.settings_keys;
CREATE POLICY settings_keys_service_role_read ON public.settings_keys FOR SELECT TO service_role USING (true);
GRANT SELECT ON public.settings_keys TO service_role;   -- the registry is written by migrations only
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_settings_service_role_all ON public.user_settings;
CREATE POLICY user_settings_service_role_all ON public.user_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_settings TO service_role;

-- The registry's validation. NULL = acceptable; else the reason, in words a user can act on.
CREATE OR REPLACE FUNCTION public.setting_problem(p_owner TEXT, p_key TEXT, p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    k   public.settings_keys%ROWTYPE;
    t   TEXT := jsonb_typeof(p_value);
    v   JSONB;
    n   NUMERIC;
    s   TEXT;
    mx  INT;
BEGIN
    SELECT * INTO k FROM public.settings_keys WHERE key = p_key;
    IF NOT FOUND THEN RETURN format('%s is not a setting', p_key); END IF;
    v := k.validation;
    IF p_value IS NULL OR t = 'null' THEN RETURN 'a value is required (delete the setting to go back to the default)'; END IF;
    IF length(p_value::text) > 4096 THEN RETURN 'the value is too large'; END IF;
    CASE k.type
    WHEN 'boolean' THEN
        IF t <> 'boolean' THEN RETURN 'must be true or false'; END IF;
    WHEN 'integer', 'number' THEN
        IF t <> 'number' THEN RETURN 'must be a number'; END IF;
        n := (p_value #>> '{}')::numeric;
        IF k.type = 'integer' AND n <> trunc(n) THEN RETURN 'must be a whole number'; END IF;
        IF v ? 'min' AND n < (v->>'min')::numeric THEN RETURN format('must be at least %s', v->>'min'); END IF;
        IF v ? 'max' AND n > (v->>'max')::numeric THEN RETURN format('must be at most %s', v->>'max'); END IF;
    WHEN 'time' THEN
        IF t <> 'string' OR (p_value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN 'must be a time HH:MM (24-hour)'; END IF;
    WHEN 'enum' THEN
        IF t <> 'string' OR NOT (COALESCE(v->'enum', '[]'::jsonb) ? (p_value #>> '{}')) THEN
            RETURN format('must be one of %s', COALESCE(v->'enum', '[]'::jsonb)::text);
        END IF;
    WHEN 'string' THEN
        IF t <> 'string' THEN RETURN 'must be text'; END IF;
        s := p_value #>> '{}';
        mx := COALESCE((v->>'max_len')::int, 200);
        IF btrim(s) = '' THEN RETURN 'must not be empty (delete the setting to go back to the default)'; END IF;
        IF length(s) > mx THEN RETURN format('must be at most %s characters', mx); END IF;
        IF s ~ '[[:cntrl:]]' THEN RETURN 'must not hold control characters'; END IF;
        -- no secret is stored here (anchor): a value shaped like a credential is refused - anywhere in the text,
        -- not only at its start (round 2, review A3: a leading space no longer slips past)
        IF s ~ '(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)' OR s ~* '(^|[^a-z0-9])bearer\s' THEN
            RETURN 'this looks like a credential; secrets are not stored in settings';
        END IF;
        IF v->>'ref' = 'podcast_team' AND NOT EXISTS (
            SELECT 1 FROM public.podcast_teams pt WHERE pt.owner_sub = p_owner AND (pt.id = s OR pt.name = s)) THEN
            RETURN 'no podcast team of yours has this id or name';
        END IF;
    WHEN 'string_list' THEN
        IF t <> 'array' THEN RETURN 'must be a list of text'; END IF;
        IF jsonb_array_length(p_value) > COALESCE((v->>'max_items')::int, 20) THEN RETURN 'the list is too long'; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > COALESCE((v->>'max_len')::int, 200)) THEN
            RETURN 'every item must be text, and short';
        END IF;
    WHEN 'destination' THEN
        -- the contract store's own validation judges a destination (the workbench, contracts/repo/system.ts)
        IF t <> 'object' THEN RETURN 'must be an object'; END IF;
    ELSE
        RETURN format('%s has a type this store cannot hold', p_key);
    END CASE;
    RETURN NULL;
END;
$$;

-- THE read function (plan 08 PD3): the stored value, else NULL (the caller keeps its env / code default).
-- A user key reads the OWNER's row (an owner of NULL - a service that runs globally - reads nothing and
-- keeps its env value); an admin key reads the shared admin tier (public.contract_settings).
CREATE OR REPLACE FUNCTION public.setting_get(p_owner TEXT, p_key TEXT)
RETURNS JSONB
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE k.tier
             WHEN 'user'  THEN (SELECT u.value FROM public.user_settings u WHERE u.owner_sub = p_owner AND u.key = k.key)
             WHEN 'admin' THEN (SELECT c.value FROM public.contract_settings c WHERE c.key = k.key)
           END
      FROM public.settings_keys k WHERE k.key = p_key;
$$;

-- Every write of the user tier, whoever writes it (the workbench, PostgREST, psql as the app role):
-- a registered, editable USER key, and a value the registry accepts.
CREATE OR REPLACE FUNCTION public.trg_user_settings_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    k public.settings_keys%ROWTYPE;
    why TEXT;
BEGIN
    SELECT * INTO k FROM public.settings_keys WHERE key = NEW.key;
    IF NOT FOUND THEN RAISE EXCEPTION '% is not a setting', NEW.key USING ERRCODE = 'P0002'; END IF;
    IF k.tier <> 'user' THEN RAISE EXCEPTION '% is an admin setting, not a user setting', NEW.key USING ERRCODE = '42501'; END IF;
    IF NOT k.editable THEN RAISE EXCEPTION '% is read-only here', NEW.key USING ERRCODE = '42501'; END IF;
    why := public.setting_problem(NEW.owner_sub, NEW.key, NEW.value);
    IF why IS NOT NULL THEN RAISE EXCEPTION '%: %', NEW.key, why USING ERRCODE = '22023'; END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_user_settings_guard ON public.user_settings;
CREATE TRIGGER trg_user_settings_guard BEFORE INSERT OR UPDATE ON public.user_settings
    FOR EACH ROW EXECUTE FUNCTION public.trg_user_settings_guard();

-- Set one of an owner's user settings (the workbench's PUT). p_version, when given, must be the stored
-- version (0 = no row yet): a stale write is refused (40001) and changes nothing.
CREATE OR REPLACE FUNCTION public.user_setting_set(
    p_owner TEXT, p_key TEXT, p_value JSONB, p_actor TEXT, p_version INT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cur INT;
    out_version INT;
BEGIN
    SELECT version INTO cur FROM public.user_settings WHERE owner_sub = p_owner AND key = p_key FOR UPDATE;
    IF p_version IS NOT NULL AND COALESCE(cur, 0) <> p_version THEN
        RAISE EXCEPTION 'the setting changed since it was read (version %, not %)', COALESCE(cur, 0), p_version USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.user_settings (owner_sub, key, value, updated_by)
    VALUES (p_owner, p_key, p_value, p_actor)
    ON CONFLICT (owner_sub, key) DO UPDATE
       SET value = EXCLUDED.value, version = public.user_settings.version + 1,
           updated_at = now(), updated_by = EXCLUDED.updated_by
    RETURNING version INTO out_version;
    RETURN out_version;
END;
$$;

-- Round 2 (review G1): nothing for PUBLIC - setting_get and user_setting_set are SECURITY DEFINER, so EXECUTE for
-- PUBLIC would let ANY login (ob_pantry, anon, authenticated) read and write any owner's settings past RLS. As slots
-- 300 and 370: REVOKE from PUBLIC, then grant the app role (service_role; ob_app_memory reaches it as a member).
REVOKE ALL ON FUNCTION public.setting_problem(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.setting_get(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_setting_set(TEXT, TEXT, JSONB, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_user_settings_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.setting_problem(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.setting_get(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_setting_set(TEXT, TEXT, JSONB, TEXT, INT) TO service_role;

-- ── the first tranche of keys (plan 08 PD3; anchor rw-settings-store) ──────────────────────────
-- Re-running the file brings every definition back to what is written here.
INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store) VALUES
    -- My idea refinery (user tier: read for the idea's owner)
    ('refinery.brainstorm', 'user', 'boolean', 'refinery', 10, 'Brainstorm on my ideas',
        'The grounded brainstorm reply under an idea''s dossier thread. Off: no brainstorm on your ideas. The service''s own switch (IDEA_BRAINSTORM) stays the master: this can turn it off for you, not on.',
        'true', 'IDEA_BRAINSTORM', 'openbrain-idea-refinery, on every brainstorm reply under one of your ideas', '{}', true, 'settings'),
    ('refinery.dormancy_days', 'user', 'integer', 'refinery', 20, 'Days before a quiet idea goes dormant',
        'A researched idea with no engagement for this many days goes dormant (editing it revives it).',
        '14', 'IDEA_DORMANCY_DAYS', 'openbrain-idea-refinery, on every pass (each minute)', '{"min":1,"max":365}', true, 'settings'),
    ('refinery.resurface_max_dist', 'user', 'number', 'refinery', 30, 'How close a dormant idea must be to resurface',
        'The cosine distance (0 = identical) under which a dormant idea of yours is named in a related idea''s dossier. Smaller = stricter.',
        '0.40', 'IDEA_RESURFACE_MAX_DIST', 'openbrain-idea-refinery, on every dossier delivered on one of your ideas', '{"min":0.05,"max":1}', true, 'settings'),
    -- My digest and podcast (user tier: read for the owner of the run)
    ('digest.window_hours', 'user', 'integer', 'digest', 10, 'Hours of mail in the digest',
        'The AI-news section lists what was captured in the last this-many hours.',
        '24', 'DIGEST_WINDOW_HOURS', 'openbrain-digest, on every digest of yours (DIGEST_OWNER_SUB)', '{"min":1,"max":168}', true, 'settings'),
    ('digest.send_time', 'user', 'time', 'digest', 20, 'Send time',
        'The daily chain starts at 05:00 UTC (the cron) and the digest is due by ROUTINE_SEND_BY. A per-user send time comes with the per-user scheduled chain (plan 08 PD4); shown here, not yet editable.',
        '"05:00"', NULL, 'openbrain-cron (crontab 0 5 * * * UTC), fixed', '{}', false, 'settings'),
    ('podcast.team', 'user', 'string', 'digest', 30, 'The team that voices my daily episode',
        'A team of your presenters (by id or name). With none, the episode''s script is written and no audio is voiced.',
        NULL, 'PODCAST_TEAM', 'openbrain-podcast (link-enrich), on every daily episode of yours (PODCAST_OWNER_SUB)', '{"max_len":120,"ref":"podcast_team"}', true, 'settings'),
    -- the archive destination: the slot-230 global setting (admin tier, the contract store)
    ('podcast.archive_destination', 'admin', 'destination', 'digest', 40, 'Podcast archive destination',
        'Where every rendered episode is archived - shared by everyone, so only an admin changes it.',
        '{"mount":"podcast-archive"}', NULL, 'openbrain-podcast archive writer, on every render', '{}', true, 'contract'),
    -- Admin: research tuning (read-only here; making it editable is a later item)
    ('research.max_fetch', 'admin', 'integer', 'research', 10, 'Pages retrieved per run (MAX_FETCH)', 'The source-yield budget of a research run.',
        '24', 'MAX_FETCH', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.max_fetch_timeouts', 'admin', 'integer', 'research', 20, 'Timed-out fetches before a run stops', '0 = no ceiling.',
        '20', 'MAX_FETCH_TIMEOUTS', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.max_rounds', 'admin', 'integer', 'research', 30, 'Gather rounds (MAX_ROUNDS)', 'The hard ceiling on iterative deepening.',
        '3', 'MAX_ROUNDS', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.relevant_target', 'admin', 'integer', 'research', 40, 'Relevant pages a run aims for', 'Gathering continues below this while reformulations remain.',
        '8', 'RELEVANT_TARGET', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.max_wall_ms', 'admin', 'integer', 'research', 50, 'Wall time per run (ms)', 'The shared default; Open WebUI topic research may run to MAX_WALL_MS_OWUI.',
        '180000', 'MAX_WALL_MS', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.search_k', 'admin', 'integer', 'research', 60, 'Search hits per query (SEARCH_K)', '',
        '8', 'SEARCH_K', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.confidence_floor', 'admin', 'number', 'research', 70, 'Confidence floor', 'Below it a hit is a lead, never staged.',
        '0.50', 'CONFIDENCE_FLOOR', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.reuse_max_distance', 'admin', 'number', 'research', 80, 'Claim reuse distance', 'Claims farther than this from the query are not reused.',
        '0.55', 'REUSE_MAX_DISTANCE', 'openbrain-research, every run', '{}', false, 'settings'),
    ('research.kb_sources_k', 'admin', 'integer', 'research', 90, 'Stored sources folded in per run', '0 = recall off.',
        '6', 'KB_SOURCES_K', 'openbrain-research, every run', '{}', false, 'settings'),
    ('curator.shortlist_k', 'admin', 'integer', 'research', 110, 'Curator: thread candidates', '',
        '5', 'SHORTLIST_K', 'openbrain-research-curator, every filing', '{}', false, 'settings'),
    ('curator.new_thread_min_confidence', 'admin', 'number', 'research', 120, 'Curator: confidence to start a new thread', 'Below it a claim attaches to the top candidate.',
        '0.60', 'NEW_THREAD_MIN_CONFIDENCE', 'openbrain-research-curator, every filing', '{}', false, 'settings'),
    ('curator.merge_floor_distance', 'admin', 'number', 'research', 130, 'Curator: merge distance (model down)', '',
        '0.45', 'MERGE_FLOOR_DISTANCE', 'openbrain-research-curator, every filing', '{}', false, 'settings'),
    ('curator.conflict_distance', 'admin', 'number', 'research', 140, 'Curator: conflict distance', 'A new claim this close to a thread claim is judged for contradiction.',
        '0.25', 'CONFLICT_DISTANCE', 'openbrain-research-curator, every filing', '{}', false, 'settings')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store;

-- Round 2 (review G2): PostgREST caches the schema; without this a live `psql -f` leaves /rest/v1/rpc/setting_get
-- a 404 (the digest and the podcast then keep their env values) until PostgREST restarts.
NOTIFY pgrst, 'reload schema';
