"""stubs.py - the rw-mcp-identity lab's stand-ins, one stdlib HTTP server on :8080 (run with the Open WebUI image's
Python, which carries PyJWT + cryptography). Network aliases put it at every name the lab needs:

  stub-oidc        an OpenID provider standing in for Authentik: discovery, authorize (auto-approves the lab user
                   named by ?lab_user=), token (code + refresh), userinfo, jwks. RS256 ID and ACCESS tokens; the
                   access token carries iss / sub / aud / azp / exp / iat like Authentik's.
  stub-llm         an OpenAI-compatible model for Open WebUI (no inference): it answers Open WebUI's tool-selection
                   prompt with the tool call written in the user's message ("CALL <tool> <json>") and then echoes
                   every message it was given, so the tool's result comes back in the chat answer.
  llama-cpp,       the lab stand-in at the gateway aliases for openbrain-mcp's embedding and metadata calls
  llama-cpp-embed  (deterministic 1024-d vectors, a fixed metadata JSON). Never a real model.
  openbrain-       a recorder for openbrain-mcp's contract tools: it answers every /workbench/* call with the NAMES of
  workbench        the headers it received (never values) and whether the key was the service key.

Lab only. Never on a live network.
"""
import base64, hashlib, json, os, re, secrets, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISS = os.environ["LAB_ISS"]
CLIENT_ID = os.environ["LAB_CLIENT_ID"]
CLIENT_SECRET = os.environ["LAB_CLIENT_SECRET"]
BASE = os.environ.get("LAB_BASE", "http://stub-oidc:8080")
PATH = urllib.parse.urlparse(ISS).path.rstrip("/")  # /application/o/open-webui
USERS = json.loads(os.environ["LAB_USERS"])  # {"a": {"sub":..,"email":..,"name":..}, ...}
SERVICE_KEY = os.environ.get("LAB_WORKBENCH_KEY", "")
TOKEN_TTL = int(os.environ.get("LAB_TOKEN_TTL", "3600"))

# the provider's signing key: made once per run and kept in the run's state dir, so a restarted stub keeps signing with
# the key the servers' static JWKS names
_KEYFILE = "/state/stub-signing-key.pem"
if os.path.exists(_KEYFILE):
    KEY = serialization.load_pem_private_key(open(_KEYFILE, "rb").read(), password=None)
else:
    KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(_KEYFILE, "wb") as f:
        f.write(KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
KID = "lab-" + hashlib.sha256(KEY.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()[:8]
_pub = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
JWKS = {"keys": [{**_pub, "kid": KID, "use": "sig", "alg": "RS256"}]}
with open("/tmp/jwks.json", "w") as f:
    json.dump(JWKS, f, separators=(",", ":"))

CODES, REFRESH = {}, {}


def tokens(user_key, nonce=None):
    u = USERS[user_key]
    now = int(time.time())
    base = {"iss": ISS, "sub": u["sub"], "aud": CLIENT_ID, "iat": now, "exp": now + TOKEN_TTL}
    access = jwt.encode({**base, "azp": CLIENT_ID, "scope": "openid email profile", "uid": u["sub"][:8]}, KEY,
                        algorithm="RS256", headers={"kid": KID})
    idt = {**base, "email": u["email"], "email_verified": True, "name": u["name"], "preferred_username": u["name"]}
    if nonce:
        idt["nonce"] = nonce
    rt = secrets.token_urlsafe(24)
    REFRESH[rt] = user_key
    return {"access_token": access, "id_token": jwt.encode(idt, KEY, algorithm="RS256", headers={"kid": KID}),
            "token_type": "Bearer", "expires_in": TOKEN_TTL, "refresh_token": rt, "scope": "openid email profile"}


def vec(text):
    # ONE vector for every text: every row is equally similar to every query (cosine 1), so a search returns every row
    # its owner clause lets through and the lab sees exactly what the clause decides
    return [1.0 / 32.0] * 1024


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        sys.stderr.write("[stub] " + (fmt % a) + "\n")

    def send(self, code, body, ctype="application/json", headers=None):
        b = body if isinstance(body, bytes) else (json.dumps(body) if not isinstance(body, str) else body).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == f"{PATH}/.well-known/openid-configuration":
            return self.send(200, {
                "issuer": ISS, "authorization_endpoint": f"{BASE}{PATH}/authorize/",
                "token_endpoint": f"{BASE}{PATH}/token/", "userinfo_endpoint": f"{BASE}{PATH}/userinfo/",
                "jwks_uri": f"{BASE}{PATH}/jwks/", "end_session_endpoint": f"{BASE}{PATH}/end-session/",
                "response_types_supported": ["code"], "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"], "scopes_supported": ["openid", "email", "profile"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
                "code_challenge_methods_supported": ["S256"], "grant_types_supported": ["authorization_code", "refresh_token"],
            })
        if u.path == f"{PATH}/jwks/":
            return self.send(200, JWKS)
        if u.path == f"{PATH}/authorize/":
            who = q.get("lab_user")
            if who not in USERS or q.get("client_id") != CLIENT_ID or not q.get("redirect_uri"):
                return self.send(400, {"error": "lab: name ?lab_user= and the lab client"})
            code = secrets.token_urlsafe(16)
            CODES[code] = {"user": who, "nonce": q.get("nonce"), "redirect_uri": q["redirect_uri"],
                           "challenge": q.get("code_challenge")}
            sep = "&" if "?" in q["redirect_uri"] else "?"
            loc = f"{q['redirect_uri']}{sep}code={code}&state={urllib.parse.quote(q.get('state', ''))}"
            return self.send(302, b"", headers={"location": loc})
        if u.path == f"{PATH}/userinfo/":
            auth = self.headers.get("authorization", "")
            try:
                c = jwt.decode(auth.split(" ", 1)[1], KEY.public_key(), algorithms=["RS256"], audience=CLIENT_ID)
            except Exception:
                return self.send(401, {"error": "invalid_token"})
            u2 = next(v for v in USERS.values() if v["sub"] == c["sub"])
            return self.send(200, {"sub": u2["sub"], "email": u2["email"], "email_verified": True, "name": u2["name"],
                                   "preferred_username": u2["name"]})
        if u.path in ("/v1/models", "/models"):
            return self.send(200, {"object": "list", "data": [{"id": "lab-model", "object": "model", "owned_by": "lab"}]})
        if u.path.startswith("/workbench/"):
            return self.workbench()
        if u.path == "/health":
            return self.send(200, {"ok": True})
        return self.send(404, {"error": "lab stub: no route " + u.path})

    def workbench(self):
        names = sorted(k.lower() for k in self.headers.keys())
        return self.send(200, {"lab_workbench": True, "header_names": names,
                               "service_key": bool(SERVICE_KEY) and self.headers.get("x-brain-key") == SERVICE_KEY,
                               "results": []})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        raw = self.body()
        if u.path == f"{PATH}/token/":
            f = dict(urllib.parse.parse_qsl(raw.decode()))
            cid, csec = f.get("client_id"), f.get("client_secret")
            auth = self.headers.get("authorization", "")
            if auth.startswith("Basic "):
                cid, _, csec = base64.b64decode(auth[6:]).decode().partition(":")
                cid, csec = urllib.parse.unquote(cid), urllib.parse.unquote(csec)
            if cid != CLIENT_ID or csec != CLIENT_SECRET:
                return self.send(401, {"error": "invalid_client"})
            if f.get("grant_type") == "authorization_code":
                c = CODES.pop(f.get("code", ""), None)
                if not c or c["redirect_uri"] != f.get("redirect_uri"):
                    return self.send(400, {"error": "invalid_grant"})
                if c["challenge"]:
                    v = f.get("code_verifier", "")
                    d = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
                    if d != c["challenge"]:
                        return self.send(400, {"error": "invalid_grant", "error_description": "pkce"})
                return self.send(200, tokens(c["user"], c["nonce"]))
            if f.get("grant_type") == "refresh_token":
                who = REFRESH.pop(f.get("refresh_token", ""), None)
                if not who:
                    return self.send(400, {"error": "invalid_grant"})
                return self.send(200, tokens(who))
            return self.send(400, {"error": "unsupported_grant_type"})
        if u.path in ("/v1/embeddings", "/embeddings"):
            b = json.loads(raw or b"{}")
            inp = b.get("input")
            items = inp if isinstance(inp, list) else [inp]
            return self.send(200, {"object": "list", "model": b.get("model", "lab"),
                                   "data": [{"object": "embedding", "index": i, "embedding": vec(str(t))} for i, t in enumerate(items)]})
        if u.path in ("/v1/chat/completions", "/chat/completions"):
            return self.chat(json.loads(raw or b"{}"))
        if u.path.startswith("/workbench/"):
            return self.workbench()
        return self.send(404, {"error": "lab stub: no route " + u.path})

    def chat(self, b):
        msgs = b.get("messages") or []
        text_of = lambda m: m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content"))
        sys0 = text_of(msgs[0]) if msgs and msgs[0].get("role") == "system" else ""
        last = text_of(msgs[-1]) if msgs else ""
        if sys0.startswith("Extract metadata"):  # openbrain-mcp's capture metadata call
            content = json.dumps({"topics": ["lab"], "type": "observation", "people": [], "action_items": [], "dates_mentioned": []})
        elif sys0.startswith("Available Tools"):  # Open WebUI's tool-selection prompt
            m = re.search(r"CALL (\S+) (\{.*\})", last)
            calls = []
            if m:
                want, args = m.group(1), json.loads(m.group(2))
                names = re.findall(r'"name":\s*"([^"]+)"', sys0)
                hit = next((n for n in names if n == want or n.endswith("_" + want)), want)
                calls = [{"name": hit, "parameters": args}]
            content = json.dumps({"tool_calls": calls})
        else:
            content = "LAB-ECHO-BEGIN\n" + "\n---\n".join(text_of(m) or "" for m in msgs) + "\nLAB-ECHO-END"
        if b.get("stream"):
            chunk = {"id": "lab", "object": "chat.completion.chunk", "created": int(time.time()), "model": "lab-model",
                     "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}]}
            end = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            data = f"data: {json.dumps(chunk)}\n\ndata: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode()
            return self.send(200, data, ctype="text/event-stream")
        return self.send(200, {"id": "lab", "object": "chat.completion", "created": int(time.time()), "model": "lab-model",
                               "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
