# Gmail → Open Brain — Scheduled Pull (design)

**Status:** Implemented (2026-05-25). Recipe patches, prune script,
wiki delete-propagation (DB trigger + compiler orphan-sweep), and
scheduled-task wrappers are in place.

> [!IMPORTANT]
> **Trigger mechanism updated 2026-05-27.** The "Windows Task Scheduler
> wrappers" referenced below are superseded by the `openbrain-cron`
> container + HTTP-trigger chain (pull → prune → digest via
> `NEXT_TRIGGER_URL` env vars). See
> [google-open-brain-scheduled-digest.md](./google-open-brain-scheduled-digest.md)
> for the current cascade. All locked decisions below about *what* is
> pulled and *when* still apply; only the *how-to-fire* changed.

## Purpose

Make the Gmail-to-Open-Brain integration autonomous: a Gmail label drives
what enters the brain, a separate retention job drives what leaves. No
hand-launched runs after this is in place.

## Locked decisions

1. **Pull is a recurring, fully autonomous job.** Daily at 1am local
   (Windows Task Scheduler, recurring trigger).
2. **Label-driven, dynamically discovered.** The job enumerates every Gmail
   label whose name starts with `brain/` and pulls from each. New `brain/*`
   child labels in Gmail flow in automatically on the next run — no edit
   to the schedule or any config required.
3. **The bare `brain` parent label is excluded.** Only children
   (`brain/ai`, `brain/work/y-12`, etc.) are pulled. Tagging the parent
   does nothing intentionally.
4. **Hierarchy is flat at the API level.** Gmail's `labelIds` query does
   not include child labels when you target a parent. Dynamic discovery
   handles this by enumerating every matching leaf.
5. **Short-term holding pen: `brain/keep-short-term`** *(and any
   sub-label under it)*. Anything tagged with this label OR any
   sub-label of it (e.g. `brain/keep-short-term/Y-12`,
   `brain/keep-short-term/Cozy Kidz Academy`) is treated as "maybe
   keep" — subject to autonomous retention. Sub-labels are a
   user-organizing convenience; retention semantics are identical.
   Match rule (mirrored in both pull pre-filter and prune):
   `label === stl || label.startsWith(stl + "/")`.
6. **Retention is configurable, not hardcoded.** A single config value
   (env var on the prune job, e.g. `BRAIN_SHORT_TERM_RETENTION_DAYS`)
   controls the cutoff. Default 90 days.
7. **Retention uses the email's received date, NOT the brain row's
   ingestion date.** A 6-month-old email newly tagged short-term is
   already past the cutoff on day one.
8. **Pre-filter at pull time.** Emails labeled `brain/keep-short-term`
   whose received date is already past the retention cutoff are skipped
   entirely — never embedded, never inserted. The only path into the
   brain for an old email is via a long-term `brain/X` label.
9. **Prune runs as a separate, small job** on its own daily schedule. It
   deletes brain rows where `metadata.source = 'gmail'` AND the row's
   gmail labels contain `brain/keep-short-term` AND the email's received
   date is older than the configured cutoff.
10. **Promotion workflow.** To rescue a short-term row from prune,
    relabel the email in Gmail from `brain/keep-short-term` to any
    long-term `brain/X` child. The existing brain row stays as-is
    (already ingested); the prune job ignores it because the short-term
    label is gone.
    - *Caveat (known, accepted):* the brain row's `gmail_labels` metadata
      remains frozen at ingest time. So a promoted row still shows the
      original labels in the brain. Source-of-truth lives in Gmail.
11. **Deletes in Gmail do not propagate.** Accepted. The brain is a
    snapshot/archive; if you want a row gone, delete it directly.
12. **Wiki delete-propagation is in scope.** Brain deletes MUST propagate
    to the wiki — orphan pages from pruned thoughts are a bug, not an
    accepted trade-off. Two coupled mechanisms make this work:
    - **DB trigger** (`init-graph.sql`) — on `DELETE FROM thoughts`,
      bump `entities.updated_at` for every entity in the cascade-deleted
      `thought_entities` rows. This puts the affected entities into the
      next wiki compile's "dirty" set so their pages regenerate.
    - **Compiler orphan sweep** (`wiki-service.mjs`) — after every
      compile, query the DB for the authoritative kept-set
      (entities with `linked_thought_count >= WIKI_BATCH_MIN_LINKED`)
      and delete any `content/<type>/<slug>.md` file not in that set.
      Same idea for `content/topic/<slug>.md` against active notebooks.
13. **Daily ordering: pull → prune → wiki compile.** All three serial,
    in this order. The wiki's in-container daily scheduler is moved off
    01:00 to avoid colliding with the pull; the prune script triggers
    the wiki by POSTing `/recompile` to `openbrain-wiki:8000` at the
    end of its run, so ordering is enforced by the prune script itself,
    not by clock-math.

## Components to build

### A. Recipe enhancements (`pull-gmail.ts`)

- **Dynamic label discovery mode.** A flag (e.g. `--labels-prefix=brain/`)
  enumerates all labels whose name starts with the prefix, excludes the
  bare prefix label itself, resolves to Gmail label IDs, and uses those
  for the pull. The existing `--labels=` flag stays for ad-hoc runs.
- **Short-term pre-filter.** Before sending an email to the embed/insert
  pipeline, if its labels include `brain/keep-short-term` AND its
  received date is older than `BRAIN_SHORT_TERM_RETENTION_DAYS`, drop it.
- **Email received date in metadata.** Add the parsed received date to
  the brain row's `metadata` as a top-level field (e.g. `email_date`).
  The prune job needs a clean field to query — relying on the
  LLM-extracted `dates_mentioned` is wrong (it's content, not provenance).

### B. Prune job (new, small)

- Standalone Deno script alongside the recipe
  (`recipes/email-history-import/prune-short-term.ts`). Same
  dual-network container pattern as the import.
- Logic: `DELETE` from `thoughts` where `metadata->>source = 'gmail'`
  AND `metadata->'gmail_labels' ? 'brain/keep-short-term'` AND
  `(metadata->>email_date)::timestamptz < now() - interval '<retention> days'`.
- Logs what it deleted (count + a sample of subjects/dates) for the
  morning review trail. Idempotent — safe to re-run.
- **After deletion, POSTs to `http://openbrain-wiki:8000/recompile`**
  with the `MCP_ACCESS_KEY` header so the wiki regenerates dirty entity
  pages and runs the orphan sweep on the post-prune brain state.

### B'. Wiki delete-propagation (new, in two places)

- **DB trigger** added in `docker/init-graph.sql`: a `BEFORE DELETE`
  trigger on `thoughts` that bumps `entities.updated_at = now()` for
  every entity linked through `thought_entities` to the dying thought.
  Effect: those entities land in the next compile's `dirtyEntityIds`
  set automatically, so their pages get rewritten with the now-missing
  source removed.
- **Orphan sweep** added in `docker/wiki-service/wiki-service.mjs` at
  the end of each compile, before the git-commit step:
  1. Query the authoritative kept-set from the DB
     (entities with at least `WIKI_BATCH_MIN_LINKED` linked thoughts).
  2. Compute expected files `content/<type>/<slug>.md` (using the
     pinned `wiki_slug` when present).
  3. Walk `content/<type>/*.md` on disk; delete any file not in the
     expected set.
  4. Same logic for `content/topic/<slug>.md` against notebooks that
     still have ≥1 source.
  5. Deletions become part of the same compile commit, so the git log
     shows the wiki shrinking in lockstep with the brain.

### C. Scheduling (Windows Task Scheduler) — order: pull → prune → wiki

Both jobs run as **compose services** under the `open-brain` project
with `profiles: ["scheduled"]` so they do not auto-start with
`docker compose up -d`. They fire only when invoked by the scheduled
task wrapper via `docker compose --profile scheduled run --rm <svc>`.
This keeps mounts/env/networks declared in YAML and the containers
appearing under the `open-brain` project in Docker Desktop.

- **Service `openbrain-gmail-pull`** — Task `OB1-Gmail-Pull-Scheduled`,
  daily at 01:00 local. Default flags (in YAML): `--labels-prefix=brain/
  --window=24h --limit=500`. Wrapper: `D:\_data\gmail-pull-scheduled.ps1`.
- **Service `openbrain-gmail-prune`** — Task
  `OB1-Gmail-Prune-Scheduled`, daily at 01:30 local. The script deletes
  expired short-term rows (label OR any sub-label) then POSTs
  `/recompile` to `http://openbrain-wiki:8000/recompile`. Wrapper:
  `D:\_data\gmail-prune-scheduled.ps1`.
- **Wiki's in-container daily scheduler is moved off 01:00**
  (`WIKI_RECOMPILE_HOUR=4` in `docker/.env`) so it cannot race the
  pull. Change-watch remains on, so any work landed by the pull
  triggers a debounced recompile naturally — and the explicit POST
  from the prune script is the authoritative end-of-cycle compile.
- **OAuth secrets** are bind-mounted INDIVIDUALLY in the compose
  service definitions from `OB1/secrets/google/open-brain-email/` over
  the in-repo placeholder paths (the recipe-dir `credentials.json` and
  `token.json` are intentionally 0-byte stubs). The `token.json` mount
  is RW so `refreshAccessToken()` persists. If the OAuth client is
  re-issued, update the `client_secret_*.apps.googleusercontent.com.json`
  filename in both service blocks.
- Both tasks log to `D:\_data\gmail-pull-<timestamp>.log` and
  `D:\_data\gmail-prune-<timestamp>.log` for morning review.
- Both inherit the Docker Desktop / interactive-logon caveat: machine
  must be logged in for the tasks to fire (Docker Desktop runs in user
  session).

## Open considerations / risks

- **GPU contention at 1am.** Wiki recompile and other jobs may overlap.
  Llama-swap queues; nothing fails, just slows. If contention becomes
  a problem, stagger the pull (e.g. 2am) — config decision, not a code
  decision.
- **Wiki delete-propagation (now in scope, see locked decision 12).**
  Default wiki compile is incremental and skips deletes — orphan pages
  would remain forever. Resolved with the DB trigger + compiler
  orphan-sweep. Verify in the morning log that the wiki commit after a
  prune actually contains `D <type>/<slug>.md` lines when retention
  removed rows. The first scheduled prune-with-deletions should be
  spot-checked: pick a deleted email's `gmail_id` from the prune log,
  then `grep -r <id>` the wiki content to confirm it's gone.
- **OAuth token rot.** The Google refresh token lives in `token.json`
  and refreshes automatically on each run. If the user revokes the
  OAuth grant in their Google account, the daily pull breaks until
  re-authorized. Log the auth failure clearly so it's visible in the
  morning log.
- **First scheduled run after deploy.** Should be a
  `--dry-run --limit=10` to confirm dynamic discovery picked up the
  expected labels, then flip to live mode. Avoids a surprise first-day
  bulk ingest if the user has many pre-existing labeled emails.
- **No backfill of "labeled before this design existed."** Once
  dynamic discovery is live, every existing `brain/*`-labeled email is
  fair game on day one. Decide whether the first run should be windowed
  (e.g. `--window=1y`) to avoid pulling years of historical labeled
  mail in one shot.

## Out of scope (explicit non-goals)

- **No bidirectional sync.** Gmail → brain only. Deletes/label edits in
  Gmail do not propagate.
- **No live push.** No Gmail watch/webhook subscription; just the
  scheduled pull.
- **No prune by ingestion date.** Only by email received date.
- **No prune of long-term `brain/*` rows.** Only `brain/keep-short-term`
  is subject to retention.
- **No bidirectional sync from wiki to brain.** The compiler's
  delete-propagation only operates wiki ← brain. A hand-edit or hand
  deletion of a `content/*.md` file is reverted on the next compile.
  (Note files under `notes/` are user-owned and remain untouched.)

## File / artifact locations

- Recipe (patched in this work):
  `OB1/recipes/email-history-import/pull-gmail.ts`
- Prune script (new in this work):
  `OB1/recipes/email-history-import/prune-short-term.ts`
- OAuth secrets (canonical location, outside the recipe dir):
  `OB1/secrets/google/open-brain-email/`
  - `token.json` (RW; refresh persists here)
  - `client_secret_140943225735-jlldopci4llqu5i1ag7j08ks44a269jq.apps.googleusercontent.com.json` (RO)
  - The recipe-dir `credentials.json` and `token.json` are intentional
    0-byte placeholders, overlaid by the compose bind-mounts.
- Compose services (new in this work, under the `open-brain` project):
  `OB1/docker/docker-compose.yml` →
  `openbrain-gmail-pull`, `openbrain-gmail-prune` (profile: `scheduled`).
- DB trigger (new):
  `OB1/docker/init-graph.sql` →
  `trg_touch_entities_on_thought_delete` + function.
- Wiki orphan sweep (new):
  `OB1/docker/wiki-service/wiki-service.mjs` → `sweepOrphanEntityPages()`
  and `sweepOrphanTopicPages()`, called from `compile()`.
- Scheduled task wrappers (kept outside git, in `D:\_data\`):
  - `D:\_data\gmail-pull-scheduled.ps1`
  - `D:\_data\gmail-prune-scheduled.ps1`
- Logs:
  - `D:\_data\gmail-pull-<timestamp>.log`
  - `D:\_data\gmail-prune-<timestamp>.log`
- Wiki schedule offset (so 01:00 stays clear):
  `OB1/docker/.env` → `WIKI_RECOMPILE_HOUR=4`
