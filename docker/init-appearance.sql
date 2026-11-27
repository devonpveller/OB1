-- ============================================================
-- Appearance keys (research-workbench-redesign rwr-appearance). Slot 700.
-- Five per-user settings keys, section 'ui', tag only_you, so "light / dark / follow device, accent, density, text size and
-- saved themes" follow the ACCOUNT to every browser (slot 400's store: one value per owner_sub, versioned writes, read and
-- written only for the identity seam's subject through /workbench/settings/:key; no route change):
--   ui.theme         enum light | dark | system                  (default system)
--   ui.accent        enum teal | indigo | amber | rose | slate   (default teal; the app tests AA contrast for each, light and dark)
--   ui.density       enum comfortable | compact                  (default comfortable)
--   ui.text_size     enum 13 | 14 | 15 | 16 | 18                 (default 14; a pixel size as text)
--   ui.saved_themes  theme_list (NEW type)                       at most 10 per person (the coordinator's default, validation.max_items)
-- Also: settings_keys.type gains 'theme_list'; setting_problem() gains a theme_list branch (every other branch is slot 490's
-- text, unchanged). Over the cap, an unknown choice, an extra field, a credential-shaped or control-character name, a
-- repeated name: refused (400), nothing stored. A stored value that later falls outside an offered list never causes an
-- error on read: the app shows the default for it.
-- Slot 700 sits ON slots 400 + 490 + 550 (it needs the tag column). Additive and idempotent. Fresh-volume slot 700; live:
-- after 400 + 490 + 550 and a fresh DB backup, psql -f BEFORE the new workbench-app image (the screen reads these keys).
-- RE-RUN IT AFTER ANY RE-RUN OF SLOT 400 OR 490 (they replace setting_problem and the type CHECK; a re-run puts their text back).
-- Revert, in this order: previous workbench-app image back FIRST, then revert-appearance.sql (BEFORE revert-settings-tags.sql
-- and BEFORE revert-ui-state.sql: it narrows the type CHECK and restores 490's setting_problem, so with 490's own revert run
-- first the narrowing would be refused).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_type_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_type_check
    CHECK (type IN ('boolean', 'integer', 'number', 'string', 'time', 'enum', 'string_list', 'destination', 'ref_list', 'theme_list'));

-- slot 490's setting_problem() with one more branch (theme_list); CREATE OR REPLACE keeps owner and grants
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
    WHEN 'theme_list' THEN
        -- rwr-appearance (slot 700): saved themes - a capped list of {name, theme, accent, density, text_size}. Every
        -- choice is one of the key's offered lists; the name is short text; nothing else can ride in an item.
        IF t <> 'array' THEN RETURN 'must be a list'; END IF;
        IF jsonb_array_length(p_value) > COALESCE((v->>'max_items')::int, 10) THEN
            RETURN format('you can keep at most %s saved themes', COALESCE((v->>'max_items')::int, 10));
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_value) e
             WHERE CASE WHEN jsonb_typeof(e) <> 'object' THEN true ELSE (
                      EXISTS (SELECT 1 FROM jsonb_object_keys(e) ek WHERE ek NOT IN ('name', 'theme', 'accent', 'density', 'text_size'))
                   OR jsonb_typeof(e->'name') IS DISTINCT FROM 'string'
                   OR btrim(e->>'name') = ''
                   OR length(e->>'name') > COALESCE((v->>'max_name')::int, 40)
                   OR (e->>'name') ~ '[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]'
                   OR (e->>'name') ~ '(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)' OR (e->>'name') ~* '(^|[^a-z0-9])bearer\s'
                   OR jsonb_typeof(e->'theme') IS DISTINCT FROM 'string' OR NOT (COALESCE(v->'themes', '[]'::jsonb) ? (e->>'theme'))
                   OR jsonb_typeof(e->'accent') IS DISTINCT FROM 'string' OR NOT (COALESCE(v->'accents', '[]'::jsonb) ? (e->>'accent'))
                   OR jsonb_typeof(e->'density') IS DISTINCT FROM 'string' OR NOT (COALESCE(v->'densities', '[]'::jsonb) ? (e->>'density'))
                   OR jsonb_typeof(e->'text_size') IS DISTINCT FROM 'string' OR NOT (COALESCE(v->'text_sizes', '[]'::jsonb) ? (e->>'text_size'))
                 ) END
        ) THEN
            RETURN 'every saved theme is {"name": short text, "theme", "accent", "density", "text_size"} using the offered choices';
        END IF;
        IF (SELECT count(DISTINCT lower(btrim(e->>'name'))) FROM jsonb_array_elements(p_value) e) <> jsonb_array_length(p_value) THEN
            RETURN 'two saved themes cannot have the same name';
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

INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store, tag) VALUES
    ('ui.theme', 'user', 'enum', 'ui', 5, 'Theme',
        'Light, dark, or follow your device (light by day, dark if your device is dark).',
        '"system"', NULL, 'openbrain-workbench-app, at start and whenever you change it', '{"enum":["light","dark","system"]}', true, 'settings', 'only_you'),
    ('ui.accent', 'user', 'enum', 'ui', 6, 'Accent colour',
        'Buttons, links and highlights. One of the colours offered.',
        '"teal"', NULL, 'openbrain-workbench-app, at start and whenever you change it', '{"enum":["teal","indigo","amber","rose","slate"]}', true, 'settings', 'only_you'),
    ('ui.density', 'user', 'enum', 'ui', 7, 'Density',
        'Comfortable: roomier rows. Compact: tighter rows in Documents, Research and the Library.',
        '"comfortable"', NULL, 'openbrain-workbench-app, at start and whenever you change it', '{"enum":["comfortable","compact"]}', true, 'settings', 'only_you'),
    ('ui.text_size', 'user', 'enum', 'ui', 8, 'Text size',
        'The size of body text, in pixels.',
        '"14"', NULL, 'openbrain-workbench-app, at start and whenever you change it', '{"enum":["13","14","15","16","18"]}', true, 'settings', 'only_you'),
    ('ui.saved_themes', 'user', 'theme_list', 'ui', 50, 'Saved themes',
        'Your own looks, kept with your account: a name and the theme, accent, density and text size it sets. At most 10.',
        NULL, NULL, 'openbrain-workbench-app, at start and whenever you save, apply or delete a theme',
        '{"max_items":10,"max_name":40,"themes":["light","dark","system"],"accents":["teal","indigo","amber","rose","slate"],"densities":["comfortable","compact"],"text_sizes":["13","14","15","16","18"]}', true, 'settings', 'only_you')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store,
    tag = EXCLUDED.tag;

COMMIT;
NOTIFY pgrst, 'reload schema';
