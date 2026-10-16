"""Linear-time HTML text extraction for stage 3 (content disarm and reconstruction).

Why not a DOM library (DESIGN-intake.md names selectolax): the I2 anchor asks for a parser
"with a linear-time guarantee", and none of the candidates has one. Measured 2026-10-15
(findings note intake-i2, D-1): selectolax 1.0.0 (lexbor) takes 9.2 s on 800 KB of "<", 4.2 s
on 40,000 nested <div> and 15.5 s on 2 MB of "<a>"; html5ever (markupever 0.x) takes 12 s on
40,000 nested <div>. HTML5 tree construction walks the stack of open elements for its scope
checks, so without a depth cap it is O(n * depth) in any faithful implementation.

What this module does instead: a streaming tokenizer and a bounded element stack.

  * The scanner only moves forward. Each step is a C-level forward search from the current
    offset (one regex search for the next tag opening, bytes.find for the '>' that closes it,
    one RE2 DFA match when the tag holds quotes) followed by consuming what was read, so
    tokenizing is O(n) and never loops per byte in Python (attempt 1's 2 MB single tag
    `<a/=/=...` took 1.9 s in a per-alternative regex loop; it is now one DFA pass).
  * Per tag the work is O(1) amortised: open elements sit on a stack with, per name, the stack
    positions of that name, per scope kind the positions of scope boundaries, and a running
    count of non-formatting elements, so an end tag finds its element (or learns it is not in
    scope, or that a block sits above a formatting element) without walking the stack.
  * Work caps (limits.py, operator D34): HTML_MAX_TAGS, HTML_MAX_ENTITIES, HTML_MAX_STYLE_EVALS
    and HTML_MAX_DEPTH sit above anything a real page reaches; past one the input is a parser
    bomb (ParserBomb -> `rejected`). A legitimate page up to the 2 MB cap is extracted whole.
  * The deadline (deadline.py) is checked every 1024 tags.
  * Raw-text elements (script, style, textarea, title, ...) are skipped with one forward search
    for their end tag, following the HTML5 script "escaped"/"double escaped" states.

Regex engines here: RE2 (google-re2) where a pattern alternates over long input; Python's `re`
only for patterns that cannot backtrack super-linearly - a literal or one character class with
a quantifier, or alternatives decided by their first bytes that end in parts which cannot fail.
Each is listed with that argument where it is defined. tests/test_bounds.py times them all.

It follows the HTML5 tokenizer where that decides what is text, and models the tree-building
rules that matter for visibility: implied end tags (p, li, dd/dt, table parts, a), the quirks
mode rule that a <table> does not close an open <p> without a doctype, closed <details>, and
an approximation of the adoption agency: the end tag of a formatting element with a block
element above it is ignored, so the block (and whatever hides it) stays open. Where it and a
browser can still disagree, the error is in the safe direction for this stage: text a browser
hides is at worst handed to the rules and the classifier, as with stylesheet-class hiding
(DESIGN section 3, "Limit"), and in the other direction visible text is dropped.
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass, field

import re2

from . import deadline as _deadline
from . import limits


class ParserBomb(Exception):
    """The input is structurally hostile; the item is `rejected` (DESIGN section 7)."""


def _re2_latin1(pattern: bytes):
    opt = re2.Options()
    opt.encoding = re2.Options.Encoding.LATIN1
    return re2.compile(pattern, opt)


# Python `re`, each linear by form:
# The opening of a tag: a literal '<' (so the search skips text at C speed), then alternatives
# decided by the next byte (a letter / '/'+letter / '!--' / one of '!?/'), each a single class
# with a quantifier and nothing after it. The rest of the tag is read by _tag_end.
# A start or end tag also reads its body up to the first '>' or quote ([^>"']*, then an optional
# '>'): nothing after the stars can fail, so there is no backtracking. A body that stopped at a
# quote is finished by _Scanner.tag_end.
_OPEN = re.compile(
    rb"<(?:([A-Za-z][^\t\n\f\r />]*)([^>\"']*)(>?)"   # 1 name, 2 body, 3 '>'
    rb"|/([A-Za-z][^\t\n\f\r />]*)([^>\"']*)(>?)"      # 4 name, 5 body, 6 '>'
    rb"|(!--)|([!?/]))")                               # 7 comment, 8 bogus
# a literal with one optional character.
_COMMENT_END = re.compile(rb"--!?>")
# HTML whitespace (only these five fold; other controls stay for stage 4 to count).
_HTML_WS = re.compile(rb"[ \t\n\f\r]+")
# One attribute: a name (one class, plus) and an optional value. The only backtracking is over
# the whitespace before a missing '=', bounded by that run. Quoted values run to the closing
# quote or the end of the (already delimited) attribute string.
_ATTR = re.compile(
    rb"([^\t\n\f\r />=]+|=[^\t\n\f\r />=]*)"
    rb"(?:[\t\n\f\r ]*=[\t\n\f\r ]*(\"[^\"]*\"?|'[^']*'?|[^\t\n\f\r >]*))?")
# A numeric character reference small enough to be a control character (decided by length).
_SMALL_NUMREF = re.compile(rb"&#(?:[xX]0*([0-9a-fA-F]{1,2})|0*([0-9]{1,3}));?")

# RE2, no capture groups (DFA only): the body of a tag that contains a quote, up to (not
# including) its closing '>'. HTML5: a quote opens a value only after '='; an unterminated
# value runs to the end of input.
_TAG_BODY = _re2_latin1(
    rb"(?:[^>\"'=]|=[\t\n\f\r ]*(?:\"[^\"]*(?:\"|\z)|'[^']*(?:'|\z))?|[\"'])*")
_SCRIPT_SCAN = _re2_latin1(rb"(?i)(<!--)|(-->)|(<script[\t\n\f\r />])|(</script[\t\n\f\r />])")

_VOID = frozenset(
    "area base basefont bgsound br col embed frame hr img input keygen link meta param source "
    "track wbr".split())
# Raw text / RCDATA elements: their content is skipped up to the end tag in one search.
_RAWTEXT = frozenset("script style xmp iframe noembed noframes noscript textarea title".split())
# Dropped with everything inside them: the DESIGN section 3 list, plus elements a browser does
# not render as page text (noscript with scripting on, object/embed/canvas/audio/video
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
_FORMATTING = frozenset("a b big code em font i nobr s small strike strong tt u".split())
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
# Start tag -> the open elements it closes first, and the scope each must be in (HTML5).
_IMPLIED = {
    "li": (("li", "list"),),
    "dd": (("dd", "default"), ("dt", "default")),
    "dt": (("dd", "default"), ("dt", "default")),
    "td": (("td", "table"), ("th", "table")),
    "th": (("td", "table"), ("th", "table")),
    "tr": (("td", "table"), ("th", "table"), ("tr", "table")),
    "option": (("option", "default"),),
    "optgroup": (("option", "default"), ("optgroup", "default")),
}
for _n in ("thead", "tbody", "tfoot"):
    _IMPLIED[_n] = tuple((x, "table") for x in ("td", "th", "tr", "thead", "tbody", "tfoot"))
_CONTROL_REFS = frozenset(list(range(0x01, 0x09)) + [0x0B] + list(range(0x0E, 0x20)) + [0x7F])

_SPECIAL = (_VOID | _RAWTEXT | _P_CLOSERS | _HEADINGS | _DROP
            | {"html", "body", "head", "plaintext", "li", "dd", "dt", "td", "th", "tr", "thead",
               "tbody", "tfoot", "option", "optgroup", "a", "details", "dialog", "summary", "svg",
               "math", "table", "caption", "button", "ol", "ul", "template", "marquee", "object",
               "applet"})


class _Plain:
    """Membership test: an element name with no special tree-building rule here."""

    def __contains__(self, name: str) -> bool:
        return name not in _SPECIAL


_PLAIN = _Plain()
# Block containers whose only special rule is closing an open <p>: the fast path treats them
# like plain elements (an open <p> then stays open: the safe direction).
_P_ONLY = frozenset("div section article main address blockquote center figure figcaption "
                    "hgroup menu dir fieldset".split())


class _Trackless:
    def __contains__(self, name: str) -> bool:
        return name not in _SPECIAL or name in _P_ONLY


_TRACKLESS = _Trackless()


def _may_hide(raw_attrs: bytes) -> bool:
    low = raw_attrs.lower()
    return b"hidden" in low or b"style" in low or b"popover" in low

# element state on the stack
VISIBLE, HIDDEN, CLOSED_DETAILS = 0, 1, 2


@dataclass
class HtmlExtract:
    text: str
    title: str | None
    links: list[dict] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


class _Scanner:
    def __init__(self, data: bytes, dl):
        self.b = data
        self.n = len(data)
        self.dl = dl
        self.names: list[str] = []
        self.states: list[int] = []
        self.nf: list[int] = []  # running count of non-formatting elements, per stack index
        self.positions: dict[str, list[int]] = {}
        self.bounds: dict[str, list[int]] = {"default": [], "button": [], "list": [], "table": []}
        self.out: list[str] = []
        self.title: str | None = None
        self.links: list[dict] = []
        self.tags = 0
        self.entities = 0
        self.foreign = 0
        self.doc_hidden = False
        self.quirks = True  # until a doctype is seen before the first element
        self.seen_element = False
        self.styles: dict[str, bool] = {}
        self._attr_cache: dict[bytes, dict[str, str]] = {}
        self._marker_next = [-1, -1, -1, -1]
        self.counts = {"hidden_elements": 0, "dropped_elements": 0, "links_dropped": 0,
                       "controls_refs": 0}

    def count_tag(self) -> None:
        self.tags += 1
        if self.tags > limits.HTML_MAX_TAGS:
            raise ParserBomb(f"html: more than {limits.HTML_MAX_TAGS} tags")
        if not self.tags & 1023:
            self.dl.check()

    # -- the element stack ------------------------------------------------------------------
    def visible(self) -> bool:
        return not self.doc_hidden and (not self.states or self.states[-1] == VISIBLE)

    def push(self, name: str, state: int) -> None:
        idx = len(self.names)
        if idx >= limits.HTML_MAX_DEPTH:
            raise ParserBomb(f"html: more than {limits.HTML_MAX_DEPTH} open elements")
        self.names.append(name)
        self.states.append(state)
        nf = self.nf
        nf.append((nf[-1] if nf else 0) + (name not in _FORMATTING))
        lst = self.positions.get(name)
        if lst is None:
            self.positions[name] = [idx]
        else:
            lst.append(idx)
        scopes = _SCOPES_OF.get(name)
        if scopes:
            for scope in scopes:
                self.bounds[scope].append(idx)
            if name in ("svg", "math"):
                self.foreign += 1
        elif name in ("svg", "math"):
            self.foreign += 1

    def pop_to(self, idx: int) -> None:
        """Pop every element at stack index >= idx."""
        names, states, nf, positions = self.names, self.states, self.nf, self.positions
        while len(names) > idx:
            name = names.pop()
            state = states.pop()
            nf.pop()
            positions[name].pop()
            scopes = _SCOPES_OF.get(name)
            if scopes:
                for scope in scopes:
                    self.bounds[scope].pop()
            if name in ("svg", "math"):
                self.foreign -= 1
            if state != HIDDEN and name in _BLOCK:
                self.out.append("\n")

    def in_scope(self, name: str, scope: str) -> int:
        """Stack index of the topmost `name` if it is in `scope`, else -1."""
        lst = self.positions.get(name)
        if not lst:
            return -1
        bnd = self.bounds[scope]
        # in scope when no boundary sits above it (the element may be a boundary itself)
        return lst[-1] if lst[-1] >= (bnd[-1] if bnd else -1) else -1

    def close_in_scope(self, name: str, scope: str) -> None:
        i = self.in_scope(name, scope)
        if i >= 0:
            self.pop_to(i)

    # -- text -----------------------------------------------------------------------------
    def _control_ref(self, m) -> bytes:
        v = int(m.group(1), 16) if m.group(1) is not None else int(m.group(2))
        if v in _CONTROL_REFS:
            # html.unescape would silently drop it; keep the control so stage 4 counts it
            self.counts["controls_refs"] += 1
            return bytes((v,))
        return m.group(0)

    def decode(self, seg: bytes) -> str:
        if b"&" in seg:
            self.entities += seg.count(b"&")
            if self.entities > limits.HTML_MAX_ENTITIES:
                raise ParserBomb(f"html: more than {limits.HTML_MAX_ENTITIES} character references")
            if b"&#" in seg:
                seg = _SMALL_NUMREF.sub(self._control_ref, seg)
            return _html.unescape(seg.decode("utf-8", "replace"))
        return seg.decode("utf-8", "replace")

    def emit_text(self, seg: bytes) -> None:
        if not seg or not self.visible():
            return
        if not self.positions.get("pre"):
            seg = _HTML_WS.sub(b" ", seg)
        self.out.append(self.decode(seg))

    # -- attributes -----------------------------------------------------------------------
    def attrs(self, raw: bytes) -> dict[str, str]:
        hit = self._attr_cache.get(raw)
        if hit is None:
            hit = self._parse_attrs(raw)
            if len(self._attr_cache) < 4096:
                self._attr_cache[raw] = hit
        return hit

    def _parse_attrs(self, raw: bytes) -> dict[str, str]:
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

    def hides(self, attrs: dict[str, str]) -> bool:
        if not attrs:
            return False
        if "hidden" in attrs or "popover" in attrs:
            return True
        if attrs.get("aria-hidden", "").strip().lower() == "true":
            return True
        style = attrs.get("style")
        if not style:
            return False
        hit = self.styles.get(style)
        if hit is None:
            if len(self.styles) >= limits.HTML_MAX_STYLE_EVALS:
                raise ParserBomb(f"html: more than {limits.HTML_MAX_STYLE_EVALS} distinct inline styles")
            hit = self.styles[style] = css_hides(style)
        return hit

    def add_link(self, kind: str, url: str | None, text: str | None) -> None:
        if not url:
            return
        if len(self.links) >= limits.MAX_LINKS:
            self.counts["links_dropped"] += 1
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
    def tag_end(self, p: int) -> int:
        """Offset of the '>' that closes the tag whose body starts at p; -1 at end of input."""
        b = self.b
        gt = b.find(b">", p)
        if gt < 0:
            return -1
        dq = b.find(b'"', p, gt)
        sq = b.find(b"'", p, gt)
        if dq < 0 and sq < 0:
            return gt
        # A quote opens a value only right after '=' (and blanks). Walk the quotes with
        # C-level finds; a tag with many quotes goes to the RE2 DFA in one pass.
        q = p
        for _ in range(64):
            if dq < 0 and sq < 0:
                return gt
            i = dq if sq < 0 or (0 <= dq < sq) else sq
            k = i - 1
            while k >= q and b[k] in b" \t\n\f\r":
                k -= 1
            if k >= q and b[k] == 0x3D:  # '=': a quoted value runs to its closing quote
                j = b.find(b[i:i + 1], i + 1)
                if j < 0:
                    return -1  # unterminated value: the tag runs to the end of input
                q = j + 1
                if q > gt:
                    gt = b.find(b">", q)
                    if gt < 0:
                        return -1
            else:
                q = i + 1  # a quote inside a name: ordinary character
            dq = b.find(b'"', q, gt)
            sq = b.find(b"'", q, gt)
        e = _TAG_BODY.match(b, p).end()
        return e if e < self.n else -1

    def start_tag(self, name: str, raw_attrs: bytes, pos_after: int) -> int:
        self.seen_element = True
        if name in _TRACKLESS and not self.foreign and not self.positions.get(name) \
                and (not raw_attrs or not _may_hide(raw_attrs)):
            # Fast path: an element that cannot hide anything, with no same-name element open,
            # changes no visibility: it is not put on the stack (its end tag is ignored the same
            # way). Ignoring it can only keep an open element open longer: the safe direction.
            if name in _BLOCK and self.visible():
                self.out.append("\n")
            return pos_after
        selfclose = raw_attrs.endswith(b"/")
        if selfclose and (self.foreign or name in ("svg", "math")):
            return pos_after  # foreign elements honour '/>' (HTML5); an empty <svg/> holds nothing
        attrs: dict[str, str] = {}
        if raw_attrs:
            low = raw_attrs.lower()
            if (b"hidden" in low or b"style" in low or b"popover" in low
                    or (b"open" in low and name in ("dialog", "details"))
                    or (name in ("a", "area", "img") and len(self.links) < limits.MAX_LINKS)):
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
            if name in ("br", "hr"):
                if name == "hr":
                    self.close_in_scope("p", "button")
                if vis:
                    self.out.append("\n")
            elif name == "img" and vis:
                self.add_link("image", attrs.get("src"), attrs.get("alt") or attrs.get("title"))
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
        positions = self.positions  # (each close is skipped at once when nothing of that name is open)
        if name in _P_CLOSERS and positions.get("p") and not (name == "table" and self.quirks):
            self.close_in_scope("p", "button")
        implied = _IMPLIED.get(name)
        if implied:
            for n, scope in implied:
                if positions.get(n):
                    self.close_in_scope(n, scope)
        elif name == "a" and positions.get("a"):
            self.end_tag("a")
        if name in _HEADINGS and self.names and self.names[-1] in _HEADINGS:
            self.pop_to(len(self.names) - 1)

        top = self.states[-1] if self.states else VISIBLE
        if self.doc_hidden or top == HIDDEN:
            parent_hidden = True
        elif top == CLOSED_DETAILS:
            parent_hidden = name != "summary"  # a closed <details> shows only its summary
        else:
            parent_hidden = False
        drop = name in _DROP or (name == "dialog" and "open" not in attrs)
        if not parent_hidden:
            if hidden_attr:
                self.counts["hidden_elements"] += 1
            elif drop:
                self.counts["dropped_elements"] += 1
        if parent_hidden or hidden_attr or drop:
            state = HIDDEN
        elif name == "details" and "open" not in attrs:
            state = CLOSED_DETAILS
        else:
            state = VISIBLE
        if name == "a" and state != HIDDEN:
            self.add_link("link", attrs.get("href"), attrs.get("title"))
        self.push(name, state)
        if name in _BLOCK and state != HIDDEN:
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
        gt = self.tag_end(start + 2)
        return self.n if gt < 0 else gt + 1

    _low: bytes | None = None

    def rawtext_end(self, name: str, pos: int) -> int:
        """Offset of the first '</name' + delimiter at or after pos (HTML5: the 'appropriate end
        tag'); the end of input if none. One forward pass over a lower-cased copy."""
        if self._low is None:
            self._low = self.b.lower()  # ASCII case fold only; same length, same offsets
        needle = b"</" + name.encode()
        p = pos
        while True:
            i = self._low.find(needle, p)
            if i < 0:
                return self.n
            j = i + len(needle)
            if j < self.n and self.b[j] in b"\t\n\f\r />":
                return i
            p = j

    _MARKERS = (b"<!--", b"-->", b"<script", b"</script")

    def _next_marker(self, k: int, p: int) -> int:
        """Next offset >= p of marker k ('<script'/'</script' only when a delimiter follows),
        cached per document: every marker's position only moves forward, so all the finds
        together read the input a bounded number of times."""
        nxt = self._marker_next
        if nxt[k] >= p:
            return nxt[k]
        if self._low is None:
            self._low = self.b.lower()  # ASCII case fold only; same length, same offsets
        needle = self._MARKERS[k]
        i = p
        while True:
            i = self._low.find(needle, i)
            if i < 0:
                i = self.n
                break
            j = i + len(needle)
            if k < 2 or (j < self.n and self.b[j] in b"\t\n\f\r />"):
                break
            i = j
        nxt[k] = i
        return i

    def script_end(self, pos: int) -> int:
        """HTML5 script data states (13.2.5.4-.30): '<!--' enters 'escaped', '<script' inside
        it 'double escaped', where '</script' does not end the script."""
        escaped = double = False
        p = pos
        while True:
            offs = [self._next_marker(k, p) for k in range(4)]
            k = min(range(4), key=offs.__getitem__)
            i = offs[k]
            if i >= self.n:
                return self.n
            self.count_tag()  # each marker costs one step; bounded like tags
            p = i + len(self._MARKERS[k])
            if k == 0:
                escaped = True
            elif k == 1:
                escaped = double = False
            elif k == 2:
                if escaped and not double:
                    double = True
            elif double:
                double = False
            else:
                return i

    def end_tag(self, name: str) -> None:
        if name in _TRACKLESS and not self.positions.get(name):
            if name in _BLOCK and self.visible():
                self.out.append("\n")
            return
        if name == "br":
            if self.visible():
                self.out.append("\n")
            return
        if name in ("html", "body", "head"):
            return
        if name in _FORMATTING:
            i = self.in_scope(name, "default")
            if i < 0:
                return
            if self.nf[-1] - self.nf[i] > 0:
                # Adoption agency (HTML5 13.2.6.4.7): a block sits above the formatting element;
                # a browser keeps that block open with the content that follows. Ignoring the
                # end tag keeps the block (and anything hiding it) open: the safe direction.
                return
            self.pop_to(i)
            return
        self.close_in_scope(name, _END_SCOPE.get(name, "default"))

    # -- the loop ---------------------------------------------------------------------------
    def run(self) -> None:
        """The scan loop. The common cases (text, and tags of elements that cannot change
        visibility) are handled inline: the per-tag cost is the work budget of this stage."""
        b, n, pos = self.b, self.n, 0
        info: dict[bytes, tuple[str, int]] = {}
        search = _OPEN.search
        ws_sub = _HTML_WS.sub
        out = self.out
        positions = self.positions
        states = self.states
        start_tag, end_tag, tag_end, decode = self.start_tag, self.end_tag, self.tag_end, self.decode
        max_tags = limits.HTML_MAX_TAGS
        tags = 0
        while pos < n:
            m = search(b, pos)
            lt = n if m is None else m.start()
            if lt > pos and not self.doc_hidden and (not states or states[-1] == VISIBLE):
                seg = b[pos:lt]
                if not positions.get("pre"):
                    seg = ws_sub(b" ", seg)
                out.append(decode(seg) if b"&" in seg else seg.decode("utf-8", "replace"))
            if m is None:
                break
            tags += 1
            if not tags & 1023:
                if tags > max_tags:
                    raise ParserBomb(f"html: more than {max_tags} tags")
                self.dl.check()
            kind = m.lastindex
            if kind == 3 or kind == 6:  # start tag / end tag
                raw = m.group(1) if kind == 3 else m.group(4)
                got = info.get(raw)
                if got is None:
                    name = raw.decode("latin-1").lower()
                    cls = (2 if name not in _TRACKLESS else 1 if name in _BLOCK else 0)
                    got = info[raw] = (name, cls)
                name, cls = got
                closed = m.group(kind)  # '>' when the body held no quote
                if closed:
                    end = m.end()
                    body_b = m.group(kind - 1)
                else:
                    body = m.start(kind - 1)
                    gt = tag_end(body)
                    if gt < 0:  # cut off by the end of input: dropped (HTML5)
                        break
                    end = gt + 1
                    body_b = b[body:gt]
                pos = end
                if cls < 2 and not self.foreign and not positions.get(name) \
                        and (kind == 6 or not body_b or not _may_hide(body_b)):
                    # an element that cannot change visibility, none of its name open: not
                    # tracked (see start_tag); block elements still separate lines
                    self.seen_element = True
                    if cls == 1 and not self.doc_hidden and (not states or states[-1] == VISIBLE):
                        out.append("\n")
                    continue
                if kind == 3:
                    pos = start_tag(name, body_b, end)
                else:
                    end_tag(name)
            elif kind == 7:  # comment
                p = m.end()
                if b.startswith(b">", p):
                    pos = p + 1
                elif b.startswith(b"->", p):
                    pos = p + 2
                else:
                    e = _COMMENT_END.search(b, p)
                    pos = n if e is None else e.end()
            else:  # doctype, processing instruction, bogus comment, '</>'
                gt = b.find(b">", m.end())
                if not self.seen_element and b[lt:lt + 9].lower() == b"<!doctype":
                    self.quirks = False
                pos = n if gt < 0 else gt + 1
        self.tags += tags
        if self.tags > max_tags:
            raise ParserBomb(f"html: more than {max_tags} tags")


# -- inline CSS ------------------------------------------------------------------------------
# Python `re`, linear by form: a literal backslash, then a bounded class run or one character.
_CSS_ESCAPE = re.compile(rb"\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n0-9a-fA-F])")
# Python `re`, linear by form: used with .match on one short token at a time.
_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_RELEVANT = frozenset((
    "display", "visibility", "content-visibility", "opacity", "font-size", "font", "left", "right",
    "top", "bottom", "inset", "margin-left", "margin-right", "margin-top", "margin", "text-indent",
    "clip", "clip-path", "transform", "translate", "scale", "zoom", "height", "max-height", "width",
    "max-width", "overflow", "overflow-x", "overflow-y", "color", "background-color", "background"))
_MAX_DECLS = 64
_MAX_CSS_ESCAPES = 256
# CSS units to px (absolute per CSS Values 4; font-relative at 16px; viewport at a 1000px window)
_PX = {"": 1.0, "px": 1.0, "pt": 4 / 3, "pc": 16.0, "in": 96.0, "cm": 96 / 2.54, "mm": 96 / 25.4,
       "q": 96 / 101.6, "em": 16.0, "rem": 16.0, "ex": 8.0, "ch": 8.0, "cap": 11.0, "ic": 16.0,
       "lh": 19.2, "rlh": 19.2, "vw": 10.0, "vh": 10.0, "vmin": 10.0, "vmax": 10.0, "%": 10.0}
_OFFSET_PROPS = ("left", "right", "top", "bottom", "inset", "margin-left", "margin-right",
                 "margin-top", "margin", "text-indent", "translate")


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


def _tokens(val: str) -> list[str]:
    for ch in ",()/":
        val = val.replace(ch, " ")
    return val.split()


def _num(tok: str) -> tuple[float, str] | None:
    """(value, unit) of a CSS number token ('1e-9px' -> (1e-09, 'px')), or None."""
    m = _NUMBER.match(tok)
    if m is None:
        return None
    try:
        v = float(m.group(0))
    except (ValueError, OverflowError):
        return None
    if v != v:  # NaN
        return None
    return v, tok[m.end():].lower()


def _nums(val: str):
    for tok in _tokens(val):
        r = _num(tok)
        if r is not None:
            yield r


def _px(v: float, unit: str) -> float | None:
    f = _PX.get(unit)
    return None if f is None else v * f


def _calc(expr: str) -> float | None:
    """Evaluate a calc() body ('-1 * 9999px') to px, left to right with * and / binding first;
    None when it is not a plain arithmetic of numbers."""
    toks = expr.replace("*", " * ").replace("/", " / ").replace("(", " ").replace(")", " ").split()
    terms: list[float] = []
    sign = 1.0
    cur: float | None = None
    op = None
    for t in toks:
        if t in ("*", "/"):
            op = t
            continue
        if t in ("+", "-"):
            if cur is not None:
                terms.append(cur)
                cur = None
            sign = -1.0 if t == "-" else 1.0
            continue
        r = _num(t)
        if r is None:
            return None
        v = _px(*r) if r[1] else r[0]
        if v is None:
            return None
        if cur is None:
            cur = sign * v
            sign = 1.0
        elif op == "*":
            cur *= v
        elif op == "/":
            cur = cur / v if v else float("inf")
        op = None
    if cur is not None:
        terms.append(cur)
    return sum(terms) if terms else None


def _lengths_px(val: str) -> list[float]:
    """Every length in a value, in px; calc() expressions are evaluated."""
    out: list[float] = []
    low = val
    while "calc(" in low:
        i = low.find("calc(")
        depth = 0
        j = i + 4
        while j < len(low):
            if low[j] == "(":
                depth += 1
            elif low[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = low[i + 5:j]
        if len(body) > limits.CSS_MAX_CALC_CHARS:
            out.append(float("-inf"))  # an expression this long is treated as off-screen
        else:
            v = _calc(body)
            if v is not None:
                out.append(v)
        low = low[:i] + " " + low[j + 1:]
    for v, unit in _nums(low):
        p = _px(v, unit)
        if p is not None:
            out.append(p)
    return out


def _tiny_font(val: str) -> bool:
    for p in _lengths_px(val):
        return p < 2
    return False


def _off_screen(val: str) -> bool:
    return any(p <= -500 or p >= 5000 for p in _lengths_px(val))


def _alpha_zero(color: str) -> bool:
    c = color.replace(" ", "")
    if c == "transparent":
        return True
    if c.startswith("#") and len(c) in (5, 9) and all(ch in "0123456789abcdef" for ch in c[1:]):
        alpha = c[-1:] if len(c) == 5 else c[-2:]  # #rgba / #rrggbbaa
        return int(alpha, 16) == 0
    if c.endswith((",0)", "/0)", ",0%)", "/0%)", ",.0)", "/.0)", ",0.0)", "/0.0)")):
        return True
    return False


def css_hides(style: str) -> bool:
    """True when an inline style hides the element: DESIGN section 3 (display:none,
    visibility:hidden, font-size:0, opacity:0, off-screen positioning) and the equivalents a
    page uses for the same effect (clip, zero box + overflow, zoom, scale, transparent or
    same-as-background colour, translate off-screen). Numbers may use exponents, every CSS
    length unit, and calc()."""
    s = style[: limits.HTML_MAX_ATTR_BYTES]
    if "/*" in s:
        s = _strip_css_comments(s)
    if "\\" in s:
        if s.count("\\") > _MAX_CSS_ESCAPES:
            return True  # a style built of escapes is not presentation: treat it as hiding
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
    if "zoom" in decls:
        for v, unit in _nums(decls["zoom"]):
            if (unit == "%" and v <= 10) or (unit != "%" and v <= 0.1):
                return True
            break
    if "font-size" in decls and _tiny_font(decls["font-size"]):
        return True
    if "font" in decls:
        for tok in decls["font"].replace("/", " ").split():
            if tok[:1].isdigit() or tok[:1] in (".", "-", "+") or tok.startswith("calc"):
                if _tiny_font(tok):
                    return True
                break
    for prop in _OFFSET_PROPS:
        if prop in decls and _off_screen(decls[prop]):
            return True
    tr = decls.get("transform", "")
    if tr:
        if "translate" in tr and _off_screen(tr):
            return True
        if "scale" in tr:
            i = tr.find("scale")
            inner = tr[i:tr.find(")", i) + 1] if ")" in tr[i:] else tr[i:]
            if any(abs(v) <= 0.01 for v, _u in _nums(inner.split("(", 1)[-1])):
                return True
    if "scale" in decls and any(abs(v) <= 0.01 for v, _u in _nums(decls["scale"])):
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
                for p in _lengths_px(decls[prop]):
                    if p <= 1:
                        return True
                    break
    color = decls.get("color", "")
    if color:
        if _alpha_zero(color):
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


def extract_html(data: bytes, dl=_deadline.NONE) -> HtmlExtract:
    """UTF-8 HTML bytes -> visible text, raw title, links. Raises ParserBomb on hostile
    structure and DeadlineExceeded past the deadline."""
    truncated = max(0, len(data) - limits.HTML_MAX_BYTES)
    data = cut_utf8(data, limits.HTML_MAX_BYTES)
    sc = _Scanner(data, dl)
    sc.run()
    dl.check()
    # strip only HTML whitespace: other controls stay for stage 4 to count (str.strip() would
    # drop U+001C..U+001F and U+0085 silently)
    lines = (ln.strip(" \t\r\f") for ln in "".join(sc.out).split("\n"))
    text = "\n".join(ln for ln in lines if ln)
    counts = dict(sc.counts)
    counts["truncated_bytes"] = truncated
    title = " ".join(sc.title.split()) if sc.title is not None else None
    return HtmlExtract(text=text, title=title, links=sc.links, counts=counts)
