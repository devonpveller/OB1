"""The real, hash-verified classifier for the I3 tests, loaded once per precision per process
with sockets already disabled (tests.support is imported first). The model files must have
been fetched and verified at setup time: `python tools/fetch_classifier.py` (they are never
fetched by a test)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from tests import support

from intake import classifier, config

FIXTURES = Path(__file__).with_name("fixtures")
_LOADED: dict[str, classifier.Classifier] = {}


def real(precision: str = "fp32") -> classifier.Classifier:
    if precision not in _LOADED:
        env = {k: v for k, v in os.environ.items() if not k.startswith("INTAKE_CLASSIFIER_")}
        if "INTAKE_CLASSIFIER_DIR" in os.environ:
            env["INTAKE_CLASSIFIER_DIR"] = os.environ["INTAKE_CLASSIFIER_DIR"]
        if "INTAKE_CLASSIFIER_THREADS" in os.environ:
            env["INTAKE_CLASSIFIER_THREADS"] = os.environ["INTAKE_CLASSIFIER_THREADS"]
        env["INTAKE_CLASSIFIER_PRECISION"] = precision
        clf = classifier.Classifier(config.classifier_config(env))
        try:
            clf.load()
        except classifier.ClassifierUnavailable as e:
            raise AssertionError(
                f"the classifier model is not available ({e}); fetch and verify it once with "
                "`python tools/fetch_classifier.py` (or set INTAKE_CLASSIFIER_DIR)") from None
        _LOADED[precision] = clf
    return _LOADED[precision]


def eval_fixture() -> dict:
    return json.loads((FIXTURES / "classifier_eval.json").read_text(encoding="utf-8"))


def corpus_items() -> list[tuple[str, str]]:
    """The I2 corpus as plain text: the 44 + 78 search-gateway snippets (title + excerpt) and the
    10 written articles of test_round2.F9StrongOnlyOnPayloadShapes."""
    from tests.test_round2 import F9StrongOnlyOnPayloadShapes
    out = []
    for name in ("legit_security_corpus.json", "tester_sg_corpus.json"):
        for it in json.loads((FIXTURES / name).read_text(encoding="utf-8"))["items"]:
            out.append((it["id"], it["title"] + "\n\n" + it["excerpt"]))
    for i, t in enumerate(F9StrongOnlyOnPayloadShapes.ARTICLES):
        out.append((f"article{i:02d}", t))
    return out


def corpus_fixture() -> dict:
    return json.loads((FIXTURES / "classifier_corpus_scores.json").read_text(encoding="utf-8"))


assert support
