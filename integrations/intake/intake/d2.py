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
  clean-with-rule-hit        opinion clean, rule weak                      suspicious (Policy, D40)
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

import math
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


@dataclass(frozen=True)
class Policy:
    """The policy points of the table that the operator may still set.

    weak_rule_judge_clean (D40, pending): the label of row `clean-with-rule-hit` - a WEAK rule
    hit that a judge who saw ALL the flagged evidence called clean. "suspicious" (the DESIGN
    section 5 row, the default) or "clean". Either way the row applies only with no missing
    stage, a complete judge input, no error and no expiry; nothing else in the table moves.
    Config: INTAKE_D2_WEAK_RULE_JUDGE_CLEAN (config.d2_policy)."""

    weak_rule_judge_clean: str = "suspicious"

    def __post_init__(self):
        if self.weak_rule_judge_clean not in ("suspicious", "clean"):
            raise ValueError("weak_rule_judge_clean is 'suspicious' or 'clean'")


DEFAULT_POLICY = Policy()


def decide(ev: Evidence, policy: Policy = DEFAULT_POLICY) -> Decision:
    if not isinstance(ev, Evidence):
        raise ValueError("decide() takes an Evidence")
    if not isinstance(policy, Policy):
        raise ValueError("decide() takes a d2.Policy")
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
        if ev.rule == "weak" and policy.weak_rule_judge_clean == "suspicious":
            return Decision("suspicious", "clean-with-rule-hit")
        if ev.rule == "missing" or ev.classifier == "missing":
            return Decision("suspicious", "clean-evidence-missing")
        if not ev.opinion_complete:
            return Decision("suspicious", "clean-partial")
        if ev.rule == "weak":  # D40 = clean: a complete judge clean clears a WEAK hit
            return Decision("clean", "clean-with-rule-hit")
        return Decision("clean", "second-opinion-clean")
    if ev.rule in ("weak", "missing") or ev.classifier in ("over", "missing"):
        return Decision("pending", "awaiting-second-opinion", second_opinion=True)
    return Decision("clean", "no-signal")


def _unit(v) -> float | None:
    """v as a float in [0, 1], or None (bool, non-number, NaN, inf, out of range)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) and 0.0 <= f <= 1.0 else None


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
    classifier = "missing"
    if stages.get("classifier") == "ok" and clf is not None:
        score, threshold = _unit(clf.get("max_score")), _unit(clf.get("threshold"))
        # attempt 1 T-F1: a score or threshold that is not a real number in [0, 1] (NaN, inf,
        # a string, a bool) is no evidence: `missing`, never `below`
        if score is not None and threshold is not None and threshold > 0.0:
            classifier = "over" if score >= threshold else "below"
    if result.needs_second_opinion and rule == "none" and classifier == "below":
        # T-F1: the result itself says the judge is needed, but no evidence here says why;
        # inconsistent evidence is missing evidence (never `no-signal`)
        classifier = "missing"
    if result.error is None:
        error = "none"
    else:
        error = result.error_kind if result.error_kind in ("transient", "permanent") else "transient"
    return Evidence(rule=rule, classifier=classifier, opinion=opinion,
                    opinion_complete=result.judge_complete if complete is None else bool(complete),
                    error=error, expired=bool(expired))
