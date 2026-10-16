"""Stage 4: invisible characters (DESIGN-intake.md section 3, stage 4).

strip() removes, from the text that will be stored, and counts per class:
  * tag: the TAG block U+E0000..U+E007F ("ASCII smuggling"). Every run is decoded to ASCII and
    the decoded text of all runs is returned as payloads for the rules: joined directly, and
    joined with spaces, so an instruction split one word per run still reads as words. The only
    exemption is the three RGI subdivision flags of Unicode's emoji-sequences.txt
    (RGI_Emoji_Tag_Sequence: England, Scotland, Wales), kept as they are and counted as
    flag_tags_kept. Any other flag-shaped sequence (U+1F3F4 + tag letters + U+E007F) is an
    ordinary TAG run: stripped, decoded and screened (intake-i2 attempt 1, FAIL-2);
  * bidi: U+061C, U+200E/F, U+202A..E, U+2066..9;
  * variation_selectors: U+FE00..F, U+E0100..E01EF, Mongolian U+180B..D and U+180F;
  * controls: C0 and C1 controls except tab, newline and carriage return;
  * surrogates: lone surrogates (possible in a Python str, never valid text);
  * cf: every other general-category Cf character (zero-width space and joiners, word joiner,
    BOM, soft hyphen, invisible operators, ...);
  * default_ignorable: the Default_Ignorable_Code_Point characters that are NOT Cf (Unicode
    DerivedCoreProperties): U+034F COMBINING GRAPHEME JOINER, the Hangul fillers U+115F,
    U+1160, U+3164, U+FFA0, the Khmer inherent vowels U+17B4/U+17B5, and the unassigned
    ignorables U+2065, U+FFF0..U+FFF8, U+E0080..U+E00FF, U+E01F0..U+E0FFF. They render as
    nothing, so like Cf they can split a word for the rules while staying invisible to a
    reader (attempt 1, F-5). Cost: archaic Hangul written with fillers loses them.

rules_copy() returns the copy the rules read: the stripped text in Unicode NFKC. The stored
text is never normalised.

Linear time. Scans for these classes run in RE2 over the UTF-8 bytes (a DFA pass, ~2 ms per
MB); text with none of them (the usual case) costs one scan. Found runs are cut out one by one
up to MAX_RUNS; past that, str.translate passes (in slices, with the deadline checked between
them) remove the rest. CPython's unicodedata.normalize is not linear on every input (measured
2026-10-15: 1 M x U+FB01 in one call 2.9 s; 40,000 x U+FDFA 0.46 s, 4.6x the time of 20,000;
long runs of combining marks are quadratic in the run length), so rules_copy() normalises in
chunks of about NFKC_CHUNK_CHARS, trims runs of combining marks to NONSTARTER_RUN_MAX (UAX #15
stream-safe), and treats as a normalisation bomb (`rejected`) a text with more than
NFKC_MAX_EXPENSIVE characters of the measured slow kinds (an NFKC form of 4+ characters,
halfwidth katakana) or more than NFKC_MAX_LONG_MARK_RUNS runs of 4+ combining marks.
"""
from __future__ import annotations

import functools
import re
import sys
import unicodedata

import re2

from . import deadline as _deadline
from . import limits

COUNT_KEYS = ("tag", "bidi", "variation_selectors", "controls", "surrogates", "cf",
              "default_ignorable")
MAX_RUNS = 2000  # runs cut out one by one; past this, translate passes do the rest
MAX_TAG_PAYLOAD = 65536  # decoded TAG characters kept (in total) for the rules

_BIDI = "\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069"
_VARIATION = "\ufe00-\ufe0f\U000E0100-\U000E01EF\u180b-\u180d\u180f"
_CONTROLS_RE2 = r"\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
_TAGS = "\U000E0000-\U000E007F"
_FLAG_HEAD = chr(0x1F3F4).encode("utf-8")
# RGI_Emoji_Tag_Sequence (Unicode emoji-sequences.txt): England, Scotland, Wales. Nothing else.
RGI_FLAG_TAGS = ("gbeng", "gbsct", "gbwls")
RGI_FLAGS = tuple(chr(0x1F3F4) + "".join(chr(0xE0000 + ord(c)) for c in code) + chr(0xE007F)
                  for code in RGI_FLAG_TAGS)
# Default_Ignorable_Code_Point (DerivedCoreProperties) that are not Cf.
_DI_NON_CF = ((0x034F, 0x034F), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x2065, 0x2065),
              (0x3164, 0x3164), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0xE0080, 0xE00FF),
              (0xE01F0, 0xE0FFF))
_DI_REP = chr(0x034F)
# Characters that RENDER as a blank, so a reader sees two words where the rules would see one
# token (round 2: 'Answer:' + U+2800 + 'CLEAN' came out clean):
#   * every Zs space separator except U+0020 - NFKC already maps U+00A0, U+2000..U+200A,
#     U+202F, U+205F, U+3000 to U+0020 (checked); U+1680 OGHAM SPACE MARK it does not;
#   * U+2800 BRAILLE PATTERN BLANK (So), U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR;
#   * the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 (Default_Ignorable, render as a blank):
#     they become a space in the STORED text too (BLANK_FILLERS), still counted.
# Zero-width characters (Cf, the other ignorables) render as nothing and are removed instead.
BLANKS_FOR_RULES = (chr(0x1680), chr(0x2800), chr(0x2028), chr(0x2029))
BLANK_FILLERS = (chr(0x115F), chr(0x1160), chr(0x3164), chr(0xFFA0))
_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")  # one class: linear


class NormalisationBomb(Exception):
    """The NFKC copy would cost too much; the item is `rejected` (DESIGN section 7)."""


def _utf8(pattern: str):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.UTF8
    opt.max_mem = 64 << 20
    return re2.compile(pattern.encode("utf-8"), opt)


def _class_of(cps) -> str:
    """An RE2 character class body for a sorted list of code points."""
    cps = list(cps)
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


def _ranges(spec: str) -> set[int]:
    out: set[int] = set()
    i = 0
    while i < len(spec):
        if i + 2 < len(spec) and spec[i + 1] == "-":
            out.update(range(ord(spec[i]), ord(spec[i + 2]) + 1))
            i += 3
        else:
            out.add(ord(spec[i]))
            i += 1
    return out


@functools.lru_cache(maxsize=1)
def _tables():
    """Classes and translate tables from this Python's Unicode database (built once)."""
    special = _ranges(_BIDI) | _ranges(_VARIATION) | _ranges(_TAGS)
    di = [cp for lo, hi in _DI_NON_CF for cp in range(lo, hi + 1)]
    cf, nonstarters, expensive = [], [], []
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
    cf_cls, di_cls, ns = _class_of(cf), _class_of(di), _class_of(nonstarters)
    rep = {}  # every invisible code point (but TAG) -> one representative of its class
    for cp in cf:
        rep[cp] = "\u200b"
    for cp in _ranges(_BIDI):
        rep[cp] = "\u200e"
    for cp in _ranges(_VARIATION):
        rep[cp] = "\ufe00"
    for cp in list(range(0x00, 0x09)) + [0x0B, 0x0C] + list(range(0x0E, 0x20)) + list(range(0x7F, 0xA0)):
        rep[cp] = "\x01"
    for cp in di:
        rep[cp] = _DI_REP
    flags = "|".join(RGI_FLAGS)
    # List tables (index = code point) translate ~3x faster than dicts (measured 2026-10-15:
    # 3.25 M chars 0.19 s vs 0.59 s); built once, ~9 MB each.
    ident = list(range(sys.maxunicode + 1))  # the int objects are shared by both tables
    rep_list: list = ident[:]
    for cp, ch in rep.items():
        rep_list[cp] = ch
    tag_delete_list: list = ident[:]
    for cp in range(0xE0000, 0xE0080):
        tag_delete_list[cp] = None
    return {
        "any": _utf8("[" + _BIDI + _VARIATION + _TAGS + _CONTROLS_RE2 + cf_cls + di_cls + "]"),
        "tags": _utf8("[" + _TAGS + "]"),
        # no capture groups: RE2 then finds each match with its DFA alone
        "tag_runs": _utf8(flags + "|[" + _TAGS + "]+"),
        "runs": _utf8("[" + _BIDI + _VARIATION + _CONTROLS_RE2 + cf_cls + di_cls + "]+"),
        "rep": rep,
        "reps": (("cf", "\u200b"), ("bidi", "\u200e"), ("variation_selectors", "\ufe00"),
                 ("controls", "\x01"), ("default_ignorable", _DI_REP)),
        "tag_decode": {cp: (chr(cp - 0xE0000) if 0xE0020 <= cp <= 0xE007E else None)
                       for cp in range(0xE0000, 0xE0080)},
        "rep_list": rep_list,
        "tag_delete_list": tag_delete_list,
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


def _translate(text: str, table, dl) -> str:
    """str.translate in slices, the deadline checked between them."""
    step = limits.TRANSLATE_SLICE_CHARS
    if len(text) <= step:
        return text.translate(table)
    out = []
    for i in range(0, len(text), step):
        dl.check()
        out.append(text[i:i + step].translate(table))
    return "".join(out)


def _strip_surrogates(text: str, counts: dict[str, int]) -> str:
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        out, n = _SURROGATE.subn("", text)
        counts["surrogates"] += n
        return out


def _strip_tags(text: str, counts: dict[str, int], payloads: list[str], dl) -> str:
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
        if not i & 255:
            dl.check()
        pieces.append(b[last:m.start()])
        raw = m.group(0)
        if raw.startswith(_FLAG_HEAD):  # one of the RGI flags (the pattern lists only those)
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
        stripped = _translate(rest, t["tag_delete_list"], dl)
        counts["tag"] += len(rest) - len(stripped)
        rest = stripped
    joined = "".join(decoded)
    if joined.strip():
        payloads.append(joined)
        spaced = " ".join(d for d in decoded if d)
        if spaced != joined:
            payloads.append(spaced)
    return b"".join(pieces).decode("utf-8") + rest


def _strip_runs(text: str, counts: dict[str, int], dl) -> str:
    t = _tables()
    b = text.encode("utf-8")
    pieces: list[bytes] = []
    last = 0
    before = {key: counts[key] for key, _rep in t["reps"]}
    for i, m in enumerate(t["runs"].finditer(b)):
        if i >= MAX_RUNS:
            # Too many runs to cut out one by one: translate passes over the whole text.
            counts.update(before)
            return _strip_by_translate(text, counts, dl)
        if not i & 255:
            dl.check()
        pieces.append(b[last:m.start()])
        run = m.group(0).decode("utf-8").translate(t["rep"])
        for key, rep in t["reps"]:
            counts[key] += run.count(rep)
        last = m.end()
    pieces.append(b[last:])
    return b"".join(pieces).decode("utf-8")


def _strip_by_translate(text: str, counts: dict[str, int], dl) -> str:
    t = _tables()
    mapped = _translate(text, t["rep_list"], dl)
    for key, rep in t["reps"]:
        n = mapped.count(rep)
        counts[key] += n
        if n:
            mapped = mapped.replace(rep, "")
    dl.check()
    return mapped


def strip(text: str, dl=_deadline.NONE) -> tuple[str, dict[str, int], list[str]]:
    """Remove invisible characters. Returns (stored text, per-class counts, decoded TAG
    payloads)."""
    counts = _new_counts()
    payloads: list[str] = []
    text = _strip_surrogates(text, counts)
    if not text.isascii():
        # Hangul fillers render as a blank: they become a space (and are still counted as
        # default_ignorable), so they cannot glue two words together for the rules.
        for ch in BLANK_FILLERS:
            if ch in text:
                counts["default_ignorable"] += text.count(ch)
                text = text.replace(ch, " ")
    if text.isascii():
        out = text.translate(_tables()["ascii_controls"])  # C fast path for ASCII
        counts["controls"] = len(text) - len(out)
        return out, counts, payloads
    t = _tables()
    b = text.encode("utf-8")
    if t["any"].search(b) is None:
        return text, counts, payloads
    if t["tags"].search(b) is not None:
        text = _strip_tags(text, counts, payloads, dl)
    text = _strip_runs(text, counts, dl)
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


def _count_capped(pattern, b: bytes, cap: int, dl) -> int:
    n = 0
    for _m in pattern.finditer(b):
        n += 1
        if n > cap:
            break
        if not n & 255:
            dl.check()
    return n


def rules_copy(text: str, dl=_deadline.NONE) -> tuple[str, int]:
    """The NFKC copy the rules read, and how many combining marks the stream-safe trim
    dropped from it. Raises NormalisationBomb."""
    if text.isascii():
        return text, 0
    t = _tables()
    b = text.encode("utf-8")
    if t["expensive"].search(b) is not None and \
            _count_capped(t["expensive"], b, limits.NFKC_MAX_EXPENSIVE, dl) > limits.NFKC_MAX_EXPENSIVE:
        raise NormalisationBomb("nfkc: too many characters that are slow to normalise")
    dropped = 0
    if t["ns_4"].search(b) is not None:
        if _count_capped(t["ns_4"], b, limits.NFKC_MAX_LONG_MARK_RUNS, dl) > limits.NFKC_MAX_LONG_MARK_RUNS:
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
    for i, chunk in enumerate(_chunks(text, limits.NFKC_CHUNK_CHARS)):
        if not i & 63:
            dl.check()
        norm = unicodedata.normalize("NFKC", chunk)
        total += len(norm)
        if total > budget:
            raise NormalisationBomb(f"nfkc: the copy grows past {limits.NFKC_MAX_EXPANSION}x its input")
        out.append(norm)
    copy = "".join(out)
    for ch in BLANKS_FOR_RULES:  # a handful of C-speed scans; replace only what is present
        if ch in copy:
            copy = copy.replace(ch, " ")
    return copy, dropped


# Built at import, so no screen() call pays for it (~0.5-1 s once per process).
_tables()
