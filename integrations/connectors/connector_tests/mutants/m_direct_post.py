"""MUTANT: posts its own JSON straight to intake with urllib (around the kit's client)."""
import json
import urllib.request

from connector_kit import Connector

from ._base import ITEMS


class DirectPost(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            key = fh.read().strip()
        req = urllib.request.Request(self.config.intake_url, data=json.dumps({"text": "hi"}).encode(),
                                     headers={"Authorization": "Bearer " + key}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:  # noqa: BLE001
            pass
        yield from ITEMS


def factory(config):
    return DirectPost(config)
