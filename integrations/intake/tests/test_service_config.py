"""I5 service configuration: read ONCE at start-up, and an invalid value refuses the start
(I4 review R3-T2/R3-T3: the D40 policy point is validated at service start, not per call; the
policy the service uses is the configured one, never d2's default)."""
import unittest

from tests import service_support as ss

from intake import d2
from intake_service import settings


class Refusals(unittest.TestCase):
    def assertRefused(self, env, needle):
        with self.assertRaises(settings.ConfigError) as cm:
            settings.load(env)
        self.assertIn(needle, str(cm.exception))
        for s in ss.SECRETS:
            self.assertNotIn(s, str(cm.exception), "a refusal must not print a secret")

    def test_the_defaults_load(self):
        s = settings.load(ss.base_env())
        self.assertEqual(s.policy, d2.Policy("clean"))
        self.assertEqual(s.workers, 1)
        self.assertEqual(s.listen_port, 8000)
        self.assertEqual(s.db_user, "intake")
        self.assertEqual(sorted(s.callers.connectors), ["mcp", "research"])

    def test_d40_policy_is_read_once_and_refused_when_bad(self):
        self.assertEqual(settings.load(ss.base_env(INTAKE_D2_WEAK_RULE_JUDGE_CLEAN="suspicious")).policy,
                         d2.Policy("suspicious"))
        for bad in ("Clean", "", "yes", "clean "):
            with self.subTest(bad=bad):
                self.assertRefused(ss.base_env(INTAKE_D2_WEAK_RULE_JUDGE_CLEAN=bad),
                                   "INTAKE_D2_WEAK_RULE_JUDGE_CLEAN")

    def test_library_settings_are_validated_at_start(self):
        self.assertRefused(ss.base_env(INTAKE_BRONZE_RETENTION_DAYS="0"), "INTAKE_BRONZE_RETENTION_DAYS")
        self.assertRefused(ss.base_env(INTAKE_CLASSIFIER_THRESHOLD="2"), "INTAKE_CLASSIFIER_THRESHOLD")
        self.assertRefused(ss.base_env(INTAKE_SECOND_OPINION_MAX_ATTEMPTS="0"),
                           "INTAKE_SECOND_OPINION_MAX_ATTEMPTS")
        self.assertRefused(ss.base_env(INTAKE_CLASSIFIER_WORKERS="0"), "INTAKE_CLASSIFIER_WORKERS")

    def test_caller_keys_are_required_and_well_formed(self):
        self.assertRefused(ss.base_env(INTAKE_CALLER_KEYS=None), "INTAKE_CALLER_KEYS")
        self.assertRefused(ss.base_env(INTAKE_CALLER_KEYS=""), "INTAKE_CALLER_KEYS")
        long_key = "k" * 40
        for bad, why in (("research", "connector=key"),
                         ("Research=" + long_key, "connector"),
                         ("research=short", "at least"),
                         ("research=" + long_key + ",mcp=" + long_key, "twice"),
                         ("research=" + long_key + ",research=" + "j" * 40, "twice"),
                         ("research=" + "k" * 30 + " " + "k" * 9, "printable")):
            with self.subTest(bad=why):
                self.assertRefused(ss.base_env(INTAKE_CALLER_KEYS=bad), "INTAKE_CALLER_KEYS")

    def test_db_password_is_required(self):
        self.assertRefused(ss.base_env(INTAKE_DB_PASSWORD=None), "INTAKE_DB_PASSWORD")
        self.assertRefused(ss.base_env(INTAKE_DB_PASSWORD=""), "INTAKE_DB_PASSWORD")

    def test_service_limits_are_refused_out_of_range(self):
        for name, bad in (("INTAKE_LISTEN_PORT", "0"), ("INTAKE_LISTEN_PORT", "70000"),
                          ("INTAKE_MAX_REQUEST_BYTES", "10"), ("INTAKE_MAX_REQUEST_BYTES", "999999999"),
                          ("INTAKE_WALL_STAGES_SECONDS", "0"), ("INTAKE_WALL_STAGES_SECONDS", "abc"),
                          ("INTAKE_SO_CONCURRENCY", "0"), ("INTAKE_SO_CONCURRENCY", "65"),
                          ("INTAKE_PURGE_INTERVAL_SECONDS", "-1"), ("INTAKE_DB_PORT", "x"),
                          ("INTAKE_LOG_LEVEL", "LOUD")):
            with self.subTest(name=name, bad=bad):
                self.assertRefused(ss.base_env(**{name: bad}), name)

    def test_no_secret_in_the_repr(self):
        s = settings.load(ss.base_env())
        text = repr(s) + str(s) + repr(s.callers) + repr(s.db_password)
        for secret in ss.SECRETS:
            self.assertNotIn(secret, text)

    def test_unset_second_opinion_key_is_reported_not_refused(self):
        s = settings.load(ss.base_env(INTAKE_SECOND_OPINION_KEY=None))
        self.assertFalse(s.second_opinion_key_set)


class CallerKeyMatch(unittest.TestCase):
    def test_match_names_the_connector_and_nothing_else_matches(self):
        keys = settings.load(ss.base_env()).callers
        self.assertEqual(keys.match(ss.CALLER_KEYS["research"]), "research")
        self.assertEqual(keys.match(ss.CALLER_KEYS["mcp"]), "mcp")
        for wrong in ("", "x", ss.CALLER_KEYS["research"][:-1], ss.CALLER_KEYS["research"] + "x",
                      ss.CALLER_KEYS["research"].upper(), ss.DB_PASSWORD):
            self.assertIsNone(keys.match(wrong))


if __name__ == "__main__":
    unittest.main()
