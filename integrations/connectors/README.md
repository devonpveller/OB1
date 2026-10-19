# connectors - the one way external content comes in (fork-owned)

Every external source (web pages through the search gate, Gmail, docs crawls, repo-sync, any future
API) is a **connector**, and a connector's only output is **intake envelopes**. Intake
(`../intake/`) screens them and is the only thing that writes Open Brain. This directory is the
contract every connector builds on, and the test kit that proves a connector keeps it
(security plan step 2, `PLAN-connectors.md`; operator decisions D1-D4).

Fork-owned: `integrations/connectors/` is listed in `../intake/FORK-OWNED.md`, and the
`ob1-fork-owned` gate fails an upstream change that touches it.

Status: **the kit, the test kit and the reference connector are built and tested; nothing is
deployed and no live caller is moved** (that is plan step 5). Standard library only, Python 3.11+.

| Path | What |
|---|---|
| `connector_kit/connector.py` | `Connector` (the base class), `Item`, `ConnectorConfig`, `RunReport` |
| `connector_kit/envelope.py` | the envelope: intake's stage-1 schema mirrored exactly, `build()`, the idempotency key |
| `connector_kit/provenance.py` | `metadata.provenance`: connector id, version, fetched_at, origin, redirect chain, labels |
| `connector_kit/client.py` | `IntakeClient`: the only socket a connector opens; bounded send, retries |
| `connector_kit/outcomes.py` | what each intake answer means (record / retry / stop) |
| `connector_kit/secret.py` | the connector's own intake key, read from a file, never shown |
| `connector_kit/testkit/` | `FakeIntake`, the `Sandbox`, the static scan, the contract tests, the conformance runner |
| `reference/` | the reference connector: local files or stdin, no network |
| `connector_tests/` | the kit's own tests, the mutants, the parity tests against the real intake code |
| `roundtrip/run_roundtrip.py` | the reference connector against the real intake image and a throwaway postgres |

## The contract

A connector **collects**. The kit builds, checks and sends.

1. **Its only output is intake envelopes**, built by the kit from the `Item`s `collect()` yields
   and POSTed by the kit's `IntakeClient` to `http://<intake>/v1/intake` with **its own key**
   (`Authorization: Bearer`, one key per connector in intake's `intake_caller_keys`; intake
   refuses an envelope whose `connector` is not the key's).
2. **It never writes an Open Brain table**, nor any other database: no DB driver, no SQL.
3. **It never calls a model**: no SDK, no LiteLLM, no llama-cpp alias.
4. **It never fetches a URL except through the search gate** (plan step 3). The gate's hosts
   (`connector.GATE_HOSTS`) are the only hosts a connector may declare in `allowed_hosts`; no other
   socket, no HTTP library, no subprocess (a `curl` is a fetch).
5. **Its key never appears** in a log line, stdout, stderr, an envelope or a report.
6. **Its item ids are stable**: the same thing collected twice has the same `external_id`, so
   intake answers a repeat (same bytes) or a new revision (changed bytes), never a second item.
7. `envelopes()` and `run()` are the kit's: overriding them, or declaring a non-gate host, is
   refused when the class is created (`TypeError`).

### The envelope (intake's stage 1, exactly)

`{source, connector, external_id, fetched_at, content_type, raw, raw_encoding?, metadata?, links?}`
with intake's rules: `source`/`connector` slugs `[a-z0-9][a-z0-9._-]*` (<= 64), `external_id`
1..1024 characters, `fetched_at` ISO 8601, `content_type` one of text/html,
application/xhtml+xml, text/plain, text/markdown, message/rfc822, application/json (a `charset`
parameter allowed), raw <= 5 MB after decoding, metadata plain JSON <= 64 KiB, at most 1000 links
of 1..2048 characters, no other field. `connector_kit.envelope.check()` mirrors
`intake.envelope.validate()`; `connector_tests/test_envelope.py` runs both over the same corpus
(valid envelopes, every single-field mutation, the raw caps at the edge, random mutations) and
fails on any disagreement. `build()` makes a subset: raw always base64, `fetched_at` with a zone,
`metadata.provenance` always set. The idempotency key `(source, external_id, sha256(raw))` is
computed by the kit as intake computes it, and the client checks intake's answer names that key.

### Provenance (`metadata.provenance`, DESIGN-intake.md section 6)

`{connector, connector_version, fetched_at, origin, redirect_chain, labels: {connector, source,
external_id}}` - exactly these keys. `origin` is a URL or a connector locator (`file:<name>`,
`stdin`; never a host path); `redirect_chain` lists the URLs a fetch passed through (from the
search gate's report, for gate connectors), at most 20. **A connector cannot pre-label its
content**: `verdict`, `intake_id`, `classifier` and `flags` are intake's and are refused anywhere
in provenance.

### What each intake answer means (`outcomes.py`)

| intake answers | the kit |
|---|---|
| 200 `clean` / `suspicious` / `pending` / `injected` | **record** (the text intake returns is dropped: consumers read Open Brain) |
| 200 `rejected` (content, e.g. a parser bomb) | **record**, never resent |
| 200 for another key or connector, an unknown label, text for injected/pending | **stop** (protocol) |
| 408, 503 (busy, not ready, store down, too many in flight, no key announced), no answer | **retry**: capped exponential backoff, `Retry-After` honoured (capped), until `max_attempts` / `budget_s`; then the item is **deferred** and the run stops |
| 401, 403, 413 | **stop** the run after that one request (a key or a cap problem; retrying cannot help) |
| 400, 411, 422, 404/405/500, a 3xx | **stop** (a kit bug, schema drift, or not intake) |

A deferred or not-sent item is not stored; a later run sends it again, and the key makes that
idempotent. `pending` and `injected` are recorded, not retried: intake owns the second opinion and
the re-screen.

### The client (`client.py`), intake's bounded-send pattern

One deadline per attempt (`timeout_s`), not per socket operation: the connect is bounded by the
socket timeout set to what is left; once connected, a watchdog shuts the socket at the deadline
(a stall while sending or while headers drip); the reply is read in pieces with the timeout set to
what is left, to at most `max_reply_bytes`. No proxy (http.client, not urllib), no redirect
followed, Content-Length always (never chunked), a reply shorter than its Content-Length is a
network failure. A body over `max_request_bytes` (intake's 8 MiB default) is refused locally.
The envelope is re-checked right before it is sent, whoever built it.

## Adding a connector

1. Write the class in its own module:

   ```python
   from connector_kit import Connector, Item

   class GmailConnector(Connector):
       id = "gmail"            # = its entry in intake_caller_keys
       source = "gmail"
       version = "1"
       # allowed_hosts = ("search-gateway",)   # only if it fetches through the gate

       def collect(self):
           for msg in ...:     # the provider credential is the connector's own; fetch nothing else
               yield Item(external_id=msg.id, content_type="message/rfc822", raw=msg.raw,
                          fetched_at=msg.fetched_at, origin="gmail:" + msg.id)
   ```

   Helper modules holding connector code go in `extra_modules` (the contract scans them too).
2. Add its contract test (a fixture input, no network):

   ```python
   class GmailContract(ConnectorContract, unittest.TestCase):
       def make_connector(self, config):           # config carries intake's URL and a key FILE
           return GmailConnector(dataclasses.replace(config, options={...fixture...}))
       def make_oversize_connector(self, config):  # optional: an input over a cap
           ...
   ```

   or run the conformance runner on a factory:
   `python -m connector_kit.testkit.conformance my_pkg.factories:fixture_connector` (exit 0 =
   conformant).
3. Give it a STRIDE note (five lines, below) in its module docstring or README.
4. Deploying it (not done by this kit): a key in intake's `intake_caller_keys` (`<id>=<key>`), the
   same key as a read-only file for the connector container (a compose secret, never an
   environment variable), the connector's egress declared in `stack.manifest.toml` (plan step 6).

### The contract tests (`testkit/contract.py`)

Each runs the connector against a `FakeIntake` inside the `Sandbox`, with a random canary key:
`test_declaration`, `test_static_scan`, `test_sends_only_valid_envelopes` (every body that reached
intake passes intake's own stage 1 - the oracle - and came through the kit's client),
`test_no_table_writes_or_model_calls`, `test_network_only_allowed_hosts`, `test_no_secret_in_logs`
(the key, its base64, hex and sha256, in logs, stdout, stderr, bodies, the report),
`test_idempotency_key`, `test_size_caps`, `test_outcome_handling` (every intake outcome).

The sandbox and the static scan are TEST tools: they make a connector that breaks the rules fail
its tests. At run time the boundary is the network (plan step 6: a connector container has no
route except to intake and the gate) and intake's own checks.

### The proof: mutants (`connector_tests/test_mutants.py`)

15 mutant connectors, each breaking one rule, MUST fail conformance on that rule: a non-envelope
(dict items; a direct urllib POST; a post through the client's private transport; an overridden
`run()`), a table write (psycopg; sqlite3), a socket to a non-allowed host (the DB by name; an IP;
the model alias; a curl subprocess; a non-gate `allowed_hosts`), a leaked key (a log line;
stderr; envelope metadata), and an unstable item id. The reference connector is the control.

### The fake intake (`testkit/fake_intake.py`)

Records every request and replays every outcome the real I5 service produces: the labels, and
400, 401, 403, 408, 411, 413, 422, 500 and the five 503 bodies, in the real order of checks, with
the real error texts and headers, repeats and revisions. `connector_tests/test_fake_parity.py`
sends the same requests to the fake and to the real intake code in-process (web.py + core.py +
intake's in-memory store and inline pool) - I5's e2e fixtures and the HTTP cases - and compares
the answers.

## The reference connector (`reference/`)

`python -m reference --input <file|dir|-> --intake-url http://openbrain-intake:8000/v1/intake
--key-file <path> [--external-id ID --content-type TYPE]` - one item per file (`file/<name>`), or
stdin (an `--external-id` required). Exit 0 / 3 (stopped) / 4 (intake unavailable) / 2 (usage, key
file). Prints the run report (outcomes only, never text or the key).

STRIDE (reference connector): **S** it authenticates to intake with its own key only; it holds no
provider credential. **T** content is passed through unmodified and hashed; intake decides. **R**
every item carries provenance (connector, version, fetched_at, origin) and intake records the key.
**I** it reads only the files it is pointed at; reports and logs carry no content or key; origin
never names a host path. **D** a file over 5 MB is refused after a bounded read; one deadline per
request; retries are capped. **E** no network, no DB, no model, no subprocess; the kit refuses
overriding its send path.

## Tests

From this directory, in a venv with intake's `requirements-dev.txt` (the parity tests run the
real intake code; without google-re2/selectolax they are skipped with that reason):

    python -m unittest discover -s connector_tests -t .
    ruff check .

The round trip against the real image (Docker, a throwaway postgres with the I1 migration, an
internal test network outside 192.168.0.0/16; nothing live):

    python roundtrip/run_roundtrip.py --image openbrain-intake:wt-<id> --model-dir <verified dir> --out <dir>
