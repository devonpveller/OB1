"""D2 quarantine as code (DESIGN-intake.md section 5; operator D2, D24, D27; I4).

    decide(Evidence) -> Decision        one pure function, no I/O

The evidence about one item, each part as a closed set of values:

  rule        none | weak | strong | missing    stage 5 (missing: the stage did not finish)
  classifier  below | over | missing            stage 6 (over: max chunk score >= threshold)
  opinion     not_asked | awaiting | clean | injection | uncertain
                                                stage 7, the second opinion's answer
  opinion_complete                              the judge read ALL the flagged evidence
  error       none | transient | permanent      stage 8 (permanent: retrying cannot help,
                                                e.g. the classifier's budget, I3 F-2)
  expired     the item has waited the D27 cap (24 h) or used its attempt budget

The table, first matching row wins (`row` names it):

  row                        when                                          label
  strong-rule                rule strong                                   injected
  second-opinion-injection   opinion injection                             injected
  permanent-error            error permanent                               suspicious
  second-opinion-uncertain   opinion uncertain                             suspicious
  expired                    expired                                       suspicious
  transient-error            error transient                               pending (retry the screen)
  clean-with-rule-hit        opinion clean, rule weak                      suspicious
  clean-evidence-missing     opinion clean, rule or classifier missing     suspicious
  clean-partial              opinion clean, judge saw only part            suspicious
  second-opinion-clean       opinion clean, nothing else against           clean
  awaiting-second-opinion    rule weak/missing or classifier over/missing  pending (ask the judge)
  no-signal                  rule none, classifier below                   clean

The fixed tie-break: a disagreement goes to the less-trusted label (injected < pending <
suspicious < clean), and missing evidence never resolves to `clean`. `clean` is reached only
by "no-signal" (nothing fired, nothing missing) and "second-opinion-clean" (the classifier
alone was over the threshold and a judge that read every flagged chunk said clean; D24).
`pending` is unreadable; `suspicious` is served to tool-less reads only and purged at 30 days
(purge.py); `injected` keeps only a discard record.
"""
from __future__ import annotations

from dataclasses import dataclass

from .result import IntakeResult

RULE_VALUES = ("none", "weak", "strong", "missing")
CLASSIFIER_VALUES = ("below", "over", "missing")
OPINION_VALUES = ("not_asked", "awaiting", "clean", "injection", "uncertain")
ERROR_VALUES = ("none", "transient", "permanent")
LABELS = ("clean", "suspicious", "pending", "injected")
# lower = less trusted (the tie-break order)
TRUST = {"injected": 0, "pending": 1, "suspicious": 2, "clean": 3}

ROWS = (
    "strong-rule", "second-opinion-injection", "permanent-error", "second-opinion-uncertain",
    "expired", "transient-error", "clean-with-rule-hit", "clean-evidence-missing",
    "clean-partial", "second-opinion-clean", "awaiting-second-opinion", "no-signal",
)


@dataclass(frozen=True)
class Evidence:
    rule: str = "missing"
    classifier: str = "missing"
    opinion: str = "not_asked"
    opinion_complete: bool = False
    error: str = "none"
    expired: bool = False

    def __post_init__(self):
        for name, allowed in (("rule", RULE_VALUES), ("classifier", CLASSIFIER_VALUES),
                              ("opinion", OPINION_VALUES), ("error", ERROR_VALUES)):
            if getattr(self, name) not in allowed:
                raise ValueError(f"{name}={getattr(self, name)!r} is not one of {allowed}")
        for name in ("opinion_complete", "expired"):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name} must be a bool")


@dataclass(frozen=True)
class Decision:
    label: str             # clean | suspicious | pending | injected
    row: str               # which row of the table decided
    retry: bool = False    # pending: re-run the screen (a transient error)
    second_opinion: bool = False  # pending: waiting for the judge

    def to_dict(self) -> dict:
        return {"label": self.label, "row": self.row, "retry": self.retry,
                "second_opinion": self.second_opinion}


def decide(ev: Evidence) -> Decision:
    if not isinstance(ev, Evidence):
        raise ValueError("decide() takes an Evidence")
    if ev.rule == "strong":
        return Decision("injected", "strong-rule")
    if ev.opinion == "injection":
        return Decision("injected", "second-opinion-injection")
    if ev.error == "permanent":
        return Decision("suspicious", "permanent-error")
    if ev.opinion == "uncertain":
        return Decision("suspicious", "second-opinion-uncertain")
    if ev.expired:
        return Decision("suspicious", "expired")
    if ev.error == "transient":
        return Decision("pending", "transient-error", retry=True)
    if ev.opinion == "clean":
        if ev.rule == "weak":
            return Decision("suspicious", "clean-with-rule-hit")
        if ev.rule == "missing" or ev.classifier == "missing":
            return Decision("suspicious", "clean-evidence-missing")
        if not ev.opinion_complete:
            return Decision("suspicious", "clean-partial")
        return Decision("clean", "second-opinion-clean")
    if ev.rule in ("weak", "missing") or ev.classifier in ("over", "missing"):
        return Decision("pending", "awaiting-second-opinion", second_opinion=True)
    return Decision("clean", "no-signal")


def evidence_from(result: IntakeResult, *, opinion: str = "not_asked", complete: bool | None = None,
                  expired: bool = False) -> Evidence:
    """The table's input from a stage 1-6 result plus what the second opinion has said so far.
    `complete` defaults to the result's judge_complete. A `rejected` item stores nothing and is
    not a D2 input (ValueError)."""
    if result.verdict == "rejected":
        raise ValueError("a rejected item is not a D2 input: nothing is stored")
    stages = {t.stage: t.status for t in result.trace}
    if result.verdict == "injected":
        rule = "strong"
    elif stages.get("rules") == "ok":
        rule = "weak" if any(r.strength == "weak" for r in result.reasons) else "none"
    else:
        rule = "missing"
    clf = result.classifier
    if stages.get("classifier") == "ok" and clf is not None:
        try:
            over = float(clf["max_score"]) >= float(clf["threshold"])
            classifier = "over" if over else "below"
        except (KeyError, TypeError, ValueError):
            classifier = "missing"
    else:
        classifier = "missing"
    if result.error is None:
        error = "none"
    else:
        error = result.error_kind if result.error_kind in ("transient", "permanent") else "transient"
    return Evidence(rule=rule, classifier=classifier, opinion=opinion,
                    opinion_complete=result.judge_complete if complete is None else bool(complete),
                    error=error, expired=bool(expired))
