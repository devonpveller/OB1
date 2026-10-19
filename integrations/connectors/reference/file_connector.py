"""The reference connector: local files or stdin in, intake envelopes out. No network of its own.

It proves the kit: everything a real connector does except fetching. Options (ConnectorConfig.options):

  input        a file, a directory (every regular file directly in it, sorted by name; not
               recursive; hidden files skipped), or "-" for stdin
  external_id  for stdin only (required there): the item's stable id
  content_type for stdin only (default text/plain); for files it comes from the extension

ITEM IDENTITY: a file's external_id is "file/<name>" (the name relative to the input directory,
or the file's own name) - stable across runs, so a re-run is a repeat at intake and an edited file
a new revision. The origin in the provenance is "file:<name>" or "stdin", never a host path.

CAPS: a file over intake's 5 MB raw cap is refused locally (too_large) after a bounded read (at
most 5 MB + 1 byte) - it is never read whole and never sent. An unknown extension is refused (refused).
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path
from typing import Iterator

from connector_kit import Connector, Item
from connector_kit.envelope import ALLOWED_TYPES, RAW_MAX_BYTES

TYPES = {".txt": "text/plain", ".text": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
         ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
         ".eml": "message/rfc822", ".json": "application/json"}
assert set(TYPES.values()) <= set(ALLOWED_TYPES)


class FileConnector(Connector):
    id = "reference-file"
    source = "local-file"
    version = "1"

    def _now(self) -> dt.datetime:
        return dt.datetime.now(dt.timezone.utc)

    def collect(self) -> Iterator[Item]:
        opts = self.config.options
        target = opts.get("input")
        if not target:
            raise ValueError("the reference connector needs options['input'] (a file, a directory or '-')")
        if target == "-":
            ext_id = opts.get("external_id")
            if not ext_id:
                raise ValueError("stdin needs options['external_id'] (a stable id)")
            data = sys.stdin.buffer.read(RAW_MAX_BYTES + 1)
            yield Item(external_id=ext_id, content_type=opts.get("content_type", "text/plain"), raw=data,
                       fetched_at=self._now(), origin="stdin")
            return
        path = Path(target)
        if path.is_dir():
            files = sorted(p for p in path.iterdir() if p.is_file() and not p.name.startswith("."))
        else:
            files = [path]
        for f in files:
            yield self._item(f)

    def _item(self, f: Path) -> Item:
        name = f.name
        ctype = TYPES.get(f.suffix.lower(), "application/octet-stream")
        # a bounded read: a file over the 5 MB raw cap is never read whole; the kit refuses the
        # over-cap raw (too_large) before anything is sent
        with open(f, "rb") as fh:
            data = fh.read(RAW_MAX_BYTES + 1)
        return Item(external_id=f"file/{name}", content_type=ctype, raw=data, fetched_at=self._now(),
                    origin=f"file:{name}")
