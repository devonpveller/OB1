"""The classifier files checked against their pins at service start (I5).

The model is mounted READ-ONLY from a host path (compose: ${INTAKE_MODEL_DIR}:/models:ro), not
baked into the image. Before any worker starts, the service streams each pinned file
(classifier.MODEL_FILES: config.json, tokenizer.json, model.safetensors) through sha256 and
compares size and digest; a missing, short, long or altered file REFUSES THE START (exit 3).
Each worker then loads the model with the library's own loader, which checks the same pins on
the very bytes it loads (no time-of-check/time-of-use gap there): the start check is what
makes a tampered mount fail loudly at deploy time instead of every item going `pending`.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from intake.classifier import MODEL_FILES

_CHUNK = 1024 * 1024


class WeightsRefused(Exception):
    """A classifier file is missing or is not the pinned one."""


def verify_model_dir(model_dir: str | os.PathLike, files: dict[str, tuple[int, str]] | None = None) -> dict[str, str]:
    files = MODEL_FILES if files is None else files
    out: dict[str, str] = {}
    for name, (size, sha) in files.items():
        path = Path(model_dir) / name
        try:
            st = path.stat()
        except OSError as e:
            raise WeightsRefused(f"{name}: missing ({type(e).__name__})") from None
        if st.st_size != size:
            raise WeightsRefused(f"{name}: {st.st_size} bytes, pinned {size}")
        h = hashlib.sha256()
        n = 0
        try:
            with open(path, "rb") as f:
                while True:
                    b = f.read(_CHUNK)
                    if not b:
                        break
                    h.update(b)
                    n += len(b)
        except OSError as e:
            raise WeightsRefused(f"{name}: unreadable ({type(e).__name__})") from None
        got = h.hexdigest()
        if n != size or got != sha:
            raise WeightsRefused(f"{name}: sha256 {got[:16]}... is not the pinned {sha[:16]}...")
        out[name] = got
    return out
