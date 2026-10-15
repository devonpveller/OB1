# FORK-OWNED: what this fork owns for intake

Operator decision D23 (2026-10-15): intake lives in OB1 on the condition that upstream OB1
(NateBJones-Projects/OB1) can never overwrite or collide with it. On 2026-10-15 upstream/main
had no `intake` path, file, schema or role and no `docker/` directory at all.

Everything intake adds is namespaced:

| What | Name |
|---|---|
| code | `integrations/intake/` (this directory) |
| migration | `integrations/intake/sql/init-intake.sql`, revert `sql/revert-intake.sql`, mounted as `220-init-intake.sql` by `docker/docker-compose.yml` and `docker/docker-compose.preview.yml` |
| SQL schema | `intake` (`intake.raw_items`, `intake.items`, `intake.discards`, `intake.enforce_screen_verdict_authority()`) |
| DB role | `intake` |
| columns on upstream tables | `public.sources.screen_verdict`, `public.sources.intake_item_id`, `public.thoughts.screen_verdict`, `public.thoughts.intake_item_id` (added `IF NOT EXISTS` by the migration) |
| constraints, triggers, policies, indexes | `sources_screen_verdict_check`, `thoughts_screen_verdict_check`, `sources_intake_item_id_fkey`, `thoughts_intake_item_id_fkey`, `zzz_intake_screen_verdict_authority` (both tables), `thoughts_intake_label_select`, `thoughts_intake_label_update`, `idx_sources_intake_item_id`, `idx_thoughts_intake_item_id` |

## The check

`tools/check_fork_owned.py` reads the block below and FAILS (exit 1) when an upstream change
touches a listed path, or adds or removes a line naming a listed identifier or matching a
listed pattern, in any file. Exit 2 means it could not check, and is a failure too.

- Before merging upstream into the fork:
  `python integrations/intake/tools/check_fork_owned.py --upstream upstream/main`
- On every OB1 gitlink bump in ai-stack, the pre-commit gate `ob1-fork-owned`
  (`scripts/checks/check-ob1-fork-owned.ps1`) runs `--range <old pin>..<new pin>`, which checks
  what each merge commit's upstream parent brought in, plus this directory's unit tests.

A hit is not an automatic "no": it means a human reviews the upstream change against this list.
Once reviewed, add `reviewed-upstream: <full sha of the upstream parent>` to the block and
commit it; that merge is then accepted. There is no flag that skips the check.

Adding to what intake owns? Add it to the table AND the block in the same commit.

```fork-owned
# paths (a directory ends in "/")
path: integrations/intake/

# columns intake adds to upstream tables - any added/removed line naming one, in any file
identifier: screen_verdict
identifier: intake_item_id
identifier: init-intake.sql
identifier: revert-intake.sql
identifier: zzz_intake_screen_verdict_authority
identifier: thoughts_intake_label_select
identifier: thoughts_intake_label_update

# the schema and the role: the bare word "intake" is ordinary English, so only SQL forms count
pattern: \bintake\."?[a-z_]
pattern: "intake"\.
pattern: \bSCHEMA\s+(IF\s+(NOT\s+)?EXISTS\s+)?"?intake"?\b
pattern: \bROLE\s+(IF\s+(NOT\s+)?EXISTS\s+)?"?intake"?\b
pattern: \b(TO|FROM)\s+"?intake"?\s*(;|,|$)
pattern: \bOWNED\s+BY\s+"?intake"?\b
pattern: \bAUTHORIZATION\s+"?intake"?\b
```
