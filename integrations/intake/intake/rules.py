"""Stage 5: linear rules (DESIGN-intake.md section 3, stage 5).

The rules live in rules.toml (id, strength, kind, pattern, rationale, positive and negative
examples). Patterns are RE2 (google-re2): RE2 guarantees time linear in the input for every
pattern, with no backtracking, which is why audit B4's backtracking blow-up cannot happen
here whatever a page contains. They are compiled over UTF-8 bytes with no capture groups, so
RE2 answers each search with its DFA.

evaluate() runs every rule over the NFKC copy (stage 4) and over the decoded TAG payload.
neutralise() rewrites the STORED text so forged '[Source N]' lines and prompt section labels
no longer look like the research prompts' own structure (audit B7):
  * a line that a `neutralise` rule matched (found in the copy; NFKC never adds or removes a
    newline, so line numbers carry over) gets the prefix "~ ";
  * every '[Source N]' token, ASCII or fullwidth brackets, becomes '(Source N)'.
"""
from __future__ import annotations

import functools
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

import re2

from .result import Reason

RULES_PATH = Path(__file__).with_name("rules.toml")
STRENGTHS = ("strong", "weak")
KINDS = ("regex", "tag-payload", "tag-chars")
NEUTRALISERS = ("source-line", "section-label")
MAX_NEUTRALISED = 10_000
NEUTRAL_PREFIX = "~ "

# Python `re`, linear by form: '[' or a fullwidth '[' starts every match, and the only
# backtracking is over a run of blanks that belongs to that one bracket.
_SOURCE_REF = re.compile(
    "[\\[\uff3b]([ \\t]*[Ss][Oo][Uu][Rr][Cc][Ee][ \\t]*[0-9\uff10-\uff19]+[ \\t]*)[\\]\uff3d]")
_TAG_WORD = re2.compile(rb"[A-Za-z]{3}")


class RulesError(Exception):
    pass


class NeutraliseBomb(Exception):
    """More than MAX_NEUTRALISED forged lines or tokens: the item is `rejected`. A page built
    of forged prompt structure is not content, and the cap keeps stage 5 cheap."""


@dataclass(frozen=True)
class Rule:
    id: str
    strength: str
    kind: str
    rationale: str
    positive: tuple[str, ...]
    negative: tuple[str, ...]
    pattern: str | None = None
    neutralise: str | None = None
    regex: object = None


def _compile(pattern: str):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.UTF8
    opt.max_mem = 64 << 20
    rx = re2.compile(pattern.encode("utf-8"), opt)
    if rx.groups:
        raise RulesError("rule patterns must not have capture groups (use (?:...))")
    return rx


def load_rules(path: Path = RULES_PATH) -> tuple[Rule, ...]:
    with open(path, "rb") as fh:
        doc = tomllib.load(fh)
    out: list[Rule] = []
    seen: set[str] = set()
    for raw in doc.get("rule", []):
        rid = raw.get("id")
        if not isinstance(rid, str) or not rid or rid in seen:
            raise RulesError(f"rule id {rid!r} is missing or repeated")
        seen.add(rid)
        strength, kind = raw.get("strength"), raw.get("kind")
        if strength not in STRENGTHS or kind not in KINDS:
            raise RulesError(f"{rid}: bad strength or kind")
        pos, neg = raw.get("positive"), raw.get("negative")
        if not pos or not neg or not all(isinstance(x, str) for x in [*pos, *neg]):
            raise RulesError(f"{rid}: needs at least one positive and one negative example")
        if not isinstance(raw.get("rationale"), str) or not raw["rationale"].strip():
            raise RulesError(f"{rid}: needs a rationale")
        neutralise = raw.get("neutralise")
        if neutralise is not None and neutralise not in NEUTRALISERS:
            raise RulesError(f"{rid}: unknown neutraliser {neutralise!r}")
        pattern = raw.get("pattern")
        regex = None
        if kind == "regex":
            if not isinstance(pattern, str) or not pattern:
                raise RulesError(f"{rid}: a regex rule needs a pattern")
            regex = _compile(pattern)
        unknown = set(raw) - {"id", "strength", "kind", "pattern", "rationale", "positive",
                              "negative", "neutralise"}
        if unknown:
            raise RulesError(f"{rid}: unknown field(s) {sorted(unknown)}")
        out.append(Rule(rid, strength, kind, raw["rationale"].strip(), tuple(pos), tuple(neg),
                        pattern, neutralise, regex))
    if not out:
        raise RulesError("no rules")
    return tuple(out)


@functools.lru_cache(maxsize=1)
def rules() -> tuple[Rule, ...]:
    return load_rules()


def _snippet(b: bytes, start: int, end: int) -> str:
    s = b[max(0, start - 30): min(end, start + 120) + 30].decode("utf-8", "replace")
    return " ".join(s.split())[:200]


def evaluate(copy: str, payloads: list[str], counts: dict[str, int]) -> list[Reason]:
    cb = copy.encode("utf-8")
    pb = [p.encode("utf-8") for p in payloads]
    reasons: list[Reason] = []
    tag_payload_hit = False
    for rule in rules():
        if rule.kind == "regex":
            m = rule.regex.search(cb)
            if m is not None:
                reasons.append(Reason(rule.id, rule.strength, _snippet(cb, *m.span())))
                continue
            for p in pb:
                m = rule.regex.search(p)
                if m is not None:
                    reasons.append(Reason(rule.id, rule.strength,
                                          "in TAG payload: " + _snippet(p, *m.span())))
                    break
        elif rule.kind == "tag-payload":
            hit = next((p for p in pb if _TAG_WORD.search(p)), None)
            if hit is not None or counts.get("tag_runs_capped"):
                tag_payload_hit = True
                detail = _snippet(hit, 0, 0) if hit is not None else "too many TAG runs to list"
                reasons.append(Reason(rule.id, rule.strength, "decoded: " + detail))
        elif rule.kind == "tag-chars":
            if counts.get("tag") and not tag_payload_hit:
                reasons.append(Reason(rule.id, rule.strength, f"{counts['tag']} TAG characters"))
    return reasons


def neutralise(stored: str, copy: str) -> tuple[str, int, int]:
    """Return (stored text with forged lines/tokens neutralised, lines changed, tokens
    changed). Raises RulesError when the copy and the stored text disagree on line count (the
    pipeline then fails closed) and NeutraliseBomb past MAX_NEUTRALISED hits (`rejected`)."""
    cb = copy.encode("utf-8")
    hit_lines: set[int] = set()
    for rule in rules():
        if rule.neutralise is None:
            continue
        line = 0
        prev = 0
        for m in rule.regex.finditer(cb):
            line += cb.count(b"\n", prev, m.start())
            prev = m.start()
            hit_lines.add(line)
            if len(hit_lines) > MAX_NEUTRALISED:
                raise NeutraliseBomb(f"more than {MAX_NEUTRALISED} forged lines")
    text = stored
    if hit_lines:
        lines = stored.split("\n")
        if len(lines) != cb.count(b"\n") + 1:
            raise RulesError("the NFKC copy and the stored text disagree on line count")
        for i in hit_lines:
            lines[i] = NEUTRAL_PREFIX + lines[i]
        text = "\n".join(lines)
    text, refs = _SOURCE_REF.subn(r"(\1)", text, count=MAX_NEUTRALISED + 1)
    if refs > MAX_NEUTRALISED:
        raise NeutraliseBomb(f"more than {MAX_NEUTRALISED} forged [Source N] tokens")
    return text, len(hit_lines), refs
