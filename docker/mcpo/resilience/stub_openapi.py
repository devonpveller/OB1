"""A proxy that is UP and serving an openapi.json with $PATHS paths, for the healthcheck RED/GREEN."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

N = int(os.environ.get("PATHS", "0"))


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path.endswith("/openapi.json")
        body = json.dumps({"openapi": "3.1.0", "paths": {"/t%d" % i: {} for i in range(N)}} if ok else {}).encode()
        self.send_response(200 if ok else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
