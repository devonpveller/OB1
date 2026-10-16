"""Intake configuration constants: retention (I1, I4), the classifier (I3) and the second
opinion (I4).

Retention (operator decision D27, 2026-10-15; DESIGN-intake.md section 10 O5):
  * clean bronze (intake.raw_items) is kept 30 days so items can be re-screened when the
    classifier changes;
  * discard records (intake.discards) are kept 365 days;
  * an item waits at most 24 hours for the GPU second opinion, then becomes `suspicious`
    (never `clean`);
  * a `suspicious` item's bronze is purged after 30 days (D2 "held items purged after 30
    days"; I4).

Nothing here deletes anything: purge.py and second_opinion.py read these values.

Each value can be overridden from the environment (INTAKE_<NAME>). An override that is not a
positive whole number is REFUSED rather than replaced by the default: a typo must not
silently become "keep forever" or "keep nothing".
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Mapping, NamedTuple

BRONZE_RETENTION_DAYS = 30
DISCARD_RETENTION_DAYS = 365
SECOND_OPINION_MAX_WAIT_HOURS = 24
SUSPICIOUS_RETENTION_DAYS = 30

_POSITIVE_INT = re.compile(r"[1-9][0-9]{0,5}")


class Retention(NamedTuple):
    bronze_days: int
    discard_days: int
    second_opinion_max_wait_hours: int
    suspicious_days: int = SUSPICIOUS_RETENTION_DAYS


def _read(env: Mapping[str, str], name: str, default: int) -> int:
    key = "INTAKE_" + name
    if key not in env:
        return default
    raw = env[key]
    if not _POSITIVE_INT.fullmatch(raw):
        raise ValueError(f"{key}={raw!r} is not a positive whole number")
    return int(raw)


def retention(env: Mapping[str, str] | None = None) -> Retention:
    env = os.environ if env is None else env
    return Retention(
        _read(env, "BRONZE_RETENTION_DAYS", BRONZE_RETENTION_DAYS),
        _read(env, "DISCARD_RETENTION_DAYS", DISCARD_RETENTION_DAYS),
        _read(env, "SECOND_OPINION_MAX_WAIT_HOURS", SECOND_OPINION_MAX_WAIT_HOURS),
        _read(env, "SUSPICIOUS_RETENTION_DAYS", SUSPICIOUS_RETENTION_DAYS),
    )


# -- the classifier, stage 6 (I3; operator D24/D26 and the CPU-upgrade note) -------------------
# Everything that depends on the host is config, not code: the precision, the thread count and
# the worker count change when the CPU does (the i7-7820X is due to become an 18-core part with
# AVX-512 VNNI). Measured on the i7-7820X (intake-i3 findings): fp32 at 8 threads.
#
#   INTAKE_CLASSIFIER_DIR            the verified model files (tools/fetch_classifier.py);
#                                    default: models/<repo>-<revision[:8]> beside the package
#                                    (gitignored)
#   INTAKE_CLASSIFIER_PRECISION      fp32 | int8
#   INTAKE_CLASSIFIER_INT8_LAYERS    with int8: which encoder Linear groups are quantised, a
#                                    comma list of attention_output, qkv, intermediate,
#                                    ffn_output (default attention_output: the only group
#                                    within the eval tolerance on the i7-7820X)
#   INTAKE_CLASSIFIER_THREADS        torch intra-op threads per worker process
#   INTAKE_CLASSIFIER_WORKERS        screening worker processes (read by the I5 service)
#   INTAKE_CLASSIFIER_THRESHOLD      a max chunk score >= this goes to the second opinion
#   INTAKE_CLASSIFIER_CHUNK_TOKENS   tokens per chunk, [CLS] and [SEP] included
#   INTAKE_CLASSIFIER_OVERLAP_TOKENS tokens shared by neighbouring chunks
#   INTAKE_CLASSIFIER_MAX_CHUNKS     a text needing more chunks is refused (pending)
#   INTAKE_CLASSIFIER_MAX_SECONDS    scoring budget per item, checked before every chunk
#
# Like retention, a value that does not parse or is out of range is REFUSED (ValueError), never
# replaced by the default.
CLASSIFIER_DIR_NAME = "protectai-deberta-v3-base-prompt-injection-v2-90c9989b"
DEFAULT_CLASSIFIER_DIR = str(Path(__file__).resolve().parent.parent / "models" / CLASSIFIER_DIR_NAME)
CLASSIFIER_PRECISIONS = ("fp32", "int8")
CLASSIFIER_PRECISION = "fp32"
CLASSIFIER_INT8_GROUPS = ("attention_output", "qkv", "intermediate", "ffn_output")
CLASSIFIER_INT8_LAYERS = ("attention_output",)
CLASSIFIER_THREADS = 8
CLASSIFIER_WORKERS = 1
CLASSIFIER_THRESHOLD = 0.5
CLASSIFIER_CHUNK_TOKENS = 256
CLASSIFIER_OVERLAP_TOKENS = 32
CLASSIFIER_MAX_CHUNKS = 400
CLASSIFIER_MAX_SECONDS = 180.0

_FLOAT = re.compile(r"[0-9]{1,6}(\.[0-9]{1,6})?")


class ClassifierConfig(NamedTuple):
    model_dir: str = DEFAULT_CLASSIFIER_DIR
    precision: str = CLASSIFIER_PRECISION
    int8_layers: tuple = CLASSIFIER_INT8_LAYERS
    threads: int = CLASSIFIER_THREADS
    workers: int = CLASSIFIER_WORKERS
    threshold: float = CLASSIFIER_THRESHOLD
    chunk_tokens: int = CLASSIFIER_CHUNK_TOKENS
    overlap_tokens: int = CLASSIFIER_OVERLAP_TOKENS
    max_chunks: int = CLASSIFIER_MAX_CHUNKS
    max_seconds: float = CLASSIFIER_MAX_SECONDS


def _int_in(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    key = "INTAKE_CLASSIFIER_" + name
    if key not in env:
        return default
    raw = env[key]
    if not re.fullmatch(r"[0-9]{1,6}", raw) or not lo <= int(raw) <= hi:
        raise ValueError(f"{key}={raw!r} is not a whole number in [{lo}, {hi}]")
    return int(raw)


def _float_in(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    key = "INTAKE_CLASSIFIER_" + name
    if key not in env:
        return default
    raw = env[key]
    if not _FLOAT.fullmatch(raw) or not lo <= float(raw) <= hi:
        raise ValueError(f"{key}={raw!r} is not a number in [{lo}, {hi}]")
    return float(raw)


def classifier_config(env: Mapping[str, str] | None = None) -> ClassifierConfig:
    env = os.environ if env is None else env
    precision = env.get("INTAKE_CLASSIFIER_PRECISION", CLASSIFIER_PRECISION)
    if precision not in CLASSIFIER_PRECISIONS:
        raise ValueError(f"INTAKE_CLASSIFIER_PRECISION={precision!r} is not one of {CLASSIFIER_PRECISIONS}")
    model_dir = env.get("INTAKE_CLASSIFIER_DIR", DEFAULT_CLASSIFIER_DIR)
    if not model_dir.strip():
        raise ValueError("INTAKE_CLASSIFIER_DIR is empty")
    raw_layers = env.get("INTAKE_CLASSIFIER_INT8_LAYERS")
    if raw_layers is None:
        int8_layers = CLASSIFIER_INT8_LAYERS
    else:
        parts = [p.strip() for p in raw_layers.split(",")]
        if not parts or any(p not in CLASSIFIER_INT8_GROUPS for p in parts) or len(set(parts)) != len(parts):
            raise ValueError(f"INTAKE_CLASSIFIER_INT8_LAYERS={raw_layers!r}: a comma list of "
                             f"{CLASSIFIER_INT8_GROUPS}, no repeats")
        int8_layers = tuple(g for g in CLASSIFIER_INT8_GROUPS if g in parts)
    chunk = _int_in(env, "CHUNK_TOKENS", CLASSIFIER_CHUNK_TOKENS, 16, 512)
    overlap = _int_in(env, "OVERLAP_TOKENS", CLASSIFIER_OVERLAP_TOKENS, 0, 512)
    if overlap > (chunk - 2) // 2:
        raise ValueError(f"INTAKE_CLASSIFIER_OVERLAP_TOKENS={overlap} is more than half a chunk")
    return ClassifierConfig(
        model_dir=model_dir,
        precision=precision,
        int8_layers=int8_layers,
        threads=_int_in(env, "THREADS", CLASSIFIER_THREADS, 1, 256),
        workers=_int_in(env, "WORKERS", CLASSIFIER_WORKERS, 1, 64),
        threshold=_float_in(env, "THRESHOLD", CLASSIFIER_THRESHOLD, 0.01, 1.0),
        chunk_tokens=chunk,
        overlap_tokens=overlap,
        max_chunks=_int_in(env, "MAX_CHUNKS", CLASSIFIER_MAX_CHUNKS, 1, 100_000),
        max_seconds=_float_in(env, "MAX_SECONDS", CLASSIFIER_MAX_SECONDS, 0.1, 86_400.0),
    )


# -- the second opinion, stage 7 (I4; DESIGN section 3 stage 7, operator D2/D27) ---------------
# The judge is the GPU model, reached ONLY through the LiteLLM gateway alias (the base URL is a
# constant in second_opinion.py, not config: CLAUDE.md "never route inference around LiteLLM").
#
#   INTAKE_SECOND_OPINION_KEY                  intake's own LiteLLM virtual key (a secret; read
#                                              by second_opinion.Judge, never stored in config,
#                                              never logged). Missing: every ask is `no_key`.
#   INTAKE_SECOND_OPINION_MODEL                a gateway model name (default local-large:nothink)
#   INTAKE_SECOND_OPINION_QUEUE_USER           the OpenAI `user` field llm-queue attributes the
#                                              batch class from (default ob-intake)
#   INTAKE_SECOND_OPINION_TIMEOUT_SECONDS      one request (default 120)
#   INTAKE_SECOND_OPINION_MAX_ATTEMPTS         asks per item before it expires (default 12)
#   INTAKE_SECOND_OPINION_BACKOFF_BASE_SECONDS first retry delay, doubled per attempt (60)
#   INTAKE_SECOND_OPINION_BACKOFF_CAP_SECONDS  longest delay (3600)
#   INTAKE_SECOND_OPINION_MAX_TOKENS           the reply budget (default 32; the answer is
#                                              one short JSON object)
# The 24 h wait cap is Retention.second_opinion_max_wait_hours above (D27).
SECOND_OPINION_MODEL = "local-large:nothink"
SECOND_OPINION_QUEUE_USER = "ob-intake"
SECOND_OPINION_TIMEOUT_SECONDS = 120.0
SECOND_OPINION_MAX_ATTEMPTS = 12
SECOND_OPINION_BACKOFF_BASE_SECONDS = 60.0
SECOND_OPINION_BACKOFF_CAP_SECONDS = 3600.0
SECOND_OPINION_MAX_TOKENS = 32

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}")


class SecondOpinionConfig(NamedTuple):
    model: str = SECOND_OPINION_MODEL
    queue_user: str = SECOND_OPINION_QUEUE_USER
    timeout_seconds: float = SECOND_OPINION_TIMEOUT_SECONDS
    max_attempts: int = SECOND_OPINION_MAX_ATTEMPTS
    backoff_base_seconds: float = SECOND_OPINION_BACKOFF_BASE_SECONDS
    backoff_cap_seconds: float = SECOND_OPINION_BACKOFF_CAP_SECONDS
    max_tokens: int = SECOND_OPINION_MAX_TOKENS


def _so_name(env: Mapping[str, str], name: str, default: str) -> str:
    key = "INTAKE_SECOND_OPINION_" + name
    if key not in env:
        return default
    raw = env[key]
    if not _NAME.fullmatch(raw):
        raise ValueError(f"{key}={raw!r} is not a plain name ([A-Za-z0-9._:/@-], 1-128 chars)")
    return raw


def _so_float(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    key = "INTAKE_SECOND_OPINION_" + name
    if key not in env:
        return default
    raw = env[key]
    if not _FLOAT.fullmatch(raw) or not lo <= float(raw) <= hi:
        raise ValueError(f"{key}={raw!r} is not a number in [{lo}, {hi}]")
    return float(raw)


def _so_int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    key = "INTAKE_SECOND_OPINION_" + name
    if key not in env:
        return default
    raw = env[key]
    if not re.fullmatch(r"[0-9]{1,6}", raw) or not lo <= int(raw) <= hi:
        raise ValueError(f"{key}={raw!r} is not a whole number in [{lo}, {hi}]")
    return int(raw)


def second_opinion_config(env: Mapping[str, str] | None = None) -> SecondOpinionConfig:
    """The second-opinion settings (not the key: second_opinion.Judge reads that itself, so
    it never sits in a config object that might be printed)."""
    env = os.environ if env is None else env
    base = _so_float(env, "BACKOFF_BASE_SECONDS", SECOND_OPINION_BACKOFF_BASE_SECONDS, 1.0, 86_400.0)
    cap = _so_float(env, "BACKOFF_CAP_SECONDS", SECOND_OPINION_BACKOFF_CAP_SECONDS, 1.0, 86_400.0)
    if cap < base:
        raise ValueError("INTAKE_SECOND_OPINION_BACKOFF_CAP_SECONDS is below the base delay")
    return SecondOpinionConfig(
        model=_so_name(env, "MODEL", SECOND_OPINION_MODEL),
        queue_user=_so_name(env, "QUEUE_USER", SECOND_OPINION_QUEUE_USER),
        timeout_seconds=_so_float(env, "TIMEOUT_SECONDS", SECOND_OPINION_TIMEOUT_SECONDS, 1.0, 3600.0),
        max_attempts=_so_int(env, "MAX_ATTEMPTS", SECOND_OPINION_MAX_ATTEMPTS, 1, 1000),
        backoff_base_seconds=base,
        backoff_cap_seconds=cap,
        max_tokens=_so_int(env, "MAX_TOKENS", SECOND_OPINION_MAX_TOKENS, 8, 64),
    )


# -- the D2 table's policy point (I4 round 2; operator decision D40 = (a), 2026-10-16) ----------
#   INTAKE_D2_WEAK_RULE_JUDGE_CLEAN   clean (default, D40) | suspicious: the label of d2 row
#                                     clean-with-rule-hit. Anything else is refused.
D2_WEAK_RULE_JUDGE_CLEAN = "clean"


def d2_policy(env: Mapping[str, str] | None = None):
    from .d2 import Policy
    env = os.environ if env is None else env
    raw = env.get("INTAKE_D2_WEAK_RULE_JUDGE_CLEAN", D2_WEAK_RULE_JUDGE_CLEAN)
    if raw not in ("suspicious", "clean"):
        raise ValueError(f"INTAKE_D2_WEAK_RULE_JUDGE_CLEAN={raw!r} is not 'suspicious' or 'clean'")
    return Policy(weak_rule_judge_clean=raw)
