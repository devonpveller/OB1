# intake - the screened way in for external content (fork-owned)

Every piece of external content (web pages, email, API data, crawls) is meant to pass intake
before it is stored in Open Brain or shown to a model. This directory is fork-owned:
[FORK-OWNED.md](FORK-OWNED.md) lists every path, schema object and column, and a check fails
any upstream change that touches them.

Status: **I1, the schema; I2, the deterministic stages as a library; I3, the classifier
stage.** The second opinion, the service and its container arrive in the later build items I4
to I9.

**Callers run `screen()` in a killable worker process with a hard wall-clock limit** (operator
D38; built in I5). The stages check their own deadline, but a single library call - a stdlib
parser call, the classifier's tokenizer, one model forward pass - cannot be interrupted
in-process; an overrun is killed and the item stays `pending`.

## What I2 ships: `intake.pipeline.screen(envelope, history=None) -> IntakeResult`

A function (no service, no DB writes, no network) running DESIGN-intake.md section 3 stages 1-5
and 8 (stage 6, the classifier, is I3 below):

| Stage | Module | Outcome |
|---|---|---|
| 1 validate | `envelope.py` | strict schema, raw <= 5 MB, content-type allow-list; else `rejected` |
| 2 idempotency | `revisions.py` | key `(source, external_id, sha256(raw))` over a caller-supplied read-only `History`; a repeat returns the stored result, a new hash is revision n+1 (`supersedes` names the old hash), never a rewrite |
| 3 CDR | `cdr.py`, `htmlscan.py` | HTML capped at 2 MB and read by a linear-time scanner (hidden and non-content elements dropped, links/images to `links`, title kept for escaping); email: text/plain preferred, attachments listed not read; JSON strings; plain/markdown as is |
| 4 invisible | `invisible.py` | TAG block (decoded as a payload; only the 3 RGI subdivision flags - England, Scotland, Wales - are exempt), bidi, variation selectors, C0/C1 controls, lone surrogates and every other Cf character stripped and counted per class; the rules read an NFKC copy, the stored text is not normalised |
| 5 rules | `rules.py`, `rules.toml` | RE2 patterns kept on RE2's DFA (no counted repetition, no captures); a STRONG rule, or two different cue rules side by side, gives `injected`; a WEAK rule a reason and `pending` for the second opinion; forged `[Source N]` lines and prompt section labels neutralised in the stored text |
| 8 fail closed | `pipeline.py`, `deadline.py` | any exception in a stage, or the deadline (1.6 s, checked inside the stages' loops; overshoot up to ~0.3 s under load) passing, gives `pending` (never `clean`); `screen()` never raises |

Bound (operator D34): every input inside the caps finishes in < 2 s on the reference host; a
legitimate page up to the 2 MB HTML cap is extracted whole, and input past a work cap is a
parser bomb (`rejected`). Importing the package builds the Unicode tables once (~1 s).

`IntakeResult` (`result.py`) carries the verdict so far (`clean` / `pending` / `injected` /
`rejected`), reasons, per-class counts, links, attachments, the text, the escaped title, the
stage trace, the idempotency key and the revision. Caps and their reasons: `limits.py`.
Every rule has an id, strength, rationale and positive and negative examples in `rules.toml`.

Install (Python 3.11+): `pip install --require-hashes -r requirements.txt` (tests:
`requirements-dev.txt`). The tests switch the network off on import (`tests/support.py`).

## What I3 ships: stage 6, the classifier (`classifier.py`)

| What | How |
|---|---|
| model | `protectai/deberta-v3-base-prompt-injection-v2` (Apache-2.0, ungated; operator D26), revision `90c9989b1a342275dd0d1a95aad283c04e075671`, CPU |
| pinned files | `config.json`, `tokenizer.json`, `model.safetensors`: size and sha256 in `classifier.MODEL_FILES`; safetensors only (no pickle) |
| fetch, once | `python tools/fetch_classifier.py` streams each file from `https://huggingface.co/<repo>/resolve/<revision>/<file>` into `models/<repo>-90c9989b/` (gitignored; or `--dest` / `INTAKE_CLASSIFIER_DIR`), checks size and sha256, then renames it into place; `--verify-only` checks without fetching |
| load, offline | the loader checks every file's size and sha256 on the bytes it then loads, sets the Hugging Face offline switches, and builds the model from those bytes; nothing is fetched at screen time |
| scoring | the whole text in 256-token chunks overlapping by 32 (a payload of up to 32 tokens on a boundary is wholly inside one chunk); fields: the stage-4 NFKC copy, the side text (title, link texts and URLs, attachment names), decoded TAG payloads; the MAX chunk score counts |
| verdict (D24) | skipped after a STRONG rule; score >= threshold: `pending` + `needs_second_opinion`, with the score and each flagged chunk's field and character offsets; below: the stage-5 verdict stands. Never `injected` on the score alone |
| fail closed | missing or corrupt files, a hash mismatch, torch/transformers missing, a tokenizer or model exception, a non-score, the time or chunk budget: `pending` with the error, never `clean` |
| result | `classifier_version` (`<repo>@<rev12>/<precision>/c<chunk>o<overlap>`) and `classifier` (max score, chunks, flagged chunks, ms, threads) |

Configuration (environment; a bad value is refused, never defaulted; `config.classifier_config`):
`INTAKE_CLASSIFIER_DIR`, `_PRECISION` (`fp32` default, or `int8`), `_INT8_LAYERS`, `_THREADS`
(8), `_WORKERS` (1, read by the I5 service), `_THRESHOLD` (0.5), `_CHUNK_TOKENS` (256),
`_OVERLAP_TOKENS` (32), `_MAX_CHUNKS` (400), `_MAX_SECONDS` (180). Precision and threads are
config because the host CPU is due to change; on the i7-7820X (AVX-512, no VNNI) INT8 is no
faster than fp32, so fp32 is the default. Re-measure with the eval fixture after the upgrade.

Runtime: `requirements-classifier.txt` (torch CPU, transformers, tokenizers, safetensors; not
yet hash-pinned, see the file). The eval set of DESIGN section 9 is frozen in
`tests/fixtures/classifier_eval.json` (expected scores per precision, stated tolerances) and
the I2 corpus scores in `tests/fixtures/classifier_corpus_scores.json`; the classifier tests
need the fetched model and load it with sockets disabled.

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
3. Unit tests, run from this directory in a venv made from `requirements-dev.txt` plus
   `requirements-classifier.txt`, after `python tools/fetch_classifier.py` (the one network
   step): `python -m unittest discover -s tests -t .` (the fuzz budget is
   `INTAKE_FUZZ_EXAMPLES`, default 300 per target; `INTAKE_BOUNDS_REPORT=<file>` writes the
   timing table). The stage 1-5 tests use a zero-score stand-in for the model
   (`tests/support.py`); `test_classifier*.py` load the real one.
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

- I4: the second opinion, purge jobs.
- I5: the service and its container.
- I6: read filters and fences.
- I8: retiring `metadata.injection_screen` and moving the writers.
