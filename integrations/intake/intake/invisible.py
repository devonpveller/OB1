"""Stage 4: invisible characters (DESIGN-intake.md section 3, stage 4).

strip() removes, from the text that will be stored, and counts per class:
  * tag: the TAG block U+E0000..U+E007F ("ASCII smuggling"). Every run is decoded to ASCII and
    the decoded text of all runs, joined, is returned as a payload for the rules. A valid
    subdivision flag (U+1F3F4, 2-7 tag letters/digits, U+E007F CANCEL TAG) is the only
    exemption and is kept as it is (counted as flag_tags_kept);
  * bidi: U+061C, U+200E/F, U+202A..E, U+2066..9;
  * variation_selectors: U+FE00..F, U+E0100..E01EF, Mongolian U+180B..D and U+180F;
  * controls: C0 and C1 controls except tab, newline and carriage return;
  * surrogates: lone surrogates (possible in a Python str, never valid text);
  * cf: every other general-category Cf character (zero-width space and joiners, word joiner,
    BOM, soft hyphen, invisible operators, ...).

rules_copy() returns the copy the rules read: the stripped text in Unicode NFKC. The stored
text is never normalised.

Linear time. Scans for these classes run in RE2 over the UTF-8 bytes (a DFA pass, ~2 ms per
MB); text with none of them (the usual case) costs one scan per class group. Found runs are
cut out one by one up to MAX_RUNS; past that, one str.translate pass removes the rest, so the
cost is bounded by MAX_RUNS steps plus O(n). CPython's unicodedata.normalize is not linear on
every input (measured 2026-10-15: 1 M x U+FB01 in one call 2.9 s; 40,000 x U+FDFA 0.46 s, 4.6x
the time of 20,000; long runs of combining marks are quadratic in the run length), so
rules_copy() normalises in chunks of about NFKC_CHUNK_CHARS, trims runs of combining marks to
NONSTARTER_RUN_MAX (UAX #15 stream-safe), and treats as a normalisation bomb (`rejected`) a
text with more than NFKC_MAX_EXPENSIVE characters of the measured slow kinds (an NFKC form of
4+ characters, halfwidth katakana) or more than NFKC_MAX_LONG_MARK_RUNS runs of 4+ combining
marks.
"""
from __future__ import annotations

import functools
import sys
import unicodedata

import re2

from . import limits

COUNT_KEYS = ("tag", "bidi", "variation_selectors", "controls", "surrogates", "cf")
MAX_RUNS = 2000  # runs cut out one by one; past this, one translate pass does the rest
MAX_TAG_PAYLOAD = 65536  # decoded TAG characters kept (in total) for the rules

_BIDI = "\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069"
_VARIATION = "\ufe00-\ufe0f\U000E0100-\U000E01EF\u180b-\u180d\u180f"
_CONTROLS_RE2 = r"\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
_TAGS = "\U000E0000-\U000E007F"
_FLAG_HEAD = "\U0001F3F4".encode("utf-8")
_FLAG = "\U0001F3F4[\U000E0030-\U000E0039\U000E0061-\U000E007A]{2,7}\U000E007F"


class NormalisationBomb(Exception):
    """The NFKC copy would cost too much; the item is `rejected` (DESIGN section 7)."""


def _utf8(pattern: str):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.UTF8
    opt.max_mem = 64 << 20
    return re2.compile(pattern.encode("utf-8"), opt)


def _class_of(cps: list[int]) -> str:
    """An RE2 character class body for a sorted list of code points."""
    parts = []
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        a, b = cps[i], cps[j]
        parts.append(f"\\x{{{a:x}}}" if a == b else f"\\x{{{a:x}}}-\\x{{{b:x}}}")
        i = j + 1
    return "".join(parts)


@functools.lru_cache(maxsize=1)
def _tables():
    """Classes and translate tables from this Python's Unicode database (built once)."""
    cf, nonstarters, expensive = [], [], []
    special = set()
    for spec in (_BIDI, _VARIATION, _TAGS):
        i = 0
        while i < len(spec):
            if i + 2 < len(spec) and spec[i + 1] == "-":
                special.update(range(ord(spec[i]), ord(spec[i + 2]) + 1))
                i += 3
            else:
                special.add(ord(spec[i]))
                i += 1
    for cp in range(sys.maxunicode + 1):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        ch = chr(cp)
        cat = unicodedata.category(ch)
        if cat == "Cf" and cp not in special:
            cf.append(cp)
        if unicodedata.combining(ch):
            nonstarters.append(cp)
        if 0xFF61 <= cp <= 0xFF9F or (unicodedata.decomposition(ch).startswith("<")
                                      and len(unicodedata.normalize("NFKC", ch)) >= 4):
            expensive.append(cp)
    cf_cls = _class_of(cf)
    ns = _class_of(nonstarters)
    rep = {}  # every invisible code point -> one representative of its class
    for cp in cf:
        rep[cp] = "\u200b"
    for lo, hi in ((0x061C, 0x061C), (0x200E, 0x200F), (0x202A, 0x202E), (0x2066, 0x2069)):
        for cp in range(lo, hi + 1):
            rep[cp] = "\u200e"
    for lo, hi in ((0xFE00, 0xFE0F), (0xE0100, 0xE01EF), (0x180B, 0x180D), (0x180F, 0x180F)):
        for cp in range(lo, hi + 1):
            rep[cp] = "\ufe00"
    for cp in list(range(0x00, 0x09)) + [0x0B, 0x0C] + list(range(0x0E, 0x20)) + list(range(0x7F, 0xA0)):
        rep[cp] = "\x01"
    return {
        "any": _utf8("[" + _BIDI + _VARIATION + _TAGS + _CONTROLS_RE2 + cf_cls + "]"),
        "tags": _utf8("[" + _TAGS + "]"),
        # no capture groups: RE2 then finds each match with its DFA alone
        "tag_runs": _utf8(_FLAG + "|[" + _TAGS + "]+"),
        "runs": _utf8("[" + _BIDI + _VARIATION + _CONTROLS_RE2 + cf_cls + "]+"),
        "rep": rep,
        "reps": (("cf", "\u200b"), ("bidi", "\u200e"), ("variation_selectors", "\ufe00"),
                 ("controls", "\x01")),
        "tag_decode": {cp: (chr(cp - 0xE0000) if 0xE0020 <= cp <= 0xE007E else None)
                       for cp in range(0xE0000, 0xE0080)},
        "tag_delete": dict.fromkeys(range(0xE0000, 0xE0080)),
        "ascii_controls": dict.fromkeys(list(range(0x00, 0x09)) + [0x0B, 0x0C]
                                        + list(range(0x0E, 0x20)) + [0x7F]),
        "ns_long": _utf8("[" + ns + "]{%d,}" % (limits.NONSTARTER_RUN_MAX + 1)),
        "ns_4": _utf8("[" + ns + "]{4,}"),
        "expensive": _utf8("[" + _class_of(expensive) + "]"),
    }


def _new_counts() -> dict[str, int]:
    counts = dict.fromkeys(COUNT_KEYS, 0)
    counts["flag_tags_kept"] = 0
    return counts


def _strip_surrogates(text: str, counts: dict[str, int]) -> str:
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        out = "".join(ch for ch in text if not 0xD800 <= ord(ch) <= 0xDFFF)
        counts["surrogates"] += len(text) - len(out)
        return out


def _strip_tags(text: str, counts: dict[str, int], payloads: list[str]) -> str:
    t = _tables()
    b = text.encode("utf-8")
    pieces: list[bytes] = []
    decoded: list[str] = []
    kept = 0
    last = 0
    capped = False
    for i, m in enumerate(t["tag_runs"].finditer(b)):
        if i >= MAX_RUNS:
            capped = True
            break
        pieces.append(b[last:m.start()])
        raw = m.group(0)
        if raw.startswith(_FLAG_HEAD):
            pieces.append(raw)
            counts["flag_tags_kept"] += (len(raw) - len(_FLAG_HEAD)) // 4
        else:  # every TAG character is 4 bytes in UTF-8
            counts["tag"] += len(raw) // 4
            room = MAX_TAG_PAYLOAD - kept
            if room > 0:
                part = raw[: 4 * room].decode("utf-8").translate(t["tag_decode"])
                decoded.append(part)
                kept += len(part)
        last = m.end()
    rest = b[last:].decode("utf-8")
    if capped:
        counts["tag_runs_capped"] = 1
        stripped = rest.translate(t["tag_delete"])
        counts["tag"] += len(rest) - len(stripped)
        rest = stripped
    payload = "".join(decoded)
    if payload.strip():
        payloads.append(payload)
    return b"".join(pieces).decode("utf-8") + rest


def _strip_runs(text: str, counts: dict[str, int]) -> str:
    t = _tables()
    b = text.encode("utf-8")
    pieces: list[bytes] = []
    last = 0
    before = {key: counts[key] for key, _rep in t["reps"]}
    for i, m in enumerate(t["runs"].finditer(b)):
        if i >= MAX_RUNS:
            # Too many runs to cut out one by one: one translate pass over the whole text.
            counts.update(before)
            return _strip_by_translate(text, counts)
        pieces.append(b[last:m.start()])
        run = m.group(0).decode("utf-8").translate(t["rep"])
        for key, rep in t["reps"]:
            counts[key] += run.count(rep)
        last = m.end()
    pieces.append(b[last:])
    return b"".join(pieces).decode("utf-8")


def _strip_by_translate(text: str, counts: dict[str, int]) -> str:
    t = _tables()
    mapped = text.translate(t["rep"])
    for key, rep in t["reps"]:
        n = mapped.count(rep)
        counts[key] += n
        if n:
            mapped = mapped.replace(rep, "")
    return mapped


def strip(text: str) -> tuple[str, dict[str, int], list[str]]:
    """Remove invisible characters. Returns (stored text, per-class counts, decoded TAG
    payloads)."""
    counts = _new_counts()
    payloads: list[str] = []
    text = _strip_surrogates(text, counts)
    if text.isascii():
        out = text.translate(_tables()["ascii_controls"])
        counts["controls"] = len(text) - len(out)
        return out, counts, payloads
    t = _tables()
    b = text.encode("utf-8")
    if t["any"].search(b) is None:
        return text, counts, payloads
    if t["tags"].search(b) is not None:
        text = _strip_tags(text, counts, payloads)
    text = _strip_runs(text, counts)
    return text, counts, payloads


def _chunks(text: str, size: int):
    n = len(text)
    i = 0
    while i < n:
        j = min(n, i + size)
        if j < n:
            k = text.rfind("\n", i + size // 2, j)
            if k < 0:
                k = text.rfind(" ", i + size // 2, j)
            if k > i:
                j = k  # cut before an ASCII character: never inside a combining sequence
            else:
                while j > i + 1 and unicodedata.combining(text[j]):
                    j -= 1  # never split a run of combining marks (runs are <= 30 here)
        yield text[i:j]
        i = j


def _count_capped(pattern, b: bytes, cap: int) -> int:
    n = 0
    for _m in pattern.finditer(b):
        n += 1
        if n > cap:
            break
    return n


def rules_copy(text: str) -> tuple[str, int]:
    """The NFKC copy the rules read, and how many combining marks the stream-safe trim
    dropped from it. Raises NormalisationBomb."""
    if text.isascii():
        return text, 0
    t = _tables()
    b = text.encode("utf-8")
    if t["expensive"].search(b) is not None and \
            _count_capped(t["expensive"], b, limits.NFKC_MAX_EXPENSIVE) > limits.NFKC_MAX_EXPENSIVE:
        raise NormalisationBomb("nfkc: too many characters that are slow to normalise")
    dropped = 0
    if t["ns_4"].search(b) is not None:
        if _count_capped(t["ns_4"], b, limits.NFKC_MAX_LONG_MARK_RUNS) > limits.NFKC_MAX_LONG_MARK_RUNS:
            raise NormalisationBomb("nfkc: too many long runs of combining marks")
        if t["ns_long"].search(b) is not None:
            pieces = []
            last = 0
            for m in t["ns_long"].finditer(b):
                pieces.append(b[last:m.start()])
                run = m.group(0).decode("utf-8")
                pieces.append(run[: limits.NONSTARTER_RUN_MAX].encode("utf-8"))
                dropped += len(run) - limits.NONSTARTER_RUN_MAX
                last = m.end()
            pieces.append(b[last:])
            text = b"".join(pieces).decode("utf-8")
    out = []
    total = 0
    budget = limits.NFKC_MAX_EXPANSION * len(text) + limits.NFKC_EXPANSION_SLACK
    for chunk in _chunks(text, limits.NFKC_CHUNK_CHARS):
        norm = unicodedata.normalize("NFKC", chunk)
        total += len(norm)
        if total > budget:
            raise NormalisationBomb(f"nfkc: the copy grows past {limits.NFKC_MAX_EXPANSION}x its input")
        out.append(norm)
    return "".join(out), dropped
