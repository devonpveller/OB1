"""Stage 1: validate an envelope (DESIGN-intake.md sections 2 and 3, stage 1).

The envelope is the connector's request body for one item:
  { source, connector, external_id, fetched_at, content_type, raw, raw_encoding?, metadata?,
    links? }
raw is text, or base64 when raw_encoding == "base64". The schema is strict: a missing or
unknown field, a wrong type, raw over RAW_MAX_BYTES (after base64 decoding) or a content type
outside the allow-list (html, xhtml, plain, markdown, rfc822, json) raises Rejected, and the
pipeline returns a `rejected` result.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

from . import limits

# content type -> the extractor stage 3 uses
ALLOWED_TYPES = {
    "text/html": "html",
    "application/xhtml+xml": "html",
    "text/plain": "plain",
    "text/markdown": "markdown",
    "message/rfc822": "rfc822",
    "application/json": "json",
}
REQUIRED = ("source", "connector", "external_id", "fetched_at", "content_type", "raw")
OPTIONAL = ("raw_encoding", "metadata", "links")
MAX_METADATA_BYTES = 64 * 1024
MAX_ENVELOPE_LINKS = 1000

_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")  # one class: linear
_SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_MIME = re.compile(r"[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}")
_CHARSET = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,39}")


class Rejected(Exception):
    """The envelope fails stage 1; the message says why (it becomes the reason detail)."""


@dataclass(frozen=True)
class Envelope:
    source: str
    connector: str
    external_id: str
    fetched_at: str
    content_type: str
    kind: str
    charset: str | None
    raw: bytes
    metadata: Mapping[str, object]
    links: tuple[str, ...]
    surrogates: int = 0


def _text(obj: Mapping, name: str, max_len: int) -> str:
    v = obj[name]
    if not isinstance(v, str):
        raise Rejected(f"{name} must be a string")
    if not v or len(v) > max_len:
        raise Rejected(f"{name} must be 1..{max_len} characters")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        raise Rejected(f"{name} contains control characters")
    return v


def _content_type(value: str) -> tuple[str, str, str | None]:
    parts = [p.strip() for p in value.split(";")]
    mime = parts[0].lower()
    if not _MIME.fullmatch(mime) or mime not in ALLOWED_TYPES:
        raise Rejected(f"content type {mime!r} is not allowed")
    charset = None
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            if k.strip().lower() == "charset":
                v = v.strip().strip('"')
                if not _CHARSET.fullmatch(v):
                    raise Rejected("charset parameter is malformed")
                charset = v
    return mime, ALLOWED_TYPES[mime], charset


def _raw_bytes(raw: object, encoding: str) -> tuple[bytes, int]:
    if not isinstance(raw, str):
        raise Rejected("raw must be a string")
    if encoding == "text":
        if len(raw) > limits.RAW_MAX_BYTES:
            raise Rejected(f"raw is over {limits.RAW_MAX_BYTES} bytes")
        surrogates = 0
        try:
            data = raw.encode("utf-8")
        except UnicodeEncodeError:
            # lone surrogates (from a JSON '\ud800' escape) cannot be stored; each becomes
            # U+FFFD here and is counted under 'surrogates' (stage 4's class)
            fixed, surrogates = _SURROGATE.subn(chr(0xFFFD), raw)
            data = fixed.encode("utf-8")
        if len(data) > limits.RAW_MAX_BYTES:
            raise Rejected(f"raw is over {limits.RAW_MAX_BYTES} bytes")
        return data, surrogates
    elif encoding == "base64":
        if len(raw) > (limits.RAW_MAX_BYTES + 2) // 3 * 4 + 4:
            raise Rejected(f"raw is over {limits.RAW_MAX_BYTES} bytes")
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as e:
            raise Rejected(f"raw is not valid base64: {e}") from None
    else:
        raise Rejected("raw_encoding must be 'text' or 'base64'")
    if len(data) > limits.RAW_MAX_BYTES:
        raise Rejected(f"raw is over {limits.RAW_MAX_BYTES} bytes")
    return data, 0


def validate(obj: object) -> Envelope:
    """Return the validated envelope or raise Rejected."""
    if not isinstance(obj, Mapping):
        raise Rejected("the envelope must be an object")
    keys = set(obj.keys())
    missing = [k for k in REQUIRED if k not in keys]
    if missing:
        raise Rejected("missing field(s): " + ", ".join(missing))
    unknown = sorted(str(k) for k in keys - set(REQUIRED) - set(OPTIONAL))
    if unknown:
        raise Rejected("unknown field(s): " + ", ".join(unknown[:10]))

    source = _text(obj, "source", 64)
    connector = _text(obj, "connector", 64)
    for name, v in (("source", source), ("connector", connector)):
        if not _SLUG.fullmatch(v):
            raise Rejected(f"{name} must match [a-z0-9][a-z0-9._-]*")
    external_id = _text(obj, "external_id", 1024)
    fetched_at = _text(obj, "fetched_at", 64)
    try:
        datetime.fromisoformat(fetched_at)
    except ValueError:
        raise Rejected("fetched_at is not an ISO 8601 timestamp") from None
    ct_value = _text(obj, "content_type", 200)
    mime, kind, charset = _content_type(ct_value)

    encoding = obj.get("raw_encoding", "text")
    if encoding not in ("text", "base64"):
        raise Rejected("raw_encoding must be 'text' or 'base64'")
    raw, surrogates = _raw_bytes(obj["raw"], encoding)

    metadata = obj.get("metadata", {})
    if not isinstance(metadata, Mapping) or not all(isinstance(k, str) for k in metadata):
        raise Rejected("metadata must be an object with string keys")
    try:
        encoded = json.dumps(metadata, ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise Rejected("metadata is not plain JSON") from None
    if len(encoded) > MAX_METADATA_BYTES:
        raise Rejected(f"metadata is over {MAX_METADATA_BYTES} bytes")

    links = obj.get("links", [])
    if not isinstance(links, list) or len(links) > MAX_ENVELOPE_LINKS:
        raise Rejected(f"links must be a list of at most {MAX_ENVELOPE_LINKS} strings")
    for u in links:
        if not isinstance(u, str) or not u or len(u) > limits.MAX_URL_CHARS:
            raise Rejected(f"each link must be a string of 1..{limits.MAX_URL_CHARS} characters")

    return Envelope(source=source, connector=connector, external_id=external_id,
                    fetched_at=fetched_at, content_type=mime, kind=kind, charset=charset,
                    raw=raw, metadata=json.loads(encoded), links=tuple(links),
                    surrogates=surrogates)
