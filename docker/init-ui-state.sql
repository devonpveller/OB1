-- ============================================================
-- Per-user front-end state keys (research-workbench-redesign rwr-ui-state-keys, phase 0). Slot 490.
-- The new app's shell keeps four things with the ACCOUNT, not the browser: which document you have locked,
-- which you had open last, which screen you start on, and your Recently viewed list. They are user-tier
-- settings keys (slot 400's store): one value per owner_sub, versioned writes, read and written only for the
-- identity seam's subject through /workbench/settings/:key. They hold identifiers and a screen name, never
-- document text.
--   * settings_keys.section gains 'ui'; settings_keys.type gains 'ref_list'.
--   * setting_problem() judges ref_list: at most max_items {kind, id[, locked]} objects; kind one of the key's
--     registered kinds; a document id a documents/ path, any other id an opaque identifier; ids are refused when
--     credential-shaped, with control (C0/C1), bidi or zero-width characters, backslashes or dot segments; nothing
--     else in an item. A string key with validation ref = doc_path (the two document keys) gets the same path rule
--     on top of the string rules.
--   * VERSIONS NEVER GO BACK (round 2): public.user_setting_tombstones keeps the version of a deleted key;
--     user_setting_set() is serialised per (owner, key) by an advisory lock, so two first writes that both
--     send version 0 cannot both win; user_setting_clear() is the versioned DELETE (a delete is a new version).
--   * four rows: ui.locked_document, ui.last_document (string, doc_path), ui.start_screen (enum),
--     library.recent (ref_list, capped at 24, kinds source/claim/topic/gap/document/idea/run).
-- Additive and idempotent (a re-run restores exactly what is written here). Fresh-volume slot 490; live: after
-- slot 400 and a fresh DB backup, psql -f BEFORE the new workbench image.
-- RE-RUN IT AFTER ANY RE-RUN OF SLOT 400: this file replaces two of 400's functions (setting_problem and
-- user_setting_set), and a re-run of 400 puts 400's text back (ref_list refused, no doc_path rule, no advisory
-- lock, no tombstone check, so every versioned write of a key that was ever deleted is a 409 until this file runs).
-- Revert, in this order: put the PREVIOUS workbench image back FIRST (the new one reads the tombstone table on every
-- settings GET and calls user_setting_clear on every DELETE), then revert-ui-state.sql (discards the four keys' stored
-- values and every tombstone; after the revert of any later migration that added 'ui' keys), then, if ever,
-- revert-settings.sql.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_section_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_section_check
    CHECK (section IN ('refinery', 'digest', 'research', 'ui'));
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_type_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_type_check
    CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination', 'ref_list'));

-- the version of a deleted user setting (a key never stored has none: version 0)
CREATE TABLE IF NOT EXISTS public.user_setting_tombstones (
    owner_sub TEXT NOT NULL CHECK (btrim(owner_sub) <> ''),
    key       TEXT NOT NULL,
    version   INT  NOT NULL CHECK (version > 0),
    PRIMARY KEY (owner_sub, key)
);
ALTER TABLE public.user_setting_tombstones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_setting_tombstones_service_role_all ON public.user_setting_tombstones;
CREATE POLICY user_setting_tombstones_service_role_all ON public.user_setting_tombstones
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_setting_tombstones TO service_role;

-- the registry's validation, with the ref_list branch and the doc_path rule (CREATE OR REPLACE keeps owner and grants)
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
        -- rwr-ui-state-keys (slot 490): a document is an identifier - a path under documents/, no dot segments, no
        -- control (C0, DEL, C1 such as U+0085), bidi or zero-width character, no backslash
        IF v->>'ref' = 'doc_path' THEN
            IF s !~ '^documents/.' THEN RETURN 'a document path starts with documents/'; END IF;
            IF s ~ '[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]' OR position(chr(92) in s) > 0 THEN RETURN 'a document path has no control, invisible or direction characters'; END IF;
            IF s ~ '(^|/)[.][.]?(/|$)' THEN RETURN 'a document path has no dot segments'; END IF;
        END IF;
    WHEN 'string_list' THEN
        IF t <> 'array' THEN RETURN 'must be a list of text'; END IF;
        IF jsonb_array_length(p_value) > COALESCE((v->>'max_items')::int, 20) THEN RETURN 'the list is too long'; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > COALESCE((v->>'max_len')::int, 200)) THEN
            RETURN 'every item must be text, and short';
        END IF;
    WHEN 'ref_list' THEN
        -- rwr-ui-state-keys (slot 490): a capped list of {kind, id[, locked]} - identifiers only, never text. kind is one
        -- of the key's registered kinds; a document id is a documents/ path, any other id an opaque identifier
        IF t <> 'array' THEN RETURN 'must be a list'; END IF;
        IF jsonb_array_length(p_value) > COALESCE((v->>'max_items')::int, 24) THEN RETURN 'the list is too long'; END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_value) e
             WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true ELSE (
                      EXISTS (SELECT 1 FROM jsonb_object_keys(e) ek WHERE ek NOT IN ('kind', 'id', 'locked'))
                   OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string'
                   OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string'
                   OR (e ? 'locked' AND jsonb_typeof(e->'locked') <> 'boolean')
                   OR NOT (COALESCE(v->'kinds', '[]'::jsonb) ? (e->>'kind'))
                   OR btrim(e->>'id') = ''
                   OR length(e->>'id') > COALESCE((v->>'max_len')::int, 120)
                   OR (e->>'id') ~ '[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]'
                   OR position(chr(92) in (e->>'id')) > 0
                   OR (e->>'id') ~ '(^|/)[.][.]?(/|$)' OR (e->>'id') LIKE '%..%'
                   OR (e->>'id') ~ '(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)' OR (e->>'id') ~* '(^|[^a-z0-9])bearer\s'
                   OR CASE WHEN e->>'kind' = 'document' THEN (e->>'id') !~ '^documents/.'
                           ELSE (e->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' END
                 ) END
        ) THEN
            RETURN 'every item must be {"kind": one of the allowed kinds, "id": an identifier[, "locked": true or false]}';
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

-- Set one of an owner's user settings (the workbench's PUT). p_version, when given, must be the key's current version:
-- the stored row's, or - when there is none - the version a deleted key left behind (0 only for a key never stored).
-- A stale write is refused (40001) and changes nothing. Two writers of the same (owner, key) are serialised by an
-- advisory lock, so even two first writes that both send the same version cannot both win (rwr-ui-state-keys, F2).
CREATE OR REPLACE FUNCTION public.user_setting_set(
    p_owner TEXT, p_key TEXT, p_value JSONB, p_actor TEXT, p_version INT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cur INT;
    live BOOLEAN;
    out_version INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('user_setting' || chr(31) || p_owner || chr(31) || p_key, 0));
    SELECT version INTO cur FROM public.user_settings WHERE owner_sub = p_owner AND key = p_key FOR UPDATE;
    live := FOUND;
    IF NOT live THEN
        SELECT version INTO cur FROM public.user_setting_tombstones WHERE owner_sub = p_owner AND key = p_key;
        cur := COALESCE(cur, 0);
    END IF;
    IF p_version IS NOT NULL AND cur <> p_version THEN
        RAISE EXCEPTION 'the setting changed since it was read (version %, not %)', cur, p_version USING ERRCODE = '40001';
    END IF;
    IF live THEN
        UPDATE public.user_settings
           SET value = p_value, version = cur + 1, updated_at = now(), updated_by = p_actor
         WHERE owner_sub = p_owner AND key = p_key
        RETURNING version INTO out_version;
    ELSE
        INSERT INTO public.user_settings (owner_sub, key, value, version, updated_by)
        VALUES (p_owner, p_key, p_value, cur + 1, p_actor)
        RETURNING version INTO out_version;
        DELETE FROM public.user_setting_tombstones WHERE owner_sub = p_owner AND key = p_key;
    END IF;
    RETURN out_version;
END;
$$;

-- Put one of an owner's user settings back to its default (the workbench's DELETE). A delete is itself a version: the
-- key's number goes up and is kept in a tombstone, so it never goes back and a stale tab's version can never match
-- again (F3). p_version, when given, must be the current one (stale: 40001, nothing deleted). Returns the new version.
CREATE OR REPLACE FUNCTION public.user_setting_clear(p_owner TEXT, p_key TEXT, p_version INT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cur INT;
    live BOOLEAN;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('user_setting' || chr(31) || p_owner || chr(31) || p_key, 0));
    SELECT version INTO cur FROM public.user_settings WHERE owner_sub = p_owner AND key = p_key FOR UPDATE;
    live := FOUND;
    IF NOT live THEN
        SELECT version INTO cur FROM public.user_setting_tombstones WHERE owner_sub = p_owner AND key = p_key;
        cur := COALESCE(cur, 0);
    END IF;
    IF p_version IS NOT NULL AND cur <> p_version THEN
        RAISE EXCEPTION 'the setting changed since it was read (version %, not %)', cur, p_version USING ERRCODE = '40001';
    END IF;
    IF NOT live THEN RETURN cur; END IF;
    DELETE FROM public.user_settings WHERE owner_sub = p_owner AND key = p_key;
    INSERT INTO public.user_setting_tombstones (owner_sub, key, version) VALUES (p_owner, p_key, cur + 1)
    ON CONFLICT (owner_sub, key) DO UPDATE SET version = EXCLUDED.version;
    RETURN cur + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.user_setting_set(TEXT, TEXT, JSONB, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_setting_clear(TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_setting_set(TEXT, TEXT, JSONB, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.user_setting_clear(TEXT, TEXT, INT) TO service_role;

INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store) VALUES
    ('ui.locked_document', 'user', 'string', 'ui', 10, 'Locked document',
        'The document you have locked as the one research and sources are added to. An identifier (a documents/ path), never text. Empty: none locked.',
        NULL, NULL, 'openbrain-workbench-app, at start and on every lock / unlock', '{"max_len":400,"ref":"doc_path"}', true, 'settings'),
    ('ui.last_document', 'user', 'string', 'ui', 20, 'Last document',
        'The document you had open last, so the shell can offer it again on any browser. An identifier (a documents/ path), never text.',
        NULL, NULL, 'openbrain-workbench-app, at start and whenever a document is opened', '{"max_len":400,"ref":"doc_path"}', true, 'settings'),
    ('ui.start_screen', 'user', 'enum', 'ui', 30, 'Start screen',
        'The screen the app opens on. Unset: the app''s own default (Home).',
        NULL, NULL, 'openbrain-workbench-app, at start', '{"enum":["home","research","chat","documents","ideas","podcasts","library"]}', true, 'settings'),
    ('library.recent', 'user', 'ref_list', 'ui', 40, 'Recently viewed',
        'The items you opened lately, newest first, each {kind, id[, locked]} - identifiers only. At most 24.',
        NULL, NULL, 'openbrain-workbench-app, at start and whenever an item is opened, locked or closed',
        '{"max_items":24,"max_len":120,"kinds":["source","claim","topic","gap","document","idea","run"]}', true, 'settings')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store;

COMMIT;
NOTIFY pgrst, 'reload schema';
