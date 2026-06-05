-- P4 (TASKS 4.1) — append-only source edit history.
--
-- Each edit snapshots the PRIOR content/title here, then updates sources.content
-- in place (current = head; history = these rows). `source_id` never changes, so
-- thread_sources / source_entities / search stay valid. Updating is NEVER
-- replacing (there is no "replace source" gesture — D-D). A purge cascades these
-- rows away (ON DELETE CASCADE).
--
-- Additive + idempotent (G2). G3 — TWO places: initdb mount (fresh) + promotion
-- runbook (live).

CREATE TABLE IF NOT EXISTS public.source_revisions (
    source_id  UUID        NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
    revision   INT         NOT NULL,
    content    TEXT        NOT NULL DEFAULT '',
    title      TEXT        NOT NULL DEFAULT '',
    edited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_by  TEXT        NOT NULL DEFAULT 'operator',
    PRIMARY KEY (source_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_source_revisions_source ON public.source_revisions(source_id);
