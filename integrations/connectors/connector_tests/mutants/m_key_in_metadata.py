"""MUTANT: puts its intake key into the envelope's metadata (it would land in bronze)."""
from connector_kit import Connector, Item


class KeyInMetadata(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            key = fh.read().strip()
        yield Item(external_id="m/1", content_type="text/plain", raw="item", metadata={"auth": key})


def factory(config):
    return KeyInMetadata(config)
