"""Retention values are config (operator D27, 2026-10-15): 30 d clean bronze, 365 d discard
records, 24 h second-opinion wait cap. I1 ships them as constants only; the purge jobs that
read them are I4."""
import os
import unittest
from unittest import mock

from intake import config


class RetentionDefaults(unittest.TestCase):
    def test_operator_values(self):
        self.assertEqual(config.BRONZE_RETENTION_DAYS, 30)
        self.assertEqual(config.DISCARD_RETENTION_DAYS, 365)
        self.assertEqual(config.SECOND_OPINION_MAX_WAIT_HOURS, 24)

    def test_retention_reads_defaults_without_env(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            r = config.retention()
        self.assertEqual(r, config.Retention(30, 365, 24))

    def test_env_override(self):
        env = {"INTAKE_BRONZE_RETENTION_DAYS": "7",
               "INTAKE_DISCARD_RETENTION_DAYS": "400",
               "INTAKE_SECOND_OPINION_MAX_WAIT_HOURS": "12"}
        with mock.patch.dict(os.environ, env, clear=True):
            r = config.retention()
        self.assertEqual(r, config.Retention(7, 400, 12))

    def test_env_garbage_is_refused_not_defaulted(self):
        # A typo must not silently become "keep forever" or "keep nothing".
        for bad in ("", "0", "-1", "30d", "1e3", " 30", "3.5"):
            with self.subTest(bad=bad):
                with mock.patch.dict(os.environ, {"INTAKE_BRONZE_RETENTION_DAYS": bad}, clear=True):
                    with self.assertRaises(ValueError):
                        config.retention()


if __name__ == "__main__":
    unittest.main()
