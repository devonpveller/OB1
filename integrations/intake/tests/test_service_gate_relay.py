"""intake-gate-relay: the search gate's way in (DESIGN-intake section 12 item 10, R2-F4, for the
first caller). Every class here failed on OB1 bc6d3a6 (journal/evidence/intake-gate-relay/red/).

The gate (search-gateway, search plane) reaches openbrain-intake:8000 through a THIRD fixed-target
byte relay, openbrain-intake-callrelay, on intake-net and on `intake-callers` - an internal network
the search plane declares and this plane joins as external. The service keeps exactly one
network; intake-net keeps only the service and its relays; the relay is hardened exactly as the
two i5b relays are. The reachability and end-to-end clauses run in the lab
(search/gateway/tests/docker/run_gate_relay_e2e.py in ai-stack); the cross-plane render check is
ai-stack's scripts/checks/check_intake_isolation.py.
"""
import unittest
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
COMPOSE = HERE.parents[2] / "docker" / "docker-compose.yml"
RELAYS = ("openbrain-intake-dbrelay", "openbrain-intake-llmrelay")
CALL = "openbrain-intake-callrelay"
# the keys that ARE the relay hardening; each must be identical across the three relays
SAME = ("image", "command", "user", "read_only", "security_opt", "cap_drop", "sysctls", "profiles",
        "restart", "deploy")


def _compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


class CallRelayShape(unittest.TestCase):
    def setUp(self):
        self.d = _compose()
        self.assertIn(CALL, self.d["services"], "no call relay in the compose file")
        self.r = self.d["services"][CALL]

    def test_it_forwards_one_port_to_the_service_and_nothing_else(self):
        env = self.r["environment"]
        self.assertEqual((env["INTAKE_RELAY_TARGET_HOST"], env["INTAKE_RELAY_TARGET_PORT"],
                          env["INTAKE_RELAY_LISTEN_PORT"]), ("openbrain-intake", "8000", "8000"))
        self.assertEqual(self.r["command"], ["relay"])

    def test_it_is_on_intake_net_and_intake_callers_only_with_no_alias(self):
        nets = self.r["networks"]
        self.assertEqual(set(nets), {"intake-net", "intake-callers"})
        # no alias anywhere: an alias `openbrain-intake` on intake-callers answered the relay's OWN
        # lookup of its target in the compose lab (20/20, the relay dialled itself;
        # journal/evidence/intake-gate-relay/lab/alias-collision-measurement.txt). The gate's
        # INTAKE_URL names the relay instead (ai-stack search/docker-compose.yml).
        self.assertIsInstance(nets, list, "a plain list of networks: no per-network aliases")

    def test_it_publishes_no_port_and_holds_no_secret(self):
        self.assertNotIn("ports", self.r)
        self.assertNotIn("expose", self.r)
        self.assertNotIn("secrets", self.r)
        self.assertNotIn("env_file", self.r)
        self.assertNotIn("volumes", self.r)

    def test_intake_callers_is_the_search_planes_network_joined_as_external(self):
        n = self.d["networks"]["intake-callers"]
        self.assertEqual(n, {"external": True, "name": "search_intake-callers"})

    def test_an_idle_close_is_set(self):
        idle = float(self.r["environment"]["INTAKE_RELAY_IDLE_SECONDS"])
        # above the gate's INTAKE_TIMEOUT_SECONDS default (60 s, search/gateway config.py)
        self.assertGreater(idle, 60)


class CallRelayHardeningEqualsTheI5bRelays(unittest.TestCase):
    def test_every_hardening_key_is_identical_to_both_existing_relays(self):
        s = _compose()["services"]
        self.assertIn(CALL, s)
        for key in SAME:
            for other in RELAYS:
                with self.subTest(key=key, relay=other):
                    self.assertEqual(s[CALL].get(key), s[other].get(key))

    def test_the_hardening_itself(self):
        r = _compose()["services"].get(CALL) or {}
        self.assertIs(r.get("read_only"), True)
        self.assertEqual(r.get("cap_drop"), ["ALL"])
        self.assertIn("no-new-privileges:true", r.get("security_opt") or [])
        self.assertEqual(str((r.get("sysctls") or {}).get("net.ipv4.ip_forward")), "0")
        self.assertEqual(r.get("user"), "10030:10030")

    def test_its_healthcheck_is_a_connect_to_its_own_listen_port(self):
        r = _compose()["services"].get(CALL) or {}
        test = (r.get("healthcheck") or {}).get("test") or []
        self.assertIn("('127.0.0.1', 8000)", " ".join(test))


class IsolationKept(unittest.TestCase):
    def test_intake_net_members_are_exactly_the_service_and_its_three_relays(self):
        s = _compose()["services"]
        members = {n for n, svc in s.items() if "intake-net" in (svc.get("networks") or [])}
        self.assertEqual(members, {"openbrain-intake", *RELAYS, CALL})

    def test_the_service_keeps_exactly_one_network(self):
        self.assertEqual(list(_compose()["services"]["openbrain-intake"]["networks"]), ["intake-net"])

    def test_only_the_call_relay_joins_intake_callers_in_this_plane(self):
        s = _compose()["services"]
        members = {n for n, svc in s.items() if "intake-callers" in (svc.get("networks") or [])}
        self.assertEqual(members, {CALL})

    def test_the_service_does_not_depend_on_the_call_relay(self):
        # the service starts whether or not a caller can reach it (its caller path is not its engine)
        dep = _compose()["services"]["openbrain-intake"].get("depends_on") or {}
        self.assertNotIn(CALL, dep)


if __name__ == "__main__":
    unittest.main()
