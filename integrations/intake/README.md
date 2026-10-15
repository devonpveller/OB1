# intake - the screened way in for external content (fork-owned)

Every piece of external content (web pages, email, API data, crawls) is meant to pass intake
before it is stored in Open Brain or shown to a model. This directory is fork-owned:
[FORK-OWNED.md](FORK-OWNED.md) lists every path, schema object and column, and a check fails
any upstream change that touches them.

Status: **I1, the schema; I2, the deterministic stages as a library.** The classifier, the
second opinion, the service and its container arrive in the later build items I3 to I9.

## What I2 ships: `intake.pipeline.screen(envelope, history=None) -> IntakeResult`

A pure function (no service, no DB writes, no model, no network) running DESIGN-intake.md
section 3 stages 1-5 and 8:

| Stage | Module | Outcome |
|---|---|---|
| 1 validate | `envelope.py` | strict schema, raw <= 5 MB, content-type allow-list; else `rejected` |
| 2 idempotency | `revisions.py` | key `(source, external_id, sha256(raw))` over a caller-supplied read-only `History`; a repeat returns the stored result, a new hash is revision n+1 (`supersedes` names the old hash), never a rewrite |
| 3 CDR | `cdr.py`, `htmlscan.py` | HTML capped at 2 MB and read by a linear-time scanner (hidden and non-content elements dropped, links/images to `links`, title kept for escaping); email: text/plain preferred, attachments listed not read; JSON strings; plain/markdown as is |
| 4 invisible | `invisible.py` | TAG block (decoded as a payload; subdivision flags exempt), bidi, variation selectors, C0/C1 controls, lone surrogates and every other Cf character stripped and counted per class; the rules read an NFKC copy, the stored text is not normalised |
| 5 rules | `rules.py`, `rules.toml` | RE2 patterns; a STRONG rule gives `injected`, a WEAK rule a reason and `pending` for the second opinion; forged `[Source N]` lines and prompt section labels neutralised in the stored text |
| 8 fail closed | `pipeline.py` | any exception in a stage, or a stage that ends past the deadline, gives `pending` (never `clean`) |

`IntakeResult` (`result.py`) carries the verdict so far (`clean` / `pending` / `injected` /
`rejected`), reasons, per-class counts, links, attachments, the text, the escaped title, the
stage trace, the idempotency key and the revision. Caps and their reasons: `limits.py`.
Every rule has an id, strength, rationale and positive and negative examples in `rules.toml`.

Install (Python 3.11+): `pip install --require-hashes -r requirements.txt` (tests:
`requirements-dev.txt`). The tests switch the network off on import (`tests/support.py`).

## What I1 ships

| File | Role |
|---|---|
| `sql/init-intake.sql` | the migration: schema `intake` (bronze `raw_items`; silver `items`, `discards`), `screen_verdict` + `intake_item_id` on `sources`/`thoughts`, the `intake` role, the authority trigger |
| `sql/revert-intake.sql` | undoes it exactly; refuses while intake holds state unless `-v intake_revert_drop_data=1` |
| `intake/config.py` | retention values (30 d bronze, 365 d discards, 24 h second-opinion cap), env-overridable; nothing purges yet (I4) |
| `tools/check_fork_owned.py` | the FORK-OWNED guard (`--diff`, `--upstream`, `--range`) |
| `tests/` | unit tests (config, guard) and `tests/db/run_db_tests.py`, which runs the migration against a throwaway postgres |

### The trust label

`sources.screen_verdict` / `thoughts.screen_verdict` is one of:

- `clean` or `suspicious`: only a connection that logged in as the `intake` role may set these
  (`SET ROLE intake`, including a PostgREST JWT role switch, does not count).
- `unscreened`: the default; the content is external and has not been screened.
- `internal`: the row is stack-generated.

`injected` is never stored. The AFTER ROW trigger `zzz_intake_screen_verdict_authority` judges
the row as stored (no later BEFORE trigger can rewrite it) and refuses any other role, including
a plain write by the postgres superuser, that tries to:

- set `clean` or `suspicious`;
- change a verdict intake decided;
- raise `unscreened` to `internal`;
- touch `intake_item_id`.

No role but the table owner may attach code to `sources`/`thoughts`: the migration revokes
TRIGGER and REFERENCES from every other grantee (recorded in `intake.migration_ledger`, restored
by the revert) and checks the property before it commits. It also REFUSES to apply while
foreign code is already attached to those tables (a trigger whose function is temporary,
owned by a non-superuser, or touches the label); terminate non-postgres sessions before a
live apply.

The backfill rule for existing rows is documented in `sql/init-intake.sql` section 3
(operator D29/D30/D32: anything derived from unscreened input is unscreened, so only the
operator's own notes under `notes/` backfill as `internal`). It runs
once per database: a re-apply after a revert leaves every row `unscreened` unless
`-v intake_rerun_backfill=1` asks for the marker rule again.

## Prerequisites

- An Open Brain database with `sources` and `thoughts` (`docker/init.sql`, `docker/init-sources.sql`).
- psql run as `postgres`, Python 3.8+ for the tools, and Docker for the DB tests.

## Steps

1. Fresh volume: nothing to do. `docker/docker-compose.yml` mounts the migration as
   `220-init-intake.sql`.
2. Live database: this is the operator's gated deploy, never a side effect.
   `psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -v intake_db_password="$INTAKE_DB_PASSWORD" -f sql/init-intake.sql`
3. Unit tests, run from this directory in a venv made from `requirements-dev.txt`:
   `python -m unittest discover -s tests -t .` (the fuzz budget is `INTAKE_FUZZ_EXAMPLES`,
   default 300 per target; `INTAKE_BOUNDS_REPORT=<file>` writes the timing table)
4. DB tests (a throwaway container: `--network none`, labelled; the runner refuses anything
   else): `python tests/db/run_db_tests.py --start --image pgvector/pgvector:pg16 --roles roles.sql --schema schema.sql`
   The two inputs are `pg_dumpall --roles-only --no-role-passwords` and
   `pg_dump --schema-only` of the target database.
5. Before merging upstream OB1: `python tools/check_fork_owned.py --upstream upstream/main`

## Expected outcome

- The DB tests end with `ALL PASS`.
- The guard prints `ok - nothing fork-owned is touched` (exit 0). A hit prints the path or
  line (exit 1).

## Not yet (later items)

- I4: purge jobs.
- I5: the service and its container.
- I6: read filters and fences.
- I8: retiring `metadata.injection_screen` and moving the writers.
