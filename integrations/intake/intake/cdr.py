"""Stage 3: content disarm and reconstruction (DESIGN-intake.md section 3, stage 3).

Rebuilds plain text from the raw content; nothing executable or hidden is carried over.
  * html / xhtml: htmlscan.extract_html (cap 2 MB, linear scanner, hidden content dropped,
    links and images to links[], the title kept for stage 4 and escaped after it).
  * email (message/rfc822): MIME parse; the first text/plain body is preferred, else the first
    text/html body goes through the HTML path; attachments (and attached messages) are listed
    with name, type and size, never decoded or read.
  * json: parsed, and every string (keys and values) becomes a line of text, so \\u escapes
    cannot hide words from the rules.
  * plain / markdown: decoded as they are.

Byte decoding honours a charset only from an allow-list of stateless, linear codecs; anything
else is read as UTF-8 with replacement characters (an attacker-chosen codec such as punycode
is quadratic in CPython).
"""
from __future__ import annotations

import codecs
import email
import email.header
import email.policy
import json
import re
from dataclasses import dataclass, field

from . import deadline as _deadline
from . import limits
from .htmlscan import ParserBomb, extract_html

ALLOWED_CODECS = frozenset(
    ["utf-8", "utf-8-sig", "ascii", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le",
     "utf-32-be", "koi8-r", "koi8-u", "gb2312", "gbk", "gb18030", "big5", "big5hkscs",
     "shift_jis", "cp932", "euc_jp", "euc_kr", "cp949", "iso2022_jp"]
    + [f"iso8859-{i}" for i in range(1, 17)]
    + [f"cp{n}" for n in range(1250, 1259)])


REPLACEMENT = chr(0xFFFD)
# Python `re`, linear by form: one character with a quantifier.
_REPLACEMENT_RUN = re.compile(REPLACEMENT + "+")
# A literal, optional blanks and quote, one bounded class (RFC 2046: boundary is 1-70 chars).
_BOUNDARY_PARAM = re.compile(rb'(?i)boundary[ \t]*=[ \t]*"?([^";\r\n]{1,70})')


class ContentInvalid(Exception):
    """The content cannot be parsed as its declared type; the item is `rejected`."""


@dataclass
class Extract:
    text: str
    title: str | None = None
    links: list[dict] = field(default_factory=list)
    attachments: list[dict] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


def decode_bytes(data: bytes, charset: str | None) -> str:
    name = "utf-8"
    if charset:
        try:
            info = codecs.lookup(charset)  # names are canonical here (latin-1 -> iso8859-1)
            if info.name in ALLOWED_CODECS:
                name = info.name
        except LookupError:
            pass
    text = data.decode(name, "replace")
    if REPLACEMENT * 2 in text:
        # a run of invalid bytes becomes ONE replacement character, so decoding never makes
        # the text bigger than the bytes it came from
        text = _REPLACEMENT_RUN.sub(REPLACEMENT, text)
    return text


def _html(data: bytes, charset: str | None, dl=_deadline.NONE) -> Extract:
    # one pass that also replaces invalid input, so the scanner sees valid UTF-8
    h = extract_html(decode_bytes(data, charset).encode("utf-8"), dl)
    return Extract(text=h.text, title=h.title, links=h.links, counts=h.counts)


def _json(data: bytes, charset: str | None) -> Extract:
    """The document re-serialised compactly by the C encoder with ensure_ascii=False: every
    string (key or value) appears with its JSON escapes decoded (so an escape sequence cannot
    hide a letter from the rules), in one C-speed pass (operator D34: no truncation; the
    attempt-1 Python walk needed a node cap to stay fast). The encoder still escapes control
    characters and quotes; the control escapes are turned back into the characters, so stage 4
    strips and counts them like any other (round 2: '!\\u0001[' would otherwise hide a rule
    match behind six visible characters)."""
    raw = decode_bytes(data, charset)
    try:
        doc = json.loads(raw)
        # with no backslash in the source, every string already reads as written: keep it
        text = raw if "\\" not in raw else json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    except RecursionError:
        raise ParserBomb("json: nesting too deep") from None
    except ValueError as e:
        raise ContentInvalid(f"json: {e}") from None
    if "\\" in text:
        text = _JSON_ESCAPE.sub(_json_unescape, text)
    return Extract(text=text)


# Python `re`, linear by form: a literal backslash, then alternatives decided by the next
# character; an escaped backslash is consumed whole, so '\\\\u0001' stays text.
_JSON_ESCAPE = re.compile(r"\\(?:u00([0-1][0-9a-fA-F]|7[fF])|([bfnrt])|(\\))")
_JSON_SIMPLE = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def _json_unescape(m) -> str:
    if m.group(1) is not None:
        return chr(int(m.group(1), 16))
    if m.group(2) is not None:
        return _JSON_SIMPLE[m.group(2)]
    return m.group(0)


def _header_params(value: str) -> tuple[str, dict[str, str]]:
    """'type/sub; a=b; c="d"' -> ('type/sub', {a: b, c: d}); bounded and loop-free."""
    value = value[: limits.MIME_MAX_HEADER_CHARS]
    parts = value.split(";")
    main = parts[0].strip().lower()
    params: dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params.setdefault(k.strip().lower(), v.strip().strip('"'))
    return main, params


def _raw_header(part, name: str) -> str | None:
    """The first header `name`, as the bytes the sender wrote, read as UTF-8 (RFC 6532).
    compat32's get() would turn 8-bit header bytes into U+FFFD."""
    for k, v in part.raw_items():
        if k.lower() == name:
            v = v[: limits.MIME_MAX_HEADER_CHARS]
            return v.encode("ascii", "surrogateescape").decode("utf-8", "replace")
    return None


def _subject(msg) -> str | None:
    raw = _raw_header(msg, "subject")
    if raw is None:
        return None
    raw = str(raw)[: limits.MIME_MAX_HEADER_CHARS]
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except Exception:  # noqa: BLE001 - a malformed encoded-word keeps the raw header
        return raw


def _email(data: bytes, dl=_deadline.NONE) -> Extract:
    if data.count(b"\n") > limits.MIME_MAX_LINES:
        raise ParserBomb(f"email: more than {limits.MIME_MAX_LINES} lines")
    if data.lower().count(b"boundary") > limits.MIME_MAX_MULTIPART:
        raise ParserBomb(f"email: more than {limits.MIME_MAX_MULTIPART} multipart containers")
    # Count the parts before parsing (the stdlib parser costs ~30 us per part): each part
    # starts with '--' + a declared boundary, and at most MIME_MAX_MULTIPART are declared.
    delimiters = 0
    for m in _BOUNDARY_PARAM.finditer(data):
        delimiters += data.count(b"--" + m.group(1))
        if delimiters > 2 * limits.MIME_MAX_PARTS:
            raise ParserBomb(f"email: more than {limits.MIME_MAX_PARTS} MIME parts")
    msg = email.message_from_bytes(data, policy=email.policy.compat32)
    plain = html = None
    attachments: list[dict] = []
    stack = [msg]
    parts = 0
    while stack:
        part = stack.pop()
        parts += 1
        if parts > limits.MIME_MAX_PARTS:
            raise ParserBomb(f"email: more than {limits.MIME_MAX_PARTS} MIME parts")
        ctype, cparams = _header_params(_raw_header(part, "content-type") or "text/plain")
        disp, dparams = _header_params(_raw_header(part, "content-disposition") or "")
        filename = dparams.get("filename") or cparams.get("name")
        if ctype.startswith("multipart/") and part.is_multipart():
            stack.extend(reversed(part.get_payload()))
            continue
        payload = part.get_payload()
        size = len(payload) if isinstance(payload, (str, bytes)) else 0
        if disp == "attachment" or filename or ctype == "message/rfc822" \
                or not ctype.startswith("text/"):
            attachments.append({"filename": (filename or "")[:255], "content_type": ctype[:100],
                                "size_bytes": size})
            continue
        if ctype == "text/plain" and plain is None:
            plain = (part, cparams.get("charset"))
        elif ctype == "text/html" and html is None:
            html = (part, cparams.get("charset"))
        else:
            attachments.append({"filename": "", "content_type": ctype[:100], "size_bytes": size})
    out = Extract(text="", title=_subject(msg), attachments=attachments)
    chosen = plain
    if plain is not None:
        body = plain[0].get_payload(decode=True) or b""
        text = decode_bytes(body, plain[1])
        if not text.strip() and html is not None:
            chosen = None
        else:
            out.text = text
    if chosen is None and html is not None:
        body = html[0].get_payload(decode=True) or b""
        h = _html(body, html[1], dl)
        out.text, out.links, out.counts = h.text, h.links, h.counts
    out.counts["attachments"] = len(attachments)
    return out


def extract(kind: str, data: bytes, charset: str | None, dl=_deadline.NONE) -> Extract:
    if kind == "html":
        return _html(data, charset, dl)
    if kind == "rfc822":
        return _email(data, dl)
    if kind == "json":
        return _json(data, charset)
    if kind in ("plain", "markdown"):
        return Extract(text=decode_bytes(data, charset))
    raise ValueError(f"no extractor for {kind!r}")
