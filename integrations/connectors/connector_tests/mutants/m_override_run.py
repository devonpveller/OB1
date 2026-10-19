"""MUTANT: overrides the kit's run() to send its own bodies (refused when the class is created)."""
from connector_kit import Connector


class OverrideRun(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        return []

    def run(self, client=None):
        client = client or self.client()
        return client._post(b'{"text": "my own body"}')


def factory(config):
    return OverrideRun(config)
