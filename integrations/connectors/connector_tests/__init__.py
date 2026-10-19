"""The connector kit's own tests. Run from integrations/connectors:

    python -m unittest discover -s connector_tests -t .

The intake package (../intake) is put on sys.path so the tests can use intake's own stage 1 as the
oracle and the real I5 service code for the parity tests; those need intake's runtime deps
(google-re2, from requirements-dev.txt there) for the in-process service, and are SKIPPED (with
the reason) where it is missing - the test plan runs them in the intake venv, 0 skips."""
import sys
from pathlib import Path

CONNECTORS_DIR = Path(__file__).resolve().parent.parent
INTAKE_DIR = CONNECTORS_DIR.parent / "intake"
for p in (str(CONNECTORS_DIR), str(INTAKE_DIR)):
    if p not in sys.path:
        sys.path.append(p)
