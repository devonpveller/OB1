"""Size and work caps for the deterministic stages (DESIGN-intake.md sections 3 and 7).

Every stage is bounded twice: by input size (these byte caps, checked before any parsing) and
by work (the caps below, checked while parsing). A volume cap truncates, like the byte caps:
what is not extracted is never stored or shown. Structurally hostile input (element nesting,
MIME containers, JSON depth, a normalisation bomb) is a "parser bomb" and gets a `rejected`
result (DESIGN section 7). The values keep the worst case under each cap well inside the 1 s
bound the I2 acceptance sets (tests/test_bounds.py); the findings note for intake-i2 lists
the measurements.
"""
from __future__ import annotations

# Stage 1: an envelope's raw content, after base64 decoding.
RAW_MAX_BYTES = 5 * 1024 * 1024

# Stage 3, HTML: input is cut to this many bytes (on a UTF-8 boundary) before parsing.
HTML_MAX_BYTES = 2 * 1024 * 1024
# Volume caps: past one, extraction stops and the rest of the document is truncated (like the
# byte cap; what is not extracted is never stored or shown).
# Tags (start, end, comment, doctype, script markers) per document.
HTML_MAX_TAGS = 60_000
# Character references decoded per document (text and the attributes we read).
HTML_MAX_ENTITIES = 150_000
# Distinct inline style attributes evaluated per document (identical ones are cached).
HTML_MAX_STYLE_EVALS = 3000
# Structural cap: more open elements than this is a parser bomb (`rejected`). Blink caps DOM
# depth at 512 too.
HTML_MAX_DEPTH = 512
# Attribute bytes we parse per element (style, hidden, href, src ...). Longer = not parsed.
HTML_MAX_ATTR_BYTES = 64 * 1024

# Links and images handed back in links[] (more are counted, not listed).
MAX_LINKS = 2000
MAX_URL_CHARS = 2048
MAX_LINK_TEXT_CHARS = 200
TITLE_MAX_CHARS = 300

# Stage 3, email.
MIME_MAX_MULTIPART = 32  # multipart containers per message (bounds the parser's boundary stack)
MIME_MAX_PARTS = 256
MIME_MAX_HEADER_CHARS = 2000  # subject / filename read at most this long

# Stage 3, JSON: nesting deeper than this is a parser bomb.
JSON_MAX_DEPTH = 200
# Past this many JSON values the rest is not extracted (a volume cap).
JSON_MAX_NODES = 100_000

# Stage 4: runs of non-starters (combining class != 0) longer than this are trimmed in the
# copy the rules read (Unicode UAX #15 stream-safe format), so NFKC reordering stays linear.
NONSTARTER_RUN_MAX = 30
# NFKC is applied in chunks of about this many characters (CPython's NFKC is super-linear on
# long expanding input; chunks keep it linear).
NFKC_CHUNK_CHARS = 4096
# The NFKC copy may be at most this many times longer than its input (plus slack); more is a
# normalisation bomb (one U+FDFA expands to 18 characters).
NFKC_MAX_EXPANSION = 3
# Characters that are slow to normalise (an NFKC form of 4+ characters such as U+FDFA or the
# squared CJK words, ~2.4 us each; halfwidth katakana, ~0.3 us each; CPython 3.13) allowed in
# one text; more is a normalisation bomb.
NFKC_MAX_EXPENSIVE = 20_000
# Runs of 4+ combining marks allowed in one text (canonical reordering is quadratic in the run
# length); more is a normalisation bomb.
NFKC_MAX_LONG_MARK_RUNS = 2000
NFKC_EXPANSION_SLACK = 65536

# Stage 8: the stages together get this long; a stage that finishes past it fails closed.
DEADLINE_SECONDS = 10.0
