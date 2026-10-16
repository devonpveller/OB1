"""A time limit that the stages enforce themselves (stage 8, DESIGN section 3).

Python cannot pre-empt a running C call, so the limit is cooperative: every loop in the stages
calls Deadline.check(), and every step between two checks is bounded (a single RE2 search, one
translate slice, one NFKC chunk, at most a few thousand HTML tags, one inline style). When the
time is up, check() raises DeadlineExceeded and the pipeline returns `pending`; the overshoot
is at most one step, measured up to ~0.3 s on 5 MB on the reference host under load (I2
findings).

What this does NOT bound: a single library call that cannot be interrupted (a stdlib parser
call such as the email feedparser, json, a C codec; the classifier's tokenizer and one model
forward pass). Their inputs are capped (limits.py) but their cost is not checked from inside.
Operator D38: every caller runs screen() in a killable worker process with a hard wall-clock
limit (build item I5), and an overrun is killed and stays `pending`.
"""
from __future__ import annotations

import time
from typing import Callable


class DeadlineExceeded(Exception):
    pass


class Deadline:
    __slots__ = ("_clock", "_end", "limit")

    def __init__(self, limit: float, clock: Callable[[], float] = time.perf_counter):
        self._clock = clock
        self.limit = limit
        self._end = clock() + limit

    def check(self) -> None:
        if self._clock() > self._end:
            raise DeadlineExceeded(f"deadline: the run passed {self.limit:.3f}s")

    def remaining(self) -> float:
        return self._end - self._clock()


class NoDeadline:
    """For calling a stage helper directly (tests, tools)."""

    limit = float("inf")

    def check(self) -> None:
        return None

    def remaining(self) -> float:
        return float("inf")


NONE = NoDeadline()
