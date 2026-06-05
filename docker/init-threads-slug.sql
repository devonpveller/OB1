-- P2 (TASKS 2.1) — pin a per-notebook slug on `threads`.
--
-- "Notebook" is the user-facing noun; the table stays `threads` (D-G). The slug
-- is generated ONCE at create time by the workbench via the shared canonical
-- slug module (OB1/recipes/_shared/slug.mjs), de-collided on the UNIQUE
-- violation (`-1`/`-2`), and NEVER recomputed — a rename touches `name` only and
-- the hub emits `aliases: [name]`. Same pin-for-life contract entity wiki_slug
-- has. Existing threads are slug-backfilled by the compiler (using the SAME JS
-- module, so no SQL slugify diverges from canonical — G5).
--
-- Additive + idempotent (G2). Multiple NULL slugs are allowed by the UNIQUE
-- index (Postgres treats NULLs as distinct), so pre-existing rows don't collide
-- until they are pinned.
--
-- G3 — TWO places: mounted at /docker-entrypoint-initdb.d (FRESH volume only)
-- AND applied to the live DB via the promotion runbook (X.3). A file added only
-- to compose silently no-ops on the running stack.

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_threads_slug ON public.threads(slug);
