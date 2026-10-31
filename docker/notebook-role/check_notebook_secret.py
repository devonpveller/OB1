#!/usr/bin/env python3
"""check_notebook_secret.py - ob_notebook's password is in none of the places it must never be.

    python check_notebook_secret.py [--secret-file OB1/docker/notebook-secrets/ob_notebook_db_password]
        [--ob1 OB1] [--containers open_notebook,openbrain-db] [--skip-env-file]

READ-ONLY. Reads the secret file into memory (never prints it, never passes it to another
process), then asserts, one PASS/FAIL line each, exit 1 on any FAIL:
  1. the open_notebook service in docker/docker-compose.yml sets OB1_DB_USER=ob_notebook and
     OB1_DB_PASSWORD_FILE, mounts the ob_notebook_db_password secret, and has NO OB1_DB_PASSWORD
     environment entry; the value is not in the compose file;
  2. docker/.env (open_notebook loads it whole) holds neither the value nor a variable named like
     the notebook DB password (OB1_DB_PASSWORD, *NOTEBOOK*PASSWORD*); --skip-env-file skips it;
  3. no file tracked in the OB1 repo holds the value, and the secret file is gitignored, untracked;
  4. for each container named: its `docker logs` and its configured environment (docker inspect
     Config.Env) do not hold the value, and its environment has no OB1_DB_PASSWORD.
Live use (after the deploy): run it from the ai-stack root with the defaults; it only reads.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAILS: list[str] = []


def res(name: str, ok: bool, why: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok or not why else f"  ({why})"))
    if not ok:
        FAILS.append(name)


def service_block(compose: str, name: str) -> str:
    m = re.search(rf"(?m)^  {re.escape(name)}:\s*$", compose)
    if not m:
        return ""
    nxt = re.search(r"(?m)^  [A-Za-z0-9_.-]+:\s*$|^[A-Za-z]", compose[m.end():])
    return compose[m.end(): m.end() + (nxt.start() if nxt else len(compose))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ob1_default = HERE.parent.parent
    ap.add_argument("--ob1", default=str(ob1_default))
    ap.add_argument("--secret-file", default="")
    ap.add_argument("--containers", default="")
    ap.add_argument("--skip-env-file", action="store_true")
    a = ap.parse_args()
    ob1 = Path(a.ob1)
    secret_file = Path(a.secret_file) if a.secret_file else ob1 / "docker" / "notebook-secrets" / "ob_notebook_db_password"
    try:
        value = secret_file.read_text(encoding="utf-8")
        value = value[:-2] if value.endswith("\r\n") else value[:-1] if value.endswith("\n") else value
    except OSError as exc:
        print(f"CANNOT MEASURE: the secret file is unreadable ({type(exc).__name__})")
        return 2
    if len(value) < 16:
        print("CANNOT MEASURE: the secret is shorter than 16 characters (a substring test would be meaningless)")
        return 2

    # 1. compose
    compose = (ob1 / "docker" / "docker-compose.yml").read_text(encoding="utf-8")
    blk = service_block(compose, "open_notebook")
    res("compose: open_notebook sets OB1_DB_USER=ob_notebook", bool(re.search(r"(?m)^\s*- OB1_DB_USER=ob_notebook\s*$", blk)))
    res("compose: open_notebook sets OB1_DB_PASSWORD_FILE=/run/secrets/ob_notebook_db_password",
        bool(re.search(r"(?m)^\s*- OB1_DB_PASSWORD_FILE=/run/secrets/ob_notebook_db_password\s*$", blk)))
    res("compose: open_notebook has no OB1_DB_PASSWORD environment entry",
        not re.search(r"(?m)^\s*-?\s*OB1_DB_PASSWORD\s*[=:]", blk))
    res("compose: open_notebook mounts the ob_notebook_db_password secret",
        bool(re.search(r"(?m)^\s*- source: ob_notebook_db_password\s*$", blk)))
    res("compose: the value is not in docker-compose.yml", value not in compose)

    # 2. docker/.env
    env = ob1 / "docker" / ".env"
    if a.skip_env_file:
        print("SKIP  docker/.env (--skip-env-file)")
    elif env.exists():
        text = env.read_text(encoding="utf-8", errors="replace")
        names = [ln.split("=", 1)[0].strip() for ln in text.splitlines() if "=" in ln and not ln.lstrip().startswith("#")]
        bad = [n for n in names if n == "OB1_DB_PASSWORD" or re.search(r"NOTEBOOK.*PASSWORD|OB_NOTEBOOK", n, re.I)]
        res("docker/.env: no notebook DB password variable", not bad, f"names: {bad}")
        res("docker/.env: the value is not in it", value not in text)
    else:
        print("SKIP  docker/.env (absent)")

    # 3. the repo
    ls = subprocess.run(["git", "-C", str(ob1), "ls-files", "-z"], capture_output=True)
    hits = []
    for rel in filter(None, ls.stdout.decode("utf-8", "replace").split("\0")):
        p = ob1 / rel
        try:
            if p.is_file() and p.stat().st_size <= 20 * 1024 * 1024 and value.encode("utf-8") in p.read_bytes():
                hits.append(rel)
        except OSError:
            pass
    n_files = ls.stdout.count(b"\0")
    res(f"repo: no tracked file holds the value ({n_files} files read)", ls.returncode == 0 and not hits, f"{hits}")
    rel = "docker/notebook-secrets/ob_notebook_db_password"
    ign = subprocess.run(["git", "-C", str(ob1), "check-ignore", "-q", rel]).returncode == 0
    trk = subprocess.run(["git", "-C", str(ob1), "ls-files", "--error-unmatch", rel], capture_output=True).returncode == 0
    res("repo: docker/notebook-secrets/ob_notebook_db_password is gitignored and untracked", ign and not trk,
        f"ignored={ign} tracked={trk}")

    # 4. containers
    for c in filter(None, a.containers.split(",")):
        logs = subprocess.run(["docker", "logs", c], capture_output=True)
        if logs.returncode != 0:
            res(f"container {c}: logs readable", False, "docker logs failed")
            continue
        res(f"container {c}: its log does not hold the value", value.encode() not in logs.stdout + logs.stderr)
        ins = subprocess.run(["docker", "inspect", "--format", "{{json .Config.Env}}", c], capture_output=True, text=True)
        envl = json.loads(ins.stdout or "[]") or []
        res(f"container {c}: its configured environment does not hold the value", all(value not in e for e in envl))
        res(f"container {c}: no OB1_DB_PASSWORD in its environment",
            not any(e.split("=", 1)[0] == "OB1_DB_PASSWORD" for e in envl))
    print(f"{'OK' if not FAILS else 'FAILED'}: {len(FAILS)} failure(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
