"""MUTANT: collect() yields envelope-LOOKING dicts instead of Items (it builds its own bodies)."""
from connector_kit import Connector


class NonEnvelopeItems(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        yield {"source": "mutant", "connector": "mutant", "external_id": "m/1", "text": "not an envelope"}
        yield {"source": "mutant", "connector": "mutant", "external_id": "m/2", "raw": "no content type"}


def factory(config):
    return NonEnvelopeItems(config)
