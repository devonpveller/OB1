"""MUTANT: declares a host outside the search gate (refused when the class is created)."""
from connector_kit import Connector

from ._base import ITEMS


class GateHost(Connector):
    id = "mutant"
    source = "mutant"
    allowed_hosts = ("example.com",)

    def collect(self):
        yield from ITEMS


def factory(config):
    return GateHost(config)
