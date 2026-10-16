#!/usr/bin/env python3
"""Fetch the pinned classifier model files ONCE, at build/setup time, and verify them (intake
I3). Screening never fetches: intake.classifier loads these files offline and checks every
hash again before it loads them.

    python tools/fetch_classifier.py [--dest DIR] [--verify-only]

  * Source: https://huggingface.co/<MODEL_REPO>/resolve/<MODEL_REVISION>/<file> for each file in
    intake.classifier.MODEL_FILES (the repo revision is a full commit sha, so the URL names
    exactly one version of each file).
  * Each file is streamed to <file>.part, at most its pinned size + 1 bytes (I3 review R-3),
    its size and sha256 are checked against the pin, and only then is it renamed into place.
    A mismatch deletes the part file and exits 1.
  * A file already present with the pinned hash is not fetched again.
  * --dest defaults to INTAKE_CLASSIFIER_DIR, else models/<repo>-<revision[:8]> beside the
    package (gitignored: the weights are never committed).
  * --verify-only checks what is there and fetches nothing (exit 1 on any missing or wrong file).

Exit: 0 every file verified; 1 a file missing or not the pinned one; 2 usage / network error.
Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from intake import classifier, config  # noqa: E402

URL = "https://huggingface.co/{repo}/resolve/{rev}/{name}"


def _sha256_file(path: Path) -> tuple[int, str]:
    h = hashlib.sha256()
    n = 0
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
            n += len(block)
    return n, h.hexdigest()


def verify(dest: Path) -> list[str]:
    bad = []
    for name, (size, sha) in classifier.MODEL_FILES.items():
        p = dest / name
        if not p.is_file():
            bad.append(f"{name}: missing")
            continue
        n, got = _sha256_file(p)
        if n != size or got != sha:
            bad.append(f"{name}: {n} bytes sha256 {got}, pinned {size} bytes {sha}")
    return bad


def fetch(dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    bad = []
    for name, (size, sha) in classifier.MODEL_FILES.items():
        final = dest / name
        if final.is_file() and _sha256_file(final) == (size, sha):
            print(f"ok      {name} (already verified)")
            continue
        url = URL.format(repo=classifier.MODEL_REPO, rev=classifier.MODEL_REVISION, name=name)
        part = dest / (name + ".part")
        h = hashlib.sha256()
        n = 0
        print(f"fetch   {url}")
        # I3 review R-3: read at most size + 1 bytes - one more than the pin is enough to know
        # the file is wrong - so a hostile or broken server cannot fill the disk first
        limit = size + 1
        with urllib.request.urlopen(url, timeout=60) as resp, part.open("wb") as out:
            while n < limit:
                block = resp.read(min(1 << 20, limit - n))
                if not block:
                    break
                h.update(block)
                out.write(block)
                n += len(block)
        if n != size or h.hexdigest() != sha:
            part.unlink()
            got = f"more than {size}" if n > size else str(n)
            bad.append(f"{name}: got {got} bytes sha256 {h.hexdigest()}, pinned {size} bytes {sha}")
            continue
        os.replace(part, final)
        print(f"ok      {name} {size} bytes sha256 {sha}")
    return bad


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dest", default=os.environ.get("INTAKE_CLASSIFIER_DIR", config.DEFAULT_CLASSIFIER_DIR))
    ap.add_argument("--verify-only", action="store_true")
    a = ap.parse_args(argv)
    dest = Path(a.dest)
    print(f"model   {classifier.MODEL_REPO} @ {classifier.MODEL_REVISION} ({classifier.MODEL_LICENSE})")
    print(f"dest    {dest}")
    try:
        bad = verify(dest) if a.verify_only else fetch(dest)
    except OSError as e:
        print(f"error   {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if not bad and not a.verify_only:
        bad = verify(dest)
    for b in bad:
        print(f"FAIL    {b}", file=sys.stderr)
    if not bad:
        print("verified: every file matches its pinned size and sha256")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
