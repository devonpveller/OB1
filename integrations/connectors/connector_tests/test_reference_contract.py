"""The reference connector passes the whole contract, through the test-case mixin AND through the
conformance runner (in-process and as the CLI), and its own CLI behaves per outcome."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import connector_tests  # noqa: F401 - sys.path
from connector_tests import reference_factories as rf

from connector_kit.testkit import conformance
from connector_kit.testkit.contract import ConnectorContract
from connector_kit.testkit.fake_intake import FakeIntake

KEY = "rf-" + "4d" * 20


class ReferenceContract(ConnectorContract, unittest.TestCase):
    def make_connector(self, config):
        return rf.fixture_connector(config)

    def make_oversize_connector(self, config):
        return rf.oversize_connector(config)


class ReferenceConformance(unittest.TestCase):
    def test_the_runner_passes_it(self):
        v = conformance.run(rf.fixture_connector, rf.oversize_connector)
        self.assertTrue(v.passed, v.to_dict())
        self.assertEqual(set(v.results), set(conformance.TESTS))
        self.assertEqual(len(conformance.TESTS), 9)

    def test_the_runner_cli(self):
        r = subprocess.run([sys.executable, "-m", "connector_kit.testkit.conformance",
                            "connector_tests.reference_factories:fixture_connector",
                            "connector_tests.reference_factories:oversize_connector", "--json"],
                           cwd=str(connector_tests.CONNECTORS_DIR), capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(json.loads(r.stdout)["passed"])


class ReferenceCLI(unittest.TestCase):
    def cli(self, fake, *args, stdin=None, key=KEY):
        with tempfile.TemporaryDirectory() as d:
            kf = os.path.join(d, "key")
            with open(kf, "w", encoding="ascii") as fh:
                fh.write(key)
            r = subprocess.run([sys.executable, "-m", "reference", "--intake-url", fake.url, "--key-file", kf,
                                "--max-attempts", "2", *args], cwd=str(connector_tests.CONNECTORS_DIR),
                               input=stdin, capture_output=True, timeout=120)
        out = r.stdout.decode("utf-8", "replace")
        err = r.stderr.decode("utf-8", "replace")
        self.assertNotIn(key, out + err, "the key is printed")
        return r.returncode, (json.loads(out) if out.strip().startswith("{") else None), err

    def test_a_directory_of_files(self):
        with FakeIntake({"reference-file": KEY}) as fake:
            code, rep, _ = self.cli(fake, "--input", str(rf.FIXTURES))
        self.assertEqual(code, 0)
        self.assertEqual(rep["counts"], {"clean": 5})
        self.assertEqual(sorted(i["external_id"] for i in rep["items"]),
                         ["file/beans.html", "file/harvest.json", "file/note.txt", "file/seeds.eml", "file/soil.md"])
        types = sorted(r.envelope["content_type"] for r in fake.received)
        self.assertEqual(types, ["application/json", "message/rfc822", "text/html", "text/markdown", "text/plain"])
        self.assertFalse({"text", "title", "links"} & set(rep["items"][0]), "no screened text in the report")

    def test_stdin(self):
        with FakeIntake({"reference-file": KEY}) as fake:
            code, rep, _ = self.cli(fake, "--input", "-", "--external-id", "stdin/note-1", "--content-type",
                                    "text/markdown", stdin=b"# from stdin\n")
            env = fake.received[0].envelope
        self.assertEqual(code, 0)
        self.assertEqual((env["external_id"], env["content_type"]), ("stdin/note-1", "text/markdown"))
        self.assertEqual(env["metadata"]["provenance"]["origin"], "stdin")

    def test_exit_codes_per_outcome(self):
        with FakeIntake({"reference-file": KEY}, default=403) as fake:
            code, rep, _ = self.cli(fake, "--input", str(rf.FIXTURES))
            self.assertEqual((code, len(fake.received), rep["items"][0]["result"]), (3, 1, "stop"))
        with FakeIntake({"reference-file": KEY}, default=503) as fake:
            code, rep, _ = self.cli(fake, "--input", str(rf.FIXTURES))
            self.assertEqual((code, len(fake.received), rep["items"][0]["result"]), (4, 2, "deferred"))
        with FakeIntake({"reference-file": KEY}) as fake:
            code, rep, err = self.cli(fake, "--input", str(rf.FIXTURES), key="short")
            self.assertEqual((code, rep, len(fake.received)), (2, None, 0))
            self.assertIn("key file", err)


if __name__ == "__main__":
    unittest.main()
