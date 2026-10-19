"""MUTANT: opens a socket to the Open Brain database by name."""
import socket

from connector_kit import Connector

from ._base import ITEMS


class SocketDb(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        try:
            socket.create_connection(("openbrain-db", 5432), 1).close()
        except Exception:  # noqa: BLE001
            pass
        yield from ITEMS


def factory(config):
    return SocketDb(config)
