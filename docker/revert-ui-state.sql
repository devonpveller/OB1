-- Revert init-ui-state.sql (rwr-ui-state-keys, slot 490).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-ui-state.sql
-- Removes the four keys (ui.locked_document, ui.last_document, ui.start_screen, library.recent) and every
-- user's stored value of them, drops user_setting_clear() and the tombstone table (every key's version numbers
-- then count from its stored row again), narrows the section and type CHECKs back to slot 400's and restores
-- slot 400's setting_problem() and user_setting_set() text. After it the catalog is as it was after slot 400
-- alone. ORDER: put the PREVIOUS workbench image back FIRST (the new image reads the tombstone table on every
-- settings GET and calls user_setting_clear() on DELETE only, so with this file applied under it GET /workbench/settings and
-- every DELETE fail for every user: GET on the tombstone read, DELETE on the missing function), THEN run this file, THEN, if ever, revert-settings.sql. Also after the revert of
-- any later migration that added 'ui' keys (the narrowed CHECK would refuse their rows). Forward order: slot 400, a
-- fresh DB backup, init-ui-state.sql, then the new workbench image; re-run init-ui-state.sql after any re-run of 400. Take a pg_dump of public.user_settings first if any of it matters.
-- Idempotent: a second run changes nothing.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM public.user_settings WHERE key IN ('ui.locked_document', 'ui.last_document', 'ui.start_screen', 'library.recent');
DELETE FROM public.settings_keys WHERE key IN ('ui.locked_document', 'ui.last_document', 'ui.start_screen', 'library.recent');
DROP FUNCTION IF EXISTS public.user_setting_clear(TEXT, TEXT, INT);
DROP TABLE IF EXISTS public.user_setting_tombstones;
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_section_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_section_check
    CHECK (section IN ('refinery', 'digest', 'research'));
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_type_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_type_check
    CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination'));
-- slot 400's setting_problem() and user_setting_set(), verbatim
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
COMMIT;
NOTIFY pgrst, 'reload schema';
