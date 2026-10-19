"""MUTANT: keeps its own table (sqlite3 is in the standard library, so it is imported already)."""
import os
import sqlite3
import tempfile

from connector_kit import Connector

from ._base import ITEMS


class TableWriterSqlite(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        path = os.path.join(tempfile.gettempdir(), "connector-kit-mutant-sources.db")
        try:
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE IF NOT EXISTS sources (content TEXT)")
            db.execute("INSERT INTO sources VALUES ('direct')")
            db.commit()
            db.close()
        except Exception:  # noqa: BLE001
            pass
        yield from ITEMS


def factory(config):
    return TableWriterSqlite(config)
