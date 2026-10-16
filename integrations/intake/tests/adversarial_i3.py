"""Generators of the I2 carry-in shapes (intake-i3, operator D38/D39).

* calc_chain_page(): the I2 reviewer's R-1 page - inline styles of ~64 KB, each a chain of
  calc() expressions, distinct per element, inside the 2 MB HTML cap (31 elements took 2.4 s
  on e04ff3a and ended `pending` at the deadline).
* header_semicolon_floods(): the attempt-3 tester's FAIL-B shapes - MIME header values with a
  flood of ';' that the stdlib parameter parser walks quadratically, on a multipart, after an
  open quote, as folded continuation lines, on an 8-bit text part, and in an attached message.
"""
from __future__ import annotations

KB = 1024
_T = "\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nhi\r\n--B--\r\n"


def calc_chain_page(elements: int = 31, style_bytes: int = 64 * KB - 64) -> str:
    unit = "calc(1px)"
    out = []
    for i in range(elements):
        style = "left:" + unit * (style_bytes // len(unit)) + f";top:{i}px"
        out.append(f'<p style="{style}">para {i}</p>')
    return "<html><body>" + "".join(out) + "</body></html>"


def header_semicolon_floods() -> list[tuple[str, str]]:
    return [
        ("multipart + 1M ';' (1 MB)", "Content-Type: multipart/mixed; boundary=B" + ";" * 1_000_000 + _T),
        ("multipart + 300k ';'", "Content-Type: multipart/mixed; boundary=B" + ";" * 300_000 + _T),
        ("quote then 100k ';'", 'Content-Type: multipart/mixed; boundary=B; x="' + ";" * 100_000 + '"' + _T),
        ("149,900 folded ';' lines", "Content-Type: multipart/mixed; boundary=B" + ";\r\n " * 149_900 + _T),
        ("8-bit text part + 300k ';'", "Content-Type: text/plain; charset=utf-8" + ";" * 300_000
         + "\r\n\r\nété body\r\n"),
        ("part header + 300k ';'", "Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\n"
         "Content-Type: text/plain; charset=utf-8" + ";" * 300_000 + "\r\n\r\nété\r\n--B--\r\n"),
        ("attached message header + 300k ';'", "Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\n"
         "Content-Type: message/rfc822\r\n\r\nContent-Type: multipart/mixed; boundary=C" + ";" * 300_000
         + "\r\n\r\n--C\r\nContent-Type: text/plain\r\n\r\ninner\r\n--C--\r\n--B--\r\n"),
    ]


def header_at_cap_shapes() -> list[tuple[str, str]]:
    """Headers AT the ';' cap (so they are parsed), made as costly as the cap allows: the cap's
    ';' spread over a 4.5 MB value, after an open quote (the stdlib counts quotes up to every
    ';' and copies the rest of the value per parameter)."""
    from intake import limits
    cap = limits.MIME_MAX_HEADER_SEMICOLONS
    gap = "a" * (4_500_000 // cap)
    return [
        ("at-cap ';' spread over 4.5 MB, quote", 'Content-Type: multipart/mixed; boundary=B; x="'
         + (gap + ";") * (cap - 2) + '"' + _T),
        ("at-cap ';' spread over 4.5 MB, 8-bit text", "Content-Type: text/plain; charset=utf-8"
         + (";" + gap) * (cap - 1) + "\r\n\r\n\u00e9t\u00e9\r\n"),
    ]
