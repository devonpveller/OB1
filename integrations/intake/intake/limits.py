"""Size and work caps for the deterministic stages (DESIGN-intake.md sections 3 and 7).

Every stage is bounded twice: by input size (the byte caps, checked before any parsing) and by
work (the caps below, checked while parsing). Operator D34 (2026-10-15): a legitimate page up
to the 2 MB HTML cap is extracted WHOLE - the work caps are set above anything a real page
reaches, and input that passes one is structurally hostile (a parser bomb) and is `rejected`
(DESIGN section 7), never truncated. The only truncation left is the 2 MB HTML byte cap that
DESIGN itself sets.

The bound (I2 acceptance, D34): every input inside the caps finishes the deterministic stages
in < 2 s on the reference host (i7-7820X). DEADLINE_SECONDS is enforced INSIDE the stages
(deadline.py): the loops check it, and no step between two checks is longer than ~0.3 s on
5 MB (measured under load), so a run that has not finished by the deadline stops there and
fails closed (`pending`). tests/test_bounds.py measures every case; the findings notes for
intake-i2 and intake-i3 list the numbers.

Not bounded in-process (operator D38): a single uninterruptible library call - the stdlib
email parser (MIME_MAX_HEADER_SEMICOLONS below is only a cheap early reject for its known
quadratic shape), json, a C codec, the classifier's tokenizer and forward pass. Callers run
screen() in a killable worker with a hard wall-clock limit (I5). The classifier (stage 6) has
its own time budget (classifier.py, INTAKE_CLASSIFIER_MAX_SECONDS), checked between chunks.
"""
from __future__ import annotations

# Stage 1: an envelope's raw content, after base64 decoding.
RAW_MAX_BYTES = 5 * 1024 * 1024

# Stage 3, HTML: input is cut to this many bytes (on a UTF-8 boundary) before parsing.
HTML_MAX_BYTES = 2 * 1024 * 1024
# Work caps (a page past one is a parser bomb, `rejected`). A real 2 MB page has well under
# 150,000 tags (about 14 bytes of markup per tag); 250,000 needs tags averaging < 9 bytes.
HTML_MAX_TAGS = 150_000
# Character references decoded per document (text and the attributes we read).
HTML_MAX_ENTITIES = 400_000
# Distinct inline style attributes evaluated per document (identical ones are cached).
HTML_MAX_STYLE_EVALS = 20_000
# More open elements than this is a parser bomb. Blink caps DOM depth at 512 too.
HTML_MAX_DEPTH = 512
# Attribute bytes we parse per element (style, hidden, href, src ...). A longer attribute
# list on an element is not parsed; if it mentions style/hidden the element counts as hidden.
HTML_MAX_ATTR_BYTES = 64 * 1024
# Characters inside one CSS calc() expression we evaluate; longer counts as hiding.
CSS_MAX_CALC_CHARS = 512
# calc() expressions evaluated in one CSS value; more counts as hiding (I2 review R-1, D39).
CSS_MAX_CALC_PER_VALUE = 64

# Links and images handed back in links[] (more are counted, not listed).
MAX_LINKS = 2000
MAX_URL_CHARS = 2048
MAX_LINK_TEXT_CHARS = 200
TITLE_MAX_CHARS = 300

# Stage 3, email.
MIME_MAX_MULTIPART = 32  # multipart containers per message (bounds the parser's boundary stack)
MIME_MAX_PARTS = 256
MIME_MAX_HEADER_CHARS = 2000  # subject / filename read at most this long
# Lines as the stdlib parser splits them (CR, LF or CRLF; round 3). The parser and the header
# pass cost ~4 us per header line under load; a 5 MB message of ordinary (<= 78 char) lines has
# ~70,000. More than this is a parser bomb (attempt 1: 5 MB of QP soft breaks took 1 s;
# attempt 2: 1.75 M CR-only lines took 2.4 s; round 3: 300,000 header lines took 1.25 s).
MIME_MAX_LINES = 150_000
# ';' in one header, its continuation lines included. The stdlib MIME parameter parser is
# quadratic in them inside one uninterruptible call (I2 attempt 3: 1 MB of ';' in a
# Content-Type took 28 s); a real header has a few dozen at most (DKIM-Signature ~12).
# Checked before the parser runs; more is a parser bomb (operator D38).
MIME_MAX_HEADER_SEMICOLONS = 128

# Stage 4: runs of non-starters (combining class != 0) longer than this are trimmed in the
# copy the rules read (Unicode UAX #15 stream-safe format), so NFKC reordering stays linear.
NONSTARTER_RUN_MAX = 30
# NFKC is applied in chunks of about this many characters (CPython's NFKC is super-linear on
# long expanding input; chunks keep it linear).
NFKC_CHUNK_CHARS = 4096
# The NFKC copy may be at most this many times longer than its input (plus slack); more is a
# normalisation bomb (one U+FDFA expands to 18 characters).
NFKC_MAX_EXPANSION = 3
NFKC_EXPANSION_SLACK = 65536
# Characters that are slow to normalise (an NFKC form of 4+ characters such as U+FDFA or the
# squared CJK words, ~2.4 us each; halfwidth katakana, ~0.3 us each; CPython 3.13) allowed in
# one text; more is a normalisation bomb.
NFKC_MAX_EXPENSIVE = 20_000
# Runs of 4+ combining marks allowed in one text (canonical reordering is quadratic in the run
# length); more is a normalisation bomb.
NFKC_MAX_LONG_MARK_RUNS = 2000
# str.translate over the whole text runs in slices of this many characters, so the deadline
# is checked between them.
TRANSLATE_SLICE_CHARS = 262_144

# Stage 5: matches collected per cue rule for the co-occurrence (combo) rule; and the most
# forged lines / [Source N] tokens neutralised before the item is a bomb.
CUE_MAX_MATCHES = 1000
MAX_NEUTRALISED = 10_000

# Stage 8: the run's time limit, checked inside the stages (deadline.py).
DEADLINE_SECONDS = 1.6
