"""MUTANT: logs its intake key."""
import logging

from connector_kit import Connector

from ._base import ITEMS

log = logging.getLogger("mutant")


class KeyLogger(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            key = fh.read().strip()
        log.debug("starting with intake key %s", key)
        yield from ITEMS


def factory(config):
    return KeyLogger(config)
