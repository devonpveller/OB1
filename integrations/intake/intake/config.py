"""Intake configuration constants.

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
