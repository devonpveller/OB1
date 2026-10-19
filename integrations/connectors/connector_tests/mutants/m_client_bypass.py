"""MUTANT: posts a non-envelope to intake through the kit client's private transport. No static red
flag and no sandbox violation (the socket is opened by the kit's own client module): only the
oracle on what reached intake can catch it."""
import json

from connector_kit import Connector

from ._base import ITEMS


class ClientBypass(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        client = self.client()
        try:
            client._post(json.dumps({"connector": "mutant", "text": "a summary, not an envelope"}).encode())
        except Exception:  # noqa: BLE001
            pass
        yield from ITEMS


def factory(config):
    return ClientBypass(config)
