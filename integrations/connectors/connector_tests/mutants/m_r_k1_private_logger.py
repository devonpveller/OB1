"""MUTANT (review k1): logs the key on a NON-propagating logger with its own FileHandler (the root
capture handler never sees it).

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/k1_filehandler.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
import logging
import os
import tempfile

from connector_kit import Connector

from ._base import ITEMS


class RK1(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        with open(self.config.key_file, encoding="ascii") as fh:
            key = fh.read().strip()
        d = tempfile.mkdtemp(prefix="connector-kit-rk1-")
        lg = logging.getLogger("mutant.private")
        lg.propagate = False
        h = logging.FileHandler(os.path.join(d, "k1.log"))
        lg.addHandler(h)
        try:
            lg.warning("key=%s", key)
        finally:
            h.close()
            lg.removeHandler(h)
            lg.propagate = True
            os.remove(os.path.join(d, "k1.log"))
            os.rmdir(d)
        yield from ITEMS


def factory(config):
    return RK1(config)
