"""The one result type every stage writes into (DESIGN-intake.md sections 2, 3, 5).

`verdict` is the verdict after stages 1-6 (I2 deterministic stages, I3 classifier). I4 (second
opinion) reads it and may only make it stricter:

  rejected  stage 1 refused the envelope, or the content is a parser/normalisation bomb.
            Nothing is stored.
  injected  a STRONG rule fired. No text and no links are returned (DESIGN section 2).
  pending   undecided: a stage raised (the classifier included), the deadline passed, or a
            WEAK rule fired or the classifier's max chunk score reached the threshold and the
            item needs the second opinion (needs_second_opinion=True). Never readable as clean.
  clean     every stage ran to the end without an error, no rule fired and the classifier
            scored below the threshold: "clean so far" (I4 decides only uncertain items).

The only code path that produces `clean` is pipeline.screen() after stage 6 finishes; the
constructor below refuses `clean` when the trace holds an error, and refuses `clean` with
reasons (belt and braces for stage 8: missing evidence never resolves to clean).

I4 adds:
  error_kind      with an error only: `permanent` when retrying cannot help (the classifier's
                  time or chunk budget, I3 F-2: D2 sends it to `suspicious`), else `transient`
                  (retried, then `suspicious` at the 24 h cap).
  rescreen        a repeat whose stored result was scored by another classifier version (or by
                  none, before I3) and whose verdict depended on it (I3 F-3, DESIGN section 7
                  "classifier upgrade"): the stored record stands, the caller re-screens.
  judge_chunks    for an item waiting for the second opinion: the text the judge reads (the
                  flagged classifier chunks and the context of each WEAK rule hit, from the
                  stage-4 copy the classifier and the rules read), capped.
  judge_complete  whether judge_chunks hold ALL of that evidence; a `clean` from a judge that
                  saw only part of it never resolves to `clean` (d2.py).
"""
from __future__ import annotations

import types
from dataclasses import dataclass, field
from typing import Mapping

VERDICTS = ("clean", "pending", "injected", "rejected")
ERROR_KINDS = ("transient", "permanent")
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
    # stage 6 (I3): the model version that scored the item, and its scores (max, chunks, the
    # flagged chunks with offsets); None when the classifier did not run
    classifier_version: str | None = None
    classifier: Mapping[str, object] | None = None
    # I4
    error_kind: str | None = None
    rescreen: bool = False
    judge_chunks: tuple[Mapping[str, object], ...] = ()
    judge_complete: bool = False

    def __post_init__(self):
        if self.verdict not in VERDICTS:
            raise ValueError(f"unknown verdict {self.verdict!r}")
        object.__setattr__(self, "counts", _frozen_counts(self.counts))
        object.__setattr__(self, "reasons", tuple(self.reasons))
        object.__setattr__(self, "links", tuple(types.MappingProxyType(dict(x)) for x in self.links))
        object.__setattr__(self, "attachments",
                           tuple(types.MappingProxyType(dict(x)) for x in self.attachments))
        object.__setattr__(self, "trace", tuple(self.trace))
        if self.classifier is not None:
            c = dict(self.classifier)
            c["flagged"] = tuple(types.MappingProxyType(dict(x)) for x in c.get("flagged", ()))
            object.__setattr__(self, "classifier", types.MappingProxyType(c))
        if self.verdict == "clean":
            if self.error is not None or any(t.status == "error" for t in self.trace):
                raise ValueError("a result with a stage error cannot be clean")
            if self.reasons:
                raise ValueError("a result with reasons cannot be clean")
        if self.verdict in ("injected", "rejected") and (self.text is not None or self.links):
            raise ValueError(f"an {self.verdict} result carries no text and no links")
        if self.error_kind is not None:
            if self.error_kind not in ERROR_KINDS:
                raise ValueError(f"unknown error kind {self.error_kind!r}")
            if self.error is None:
                raise ValueError("an error kind needs an error")
        object.__setattr__(self, "judge_chunks",
                           tuple(types.MappingProxyType(dict(x)) for x in self.judge_chunks))
        if (self.judge_chunks or self.judge_complete) and not (
                self.verdict == "pending" and self.needs_second_opinion):
            raise ValueError("judge chunks belong to an item waiting for the second opinion")

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
            "classifier_version": self.classifier_version,
            "classifier": (None if self.classifier is None else
                           {**self.classifier, "flagged": [dict(x) for x in self.classifier["flagged"]]}),
            "error_kind": self.error_kind,
            "rescreen": self.rescreen,
            "judge_chunks": [dict(x) for x in self.judge_chunks],
            "judge_complete": self.judge_complete,
        }
