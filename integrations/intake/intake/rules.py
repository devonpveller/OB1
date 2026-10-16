"""Stage 5: linear rules (DESIGN-intake.md section 3, stage 5).

The rules live in rules.toml (id, strength, kind, pattern, rationale, positive and negative
examples; see the header there for the cue/combo design and the pattern discipline that keeps
RE2 on its DFA). Patterns are RE2 (google-re2): RE2 guarantees time linear in the input with
no backtracking, which is why audit B4's backtracking blow-up cannot happen here; and because
the patterns have no counted repetition over overlapping candidates and no capture groups,
RE2's DFA stays small and answers each search alone (it does not fall back to the slower NFA;
tests/test_bounds.py asserts RE2 never logs "DFA out of memory" on any rule's worst input).

evaluate() runs every rule over the NFKC copy (stage 4), over the decoded TAG payloads and
over the side text (link texts, alt/title, attachment names). A STRONG rule decides
`injected`; two different cue rules within a combo window decide `injected`; any other hit is
a WEAK reason.

neutralise() rewrites the STORED text so forged '[Source N]' lines and prompt section labels
no longer look like the research prompts' own structure (audit B7):
  * a line that a `neutralise` rule matched (found in the NFKC copy; NFKC never adds or removes
    a newline, so line numbers carry over) gets the prefix "~ ";
  * on every line where the NFKC copy holds a '[Source N]' token (whatever compatibility
    characters the stored text used to spell it, attempt 1 F-7), every character whose NFKC
    form is '[' or ']' becomes '(' or ')'.
"""
from __future__ import annotations

import functools
import tomllib
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import re2

from . import deadline as _deadline
from . import limits
from .result import Reason

RULES_PATH = Path(__file__).with_name("rules.toml")
STRENGTHS = ("strong", "weak")
KINDS = ("regex", "combo", "tag-payload", "tag-chars")
NEUTRALISERS = ("source-line", "section-label")
MAX_NEUTRALISED = limits.MAX_NEUTRALISED
NEUTRAL_PREFIX = "~ "


def _utf8(pattern: str):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.UTF8
    opt.max_mem = 64 << 20
    return re2.compile(pattern.encode("utf-8"), opt)


_TAG_WORD = re2.compile(rb"[A-Za-z]{3}")
_SOURCE_TOKEN = _utf8(r"(?i)\[\s*source\s*[0-9]+\s*\]")
# every character whose NFKC form is '[' / ']' (ASCII, fullwidth, presentation forms)
_OPEN_BRACKETS = "".join(chr(c) for c in range(0x10000) if not 0xD800 <= c <= 0xDFFF
                         and unicodedata.normalize("NFKC", chr(c)) == "[")
_CLOSE_BRACKETS = "".join(chr(c) for c in range(0x10000) if not 0xD800 <= c <= 0xDFFF
                          and unicodedata.normalize("NFKC", chr(c)) == "]")
_BRACKETS_TO_PARENS = {**{ord(c): "(" for c in _OPEN_BRACKETS}, **{ord(c): ")" for c in _CLOSE_BRACKETS}}


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
    cue: bool = False
    window: int = 0
    regex: object = None


def _compile(pattern: str):
    rx = _utf8(pattern)
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
        cue = raw.get("cue", False)
        if not isinstance(cue, bool) or (cue and (strength != "weak" or kind != "regex")):
            raise RulesError(f"{rid}: a cue is a weak regex rule")
        window = raw.get("window", 0)
        if kind == "combo" and (not isinstance(window, int) or window <= 0 or strength != "strong"):
            raise RulesError(f"{rid}: a combo rule is strong and needs a positive window")
        pattern = raw.get("pattern")
        regex = None
        if kind == "regex":
            if not isinstance(pattern, str) or not pattern:
                raise RulesError(f"{rid}: a regex rule needs a pattern")
            regex = _compile(pattern)
        unknown = set(raw) - {"id", "strength", "kind", "pattern", "rationale", "positive",
                              "negative", "neutralise", "cue", "window"}
        if unknown:
            raise RulesError(f"{rid}: unknown field(s) {sorted(unknown)}")
        out.append(Rule(rid, strength, kind, raw["rationale"].strip(), tuple(pos), tuple(neg),
                        pattern, neutralise, cue, window, regex))
    if not out:
        raise RulesError("no rules")
    if sum(r.kind == "combo" for r in out) > 1:
        raise RulesError("at most one combo rule")
    return tuple(out)


@functools.lru_cache(maxsize=1)
def rules() -> tuple[Rule, ...]:
    return load_rules()


def locate(rule_id: str, text: str) -> tuple[int, int] | None:
    """Character offsets (start, end) of the first match of regex rule `rule_id` in `text`, or
    None (no such regex rule, or no match). One RE2 search: linear. Used by I4 to give the
    second opinion the context of each WEAK rule hit."""
    rule = next((r for r in rules() if r.id == rule_id and r.kind == "regex"), None)
    if rule is None:
        return None
    b = text.encode("utf-8", "surrogatepass")
    m = rule.regex.search(b)
    if m is None:
        return None
    start = len(b[:m.start()].decode("utf-8", "ignore"))
    end = start + len(b[m.start():m.end()].decode("utf-8", "ignore"))
    return start, end


def _snippet(b: bytes, start: int, end: int) -> str:
    s = b[max(0, start - 30): min(end, start + 120) + 30].decode("utf-8", "replace")
    return " ".join(s.split())[:200]


def _cue_offsets(rule: Rule, b: bytes, dl) -> list[int]:
    out = []
    for i, m in enumerate(rule.regex.finditer(b)):
        if i >= limits.CUE_MAX_MATCHES:
            break
        if not i & 127:
            dl.check()
        out.append(m.start())
    return out


def _combo(window: int, offsets: dict[str, list[int]]) -> tuple[str, str, int] | None:
    """The first pair of DIFFERENT cue rules whose matches start within `window` bytes."""
    merged = sorted((off, rid) for rid, offs in offsets.items() for off in offs)
    last: dict[str, int] = {}
    for off, rid in merged:
        for other, o in last.items():
            if other != rid and off - o <= window:
                return other, rid, o
        last[rid] = off
    return None


def evaluate(copy: str, payloads: list[str], counts: dict[str, int], side: str = "",
             dl=_deadline.NONE) -> list[Reason]:
    """All reasons for one item: the NFKC copy of the text, the decoded TAG payloads, and the
    NFKC copy of the side text (link texts, alt/title, attachment names)."""
    texts = [("", copy.encode("utf-8"))]
    texts += [("in TAG payload: ", p.encode("utf-8")) for p in payloads]
    if side:
        texts.append(("in links/attachments: ", side.encode("utf-8")))
    reasons: list[Reason] = []
    have: set[str] = set()
    all_rules = rules()
    tag_payload_hit = False
    for rule in all_rules:
        dl.check()
        if rule.kind == "regex":
            for prefix, b in texts:
                m = rule.regex.search(b)
                if m is not None:
                    reasons.append(Reason(rule.id, rule.strength, prefix + _snippet(b, *m.span())))
                    have.add(rule.id)
                    break
        elif rule.kind == "tag-payload":
            hit = next((p for p in payloads if _TAG_WORD.search(p.encode("utf-8"))), None)
            if hit is not None or counts.get("tag_runs_capped"):
                tag_payload_hit = True
                detail = " ".join(hit.split())[:200] if hit is not None else "too many TAG runs to list"
                reasons.append(Reason(rule.id, rule.strength, "decoded: " + detail))
                have.add(rule.id)
        elif rule.kind == "tag-chars":
            if counts.get("tag") and not tag_payload_hit:
                reasons.append(Reason(rule.id, rule.strength, f"{counts['tag']} TAG characters"))
                have.add(rule.id)
    combo = next((r for r in all_rules if r.kind == "combo"), None)
    cues = [r for r in all_rules if r.cue and r.id in have]
    if combo is not None and len(cues) >= 2:
        for prefix, b in texts:
            offsets = {r.id: _cue_offsets(r, b, dl) for r in cues}
            hit = _combo(combo.window, {k: v for k, v in offsets.items() if v})
            if hit is not None:
                a, c, off = hit
                reasons.append(Reason(combo.id, combo.strength,
                                      f"{prefix}{a} + {c}: " + _snippet(b, off, off + combo.window)))
                break
    return reasons


def neutralise(stored: str, copy: str, dl=_deadline.NONE) -> tuple[str, int, int]:
    """Return (stored text with forged lines/tokens neutralised, lines prefixed, lines whose
    bracket characters were replaced). Raises RulesError when the copy and the stored text
    disagree on line count (the pipeline then fails closed) and NeutraliseBomb past
    MAX_NEUTRALISED hits (`rejected`)."""
    cb = copy.encode("utf-8")
    prefixed: set[int] = set()
    bracketed: set[int] = set()
    passes = [(r.regex, prefixed) for r in rules() if r.neutralise is not None]
    passes.append((_SOURCE_TOKEN, bracketed))
    for rx, target in passes:
        line = 0
        prev = 0
        for i, m in enumerate(rx.finditer(cb)):
            if not i & 127:
                dl.check()
            line += cb.count(b"\n", prev, m.start())
            prev = m.start()
            target.add(line)
            if len(target) > MAX_NEUTRALISED:
                raise NeutraliseBomb(f"more than {MAX_NEUTRALISED} forged lines")
    if not prefixed and not bracketed:
        return stored, 0, 0
    lines = stored.split("\n")
    if len(lines) != cb.count(b"\n") + 1:
        raise RulesError("the NFKC copy and the stored text disagree on line count")
    for i in bracketed:
        lines[i] = lines[i].translate(_BRACKETS_TO_PARENS)
    for i in prefixed:
        lines[i] = NEUTRAL_PREFIX + lines[i]
    return "\n".join(lines), len(prefixed), len(bracketed)
