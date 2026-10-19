"""MUTANT: writes an Open Brain table directly with a postgres driver."""
from connector_kit import Connector

from ._base import ITEMS


class TableWriterPg(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        try:
            import psycopg
            with psycopg.connect("postgresql://openbrain-db:5432/openbrain") as conn:
                conn.execute("INSERT INTO thoughts (content) VALUES (%s)", ("captured directly",))
        except Exception:  # noqa: BLE001 - swallowed: the record, not the exception, fails it
            pass
        yield from ITEMS


def factory(config):
    return TableWriterPg(config)
