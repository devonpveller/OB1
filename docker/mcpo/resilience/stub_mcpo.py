"""Stand-in for `mcpo` in the mcpo-resilience tests: the SAME failure mode, nothing else.

Real mcpo (config mode) connects to each MCP server ONCE at start and serves
/<name>/openapi.json from what it found; a server it could not reach contributes no
paths, and it never retries. This does exactly that and no more:

  - parse `--config FILE --host H --port P --api-key K` like mcpo
  - for each server in the config POST an MCP `initialize` once; success -> 3 tool paths
  - serve /<name>/openapi.json  ->  {"openapi": "3.1.0", "paths": {...}}   (200 either way)
"""
import argparse
import json
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--config")
ap.add_argument("--host", default="0.0.0.0")
ap.add_argument("--port", type=int, default=8000)
ap.add_argument("--api-key")
a = ap.parse_args()

docs = {}
for name, srv in json.load(open(a.config))["mcpServers"].items():
    paths = {}
    try:
        req = urllib.request.Request(
            srv["url"],
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).encode(),
            headers={"content-type": "application/json", **srv.get("headers", {})},
        )
        urllib.request.urlopen(req, timeout=3).read()
        paths = {"/tool_a": {}, "/tool_b": {}, "/tool_c": {}}
    except Exception as e:  # noqa: BLE001
        print("stub-mcpo: %s unreachable (%s): serving 0 tools, never retrying" % (name, type(e).__name__), flush=True)
    docs["/%s/openapi.json" % name] = {"openapi": "3.1.0", "paths": paths}
    print("stub-mcpo: %s loaded %d tools" % (name, len(paths)), flush=True)


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        d = docs.get(self.path)
        body = json.dumps(d if d is not None else {"detail": "not found"}).encode()
        self.send_response(200 if d is not None else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer((a.host, a.port), H).serve_forever()
