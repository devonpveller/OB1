-- ============================================================
-- Research, Library and Podcast defaults, and the admin research limits (research-workbench-redesign
-- rwr-settings-defaults, phase 6). Slot 730.
--
-- What this file adds, on top of slots 400 (store), 490 (ui keys) and 550 (tags):
--   * eight USER keys: research.default_depth, research.ask_over_fetch; library.how_far_out, library.recent_size,
--     library.clear_on_signout, library.hidden_suggestions; podcast.default_format, podcast.episode_minutes. (The research
--     defaults brainstorm / rest after / what wakes an idea are the existing refinery.* keys; the mail window is the
--     existing digest.window_hours; the archive destination is the existing admin key.)
--   * a USER CEILING (settings_user_ceilings): research.ask_over_fetch may not exceed the admin's pages-per-run limit
--     (research.max_fetch, the value stored by an admin, else its code default). A trigger on user_settings refuses a
--     value above it and names the ceiling in the refusal; whoever writes (the route, PostgREST, psql as the app role).
--   * FIXED RANGES for the thirteen admin research / curator limits (settings_keys.validation min / max): an admin value
--     outside them is refused by a trigger on contract_settings, whoever writes it. The keys stay editable = false, so the
--     per-key admin PUT stays closed: the only door is a PRESET.
--   * PRESETS (settings_limit_groups / settings_limit_presets / settings_limit_preset_values): three groups (run size, judgement,
--     curator), three presets each. settings_limits_apply(actor, group, preset) writes exactly the preset's keys in ONE
--     transaction (every value re-judged against its range); settings_limits_reset(actor, group) takes the group's stored
--     values away (the services then use their env values). Both execute for ob_workbench alone.
--   * settings_admin_audit: the APPEND-ONLY log of every change of the admin tier (who, what, old value, new value; the
--     preset it came from). It is written by a trigger on contract_settings - so a change by any route or by psql is
--     logged - and the app role can read it and cannot edit, delete or truncate it. A non-admin has no route to it.
--   * the services read an admin limit through the one function, public.setting_get(NULL, key) (slot 400): NULL = the env value.
-- Slot 400's setting_problem() and slot 490's user_setting_set() are NOT replaced (the new rules are triggers).
-- Additive and idempotent: a re-run restores exactly what is written here. RE-RUN IT AFTER ANY RE-RUN OF SLOT 400 (400's upsert puts its
-- code defaults back on the three keys this file sets to the deployed values). Fresh volume: runs after 400, 480, 490, 550. Live:
-- a fresh DB backup, psql -f BEFORE the new workbench image. Revert: revert-settings-defaults.sql (discards the eight keys'
-- stored values, the stored admin limits and the audit log; the limits are then the services' env values again).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    IF to_regclass('public.settings_keys') IS NULL OR to_regclass('public.user_setting_tombstones') IS NULL THEN
        RAISE EXCEPTION 'settings defaults: slots 400 and 490 (init-settings.sql, init-ui-state.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'settings_keys' AND column_name = 'tag') THEN
        RAISE EXCEPTION 'settings defaults: slot 550 (init-settings-tags.sql, the tag column) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'settings defaults: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

-- ── 1. the registry rows ────────────────────────────────────────────────────────────────────────
INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store, tag) VALUES
    ('research.default_depth', 'user', 'enum', 'research', 10, 'Default research depth',
        'The depth the Start research dialog offers first. You can still choose another depth for each run.',
        '"standard"', NULL, 'openbrain-workbench-app, when the Start research dialog opens', '{"enum":["quick","standard","deep"]}', true, 'settings', 'only_you'),
    ('research.ask_over_fetch', 'user', 'integer', 'research', 20, 'Ask me before a run reads more than this many pages',
        'The Start research dialog asks you to confirm when the chosen depth may read more pages than this. It cannot be higher than the most pages a run may read at all (set by an admin).',
        NULL, NULL, 'openbrain-workbench-app, when the Start research dialog shows what a run would do', '{"min":1,"max":200}', true, 'settings', 'only_you'),
    ('library.how_far_out', 'user', 'integer', 'ui', 110, 'How far out the Library looks from what you open',
        'Kept now; applied when the Library opens. Steps from an item to the related items the Library shows: 1 = direct relations only, 3 = three steps out.',
        '2', NULL, 'openbrain-workbench-app Library (kept now, applied when the Library opens)', '{"min":1,"max":3}', true, 'settings', 'only_you'),
    ('library.recent_size', 'user', 'integer', 'ui', 120, 'Recently viewed: how many items to keep',
        'Kept now; applied when the Library opens. How many opened items the Recently viewed list keeps (newest first).',
        '24', NULL, 'openbrain-workbench-app Library, whenever an item is added to Recently viewed (kept now, applied when the Library opens)', '{"min":1,"max":24}', true, 'settings', 'only_you'),
    ('library.clear_on_signout', 'user', 'boolean', 'ui', 130, 'Clear Recently viewed when I sign out',
        'Kept now; applied when the Library opens. Off: the list stays with your account. On: it is emptied when you sign out.',
        'false', NULL, 'openbrain-workbench-app Library, at sign out (kept now, applied when the Library opens)', '{}', true, 'settings', 'only_you'),
    ('library.hidden_suggestions', 'user', 'ref_list', 'ui', 140, 'Hidden suggestions',
        'Kept now; applied when the Library opens. The suggestions you hid, each {kind, id} - identifiers only. At most 100.',
        NULL, NULL, 'openbrain-workbench-app Library, whenever a suggestion is hidden or shown again (kept now, applied when the Library opens)',
        '{"max_items":100,"max_len":120,"kinds":["source","claim","topic","gap"]}', true, 'settings', 'only_you'),
    ('podcast.default_format', 'user', 'string', 'digest', 110, 'Default podcast format',
        'Kept now; applied when the new-episode form opens. A format of yours (by id or name) that a new episode starts from.',
        NULL, NULL, 'openbrain-workbench-app, when a new episode is made (kept now, applied when the new-episode form opens)', '{"max_len":120,"ref":"podcast_format"}', true, 'settings', 'on_server'),
    ('podcast.episode_minutes', 'user', 'integer', 'digest', 120, 'Episode length (minutes)',
        'Kept now; applied when the new-episode form opens. How long a new episode should run, about.',
        '10', NULL, 'openbrain-workbench-app, when a new episode is made (kept now, applied when the new-episode form opens)', '{"min":3,"max":30}', true, 'settings', 'on_server')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store, tag = EXCLUDED.tag;

-- the fixed ranges of the thirteen admin limits (a re-run puts them back exactly)
UPDATE public.settings_keys k SET validation = r.v::jsonb
  FROM (VALUES
    ('research.max_fetch',                  '{"min":6,"max":160}'),
    ('research.max_fetch_timeouts',         '{"min":0,"max":80}'),
    ('research.max_rounds',                 '{"min":1,"max":5}'),
    ('research.relevant_target',            '{"min":3,"max":16}'),
    ('research.max_wall_ms',                '{"min":60000,"max":1800000}'),
    ('research.search_k',                   '{"min":3,"max":16}'),
    ('research.confidence_floor',           '{"min":0.30,"max":0.80}'),
    ('research.reuse_max_distance',         '{"min":0.30,"max":0.70}'),
    ('research.kb_sources_k',               '{"min":0,"max":12}'),
    ('curator.shortlist_k',                 '{"min":2,"max":10}'),
    ('curator.new_thread_min_confidence',   '{"min":0.40,"max":0.80}'),
    ('curator.merge_floor_distance',        '{"min":0.25,"max":0.60}'),
    ('curator.conflict_distance',           '{"min":0.10,"max":0.40}')
  ) AS r (key, v)
 WHERE k.key = r.key AND k.tier = 'admin' AND k.validation IS DISTINCT FROM r.v::jsonb;

-- The DEPLOYED defaults. Slot 400 registered harness.ts's code defaults (24 pages, 20 timeouts, 180 000 ms) but openbrain-research runs on the
-- compose defaults (docker-compose.yml: RESEARCH_MAX_FETCH 80, RESEARCH_MAX_FETCH_TIMEOUTS 40, RESEARCH_MAX_WALL_MS 900000). "In force" with nothing
-- stored, the user ceiling and the preset called Standard must say what runs, so these three default_values are set to the compose values
-- (revert-settings-defaults.sql puts slot 400's back). The other ten keys' slot-400 defaults already equal the compose defaults.
-- limits-agreement.test.ts (beside the compose file) fails if this table, the compose file or either limits.ts drifts.
UPDATE public.settings_keys k SET default_value = d.v::jsonb
  FROM (VALUES ('research.max_fetch', '80'), ('research.max_fetch_timeouts', '40'), ('research.max_wall_ms', '900000')) AS d (key, v)
 WHERE k.key = d.key AND k.tier = 'admin' AND k.default_value IS DISTINCT FROM d.v::jsonb;

-- ── 2. the user ceiling ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings_user_ceilings (
    user_key  TEXT PRIMARY KEY REFERENCES public.settings_keys (key) ON DELETE CASCADE,
    admin_key TEXT NOT NULL REFERENCES public.settings_keys (key) ON DELETE CASCADE,
    phrase    TEXT NOT NULL CHECK (btrim(phrase) <> '')   -- what the ceiling is, in words a person can act on
);
INSERT INTO public.settings_user_ceilings (user_key, admin_key, phrase) VALUES
    ('research.ask_over_fetch', 'research.max_fetch', 'the most pages one research run may read, set by an admin')
ON CONFLICT (user_key) DO UPDATE SET admin_key = EXCLUDED.admin_key, phrase = EXCLUDED.phrase;

-- the ceiling now in force for a user key: the admin's stored value, else the admin key's code default; NULL = no ceiling
CREATE OR REPLACE FUNCTION public.settings_user_ceiling(p_user_key TEXT)
RETURNS NUMERIC
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((public.setting_get(NULL, c.admin_key) #>> '{}')::numeric, (a.default_value #>> '{}')::numeric)
      FROM public.settings_user_ceilings c JOIN public.settings_keys a ON a.key = c.admin_key
     WHERE c.user_key = p_user_key;
$$;

-- Every write of the user tier, whoever writes it: the ceiling, and the podcast format's owner check. (setting_problem() is
-- slot 490's and is not replaced; this trigger fires after slot 400's guard.)
CREATE OR REPLACE FUNCTION public.trg_user_settings_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cap NUMERIC;
    ph  TEXT;
    ref TEXT;
BEGIN
    SELECT public.settings_user_ceiling(NEW.key) INTO cap;
    IF cap IS NOT NULL AND jsonb_typeof(NEW.value) = 'number' AND (NEW.value #>> '{}')::numeric > cap THEN
        SELECT phrase INTO ph FROM public.settings_user_ceilings WHERE user_key = NEW.key;
        RAISE EXCEPTION '%: must be at most % (%)', NEW.key, trim_scale(cap), ph USING ERRCODE = '22023';
    END IF;
    SELECT validation->>'ref' INTO ref FROM public.settings_keys WHERE key = NEW.key;
    IF ref = 'podcast_format' AND NOT EXISTS (
        SELECT 1 FROM public.podcast_formats f WHERE f.owner_sub = NEW.owner_sub AND (f.id = NEW.value #>> '{}' OR f.name = NEW.value #>> '{}')) THEN
        RAISE EXCEPTION '%: no podcast format of yours has this id or name', NEW.key USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_user_settings_rules ON public.user_settings;
CREATE TRIGGER trg_user_settings_rules BEFORE INSERT OR UPDATE ON public.user_settings
    FOR EACH ROW EXECUTE FUNCTION public.trg_user_settings_rules();
REVOKE ALL ON FUNCTION public.settings_user_ceiling(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_user_settings_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settings_user_ceiling(TEXT) TO ob_workbench;   -- the trigger (same owner) calls it as its definer

-- ── 3. the audit log: append-only ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings_admin_audit (
    id        BIGSERIAL PRIMARY KEY,
    at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    actor     TEXT NOT NULL CHECK (btrim(actor) <> ''),
    action    TEXT NOT NULL CHECK (action IN ('set', 'clear')),
    key       TEXT NOT NULL,
    old_value JSONB,                                  -- NULL: nothing was stored (the env value / code default was in force)
    new_value JSONB,                                  -- NULL on a clear
    grp       TEXT,                                   -- the preset group and name the change came from (NULL: another route)
    preset    TEXT,
    CONSTRAINT settings_admin_audit_shape CHECK ((action = 'set') = (new_value IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_settings_admin_audit_at ON public.settings_admin_audit (id DESC);

ALTER TABLE public.settings_admin_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settings_admin_audit_read ON public.settings_admin_audit;
CREATE POLICY settings_admin_audit_read ON public.settings_admin_audit FOR SELECT TO ob_workbench USING (true);
-- Take back every direct grant first (the schema's default privileges hand a new table ALL to service_role), then grant the one
-- thing the workbench needs: read. Nobody holds INSERT: the log is written by the SECURITY DEFINER trigger below.
REVOKE ALL ON public.settings_admin_audit FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.settings_admin_audit'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.settings_admin_audit FROM %I', r.grantee);
    END LOOP;
END $$;
REVOKE ALL ON public.settings_admin_audit FROM service_role;
REVOKE ALL ON public.settings_admin_audit FROM ob_workbench;
GRANT SELECT ON public.settings_admin_audit TO ob_workbench;
REVOKE ALL ON SEQUENCE public.settings_admin_audit_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.settings_admin_audit_id_seq FROM service_role;

CREATE OR REPLACE FUNCTION public.settings_admin_audit_no_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'settings_admin_audit is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION public.settings_admin_audit_no_edit() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_settings_admin_audit_no_update ON public.settings_admin_audit;
CREATE TRIGGER trg_settings_admin_audit_no_update BEFORE UPDATE ON public.settings_admin_audit
    FOR EACH STATEMENT EXECUTE FUNCTION public.settings_admin_audit_no_edit();
DROP TRIGGER IF EXISTS trg_settings_admin_audit_no_delete ON public.settings_admin_audit;
CREATE TRIGGER trg_settings_admin_audit_no_delete BEFORE DELETE ON public.settings_admin_audit
    FOR EACH STATEMENT EXECUTE FUNCTION public.settings_admin_audit_no_edit();
DROP TRIGGER IF EXISTS trg_settings_admin_audit_no_truncate ON public.settings_admin_audit;
CREATE TRIGGER trg_settings_admin_audit_no_truncate BEFORE TRUNCATE ON public.settings_admin_audit
    FOR EACH STATEMENT EXECUTE FUNCTION public.settings_admin_audit_no_edit();

-- ── 4. the admin tier: bounds and the log, at the table ─────────────────────────────────────────
-- BEFORE: a limit outside its fixed range is refused (22023) whoever writes it. AFTER: every change is a log line. Who and which
-- preset are NOT taken from anything a caller can set (no GUC, no updated_by): this file's SECURITY DEFINER writers record
-- the actor they were given in settings_audit_context (no right for any app role) for their own transaction, and the trigger
-- reads it there. A write that does not come through them is logged as "db role <session_user> (a direct write)" with no preset.
-- TRUNCATE of the table is refused (a statement trigger), so the stored limits cannot vanish without a line.
CREATE TABLE IF NOT EXISTS public.settings_audit_context (
    txid   BIGINT PRIMARY KEY,
    actor  TEXT NOT NULL CHECK (btrim(actor) <> ''),
    grp    TEXT,
    preset TEXT
);
REVOKE ALL ON public.settings_audit_context FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.settings_audit_context'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.settings_audit_context FROM %I', r.grantee);
    END LOOP;
END $$;
REVOKE ALL ON public.settings_audit_context FROM service_role;
REVOKE ALL ON public.settings_audit_context FROM ob_workbench;
ALTER TABLE public.settings_audit_context ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.trg_contract_settings_no_truncate() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'contract_settings cannot be truncated: its limits are changed one key at a time and every change is logged' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION public.trg_contract_settings_no_truncate() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_contract_settings_no_truncate ON public.contract_settings;
CREATE TRIGGER trg_contract_settings_no_truncate BEFORE TRUNCATE ON public.contract_settings
    FOR EACH STATEMENT EXECUTE FUNCTION public.trg_contract_settings_no_truncate();

CREATE OR REPLACE FUNCTION public.trg_contract_settings_bounds() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE why TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM public.settings_keys k WHERE k.key = NEW.key AND k.tier = 'admin' AND k.store = 'settings') THEN
        why := public.setting_problem(NULL, NEW.key, NEW.value);
        IF why IS NOT NULL THEN RAISE EXCEPTION '%: %', NEW.key, why USING ERRCODE = '22023'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contract_settings_bounds ON public.contract_settings;
CREATE TRIGGER trg_contract_settings_bounds BEFORE INSERT OR UPDATE ON public.contract_settings
    FOR EACH ROW EXECUTE FUNCTION public.trg_contract_settings_bounds();

CREATE OR REPLACE FUNCTION public.trg_contract_settings_audit() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    who TEXT;
    g   TEXT;
    p   TEXT;
BEGIN
    SELECT c.actor, c.grp, c.preset INTO who, g, p FROM public.settings_audit_context c WHERE c.txid = txid_current();
    IF who IS NULL THEN
        who := 'db role ' || session_user || ' (a direct write)';
        g := NULL; p := NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        INSERT INTO public.settings_admin_audit (actor, action, key, old_value, new_value, grp, preset)
        VALUES (who, 'clear', OLD.key, OLD.value, NULL, g, p);
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO public.settings_admin_audit (actor, action, key, old_value, new_value, grp, preset)
        VALUES (who, 'set', NEW.key, NULL, NEW.value, g, p);
    ELSIF OLD.value IS DISTINCT FROM NEW.value THEN
        INSERT INTO public.settings_admin_audit (actor, action, key, old_value, new_value, grp, preset)
        VALUES (who, 'set', NEW.key, OLD.value, NEW.value, g, p);
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_contract_settings_bounds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_contract_settings_audit() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_contract_settings_audit ON public.contract_settings;
CREATE TRIGGER trg_contract_settings_audit AFTER INSERT OR UPDATE OR DELETE ON public.contract_settings
    FOR EACH ROW EXECUTE FUNCTION public.trg_contract_settings_audit();

-- ── 5. the presets ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings_limit_groups (
    grp      TEXT PRIMARY KEY CHECK (grp ~ '^[a-z][a-z_]*$'),
    position INT  NOT NULL,
    label    TEXT NOT NULL,
    help     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS public.settings_limit_presets (
    grp      TEXT NOT NULL REFERENCES public.settings_limit_groups (grp) ON DELETE CASCADE,
    preset   TEXT NOT NULL CHECK (preset ~ '^[a-z][a-z_]*$'),
    position INT  NOT NULL,
    label    TEXT NOT NULL,
    help     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (grp, preset)
);
CREATE TABLE IF NOT EXISTS public.settings_limit_preset_values (
    grp    TEXT NOT NULL,
    preset TEXT NOT NULL,
    key    TEXT NOT NULL REFERENCES public.settings_keys (key) ON DELETE CASCADE,
    value  JSONB NOT NULL,
    PRIMARY KEY (grp, preset, key),
    FOREIGN KEY (grp, preset) REFERENCES public.settings_limit_presets (grp, preset) ON DELETE CASCADE
);

INSERT INTO public.settings_limit_groups (grp, position, label, help) VALUES
    ('run_size', 10, 'How big a research run is',
        'Pages read, search rounds, time and search hits per run. A bigger run takes longer and uses more GPU and network, for everyone.'),
    ('judgement', 20, 'How strict research is about evidence',
        'The confidence a hit needs to be used, and how far a stored claim may be from the question and still be reused. A lower bar admits weaker sources.'),
    ('curator', 30, 'How new claims are filed into threads',
        'Thread candidates, the confidence to start a new thread, and the distances for merging and for contradiction checks. These change how claims group.')
ON CONFLICT (grp) DO UPDATE SET position = EXCLUDED.position, label = EXCLUDED.label, help = EXCLUDED.help;

INSERT INTO public.settings_limit_presets (grp, preset, position, label, help) VALUES
    ('run_size', 'small',    10, 'Small',    'Quicker, lighter runs.'),
    ('run_size', 'standard', 20, 'Standard', 'The deployed defaults: what runs when nothing is chosen.'),
    ('run_size', 'large',    30, 'Large',    'Longer runs that read more.'),
    ('judgement', 'strict',   10, 'Strict',   'A higher bar for a source or a stored claim.'),
    ('judgement', 'standard', 20, 'Standard', 'The deployed defaults: what runs when nothing is chosen.'),
    ('judgement', 'open',     30, 'Open',     'A lower bar: weaker evidence gets through as a lead.'),
    ('curator', 'careful',  10, 'Careful',  'Fewer, tighter threads.'),
    ('curator', 'standard', 20, 'Standard', 'The deployed defaults: what runs when nothing is chosen.'),
    ('curator', 'broad',    30, 'Broad',    'More candidates, looser grouping.')
ON CONFLICT (grp, preset) DO UPDATE SET position = EXCLUDED.position, label = EXCLUDED.label, help = EXCLUDED.help;

-- the documented values (the table the test compares with); a re-run puts them back
DELETE FROM public.settings_limit_preset_values;
INSERT INTO public.settings_limit_preset_values (grp, preset, key, value) VALUES
    ('run_size', 'small',    'research.max_fetch', '24'),        ('run_size', 'small',    'research.max_fetch_timeouts', '20'),
    ('run_size', 'small',    'research.max_rounds', '2'),        ('run_size', 'small',    'research.relevant_target', '5'),
    ('run_size', 'small',    'research.max_wall_ms', '300000'),  ('run_size', 'small',    'research.search_k', '6'),
    ('run_size', 'small',    'research.kb_sources_k', '4'),
    ('run_size', 'standard', 'research.max_fetch', '80'),        ('run_size', 'standard', 'research.max_fetch_timeouts', '40'),
    ('run_size', 'standard', 'research.max_rounds', '3'),        ('run_size', 'standard', 'research.relevant_target', '8'),
    ('run_size', 'standard', 'research.max_wall_ms', '900000'),  ('run_size', 'standard', 'research.search_k', '8'),
    ('run_size', 'standard', 'research.kb_sources_k', '6'),
    ('run_size', 'large',    'research.max_fetch', '120'),       ('run_size', 'large',    'research.max_fetch_timeouts', '60'),
    ('run_size', 'large',    'research.max_rounds', '4'),        ('run_size', 'large',    'research.relevant_target', '12'),
    ('run_size', 'large',    'research.max_wall_ms', '1500000'),  ('run_size', 'large',    'research.search_k', '12'),
    ('run_size', 'large',    'research.kb_sources_k', '10'),
    ('judgement', 'strict',   'research.confidence_floor', '0.65'), ('judgement', 'strict',   'research.reuse_max_distance', '0.45'),
    ('judgement', 'standard', 'research.confidence_floor', '0.50'), ('judgement', 'standard', 'research.reuse_max_distance', '0.55'),
    ('judgement', 'open',     'research.confidence_floor', '0.40'), ('judgement', 'open',     'research.reuse_max_distance', '0.62'),
    ('curator', 'careful',  'curator.shortlist_k', '4'), ('curator', 'careful',  'curator.new_thread_min_confidence', '0.70'),
    ('curator', 'careful',  'curator.merge_floor_distance', '0.35'), ('curator', 'careful',  'curator.conflict_distance', '0.20'),
    ('curator', 'standard', 'curator.shortlist_k', '5'), ('curator', 'standard', 'curator.new_thread_min_confidence', '0.60'),
    ('curator', 'standard', 'curator.merge_floor_distance', '0.45'), ('curator', 'standard', 'curator.conflict_distance', '0.25'),
    ('curator', 'broad',    'curator.shortlist_k', '8'), ('curator', 'broad',    'curator.new_thread_min_confidence', '0.50'),
    ('curator', 'broad',    'curator.merge_floor_distance', '0.55'), ('curator', 'broad',    'curator.conflict_distance', '0.32');

-- every preset of a group names the same keys, and every value is inside its key's range (a bad edit of this file stops here)
DO $$
DECLARE bad TEXT;
BEGIN
    SELECT string_agg(DISTINCT p.grp || '/' || p.preset, ', ') INTO bad
      FROM public.settings_limit_presets p
     WHERE (SELECT count(*) FROM public.settings_limit_preset_values v WHERE v.grp = p.grp AND v.preset = p.preset)
        <> (SELECT count(DISTINCT v.key) FROM public.settings_limit_preset_values v WHERE v.grp = p.grp);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'settings defaults: presets of one group name different keys: %', bad; END IF;
    SELECT string_agg(v.grp || '/' || v.preset || '/' || v.key, ', ') INTO bad
      FROM public.settings_limit_preset_values v WHERE public.setting_problem(NULL, v.key, v.value) IS NOT NULL;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'settings defaults: preset values outside their range: %', bad; END IF;
END $$;

-- read-only for the app: the presets are written by migrations only
DO $$
DECLARE t TEXT; r RECORD;
BEGIN
    FOREACH t IN ARRAY ARRAY['settings_limit_groups', 'settings_limit_presets', 'settings_limit_preset_values', 'settings_user_ceilings'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO ob_workbench USING (true)', t || '_read', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE cl.oid = ('public.' || t)::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner
        LOOP
            EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r.grantee);
        END LOOP;
        EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
        EXECUTE format('GRANT SELECT ON public.%I TO ob_workbench', t);
    END LOOP;
END $$;
-- ── 6. the admin write functions: ob_workbench alone ────────────────────────────────────────────
-- Which preset the stored values match: the group's preset whose every key equals the key's effective value (stored, else the
-- code default); 'custom' when none does (a value the presets do not name, e.g. written directly); nothing is rewritten.
CREATE OR REPLACE FUNCTION public.settings_limits_current(p_grp TEXT) RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT p.preset FROM public.settings_limit_presets p
         WHERE p.grp = p_grp
           AND NOT EXISTS (
               SELECT 1 FROM public.settings_limit_preset_values v JOIN public.settings_keys k ON k.key = v.key
                WHERE v.grp = p.grp AND v.preset = p.preset
                  AND v.value IS DISTINCT FROM COALESCE((SELECT c.value FROM public.contract_settings c WHERE c.key = v.key), k.default_value))
         ORDER BY p.position LIMIT 1), 'custom');
$$;

-- apply one preset: every key of it, in this one transaction, each judged against its range; returns how many keys changed
CREATE OR REPLACE FUNCTION public.settings_limits_apply(p_actor TEXT, p_grp TEXT, p_preset TEXT) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v   RECORD;
    n   INT := 0;
    c   INT;
    why TEXT;
BEGIN
    IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'an actor is required' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.settings_limit_presets WHERE grp = p_grp AND preset = p_preset) THEN
        RAISE EXCEPTION 'there is no preset % in %', p_preset, p_grp USING ERRCODE = 'P0002';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('settings_limits' || chr(31) || p_grp, 0));
    INSERT INTO public.settings_audit_context (txid, actor, grp, preset) VALUES (txid_current(), p_actor, p_grp, p_preset)
    ON CONFLICT (txid) DO UPDATE SET actor = EXCLUDED.actor, grp = EXCLUDED.grp, preset = EXCLUDED.preset;
    FOR v IN SELECT key, value FROM public.settings_limit_preset_values WHERE grp = p_grp AND preset = p_preset ORDER BY key LOOP
        why := public.setting_problem(NULL, v.key, v.value);
        IF why IS NOT NULL THEN RAISE EXCEPTION '%: %', v.key, why USING ERRCODE = '22023'; END IF;
        INSERT INTO public.contract_settings (key, value, updated_by) VALUES (v.key, v.value, p_actor)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = public.contract_settings.version + 1,
               updated_at = now(), updated_by = EXCLUDED.updated_by
         WHERE public.contract_settings.value IS DISTINCT FROM EXCLUDED.value;
        GET DIAGNOSTICS c = ROW_COUNT;
        n := n + c;
    END LOOP;
    DELETE FROM public.settings_audit_context WHERE txid = txid_current();
    RETURN n;
END;
$$;

-- take a group's stored values away: the services use their env values again; returns how many were stored
CREATE OR REPLACE FUNCTION public.settings_limits_reset(p_actor TEXT, p_grp TEXT) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE n INT;
BEGIN
    IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'an actor is required' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.settings_limit_groups WHERE grp = p_grp) THEN
        RAISE EXCEPTION 'there is no group %', p_grp USING ERRCODE = 'P0002';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('settings_limits' || chr(31) || p_grp, 0));
    INSERT INTO public.settings_audit_context (txid, actor, grp, preset) VALUES (txid_current(), p_actor, p_grp, 'env')
    ON CONFLICT (txid) DO UPDATE SET actor = EXCLUDED.actor, grp = EXCLUDED.grp, preset = EXCLUDED.preset;
    DELETE FROM public.contract_settings WHERE key IN (SELECT DISTINCT key FROM public.settings_limit_preset_values WHERE grp = p_grp);
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM public.settings_audit_context WHERE txid = txid_current();
    RETURN n;
END;
$$;

-- clear one editable shared setting (the existing admin DELETE), so its removal is logged with who removed it
CREATE OR REPLACE FUNCTION public.admin_setting_clear(p_actor TEXT, p_key TEXT) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE n INT;
BEGIN
    IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'an actor is required' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.settings_audit_context (txid, actor) VALUES (txid_current(), p_actor)
    ON CONFLICT (txid) DO UPDATE SET actor = EXCLUDED.actor, grp = NULL, preset = NULL;
    DELETE FROM public.contract_settings WHERE key = p_key;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM public.settings_audit_context WHERE txid = txid_current();
    RETURN n;
END;
$$;

-- set one shared setting (the contract door's and the admin PUT's write), so the change is logged with the admin who made it
CREATE OR REPLACE FUNCTION public.admin_setting_write(p_actor TEXT, p_key TEXT, p_value JSONB) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'an actor is required' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.settings_audit_context (txid, actor) VALUES (txid_current(), p_actor)
    ON CONFLICT (txid) DO UPDATE SET actor = EXCLUDED.actor, grp = NULL, preset = NULL;
    INSERT INTO public.contract_settings (key, value, updated_by) VALUES (p_key, p_value, p_actor)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = public.contract_settings.version + 1,
           updated_at = now(), updated_by = EXCLUDED.updated_by;
    DELETE FROM public.settings_audit_context WHERE txid = txid_current();
END;
$$;

DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY['public.settings_limits_current(text)', 'public.settings_limits_apply(text,text,text)',
                             'public.settings_limits_reset(text,text)', 'public.admin_setting_clear(text,text)', 'public.admin_setting_write(text,text,jsonb)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
        END LOOP;
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_workbench', f);
    END LOOP;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
