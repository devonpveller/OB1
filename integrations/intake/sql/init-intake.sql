-- init-intake.sql
--
-- THE INTAKE STORAGE ZONES AND THE TRUST COLUMN (security-hardening-2026-10, build item I1).
--
-- Fork-owned (operator D23; ../FORK-OWNED.md lists every name this file creates). Nothing
-- upstream is edited: the only touches on upstream objects are two columns added
-- IF NOT EXISTS to public.sources and public.thoughts, their CHECK / FK / index, one trigger
-- per table, two additive RLS policies on thoughts for the intake role, and column grants.
--
-- WHAT IT BUILDS
--   bronze  intake.raw_items  raw bytes + envelope. Readable by the `intake` role ONLY; no
--                             model-facing role has USAGE on the schema (DESIGN section 4).
--   silver  intake.items      verdict, reasons, counts, scores, classifier_version.
--           intake.discards   the record kept when an item is discarded as injected
--                             (source, connector, external_id, raw_sha256, reason, scores).
--           sources.screen_verdict / thoughts.screen_verdict
--                             'clean' | 'suspicious' | 'unscreened' | 'internal'
--           sources.intake_item_id / thoughts.intake_item_id  -> intake.items(id)
--   role    intake            the only role that may set clean/suspicious or intake_item_id,
--                             and only on a connection that LOGGED IN as intake (AFTER ROW
--                             trigger zzz_intake_screen_verdict_authority, section 5).
--
-- Retention (30 d bronze, 365 d discards, 24 h second-opinion cap; operator D27) is config
-- in ../intake/config.py. NOTHING HERE PURGES: the purge jobs are build item I4.
-- metadata.injection_screen (written by research, read by nothing) is NOT touched; it is
-- retired in a later item once the writers move (I8).
--
-- ROLLOUT ORDER (DESIGN section 4, the 2026-09-02 lesson: a constraint that lands before its
-- writers turns a deploy into an outage):
--   1. the column, WITH a default, so every deployed writer keeps working unchanged;
--   2. the writers (later items I5-I8) - they state the label;
--   3. the constraint.
-- This file lands steps 1 AND 3 together, and that is safe for one reason that is checked, not
-- assumed: no deployed writer writes screen_verdict at all (the column does not exist before
-- this file), so every write from them takes the DEFAULT, and the DEFAULT satisfies the CHECK.
-- The CHECK therefore refuses only a writer that names a bad value - which is its job.
--
-- DEFAULT IS 'unscreened', NEVER 'internal'. An unconverted EXTERNAL writer (ingest_url,
-- research staging, gmail) inserting after this file must not come out labelled as trusted
-- stack output. The fail-safe direction is "external until a writer says otherwise".
--
-- APPLY
--   Fresh volume: mounted by docker/docker-compose.yml as 220-init-intake.sql (initdb runs it
--   once, on an empty volume). Live DB: by hand, as the operator's gated deploy:
--     psql -U postgres -d openbrain -v ON_ERROR_STOP=1 \
--          [-v intake_db_password="$INTAKE_DB_PASSWORD"] -f init-intake.sql
--   Without -v the role exists with NO password and cannot log in until
--   `ALTER ROLE intake PASSWORD '...'` is run - the same out-of-band step as ob_app_memory
--   and ob_pantry.
--
-- IDEMPOTENT: re-running changes nothing (the backfill runs only in the run that ADDS the
-- column, and only ONCE per database - section 3 - so rows written since keep the label their
-- writer gave them, even across a revert + re-apply).
-- ALSO CHANGES (section 5b): TRIGGER and REFERENCES on sources/thoughts are revoked from every
-- non-owner grantee (live: service_role held TRIGGER on sources); recorded in
-- intake.migration_ledger and restored by the revert.
-- REVERT: revert-intake.sql, beside this file.
-- TESTS: ../tests/db/run_db_tests.py (throwaway postgres, live schema-only dump).

\set ON_ERROR_STOP 1

BEGIN;

-- ==========================================================================================
-- 0. PRECONDITIONS
-- ==========================================================================================
DO $$
BEGIN
  IF to_regclass('public.sources') IS NULL OR to_regclass('public.thoughts') IS NULL THEN
    RAISE EXCEPTION 'init-intake: public.sources and public.thoughts must exist (init.sql, '
                    'init-sources.sql). This file labels existing tables; it does not build them.';
  END IF;
  IF to_regprocedure('public.gen_random_uuid()') IS NULL
     AND to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'init-intake: gen_random_uuid() is missing.';
  END IF;
  -- A role named intake that is a superuser or BYPASSRLS would make every check below moot.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'init-intake: role intake exists and is SUPERUSER or BYPASSRLS. Refusing.';
  END IF;
END $$;

-- ==========================================================================================
-- 1. THE ROLE
-- ==========================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake') THEN
    CREATE ROLE intake LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT;
  END IF;
END $$;
\if :{?intake_db_password}
ALTER ROLE intake PASSWORD :'intake_db_password';
\endif

-- ==========================================================================================
-- 2. THE SCHEMA: bronze + silver. Owned by postgres; intake gets DML, nobody else gets USAGE.
-- ==========================================================================================
CREATE SCHEMA IF NOT EXISTS intake AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA intake FROM PUBLIC;

CREATE TABLE IF NOT EXISTS intake.raw_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL CHECK (source <> ''),
  connector     TEXT NOT NULL CHECK (connector <> ''),
  external_id   TEXT NOT NULL CHECK (external_id <> ''),
  raw_sha256    TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at    TIMESTAMPTZ,
  content_type  TEXT NOT NULL CHECK (content_type <> ''),
  raw           BYTEA NOT NULL CHECK (octet_length(raw) <= 5242880),   -- DESIGN 3.1: raw <= 5 MB
  envelope      JSONB NOT NULL DEFAULT '{}'::jsonb,                    -- metadata{}, links[]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- DESIGN 3.2 idempotency key: a repeat is the same row; a new hash is a new revision.
  CONSTRAINT raw_items_idempotency_key UNIQUE (source, external_id, raw_sha256)
);
COMMENT ON TABLE intake.raw_items IS
  'BRONZE (intake I1). Raw external content + envelope, exactly as a connector delivered it. Readable by the intake role ONLY - no model-facing role may read it. Clean raw kept 30 days (config BRONZE_RETENTION_DAYS; purge job is I4).';

CREATE TABLE IF NOT EXISTS intake.items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_item_id         UUID REFERENCES intake.raw_items(id) ON DELETE SET NULL,  -- bronze is purged, silver stays
  source              TEXT NOT NULL CHECK (source <> ''),
  connector           TEXT NOT NULL CHECK (connector <> ''),
  external_id         TEXT NOT NULL CHECK (external_id <> ''),
  raw_sha256          TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','done','rejected')),
  -- NULL while pending. 'injected' is a legal VERDICT here (it is what intake decided) but can
  -- never reach sources/thoughts: their CHECK below has no such value.
  verdict             TEXT CHECK (verdict IN ('clean','suspicious','injected','unscreened')),
  reasons             TEXT[] NOT NULL DEFAULT '{}',
  counts              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- stripped: hidden_elements, cf, tag, bidi, controls
  scores              JSONB NOT NULL DEFAULT '{}'::jsonb,   -- classifier max chunk score etc.
  classifier_version  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ,
  CONSTRAINT items_idempotency_key UNIQUE (source, external_id, raw_sha256),
  CONSTRAINT items_done_has_verdict CHECK (status <> 'done' OR verdict IS NOT NULL)
);
COMMENT ON TABLE intake.items IS
  'SILVER (intake I1). One row per screened item revision: verdict, reasons, stripped counts, scores, classifier_version. sources/thoughts.intake_item_id points here.';

CREATE TABLE IF NOT EXISTS intake.discards (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source <> ''),
  connector    TEXT NOT NULL CHECK (connector <> ''),
  external_id  TEXT NOT NULL CHECK (external_id <> ''),
  raw_sha256   TEXT NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  reason       TEXT NOT NULL CHECK (reason <> ''),
  scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE intake.discards IS
  'The record kept when an item is discarded as injected (D2): no raw, no text. Kept 365 days (config DISCARD_RETENTION_DAYS; purge job is I4).';

-- What this migration changed outside its own objects, so the revert can put it back exactly.
-- postgres only: no grant to intake (a row here makes the revert GRANT something).
CREATE TABLE IF NOT EXISTS intake.migration_ledger (
  kind         TEXT NOT NULL,
  detail       JSONB NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, detail)
);
COMMENT ON TABLE intake.migration_ledger IS
  'intake I1: privileges init-intake.sql revoked from upstream tables; revert-intake.sql re-grants them. postgres only.';

CREATE INDEX IF NOT EXISTS idx_intake_raw_items_created_at ON intake.raw_items (created_at);
CREATE INDEX IF NOT EXISTS idx_intake_items_status ON intake.items (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_intake_discards_created_at ON intake.discards (created_at);

REVOKE ALL ON ALL TABLES IN SCHEMA intake FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA intake FROM PUBLIC;
GRANT USAGE ON SCHEMA intake TO intake;
GRANT SELECT, INSERT, UPDATE, DELETE ON intake.raw_items, intake.items, intake.discards TO intake;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA intake TO intake;

-- ==========================================================================================
-- 3. THE COLUMNS - WITH A DEFAULT FIRST (rollout step 1), backfilled once
-- ==========================================================================================
-- THE ORIGIN RULE for rows that exist before this file (DESIGN section 4: stack-generated =
-- 'internal', external = 'unscreened'). Neither table has an origin column; origin is recorded
-- today only in content_type (sources) and in writer-stamped metadata keys. Derived from the
-- writers, 2026-10-15 (OB1 43d35fb, ai-stack 979567a2; file:line inventory in the I1 findings):
--
--   sources - 13 writer shapes, 2 of them stack-generated:
--     INTERNAL  content_type='research_synthesis' AND url IS NULL AND research_key IS NOT NULL
--               AND metadata.source='deep-research'      (/research/persist synthesis row,
--                                                         kubernetes-deployment/index.ts)
--     INTERNAL  content_type='podcast_transcript' AND metadata.source='daily-digest-podcast'
--               AND metadata has 'episode'               (digest podcast loop-close, our script)
--     everything else: ingest_url(s), capture_with_thread (caller- or fetch-supplied text),
--     research staging + repo-sync, grounding-backfiller (Wikipedia), research gathered
--     sources, workbench uploads / URL ingest, Open Notebook (incl. 'manual' pasted text).
--
--   thoughts - stack-generated when metadata says one of:
--     source='mcp' with no gmail_id/url/source_url key  (capture_thought, capture_idea - the
--                                                         operator's or an agent's own words)
--     source='agent-memory' with workspace_id           (agent-memory writeback)
--     source='agent-org' with event_id                  (agent-org audit mirror)
--     source IN ('user_note','ai_note') with note_path  (wiki note sync)
--     type='dossier' AND generated_by='recipes/entity-wiki/generate-wiki.mjs'
--     source_type='gmail_wiki' with gmail               (model-written summaries; operator
--                                                         clarification: summaries are internal)
--     everything else: gmail pull ('gmail'), the import recipes (chatgpt, perplexity, obsidian,
--     x_twitter_import, blogger_import, instagram_import, grok_import, google_activity, ...),
--     upstream-only sources ('agent_memory' with an underscore, 'dashboard'), no marker at all.
--
-- FAIL-SAFE BY CONSTRUCTION: 'internal' is an ALLOW-LIST of positive markers, each pinned by a
-- second key where one value alone is shared or forgeable; a row matching none of them, with
-- an unknown or missing marker, or with metadata NULL, is 'unscreened'. The error direction is
-- always "external content shown with its label", never "external content trusted".
-- KNOWN LIMIT: metadata.source is writer-stamped jsonb, and a local caller can set it through
-- metadata_extra; a forged marker on an EXISTING row is labelled internal by this backfill.
-- That is the reason the column now exists - from here on trust is the typed column, which
-- the trigger in section 5 guards. P6 re-screens legacy rows.
--
-- WRITES ONLY THE LABEL. The UPDATE runs with session_replication_role=replica (transaction-
-- local) so no USER trigger fires - in particular trg_sources_touch, which would otherwise
-- rewrite sources.updated_at on every labelled row. Rows whose label is 'unscreened' are not
-- touched at all: that is the column DEFAULT (a catalogue-only fast default, no table rewrite).
--
-- ONE-SHOT, RECORDED (round 2, tester F2). The backfill runs only in the run that ADDS the
-- column AND only if it has never run on this database before. The first run records itself
-- as a database-level setting, intake.backfill_done_at, which revert-intake.sql deliberately
-- leaves in place. Why: after a revert + re-apply, rows written between the first apply and
-- the revert carry whatever markers their writers stamped - including forged ones - and a
-- second backfill would promote them to 'internal'. So a re-apply after a revert labels every
-- row 'unscreened' (the fail-safe direction) unless the operator explicitly asks for the
-- marker rule again with  psql -v intake_rerun_backfill=1  (a decision, never a side effect).
-- To forget the record:  ALTER DATABASE openbrain RESET intake.backfill_done_at;
\if :{?intake_rerun_backfill}
SELECT set_config('intake.rerun_backfill', 'on', false);
\else
SELECT set_config('intake.rerun_backfill', 'off', false);
\endif
DO $$
DECLARE
  v_new_s BOOLEAN := NOT EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema='public' AND table_name='sources'
                                    AND column_name='screen_verdict');
  v_new_t BOOLEAN := NOT EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema='public' AND table_name='thoughts'
                                    AND column_name='screen_verdict');
  v_done  TEXT := (SELECT substr(c, length('intake.backfill_done_at=') + 1)
                     FROM pg_db_role_setting s
                     JOIN pg_database d ON d.oid = s.setdatabase AND d.datname = current_database()
                     CROSS JOIN unnest(s.setconfig) c
                    WHERE s.setrole = 0 AND c LIKE 'intake.backfill_done_at=%' LIMIT 1);
  v_rerun BOOLEAN := current_setting('intake.rerun_backfill', true) = 'on';
  v_run   BOOLEAN;
  v_n INT;
BEGIN
  IF v_new_s THEN
    ALTER TABLE public.sources ADD COLUMN screen_verdict TEXT DEFAULT 'unscreened';
  END IF;
  IF v_new_t THEN
    ALTER TABLE public.thoughts ADD COLUMN screen_verdict TEXT DEFAULT 'unscreened';
  END IF;
  v_run := (v_new_s OR v_new_t) AND (v_done IS NULL OR v_rerun);
  IF (v_new_s OR v_new_t) AND NOT v_run THEN
    RAISE NOTICE 'init-intake: the marker backfill already ran on this database (%); every '
                 'row stays unscreened. Re-run it only on purpose: -v intake_rerun_backfill=1', v_done;
  END IF;

  PERFORM set_config('session_replication_role', 'replica', true);
  IF v_new_s AND v_run THEN
    UPDATE public.sources s SET screen_verdict = 'internal'
     WHERE (s.content_type = 'research_synthesis' AND s.url IS NULL AND s.research_key IS NOT NULL
            AND s.metadata->>'source' = 'deep-research')
        OR (s.content_type = 'podcast_transcript'
            AND s.metadata->>'source' = 'daily-digest-podcast' AND s.metadata ? 'episode');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'init-intake: sources labelled internal: % (every other row: unscreened)', v_n;
  END IF;
  IF v_new_t AND v_run THEN
    UPDATE public.thoughts t SET screen_verdict = 'internal'
     WHERE (t.metadata->>'source' = 'mcp'                      -- capture_thought / capture_idea
            AND NOT (t.metadata ?| ARRAY['gmail_id','url','source_url']))  -- (D29 pending: cloud-origin mcp)
        OR (t.metadata->>'source' = 'agent-memory' AND t.metadata ? 'workspace_id')
        OR (t.metadata->>'source' = 'agent-org'    AND t.metadata ? 'event_id')
        OR (t.metadata->>'source' = 'user_note' AND t.metadata ? 'note_path')
        OR (t.metadata->>'source' = 'ai_note'   AND t.metadata ? 'note_path')     -- (D29 pending)
        OR (t.metadata->>'type' = 'dossier'
            AND t.metadata->>'generated_by' = 'recipes/entity-wiki/generate-wiki.mjs')
        OR (t.metadata->>'source_type' = 'gmail_wiki' AND t.metadata ? 'gmail'); -- (D29 pending)
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'init-intake: thoughts labelled internal: % (every other row: unscreened)', v_n;
  END IF;
  PERFORM set_config('session_replication_role', 'origin', true);
  IF v_run THEN
    EXECUTE format('ALTER DATABASE %I SET intake.backfill_done_at = %L',
                   current_database(), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  END IF;
END $$;

ALTER TABLE public.sources  ADD COLUMN IF NOT EXISTS intake_item_id UUID;
ALTER TABLE public.thoughts ADD COLUMN IF NOT EXISTS intake_item_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_intake_item_id_fkey'
                  AND conrelid = 'public.sources'::regclass) THEN
    ALTER TABLE public.sources ADD CONSTRAINT sources_intake_item_id_fkey
      FOREIGN KEY (intake_item_id) REFERENCES intake.items(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_intake_item_id_fkey'
                  AND conrelid = 'public.thoughts'::regclass) THEN
    ALTER TABLE public.thoughts ADD CONSTRAINT thoughts_intake_item_id_fkey
      FOREIGN KEY (intake_item_id) REFERENCES intake.items(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sources_intake_item_id  ON public.sources  (intake_item_id) WHERE intake_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_intake_item_id ON public.thoughts (intake_item_id) WHERE intake_item_id IS NOT NULL;

COMMENT ON COLUMN public.sources.screen_verdict IS
  'intake I1 trust label: clean | suspicious (set ONLY by the intake role - trigger zzz_intake_screen_verdict_authority) | unscreened (default; external, not screened) | internal (stack-generated). injected never lands here. Typed column, not jsonb; replaces metadata.injection_screen.';
COMMENT ON COLUMN public.thoughts.screen_verdict IS
  'intake I1 trust label: clean | suspicious (set ONLY by the intake role - trigger zzz_intake_screen_verdict_authority) | unscreened (default; external, not screened) | internal (stack-generated). injected never lands here.';
COMMENT ON COLUMN public.sources.intake_item_id IS 'intake I1: the intake.items row that screened this content; set only by the intake role.';
COMMENT ON COLUMN public.thoughts.intake_item_id IS 'intake I1: the intake.items row that screened this content; set only by the intake role.';

-- ==========================================================================================
-- 4. THE CONSTRAINT LAST (rollout step 3) - NOT NULL + CHECK, no 'injected'
-- ==========================================================================================
ALTER TABLE public.sources  ALTER COLUMN screen_verdict SET NOT NULL;
ALTER TABLE public.thoughts ALTER COLUMN screen_verdict SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_screen_verdict_check'
                  AND conrelid = 'public.sources'::regclass) THEN
    ALTER TABLE public.sources ADD CONSTRAINT sources_screen_verdict_check
      CHECK (screen_verdict IN ('clean','suspicious','unscreened','internal')) NOT VALID;
    ALTER TABLE public.sources VALIDATE CONSTRAINT sources_screen_verdict_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thoughts_screen_verdict_check'
                  AND conrelid = 'public.thoughts'::regclass) THEN
    ALTER TABLE public.thoughts ADD CONSTRAINT thoughts_screen_verdict_check
      CHECK (screen_verdict IN ('clean','suspicious','unscreened','internal')) NOT VALID;
    ALTER TABLE public.thoughts VALIDATE CONSTRAINT thoughts_screen_verdict_check;
  END IF;
END $$;

-- ==========================================================================================
-- 5. THE AUTHORITY TRIGGER - only the intake role decides trust
-- ==========================================================================================
-- Precedent: docker/init-agent-memory-column-authority.sql - trust lives in a TYPED COLUMN
-- the database enforces, not in jsonb a writer can stamp (C-F3: metadata.injection_screen is
-- written and read by nothing).
--
-- WHO IS "intake": current_user = 'intake' AND session_user = 'intake' - a connection that
-- LOGGED IN as intake. A `SET ROLE intake` does not count (round 2, tester F5): PostgREST
-- authenticates as postgres and switches to a JWT's role with SET LOCAL ROLE, so a token
-- carrying role=intake would otherwise be honoured; so would an operator's SET ROLE. Neither
-- can set clean/suspicious. (A superuser can still SET SESSION AUTHORIZATION or disable the
-- trigger - nothing in a database fences a superuser.)
--
-- Anyone else (even the postgres superuser on a plain write):
--   * may not write 'clean' or 'suspicious'                       (INSERT or UPDATE);
--   * may not change a verdict intake decided (OLD clean/suspicious) - no laundering
--     suspicious -> internal, no stripping clean -> unscreened behind intake's back;
--   * may not raise a row from 'unscreened' to 'internal' (that relabels external content as
--     stack output; a stack writer states 'internal' when it INSERTS its own row);
--   * may not set or change intake_item_id.
-- It MAY insert 'internal' or 'unscreened', lower 'internal' to 'unscreened', and do every
-- other write it does today. (D30, pending: an allow-list of the stack writers that may INSERT
-- 'internal'.) Values outside the four are the CHECK's job (section 4), which binds intake too.
--
-- AN AFTER ROW TRIGGER, NOT BEFORE (round 2, tester T5.1). A BEFORE trigger judges NEW as it
-- stands when it fires; any BEFORE trigger that sorts after it can still rewrite NEW - the
-- tester did exactly that with a pg_temp trigger function attached under the TRIGGER privilege
-- service_role held on sources. An AFTER ROW trigger fires once every BEFORE trigger has run,
-- sees the row AS STORED, and nothing after it can change that row: it can only reject, which
-- rolls the statement back. Not a deferrable constraint trigger: SET CONSTRAINTS ... DEFERRED
-- would let a session postpone the check. Section 5b removes the privilege that let a writer
-- attach code in the first place; the two are independent layers.
--
-- SECURITY INVOKER on purpose: current_user must be the writer, not the function owner.
-- search_path pinned with pg_temp LAST, so a session's temp objects can never shadow anything.
CREATE OR REPLACE FUNCTION intake.enforce_screen_verdict_authority() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_who TEXT := current_user;
BEGIN
  IF v_who = 'intake' AND session_user = 'intake' THEN
    RETURN NULL;
  END IF;
  IF v_who <> session_user THEN
    v_who := v_who || ' (session ' || session_user || ')';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.screen_verdict IN ('clean','suspicious') THEN
      RAISE EXCEPTION 'intake authority: role % may not write screen_verdict=% on %.% - only the intake role decides clean/suspicious',
        v_who, NEW.screen_verdict, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    IF NEW.intake_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'intake authority: role % may not set intake_item_id on %.%',
        v_who, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;
  -- UPDATE
  IF NEW.intake_item_id IS DISTINCT FROM OLD.intake_item_id THEN
    RAISE EXCEPTION 'intake authority: role % may not change intake_item_id on %.%',
      v_who, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF NEW.screen_verdict IS DISTINCT FROM OLD.screen_verdict THEN
    IF NEW.screen_verdict IN ('clean','suspicious') THEN
      RAISE EXCEPTION 'intake authority: role % may not set screen_verdict=% on %.% - only the intake role decides clean/suspicious',
        v_who, NEW.screen_verdict, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    IF OLD.screen_verdict IN ('clean','suspicious') THEN
      RAISE EXCEPTION 'intake authority: role % may not change a verdict intake decided (% -> %) on %.%',
        v_who, OLD.screen_verdict, NEW.screen_verdict, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    IF NEW.screen_verdict = 'internal' THEN
      RAISE EXCEPTION 'intake authority: role % may not relabel % as internal on %.% - a stack writer states internal when it inserts its own row',
        v_who, OLD.screen_verdict, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION intake.enforce_screen_verdict_authority() FROM PUBLIC;

DROP TRIGGER IF EXISTS zzz_intake_screen_verdict_authority ON public.sources;
CREATE TRIGGER zzz_intake_screen_verdict_authority
  AFTER INSERT OR UPDATE ON public.sources
  FOR EACH ROW EXECUTE FUNCTION intake.enforce_screen_verdict_authority();
DROP TRIGGER IF EXISTS zzz_intake_screen_verdict_authority ON public.thoughts;
CREATE TRIGGER zzz_intake_screen_verdict_authority
  AFTER INSERT OR UPDATE ON public.thoughts
  FOR EACH ROW EXECUTE FUNCTION intake.enforce_screen_verdict_authority();

-- ==========================================================================================
-- 5b. NOBODY BUT THE OWNER MAY ATTACH CODE TO THE LABELLED TABLES (round 2, tester T5.1)
-- ==========================================================================================
-- Live, `GRANT ALL ON public.sources TO service_role` includes TRIGGER (relacl arwdDxt), and
-- PUBLIC has TEMP with plpgsql trusted: any member of service_role (ob_app_memory = the DB user
-- of openbrain-mcp, -ext, -research, ...) could attach a pg_temp trigger function to sources.
-- TRIGGER and REFERENCES are revoked here from every grantee other than the owner, on sources,
-- thoughts and every table in schema intake; each revoke is written to intake.migration_ledger
-- so revert-intake.sql restores exactly what was there. No live writer creates triggers or
-- foreign keys at run time (checked 2026-10-15: no CREATE TRIGGER / REFERENCES sources|thoughts
-- outside the initdb SQL, which runs as postgres). Section 7 then asserts the PROPERTY over
-- every role: no non-superuser can attach code to these tables.
--
-- TEMP on the database is NOT revoked from PUBLIC (assessed 2026-10-15; see the I1 findings):
-- no code path found uses temp tables, but drivers and ORMs may, a revoke is a database-wide
-- change outside the label control, and TEMP alone no longer reaches the labels once TRIGGER
-- and REFERENCES are gone and the check runs AFTER.
DO $$
DECLARE
  r RECORD;
  v_grantee TEXT;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS tbl, a.grantee, a.privilege_type, a.is_grantable
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE (c.oid IN ('public.sources'::regclass, 'public.thoughts'::regclass)
            OR c.relnamespace = 'intake'::regnamespace)
       AND c.relkind IN ('r','p')
       AND a.privilege_type IN ('TRIGGER','REFERENCES')
       AND a.grantee <> c.relowner
  LOOP
    v_grantee := CASE WHEN r.grantee = 0 THEN 'PUBLIC' ELSE r.grantee::regrole::text END;
    INSERT INTO intake.migration_ledger (kind, detail)
    VALUES ('revoked-privilege', jsonb_build_object('table', r.tbl, 'grantee', v_grantee,
                                                    'privilege', r.privilege_type,
                                                    'grantable', r.is_grantable))
    ON CONFLICT DO NOTHING;
    EXECUTE format('REVOKE %s ON %s FROM %s', r.privilege_type, r.tbl, v_grantee);
    RAISE NOTICE 'init-intake: revoked % on % from %', r.privilege_type, r.tbl, v_grantee;
  END LOOP;
END $$;

-- ==========================================================================================
-- 6. WHAT INTAKE MAY TOUCH ON THE UPSTREAM TABLES - the label, and nothing it can read
-- ==========================================================================================
-- Column grants only: intake can find a row by id and set its label; it cannot read content,
-- titles, urls or metadata. It gets no INSERT on these tables in I1 (the writers move in I8).
GRANT USAGE ON SCHEMA public TO intake;
GRANT SELECT (id, screen_verdict, intake_item_id) ON public.sources, public.thoughts TO intake;
GRANT UPDATE (screen_verdict, intake_item_id)     ON public.sources, public.thoughts TO intake;
-- thoughts is FORCE ROW LEVEL SECURITY with policies for service_role and ob_plane_personal
-- only, so without its own policy intake would match zero rows and every label write would be
-- a silent no-op. Additive policies, upstream's untouched; the column grants above are what
-- keep it from reading the content of either plane.
DROP POLICY IF EXISTS thoughts_intake_label_select ON public.thoughts;
CREATE POLICY thoughts_intake_label_select ON public.thoughts FOR SELECT TO intake USING (true);
DROP POLICY IF EXISTS thoughts_intake_label_update ON public.thoughts;
CREATE POLICY thoughts_intake_label_update ON public.thoughts FOR UPDATE TO intake
  USING (true) WITH CHECK (true);

-- ==========================================================================================
-- 7. THE MIGRATION CHECKS ITSELF BEFORE IT COMMITS
-- ==========================================================================================
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  -- (a) nobody but intake (and superusers, which no grant can stop) holds any privilege on
  --     intake.* - this covers pg_read_all_data membership and any future role.
  SELECT string_agg(DISTINCT r.rolname || ' ' || c.relname, ', ') INTO v_bad
    FROM pg_roles r
    CROSS JOIN pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'intake' AND c.relkind IN ('r','p','S')
     AND NOT r.rolsuper AND r.rolname <> 'intake'
     AND r.rolname NOT IN ('pg_read_all_data','pg_write_all_data')
     AND (has_table_privilege(r.oid, c.oid, 'SELECT') OR has_table_privilege(r.oid, c.oid, 'INSERT')
          OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: role(s) other than intake can touch the intake schema: %', v_bad;
  END IF;
  SELECT string_agg(m.rolname || ' in ' || g.rolname, ', ') INTO v_bad
    FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
   WHERE g.rolname IN ('intake','pg_read_all_data','pg_write_all_data');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: membership would bypass the intake boundary: %', v_bad;
  END IF;
  -- (b) the trigger is SECURITY INVOKER (a definer trigger would see its owner as current_user)
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'intake.enforce_screen_verdict_authority()'::regprocedure
              AND prosecdef) THEN
    RAISE EXCEPTION 'init-intake: the authority trigger function is SECURITY DEFINER.';
  END IF;
  -- (c) 'injected' is refused by both tables (the CHECK is what says so, not this comment)
  PERFORM 1 FROM pg_constraint
    WHERE conname IN ('sources_screen_verdict_check','thoughts_screen_verdict_check')
      AND convalidated AND pg_get_constraintdef(oid) NOT LIKE '%injected%'
    HAVING count(*) = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'init-intake: the screen_verdict CHECK constraints are missing or admit injected.';
  END IF;
  -- (d) nobody but a superuser can ATTACH CODE to the labelled tables or the intake schema
  --     (round 2, tester T5.1): TRIGGER or REFERENCES on sources, thoughts or intake.*;
  --     ownership of them or of the trigger function (an owner can ALTER, add RULEs/policies,
  --     disable triggers), by being the owner or a member of it; CREATE on schema intake.
  SELECT string_agg(DISTINCT r.rolname || ' ' || c.oid::regclass::text || ' ' || p, ', ') INTO v_bad
    FROM pg_roles r
    CROSS JOIN pg_class c
    CROSS JOIN unnest(ARRAY['TRIGGER','REFERENCES']) p
   WHERE (c.oid IN ('public.sources'::regclass, 'public.thoughts'::regclass)
          OR c.relnamespace = 'intake'::regnamespace)
     AND c.relkind IN ('r','p')
     AND NOT r.rolsuper
     AND has_table_privilege(r.oid, c.oid, p);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: non-superuser role(s) can attach code to a labelled table: %', v_bad;
  END IF;
  SELECT string_agg(DISTINCT r.rolname || ' owns ' || o.what, ', ') INTO v_bad
    FROM pg_roles r
    CROSS JOIN (SELECT 'public.sources' AS what, relowner AS owner FROM pg_class WHERE oid = 'public.sources'::regclass
                UNION ALL SELECT 'public.thoughts', relowner FROM pg_class WHERE oid = 'public.thoughts'::regclass
                UNION ALL SELECT c.oid::regclass::text, relowner FROM pg_class c WHERE c.relnamespace = 'intake'::regnamespace
                UNION ALL SELECT 'schema intake', nspowner FROM pg_namespace WHERE nspname = 'intake'
                UNION ALL SELECT 'intake.enforce_screen_verdict_authority()', proowner FROM pg_proc
                           WHERE oid = 'intake.enforce_screen_verdict_authority()'::regprocedure) o
   WHERE NOT r.rolsuper AND pg_has_role(r.oid, o.owner, 'MEMBER');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: non-superuser role(s) own (or inherit ownership of) a guarded object: %', v_bad;
  END IF;
  SELECT string_agg(r.rolname, ', ') INTO v_bad FROM pg_roles r
   WHERE NOT r.rolsuper AND has_schema_privilege(r.oid, 'intake', 'CREATE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: non-superuser role(s) can CREATE in schema intake: %', v_bad;
  END IF;
  -- (e) the authority trigger is an AFTER ROW trigger on both tables, enabled, not deferrable
  --     (tgtype bit 2 = BEFORE; tgenabled 'O' = fires in normal sessions).
  PERFORM 1 FROM pg_trigger
    WHERE tgname = 'zzz_intake_screen_verdict_authority'
      AND tgrelid IN ('public.sources'::regclass, 'public.thoughts'::regclass)
      AND (tgtype & 1) = 1 AND (tgtype & 2) = 0 AND tgenabled = 'O' AND NOT tgdeferrable
    HAVING count(*) = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'init-intake: zzz_intake_screen_verdict_authority is not an enabled AFTER ROW trigger on both tables.';
  END IF;
  -- (f) intake is not assumable through a membership and holds none itself (tester F5):
  --     no role is a member of intake (checked in (a)), intake is a member of nothing, and it
  --     cannot create roles or bypass RLS.
  SELECT string_agg(g.rolname, ', ') INTO v_bad
    FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
   WHERE m.rolname = 'intake';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'init-intake: role intake is a member of: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake'
              AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'init-intake: role intake has an attribute it must not have.';
  END IF;
  RAISE NOTICE 'init-intake: schema intake, role intake, screen_verdict + intake_item_id, authority trigger in place.';
END $$;

COMMIT;
