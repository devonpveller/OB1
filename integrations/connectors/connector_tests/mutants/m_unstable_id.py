"""MUTANT: a new external_id every run (intake can never answer a repeat or a revision)."""
import uuid

from connector_kit import Connector, Item


class UnstableId(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        yield Item(external_id=str(uuid.uuid4()), content_type="text/plain", raw="the same text every run")


def factory(config):
    return UnstableId(config)
