# contract-scope-calls.py - the cloud door's tools/call messages, policed by the REAL gateway
# (research-workbench P0, rw-p0-contract2 attempt 2; the shape of tester t-rw-p0's Case 23 probe).
#
#   python contract-scope-calls.py <openbrain-gateway/app.py> <contract-tools.json> <out dir>
#
# Loads the gateway's app.py (no server is started), runs its _apply_policy over every cloud
# tool x every argument set below x eight metadata_filter shapes (absent, {}, an override to
# share=local with undeclared override arguments, share=null, an extra key, the JSON strings
# "{}" and '{"share":"local"}', and a list), and writes what the gateway would FORWARD to
# <out dir>/calls.json. contract-scope.e2e.test.ts executes those calls through the
# openbrain-mcp adapter against a disposable :wt workbench and checks every answer for
# out-of-scope strings. "$name" placeholders are resolved by the e2e test from its seed.
#
# Exit 0 only when: the gateway's cloud contract set is exactly the manifest tools that carry
# metadata_filter; the argument sets cover every one of them; every refused call is the list
# shape (-32602); every forwarded call carries a metadata_filter containing share=cloud.
# Reads two files, writes two; no network, no database, no container.
import copy
import importlib.util
import json
import os
import pathlib
import sys

if len(sys.argv) != 4:
    sys.exit("usage: contract-scope-calls.py <openbrain-gateway/app.py> <contract-tools.json> <out dir>")
app_py, manifest_path, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])

# The gateway's own defaults: no override of its tool sets or of the forced filter.
os.environ.setdefault("OPENBRAIN_URL", "http://stub-openbrain.invalid:8000")
os.environ["OPENBRAIN_KEY"] = "x"
os.environ["GATEWAY_KEY"] = "y"
for k in ("GATEWAY_CONTRACT_TOOLS", "GATEWAY_READ_TOOLS", "GATEWAY_WRITE_TOOLS",
          "GATEWAY_READ_FILTER_FIELD", "GATEWAY_READ_FILTER_VALUE"):
    os.environ.pop(k, None)
spec = importlib.util.spec_from_file_location("openbrain_gateway_app", app_py)
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
filtered = sorted(t["tool"] for t in manifest if "metadata_filter" in ((t.get("input") or {}).get("properties") or {}))
cloud = sorted(gw.CONTRACT_TOOLS)
problems = []
if cloud != filtered:
    problems.append(f"gateway CONTRACT_TOOLS {cloud} != manifest tools with metadata_filter {filtered}")

VARIANTS = {
    "absent": None,
    "empty": {},
    "override_local": {"share": "local"},
    "override_null": {"share": None},
    "extra_key": {"share": "cloud", "extra": "k"},
    "string_empty": "{}",
    "string_override": "{\"share\":\"local\"}",
    "list": [],
}
BAD = ["..", "../registries", "not-a-uuid"]
CALLS = [
    ("contract_reference", {"id": "$srcLocal"}), ("contract_reference", {"id": "$srcCloud"}),
    ("contract_reference", {"id": "$srcSupCloud"}), ("contract_reference", {"id": "$heldCloud"}),
    ("contract_reference", {"id": "$eraseLocal"}), ("contract_reference", {"id": "$eraseCloud"}),
    ("contract_reference", {"id": "$srcLocal", "evidence_only": "false", "version": "1"}),
    ("contract_reference", {"id": "$leadLocal"}), ("contract_reference", {"id": "$synLocal"}),
    ("contract_chunk_context", {"chunkId": "$srcLocal:0"}), ("contract_chunk_context", {"chunkId": "$srcCloud:0", "window": "5"}),
    ("contract_chunk_context", {"chunkId": "$heldCloud:0"}), ("contract_chunk_context", {"chunkId": ".."}),
    ("contract_claims", {}), ("contract_claims", {"source_id": "$srcLocal"}), ("contract_claims", {"source_id": "$srcCloud"}),
    ("contract_claims", {"source_id": "$eraseLocal"}), ("contract_claims", {"q": "$LOCAL"}), ("contract_claims", {"q": "cloud claim"}),
    ("contract_claims", {"synthesis_id": "$synLocal"}), ("contract_claims", {"synthesis_id": "$synCloud"}),
    ("contract_claims", {"thread_id": "$thread"}), ("contract_claims", {"status": "active"}),
    ("contract_claims", {"evidence_only": "true"}), ("contract_claims", {"source_id": "not-a-uuid"}),
    ("contract_dependence", {"id": "$srcLocal"}), ("contract_dependence", {"id": "$srcCloud"}),
    ("contract_dependence", {"id": "$srcSupCloud"}), ("contract_dependence", {"id": "$synLocal"}),
    ("contract_dependence", {"id": "$leadLocal"}), ("contract_dependence", {"id": "$eraseLocal"}),
    ("contract_dependence", {"id": "$heldCloud"}), ("contract_dependence", {"id": "$fx1"}),
    ("contract_documents", {}), ("contract_documents", {"limit": "500"}),
    ("contract_idea", {"id": "$fxIdea"}), ("contract_ideas", {}),
    ("contract_jobs", {}), ("contract_jobs", {"state": "done", "kinds": "research,import"}),
    ("contract_neighbours", {"id": "$page"}), ("contract_neighbours", {"id": "content/tool/tool-fixture", "depth": "3"}),
    ("contract_quality", {"id": "$srcLocal"}), ("contract_quality", {"id": "$srcCloud"}),
    ("contract_quality", {"id": "$srcSupCloud"}), ("contract_quality", {"id": "$heldCloud"}),
    ("contract_search", {"q": "$LOCAL"}), ("contract_search", {"q": "$LOCAL", "kinds": "page,claim,source,document"}),
    ("contract_search", {"q": "fixture"}), ("contract_search", {"q": "$LOCAL", "refinery_id": "$fxIdea"}),
    ("contract_search", {"q": "held", "refinery_id": "$fxIdea"}), ("contract_search", {"q": "$run"}),
    ("contract_search", {"q": "contract retrieval", "kinds": "page"}),
    ("contract_session", {"id": "$fxJob"}), ("contract_session", {"id": "$session"}),
    ("contract_timeline", {}), ("contract_timeline", {"source_id": "$srcLocal"}), ("contract_timeline", {"source_id": "$srcCloud"}),
    ("contract_tombstone", {"id": "$tombLocal"}), ("contract_tombstone", {"id": "$tombCloud"}),
    ("contract_trail", {}), ("contract_trail", {"source_id": "$srcLocal"}), ("contract_trail", {"source_id": "$srcCloud"}),
    ("contract_trail", {"source_id": "$eraseLocal"}),
]
# malformed path ids on every tool that takes one (N3: 400, never database text)
for tname in ("contract_reference", "contract_dependence", "contract_quality", "contract_idea",
              "contract_session", "contract_tombstone"):
    for b in BAD:
        CALLS.append((tname, {"id": b}))

covered = sorted({c[0] for c in CALLS})
if covered != cloud:
    problems.append(f"argument sets cover {covered}, the cloud door exposes {cloud}")

calls, refused = [], []
for tool, args in CALLS:
    for vname, v in VARIANTS.items():
        a = copy.deepcopy(args)
        if v is not None:
            a["metadata_filter"] = copy.deepcopy(v)
        if vname == "override_local":
            # undeclared arguments that try to override the scope (the MCP SDK drops them; the
            # adapter never reads them) ride along to prove it
            a["metadataFilter"] = {}
            a["filter"] = None
        msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": copy.deepcopy(a)}}
        fwd, err = gw._apply_policy(msg)
        if err:
            refused.append({"tool": tool, "variant": vname, "code": err["error"]["code"]})
            if not (vname == "list" and err["error"]["code"] == -32602):
                problems.append(f"{tool} {vname}: refused {err['error']}")
            continue
        f = fwd["params"]["arguments"].get("metadata_filter")
        if not isinstance(f, dict) or f.get("share") != "cloud":
            problems.append(f"{tool} {vname}: forwarded metadata_filter {f!r}")
        calls.append({"tool": tool, "variant": vname, "forwarded": fwd["params"]["arguments"]})

out.mkdir(parents=True, exist_ok=True)
(out / "calls.json").write_text(json.dumps(calls, indent=1), encoding="utf-8")
report = {
    "cloud_tools": cloud, "argument_sets": len(CALLS), "variants": list(VARIANTS),
    "forwarded": len(calls), "refused": len(refused),
    "refused_shapes": sorted({(r["variant"], r["code"]) for r in refused}),
    "forwarded_filters": sorted({json.dumps(c["forwarded"].get("metadata_filter"), sort_keys=True) for c in calls}),
    "problems": problems,
}
(out / "gateway-report.json").write_text(json.dumps(report, indent=1, default=list), encoding="utf-8")
print(f"cloud tools: {len(cloud)}; argument sets: {len(CALLS)}; shapes: {len(VARIANTS)}; "
      f"forwarded: {len(calls)}; refused: {len(refused)} {report['refused_shapes']}")
print(f"forwarded filters: {report['forwarded_filters']}")
for p in problems:
    print(f"PROBLEM: {p}")
sys.exit(1 if problems else 0)
