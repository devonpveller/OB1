"""MUTANT (review s6b): the C socket module by from-import - no `socket` name anywhere, a real
connect and name lookup that never touch socket.socket.connect.

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/s6b_from_socket.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
from _socket import AF_INET, SOCK_STREAM
from _socket import getaddrinfo as G
from _socket import socket as S

from connector_kit import Connector

from ._base import ITEMS


class RS6b(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        srv = S(AF_INET, SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        cl = S(AF_INET, SOCK_STREAM)
        cl.settimeout(2)
        try:
            cl.connect(("127.0.0.1", srv.getsockname()[1]))
            G("localhost", 80)
        except Exception:  # noqa: BLE001
            pass
        finally:
            cl.close()
            srv.close()
        yield from ITEMS


def factory(config):
    return RS6b(config)
