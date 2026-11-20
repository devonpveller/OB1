"""swap-ext-key.py - rw-mcp-identity round 2 (tester attempt 1, F6): take the FULL MCP_ACCESS_KEY out of openbrain-mcpo-ext's
config, the one place on the Open WebUI side that still holds it. openbrain-ext treats MCP_PERSONAL_ACCESS_KEY as no identity
(the shared wiki reads; every personal tool and write refused), exactly what the full key already was there, so mcpo-ext
keeps working, inert, with the personal key.

    python -I OB1/docker/mcpo/swap-ext-key.py --env OB1/docker/.env --config OB1/docker/mcpo-ext.config.json

Reads the two keys from the .env BY NAME, rewrites the config's x-brain-key, and prints only names and outcomes - never a
value. Refuses (exit 1, nothing written) when the personal key is unset, equals the full key, or the config does not hold the
full key (already swapped, or something else). Then recreate openbrain-mcpo-ext alone:
    docker compose -f OB1/docker/docker-compose.yml up -d --no-deps --force-recreate openbrain-mcpo-ext
"""
import argparse, json, os, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument("--env", required=True)
ap.add_argument("--config", required=True)
ap.add_argument("--restore", action="store_true", help="the ROLLBACK: put MCP_ACCESS_KEY back (the pre-rw-mcp-identity openbrain-ext accepts only it)")
a = ap.parse_args()

vals = {}
for line in open(a.env, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    vals[k.strip()] = v
full, personal = vals.get("MCP_ACCESS_KEY", ""), vals.get("MCP_PERSONAL_ACCESS_KEY", "")
print(f"env: MCP_ACCESS_KEY {'set' if full else 'UNSET'}, MCP_PERSONAL_ACCESS_KEY {'set' if personal else 'UNSET'}")
if not full or not personal or personal == full:
    print("refused: both keys must be set and differ; nothing written")
    sys.exit(1)
cfg = json.load(open(a.config, encoding="utf-8"))
servers = cfg.get("mcpServers", {})
frm, to, frm_name, to_name = (personal, full, "MCP_PERSONAL_ACCESS_KEY", "MCP_ACCESS_KEY") if a.restore else (full, personal, "MCP_ACCESS_KEY", "MCP_PERSONAL_ACCESS_KEY")
hits = [n for n, s in servers.items() if (s.get("headers") or {}).get("x-brain-key") == frm]
print(f"config: servers {sorted(servers)}; holding {frm_name}: {hits or 'none'}")
if not hits:
    print(f"refused: no server in the config holds {frm_name}; nothing written")
    sys.exit(1)
for n in hits:
    servers[n]["headers"]["x-brain-key"] = to
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(a.config)))
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
os.replace(tmp, a.config)
print(f"swapped: {hits} now hold {to_name}; {frm_name} no longer appears in the config")
