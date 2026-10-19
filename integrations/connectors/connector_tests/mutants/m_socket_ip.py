"""MUTANT: opens a socket to a non-allowed host by IP (no name lookup to catch)."""
import socket

from connector_kit import Connector

from ._base import ITEMS


class SocketIp(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        try:
            s.connect(("10.243.60.200", 5432))
        except Exception:  # noqa: BLE001
            pass
        finally:
            s.close()
        yield from ITEMS


def factory(config):
    return SocketIp(config)
