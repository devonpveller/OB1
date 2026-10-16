"""Intake configuration constants: retention (I1) and the classifier (I3).

Retention (operator decision D27, 2026-10-15; DESIGN-intake.md section 10 O5):
  * clean bronze (intake.raw_items) is kept 30 days so items can be re-screened when the
    classifier changes;
  * discard records (intake.discards) are kept 365 days;
  * an item waits at most 24 hours for the GPU second opinion, then becomes `suspicious`
    (never `clean`).

I1 ships these as config ONLY. Nothing here deletes anything: the purge jobs and the
second-opinion timeout that read them are build item I4.

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

_POSITIVE_INT = re.compile(r"[1-9][0-9]{0,5}")


class Retention(NamedTuple):
    bronze_days: int
    discard_days: int
    second_opinion_max_wait_hours: int


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
