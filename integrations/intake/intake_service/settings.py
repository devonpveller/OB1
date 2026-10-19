"""The service configuration, read ONCE at start-up from the environment and, for the three
secrets, from FILES (I5; intake-i5b R2-F1).

Every value - the service's own and the library's (retention, classifier, second opinion, the
D40 policy point) - is parsed here, before any worker starts. A value that does not parse or is
out of range raises ConfigError and the service REFUSES TO START (I4 review R3-T2/R3-T3): the
D40 policy the service decides with is the configured one, never d2's default, and a bad value
is caught at start, not on the first item that needs it. Nothing is ever replaced by a default.

THE SECRETS ARE FILES, NEVER ENVIRONMENT VARIABLES (intake-i5 round-2 tester R2-F1): every
process `docker exec` starts in the container - the compose healthcheck, `stack.py health`,
check-openbrain-health - runs with the container's configured environment, so a secret there
reaches each of them, ordinary dumpable processes of the service's uid. The secrets are compose
secrets instead (docker/intake-secrets/, gitignored, mounted read-only at /run/secrets), read
here once; a secret NAME in the environment refuses the start (exit 2), so an old intake.env
that still carries one cannot quietly put it back. Each file: UTF-8, at most 16 KiB, one
trailing line break dropped (an editor's), nothing else stripped. After reading them the
service seals the directory against itself and its workers (app.seal_secrets, Landlock).

  INTAKE_SECRETS_DIR                  /run/secrets (an absolute path): the directory of the files
  intake_caller_keys    (file)        REQUIRED, secret: `connector=key[,connector=key...]`. One key
                                      per connector (DESIGN section 2: a per-connector key); the
                                      key a request presents decides which connector it may submit
                                      for (envelope.connector must match, else 403). Keys are 32-256
                                      printable ASCII characters with no blank, `,` or `=`.
  INTAKE_MAX_REQUEST_BYTES            8 MiB: a body over it is 413, never read (a 5 MB raw fits as
                                      base64; heavily escaped JSON text may not - send base64)
  INTAKE_MAX_INFLIGHT                 16 requests at once, then 503
  INTAKE_MAX_CONNECTIONS              64 open connections at once (before auth too); more are
                                      closed at accept (intake-i5 attempt 1 F-T3)
  INTAKE_BODY_READ_SECONDS            30: the WHOLE body must arrive within this, or 408 (a drip
                                      cannot hold a slot; F-T3)
  INTAKE_QUEUE_WAIT_SECONDS           30: how long a request waits for a free worker, then 503
  INTAKE_WALL_STAGES_SECONDS          5: hard wall clock for stages 1-5 in the worker (D38); the
                                      library's own deadline is 1.6 s (< 2 s bound, D34)
  INTAKE_WALL_TRANSFER_SECONDS        10: handing the job to the worker and reading it there
  INTAKE_WALL_CLASSIFIER_SLACK_SECONDS 15: the classifier's wall clock is its own budget
                                      (INTAKE_CLASSIFIER_MAX_SECONDS) plus this
  INTAKE_WORKER_START_SECONDS         300: a worker must load (verify + build the model) in this
  INTAKE_DB_HOST / _PORT / _NAME / _USER  the relay host / 5432 / openbrain / intake
  intake_db_password    (file)        REQUIRED, secret: the intake role's password
  INTAKE_SO_INTERVAL_SECONDS          30: the second-opinion loop's period
  INTAKE_SO_BATCH / _CONCURRENCY      8 items per sweep / 1 request at a time (llm-queue's
                                      ob-intake class is max_concurrency 1, I4 F-2)
  INTAKE_RESCREEN_INTERVAL_SECONDS    60: the loop that re-screens errored items from bronze
  INTAKE_RESCREEN_MAX_ATTEMPTS        3 screens per errored item, then it expires (`suspicious`)
  INTAKE_RESCREEN_BACKOFF_SECONDS     300 between re-screens
  INTAKE_PURGE_INTERVAL_SECONDS       3600: the retention purge (I4 purge.run_all)
  INTAKE_LOG_LEVEL                    INFO | WARNING | ERROR | DEBUG
  intake_second_opinion_key (file)    secret, handed to second_opinion.Judge (the library); an
                                      absent or empty file is reported (healthz, a warning), not
                                      refused: every judge ask is then `no_key` and items expire
                                      `suspicious`, never clean
  INTAKE_LISTEN_HOST / _PORT          0.0.0.0 / 8000

The secrets are held in Secret objects whose repr is a mask; the caller names the service logs
are connector names, never keys.
"""
from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass, field
from typing import Mapping

from intake import config as libconfig
from intake.config import ClassifierConfig, Retention, SecondOpinionConfig
from intake.d2 import Policy

SECRET_ENV = ("INTAKE_CALLER_KEYS", "INTAKE_DB_PASSWORD", "INTAKE_SECOND_OPINION_KEY")
# the secret (by its logical name) -> its file in INTAKE_SECRETS_DIR (the compose secret's name)
SECRET_FILES = {"INTAKE_CALLER_KEYS": "intake_caller_keys", "INTAKE_DB_PASSWORD": "intake_db_password",
                "INTAKE_SECOND_OPINION_KEY": "intake_second_opinion_key"}
SECRETS_DIR_ENV = "INTAKE_SECRETS_DIR"
DEFAULT_SECRETS_DIR = "/run/secrets"
MAX_SECRET_BYTES = 16 * 1024
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

_SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_KEY = re.compile(r"[!-~]{32,256}")
_INT = re.compile(r"[0-9]{1,9}")
_NUM = re.compile(r"[0-9]{1,6}(\.[0-9]{1,6})?")
_HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}")
_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")


class ConfigError(Exception):
    """A configuration value is missing or invalid: the service does not start."""


class Secret:
    """A value that never prints."""

    __slots__ = ("_v",)

    def __init__(self, value: str):
        self._v = value

    def reveal(self) -> str:
        return self._v

    def __repr__(self) -> str:
        return "Secret(***)"

    __str__ = __repr__

    def __bool__(self) -> bool:
        return bool(self._v)


class CallerKeys:
    """connector -> key. match() compares the presented key with EVERY key in constant time."""

    def __init__(self, entries: Mapping[str, str]):
        self._entries = tuple((c, k.encode("ascii")) for c, k in entries.items())

    @property
    def connectors(self) -> tuple[str, ...]:
        return tuple(c for c, _ in self._entries)

    def match(self, presented: str) -> str | None:
        try:
            p = presented.encode("ascii")
        except (UnicodeEncodeError, AttributeError):
            p = b"\x00"
        found = None
        for connector, key in self._entries:
            if hmac.compare_digest(p, key) and found is None:
                found = connector
        return found

    def __repr__(self) -> str:
        return f"CallerKeys({', '.join(self.connectors)}; keys hidden)"

    __str__ = __repr__


@dataclass(frozen=True)
class Settings:
    listen_host: str
    listen_port: int
    max_request_bytes: int
    max_inflight: int
    max_connections: int
    body_read_s: float
    queue_wait_s: float
    wall_stages_s: float
    wall_transfer_s: float
    wall_classifier_slack_s: float
    worker_start_s: float
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    so_interval_s: float
    so_batch: int
    so_concurrency: int
    rescreen_interval_s: float
    rescreen_max_attempts: int
    rescreen_backoff_s: float
    purge_interval_s: float
    log_level: str
    policy: Policy
    retention: Retention
    classifier: ClassifierConfig
    second_opinion: SecondOpinionConfig
    second_opinion_key_set: bool
    secrets_dir: str
    callers: CallerKeys = field(repr=False)
    db_password: Secret = field(repr=False)
    second_opinion_key: Secret = field(repr=False, default_factory=lambda: Secret(""))

    @property
    def workers(self) -> int:
        return self.classifier.workers

    @property
    def wall_classifier_s(self) -> float:
        return self.classifier.max_seconds + self.wall_classifier_slack_s


def _get(env: Mapping[str, str], name: str, default: str | None) -> str:
    v = env.get(name)
    if v is None:
        if default is None:
            raise ConfigError(f"{name} is required")
        return default
    return v


def _int(env, name, default: int, lo: int, hi: int) -> int:
    raw = _get(env, name, str(default))
    if not _INT.fullmatch(raw) or not lo <= int(raw) <= hi:
        raise ConfigError(f"{name}={raw!r} is not a whole number in [{lo}, {hi}]")
    return int(raw)


def _num(env, name, default: float, lo: float, hi: float) -> float:
    raw = _get(env, name, repr(default))
    if not _NUM.fullmatch(raw) or not lo <= float(raw) <= hi:
        raise ConfigError(f"{name}={raw!r} is not a number in [{lo}, {hi}]")
    return float(raw)


def _secrets_dir(env) -> str:
    d = _get(env, SECRETS_DIR_ENV, DEFAULT_SECRETS_DIR)
    if not os.path.isabs(d) or "\x00" in d:
        raise ConfigError(f"{SECRETS_DIR_ENV}={d!r} is not an absolute directory path")
    return d


def read_secrets(env) -> tuple[str, dict]:
    """(the directory, {logical name: value or None when the file is absent}). Never the
    environment: a secret name there is refused. Errors name the file, never a value."""
    for name in SECRET_FILES:
        if name in env:
            raise ConfigError(f"{name} is set in the environment: the intake secrets are files only "
                              f"({SECRETS_DIR_ENV}, compose secrets; intake-i5b R2-F1) - remove it from "
                              "the environment (docker/intake.env)")
    d = _secrets_dir(env)
    out: dict = {}
    for name, fn in SECRET_FILES.items():
        path = os.path.join(d, fn)
        try:
            with open(path, "rb") as fh:
                data = fh.read(MAX_SECRET_BYTES + 1)
        except FileNotFoundError:
            out[name] = None
            continue
        except OSError as e:
            raise ConfigError(f"{name}: the secret file {path} cannot be read ({type(e).__name__})") from None
        if len(data) > MAX_SECRET_BYTES:
            raise ConfigError(f"{name}: the secret file {path} is over {MAX_SECRET_BYTES} bytes")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ConfigError(f"{name}: the secret file {path} is not UTF-8") from None
        for tail in ("\r\n", "\n"):
            if text.endswith(tail):
                text = text[: -len(tail)]
                break
        out[name] = text
    return d, out


def _caller_keys(raw: str | None, path: str) -> CallerKeys:
    if raw is None or not raw.strip():
        raise ConfigError(f"INTAKE_CALLER_KEYS is required (the secret file {path}): connector=key[,connector=key...]")
    entries: dict[str, str] = {}
    seen_keys: set[str] = set()
    for i, part in enumerate(raw.split(","), 1):
        if "=" not in part:
            raise ConfigError(f"INTAKE_CALLER_KEYS entry {i} is not connector=key")
        connector, key = part.split("=", 1)
        if not _SLUG.fullmatch(connector):
            raise ConfigError(f"INTAKE_CALLER_KEYS entry {i}: the connector must match [a-z0-9][a-z0-9._-]*")
        if not _KEY.fullmatch(key):
            raise ConfigError(f"INTAKE_CALLER_KEYS entry {i} ({connector}): a key is at least 32 and at most "
                              "256 printable ASCII characters, with no blank, ',' or '='")
        if connector in entries:
            raise ConfigError(f"INTAKE_CALLER_KEYS names connector {connector!r} twice")
        if key in seen_keys:
            raise ConfigError(f"INTAKE_CALLER_KEYS uses one key twice (entry {i}, {connector})")
        entries[connector] = key
        seen_keys.add(key)
    return CallerKeys(entries)


def load(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    try:
        policy = libconfig.d2_policy(env)
        retention = libconfig.retention(env)
        clf = libconfig.classifier_config(env)
        so = libconfig.second_opinion_config(env)
    except ValueError as e:  # the library's own refusals name the variable
        raise ConfigError(str(e)) from None
    host = _get(env, "INTAKE_LISTEN_HOST", "0.0.0.0")
    if not (host == "0.0.0.0" or _HOST.fullmatch(host)):
        raise ConfigError(f"INTAKE_LISTEN_HOST={host!r} is not a host name or address")
    db_host = _get(env, "INTAKE_DB_HOST", "openbrain-intake-dbrelay")
    if not _HOST.fullmatch(db_host):
        raise ConfigError(f"INTAKE_DB_HOST={db_host!r} is not a host name")
    db_name = _get(env, "INTAKE_DB_NAME", "openbrain")
    db_user = _get(env, "INTAKE_DB_USER", "intake")
    for name, v in (("INTAKE_DB_NAME", db_name), ("INTAKE_DB_USER", db_user)):
        if not _NAME.fullmatch(v):
            raise ConfigError(f"{name}={v!r} is not a plain SQL name")
    secrets_dir, secret = read_secrets(env)
    password = secret["INTAKE_DB_PASSWORD"]
    if not password:
        raise ConfigError("INTAKE_DB_PASSWORD is required (the intake role's password, the secret file "
                          f"{os.path.join(secrets_dir, SECRET_FILES['INTAKE_DB_PASSWORD'])})")
    if any(c in password for c in "\r\n\x00"):
        raise ConfigError("INTAKE_DB_PASSWORD contains a line break or NUL")
    level = _get(env, "INTAKE_LOG_LEVEL", "INFO")
    if level not in LOG_LEVELS:
        raise ConfigError(f"INTAKE_LOG_LEVEL={level!r} is not one of {LOG_LEVELS}")
    so_key = secret["INTAKE_SECOND_OPINION_KEY"] or ""
    return Settings(
        listen_host=host,
        listen_port=_int(env, "INTAKE_LISTEN_PORT", 8000, 1, 65535),
        max_request_bytes=_int(env, "INTAKE_MAX_REQUEST_BYTES", 8 * 1024 * 1024, 1024, 16 * 1024 * 1024),
        max_inflight=_int(env, "INTAKE_MAX_INFLIGHT", 16, 1, 1024),
        max_connections=_int(env, "INTAKE_MAX_CONNECTIONS", 64, 1, 4096),
        body_read_s=_num(env, "INTAKE_BODY_READ_SECONDS", 30.0, 0.1, 3600.0),
        queue_wait_s=_num(env, "INTAKE_QUEUE_WAIT_SECONDS", 30.0, 0.01, 3600.0),
        wall_stages_s=_num(env, "INTAKE_WALL_STAGES_SECONDS", 5.0, 0.001, 600.0),
        wall_transfer_s=_num(env, "INTAKE_WALL_TRANSFER_SECONDS", 10.0, 0.1, 600.0),
        wall_classifier_slack_s=_num(env, "INTAKE_WALL_CLASSIFIER_SLACK_SECONDS", 15.0, 0.001, 3600.0),
        worker_start_s=_num(env, "INTAKE_WORKER_START_SECONDS", 300.0, 1.0, 3600.0),
        db_host=db_host,
        db_port=_int(env, "INTAKE_DB_PORT", 5432, 1, 65535),
        db_name=db_name,
        db_user=db_user,
        so_interval_s=_num(env, "INTAKE_SO_INTERVAL_SECONDS", 30.0, 0.01, 86400.0),
        so_batch=_int(env, "INTAKE_SO_BATCH", 8, 1, 1000),
        so_concurrency=_int(env, "INTAKE_SO_CONCURRENCY", 1, 1, 64),
        rescreen_interval_s=_num(env, "INTAKE_RESCREEN_INTERVAL_SECONDS", 60.0, 0.01, 86400.0),
        rescreen_max_attempts=_int(env, "INTAKE_RESCREEN_MAX_ATTEMPTS", 3, 1, 100),
        rescreen_backoff_s=_num(env, "INTAKE_RESCREEN_BACKOFF_SECONDS", 300.0, 0.01, 86400.0),
        purge_interval_s=_num(env, "INTAKE_PURGE_INTERVAL_SECONDS", 3600.0, 0.01, 86400.0),
        log_level=level,
        policy=policy,
        retention=retention,
        classifier=clf,
        second_opinion=so,
        second_opinion_key_set=bool(so_key and so_key.strip()),
        secrets_dir=secrets_dir,
        callers=_caller_keys(secret["INTAKE_CALLER_KEYS"],
                             os.path.join(secrets_dir, SECRET_FILES["INTAKE_CALLER_KEYS"])),
        db_password=Secret(password),
        second_opinion_key=Secret(so_key),
    )
