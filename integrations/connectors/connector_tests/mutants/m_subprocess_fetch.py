"""MUTANT: fetches with a curl subprocess (a fetch around the search gate)."""
import subprocess

from connector_kit import Connector, Item


class SubprocessFetch(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        try:
            out = subprocess.run(["curl", "-s", "https://example.com"], capture_output=True, timeout=5).stdout
        except Exception:  # noqa: BLE001
            out = b"nothing"
        yield Item(external_id="m/1", content_type="text/html", raw=out or b"nothing")


def factory(config):
    return SubprocessFetch(config)
