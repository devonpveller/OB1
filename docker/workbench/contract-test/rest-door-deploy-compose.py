# rest-door-deploy-compose.py - the rw-rest-door-auth deploy-path lab's compose file (run-rest-door-deploy-lab.ps1).
#
# Reads the RENDERED compose of a lab copy of OB1/docker (`docker compose config --format json`, the live files with a
# lab .env) and writes a lab project file that keeps exactly what decides the deploy's behaviour - the door services'
# real configuration (openbrain-db, openbrain-postgrest, openbrain-rest: image, environment, bind mounts, depends_on,
# healthcheck) and the seven callers' real environment and depends_on - and takes away what would touch the host or
# the live stack:
#   * no container_name (the lab's containers are <project>-<service>-1, never the live names), no ports, no
#     network_mode, no build, no profiles; one network, `lab`, --internal on the lab subnet; every object labelled;
#   * a caller is a stand-in: its real environment and depends_on, the image `node`, `sleep infinity` - so its config
#     hash moves exactly when the deploy changes its configuration (its token env), and the lab can run one request
#     as that caller with the token from its own environment.
# Refuses (exit 2) if the result still has a port, a host network, an external network, a privileged service or a
# :local image.
#   python rest-door-deploy-compose.py <rendered.json> <out.json> <subnet> <owner-label> <node-image> <lab-project>
# The project name is the lab's (never open-brain / ai-stack: the live project's volumes are open-brain_*), and no
# volume keeps a `name`, so the lab's database volume is <lab-project>_openbrain-db-data.
import json
import sys

src, out, subnet, owner, node_image, project = sys.argv[1:7]
if not project.startswith('rda-deploy-'):
    print(f'REFUSED: lab project {project!r} must start with rda-deploy-')
    sys.exit(2)
d = json.load(open(src, encoding="utf-8"))
DOOR = ["openbrain-db", "openbrain-postgrest", "openbrain-rest"]
CALLERS = ["openbrain-wiki", "openbrain-wiki-viewer", "openbrain-entity-worker", "openbrain-digest", "openbrain-podcast",
           "openbrain-gmail-pull", "openbrain-gmail-prune"]
keep = DOOR + CALLERS
label = {"ai-stack.harness.owner": owner}
svcs = {}
for name in keep:
    s = d["services"].get(name)
    if s is None:
        print(f"REFUSED: the rendered compose has no service {name}")
        sys.exit(2)
    n = {"environment": s.get("environment") or {}, "labels": dict(label), "networks": ["lab"]}
    dep = {k: v for k, v in (s.get("depends_on") or {}).items() if k in keep}
    if dep:
        n["depends_on"] = dep
    if name in DOOR:
        n["image"] = s["image"]
        for k in ("volumes", "healthcheck", "command", "entrypoint"):
            if s.get(k) is not None:
                n[k] = s[k]
        n["restart"] = "no"
    else:
        n["image"] = node_image
        n["entrypoint"] = ["sleep", "infinity"]
        n["init"] = True
    svcs[name] = n

vols = {}
for name, n in svcs.items():
    for v in n.get("volumes", []):
        if isinstance(v, dict) and v.get("type") == "volume":
            vols[v["source"]] = {"labels": dict(label)}

lab = {
    "name": project,
    "services": svcs,
    "networks": {"lab": {"internal": True, "labels": dict(label), "ipam": {"config": [{"subnet": subnet}]}}},
    "volumes": vols,
}
bad = []
for name, n in svcs.items():
    for k in ("ports", "network_mode", "privileged", "container_name", "build", "profiles", "cap_add", "pid", "ipc"):
        if k in n:
            bad.append(f"{name}.{k}")
    if str(n.get("image", "")).endswith(":local"):
        bad.append(f"{name}: a :local image")
    for v in n.get("volumes", []):
        if isinstance(v, dict) and v.get("type") == "bind" and "docker.sock" in str(v.get("source", "")):
            bad.append(f"{name}: the docker socket")
if bad:
    print("REFUSED: " + ", ".join(bad))
    sys.exit(2)
json.dump(lab, open(out, "w", encoding="utf-8"), indent=1)
print(f"lab compose: {len(svcs)} services, {len(vols)} volume(s), network lab {subnet} (internal)")
