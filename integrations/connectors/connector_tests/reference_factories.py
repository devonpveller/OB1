"""Conformance factories for the reference connector (python -m connector_kit.testkit.conformance
connector_tests.reference_factories:fixture_connector connector_tests.reference_factories:oversize_connector)."""
from __future__ import annotations

import atexit
import dataclasses
import os
import shutil
import tempfile
from pathlib import Path

import connector_tests  # noqa: F401 - sys.path

from connector_kit.envelope import RAW_MAX_BYTES
from reference.file_connector import FileConnector

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "reference"
_BIG: list[str] = []


def fixture_connector(config):
    return FileConnector(dataclasses.replace(config, options={"input": str(FIXTURES)}))


def _big_dir() -> str:
    if not _BIG:
        d = tempfile.mkdtemp(prefix="reference-oversize-")
        with open(os.path.join(d, "big.txt"), "wb") as fh:
            fh.write(b"a" * (RAW_MAX_BYTES + 1))
        with open(os.path.join(d, "small.txt"), "wb") as fh:
            fh.write(b"a small file next to the big one")
        _BIG.append(d)
        atexit.register(shutil.rmtree, d, True)
    return _BIG[0]


def oversize_connector(config):
    return FileConnector(dataclasses.replace(config, options={"input": _big_dir()}))
