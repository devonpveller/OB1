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
# The stdlib's header line test (email.feedparser.headerRE, the field-name part): one class,
# then a literal; linear.
_HEADER_LINE = re.compile(rb"[\041-\071\073-\176]*:")


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
    characters, quotes and backslashes; those escapes are decoded too, so stage 4 strips and
    counts the controls like any other (round 2: '!' + an escaped U+0001 + '[' would otherwise
    hide a rule match behind six visible characters). Round 3: that decoding is NATIVE - the
    text is re-encoded with every non-ASCII character as a backslash escape and decoded once
    with the C 'unicode_escape' codec - not a Python callback per escape (attempt 2: 5 MB of
    escapes was 1.3-2.6 M callbacks, 2.3 s in one call)."""
    raw = decode_bytes(data, charset)
    try:
        doc = json.loads(raw)
        # with no backslash in the source, every string already reads as written: keep it
        if "\\" not in raw:
            return Extract(text=raw)
        text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    except RecursionError:
        raise ParserBomb("json: nesting too deep") from None
    except ValueError as e:
        raise ContentInvalid(f"json: {e}") from None
    if "\\" in text:
        # dumps leaves only valid escapes (backslash, quote, b f n r t, u00XX for controls);
        # 'backslashreplace' turns every other non-ASCII character into an escape the codec
        # decodes back, so the round trip is exact. Two C passes, linear in the text.
        text = text.encode("ascii", "backslashreplace").decode("unicode_escape")
    return Extract(text=text)


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


_WANTED_HEADERS = ("subject", "content-type", "content-disposition", "content-transfer-encoding")
# Transfer encodings decoded by C code in the stdlib (binascii base64 / quoted-printable) or not
# encoded at all. Anything else (x-uuencode decodes in a Python loop per line: ~9 us a line)
# is not decoded: the part's text is not read, and it is listed like an attachment.
_DECODED_CTE = ("", "7bit", "8bit", "binary", "base64", "quoted-printable")


def _raw_headers(part) -> dict[str, str]:
    """The first of each wanted header, as the bytes the sender wrote, read as UTF-8 (RFC
    6532), in ONE pass over the part's headers (round 3 sweep: one pass per header name was a
    pass per name over up to MIME_MAX_LINES headers). compat32's get() would turn 8-bit header
    bytes into U+FFFD."""
    found: dict[str, str] = {}
    for k, v in part.raw_items():
        k = k.lower()
        if k in _WANTED_HEADERS and k not in found:
            v = v[: limits.MIME_MAX_HEADER_CHARS]
            found[k] = v.encode("ascii", "surrogateescape").decode("utf-8", "replace")
            if len(found) == len(_WANTED_HEADERS):
                break
    return found


def _subject(headers: dict[str, str]) -> str | None:
    raw = headers.get("subject")
    if raw is None:
        return None
    raw = str(raw)[: limits.MIME_MAX_HEADER_CHARS]
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except Exception:  # noqa: BLE001 - a malformed encoded-word keeps the raw header
        return raw


def _check_header_semicolons(data: bytes, low: bytes) -> None:
    """Reject (parser bomb) a message with a header holding more than MIME_MAX_HEADER_SEMICOLONS
    ';', before the stdlib parser runs (operator D38; I2 attempt-3 FAIL-B). The stdlib MIME
    parameter parser (email.message._parseparam, reached from the feedparser's get_boundary()
    and from get_payload() / get_content_charset()) is quadratic in the ';' of one header
    value, inside one call that cannot be interrupted: 1 MB of ';' took 28 s.

    Only header lines count, per header (a folded header's continuation lines count with it):
    the top block, every block after a declared boundary delimiter, and the block of an
    attached message (a part of type message/*, or a part with no type inside a
    multipart/digest). ';' in a body (CSS, code, prose) is never counted. One pass over the
    lines (at most MIME_MAX_LINES, checked before), so linear. This is a cheap early reject;
    the structural bound for anything the stdlib does that it does not foresee is the
    killable worker every caller runs screen() in (I5)."""
    cap = limits.MIME_MAX_HEADER_SEMICOLONS
    if data.count(b";") <= cap:
        return
    delimiters = {b"--" + m.group(1) for m in _BOUNDARY_PARAM.finditer(data)}
    digest = b"multipart/digest" in low
    in_headers = True
    top = True
    count = 0
    is_ctype = False
    ctype = b""
    for line in data.splitlines():
        if not in_headers:
            if line.rstrip(b" \t") in delimiters:
                in_headers, count, is_ctype, ctype = True, 0, False, b""
            continue
        if not line:
            # the end of this header block; an attached message's own headers follow it
            in_headers = ctype.startswith(b"message/") or (digest and not top and not ctype)
            top, count, is_ctype, ctype = False, 0, False, b""
            continue
        if line[:1] in (b" ", b"\t"):
            count += line.count(b";")
            if is_ctype and len(ctype) < 64:
                ctype = (ctype + line.strip().lower())[:64]
        elif _HEADER_LINE.match(line) or line.startswith(b"From "):
            count = line.count(b";")
            name, _, value = line.partition(b":")
            is_ctype = name.strip().lower() == b"content-type"
            if is_ctype:
                ctype = value.strip().lower()[:64]
        else:
            # not a header line: the stdlib starts the body here (no blank line)
            in_headers, top, count = False, False, 0
            continue
        if count > cap:
            raise ParserBomb(f"email: a header with more than {cap} ';'")


def _email(data: bytes, dl=_deadline.NONE) -> Extract:
    # The stdlib parser splits lines on CR, LF and CRLF alike (attempt 2: 1.75 M CR-only lines
    # passed an LF-only count and took 2.4 s in one call). Count every break it splits on.
    lines = data.count(b"\n") + data.count(b"\r") - data.count(b"\r\n")
    if lines > limits.MIME_MAX_LINES:
        raise ParserBomb(f"email: more than {limits.MIME_MAX_LINES} lines")
    low = data.lower()
    if low.count(b"boundary") > limits.MIME_MAX_MULTIPART:
        raise ParserBomb(f"email: more than {limits.MIME_MAX_MULTIPART} multipart containers")
    _check_header_semicolons(data, low)
    # Count the parts before parsing (the stdlib parser costs ~30 us per part): each part
    # starts with '--' + a declared boundary, and at most MIME_MAX_MULTIPART are declared.
    delimiters = 0
    for m in _BOUNDARY_PARAM.finditer(data):
        delimiters += data.count(b"--" + m.group(1))
        if delimiters > 2 * limits.MIME_MAX_PARTS:
            raise ParserBomb(f"email: more than {limits.MIME_MAX_PARTS} MIME parts")
    msg = email.message_from_bytes(data, policy=email.policy.compat32)
    plain = html = None
    top_headers: dict[str, str] = {}
    attachments: list[dict] = []
    stack = [msg]
    parts = 0
    while stack:
        part = stack.pop()
        parts += 1
        if parts > limits.MIME_MAX_PARTS:
            raise ParserBomb(f"email: more than {limits.MIME_MAX_PARTS} MIME parts")
        hdrs = _raw_headers(part)
        if part is msg:
            top_headers = hdrs
        ctype, cparams = _header_params(hdrs.get("content-type") or "text/plain")
        disp, dparams = _header_params(hdrs.get("content-disposition") or "")
        cte = (hdrs.get("content-transfer-encoding") or "").strip().lower()
        filename = dparams.get("filename") or cparams.get("name")
        if ctype.startswith("multipart/") and part.is_multipart():
            stack.extend(reversed(part.get_payload()))
            continue
        payload = part.get_payload()
        size = len(payload) if isinstance(payload, (str, bytes)) else 0
        if disp == "attachment" or filename or ctype == "message/rfc822" \
                or not ctype.startswith("text/") or cte not in _DECODED_CTE:
            att = {"filename": (filename or "")[:255], "content_type": ctype[:100], "size_bytes": size}
            if cte not in _DECODED_CTE:
                att["transfer_encoding"] = cte[:40]  # not decoded, not read
            attachments.append(att)
            continue
        if ctype == "text/plain" and plain is None:
            plain = (part, cparams.get("charset"))
        elif ctype == "text/html" and html is None:
            html = (part, cparams.get("charset"))
        else:
            attachments.append({"filename": "", "content_type": ctype[:100], "size_bytes": size})
    out = Extract(text="", title=_subject(top_headers), attachments=attachments)
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
        ex = _html(data, charset, dl)
    elif kind == "rfc822":
        ex = _email(data, dl)
    elif kind == "json":
        ex = _json(data, charset)
    elif kind in ("plain", "markdown"):
        ex = Extract(text=decode_bytes(data, charset))
    else:
        raise ValueError(f"no extractor for {kind!r}")
    # A single-byte charset (latin-1, cp125x, koi8 ...) turns each byte >= 0x80 into a 2-byte
    # UTF-8 character, so 5 MB of raw can become ~10 MB of text (round 3 sweep). The extracted
    # text keeps the raw cap; past it the item is a parser bomb, not truncated.
    if len(ex.text) * 4 > limits.RAW_MAX_BYTES and \
            len(ex.text.encode("utf-8", "surrogatepass")) > limits.RAW_MAX_BYTES:
        raise ParserBomb(f"{kind}: the decoded text is over {limits.RAW_MAX_BYTES} bytes")
    return ex
