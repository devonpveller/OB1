"""THE PROOF: every mutant connector FAILS conformance, and fails it on the rule it breaks.

Each mutant (connector_tests/mutants/) breaks one rule of the contract; the conformance runner is
run on it exactly as on a real connector. A mutant that passes - or that fails only on some other
test - means the kit does not check that rule. The acceptance names four classes (a non-envelope,
a table write, a socket to a non-allowed host, a logged key); the rest close the obvious ways
around those four.
"""
import unittest

import connector_tests  # noqa: F401 - sys.path

from connector_kit.testkit import conformance

# mutant module -> (the class of rule it breaks, the contract tests that MUST fail for it)
MUTANTS = {
    # posts a non-envelope
    "m_non_envelope_items": ("non-envelope", {"test_sends_only_valid_envelopes"}),
    "m_client_bypass": ("non-envelope", {"test_sends_only_valid_envelopes"}),
    "m_direct_post": ("non-envelope", {"test_sends_only_valid_envelopes", "test_network_only_allowed_hosts",
                                       "test_static_scan"}),
    "m_override_run": ("non-envelope", {"load"}),
    # writes a table
    "m_table_writer_pg": ("table write", {"test_no_table_writes_or_model_calls", "test_static_scan"}),
    "m_table_writer_sqlite": ("table write", {"test_no_table_writes_or_model_calls", "test_static_scan"}),
    # opens a socket to a non-allowed host (a DB, a model, the web)
    "m_socket_db": ("socket", {"test_network_only_allowed_hosts", "test_static_scan"}),
    "m_socket_ip": ("socket", {"test_network_only_allowed_hosts", "test_static_scan"}),
    "m_model_call": ("socket", {"test_network_only_allowed_hosts", "test_static_scan"}),
    "m_subprocess_fetch": ("socket", {"test_no_table_writes_or_model_calls", "test_static_scan"}),
    "m_gate_host": ("socket", {"load"}),
    # logs (or leaks) its key
    "m_key_logger": ("key", {"test_no_secret_in_logs"}),
    "m_key_stderr": ("key", {"test_no_secret_in_logs"}),
    "m_key_in_metadata": ("key", {"test_no_secret_in_logs"}),
    # an unstable item id
    "m_unstable_id": ("idempotency", {"test_idempotency_key"}),
    # round 2: the reviewer's six (reviews/connector-template.md, r-conn) that passed round 1
    "m_r_s6b_from_c_socket": ("socket", {"test_static_scan"}),
    "m_r_s7_c_spawn": ("socket", {"test_static_scan"}),
    "m_r_t4b_c_sqlite": ("table write", {"test_static_scan"}),
    "m_r_k1_private_logger": ("key", {"test_no_secret_in_logs"}),
    "m_r_k7_real_stderr": ("key", {"test_no_secret_in_logs"}),
    "m_r_k10_fd2": ("key", {"test_no_secret_in_logs"}),
}


class Mutants(unittest.TestCase):
    def test_every_mutant_fails_conformance_on_its_rule(self):
        verdicts = {}
        for name, (_rule, must_fail) in MUTANTS.items():
            with self.subTest(mutant=name):
                v = conformance.run_spec(f"connector_tests.mutants.{name}:factory")
                verdicts[name] = v
                self.assertFalse(v.passed, f"{name} PASSED conformance: the kit does not check its rule")
                if must_fail == {"load"}:
                    self.assertIsNotNone(v.load_error, f"{name} should be refused when its class is created")
                    self.assertIn("TypeError", v.load_error)
                else:
                    self.assertIsNone(v.load_error, v.load_error)
                    missing = must_fail - set(v.failed)
                    self.assertEqual(missing, set(), f"{name}: these tests did not fail: {missing}; "
                                                     f"results {v.results}")
        classes = {r for r, _ in MUTANTS.values()}
        self.assertLessEqual({"non-envelope", "table write", "socket", "key"}, classes)

    def test_the_reference_connector_is_the_control(self):
        v = conformance.run_spec("connector_tests.reference_factories:fixture_connector",
                                 "connector_tests.reference_factories:oversize_connector")
        self.assertTrue(v.passed, v.to_dict())


if __name__ == "__main__":
    unittest.main()
