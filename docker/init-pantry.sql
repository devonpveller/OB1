-- Pantry / meal-planner schema (fork-local; item pantry-core of pantry-meal-planner).
--
-- NEW FILE ONLY. Nothing upstream is edited. The only touches on upstream objects are
--   * ALTER TABLE recipes / meal_plans ... ADD COLUMN IF NOT EXISTS   (new columns)
--   * additive RLS policies for the least-privilege role below on recipes, meal_plans,
--     shopping_lists (upstream's own policies are untouched)
--
-- IDEMPOTENT: apply it twice in a row, no error, no duplicate. Everything is IF NOT EXISTS /
-- CREATE OR REPLACE / catalogue-guarded. Fresh volume: mounted as 210-init-pantry.sql
-- (initdb runs only on an empty volume). Live DB: applied by hand with psql, as the
-- operator's gated deploy:
--     psql -U postgres -d openbrain -v ON_ERROR_STOP=1 \
--          -v pantry_db_password="$PANTRY_DB_PASSWORD" -f init-pantry.sql
-- (the -v is optional: without it the role exists with NO password and cannot log in until
--  `ALTER ROLE ob_pantry PASSWORD '...'` is run, the same out-of-band step as ob_app_memory.)
--
-- Requires init.sql + init-extensions.sql applied first (recipes, meal_plans, shopping_lists).
-- Scoping: every table carries user_id UUID NOT NULL; the service filters on it (same
-- app-level scoping as the upstream extensions; auth.uid() is a NULL shim in this database).

-- ============================================================
-- Unit helpers (pure; mirror the service's src/units.ts - a test asserts they agree)
-- ============================================================
CREATE OR REPLACE FUNCTION pantry_unit_dim(u text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(u, ''))
    WHEN 'g' THEN 'mass' WHEN 'kg' THEN 'mass' WHEN 'mg' THEN 'mass'
    WHEN 'oz' THEN 'mass' WHEN 'lb' THEN 'mass'
    WHEN 'ml' THEN 'volume' WHEN 'l' THEN 'volume' WHEN 'tsp' THEN 'volume'
    WHEN 'tbsp' THEN 'volume' WHEN 'cup' THEN 'volume' WHEN 'fl_oz' THEN 'volume'
    WHEN 'count' THEN 'count' WHEN 'each' THEN 'count' WHEN 'pc' THEN 'count'
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION pantry_unit_factor(u text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(u, ''))
    WHEN 'g' THEN 1::numeric WHEN 'kg' THEN 1000::numeric WHEN 'mg' THEN 0.001::numeric
    WHEN 'oz' THEN 28.349523125::numeric WHEN 'lb' THEN 453.59237::numeric
    WHEN 'ml' THEN 1::numeric WHEN 'l' THEN 1000::numeric
    WHEN 'tsp' THEN 4.92892159375::numeric WHEN 'tbsp' THEN 14.78676478125::numeric
    WHEN 'cup' THEN 236.5882365::numeric WHEN 'fl_oz' THEN 29.5735295625::numeric
    WHEN 'count' THEN 1::numeric WHEN 'each' THEN 1::numeric WHEN 'pc' THEN 1::numeric
    ELSE NULL END
$$;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS pantry_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    category TEXT,
    kind TEXT NOT NULL DEFAULT 'counted' CHECK (kind IN ('counted', 'staple')),
    quantity NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    unit TEXT CHECK (unit IS NULL OR unit IN ('g', 'ml', 'count')),
    level TEXT CHECK (level IS NULL OR level IN ('plenty', 'low', 'out')),
    location TEXT,
    expires_on DATE,
    allergens TEXT[] NOT NULL DEFAULT '{}',
    may_contain TEXT[] NOT NULL DEFAULT '{}',
    removed_at TIMESTAMPTZ,                       -- soft remove (ledger/audit rows keep pointing here)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pantry_items_user_name
    ON pantry_items (user_id, lower(name)) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pantry_items_user_category ON pantry_items (user_id, category);

CREATE TABLE IF NOT EXISTS pantry_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    label TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('adult', 'child')),
    birth_month TEXT CHECK (birth_month IS NULL OR birth_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    allergies TEXT[] NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pantry_people_user ON pantry_people (user_id);

CREATE TABLE IF NOT EXISTS pantry_settings (
    user_id UUID PRIMARY KEY,
    default_servings JSONB NOT NULL DEFAULT '{"adults": 2, "children": 1}',
    portions JSONB NOT NULL DEFAULT '{"adult": 1.0, "child": 0.5}',
    week_start_day TEXT NOT NULL DEFAULT 'monday',
    child_cooldown_days INTEGER NOT NULL DEFAULT 7,
    use_soon_days INTEGER NOT NULL DEFAULT 5,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pantry_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('csv', 'xlsx', 'chat')),
    file_name TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    items_checked INTEGER NOT NULL DEFAULT 0,
    items_changed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pantry_audits_user_at ON pantry_audits (user_id, at);

CREATE TABLE IF NOT EXISTS pantry_audit_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id UUID NOT NULL REFERENCES pantry_audits(id),
    user_id UUID NOT NULL,
    item_id UUID NOT NULL REFERENCES pantry_items(id),
    expected NUMERIC,
    actual NUMERIC,
    delta NUMERIC,
    unit TEXT,
    expected_level TEXT,
    actual_level TEXT
);
CREATE INDEX IF NOT EXISTS idx_pantry_audit_lines_audit ON pantry_audit_lines (audit_id);
CREATE INDEX IF NOT EXISTS idx_pantry_audit_lines_item ON pantry_audit_lines (user_id, item_id);

-- A preview is the service's own scratch row: what an import WOULD do, held until commit.
-- It is never stock. Expires after 24 h.
CREATE TABLE IF NOT EXISTS pantry_audit_previews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('csv', 'xlsx', 'chat')),
    file_name TEXT,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
    committed_at TIMESTAMPTZ,
    audit_id UUID
);

-- upstream recipes / meal_plans / shopping_lists exist from init-extensions.sql; new columns only.
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS theme TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS current_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS draft BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'household'
    CHECK (source IN ('generated', 'household'));
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS rotation BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'cooked', 'skipped'));
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS leftovers_of UUID;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS cook_event_id UUID;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS guest_context JSONB;
-- upstream meal_plans.servings is INTEGER and its week_start/day_of_week are NOT NULL; the
-- pantry needs fractional portions (2.5) and an exact date, so it adds both beside them.
-- Upstream rows have plan_date / servings_exact NULL and are therefore never reserved.
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS plan_date DATE;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS servings_exact NUMERIC;
CREATE INDEX IF NOT EXISTS idx_meal_plans_user_plan_date ON meal_plans (user_id, plan_date);

CREATE TABLE IF NOT EXISTS pantry_recipe_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    recipe_id UUID NOT NULL REFERENCES recipes(id),
    revision INTEGER NOT NULL,
    servings INTEGER,
    ingredients JSONB NOT NULL DEFAULT '[]',
    instructions JSONB NOT NULL DEFAULT '[]',
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (recipe_id, revision)
);

CREATE TABLE IF NOT EXISTS pantry_cook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    recipe_id UUID REFERENCES recipes(id),
    recipe_revision INTEGER,
    meal_plan_id UUID,
    servings NUMERIC NOT NULL,
    guest_context JSONB,
    logged_after BOOLEAN NOT NULL DEFAULT false,
    cooked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone_at TIMESTAMPTZ,
    shortfalls JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pantry_cook_events_user ON pantry_cook_events (user_id, cooked_at);

-- Append-only ledger: every quantity (or staple level) change is a row. Sum of deltas per
-- item over time = the item's quantity movement; an undo is the exact opposite rows.
CREATE TABLE IF NOT EXISTS pantry_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    item_id UUID NOT NULL REFERENCES pantry_items(id),
    delta NUMERIC NOT NULL DEFAULT 0,
    quantity_before NUMERIC,
    quantity_after NUMERIC,
    level_before TEXT,
    level_after TEXT,
    reason TEXT NOT NULL CHECK (reason IN ('cook', 'correct', 'restock', 'audit', 'manual', 'undo')),
    cook_event_id UUID,
    shopping_list_id UUID,
    audit_id UUID,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_pantry_adjustments_item ON pantry_adjustments (user_id, item_id, at);
CREATE INDEX IF NOT EXISTS idx_pantry_adjustments_cook ON pantry_adjustments (cook_event_id);

-- ---- tables pantry-taste will use (created here so the schema ships once) ----
CREATE TABLE IF NOT EXISTS pantry_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    cook_event_id UUID NOT NULL REFERENCES pantry_cook_events(id),
    recipe_id UUID,
    theme TEXT,
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    liked BOOLEAN,
    why TEXT,
    change TEXT,
    who TEXT NOT NULL DEFAULT 'all' CHECK (who IN ('adult', 'child', 'all')),
    curiosity_q TEXT,
    curiosity_a TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pantry_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    statement TEXT NOT NULL,
    strength TEXT NOT NULL CHECK (strength IN ('hard', 'contextual', 'soft')),
    subject TEXT NOT NULL,
    context TEXT,
    reason TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('recipe', 'theme', 'always')),
    who TEXT NOT NULL DEFAULT 'adult' CHECK (who IN ('adult', 'child', 'all')),
    evidence JSONB NOT NULL DEFAULT '[]',
    confirmed BOOLEAN NOT NULL DEFAULT false,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pantry_taste_hypotheses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    statement TEXT NOT NULL,
    support INTEGER NOT NULL DEFAULT 0,
    against INTEGER NOT NULL DEFAULT 0,
    last_tested TIMESTAMPTZ,
    evidence UUID[] NOT NULL DEFAULT '{}',          -- evaluation ids already counted (no double count)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pantry_explored (
    user_id UUID NOT NULL,
    dimension TEXT NOT NULL CHECK (dimension IN ('cuisine', 'technique', 'ingredient')),
    value TEXT NOT NULL,
    first_tried TIMESTAMPTZ NOT NULL DEFAULT now(),
    times INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, dimension, value)
);

CREATE TABLE IF NOT EXISTS pantry_exposures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    who UUID,                                      -- pantry_people.id when known
    subject TEXT NOT NULL,
    cook_event_id UUID,
    reaction TEXT NOT NULL CHECK (reaction IN ('refused', 'tolerated', 'liked')),
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pantry_exposures_user_subject ON pantry_exposures (user_id, subject, at);

-- ============================================================
-- View: on hand - reserved by planned, uncooked dinners (D4)
-- ============================================================
-- reserved = sum over meal_plans.status='planned' (recipe plans, not leftovers) of
--   ingredient quantity (converted to the item's unit, same dimension only)
--   x servings_exact / recipe.servings.   Staples and unconvertible lines reserve nothing.
CREATE OR REPLACE VIEW pantry_available AS
SELECT i.id AS item_id,
       i.user_id,
       i.name,
       i.kind,
       i.unit,
       i.quantity,
       COALESCE(r.reserved, 0) AS reserved,
       i.quantity - COALESCE(r.reserved, 0) AS available
  FROM pantry_items i
  LEFT JOIN (
        SELECT pi2.id AS item_id, pi2.user_id,
               SUM(b.need_base / pantry_unit_factor(pi2.unit)) AS reserved
          FROM (
            SELECT mp.user_id,
                   CASE WHEN e.j->>'pantry_item_id' ~ '^[0-9a-fA-F-]{36}$'
                        THEN (e.j->>'pantry_item_id')::uuid END AS item_id,
                   CASE WHEN e.j->>'quantity' ~ '^[0-9]+(\.[0-9]+)?$'
                         AND coalesce(e.j->>'staple', 'false') <> 'true'
                         AND rc.servings IS NOT NULL AND rc.servings > 0
                        THEN (e.j->>'quantity')::numeric
                             * pantry_unit_factor(coalesce(nullif(e.j->>'unit', ''), 'count'))
                             * (mp.servings_exact / rc.servings)
                   END AS need_base,
                   coalesce(nullif(e.j->>'unit', ''), 'count') AS ing_unit
              FROM meal_plans mp
              JOIN recipes rc ON rc.id = mp.recipe_id
              CROSS JOIN LATERAL jsonb_array_elements(
                     CASE WHEN jsonb_typeof(rc.ingredients) = 'array' THEN rc.ingredients ELSE '[]'::jsonb END
                   ) AS e(j)
             WHERE mp.status = 'planned'
               AND mp.leftovers_of IS NULL
               AND mp.servings_exact IS NOT NULL
          ) b
          JOIN pantry_items pi2 ON pi2.id = b.item_id AND pi2.user_id = b.user_id
         WHERE pi2.kind = 'counted'
           AND b.need_base IS NOT NULL
           AND pantry_unit_dim(b.ing_unit) IS NOT DISTINCT FROM pantry_unit_dim(pi2.unit)
           AND pantry_unit_dim(pi2.unit) IS NOT NULL
         GROUP BY pi2.id, pi2.user_id
  ) r ON r.item_id = i.id AND r.user_id = i.user_id
 WHERE i.removed_at IS NULL;

-- ============================================================
-- Least-privilege role for the service (ob_pantry)
-- ============================================================
-- Grants: pantry_* tables + view, and recipes / meal_plans / shopping_lists. Nothing else:
-- no thoughts, no sources, no graph, no schema creation, no superuser, no BYPASSRLS.
-- (Same shape as ob_app_memory: created here, password set out of band.)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_pantry') THEN
        CREATE ROLE ob_pantry LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

-- optional: `psql -v pantry_db_password=...` sets/rotates the password in the same pass.
\if :{?pantry_db_password}
ALTER ROLE ob_pantry PASSWORD :'pantry_db_password';
\endif

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ob_pantry;
GRANT USAGE ON SCHEMA public TO ob_pantry;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    pantry_items, pantry_people, pantry_settings, pantry_audits, pantry_audit_lines,
    pantry_audit_previews, pantry_recipe_revisions, pantry_cook_events, pantry_adjustments,
    pantry_evaluations, pantry_preferences, pantry_taste_hypotheses, pantry_explored,
    pantry_exposures
  TO ob_pantry;
GRANT SELECT ON pantry_available TO ob_pantry;
GRANT SELECT, INSERT, UPDATE, DELETE ON recipes, meal_plans, shopping_lists TO ob_pantry;
GRANT EXECUTE ON FUNCTION pantry_unit_dim(text), pantry_unit_factor(text) TO ob_pantry;

-- Upstream RLS on those three tables compares auth.uid() (a NULL shim here), so a
-- non-superuser role would see zero rows. Add ONE permissive policy per table for this role
-- only; upstream's policies and every other role are unchanged. Row scoping stays in the
-- service (user_id filter), as for the upstream extensions server.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['recipes', 'meal_plans', 'shopping_lists'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND tablename = t
                          AND policyname = 'pantry_service_all') THEN
            EXECUTE format(
              'CREATE POLICY pantry_service_all ON %I FOR ALL TO ob_pantry USING (true) WITH CHECK (true)', t);
        END IF;
    END LOOP;
END $$;
