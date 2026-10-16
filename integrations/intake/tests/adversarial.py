"""Generators of adversarial inputs for the bound tests (intake-i2 round 2).

* spaced(rule, size, seed, prefix_only): the attempt-1 tester's "rule prefixes at random spacing", for ANY
  rule: the rule's own fragments (every word and punctuation run of its positive examples,
  and every prefix of each), separated by 0-5 random filler characters with no newline and no
  sentence end, so every candidate stays alive in the rule's gaps. Uniform repetition keeps a
  DFA small; random spacing is what filled RE2's DFA cache in attempt 1.
* huge_tags(): one single tag filling the 2 MB HTML cap, built from each alternative of the
  tag tokenizer (attribute separators, '=', quotes, slashes), the attempt-1 `<a/=/=...` shape.
"""
from __future__ import annotations

import random
import re

MB = 1024 * 1024
FILLER = "abcdefghij  _-:/<>[]()!{}$%=\"'"


def fragments(rule, prefix_only: bool = False) -> list[str]:
    """Words, punctuation runs and their prefixes from the rule's positive examples. With
    prefix_only, only from the first 60% of each example: candidates that start a match and
    (mostly) never finish one, so a search reads all the input."""
    out: set[str] = set()
    for text in rule.positive:
        if prefix_only:
            text = text[: max(2, len(text) * 6 // 10)]
        for tok in re.findall(r"\w+|[^\w\s]+", text):
            out.add(tok)
            for i in range(1, min(len(tok), 6)):
                out.add(tok[:i])
        out.add(text[:12])
    return sorted(out)


def spaced(rule, size: int = 5 * MB, seed: int = 20261015, prefix_only: bool = True) -> str:
    rnd = random.Random(seed)
    frags = fragments(rule, prefix_only)
    parts: list[str] = []
    n = 0
    while n < size:
        f = rnd.choice(frags) if rnd.random() < 0.8 else rnd.choice(frags).upper()
        filler = "".join(rnd.choice(FILLER) for _ in range(rnd.randint(0, 5)))
        piece = f + filler
        parts.append(piece)
        n += len(piece.encode("utf-8"))
    return fit("".join(parts), size)


def fit(s: str, cap: int) -> str:
    """s cut so that its UTF-8 is at most cap bytes."""
    return s.encode("utf-8")[:cap].decode("utf-8", "ignore")


def huge_tags(size: int = 2 * MB) -> dict[str, str]:
    units = {
        "/=": "/=", " =": " =", "= ": "= ", " b=": " b=", "b=": "b=", "=\"\"": '=""',
        "\" ": '" ', "' ": "' ", "a\"": 'a"', "=x ": "=x ", "//": "//", " ": " ", "=": "=",
    }
    out = {}
    for label, unit in units.items():
        for opener in ("<a", "<p", "<img", "</div"):
            body = unit * ((size - 16) // len(unit))
            out[f"{opener} + {label!r}"] = (opener + body)[: size - 8] + ">x"
    return out
