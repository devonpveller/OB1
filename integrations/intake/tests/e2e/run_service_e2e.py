"""The I5 end-to-end run: the service IMAGE against a throwaway postgres carrying the I1 migration
and a fake LiteLLM, on internal networks this script creates and removes.

    python tests/e2e/run_service_e2e.py --image openbrain-intake:wt-intake-i5 --model-dir <verified dir>
           --out <evidence dir> [--label intake-i5] [--keep]

TOPOLOGY (mirrors docker/docker-compose.yml, profile intake; every network INTERNAL, subnets in
10.243.200-209.0/24, labelled ai-stack.test=<label>; never an ai-stack_* network):
  <p>-ob      postgres (alias openbrain-db) + the relay
  <p>-intake  the relay (alias openbrain-intake-dbrelay) + the service (alias openbrain-intake)
              + the client
  <p>-llm     the service + the fake LiteLLM (alias llama-cpp)
The postgres is pgvector/pgvector:pg16 initialised by the SAME initdb chain the compose file
mounts (every `docker-entrypoint-initdb.d` line of docker/docker-compose.yml, in order, ending
with 220-init-intake.sql); then the intake role gets a password.

WHAT IT CHECKS (acceptance lines 1-3; the verdict file is <out>/e2e-results.json):
  A  container: uid 10030, read-only root FS, cap_drop ALL, no-new-privileges (docker inspect);
     egress: from inside the service an outside host (1.1.1.1:443, 9.9.9.9:53, a DNS name,
     http://example.com) FAILS, the relay (5432) and llama-cpp (8080) succeed, the postgres
     container itself is not reachable directly
  B  start refusals: invalid D40 value -> exit 2; no caller keys -> exit 2; tampered weights
     (one byte flipped in a copy of model.safetensors) -> exit 3; each with --network none
  C  auth/limits over HTTP: no key 401, wrong key 403, other connector's envelope 403,
     oversize 413, missing length 411
  D  every fixture class: the documented first answer and the rows (intake.items status/verdict,
     bronze present or absent, a discard record for injected); repeat; new revision
  E  the second-opinion loop on schedule: each judged item reaches its final label, the fake
     LiteLLM saw POST /v1/chat/completions with intake's key and user ob-intake
  F  the purge on schedule: aged rows inserted as postgres are deleted by the service's loop
  G  slow shapes: instance K (INTAKE_WALL_STAGES_SECONDS=0.001) - EVERY shape killed at the wall
     clock -> pending (transient error, no text, a pending row with the error); response time per
     shape; the worker replaced and a later request served. Instance A (production limits) - each
     shape's answer and time (none may be `clean` by way of an error)
  H  no secret in any container log (caller keys, the DB password, the judge key, the postgres
     password)
Every container and network is removed in `finally` (unless --keep).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
INTAKE_DIR = HERE.parent.parent
OB1_DOCKER = INTAKE_DIR.parent.parent / "docker"
PG_IMAGE = "pgvector/pgvector:pg16"
SUBNETS = {"ob": "10.243.201.0/24", "intake": "10.243.202.0/24", "llm": "10.243.203.0/24"}


def sh(*args, check=True, timeout=600, input_=None):
    r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=input_,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:3])}... exit {r.returncode}: {r.stderr.strip()[:500]}")
    return r


class Run:
    def __init__(self, a):
        self.a = a
        self.p = "i5e2e-" + secrets.token_hex(3)
        self.label = f"ai-stack.test={a.label}"
        self.out = Path(a.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="i5e2e-"))
        self.containers: list[str] = []
        self.networks: list[str] = []
        self.results: dict = {"checks": [], "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.keys = {"research": "rk-" + secrets.token_hex(20), "mcp": "mk-" + secrets.token_hex(20)}
        self.db_pw = "dbpw-" + secrets.token_hex(12)
        self.pg_pw = "pgpw-" + secrets.token_hex(12)
        self.so_key = "sk-e2e-" + secrets.token_hex(16)

    # -- bookkeeping ------------------------------------------------------------------------------
    def check(self, name, ok, detail=""):
        self.results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"  [{'OK' if ok else 'FAIL'}] {name}{(' - ' + str(detail)[:300]) if detail and not ok else ''}",
              flush=True)

    def save(self):
        (self.out / "e2e-results.json").write_text(json.dumps(self.results, indent=1, default=str), encoding="utf-8")

    # -- infrastructure ---------------------------------------------------------------------------
    def net(self, key):
        name = f"{self.p}-{key}"
        assert not name.startswith("ai-stack_")
        sh("network", "create", "--internal", "--subnet", SUBNETS[key], "--label", self.label, name)
        self.networks.append(name)
        return name

    def container(self, name, image, *args, nets=(), aliases=(), env=None, cmd=(), entrypoint=None, start=True):
        cname = f"{self.p}-{name}"
        argv = ["create", "--name", cname, "--label", self.label]
        first = nets[0] if nets else "none"
        argv += ["--network", first]
        if nets:
            for al in aliases:
                argv += ["--network-alias", al]
        for k, v in (env or {}).items():
            argv += ["-e", f"{k}={v}"]
        if entrypoint:
            argv += ["--entrypoint", entrypoint]
        argv += [*args, image, *cmd]
        sh(*argv)
        self.containers.append(cname)
        for n in nets[1:]:
            extra = []
            for al in aliases:
                extra += ["--alias", al]
            sh("network", "connect", *extra, n, cname)
        if start:
            sh("start", cname)
        return cname

    def psql(self, sql):
        r = sh("exec", "-e", f"PGPASSWORD={self.pg_pw}", f"{self.p}-pg", "psql", "-U", "postgres", "-d", "openbrain",
               "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql)
        return [line.split("\t") for line in r.stdout.strip().splitlines() if line]

    def initdb_mounts(self):
        """Every initdb mount of openbrain-db in docker/docker-compose.yml, in order."""
        text = (OB1_DOCKER / "docker-compose.yml").read_text(encoding="utf-8")
        out = []
        for m in re.finditer(r"-\s+(\S+?):/docker-entrypoint-initdb\.d/(\S+?):ro", text):
            src = (OB1_DOCKER / m.group(1)).resolve()
            out.append((src, m.group(2)))
        assert out and out[-1][1] == "220-init-intake.sql", out[-3:]
        return out

    def exec_py(self, cname, code, timeout=60):
        return sh("exec", cname, "python", "-c", code, check=False, timeout=timeout)

    def client(self, plan, name, timeout=3600):
        pf = self.work / f"{name}.plan.json"
        pf.write_text(json.dumps(plan), encoding="utf-8")
        of = self.work / f"{name}.out.json"
        if of.exists():
            of.unlink()
        cname = f"{self.p}-client-{name}"
        sh("run", "--rm", "--name", cname, "--label", self.label, "--network", f"{self.p}-intake",
           "--entrypoint", "python", "-e", "PYTHONPATH=/e2e:/app", "-e", f"INTAKE_E2E_HOST={plan[0].get('host', 'openbrain-intake')}",
           "-v", f"{INTAKE_DIR / 'tests'}:/e2e/tests:ro", "-v", f"{self.work}:/work",
           "--user", "10030:10030", self.a.image, "/e2e/tests/e2e/client.py", f"/work/{pf.name}", f"/work/{of.name}",
           timeout=timeout)
        return {s["name"]: s for s in json.loads(of.read_text(encoding="utf-8"))}

    def service(self, name, alias, extra_env=None):
        env = {"INTAKE_DB_HOST": "openbrain-intake-dbrelay", "INTAKE_DB_PASSWORD": self.db_pw,
               "INTAKE_CALLER_KEYS": ",".join(f"{c}={k}" for c, k in self.keys.items()),
               "INTAKE_SECOND_OPINION_KEY": self.so_key, "INTAKE_SO_INTERVAL_SECONDS": "2",
               "INTAKE_RESCREEN_INTERVAL_SECONDS": "3", "INTAKE_PURGE_INTERVAL_SECONDS": "5",
               "INTAKE_SECOND_OPINION_BACKOFF_BASE_SECONDS": "1", "INTAKE_SECOND_OPINION_BACKOFF_CAP_SECONDS": "2",
               "INTAKE_SECOND_OPINION_MAX_ATTEMPTS": "2", "INTAKE_CLASSIFIER_THREADS": "4", "HOME": "/tmp",
               # long, so a killed row stays as the kill left it for part G's row check (the
               # re-screen loop itself is unit-tested: tests/test_service_core.Rescreen)
               "INTAKE_RESCREEN_BACKOFF_SECONDS": "86400"}
        env.update(extra_env or {})
        return self.container(name, self.a.image, *self.hardening(), "--tmpfs", "/tmp:noexec,nosuid,size=64m",
                              "-v", f"{self.a.model_dir}:/models:ro", "--memory", "4g", "--pids-limit", "256",
                              nets=(f"{self.p}-intake", f"{self.p}-llm"), aliases=(alias,), env=env, cmd=("serve",))

    @staticmethod
    def hardening():
        return ["--user", "10030:10030", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"]

    # -- the run ----------------------------------------------------------------------------------
    def go(self):
        a = self.a
        print(f"e2e prefix {self.p}, image {a.image}", flush=True)
        for k in SUBNETS:
            self.net(k)
        mounts = []
        for src, slot in self.initdb_mounts():
            mounts += ["-v", f"{src}:/docker-entrypoint-initdb.d/{slot}:ro"]
        self.container("pg", PG_IMAGE, *mounts, nets=(f"{self.p}-ob",), aliases=("openbrain-db",),
                       env={"POSTGRES_DB": "openbrain", "POSTGRES_USER": "postgres", "POSTGRES_PASSWORD": self.pg_pw})
        self.container("llm", "python:3.13-slim", "-v", f"{HERE / 'fake_litellm.py'}:/fake.py:ro",
                       nets=(f"{self.p}-llm",), aliases=("llama-cpp",), cmd=("python", "/fake.py"))
        end = time.time() + 300
        while time.time() < end:
            r = sh("exec", f"{self.p}-pg", "pg_isready", "-U", "postgres", "-d", "openbrain", check=False)
            if r.returncode == 0 and sh("logs", f"{self.p}-pg", check=False).stderr.count("database system is ready") >= 2:
                break
            time.sleep(2)
        self.psql(f"ALTER ROLE intake PASSWORD '{self.db_pw}'")
        tables = self.psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'intake'")
        self.check("postgres carries the I1 migration (schema intake)", int(tables[0][0]) >= 4, tables)
        self.container("relay", a.image, *self.hardening(), nets=(f"{self.p}-ob", f"{self.p}-intake"),
                       aliases=("openbrain-intake-dbrelay",), env={"INTAKE_RELAY_TARGET_HOST": "openbrain-db"},
                       cmd=("relay",))
        svc = self.service("svc", "openbrain-intake")
        r = self.client([{"name": "healthz", "wait_healthz": 300}], "boot")
        self.check("the service starts and /healthz is 200 (worker loaded, db through the relay)",
                   r["healthz"].get("status") == 200, r["healthz"])
        self.results["healthz"] = r["healthz"]
        self.part_a(svc)
        self.part_b()
        self.part_c()
        self.part_d_e()
        self.part_f()
        self.part_g()
        self.part_h()

    def part_a(self, svc):
        info = json.loads(sh("inspect", svc).stdout)[0]
        hc = info["HostConfig"]
        uid = sh("exec", svc, "id", "-u").stdout.strip()
        self.check("A non-root: uid 10030", uid == "10030", uid)
        self.check("A read-only root FS", hc.get("ReadonlyRootfs") is True)
        self.check("A cap_drop ALL", hc.get("CapDrop") == ["ALL"], hc.get("CapDrop"))
        self.check("A no-new-privileges", "no-new-privileges:true" in (hc.get("SecurityOpt") or []))
        w = self.exec_py(svc, "open('/app/x','w')")
        self.check("A the root FS refuses a write", w.returncode != 0, w.stderr[-200:])
        probes = {
            "tcp 1.1.1.1:443": "import socket; socket.create_connection(('1.1.1.1', 443), 5)",
            "tcp 9.9.9.9:53": "import socket; socket.create_connection(('9.9.9.9', 53), 5)",
            "dns example.com": "import socket; socket.getaddrinfo('example.com', 80)",
            "http://example.com": "import urllib.request; urllib.request.urlopen('http://example.com', timeout=5)",
            "the postgres container directly": f"import socket; socket.create_connection(('{self.p}-pg', 5432), 5)",
        }
        egress = {}
        for name, code in probes.items():
            r = self.exec_py(svc, code, timeout=40)
            egress[name] = {"exit": r.returncode, "error": r.stderr.strip().splitlines()[-1:] or ""}
            self.check(f"A outbound blocked: {name} fails", r.returncode != 0, egress[name])
        for name, code in (("relay openbrain-intake-dbrelay:5432",
                            "import socket; socket.create_connection(('openbrain-intake-dbrelay', 5432), 5)"),
                           ("LiteLLM alias llama-cpp:8080",
                            "import urllib.request; urllib.request.urlopen('http://llama-cpp:8080/health/liveliness', timeout=5)")):
            r = self.exec_py(svc, code, timeout=40)
            egress[name] = {"exit": r.returncode}
            self.check(f"A allowed host reachable: {name}", r.returncode == 0, r.stderr[-300:])
        self.results["egress"] = egress

    def refusal(self, name, env, expect, model_dir=None):
        cname = f"{self.p}-refuse-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
        base = {"INTAKE_DB_PASSWORD": self.db_pw, "INTAKE_CALLER_KEYS": f"research={self.keys['research']}",
                "INTAKE_SECOND_OPINION_KEY": self.so_key, "HOME": "/tmp"}
        base.update(env)
        argv = ["run", "--name", cname, "--label", self.label, "--network", "none", *self.hardening(),
                "--tmpfs", "/tmp:size=64m", "-v", f"{model_dir or self.a.model_dir}:/models:ro"]
        for k, v in base.items():
            if v is not None:
                argv += ["-e", f"{k}={v}"]
        t0 = time.monotonic()
        self.containers.append(cname)
        r = sh(*argv, self.a.image, "serve", check=False, timeout=600)
        logs = sh("logs", cname, check=False)
        text = logs.stdout + logs.stderr
        self.check(f"B {name}: refuses to start with exit {expect}", r.returncode == expect,
                   f"exit {r.returncode}; {text.strip().splitlines()[-1:] if text.strip() else ''}")
        self.results.setdefault("refusals", {})[name] = {"exit": r.returncode, "seconds": round(time.monotonic() - t0, 2),
                                                        "last_log": text.strip().splitlines()[-2:]}
        return text

    def part_b(self):
        self.refusal("invalid D40 (INTAKE_D2_WEAK_RULE_JUDGE_CLEAN=maybe)", {"INTAKE_D2_WEAK_RULE_JUDGE_CLEAN": "maybe"}, 2)
        self.refusal("no caller keys", {"INTAKE_CALLER_KEYS": None}, 2)
        tampered = self.work / "tampered-model"
        tampered.mkdir()
        for f in Path(self.a.model_dir).iterdir():
            shutil.copy2(f, tampered / f.name)
        p = tampered / "model.safetensors"
        with open(p, "r+b") as fh:
            fh.seek(p.stat().st_size // 2)
            b = fh.read(1)
            fh.seek(p.stat().st_size // 2)
            fh.write(bytes([b[0] ^ 1]))
        txt = self.refusal("tampered weights (one byte of model.safetensors flipped)", {}, 3, model_dir=tampered)
        self.check("B the tampered-weights refusal names the file and the pin", "model.safetensors" in txt and "pinned" in txt)
        shutil.rmtree(tampered, ignore_errors=True)

    def env_b64(self, env: dict) -> str:
        return base64.b64encode(json.dumps(env).encode()).decode()

    def part_c(self):
        good = {"source": "e2e", "connector": "research", "external_id": "auth-1",
                "fetched_at": "2026-10-18T12:00:00+00:00", "content_type": "text/plain", "raw": "auth test text"}
        other = {**good, "connector": "mcp", "external_id": "auth-2"}
        bearer = {"Authorization": "Bearer " + self.keys["research"]}
        plan = [
            {"name": "no key", "method": "POST", "path": "/v1/intake", "body_b64": self.env_b64(good)},
            {"name": "wrong key", "method": "POST", "path": "/v1/intake", "headers": {"Authorization": "Bearer " + "x" * 40},
             "body_b64": self.env_b64(good)},
            {"name": "the judge key is not a caller key", "method": "POST", "path": "/v1/intake",
             "headers": {"Authorization": "Bearer " + self.so_key}, "body_b64": self.env_b64(good)},
            {"name": "another connector's envelope", "method": "POST", "path": "/v1/intake", "headers": bearer,
             "body_b64": self.env_b64(other)},
            {"name": "oversize", "method": "POST", "path": "/v1/intake", "headers": bearer, "declare": str(9 * 1024 * 1024),
             "body_b64": base64.b64encode(b"x" * 1024).decode(), "no_body": True},
            {"name": "stats without a key", "method": "GET", "path": "/v1/stats"},
            {"name": "right key", "method": "POST", "path": "/v1/intake", "headers": bearer, "body_b64": self.env_b64(good)},
        ]
        r = self.client(plan, "auth")
        self.results["auth"] = r
        for name, code in (("no key", 401), ("wrong key", 403), ("the judge key is not a caller key", 403),
                           ("another connector's envelope", 403), ("oversize", 413), ("stats without a key", 401),
                           ("right key", 200)):
            self.check(f"C {name} -> {code}", r[name].get("status") == code, r[name])
        n = self.psql("SELECT count(*) FROM intake.items WHERE external_id = 'auth-2'")
        self.check("C nothing stored for the refused envelope", n[0][0] == "0", n)

    def part_d_e(self):
        from tests.e2e import shapes  # noqa: PLC0415 - host side, for the expectations only
        bearer = {"Authorization": "Bearer " + self.keys["research"]}
        fx = shapes.fixtures()
        plan = [{"name": n, "build": {"kind": "fixture", "id": n, "external_id": "fx-" + n}, "headers": bearer}
                for n, _r, _c, _e in fx]
        plan += [{"name": "repeat clean-plain", "build": {"kind": "fixture", "id": "clean-plain", "external_id": "fx-clean-plain"},
                  "headers": bearer},
                 {"name": "revision 2 (new raw, same id)", "build": {"kind": "fixture", "id": "clean-hidden-html",
                                                                       "external_id": "fx-clean-plain"}, "headers": bearer}]
        r = self.client(plan, "fixtures")
        self.results["fixtures"] = r
        for n, _raw, _ct, exp in fx:
            got = r[n]
            body = got.get("body") if isinstance(got.get("body"), dict) else {}
            self.check(f"D {n}: HTTP {exp['code']}, label {exp['label']}",
                       got.get("status") == exp["code"] and body.get("label") == exp["label"],
                       {k: body.get(k) for k in ("status", "label", "d2_row", "error")} | {"http": got.get("status")})
            if exp["label"] in ("pending", "injected", "rejected"):
                self.check(f"D {n}: no text returned", body.get("text") is None)
            if exp["label"] == "clean":
                self.check(f"D {n}: text returned", bool(body.get("text")))
            if exp.get("hidden_elements"):
                self.check(f"D {n}: hidden elements stripped and counted",
                           (body.get("stripped") or {}).get("hidden_elements", 0) >= 1 and "hidden payload" not in (body.get("text") or ""))
        rows = {row[0]: row[1:] for row in self.psql(
            "SELECT i.external_id, i.status, coalesce(i.verdict,''), (i.raw_item_id IS NOT NULL)::text, "
            "(SELECT count(*) FROM intake.discards d WHERE d.raw_sha256 = i.raw_sha256)::text, "
            "coalesce(i.scores->'service'->>'revision',''), coalesce(i.scores->>'needs_second_opinion','') "
            "FROM intake.items i WHERE i.external_id LIKE 'fx-%' ORDER BY i.created_at")}
        self.results["rows_after_post"] = rows
        expect_rows = {"fx-clean-plain": ("done", "clean", "true", "0"), "fx-clean-hidden-html": ("done", "clean", "true", "0"),
                       "fx-injected-tag": ("done", "injected", "false", "1"),
                       "fx-injected-chat-template": ("done", "injected", "false", "1"),
                       "fx-rejected-bomb": ("rejected", "", "false", "0")}
        for ext, want in expect_rows.items():
            got = rows.get(ext)
            self.check(f"D row {ext}: status/verdict/bronze/discards = {want}", got is not None and tuple(got[:4]) == want, got)
        self.check("D the invalid envelope wrote no row", "fx-rejected-envelope" not in rows)
        rep = r["repeat clean-plain"].get("body") or {}
        self.check("D a repeat returns the stored record (repeat=true, same id, text again)",
                   rep.get("repeat") is True and rep.get("intake_id") == r["clean-plain"]["body"].get("intake_id") and bool(rep.get("text")), rep)
        rev = r["revision 2 (new raw, same id)"].get("body") or {}
        self.check("D a new raw for the same item is revision 2 and supersedes the first hash",
                   rev.get("revision") == 2 and rev.get("supersedes") == r["clean-plain"]["body"]["key"]["sha256"], rev)
        # E: the second-opinion loop
        finals = {n: e["final"] for n, _r, _c, e in fx if "final" in e}
        end = time.time() + 180
        got = {}
        while time.time() < end:
            got = {row[0]: (row[1], row[2], row[3]) for row in self.psql(
                "SELECT external_id, status, coalesce(verdict,''), coalesce(scores->'service'->>'d2_row','') "
                "FROM intake.items WHERE external_id LIKE 'fx-%'")}
            if all(got.get("fx-" + n, ("", ""))[0] == "done" for n in finals):
                break
            time.sleep(3)
        self.results["rows_after_loop"] = got
        for n, final in finals.items():
            g = got.get("fx-" + n)
            self.check(f"E {n}: the second-opinion loop decided {final}", g is not None and g[:2] == ("done", final), g)
        disc = self.psql("SELECT count(*) FROM intake.discards WHERE external_id = 'fx-weak-judge-injection'")
        bronze = self.psql("SELECT count(*) FROM intake.raw_items WHERE external_id = 'fx-weak-judge-injection'")
        self.check("E judge injection: discard record kept, bronze deleted", disc[0][0] == "1" and bronze[0][0] == "0",
                   (disc, bronze))
        left = self.psql("SELECT count(*) FROM intake.items WHERE status = 'done' AND scores->'service' ? 'judge_input'")
        self.check("E no judge input (page text) stays in silver after a decision", left[0][0] == "0", left)
        reqs = [json.loads(line) for line in sh("exec", f"{self.p}-llm", "cat", "/tmp/requests.jsonl").stdout.splitlines() if line]
        self.results["fake_litellm_requests"] = [{k: v for k, v in q.items() if k != "prompt"} | {"prompt_head": q["prompt"][:200]}
                                                 for q in reqs]
        self.check("E the judge was asked through POST /v1/chat/completions only",
                   reqs and all(q["path"] == "/v1/chat/completions" for q in reqs), len(reqs))
        self.check("E every ask carried intake's own key and user ob-intake, temperature 0",
                   reqs and all(q["authorization"] == "Bearer " + self.so_key and q["user"] == "ob-intake"
                                and q["temperature"] == 0 for q in reqs))
        mal = [q for q in reqs if "E2E-JUDGE-MALFORMED" in q["prompt"]]
        self.check("E the malformed-answer item was asked exactly max_attempts (2) times, then expired", len(mal) == 2, len(mal))
        st = self.client([{"name": "stats", "method": "GET", "path": "/v1/stats", "headers": bearer},
                          {"name": "metrics", "method": "GET", "path": "/metrics", "headers": bearer}], "stats")
        self.results["stats"] = st["stats"].get("body")
        sb = st["stats"].get("body") or {}
        self.check("E /v1/stats is the documented shape with the research counts",
                   sb.get("schema") == "intake-stats/1" and sb.get("verdicts", {}).get("research", {}).get("injected", 0) >= 3, sb)
        mt = st["metrics"].get("body") or ""
        for metric in ("intake_items_total", "intake_screen_seconds_bucket", "intake_second_opinion_total",
                       "intake_pending_oldest_age_seconds", "intake_classifier_max_score_bucket"):
            self.check(f"E /metrics carries {metric}", metric in mt)

    def part_f(self):
        sha = lambda i: f"{i:064x}"  # noqa: E731
        self.psql(
            "WITH r AS (INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw, created_at) "
            f"VALUES ('e2e','research','purge-old','{sha(1)}','text/plain','x', now() - interval '40 days') RETURNING id) "
            "INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, verdict, created_at) "
            f"SELECT id, 'e2e','research','purge-old','{sha(1)}','done','clean', now() - interval '40 days' FROM r")
        self.psql(
            "WITH r AS (INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw, created_at) "
            f"VALUES ('e2e','research','purge-young','{sha(2)}','text/plain','x', now() - interval '29 days') RETURNING id) "
            "INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, verdict, created_at) "
            f"SELECT id, 'e2e','research','purge-young','{sha(2)}','done','clean', now() - interval '29 days' FROM r")
        self.psql("INSERT INTO intake.discards (source, connector, external_id, raw_sha256, reason, created_at) VALUES "
                  f"('e2e','research','purge-disc-old','{sha(3)}','strong:x', now() - interval '400 days'), "
                  f"('e2e','research','purge-disc-young','{sha(4)}','strong:x', now() - interval '300 days')")
        time.sleep(12)  # the purge loop runs every 5 s in this run
        raw = {r[0] for r in self.psql("SELECT external_id FROM intake.raw_items WHERE external_id LIKE 'purge-%'")}
        disc = {r[0] for r in self.psql("SELECT external_id FROM intake.discards WHERE external_id LIKE 'purge-%'")}
        items = {r[0]: r[1] for r in self.psql("SELECT external_id, coalesce(raw_item_id::text,'NULL') FROM intake.items "
                                                "WHERE external_id LIKE 'purge-%'")}
        self.results["purge"] = {"raw": sorted(raw), "discards": sorted(disc), "items": items}
        self.check("F the purge loop deleted 40-day clean bronze, kept 29-day", raw == {"purge-young"}, raw)
        self.check("F the purge loop deleted the 400-day discard, kept the 300-day one", disc == {"purge-disc-young"}, disc)
        self.check("F silver stays (raw_item_id set NULL on the purged item)", items.get("purge-old") == "NULL", items)

    def shapes_plan(self, prefix, host):
        from tests.e2e import shapes  # noqa: PLC0415
        bearer = {"Authorization": "Bearer " + self.keys["research"]}
        ids = [n for n, _r, _c in shapes.slow_shapes()]
        plan = [{"name": "host", "host": host, "sleep": 0}]
        plan += [{"name": n, "build": {"kind": "shape", "id": n, "external_id": f"{prefix}-{n}"},
                  "headers": bearer, "timeout": 600, "retry_503": 300} for n in ids]
        return ids, plan

    def part_g(self):
        # K: the stage wall clock below any real screen -> every shape is killed
        k = self.service("svck", "openbrain-intake-k", {"INTAKE_WALL_STAGES_SECONDS": "0.001",
                                                      "INTAKE_PURGE_INTERVAL_SECONDS": "3600"})
        boot = self.client([{"name": "host", "host": "openbrain-intake-k", "sleep": 0},
                            {"name": "healthz", "wait_healthz": 300}], "kboot")
        self.check("G instance K is up", boot["healthz"].get("status") == 200, boot["healthz"])
        ids, plan = self.shapes_plan("k", "openbrain-intake-k")
        r = self.client(plan, "kshapes", timeout=7200)
        timings = {}
        for n in ids:
            body = r[n].get("body") if isinstance(r[n].get("body"), dict) else {}
            err = (body.get("error") or {}).get("detail", "") if isinstance(body.get("error"), dict) else ""
            timings[n] = {"http": r[n].get("status"), "label": body.get("label"), "seconds": r[n].get("seconds"),
                          "busy_retries": r[n].get("retried_503", 0), "error": err[:120]}
            self.check(f"G[K] {n}: killed at the wall clock -> pending, no text",
                       r[n].get("status") == 200 and body.get("label") == "pending" and "killed" in err
                       and body.get("text") is None, timings[n])
        self.results["kill_timings"] = timings
        rows = {x[0]: x[1:] for x in self.psql(
            "SELECT external_id, status, coalesce(scores->>'error',''), coalesce(scores->>'error_kind','') "
            "FROM intake.items WHERE external_id LIKE 'k-%'")}
        self.check("G[K] every killed shape is a pending row with a transient error",
                   all(rows.get("k-" + n, ("",))[0] == "pending" and "killed" in rows["k-" + n][1]
                       and rows["k-" + n][2] == "transient" for n in ids), {n: rows.get("k-" + n) for n in ids[:3]})
        after = self.client([{"name": "host", "host": "openbrain-intake-k", "sleep": 0},
                             {"name": "healthz", "wait_healthz": 300}], "kafter")
        self.check("G[K] the pool replaced its killed workers (/healthz 200 afterwards)",
                   after["healthz"].get("status") == 200, after["healthz"])
        km = self.client([{"name": "host", "host": "openbrain-intake-k", "sleep": 0},
                          {"name": "metrics", "method": "GET", "path": "/metrics",
                           "headers": {"Authorization": "Bearer " + self.keys["research"]}}], "kmetrics")
        mt = km["metrics"].get("body") or ""
        kills = sum(float(m.group(1)) for m in re.finditer(r'intake_worker_kills_total\{phase="stages"\} (\S+)', mt))
        self.check("G[K] /metrics counts one stage kill per shape", kills >= len(ids), kills)
        sh("rm", "-f", k, check=False)
        # A: production limits -> each shape's own answer and time; never `clean` through an error
        ids, plan = self.shapes_plan("a", "openbrain-intake")
        r = self.client(plan, "ashapes", timeout=7200)
        prod = {}
        for n in ids:
            body = r[n].get("body") if isinstance(r[n].get("body"), dict) else {}
            err = body.get("error")
            prod[n] = {"http": r[n].get("status"), "label": body.get("label"), "d2_row": body.get("d2_row"),
                       "seconds": r[n].get("seconds"), "error": (err or {}).get("detail", "")[:120] if isinstance(err, dict) else None}
            self.check(f"G[A] {n}: answered, and never clean with an error",
                       r[n].get("status") in (200, 422) and not (body.get("label") == "clean" and err), prod[n])
        self.results["production_limit_shapes"] = prod

    def part_h(self):
        secrets_ = [*self.keys.values(), self.db_pw, self.so_key, self.pg_pw]
        leaks = {}
        for c in list(self.containers):
            r = sh("logs", c, check=False)
            text = r.stdout + r.stderr
            hit = [i for i, s in enumerate(secrets_) if s in text]
            if hit:
                leaks[c] = hit
        self.check("H no secret in any container log (caller keys, intake DB password, judge key, postgres password)",
                   not leaks, leaks)
        for c in (f"{self.p}-svc", f"{self.p}-relay"):
            r = sh("logs", c, check=False)
            (self.out / f"log-{c.split('-', 2)[-1]}.txt").write_text(r.stdout + r.stderr, encoding="utf-8")

    def cleanup(self):
        for c in reversed(self.containers):
            sh("rm", "-f", c, check=False, timeout=120)
        for n in reversed(self.networks):
            sh("network", "rm", n, check=False, timeout=120)
        shutil.rmtree(self.work, ignore_errors=True)
        left = sh("ps", "-a", "--filter", f"label={self.label}", "--filter", f"name={self.p}", "--format", "{{.Names}}",
                  check=False).stdout.split()
        nets = sh("network", "ls", "--filter", f"name={self.p}", "--format", "{{.Name}}", check=False).stdout.split()
        self.results["cleanup"] = {"containers_left": left, "networks_left": nets}
        print(f"cleanup: containers left {left}, networks left {nets}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="intake-i5")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    if not a.image.split(":")[-1].startswith("wt-"):
        sys.exit("refusing: the e2e runs only a :wt-<id> test image, never :local")
    sys.path.insert(0, str(INTAKE_DIR))
    os.chdir(INTAKE_DIR)
    run = Run(a)
    try:
        run.go()
    except Exception as e:  # noqa: BLE001
        run.check("the run completed", False, f"{type(e).__name__}: {e}")
    finally:
        if not a.keep:
            run.cleanup()
        run.results["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        bad = [c for c in run.results["checks"] if not c["ok"]]
        run.results["summary"] = {"checks": len(run.results["checks"]), "failed": len(bad)}
        run.save()
        print(f"\n{len(run.results['checks']) - len(bad)} OK, {len(bad)} FAILED")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
