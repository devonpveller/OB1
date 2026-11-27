-- Revert init-appearance.sql (rwr-appearance, slot 700).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-appearance.sql
-- Removes the five keys (ui.theme, ui.accent, ui.density, ui.text_size, ui.saved_themes) and every user's stored value of
-- them, narrows the type CHECK back to slot 490's and restores slot 490's setting_problem() text verbatim. After it the
-- catalog is as it was after slots 400 + 490 + 550. ORDER: put the PREVIOUS workbench-app image back FIRST, then this file,
-- then (if ever) revert-settings-tags.sql, then revert-ui-state.sql (490's revert narrows the type CHECK and would be refused
-- while a theme_list key exists). Take a pg_dump of public.user_settings first if any of it matters. Idempotent.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM public.user_settings WHERE key IN ('ui.theme', 'ui.accent', 'ui.density', 'ui.text_size', 'ui.saved_themes');
DELETE FROM public.user_setting_tombstones WHERE key IN ('ui.theme', 'ui.accent', 'ui.density', 'ui.text_size', 'ui.saved_themes');
DELETE FROM public.settings_keys WHERE key IN ('ui.theme', 'ui.accent', 'ui.density', 'ui.text_size', 'ui.saved_themes');
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_type_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_type_check
    CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination', 'ref_list'));
-- slot 490's setting_problem(), verbatim
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

COMMIT;
NOTIFY pgrst, 'reload schema';
