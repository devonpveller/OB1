"""Round-3 generators (intake-i2 attempt 2, FAIL-A and the JSON/email sweep): every JSON
escape kind as a 5 MB flood, email line-ending shapes (CR-only, LF-only, CRLF, mixed) as
header-continuation, header and body floods just inside the line cap, and the other single
JSON/email steps the sweep looked at. Every case is inside the 5 MB raw cap."""
from __future__ import annotations

import json

from intake import limits

MB5 = limits.RAW_MAX_BYTES
BS = "\\"
# every escape a JSON string can hold (RFC 8259 section 7), as written in the source
JSON_ESCAPES = {
    "backslash": BS + BS, "quote": BS + '"', "slash": BS + "/", "b": BS + "b", "f": BS + "f",
    "n": BS + "n", "r": BS + "r", "t": BS + "t", "u0041": BS + "u0041", "u0001": BS + "u0001",
    "u001f": BS + "u001f", "u00e9": BS + "u00e9", "u4e2d": BS + "u4e2d", "u200b": BS + "u200b",
    "u2028": BS + "u2028", "surrogate pair": BS + "ud83d" + BS + "ude00", "lone surrogate": BS + "ud800",
    "mixed": BS + "t" + BS + BS + BS + "n" + BS + "u0001" + BS + '"',
}


def fit_bytes(s: str, cap: int = MB5 - 64) -> str:
    return s.encode("utf-8")[:cap].decode("utf-8", "ignore")


def json_escape_floods():
    for name, esc in JSON_ESCAPES.items():
        n = (MB5 - 16) // len(esc)
        yield f"json escape flood {name}", '["' + esc * n + '"]'
        # the same escapes spread over many short strings and keys
        items, size, i = [], 2, 0
        while True:
            item = f'"{esc}{i}":"{esc * 3}"'
            if size + len(item) + 1 > MB5 - 64:
                break
            items.append(item)
            size += len(item) + 1
            i += 1
        yield f"json escapes in keys/values {name}", "{" + ",".join(items) + "}"


def json_other():
    yield "json 5MB of CJK text (escaped by backslashreplace in the decode)", json.dumps(
        ["\u4e2d\u6587" * ((MB5 - 16) // 6), "\\"], ensure_ascii=False)
    yield "json CJK + escapes interleaved", json.dumps(["\u4e2d\t" * ((MB5 - 16) // 5)], ensure_ascii=False)
    yield "json 5MB small numbers", "[" + "1," * ((MB5 - 4) // 2 - 1) + "1]"
    yield "json -0.0 floats", "[" + "-0.0," * ((MB5 - 4) // 5 - 1) + "0]"
    yield "json depth 900 then wide", "[" * 900 + ",".join(['"x"'] * 300_000) + "]" * 900
    yield "json 400k distinct keys", "{" + ",".join(f'"k{i}":1' for i in range(400_000)) + "}"
    yield "json 800k duplicate keys", "{" + ",".join(['"a":1'] * 800_000) + "}"
    yield "json long float", "[0." + "1" * (MB5 - 10) + "]"


def _hdr(body: str) -> str:
    return body


def email_line_shapes():
    """Header continuations, headers and body lines with each line ending, sized to sit just
    under MIME_MAX_LINES (the cap) and as 5 MB floods (over the cap: rejected fast)."""
    cap = limits.MIME_MAX_LINES
    for nl_name, nl in (("CR", "\r"), ("LF", "\n"), ("CRLF", "\r\n")):
        n = cap - 50
        yield f"email {nl_name} header continuation x{n}", "Subject: x" + (nl + " y") * n + nl + nl + "body"
        yield f"email {nl_name} headers x{n}", ("X-H: v" + nl) * n + nl + "body"
        yield f"email {nl_name} body lines x{n}", "Content-Type: text/plain" + nl + nl + ("ab" + nl) * n
        yield f"email {nl_name} 5MB continuation flood", fit_bytes(
            "Subject: x" + (nl + " y") * ((MB5 - 100) // (len(nl) + 2)) + nl + nl + "body")
    mixed = "\r", "\n", "\r\n"
    yield "email mixed CR/LF/CRLF body x cap", "Content-Type: text/plain\r\n\r\n" + "".join(
        "ab" + mixed[i % 3] for i in range(cap - 50))
    yield "email mixed CR/LF/CRLF 5MB", fit_bytes("Subject: x\r\n\r\n" + "".join(
        "a" + mixed[i % 3] for i in range((MB5 - 64) // 3)))
    yield "email LF CR pairs (\\n\\r counts twice)", fit_bytes("Subject: x\n\n" + "a\n\r" * ((MB5 - 64) // 3))


def email_other():
    cap = limits.MIME_MAX_LINES
    yield "email x-uuencode body (not decoded)", (
        "Content-Type: text/plain\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 a\r\n"
        + ("M" + "A" * 60 + "\r\n") * 80_000 + "`\r\nend\r\n")
    yield "email QP =41 escapes 5MB", ("Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable"
                                       "\r\n\r\n" + ("=41" * 25 + "=\r\n") * ((MB5 - 200) // 78))
    yield "email base64 5MB", ("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n"
                               + ("QUFB" * 19 + "\r\n") * ((MB5 - 200) // 78))
    yield "email invalid UTF-8 pairs", fit_bytes("Content-Type: text/plain; charset=latin-1\r\n\r\n"
                                                 + "\u00ff\u00fea" * ((MB5 - 100) // 5))
    for cs in ("utf-16", "utf-32", "gb18030", "iso-2022-jp", "shift_jis", "big5"):
        yield f"email body charset {cs}", f"Content-Type: text/plain; charset={cs}\r\n\r\n" + "x" * (MB5 // 2)
    yield "email 255 parts x 1000 headers", "Content-Type: multipart/mixed; boundary=B\r\n\r\n" + "".join(
        "--B\r\nContent-Type: text/plain\r\n" + "X-H: v\r\n" * 1000 + "\r\nbody\r\n" for _ in range(255)) + "--B--\r\n"
    yield "email 2000 encoded words in the subject", "Subject: " + "=?utf-8?q?a?= " * 200_000 + "\r\n\r\nbody"
    yield "email html body 5MB", ("Content-Type: text/html\r\n\r\n" + "<p>x</p>\r\n" * ((MB5 - 100) // 10))[:MB5 - 64]
    yield "email header line 5MB, no breaks", "X-Long: " + "a" * (MB5 - 100) + "\r\n\r\nbody"
    yield "email one header with cap-50 continuation lines then body", (
        "Subject: s\r\n" + "X: v" + "\r\n v" * (cap - 100) + "\r\n\r\n" + "body")
