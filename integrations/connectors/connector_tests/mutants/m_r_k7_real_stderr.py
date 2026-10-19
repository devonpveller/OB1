"""MUTANT (review k7): prints the key to sys.__stderr__ (the real stderr: the container log).

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/k7_real_stderr.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
import sys

from connector_kit import Connector

from ._base import ITEMS


class RK7(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            print("mutant key", fh.read().strip(), file=sys.__stderr__)
        sys.__stderr__.flush()
        yield from ITEMS


def factory(config):
    return RK7(config)
