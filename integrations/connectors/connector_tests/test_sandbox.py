"""Round 2 (review B1): the C modules behind the blocked ones are refused by the static scan AND by
the run-time import guard; the standard library itself may still use them."""
import unittest

import connector_tests  # noqa: F401 - sys.path

from connector_kit.testkit import static_scan
from connector_kit.testkit.sandbox import C_BACKENDS, Sandbox

REQUIRED = {"_socket", "_ssl", "_winapi", "_posixsubprocess", "_overlapped", "_ctypes", "_sqlite3",
            "_multiprocessing", "_asyncio"}


class CBackends(unittest.TestCase):
    def test_the_list_holds_the_reviewers_set(self):
        self.assertLessEqual(REQUIRED, set(C_BACKENDS))

    def test_the_static_scan_refuses_each(self):
        for mod in sorted(REQUIRED):
            for src in (f"import {mod}\n", f"from {mod} import x\n", f"import {mod} as y\n"):
                with self.subTest(src=src):
                    kinds = [f.kind for f in static_scan.scan_source(src)]
                    self.assertIn("import", kinds)

    def test_the_runtime_guard_refuses_each_from_connector_code(self):
        for mod in sorted(REQUIRED):
            with self.subTest(mod=mod):
                g = {"__name__": "some_connector.module"}
                with Sandbox(own_modules=("some_connector",)) as sb:
                    with self.assertRaises(ImportError):
                        exec(f"import {mod}", g)  # noqa: S102 - the import a connector would run
                self.assertTrue(any(v.kind == "import" and mod in v.detail for v in sb.violations), sb.violations)

    def test_the_standard_library_may_still_import_them(self):
        g = {"__name__": "socket"}          # an importer that IS a stdlib module
        with Sandbox() as sb:
            exec("import _socket", g)  # noqa: S102
        self.assertEqual(sb.violations, [])


if __name__ == "__main__":
    unittest.main()
