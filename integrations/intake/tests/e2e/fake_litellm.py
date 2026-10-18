"""A fake LiteLLM for the I5 e2e run (runs in a throwaway container, alias `llama-cpp`, :8080).

POST /v1/chat/completions answers like the gateway would, deciding by a marker in the prompt:
  E2E-JUDGE-INJECTION -> {"verdict": "injection"}
  E2E-JUDGE-UNCERTAIN -> {"verdict": "uncertain"}
  E2E-JUDGE-MALFORMED -> "Verdict: clean" (not the JSON object: the service must retry)
  otherwise           -> {"verdict": "clean"}
Every request is appended to /tmp/requests.jsonl (path, the Authorization header, the body's
model/user fields and the first 2,000 characters of the user message) for the driver to read.
GET /health/liveliness -> 200. Anything else -> 404. Standard library only.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = "/tmp/requests.jsonl"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        return

    def _send(self, code, doc):
        b = json.dumps(doc).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health/liveliness":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        user = ""
        for m in body.get("messages", []):
            if m.get("role") == "user":
                user = m.get("content", "")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"path": self.path, "authorization": self.headers.get("Authorization"),
                                "model": body.get("model"), "user": body.get("user"),
                                "temperature": body.get("temperature"), "prompt": user[:2000]}) + "\n")
        if self.path != "/v1/chat/completions":
            return self._send(404, {"error": "not found"})
        if "E2E-JUDGE-MALFORMED" in user:
            content = "Verdict: clean"
        elif "E2E-JUDGE-INJECTION" in user:
            content = json.dumps({"verdict": "injection"})
        elif "E2E-JUDGE-UNCERTAIN" in user:
            content = json.dumps({"verdict": "uncertain"})
        else:
            content = json.dumps({"verdict": "clean"})
        self._send(200, {"choices": [{"message": {"role": "assistant", "content": content},
                                      "finish_reason": "stop"}]})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
