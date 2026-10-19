"""python -m reference --input <file|dir|-> --intake-url http://<intake>:8000/v1/intake --key-file <path>
                      [--external-id ID] [--content-type TYPE] [--timeout S] [--max-attempts N]

Runs the reference connector once and prints the run report as JSON (outcomes, never text or the
key). Exit 0: every item recorded or refused locally; 3: the run stopped (401/403/413/422/...);
4: intake was unavailable (an item deferred after its retries); 2: usage or a key-file problem."""
from __future__ import annotations

import argparse
import json
import logging
import sys

from connector_kit import ConnectorConfig, RetryPolicy
from connector_kit.secret import KeyFileError

from .file_connector import FileConnector


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m reference")
    ap.add_argument("--input", required=True)
    ap.add_argument("--intake-url", required=True)
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--external-id")
    ap.add_argument("--content-type")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--max-attempts", type=int, default=5)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(name)s %(message)s")
    opts = {"input": a.input}
    if a.external_id:
        opts["external_id"] = a.external_id
    if a.content_type:
        opts["content_type"] = a.content_type
    cfg = ConnectorConfig(intake_url=a.intake_url, key_file=a.key_file, options=opts, timeout_s=a.timeout,
                          retry=RetryPolicy(max_attempts=a.max_attempts))
    try:
        report = FileConnector(cfg).run()
    except KeyFileError as e:
        print(f"key file: {e}", file=sys.stderr)
        return 2
    print(json.dumps(report.to_dict(), indent=1))
    if any(i.result == "deferred" for i in report.items):
        return 4
    return 3 if report.stopped else 0


if __name__ == "__main__":
    sys.exit(main())
