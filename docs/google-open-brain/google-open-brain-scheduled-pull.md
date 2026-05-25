# Gmail → Open Brain — Scheduled Pull (design)

**Status:** Design only. Not yet implemented. Build is a later turn.

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
5. **Short-term holding pen: `brain/keep-short-term`.** Anything tagged
   with this label is treated as "maybe keep" — subject to autonomous
   retention.
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

- Standalone script. Could be a tiny Python or Deno script — anything
  that can hit the local PostgREST proxy. Same dual-network container
  pattern as the import.
- Logic: `DELETE` from `thoughts` where `metadata->>source = 'gmail'`
  AND `metadata->'gmail_labels' ? 'brain/keep-short-term'` AND
  `(metadata->>email_date)::timestamptz < now() - interval '<retention> days'`.
- Logs what it deleted (count + a sample of subjects/dates) for the
  morning review trail. Idempotent — safe to re-run.

### C. Scheduling (Windows Task Scheduler)

- **Task 1: pull** — daily, 1:00 local, runs the recipe in the
  dual-network container with `--labels-prefix=brain/`. Reuse the
  pattern from the one-shot ChatGPT scheduled task
  (`OB1-ChatGPT-Full-Import`) but recurring.
- **Task 2: prune** — daily, 1:30 local (after the pull is reasonably
  done). Runs the prune script.
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
- **Wiki cascading.** Every new gmail thought feeds the wiki on its
  next regeneration. Pruning removes thoughts → wiki regenerates
  without them. Wiki agent owns that pipeline (out of scope here);
  design assumes the prune happens before whatever the wiki agent uses
  as its source-of-truth read window for the next regen.
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
- **No wiki coordination.** Wiki regeneration is owned by the parallel
  wiki agent; this design doesn't touch it.

## File / artifact locations (planned)

- Recipe (already exists, patched):
  `OB1/recipes/email-history-import/`
- Secrets (already in place):
  `OB1/secrets/google/open-brain-email/`
  (`credentials.json` + `token.json`)
- Prune script (to create):
  `OB1/recipes/email-history-import/prune-short-term.ts`
  (or equivalent — keeps it co-located with the import; gitignored).
- Scheduled task scripts (to create, kept outside git):
  - `D:\_data\gmail-pull-scheduled.ps1`
  - `D:\_data\gmail-prune-scheduled.ps1`
- Logs (to create):
  - `D:\_data\gmail-pull-<timestamp>.log`
  - `D:\_data\gmail-prune-<timestamp>.log`
