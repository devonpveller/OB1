-- ============================================================
-- Per-user front-end state keys (research-workbench-redesign rwr-ui-state-keys, phase 0). Slot 490.
-- The new app's shell keeps four things with the ACCOUNT, not the browser: which document you have locked,
-- which you had open last, which screen you start on, and your Recently viewed list. They are user-tier
-- settings keys (slot 400's store): one value per owner_sub, versioned writes, read and written only for the
-- identity seam's subject through /workbench/settings/:key. They hold identifiers and a screen name, never
-- document text.
--   * settings_keys.section gains 'ui' (the section CHECK is widened; the Settings panel of the old
--     workspace lists only its own sections, so these never show there).
--   * settings_keys.type gains 'ref_list' and setting_problem() judges it: a list of at most
--     max_items {kind, id[, locked]} objects, kind a short lower-case name, id a short identifier
--     with no control characters, nothing else in an item.
--   * four rows: ui.locked_document (string, a document path), ui.last_document (string),
--     ui.start_screen (enum of the menu's screens), library.recent (ref_list, capped at 24).
-- Additive and idempotent (a re-run restores exactly what is written here). Fresh-volume slot 490; live:
-- psql -f BEFORE the new workbench image, after a fresh DB backup. Revert: revert-ui-state.sql (discards the
-- four keys' stored values; it runs BEFORE revert-settings.sql, and after the revert of any later migration
-- that added 'ui' keys).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_section_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_section_check
    CHECK (section IN ('refinery', 'digest', 'research', 'ui'));
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_type_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_type_check
    CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination', 'ref_list'));

-- the registry's validation, with the ref_list branch (CREATE OR REPLACE keeps the owner and the grants)
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
    WHEN 'ref_list' THEN
        -- rwr-ui-state-keys (slot 490): a capped list of {kind, id[, locked]} - identifiers only, never text
        IF t <> 'array' THEN RETURN 'must be a list'; END IF;
        IF jsonb_array_length(p_value) > COALESCE((v->>'max_items')::int, 24) THEN RETURN 'the list is too long'; END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_value) e
             WHERE jsonb_typeof(e) <> 'object'
                OR (CASE WHEN jsonb_typeof(e) = 'object'
                         THEN EXISTS (SELECT 1 FROM jsonb_object_keys(e) ek WHERE ek NOT IN ('kind', 'id', 'locked'))
                         ELSE true END)
                OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string'
                OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string'
                OR (e ? 'locked' AND jsonb_typeof(e->'locked') <> 'boolean')
                OR (e->>'kind') !~ '^[a-z][a-z_]{0,31}$'
                OR btrim(e->>'id') = ''
                OR length(e->>'id') > COALESCE((v->>'max_len')::int, 120)
                OR (e->>'id') ~ '[[:cntrl:]]'
        ) THEN
            RETURN 'every item must be {"kind": a short name, "id": an identifier[, "locked": true or false]}';
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

INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store) VALUES
    ('ui.locked_document', 'user', 'string', 'ui', 10, 'Locked document',
        'The document you have locked as the one research and sources are added to. An identifier (a path), never text. Empty: none locked.',
        NULL, NULL, 'openbrain-workbench-app, at start and on every lock / unlock', '{"max_len":400}', true, 'settings'),
    ('ui.last_document', 'user', 'string', 'ui', 20, 'Last document',
        'The document you had open last, so the shell can offer it again on any browser. An identifier (a path), never text.',
        NULL, NULL, 'openbrain-workbench-app, at start and whenever a document is opened', '{"max_len":400}', true, 'settings'),
    ('ui.start_screen', 'user', 'enum', 'ui', 30, 'Start screen',
        'The screen the app opens on. Unset: the app''s own default (Home).',
        NULL, NULL, 'openbrain-workbench-app, at start', '{"enum":["home","research","chat","documents","ideas","podcasts","library"]}', true, 'settings'),
    ('library.recent', 'user', 'ref_list', 'ui', 40, 'Recently viewed',
        'The items you opened lately, newest first, each {kind, id[, locked]} - identifiers only. At most 24.',
        NULL, NULL, 'openbrain-workbench-app, at start and whenever an item is opened, locked or closed', '{"max_items":24,"max_len":120}', true, 'settings')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store;

COMMIT;
NOTIFY pgrst, 'reload schema';
