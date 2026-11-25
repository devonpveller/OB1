-- ============================================================
-- A tag on every settings key (research-workbench-redesign rwr-settings-shell, phase 6). Slot 550.
-- The new app's Settings screen says, beside every setting, who can see it. The answer is a column of the
-- registry row (public.settings_keys.tag), so it is set where the key is defined and read by the route; the
-- screen has no table of its own.
--   * tag is one of:  only_you     the value is yours: no other person is shown it
--                     on_server    a service on this server reads it on your behalf; it stays on this server
--                     admin_all    an admin changes it for everyone
--     'cloud' (Sent to a cloud provider) is NOT allowed yet: the CHECK refuses it on every key until phase 9
--     (models, keys, egress; the operator's gate) widens it with its own migration.
--   * the column is nullable on purpose: slots 400 and 490 insert keys with ON CONFLICT DO UPDATE and a NOT NULL
--     column would refuse them on a re-run. A key without a tag is therefore possible in the table and is what the
--     catalog test (settings_tags_integration_test.ts) fails on; the route reports it as null, never as a guess.
--   * the 24 keys that exist today get their tag here (re-running restores exactly these).
-- Slots 400 and 490 are not touched: setting_problem() and user_setting_set() stay slot 490's. A key added by a
-- later slot sets its own tag in its INSERT (the column is part of the registry row).
-- Additive and idempotent. Fresh volume: runs after 400 and 490. Live: after slots 400 and 490 and a fresh DB backup,
-- psql -f BEFORE the new workbench image (the image selects the column). A re-run of 400 or 490 keeps the tags (their
-- ON CONFLICT updates do not name the column); re-run this file after adding keys from a slot that sets none.
-- Revert: put the PREVIOUS workbench image back first, then revert-settings-tags.sql (drops the column and its CHECK;
-- no value is lost that the keys' own rows do not define). Run it BEFORE revert-ui-state.sql and revert-settings.sql.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.settings_keys ADD COLUMN IF NOT EXISTS tag TEXT;
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_tag_check;
ALTER TABLE public.settings_keys ADD CONSTRAINT settings_keys_tag_check
    CHECK (tag IS NULL OR tag IN ('only_you', 'on_server', 'admin_all'));

UPDATE public.settings_keys k SET tag = t.tag
  FROM (VALUES
    ('ui.locked_document', 'only_you'), ('ui.last_document', 'only_you'), ('ui.start_screen', 'only_you'), ('library.recent', 'only_you'),
    ('refinery.brainstorm', 'on_server'), ('refinery.dormancy_days', 'on_server'), ('refinery.resurface_max_dist', 'on_server'),
    ('digest.window_hours', 'on_server'), ('digest.send_time', 'on_server'), ('podcast.team', 'on_server'),
    ('podcast.archive_destination', 'admin_all'),
    ('research.max_fetch', 'admin_all'), ('research.max_fetch_timeouts', 'admin_all'), ('research.max_rounds', 'admin_all'),
    ('research.relevant_target', 'admin_all'), ('research.max_wall_ms', 'admin_all'), ('research.search_k', 'admin_all'),
    ('research.confidence_floor', 'admin_all'), ('research.reuse_max_distance', 'admin_all'), ('research.kb_sources_k', 'admin_all'),
    ('curator.shortlist_k', 'admin_all'), ('curator.new_thread_min_confidence', 'admin_all'),
    ('curator.merge_floor_distance', 'admin_all'), ('curator.conflict_distance', 'admin_all')
  ) AS t (key, tag)
 WHERE k.key = t.key AND k.tag IS DISTINCT FROM t.tag;

COMMIT;
NOTIFY pgrst, 'reload schema';
