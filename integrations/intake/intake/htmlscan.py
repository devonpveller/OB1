"""Linear-time HTML text extraction for stage 3 (content disarm and reconstruction).

Why not a DOM library (DESIGN-intake.md names selectolax): the I2 anchor asks for a parser
"with a linear-time guarantee", and none of the candidates has one. Measured 2026-10-15
(findings note intake-i2): selectolax 1.0.0 (lexbor) takes 9.2 s on 800 KB of "<", 4.2 s on
40,000 nested <div> and 15.5 s on 2 MB of "<a>"; html5ever (markupever 0.x) takes 12 s on
40,000 nested <div>. HTML5 tree construction walks the stack of open elements for its scope
checks, so without a depth cap it is O(n * depth) in any faithful implementation.

What this module does instead: a streaming tokenizer and a bounded element stack.

  * The scanner only moves forward. Each step is a C-level forward search from the current
    offset (bytes.find, or a regex search for a fixed short delimiter) followed by consuming
    what was read, so tokenizing is O(n).
  * Per tag the work is O(1) amortised: open elements sit on a stack with, per name, the
    stack positions of that name and, per scope kind, the positions of scope boundaries, so an
    end tag finds its element (or learns it is not in scope) without walking the stack. Every
    element is pushed and popped once.
  * Work caps (limits.py) bound what hostile input can make the loop do. Volume caps work like
    the 2 MB byte cap: past HTML_MAX_TAGS tags, HTML_MAX_ENTITIES character references or
    HTML_MAX_STYLE_EVALS distinct inline styles, extraction STOPS and the rest of the document
    is not extracted (counted as truncated_bytes; text that is not extracted is never stored or
    shown, so stopping is safe). The structural cap is a parser bomb: more than HTML_MAX_DEPTH
    open elements raises ParserBomb -> `rejected` (DESIGN section 7).
  * Raw-text elements (script, style, textarea, title, ...) are skipped with one forward search
    for their end tag, following the HTML5 script "escaped"/"double escaped" states.

Regex engines here: RE2 (google-re2) where a pattern alternates; Python's `re` only for
patterns that cannot backtrack super-linearly - a literal or one character class with a
quantifier, or a starred group whose alternatives begin with disjoint characters and that
has nothing after it that could fail (so a match never backtracks into it). Each is listed
with that argument where it is defined. tests/test_bounds.py times every one on hostile input.

It follows the HTML5 tokenizer where that decides what is text, and models the implied end
tags that matter for visibility (p, li, dd/dt, table parts, a). Where it and a browser could
disagree, the error is in the safe direction for this stage: text a browser would hide is at
worst still handed to the rules and the classifier, the same as text hidden by a stylesheet
class (DESIGN section 3, "Limit").
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass, field

import re2

from . import limits


class ParserBomb(Exception):
    """The input is structurally hostile; the item is `rejected` (DESIGN section 7)."""


class _Stop(Exception):
    """A volume cap was reached; extraction ends here (the rest is truncated)."""


def _re2_latin1(pattern: bytes):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.LATIN1
    return re2.compile(pattern, opt)


# Python `re`, each linear by form (see the module docstring).
# The tag token. It starts with a literal '<', so a search skips text at C speed. Every
# alternative is decided by the byte after '<' (a letter / '/'+letter / '!--' / '!', '?', '/')
# and then ends in parts that cannot fail (a starred group or an optional '>'), so once an
# alternative is chosen the match never backtracks. The starred group in the start tag has
# alternatives that begin with disjoint bytes: [^>"'=] / '=' / a lone quote; a quoted value
# runs to its closing quote or to the end of input (HTML5: a quote opens a value only after
# '=').
_TOKEN = re.compile(
    rb"<(?:"
    rb"([A-Za-z][^\t\n\f\r />]*)((?:[^>\"'=]+|=[\t\n\f\r ]*(?:\"[^\"]*\"?|'[^']*'?)?|[\"'])*)(>?)"
    rb"|/([A-Za-z][^\t\n\f\r />]*)[^>]*(>?)"
    rb"|(!--)"
    rb"|[!?/][^>]*>?"
    rb")")
# a literal with one optional character.
_COMMENT_END = re.compile(rb"--!?>")
# One attribute: a name (one class, plus) and an optional value. The only backtracking is
# over the whitespace before a missing '=', which is bounded by that whitespace run.
_ATTR = re.compile(
    rb"([^\t\n\f\r />=]+|=[^\t\n\f\r />=]*)"
    rb"(?:[\t\n\f\r ]*=[\t\n\f\r ]*(\"[^\"]*\"?|'[^']*'?|[^\t\n\f\r >]*))?")

# RE2: alternations.
_SCRIPT_SCAN = _re2_latin1(rb"(?i)(<!--)|(-->)|(<script[\t\n\f\r />])|(</script[\t\n\f\r />])")

_VOID = frozenset(
    "area base basefont bgsound br col embed frame hr img input keygen link meta param source "
    "track wbr".split())
# Raw text / RCDATA elements: their content is skipped up to the end tag in one search.
_RAWTEXT = frozenset("script style xmp iframe noembed noframes noscript textarea title".split())
# Dropped with everything inside them: the DESIGN section 3 list, plus elements a browser
# does not render as page text (noscript with scripting on, object/embed/canvas/audio/video
# fallback, datalist, ruby parentheses, frameset).
_DROP = frozenset(
    "script style template svg math iframe form textarea input select datalist noscript noembed "
    "noframes object embed applet canvas audio video frameset nav header footer aside rp "
    "xmp".split())
_BLOCK = frozenset(
    "address article aside blockquote caption center dd details dialog dir div dl dt fieldset "
    "figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup li main menu nav ol p pre "
    "section summary table tbody td tfoot th thead tr ul".split())
_P_CLOSERS = frozenset(
    "address article aside blockquote center details dialog dir div dl fieldset figcaption figure "
    "footer form h1 h2 h3 h4 h5 h6 header hgroup hr listing main menu nav ol p pre section "
    "summary table ul xmp".split())
_HEADINGS = frozenset("h1 h2 h3 h4 h5 h6".split())
# Scope boundaries (HTML5 13.2.4.2), per scope kind.
_SCOPES_OF: dict[str, tuple[str, ...]] = {}
for _n in "applet caption td th marquee object".split():
    _SCOPES_OF[_n] = ("default", "button", "list")
for _n in ("html", "table", "template"):
    _SCOPES_OF[_n] = ("default", "button", "list", "table")
_SCOPES_OF["button"] = ("button",)
_SCOPES_OF["ol"] = ("list",)
_SCOPES_OF["ul"] = ("list",)
_END_SCOPE = {"p": "button", "li": "list", "td": "table", "th": "table", "tr": "table",
              "tbody": "table", "thead": "table", "tfoot": "table", "caption": "table",
              "table": "table"}
_SAFE_SCHEMES = ("http", "https")


@dataclass
class HtmlExtract:
    text: str
    title: str | None
    links: list[dict] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


class _Scanner:
    def __init__(self, data: bytes):
        self.b = data
        self.n = len(data)
        self.stack: list[tuple[str, bool]] = []
        self.positions: dict[str, list[int]] = {}
        self.bounds: dict[str, list[int]] = {"default": [], "button": [], "list": [], "table": []}
        self.out: list[str] = []
        self.title: str | None = None
        self.links: list[dict] = []
        self.tags = 0
        self.entities = 0
        self.foreign = 0
        self.doc_hidden = False
        self.counts = {"hidden_elements": 0, "dropped_elements": 0, "links_dropped": 0}
        self.pos = 0
        self.styles: dict[str, bool] = {}

    def hides(self, attrs: dict[str, str]) -> bool:
        """attrs_hide with the inline-style verdict cached per document; at most
        HTML_MAX_STYLE_EVALS distinct styles are evaluated (a volume cap: then extraction stops)."""
        style = attrs.get("style")
        if not style or "hidden" in attrs or "popover" in attrs:
            return attrs_hide(attrs)
        hit = self.styles.get(style)
        if hit is None:
            if len(self.styles) >= limits.HTML_MAX_STYLE_EVALS:
                raise _Stop("styles")
            hit = self.styles[style] = css_hides(style)
        return hit or attrs_hide({k: v for k, v in attrs.items() if k != "style"})

    def count_tag(self) -> None:
        self.tags += 1
        if self.tags > limits.HTML_MAX_TAGS:
            raise _Stop("tags")

    # -- the element stack ------------------------------------------------------------------
    def visible(self) -> bool:
        return not self.doc_hidden and (not self.stack or not self.stack[-1][1])

    def push(self, name: str, hidden: bool) -> None:
        if len(self.stack) >= limits.HTML_MAX_DEPTH:
            raise ParserBomb(f"html: more than {limits.HTML_MAX_DEPTH} open elements")
        idx = len(self.stack)
        self.stack.append((name, hidden))
        self.positions.setdefault(name, []).append(idx)
        for scope in _SCOPES_OF.get(name, ()):
            self.bounds[scope].append(idx)
        if name in ("svg", "math"):
            self.foreign += 1

    def pop_to(self, idx: int) -> None:
        """Pop every element at stack index >= idx."""
        while len(self.stack) > idx:
            name, hidden = self.stack.pop()
            self.positions[name].pop()
            for scope in _SCOPES_OF.get(name, ()):
                self.bounds[scope].pop()
            if name in ("svg", "math"):
                self.foreign -= 1
            if name in _BLOCK and not hidden:
                self.out.append("\n")

    def close_in_scope(self, name: str, scope: str) -> None:
        lst = self.positions.get(name)
        if not lst:
            return
        bnd = self.bounds[scope]
        # in scope when no boundary sits above it (the element may be a boundary itself)
        if lst[-1] >= (bnd[-1] if bnd else -1):
            self.pop_to(lst[-1])

    # -- text -----------------------------------------------------------------------------
    def decode(self, seg: bytes) -> str:
        s = seg.decode("utf-8", "replace")
        if "&" in s:
            self.entities += s.count("&")
            if self.entities > limits.HTML_MAX_ENTITIES:
                raise _Stop("entities")
            s = _html.unescape(s)
        return s

    def emit_text(self, seg: bytes) -> None:
        if not seg or not self.visible():
            return
        s = self.decode(seg)
        if self.positions.get("pre"):
            self.out.append(s)
            return
        collapsed = " ".join(s.split())
        if not collapsed:
            self.out.append(" ")
            return
        if s[:1].isspace():
            collapsed = " " + collapsed
        if s[-1:].isspace():
            collapsed += " "
        self.out.append(collapsed)

    # -- attributes -----------------------------------------------------------------------
    def attrs(self, raw: bytes) -> dict[str, str]:
        found: dict[str, str] = {}
        for m in _ATTR.finditer(raw):
            name = m.group(1).decode("utf-8", "replace").lower()
            if name in found:
                continue  # HTML5: the first of duplicate attributes wins
            val = m.group(2)
            if val is None:
                found[name] = ""
                continue
            if val[:1] in (b'"', b"'"):
                val = val[1:-1] if len(val) >= 2 and val[-1:] == val[:1] else val[1:]
            found[name] = self.decode(val)
        return found

    def add_link(self, kind: str, url: str | None, text: str | None) -> None:
        if not url:
            return
        url = "".join(ch for ch in url.strip("\x00\t\n\f\r ") if ch not in "\t\n\r")
        head = url.split("/", 1)[0]
        scheme = head.split(":", 1)[0].lower() if ":" in head else ""
        if (scheme and scheme not in _SAFE_SCHEMES) or not url \
                or len(url) > limits.MAX_URL_CHARS or len(self.links) >= limits.MAX_LINKS:
            self.counts["links_dropped"] += 1
            return
        self.links.append({"kind": kind, "url": url,
                           "text": " ".join((text or "").split())[: limits.MAX_LINK_TEXT_CHARS]})

    # -- tags ------------------------------------------------------------------------------
    def start_tag(self, name: str, raw_attrs: bytes, pos_after: int) -> int:
        selfclose = raw_attrs.endswith(b"/")
        if selfclose and (self.foreign or name in ("svg", "math")):
            return pos_after  # foreign elements honour '/>' (HTML5); an empty <svg/> holds nothing
        attrs: dict[str, str] = {}
        if raw_attrs:
            low = raw_attrs.lower()
            if (b"hidden" in low or b"style" in low or b"popover" in low
                    or name in ("a", "area", "img", "dialog")):
                if len(raw_attrs) > limits.HTML_MAX_ATTR_BYTES:
                    # Too long to read; if it might hide the element, treat it as hidden.
                    attrs = {"hidden": ""} if (b"hidden" in low or b"style" in low) else {}
                else:
                    attrs = self.attrs(raw_attrs)
        hidden_attr = self.hides(attrs)
        if name in ("html", "body"):
            if hidden_attr:
                self.doc_hidden = True
                self.counts["hidden_elements"] += 1
            return pos_after
        if name == "head":
            return pos_after
        if name in _VOID and not self.foreign:
            vis = self.visible()
            if hidden_attr and vis:
                self.counts["hidden_elements"] += 1
            vis = vis and not hidden_attr
            if name in ("br", "hr") and vis:
                self.out.append("\n")
            elif name == "img" and vis:
                self.add_link("image", attrs.get("src"), attrs.get("alt"))
            elif name == "area" and vis:
                self.add_link("link", attrs.get("href"), attrs.get("alt"))
            elif name == "input" and vis:
                self.counts["dropped_elements"] += 1
            return pos_after
        if name in _RAWTEXT and not self.foreign:
            return self.raw_text(name, hidden_attr, pos_after)
        if name == "plaintext" and not self.foreign:
            if not hidden_attr:
                self.emit_text(self.b[pos_after:])
            return self.n

        # implied end tags
        if name in _P_CLOSERS:
            self.close_in_scope("p", "button")
        if name == "li":
            self.close_in_scope("li", "list")
        elif name in ("dd", "dt"):
            self.close_in_scope("dd", "default")
            self.close_in_scope("dt", "default")
        elif name in ("td", "th"):
            self.close_in_scope("td", "table")
            self.close_in_scope("th", "table")
        elif name == "tr":
            for n in ("td", "th", "tr"):
                self.close_in_scope(n, "table")
        elif name in ("thead", "tbody", "tfoot"):
            for n in ("td", "th", "tr", "thead", "tbody", "tfoot"):
                self.close_in_scope(n, "table")
        elif name in ("option", "optgroup"):
            self.close_in_scope("option", "default")
            if name == "optgroup":
                self.close_in_scope("optgroup", "default")
        elif name == "a":
            self.close_in_scope("a", "default")
        if name in _HEADINGS and self.stack and self.stack[-1][0] in _HEADINGS:
            self.pop_to(len(self.stack) - 1)

        parent_hidden = not self.visible()
        drop = name in _DROP or (name == "dialog" and "open" not in attrs)
        if not parent_hidden:
            if hidden_attr:
                self.counts["hidden_elements"] += 1
            elif drop:
                self.counts["dropped_elements"] += 1
        hidden = parent_hidden or hidden_attr or drop
        if name == "a" and not hidden:
            self.add_link("link", attrs.get("href"), attrs.get("title"))
        self.push(name, hidden)
        if name in _BLOCK and not hidden:
            self.out.append("\n")
        return pos_after

    def raw_text(self, name: str, hidden_attr: bool, pos: int) -> int:
        start = self.script_end(pos) if name == "script" else self.rawtext_end(name, pos)
        if name == "title":
            if self.title is None:
                self.title = self.decode(self.b[pos:min(start, pos + limits.TITLE_MAX_CHARS * 8)])
        elif self.visible():
            self.counts["hidden_elements" if hidden_attr else "dropped_elements"] += 1
        if start >= self.n:
            return self.n
        self.count_tag()
        gt = self.b.find(b">", start)
        return self.n if gt < 0 else gt + 1

    def rawtext_end(self, name: str, pos: int) -> int:
        """Offset of the first '</name' + delimiter at or after pos (HTML5: the 'appropriate
        end tag'); the end of input if none. bytes.find on the lower-cased name and a check
        of the byte after it: one forward pass."""
        needle = b"</" + name.encode()
        low = self.lowered()
        p = pos
        while True:
            i = low.find(needle, p)
            if i < 0:
                return self.n
            j = i + len(needle)
            if j < self.n and self.b[j] in b"\t\n\f\r />":
                return i
            p = j

    _low: bytes | None = None

    def lowered(self) -> bytes:
        if self._low is None:
            self._low = self.b.lower()  # ASCII case fold only; same length, same offsets
        return self._low

    def script_end(self, pos: int) -> int:
        escaped = double = False
        p = pos
        while True:
            m = _SCRIPT_SCAN.search(self.b, p)
            if m is None:
                return self.n
            self.count_tag()  # each marker costs one step; bounded like tags
            p = m.end()
            if m.lastindex == 1:
                escaped = True
            elif m.lastindex == 2:
                escaped = double = False
            elif m.lastindex == 3:
                if escaped and not double:
                    double = True
            elif double:
                double = False
            else:
                return m.start()

    def end_tag(self, name: str) -> None:
        if name == "br":
            if self.visible():
                self.out.append("\n")
            return
        if name in ("html", "body", "head"):
            return
        self.close_in_scope(name, _END_SCOPE.get(name, "default"))

    # -- the loop ---------------------------------------------------------------------------
    def run(self) -> None:
        b, n, pos = self.b, self.n, 0
        names: dict[bytes, str] = {}
        while pos < n:
            m = _TOKEN.search(b, pos)
            if m is None:
                self.emit_text(b[pos:])
                return
            lt = m.start()
            if lt > pos:
                self.emit_text(b[pos:lt])
            self.pos = lt
            self.tags += 1
            if self.tags > limits.HTML_MAX_TAGS:
                raise _Stop("tags")
            kind = m.lastindex
            if kind == 3:  # start tag
                if not m.group(3):  # cut off by the end of input: dropped (HTML5)
                    return
                raw = m.group(1)
                name = names.get(raw)
                if name is None:
                    name = names[raw] = raw.decode("latin-1").lower()
                pos = self.start_tag(name, m.group(2), m.end())
            elif kind == 5:  # end tag
                if m.group(5):
                    raw = m.group(4)
                    name = names.get(raw)
                    if name is None:
                        name = names[raw] = raw.decode("latin-1").lower()
                    self.end_tag(name)
                pos = m.end()
            elif kind == 6:  # comment
                p = m.end()
                if b.startswith(b">", p):
                    pos = p + 1
                elif b.startswith(b"->", p):
                    pos = p + 2
                else:
                    e = _COMMENT_END.search(b, p)
                    pos = n if e is None else e.end()
            else:  # doctype, processing instruction, bogus comment, '</>'
                pos = m.end()


# -- inline CSS ------------------------------------------------------------------------------
_CSS_ESCAPE = _re2_latin1(rb"\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n0-9a-fA-F])")
_RELEVANT = frozenset((
    "display", "visibility", "content-visibility", "opacity", "font-size", "font", "left", "right",
    "top", "bottom", "margin-left", "margin-right", "margin-top", "margin", "text-indent", "clip",
    "clip-path", "transform", "height", "max-height", "width", "max-width", "overflow",
    "overflow-x", "overflow-y", "color", "background-color", "background"))
_MAX_DECLS = 64


def _css_unescape(m) -> bytes:
    if m.group(1) is not None:
        try:
            return chr(int(m.group(1), 16)).encode("utf-8", "replace")
        except (ValueError, OverflowError):
            return b"\xef\xbf\xbd"
    return m.group(2)


def _strip_css_comments(s: str) -> str:
    out = []
    p = 0
    while True:
        i = s.find("/*", p)
        if i < 0:
            out.append(s[p:])
            return " ".join(out)
        out.append(s[p:i])
        j = s.find("*/", i + 2)
        if j < 0:
            return " ".join(out)
        p = j + 2


def _nums(val: str):
    """(value, unit) for each numeric token in a CSS value."""
    for tok in val.replace(",", " ").replace("(", " ").replace(")", " ").replace("/", " ").split():
        sign = 1.0
        if tok[:1] in "+-":
            sign = -1.0 if tok[0] == "-" else 1.0
            tok = tok[1:]
        i = 0
        while i < len(tok) and (tok[i].isdigit() or tok[i] == "."):
            i += 1
        if i == 0:
            continue
        try:
            yield sign * float(tok[:i]), tok[i:]
        except ValueError:
            continue


def _tiny_font(val: str) -> bool:
    for v, unit in _nums(val):
        if v <= 0:
            return True
        if unit in ("", "px", "pt", "q", "mm", "pc") and v < 2:
            return True
        if unit in ("em", "rem", "ex", "ch", "cap", "ic", "lh") and v < 0.15:
            return True
        if unit == "%" and v < 15:
            return True
        if unit in ("vw", "vh", "vmin", "vmax") and v < 0.2:
            return True
        return False
    return False


def _far_negative(val: str) -> bool:
    for v, unit in _nums(val):
        if v >= 0:
            continue
        a = -v
        if unit in ("", "px", "pt") and a >= 500:
            return True
        if unit in ("em", "rem", "ex", "ch") and a >= 30:
            return True
        if unit in ("%", "vw", "vh", "vmin", "vmax") and a >= 50:
            return True
        if unit in ("cm", "mm", "in", "pc", "q") and a >= 10:
            return True
    return False


def css_hides(style: str) -> bool:
    """True when an inline style hides the element: DESIGN section 3 (display:none,
    visibility:hidden, font-size:0, opacity:0, off-screen positioning) and the equivalents a
    page uses for the same effect (clip, zero box + overflow, transparent or same-as-background
    colour, translate off-screen)."""
    s = style[: limits.HTML_MAX_ATTR_BYTES]
    if "/*" in s:
        s = _strip_css_comments(s)
    if "\\" in s:
        s = _CSS_ESCAPE.sub(_css_unescape, s.encode("utf-8", "replace")).decode("utf-8", "replace")
    s = s.lower().replace("!important", "")
    decls: dict[str, str] = {}
    seen = 0
    for decl in s.split(";"):
        colon = decl.find(":")
        if colon < 0:
            continue
        prop = decl[:colon].strip()
        if prop not in _RELEVANT:
            continue
        seen += 1
        if seen > _MAX_DECLS:
            return True  # an element this keen on its own visibility is not shown
        decls[prop] = " ".join(decl[colon + 1:].split())  # the last declaration wins
    if not decls:
        return False
    if decls.get("display") == "none":
        return True
    if decls.get("visibility") in ("hidden", "collapse"):
        return True
    if decls.get("content-visibility") == "hidden":
        return True
    if "opacity" in decls:
        for v, unit in _nums(decls["opacity"]):
            if (unit == "%" and v <= 10) or (unit != "%" and v <= 0.1):
                return True
            break
    if "font-size" in decls and _tiny_font(decls["font-size"]):
        return True
    if "font" in decls:
        for tok in decls["font"].replace("/", " ").split():
            if tok[:1].isdigit() or tok[:1] in (".", "-"):
                if _tiny_font(tok):
                    return True
                break
    for prop in ("left", "right", "top", "bottom", "margin-left", "margin-right", "margin-top",
                 "margin", "text-indent"):
        if prop in decls and _far_negative(decls[prop]):
            return True
    tr = decls.get("transform", "")
    if tr:
        if "translate" in tr and _far_negative(tr):
            return True
        if "scale(0" in tr.replace(" ", ""):
            return True
    clip = decls.get("clip", "")
    if "rect(" in clip and all(abs(v) <= 1 for v, _u in _nums(clip)):
        return True
    cp = decls.get("clip-path", "").replace(" ", "")
    if cp:
        if "inset(" in cp and any(u == "%" and v >= 50 for v, u in _nums(cp)):
            return True
        if cp.startswith(("circle(0", "ellipse(0")):
            return True
    over = decls.get("overflow", "") + decls.get("overflow-x", "") + decls.get("overflow-y", "")
    if "hidden" in over or "clip" in over:
        for prop in ("height", "max-height", "width", "max-width"):
            if prop in decls:
                for v, _u in _nums(decls[prop]):
                    if v <= 1:
                        return True
                    break
    color = decls.get("color", "")
    if color:
        if color == "transparent" or color.replace(" ", "").endswith((",0)", "/0)")):
            return True
        bg = decls.get("background-color") or decls.get("background")
        if bg and bg == color:
            return True
    return False


def attrs_hide(attrs: dict[str, str]) -> bool:
    if not attrs:
        return False
    if "hidden" in attrs or "popover" in attrs:
        return True
    if attrs.get("aria-hidden", "").strip().lower() == "true":
        return True
    style = attrs.get("style")
    return bool(style) and css_hides(style)


def cut_utf8(data: bytes, cap: int) -> bytes:
    """data cut to at most cap bytes, never inside a UTF-8 sequence."""
    if len(data) <= cap:
        return data
    cut = cap
    while cut > 0 and (data[cut] & 0xC0) == 0x80:
        cut -= 1
    return data[:cut]


def extract_html(data: bytes) -> HtmlExtract:
    """UTF-8 HTML bytes -> visible text, raw title, links. Raises ParserBomb on hostile
    structure; stops (truncates) at a volume cap."""
    truncated = max(0, len(data) - limits.HTML_MAX_BYTES)
    data = cut_utf8(data, limits.HTML_MAX_BYTES)
    sc = _Scanner(data)
    stopped = ""
    try:
        sc.run()
    except _Stop as stop:
        stopped = str(stop)
        truncated += len(data) - sc.pos
    lines = (ln.strip() for ln in "".join(sc.out).split("\n"))
    text = "\n".join(ln for ln in lines if ln)
    counts = dict(sc.counts)
    counts["truncated_bytes"] = truncated
    counts["truncated_at_cap"] = 1 if stopped else 0
    title = " ".join(sc.title.split()) if sc.title is not None else None
    return HtmlExtract(text=text, title=title, links=sc.links, counts=counts)
