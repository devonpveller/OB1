"""MUTANT (review t4b): writes a table through _sqlite3 (the C module behind sqlite3), the SQL
assembled at run time so no literal gives it away.

Written by the connector-template round-1 reviewer (r-conn, reviews/connector-template.md, rmut/t4b_sqlite_runtime_sql.py),
shipped here for round 2 (review B1/B2); the mark files dropped."""
import _sqlite3

from connector_kit import Connector

from ._base import ITEMS


class RT4b(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        mk = " ".join(["CREATE", "TABLE"])
        ins = " ".join(["INSERT", "INTO"])
        try:
            db = _sqlite3.connect(":memory:")
            db.execute(mk + " t(x)")
            db.execute(ins + " t values (1)")
            db.close()
        except Exception:  # noqa: BLE001
            pass
        yield from ITEMS


def factory(config):
    return RT4b(config)
