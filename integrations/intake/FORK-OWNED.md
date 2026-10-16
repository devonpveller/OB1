# FORK-OWNED: what this fork owns for intake

Operator decision D23 (2026-10-15): intake lives in OB1 on the condition that upstream OB1
(NateBJones-Projects/OB1) can never overwrite or collide with it. On 2026-10-15 upstream/main
had no `intake` path, file, schema or role and no `docker/` directory at all.

Everything intake adds is namespaced:

| What | Name |
|---|---|
| code | `integrations/intake/` (this directory) |
| I2 screening library | `intake/{pipeline,envelope,revisions,cdr,htmlscan,invisible,rules,result,limits,deadline}.py`, the rules file `intake/rules.toml`, `requirements.txt` / `requirements-dev.txt` (hash-pinned), `tests/fixtures/` (corpus snapshots), `tests/adversarial.py` (bound-test generators) - all inside the path below |
| I3 classifier stage | `intake/classifier.py`, the classifier settings in `intake/config.py`, `tools/fetch_classifier.py`, `requirements-classifier.txt`, `tests/fixtures/classifier_eval.json` and `classifier_corpus_scores.json` (the frozen eval fixtures), `tests/test_classifier*.py`, `tests/classifier_support.py`, `tests/adversarial_i3.py`, `tests/adversarial_r3.py`, `.gitignore` (the fetched model under `models/` is never committed) - all inside the path below |
| I4 second opinion, D2, purge, stats | `intake/{d2,second_opinion,fence,purge,stats}.py`, the second-opinion settings in `intake/config.py`, `transport/` (the one HTTP module), `tests/test_{d2,second_opinion,purge_stats,i4_carryins,i4_round2}.py`, `tests/db/run_i4_db_tests.py` - all inside the path below |
| migration | `integrations/intake/sql/init-intake.sql`, revert `sql/revert-intake.sql`, mounted as `220-init-intake.sql` by `docker/docker-compose.yml` and `docker/docker-compose.preview.yml` (the whole `220-` initdb slot is ours) |
| SQL schema | `intake` (`intake.raw_items`, `intake.items`, `intake.discards`, `intake.migration_ledger`, `intake.enforce_screen_verdict_authority()`) |
| DB role | `intake` (no members, a member of nothing) |
| database setting | `intake.backfill_done_at` (the one-shot backfill record; survives a revert on purpose) |
| columns on upstream tables | `public.sources.screen_verdict`, `public.sources.intake_item_id`, `public.thoughts.screen_verdict`, `public.thoughts.intake_item_id` (added `IF NOT EXISTS` by the migration) |
| constraints, triggers, policies, indexes | `sources_screen_verdict_check`, `thoughts_screen_verdict_check`, `sources_intake_item_id_fkey`, `thoughts_intake_item_id_fkey`, `zzz_intake_screen_verdict_authority` (AFTER ROW, both tables), `thoughts_intake_label_select`, `thoughts_intake_label_update`, `idx_sources_intake_item_id`, `idx_thoughts_intake_item_id` |
| privileges on upstream tables | TRIGGER and REFERENCES on `sources`/`thoughts` are revoked from every non-owner (recorded in `intake.migration_ledger`, restored by the revert) |

## The check

`tools/check_fork_owned.py` reads the block below and FAILS (exit 1) when an upstream change
touches a listed path, or adds or removes a line naming a listed identifier (in any letter
case: unquoted SQL identifiers fold) or matching a listed pattern, in any file. Exit 2 means
it could not check, and is a failure too.

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
# paths (a directory ends in "/"); path-glob is an fnmatch over the repo path
path: integrations/intake/
# the initdb slot our migration is mounted at - an upstream file or mount there collides
path-glob: docker/220-*
pattern: docker-entrypoint-initdb\.d/220-

# names intake adds - any added/removed line naming one, in any file, in any letter case
identifier: screen_verdict
identifier: intake_item_id
identifier: init-intake.sql
identifier: revert-intake.sql
identifier: zzz_intake_screen_verdict_authority
identifier: thoughts_intake_label_select
identifier: thoughts_intake_label_update
identifier: backfill_done_at

# the schema and the role: the bare word "intake" is ordinary English, so only SQL forms count
pattern: \bintake\."?[a-z_]
pattern: "intake"\.
pattern: \bSCHEMA\s+(IF\s+(NOT\s+)?EXISTS\s+)?"?intake"?\b
pattern: \bROLE\s+(IF\s+(NOT\s+)?EXISTS\s+)?"?intake"?\b
pattern: \b(TO|FROM)\s+"?intake"?(\s*(;|,|$)|\s+WITH\b)
pattern: \bGRANT\s+"?intake"?\s*(,|\bTO\b)
pattern: \bREVOKE\s+"?intake"?\s*(,|\bFROM\b)
pattern: \bOWNED\s+BY\s+"?intake"?\b
pattern: \bAUTHORIZATION\s+"?intake"?\b
```
