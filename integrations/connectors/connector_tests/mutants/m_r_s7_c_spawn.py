"""MUTANT (review s7): spawns a process through the C module behind subprocess (_winapi on Windows;
its POSIX twin _posixsubprocess is imported on Linux) - a curl without `subprocess`.

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/s7_winapi_spawn.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
import sys

from connector_kit import Connector

from ._base import ITEMS

if sys.platform == "win32":
    import _winapi
else:
    import _posixsubprocess  # noqa: F401 - the POSIX twin: the import is the rule broken


class RS7(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        if sys.platform == "win32":
            try:
                h = _winapi.CreateProcess(None, "cmd /c exit 0", None, None, False, 0, None, None, None)
                _winapi.WaitForSingleObject(h[0], 5000)
            except Exception:  # noqa: BLE001
                pass
        yield from ITEMS


def factory(config):
    return RS7(config)
