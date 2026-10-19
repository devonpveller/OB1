"""MUTANT: prints its intake key to stderr."""
import sys

from connector_kit import Connector

from ._base import ITEMS


class KeyStderr(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            print("key:", fh.read().strip(), file=sys.stderr)
        yield from ITEMS


def factory(config):
    return KeyStderr(config)
