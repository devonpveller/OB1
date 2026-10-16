"""The one result type every stage writes into (DESIGN-intake.md sections 2, 3, 5).

`verdict` is the verdict SO FAR, after the deterministic stages (I2). I3 (classifier) and I4
(second opinion) read it and may only make it stricter:

  rejected  stage 1 refused the envelope, or the content is a parser/normalisation bomb.
            Nothing is stored.
  injected  a STRONG rule fired. No text and no links are returned (DESIGN section 2).
  pending   undecided: a stage raised, the deadline passed, or a WEAK rule fired and the item
            needs the second opinion (needs_second_opinion=True). Never readable as clean.
  clean     every deterministic stage ran to the end without an error and no rule fired:
            "clean so far". I3 still scores it.

The only code path that produces `clean` is pipeline.screen() after stage 5 finishes; the
constructor below refuses `clean` when the trace holds an error, and refuses `clean` with
reasons (belt and braces for stage 8: missing evidence never resolves to clean).
"""
from __future__ import annotations

import types
from dataclasses import dataclass, field
from typing import Mapping

VERDICTS = ("clean", "pending", "injected", "rejected")
STRENGTHS = ("strong", "weak", "stage")
TRACE_STATUSES = ("ok", "stop", "error", "skipped")

COUNT_KEYS = (
    # stage 3
    "hidden_elements", "dropped_elements", "links_dropped", "truncated_bytes", "controls_refs",
    "attachments",
    # stage 4
    "tag", "bidi", "variation_selectors", "controls", "surrogates", "cf", "default_ignorable",
    "flag_tags_kept",
    "nonstarters_trimmed",
    # stage 5
    "neutralised_lines", "neutralised_refs",
)


@dataclass(frozen=True)
class Reason:
    rule: str
    strength: str
    detail: str = ""

    def __post_init__(self):
        if self.strength not in STRENGTHS:
            raise ValueError(f"unknown strength {self.strength!r}")

    def to_dict(self) -> dict:
        return {"rule": self.rule, "strength": self.strength, "detail": self.detail}


@dataclass(frozen=True)
class StageRecord:
    stage: str
    status: str
    ms: float
    detail: str = ""

    def __post_init__(self):
        if self.status not in TRACE_STATUSES:
            raise ValueError(f"unknown trace status {self.status!r}")

    def to_dict(self) -> dict:
        return {"stage": self.stage, "status": self.status, "ms": round(self.ms, 3),
                "detail": self.detail}


@dataclass(frozen=True)
class IdempotencyKey:
    """(source, external_id, sha256(raw)): DESIGN section 3 stage 2."""
    source: str
    external_id: str
    sha256: str

    def to_dict(self) -> dict:
        return {"source": self.source, "external_id": self.external_id, "sha256": self.sha256}


def _frozen_counts(counts: Mapping[str, int] | None) -> Mapping[str, int]:
    base = dict.fromkeys(COUNT_KEYS, 0)
    for k, v in (counts or {}).items():
        base[k] = int(v)
    return types.MappingProxyType(base)


@dataclass(frozen=True)
class IntakeResult:
    verdict: str
    reasons: tuple[Reason, ...] = ()
    counts: Mapping[str, int] = field(default_factory=lambda: _frozen_counts(None))
    links: tuple[Mapping[str, str], ...] = ()
    attachments: tuple[Mapping[str, object], ...] = ()
    text: str | None = None
    title: str | None = None
    trace: tuple[StageRecord, ...] = ()
    key: IdempotencyKey | None = None
    revision: int | None = None
    supersedes: str | None = None
    repeat: bool = False
    needs_second_opinion: bool = False
    error: str | None = None

    def __post_init__(self):
        if self.verdict not in VERDICTS:
            raise ValueError(f"unknown verdict {self.verdict!r}")
        object.__setattr__(self, "counts", _frozen_counts(self.counts))
        object.__setattr__(self, "reasons", tuple(self.reasons))
        object.__setattr__(self, "links", tuple(types.MappingProxyType(dict(x)) for x in self.links))
        object.__setattr__(self, "attachments",
                           tuple(types.MappingProxyType(dict(x)) for x in self.attachments))
        object.__setattr__(self, "trace", tuple(self.trace))
        if self.verdict == "clean":
            if self.error is not None or any(t.status == "error" for t in self.trace):
                raise ValueError("a result with a stage error cannot be clean")
            if self.reasons:
                raise ValueError("a result with reasons cannot be clean")
        if self.verdict in ("injected", "rejected") and (self.text is not None or self.links):
            raise ValueError(f"an {self.verdict} result carries no text and no links")

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "reasons": [r.to_dict() for r in self.reasons],
            "counts": dict(self.counts),
            "links": [dict(x) for x in self.links],
            "attachments": [dict(x) for x in self.attachments],
            "text": self.text,
            "title": self.title,
            "trace": [t.to_dict() for t in self.trace],
            "key": self.key.to_dict() if self.key else None,
            "revision": self.revision,
            "supersedes": self.supersedes,
            "repeat": self.repeat,
            "needs_second_opinion": self.needs_second_opinion,
            "error": self.error,
        }
