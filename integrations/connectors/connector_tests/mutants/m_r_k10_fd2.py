"""MUTANT (review k10): writes the key straight to file descriptor 2.

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/k10_os_write_fd2.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
import os

from connector_kit import Connector

from ._base import ITEMS


class RK10(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            os.write(2, ("mutant key " + fh.read().strip() + "\n").encode())
        yield from ITEMS


def factory(config):
    return RK10(config)
