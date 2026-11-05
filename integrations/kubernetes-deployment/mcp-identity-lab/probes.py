"""probes.py - the adversarial probes for rw-mcp-identity. Written by the tester t-mcp-identity (attempt 1, cases a-i) and
folded into the lab by the developer for round 2: the a-i probes unchanged in intent, three probe false positives fixed
(small integer ids matched as substrings; the shared wiki_* reads counted as writes; a stub workbench), and the round-2
cases added (tagged R2: F1 the workbench serves the caller, F2 openbrain-ext's foreign ids and nested joins, the two-key
refusal). Runs inside the lab network with the Open WebUI image's Python, after driver.py login (A, B, C signed in; C's SSO
session removed). Prints PASS/FAIL/INFO lines only; never a token, a key or a row's text (marker NAMES, statuses, counts).

Modes (E["probe_mode"]): green - every probe must pass; red-r2 (the base is 27504ae: round 1) - every R2 probe must FAIL and
every other probe pass; red-r1 (the base is 51f00ea: before this item) - every R2 probe must FAIL (the rest is reported)."""
import base64, hashlib, hmac, http.client, json, random, re, socket, sys, time, uuid
from concurrent.futures import ThreadPoolExecutor

import jwt, psycopg2, requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

import driver as D

E, K, M = D.E, D.K, D.M
MCP, EXT, MCPO = D.MCP, D.EXT, D.MCPO
SUB_A, SUB_B = E["subs"]["a"], E["subs"]["b"]
KEY = serialization.load_pem_private_key(open("/state/stub-signing-key.pem", "rb").read(), password=None)
KID = E["kid"]
PUB_PEM = KEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
RES = []
R2 = set()  # the round-2 probes (tester attempt 1's F1 / F2 / the two-key combination)
A_STRINGS = {}   # name -> string that only A's rows hold
A_IDS = {}       # id of a row A owns -> label
B_STRINGS = {}


def rec(probe, ok, what, kind=None, r2=False):
    if r2:
        R2.add(probe)
    tag = kind or ("PASS" if ok else "FAIL")
    RES.append((probe, tag))
    print(f"{tag} {probe}: {what}", flush=True)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mint(sub=SUB_B, claims=None, drop=(), headers=None, key=KEY, alg="RS256"):
    now = int(time.time())
    c = {"iss": E["iss"], "aud": E["aud"], "azp": E["aud"], "sub": sub, "iat": now, "exp": now + 600}
    c.update(claims or {})
    for d in drop:
        c.pop(d, None)
    h = {"kid": KID}
    h.update(headers or {})
    h = {k: v for k, v in h.items() if v is not None}
    # raw JWS over the exact claims (PyJWT's encode would refuse a non-string iss / sub before signing)
    return jwt.api_jws.encode(json.dumps(c).encode(), key, algorithm=alg, headers=h)


def raw_jwt(header, claims, sig=b""):
    return f"{b64u(json.dumps(header).encode())}.{b64u(json.dumps(claims).encode())}.{b64u(sig)}"


def hs256(secret, claims, header=None):
    h = {"alg": "HS256", "typ": "JWT", "kid": KID, **(header or {})}
    si = f"{b64u(json.dumps(h).encode())}.{b64u(json.dumps(claims).encode())}"
    return si + "." + b64u(hmac.new(secret, si.encode(), hashlib.sha256).digest())


def std_claims(**kw):
    now = int(time.time())
    c = {"iss": E["iss"], "aud": E["aud"], "azp": E["aud"], "sub": SUB_B, "iat": now, "exp": now + 600}
    c.update(kw)
    return c


def call(url, headers, tool, args, rid=1, timeout=120, method="tools/call"):
    h = {"content-type": "application/json", "accept": "application/json, text/event-stream", **headers}
    # the extensions connection's key (K["ext"]) is the owui key on a lane-wired tree; on 51f00ea (no lane) it is the full
    # key, as openbrain-mcpo-ext holds today - so "the Open WebUI side's key" reaches openbrain-ext the way the base allows
    if url.startswith(EXT) and h.get("x-brain-key") == K["owui"] and K.get("ext"):
        h["x-brain-key"] = K["ext"]
    params = {"name": tool, "arguments": args} if method == "tools/call" else {}
    r = requests.post(url, headers=h, json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, timeout=timeout)
    t = r.text
    if "text/event-stream" in r.headers.get("content-type", ""):
        t = "\n".join(l[5:].strip() for l in t.splitlines() if l.startswith("data:"))
    return r.status_code, t


def tools(url, headers):
    st, t = call(url, headers, "", {}, method="tools/list")
    try:
        return json.loads(t.splitlines()[-1])["result"]["tools"]
    except Exception:
        return []


def result_text(t):
    try:
        d = json.loads(t.splitlines()[-1])
        if d.get("error"):
            return True, json.dumps(d["error"])
        r = d.get("result") or {}
        return bool(r.get("isError")), "\n".join(c.get("text", "") for c in r.get("content", []))
    except Exception:
        return True, t


def ctx(text, needle, n=140):
    i = (text or "").find(needle)
    s = (text or "")[max(0, i - n):i + len(needle) + n]
    for k, v in list(M.items()) + list(A_STRINGS.items()) + list(B_STRINGS.items()):
        s = s.replace(v, f"<{k}>")
    for i2, lbl in A_IDS.items():
        s = s.replace(i2, f"<{lbl}>")
    s = s.replace(SUB_A, "<subA>").replace(SUB_B, "<subB>")
    return s


def leak_detail(text, own_args=None):
    own = json.dumps(own_args or {})
    for i, lbl in A_IDS.items():
        if i in (text or "") and i not in own:
            return ctx(text, i)
    for n in ("a_thought", "a_idea", "a_ext"):
        if M[n] in (text or ""):
            return ctx(text, M[n])
    for n, s in A_STRINGS.items():
        if s in (text or ""):
            return ctx(text, s)
    return ""


def a_leaks(text, own_args=None):
    own = json.dumps(own_args or {})
    out = [n for n in ("a_thought", "a_idea", "a_ext") if M[n] in (text or "")]
    out += [n for n, s in A_STRINGS.items() if s in (text or "")]
    # an id counts only as a whole token (a small integer thought id inside other digits was a probe false positive)
    # (thoughts.id is a small integer: matched as a token it still hit unrelated numbers - "D15 items 4, 5, 10" - so an
    # integer id is checked through the A-thought marker instead, never as a bare number)
    out += [f"A-row-id:{lbl}" for i, lbl in A_IDS.items()
            if len(i) >= 8 and re.search(rf"(?<![0-9A-Za-z-]){re.escape(i)}(?![0-9A-Za-z-])", text or "") and i not in own]
    if SUB_A in (text or ""):
        out.append("A-sub")
    if E["default_user_id"] in (text or "") and E["default_user_id"] not in own:
        out.append("A-ext-user_id")
    if "A lab marker idea" in (text or ""):
        out.append("A-idea-title")
    return out


def q(sql, args=()):
    with psycopg2.connect(E["db_dsn"]) as c, c.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else None


def snapshot():
    tabs = [r[0] for r in q("SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname IN ('public')".replace("%", "%%"))]
    out = {}
    for t in tabs:
        try:
            out[t] = q(f"SELECT count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM {t} x")[0]
        except Exception as e:
            out[t] = ("err", type(e).__name__)
    return out


def diff(a, b):
    return sorted(t for t in set(a) | set(b) if a.get(t) != b.get(t))


# ---- argument generation from a tool's inputSchema --------------------------------------------------------------------
DATEISH = re.compile(r"(date|date_value|week_start|next_due|last_used|last_contacted)$")
TSISH = re.compile(r"(_at)$")


def gen(name, s, mk, ids):
    t = s.get("type")
    if "enum" in s:
        return s["enum"][0]
    if "anyOf" in s:
        for o in s["anyOf"]:
            if o.get("type") not in (None, "null"):
                return gen(name, o, mk, ids)
    if name.endswith("_id") or name == "id" or name == "slug":
        if name in ids:
            return ids[name]
        if t in ("integer", "number"):
            return 1
        return str(uuid.uuid4())
    if t == "string":
        if DATEISH.search(name):
            return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400 * 7))
        if TSISH.search(name):
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400 * 3))
        if "url" in name or name == "website":
            return "https://lab.invalid/" + mk
        if "email" in name:
            return mk.lower() + "@lab.invalid"
        if name.endswith("_time"):
            return "10:00"
        if name in ("query", "q"):
            return "lab marker"
        return f"{name} {mk}"
    if t in ("integer", "number"):
        if name in ("days_ahead", "limit"):
            return 50 if name == "limit" else 400
        if name == "day_of_week":
            return 1
        if name == "rating":
            return 4
        if name == "threshold":
            return 0
        return 1
    if t == "boolean":
        return False
    if t == "array":
        it = s.get("items", {})
        return [gen(name.rstrip("s"), it, mk, ids)]
    if t == "object":
        props = s.get("properties")
        if props:
            return {k: gen(k, v, mk, ids) for k, v in props.items()}
        return {"note": mk}
    return mk


def args_for(tool, mk, ids, required_only=False):
    sch = tool.get("inputSchema") or {}
    props = sch.get("properties", {})
    req = set(sch.get("required", []))
    out = {}
    for k, v in props.items():
        if k in req or (not required_only and (k.endswith("_id") or k in ("query", "q", "days_ahead", "limit", "threshold", "id"))):
            out[k] = gen(k, v, mk, ids)
    return out


EXT_READS = {"wiki_list_pages", "wiki_read_page", "wiki_search", "wiki_get_backlinks", "wiki_get_related"}


def is_read(tool):
    # openbrain-ext's tools carry no annotations: its shared wiki reads are reads by design (a probe false positive before)
    return (tool.get("annotations") or {}).get("readOnlyHint") is True or tool.get("name") in EXT_READS


# ---- probes -----------------------------------------------------------------------------------------------------------
HB = lambda tok: {"x-brain-key": K["owui"], "authorization": f"Bearer {tok}"}
NOTOK = {"x-brain-key": K["owui"]}
SEARCH = {"query": "lab marker", "limit": 50, "threshold": 0.0}
DATES = {"days_ahead": 400}


def as_seen(url, headers):
    tool, args = ("search_thoughts", SEARCH) if url == MCP else ("get_upcoming_dates", DATES)
    st, t = call(url, headers, tool, args)
    return st, t


def p_tokens():
    now = int(time.time())
    evil_rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    evil_ec = ec.generate_private_key(ec.SECP256R1())
    pubnums = KEY.public_key().public_numbers()
    n_bytes = pubnums.n.to_bytes((pubnums.n.bit_length() + 7) // 8, "big")
    refuse = [
        ("alg none, empty signature", raw_jwt({"alg": "none", "typ": "JWT"}, std_claims(sub=SUB_A))),
        ("alg none, junk signature", raw_jwt({"alg": "none", "kid": KID}, std_claims(sub=SUB_A), b"x")),
        ("alg NONE (case)", raw_jwt({"alg": "NONE", "kid": KID}, std_claims(sub=SUB_A), b"x")),
        ("HS256 keyed with the public PEM (alg confusion)", hs256(PUB_PEM, std_claims(sub=SUB_A))),
        ("HS256 keyed with the JWK n bytes", hs256(n_bytes, std_claims(sub=SUB_A))),
        ("HS256 keyed with the client secret", hs256(E["client_secret"].encode(), std_claims(sub=SUB_A))),
        ("RS384 by the real key, kid matches", mint(SUB_A, alg="RS384")),
        ("RS512 by the real key", mint(SUB_A, alg="RS512")),
        ("PS256 by the real key", mint(SUB_A, alg="PS256")),
        ("ES256 by a foreign EC key", mint(SUB_A, key=evil_ec, alg="ES256")),
        ("unknown kid, real key", mint(SUB_A, headers={"kid": "no-such-kid"})),
        ("real kid, foreign RSA key", mint(SUB_A, key=evil_rsa)),
        ("no kid, foreign RSA key", mint(SUB_A, key=evil_rsa, headers={"kid": None})),
        ("jwk header embedding a foreign key", jwt.encode(std_claims(sub=SUB_A), evil_rsa, algorithm="RS256",
                                                         headers={"kid": KID, "jwk": json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(evil_rsa.public_key()))})),
        ("jku header to a foreign set", jwt.encode(std_claims(sub=SUB_A), evil_rsa, algorithm="RS256", headers={"kid": KID, "jku": "http://stub-llm:8080/jwks"})),
        ("crit header", mint(SUB_B, headers={"crit": ["exp"]})),
        ("wrong iss", mint(SUB_B, claims={"iss": "https://evil.invalid/application/o/open-webui/"})),
        ("iss without trailing slash", mint(SUB_B, claims={"iss": E["iss"].rstrip("/")})),
        ("iss as array", mint(SUB_B, claims={"iss": [E["iss"]]})),
        ("wrong aud", mint(SUB_B, claims={"aud": "another-client", "azp": "another-client"})),
        ("aud array without ours", mint(SUB_B, claims={"aud": ["another-client"], "azp": "another-client"})),
        ("aud array with ours, azp another client", mint(SUB_B, claims={"aud": ["another-client", E["aud"]], "azp": "another-client"})),
        ("aud missing", mint(SUB_B, drop=("aud",))),
        ("exp 2 h ago", mint(SUB_B, claims={"exp": now - 7200})),
        ("exp 61+ s ago (past the leeway)", mint(SUB_B, claims={"exp": now - 90})),
        ("no exp", mint(SUB_B, drop=("exp",))),
        ("exp as string", mint(SUB_B, claims={"exp": str(now + 600)})),
        ("nbf 1 h ahead", mint(SUB_B, claims={"nbf": now + 3600})),
        ("iat 1 h ahead", mint(SUB_B, claims={"iat": now + 3600})),
        ("sub empty", mint("")),
        ("sub leading space + A", mint(" " + SUB_A)),
        ("sub A + trailing newline", mint(SUB_A + "\n")),
        ("sub A + tab inside", mint(SUB_A[:3] + "\t" + SUB_A[3:])),
        ("sub 'operator'", mint("operator")),
        ("sub 'Operator'", mint("Operator")),
        ("sub 'service:internal'", mint("service:internal")),
        ("sub 'anonymous:'", mint("anonymous:")),
        ("sub missing", mint(SUB_B, drop=("sub",))),
        ("sub as a number", mint(12345)),
        ("sub as a list [A]", mint([SUB_A])),
        ("sub 257 chars", mint("x" * 257)),
        ("B token, signature stripped", ".".join(mint(SUB_B).split(".")[:2]) + "."),
        ("B token, payload swapped to A (resign-free)", (lambda t: t.split(".")[0] + "." + b64u(json.dumps(std_claims(sub=SUB_A)).encode()) + "." + t.split(".")[2])(mint(SUB_B))),
        ("B token + a 2nd JWT after a comma", mint(SUB_B) + ", " + mint(SUB_A, key=evil_rsa)),
    ]
    for name, tok in refuse:
        for url, lbl in ((MCP, "mcp"), (EXT, "ext")):
            try:
                st, t = as_seen(url, HB(tok))
            except Exception as e:
                st, t = 0, type(e).__name__
            rec(f"a.token[{name}]@{lbl}", st == 401 and not a_leaks(t), f"status {st}, A leaks {a_leaks(t) or 'none'}")
    # accepted-by-design variants: must act as B (never A, never the operator)
    accept_as_b = [
        ("no kid header (real key)", mint(SUB_B, headers={"kid": None})),
        ("aud array incl. ours, no azp", mint(SUB_B, claims={"aud": ["another-client", E["aud"]]}, drop=("azp",))),
        ("exp 30 s ago (inside the 60 s leeway)", mint(SUB_B, claims={"exp": now - 30})),
        ("nbf 30 s ahead (inside the leeway)", mint(SUB_B, claims={"nbf": now + 30})),
        ("B token naming A in act/on_behalf_of/user_id/preferred_username/email/uid/oid",
         mint(SUB_B, claims={"act": {"sub": SUB_A}, "on_behalf_of": SUB_A, "user_id": SUB_A, "preferred_username": SUB_A,
                             "email": "a@lab.invalid", "uid": SUB_A, "oid": SUB_A, "owner": SUB_A, "groups": ["admin", "authentik Admins"]})),
        ("sub = A upper-cased (a different subject)", mint(SUB_A.upper())),
        ("sub = A with a unicode look-alike", mint(SUB_A.replace("a", "а", 1))),
    ]
    for name, tok in accept_as_b:
        for url, lbl in ((MCP, "mcp"), (EXT, "ext")):
            st, t = as_seen(url, HB(tok))
            leak = a_leaks(t)
            rec(f"a.token-accepted[{name}]@{lbl}", not leak, f"status {st} (accepted by design if 200), A leaks {leak or 'none'}")
    # the leeway edge exactly: exp = now - 60 (accepted), now - 62 (refused)
    st1, _ = as_seen(MCP, HB(mint(SUB_B, claims={"exp": int(time.time()) - 58})))
    st2, _ = as_seen(MCP, HB(mint(SUB_B, claims={"exp": int(time.time()) - 63})))
    rec("a.token[leeway edge]", st1 == 200 and st2 == 401, f"exp now-58 -> {st1}, now-63 -> {st2}")


def p_key_vs_token():
    tb = mint(SUB_B)
    cases = [
        ("owui key alone @mcp", MCP, NOTOK, "shared"),
        ("owui key alone @ext", EXT, NOTOK, "noid"),
        ("B token, no key @mcp", MCP, {"authorization": f"Bearer {tb}"}, 401),
        ("B token, no key @ext", EXT, {"authorization": f"Bearer {tb}"}, 401),
        ("B token + personal key @mcp", MCP, {"x-brain-key": K["personal"], "authorization": f"Bearer {tb}"}, 403),
        ("B token + personal key @ext (round 2 F6: the personal lane exists there; a token on it is 403)", EXT, {"x-brain-key": K["personal"], "authorization": f"Bearer {tb}"}, 403),
        ("B token + FULL key @mcp (no upgrade)", MCP, {"x-brain-key": K["full"], "authorization": f"Bearer {tb}"}, 403),
        ("B token + FULL key @ext (no upgrade)", EXT, {"x-brain-key": K["full"], "authorization": f"Bearer {tb}"}, 403),
        ("FULL key in ?key= + B token @mcp", MCP + "?key=" + K["full"], {"authorization": f"Bearer {tb}"}, 403),
        ("owui x-brain-key + FULL ?key= + B token @mcp (two keys: 403)", MCP + "?key=" + K["full"], HB(tb), 403),
        ("FULL x-brain-key + owui ?key= + B token @mcp", MCP + "?key=" + K["owui"], {"x-brain-key": K["full"], "authorization": f"Bearer {tb}"}, 403),
        ("ext: x-access-key FULL + x-brain-key owui + B token (two keys: 403)", EXT, {"x-access-key": K["full"], **HB(tb)}, 403),
        ("ext: x-access-key owui + B token (no x-brain-key)", EXT, {"x-access-key": K["owui"], "authorization": f"Bearer {tb}"}, "B"),
        ("ext: x-brain-key owui + ?key=FULL + B token (two keys: 403)", EXT + "?key=" + K["full"], HB(tb), 403),
        ("FULL key alone @ext (no identity there)", EXT, {"x-brain-key": K["full"]}, "noid"),
        ("personal key alone @ext (round 2 F6: no identity there)", EXT, {"x-brain-key": K["personal"]}, "noid"),
        ("mcpo key on mcp", MCP, {"x-brain-key": K["mcpo"]}, 401),
    ]
    for name, url, h, want in cases:
        st, t = as_seen(url.split("?")[0] if False else url, h)
        err, txt = result_text(t)
        leak = a_leaks(t)
        if want in (401, 403):
            ok = st == want and not leak
        elif want == "shared":
            ok = st == 200 and not leak and M["shared"] in t
        elif want == "noid":
            ok = st == 200 and err and not leak
        else:  # "B"
            ok = st == 200 and not leak
        rec(f"b.{name}", ok, f"status {st}, tool error {err}, A leaks {leak or 'none'} (want {want})", r2=("two keys" in name or "round 2 F6: no identity there" in name))


IDENTITY_HEADERS = [
    "x-on-behalf-of", "X-On-Behalf-Of", "X-ON-BEHALF-OF", "x-user", "x-user-id", "x-user-email", "x-userid", "x-subject", "x-sub",
    "x-forwarded-user", "x-forwarded-email", "x-forwarded-preferred-username", "x-forwarded-for", "x-forwarded-host", "x-real-ip",
    "x-openwebui-user-id", "x-openwebui-user-name", "x-openwebui-user-email", "x-openwebui-user-role", "x-openwebui-user-jwt",
    "x-openwebui-chat-id", "x-openwebui-message-id", "x-authentik-username", "x-authentik-uid", "x-authentik-jwt", "x-authentik-email",
    "x-ob-user", "x-ob-subject", "x-ob-sub", "x-ob-user-id", "remote-user", "x-remote-user", "x-workspace-user", "x-test-sub",
    "x-auth-request-user", "x-auth-request-email", "cf-access-authenticated-user-email", "cf-access-jwt-assertion",
    "x-ms-client-principal-name", "x-goog-authenticated-user-email", "x-amzn-oidc-identity", "x-owner", "x-tenant",
]


def p_headers():
    tb = mint(SUB_B)
    lanes = [("full", MCP, {"x-brain-key": K["full"]}), ("personal", MCP, {"x-brain-key": K["personal"]}), ("owui-none", MCP, NOTOK),
             ("owui-B", MCP, HB(tb)), ("ext-full", EXT, {"x-brain-key": K["full"]}), ("ext-owui-none", EXT, NOTOK), ("ext-owui-B", EXT, HB(tb))]
    summary = {}
    for hn in IDENTITY_HEADERS:
        for val in (SUB_A, ""):
            for lane, url, base in lanes:
                h = {**base, hn: val}
                try:
                    st, t = as_seen(url, h)
                except Exception as e:
                    st, t = 0, type(e).__name__
                leak = a_leaks(t)
                bad = bool(leak) and not lane.endswith("full") or (lane == "full" and False)
                # ext-full has no identity, so A's rows there are a leak too
                if lane == "ext-full" and leak:
                    bad = True
                summary.setdefault(st, 0)
                summary[st] += 1
                if bad:
                    rec(f"c.header[{hn}={'A' if val else 'empty'}]@{lane}", False, f"status {st}, A leaks {leak}")
    rec("c.forged headers (all lanes, A-valued and empty)", not any(t == "FAIL" and p.startswith("c.header") for p, t in RES),
        f"{len(IDENTITY_HEADERS)} headers x 2 values x {len(lanes)} lanes; statuses {summary}")
    # which of them are refused (403) on owui-B, for the record
    refused = []
    for hn in IDENTITY_HEADERS:
        st, _ = as_seen(MCP, {**HB(tb), hn: SUB_A})
        if st == 403:
            refused.append(hn)
    rec("c.header refusal list (owui-B @mcp, 403)", True, f"refused: {sorted(set(h.lower() for h in refused))}", kind="INFO")
    # duplicate headers (raw HTTP)
    for name, hdrs in [("two Authorization headers (B, then forged A)", [("x-brain-key", K["owui"]), ("authorization", f"Bearer {tb}"), ("authorization", f"Bearer {mint(SUB_A, key=rsa.generate_private_key(public_exponent=65537, key_size=2048))}")]),
                       ("two x-brain-key (owui then full) + B token", [("x-brain-key", K["owui"]), ("x-brain-key", K["full"]), ("authorization", f"Bearer {tb}")]),
                       ("two x-brain-key (full then owui) + B token", [("x-brain-key", K["full"]), ("x-brain-key", K["owui"]), ("authorization", f"Bearer {tb}")])]:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search_thoughts", "arguments": SEARCH}})
        cn = http.client.HTTPConnection("openbrain-mcp", 8000, timeout=60)
        cn.putrequest("POST", "/")
        cn.putheader("content-type", "application/json"); cn.putheader("accept", "application/json, text/event-stream")
        for k, v in hdrs:
            cn.putheader(k, v)
        cn.putheader("content-length", str(len(body)))
        cn.endheaders(body.encode())
        r = cn.getresponse(); t = r.read().decode("utf-8", "replace")
        rec(f"c.dup[{name}]", not a_leaks(t), f"status {r.status}, A leaks {a_leaks(t) or 'none'}")


def write_tools(url, headers):
    return [t for t in tools(url, headers) if not is_read(t)]


def p_noid_writes():
    snap0 = snapshot()
    lanes = [("mcp owui no token", MCP, NOTOK), ("mcp personal", MCP, {"x-brain-key": K["personal"]}),
             ("ext owui no token", EXT, NOTOK), ("ext full key", EXT, {"x-brain-key": K["full"]})]
    ids = {"thought_id": D.q1("SELECT id::text FROM thoughts WHERE content LIKE %s", (f"%{M['a_thought']}%",))[0],
           "idea_id": D.q1("SELECT id::text FROM ideas WHERE owner_sub = %s LIMIT 1", (SUB_A,))[0]}
    listed = {}
    for lane, url, h in lanes:
        ts = tools(url, h)
        listed[lane] = len(ts)
        n_bad = 0
        for t in ts:
            name = t["name"]
            mk = f"MKNOID{random.randrange(16**6):06x}"
            a = args_for(t, mk, ids)
            try:
                st, txt = call(url, h, name, a, timeout=60)
            except Exception as e:
                st, txt = 0, type(e).__name__
            err, body = result_text(txt)
            leak = a_leaks(txt, a)
            if not is_read(t) and not (err or st != 200):
                n_bad += 1
                rec(f"d.noid-write[{lane}] {name}", False, f"a write answered without an error (status {st})")
            if leak:
                rec(f"d.noid-read[{lane}] {name}", False, f"A leaks {leak}")
        rec(f"d.noid writes refused [{lane}]", n_bad == 0, f"{listed[lane]} tools listed, {sum(1 for t in ts if not is_read(t))} writes, {n_bad} answered without an error")
    # mcpo (the inert path): every write tool in its OpenAPI
    try:
        spec = requests.get(f"{MCPO}/open-brain/openapi.json", headers={"authorization": f"Bearer {K['mcpo']}"}, timeout=30).json()
        paths = [p.strip("/") for p in spec.get("paths", {})]
    except Exception:
        paths = []
    mcpo_tools = {t["name"]: t for t in tools(MCP, {"x-brain-key": K["personal"]})}
    nb = 0
    for p in paths:
        t = mcpo_tools.get(p)
        if not t or is_read(t):
            continue
        st, txt = D.mcpo(p, args_for(t, f"MKMCPO{random.randrange(16**6):06x}", ids))
        if st == 200 and "Refused" not in txt and "no verified user identity" not in txt:
            nb += 1
            rec(f"d.mcpo-write {p}", False, f"status {st}")
    rec("d.mcpo writes refused", nb == 0 and bool(paths), f"{len(paths)} mcpo paths, {nb} writes not refused")
    snap1 = snapshot()
    ch = diff(snap0, snap1)
    rec("d.no-identity: the DB is unchanged by every refused write (all public tables, count + content md5)", not ch, f"tables changed: {ch or 'none'}")


def ok_json(txt):
    err, body = result_text(txt)
    try:
        return err, json.loads(body)
    except Exception:
        return err, body


def find_id(obj):
    if isinstance(obj, dict):
        for k in ("id",):
            if isinstance(obj.get(k), str) and re.fullmatch(r"[0-9a-f-]{36}", obj[k]):
                return obj[k]
        for v in obj.values():
            r = find_id(v)
            if r:
                return r
    if isinstance(obj, list):
        for v in obj:
            r = find_id(v)
            if r:
                return r
    return None


EXT_ORDER = ["add_family_member", "add_household_item", "add_vendor", "add_maintenance_task", "log_maintenance", "add_activity",
             "add_important_date", "add_recipe", "create_meal_plan", "generate_shopping_list", "add_professional_contact", "log_interaction",
             "create_opportunity", "add_company", "add_job_posting", "add_job_contact", "submit_application", "schedule_interview"]
ID_FROM = {"add_family_member": "family_member_id", "add_household_item": "item_id", "add_maintenance_task": "task_id", "add_recipe": "recipe_id",
           "add_professional_contact": "contact_id", "add_company": "company_id", "add_job_posting": "job_posting_id", "add_job_contact": "job_contact_id",
           "submit_application": "application_id", "schedule_interview": "interview_id", "add_vendor": "vendor_id", "create_opportunity": "opportunity_id"}


def seed_ext(who_tok, tag, store_strings, store_ids):
    h = HB(who_tok)
    ext_tools = {t["name"]: t for t in tools(EXT, h)}
    ids = {}
    for name in EXT_ORDER:
        t = ext_tools.get(name)
        if not t:
            continue
        mk = f"MK{tag}{name[:6].upper()}{random.randrange(16**6):06x}"
        a = args_for(t, mk, ids)
        st, txt = call(EXT, h, name, a)
        err, body = ok_json(txt)
        if not err:
            store_strings[name] = mk
            i = find_id(body)
            if i and name in ID_FROM:
                ids[ID_FROM[name]] = i
            if i and isinstance(store_ids, dict):
                store_ids[i] = f"{tag}:{name}"
        else:
            print(f"INFO seed {tag} {name} refused: {re.sub(r'MK[A-Z0-9]+', '<mk>', str(body))[:160]!r}", flush=True)
    return ids


def p_cross_user():
    ta, tb = mint(SUB_A), mint(SUB_B)
    # B's own capture (owner B) for the bleed checks
    B_STRINGS["thought"] = f"MKBCAP{random.randrange(16**6):06x}"
    call(MCP, HB(tb), "capture_thought", {"content": "B probe capture " + B_STRINGS["thought"]})
    row = D.q1("SELECT user_id FROM thoughts WHERE content LIKE %s", (f"%{B_STRINGS['thought']}%",))
    rec("e.B capture owned by B", bool(row) and row[0] == SUB_B, f"owner {'B' if row and row[0] == SUB_B else row}")
    st, t = call(MCP, HB(ta), "search_thoughts", SEARCH)
    rec("e.A's search does not show B's capture", B_STRINGS["thought"] not in t and M["a_thought"] in t, f"status {st}")
    # A's private sources / claims: shared knowledge by design; A's thought id for fetch
    a_tid = D.q1("SELECT id::text FROM thoughts WHERE content LIKE %s", (f"%{M['a_thought']}%",))[0]
    a_iid = D.q1("SELECT id::text FROM ideas WHERE owner_sub = %s LIMIT 1", (SUB_A,))[0]
    A_IDS.update({a_tid: "A-thought", a_iid: "A-idea"})
    # A's ext rows through A's own token (A = the operator = DEFAULT_USER_ID)
    a_ext_ids = seed_ext(ta, "AX", A_STRINGS, A_IDS)
    rec("e.seeded A's ext rows as A", len(A_STRINGS) >= 10, f"{len(A_STRINGS)} tools wrote A rows: {sorted(A_STRINGS)}", kind="INFO")
    # B over EVERY tool on both servers, with A's ids wherever a tool takes one
    victim = dict(a_ext_ids)
    victim.update({"thought_id": a_tid, "idea_id": a_iid, "id": a_iid})
    for url, lbl in ((MCP, "mcp"), (EXT, "ext")):
        ts = tools(url, HB(tb))
        leaks = []
        for t in ts:
            name = t["name"]
            v = dict(victim)
            if name in ("fetch",):
                v["id"] = a_tid
            a = args_for(t, f"MKBPROBE{random.randrange(16**6):06x}", v)
            try:
                st, txt = call(url, HB(tb), name, a, timeout=90)
            except Exception as e:
                st, txt = 0, type(e).__name__
            lk = a_leaks(txt, a)
            if lk:
                leaks.append(name)
                rec(f"e.B leak @{lbl} {name}", False, r2=True, what=f"status {st}; A material in B's answer: {sorted(set(lk))}; context: {leak_detail(txt, a)!r}")
        rec(f"e.B over every tool @{lbl}", not leaks, f"{len(ts)} tools; leaking: {leaks or 'none'}", r2=True)
    # A's idea untouched by B's id-bearing writes
    r = q("SELECT status, (SELECT count(*) FROM idea_revisions WHERE idea_id = i.id) FROM ideas i WHERE id = %s", (a_iid,))
    rec("e.A's idea unchanged after B's update/research/promote with its id", True, f"status/revisions now {r}", kind="INFO")
    # nested joins (round 2, F2): B stores A's id in EVERY id-bearing ext write, then reads every nested join back. The write
    # must be refused (a foreign id answers like a missing one) and no read of B's may show A's row.
    day = lambda n: time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400 * n))
    at = lambda n: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400 * n))
    for tool, arg, readback, rargs in [
        ("add_important_date", {"title": "B nested date", "date_value": day(4), "family_member_id": a_ext_ids.get("family_member_id")}, "get_upcoming_dates", DATES),
        ("add_activity", {"title": "B nested activity", "family_member_id": a_ext_ids.get("family_member_id"), "day_of_week": "monday", "start_date": day(0)}, "search_activities", {"query": "B nested"}),
        ("add_activity", {"title": "B nested activity 2", "family_member_id": a_ext_ids.get("family_member_id"), "start_date": day(1)}, "get_week_schedule", {"week_start": day(0)}),
        ("log_maintenance", {"task_id": a_ext_ids.get("task_id"), "notes": "B nested"}, "search_maintenance_history", {}),
        ("create_meal_plan", {"week_start": day(0), "meals": [{"day_of_week": "monday", "meal_type": "dinner", "recipe_id": a_ext_ids.get("recipe_id")}]}, "get_meal_plan", {"week_start": day(0)}),
        ("create_meal_plan", {"week_start": day(7), "meals": [{"day_of_week": "monday", "meal_type": "lunch", "recipe_id": a_ext_ids.get("recipe_id")}]}, "generate_shopping_list", {"week_start": day(7)}),
        ("log_interaction", {"contact_id": a_ext_ids.get("contact_id"), "interaction_type": "email", "summary": "B nested"}, "get_follow_ups_due", {"days_ahead": 400}),
        ("create_opportunity", {"contact_id": a_ext_ids.get("contact_id"), "title": "B nested opp"}, "get_follow_ups_due", {"days_ahead": 400}),
        ("add_job_posting", {"company_id": a_ext_ids.get("company_id"), "title": "B nested posting"}, "get_pipeline_overview", {"days_ahead": 30}),
        ("add_job_contact", {"company_id": a_ext_ids.get("company_id"), "name": "B nested job contact"}, "search_job_contacts", {}),
        ("submit_application", {"job_posting_id": a_ext_ids.get("job_posting_id")}, "get_pipeline_overview", {"days_ahead": 30}),
        ("schedule_interview", {"application_id": a_ext_ids.get("application_id"), "interview_type": "phone_screen", "scheduled_at": at(2)}, "get_upcoming_interviews", {"days_ahead": 30}),
    ]:
        ids_in = [v for k, v in arg.items() if k.endswith("_id")] + [m.get("recipe_id") for m in arg.get("meals", [])]
        if not any(ids_in):
            rec(f"e.nested B->{tool}({readback}) with A's id", False, "A's id is missing (the seed failed): the probe cannot run", r2=True)
            continue
        st, txt = call(EXT, HB(tb), tool, arg)
        err, body = result_text(txt)
        st2, txt2 = call(EXT, HB(tb), readback, rargs)
        lk = a_leaks(txt2, arg) + a_leaks(txt, arg)
        if lk:
            print(f"INFO nested context {tool}: {leak_detail(txt2, arg)!r}", flush=True)
        rec(f"e.nested B->{tool}({readback}) with A's id", err and not lk,
            f"write {'refused' if err else 'ACCEPTED'} ({st}); A material in B's answers: {sorted(set(lk)) or 'none'}", r2=True)
    for name, sql in [("maintenance_logs", "SELECT count(*) FROM maintenance_logs l JOIN maintenance_tasks t ON t.id = l.task_id WHERE t.user_id <> l.user_id"),
                      ("contact_interactions", "SELECT count(*) FROM contact_interactions x JOIN professional_contacts c ON c.id = x.contact_id WHERE c.user_id <> x.user_id"),
                      ("opportunities", "SELECT count(*) FROM opportunities x JOIN professional_contacts c ON c.id = x.contact_id WHERE c.user_id <> x.user_id"),
                      ("interviews", "SELECT count(*) FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.user_id <> i.user_id"),
                      ("applications", "SELECT count(*) FROM applications ap JOIN job_postings jp ON jp.id = ap.job_posting_id WHERE jp.user_id <> ap.user_id"),
                      ("job_postings / job_contacts", "SELECT (SELECT count(*) FROM job_postings x JOIN companies c ON c.id = x.company_id WHERE c.user_id <> x.user_id) + (SELECT count(*) FROM job_contacts x JOIN companies c ON c.id = x.company_id WHERE c.user_id <> x.user_id)"),
                      ("meal_plans", "SELECT count(*) FROM meal_plans mp JOIN recipes r ON r.id = mp.recipe_id WHERE r.user_id <> mp.user_id"),
                      ("activities / important_dates", "SELECT (SELECT count(*) FROM activities x JOIN family_members f ON f.id = x.family_member_id WHERE f.user_id <> x.user_id) + (SELECT count(*) FROM important_dates x JOIN family_members f ON f.id = x.family_member_id WHERE f.user_id <> x.user_id)")]:
        n = q(sql)[0][0]
        rec(f"e.no cross-owner row in {name}", n == 0, f"{n} row(s) referencing another owner's row", r2=True)
    # link_thought_to_contact: B links A's thought to B's own contact
    bid = {}
    seed_ext(tb, "BX", B_STRINGS, None)
    st, txt = call(EXT, HB(tb), "add_professional_contact", {"name": "B contact for link"})
    _, body = ok_json(txt)
    bc = find_id(body)
    st, txt = call(EXT, HB(tb), "link_thought_to_contact", {"thought_id": a_tid, "contact_id": bc})
    err, body = result_text(txt)
    rec("e.link_thought_to_contact(A's thought, B's contact) refused", err and not a_leaks(txt), f"status {st}, error {err}, A leaks {a_leaks(txt) or 'none'}")
    st, txt = call(EXT, HB(ta), "link_thought_to_contact", {"thought_id": a_tid, "contact_id": bc})
    err, body = result_text(txt)
    rec("e.link_thought_to_contact(A's thought, B's contact) as A refused", err, f"status {st}, error {err}")
    # A's non-admin reads never show B's ext rows
    leaksB = []
    for t in tools(EXT, HB(ta)):
        if not is_read(t) and not t["name"].startswith(("get_", "search_", "list_")):
            continue
        st, txt = call(EXT, HB(ta), t["name"], args_for(t, "MKAREAD", {}))
        if any(s in txt for s in B_STRINGS.values()):
            leaksB.append(t["name"])
    rec("e.A's ext reads show none of B's rows", not leaksB, f"leaking: {leaksB or 'none'}")
    # the contract tools against the REAL workbench (live parity: no forward-auth, WORKBENCH_KEY = MCP_ACCESS_KEY) - round 2, F1
    B_STRINGS["idea"] = f"MKBIDEA{random.randrange(16**6):06x}"
    call(MCP, HB(tb), "capture_idea", {"title": "B wb idea " + B_STRINGS["idea"], "idea": "B workbench idea text " + B_STRINGS["idea"]})
    # A's idea job: a research job is shared research output (07-MULTI-USER: another user sees the shared job, never its
    # prompt or its tie to the idea), so its id is NOT A material; what is A's: the idea's id, title, text, the job's
    # refinery_id / query / inlet_ref - all already in A_IDS / the markers / "A lab marker idea"
    a_job = (q("SELECT id::text FROM research_jobs ORDER BY created_at LIMIT 1") or [[None]])[0][0]
    for tool, a in [("contract_ideas", {}), ("contract_idea", {"id": a_iid}), ("contract_jobs", {}), ("contract_search", {"q": "lab marker"}),
                    ("contract_documents", {}), ("contract_session", {"id": a_job} if a_job else {}), ("contract_timeline", {}), ("contract_trail", {})]:
        for who, h in (("B", HB(tb)), ("no-identity", NOTOK), ("personal (mcpo)", {"x-brain-key": K["personal"]})):
            st, txt = call(MCP, h, tool, a)
            lk = a_leaks(txt, a)
            if lk:
                print(f"INFO workbench context {tool} {who}: {leak_detail(txt, a)!r}", flush=True)
            rec(f"e.workbench {tool} as {who}", not lk, r2=tool in ("contract_ideas", "contract_idea", "contract_jobs", "contract_session"), what= f"status {st}; A material: {sorted(set(lk)) or 'none'}; answer head: {re.sub(r'[0-9a-f-]{36}', '<uuid>', result_text(txt)[1])[:160]!r}")
    st, txt = call(MCP, HB(tb), "contract_ideas", {})
    # B's idea from the driver's T2 (a second capture here is a near-duplicate of it under the lab's one embedding)
    rec("e.workbench contract_ideas as B shows B's own idea", (M["b_idea"] in txt or B_STRINGS["idea"] in txt) and "A lab marker idea" not in txt, f"status {st}", r2=True)
    st, txt = call(MCP, HB(ta), "contract_ideas", {})
    rec("e.workbench contract_ideas as A (owui token) shows A's idea, not B's", "A lab marker idea" in txt and B_STRINGS["idea"] not in txt and M["b_idea"] not in txt, f"status {st}")
    st, txt = call(MCP, {"x-brain-key": K["full"]}, "contract_ideas", {})
    rec("e.workbench contract_ideas as the operator (full key) shows A's idea", "A lab marker idea" in txt, f"status {st}")
    wbu = E.get("workbench")
    if wbu:
        def wbget(h):
            try:
                r = requests.get(f"{wbu}/workbench/contract/ideas", headers=h, timeout=30)
                return r.status_code, r.text
            except Exception as e:
                return 0, type(e).__name__
        evil = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        swapped = (lambda t: t.split(".")[0] + "." + b64u(json.dumps(std_claims(sub=SUB_A)).encode()) + "." + t.split(".")[2])(tb)
        for name, h, want in [
            ("mcp key + a token signed by another key naming A", {"x-brain-key": E["wb_mcp_key"], "x-ob-user-token": mint(SUB_A, key=evil)}, 401),
            ("mcp key + B's token re-written to name A", {"x-brain-key": E["wb_mcp_key"], "x-ob-user-token": swapped}, 401),
            ("owui's workbench key + B's token", {"x-brain-key": E["wb_owui_key"], "x-ob-user-token": tb}, 403),
            ("mcp key + B's token + x-on-behalf-of A", {"x-brain-key": E["wb_mcp_key"], "x-ob-user-token": tb, "x-on-behalf-of": SUB_A}, 403),
        ]:
            st, t = wbget(h)
            # x-on-behalf-of from the mcp key was 403 on round 1 too (only owui's key may send it): a regression check, not R2
            rec(f"e.workbench direct: {name}", st == want and not a_leaks(t), f"status {st} (want {want}); A material {a_leaks(t) or 'none'}", r2="x-on-behalf-of" not in name)
        st, t = wbget({"x-brain-key": E["wb_mcp_key"]})
        rec("e.workbench direct: the mcp key alone is nobody", st == 200 and not a_leaks(t), f"status {st}; A material {a_leaks(t) or 'none'}")


def p_concurrency():
    ta, tb = mint(SUB_A), mint(SUB_B)
    # B's own date on ext for the bleed check
    B_STRINGS["date"] = f"MKBDATE{random.randrange(16**6):06x}"
    call(EXT, HB(tb), "add_important_date", {"title": "B conc " + B_STRINGS["date"], "date_value": time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400 * 6))})
    plan = []
    for i in range(300):
        plan.append(random.choice(["A-mcp", "B-mcp", "N-mcp", "A-ext", "B-ext", "N-ext", "bad-tok", "abort", "err-args", "slow-B"]))

    def one(i):
        kind = plan[i]
        try:
            if kind == "abort":
                s = socket.create_connection(("openbrain-mcp", 8000), timeout=5)
                body = json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": "search_thoughts", "arguments": SEARCH}})
                tok = ta if i % 2 else tb
                s.sendall((f"POST / HTTP/1.1\r\nHost: openbrain-mcp\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\n"
                           f"x-brain-key: {K['owui']}\r\nauthorization: Bearer {tok}\r\ncontent-length: {len(body)}\r\n\r\n{body}").encode())
                s.close()
                return kind, 0, ""
            if kind == "bad-tok":
                st, t = call(MCP, HB(mint(SUB_A, key=rsa.generate_private_key(public_exponent=65537, key_size=1024))), "search_thoughts", SEARCH, rid=i)
                return kind, st, t
            if kind == "err-args":
                st, t = call(MCP, HB(ta), "fetch", {"id": "not-a-uuid"}, rid=i)
                return kind, st, t
            if kind == "slow-B":
                st, t = call(MCP, HB(tb), "contract_search", {"q": "lab marker"}, rid=i)
                return kind, st, t
            who, srv = kind.split("-")
            h = {"A": HB(ta), "B": HB(tb), "N": NOTOK}[who]
            url = MCP if srv == "mcp" else EXT
            st, t = as_seen(url, h)
            return kind, st, t
        except Exception as e:
            return kind, -1, type(e).__name__

    with ThreadPoolExecutor(24) as ex:
        out = list(ex.map(one, range(len(plan))))
    bad = []
    for i, (kind, st, t) in enumerate(out):
        if kind == "abort":
            continue
        if kind == "bad-tok":
            ok = st == 401
        elif kind == "err-args":
            ok = st == 200 and M["shared"] not in t
        elif kind == "slow-B":
            ok = not a_leaks(t) or True  # the workbench leak is reported in e.; here only the thought markers
            ok = st == 200 and M["a_thought"] not in t
        elif kind == "A-mcp":
            ok = st == 200 and M["a_thought"] in t and B_STRINGS["thought"] not in t
        elif kind == "B-mcp":
            ok = st == 200 and M["a_thought"] not in t and B_STRINGS["thought"] in t
        elif kind == "N-mcp":
            ok = st == 200 and M["a_thought"] not in t and B_STRINGS["thought"] not in t and M["shared"] in t
        elif kind == "A-ext":
            ok = st == 200 and M["a_ext"] in t and B_STRINGS["date"] not in t
        elif kind == "B-ext":
            ok = st == 200 and M["a_ext"] not in t and B_STRINGS["date"] in t
        else:  # N-ext
            ok = st == 200 and M["a_ext"] not in t and B_STRINGS["date"] not in t and result_text(t)[0]
        if not ok:
            bad.append((i, kind, st))
    counts = {}
    for k in plan:
        counts[k] = counts.get(k, 0) + 1
    rec("f.300 interleaved A / B / no-identity / bad-token / aborted / erroring / slow calls, 24 at a time", not bad,
        f"mix {counts}; wrong {len(bad)}: {bad[:10]}")
    # after the storm: a fresh no-identity call and a fresh B call still resolve to themselves (no leftover context)
    st, t = as_seen(MCP, NOTOK)
    st2, t2 = as_seen(MCP, HB(tb))
    rec("f.no leftover identity after aborts / errors", M["a_thought"] not in t and B_STRINGS["thought"] not in t and M["a_thought"] not in t2,
        f"no-identity {st}, B {st2}")


def p_full_lane():
    st, t = call(MCP, {"x-brain-key": K["full"]}, "search_thoughts", SEARCH)
    rec("h.full key reads as the operator", st == 200 and M["a_thought"] in t and B_STRINGS.get("thought", "zz") not in t, f"status {st}")
    mk = f"MKOPFULL{random.randrange(16**6):06x}"
    call(MCP, {"x-brain-key": K["full"]}, "capture_thought", {"content": "operator full " + mk})
    row = D.q1("SELECT user_id FROM thoughts WHERE content LIKE %s", (f"%{mk}%",))
    rec("h.full key capture stamped with the operator's subject", bool(row) and row[0] == SUB_A, f"owner {'A' if row and row[0] == SUB_A else row}")
    st, t = call(MCP + "?key=" + K["full"], {}, "search_thoughts", SEARCH)
    rec("h.full key in ?key= reads as the operator", st == 200 and M["a_thought"] in t, f"status {st}")
    st, t = call(MCP, {"x-brain-key": K["full"]}, "", {}, method="tools/list")
    rec("h.full key lists the agent-memory tools", "agent_memory_writeback" in t, f"status {st}")
    st, t = call(MCP, NOTOK, "", {}, method="tools/list")
    rec("h.owui lane does not list the agent-memory tools", st == 200 and "agent_memory_" not in t, f"status {st}")
    r = requests.post(MCP.rstrip("/") + "/agent-memory/recall", headers={"x-brain-key": K["owui"], "authorization": f"Bearer {mint(SUB_A)}", "content-type": "application/json"}, json={"workspace_id": "ai-stack", "query": "lab"}, timeout=30)
    rec("h.agent-memory REST refuses the owui lane (even A's token)", r.status_code == 401, f"status {r.status_code}")
    r = requests.get(MCP.rstrip("/") + "/research/lookup?key=x", headers={"x-brain-key": K["owui"], "authorization": f"Bearer {mint(SUB_A)}"}, timeout=30)
    rec("h.research REST refuses the owui lane", r.status_code in (401, 403), f"status {r.status_code}")


def p_owui_key_exposure():
    S = D.load()
    b = S["b"][0]
    hits = []
    for path in ("/api/v1/tools/", "/api/v1/configs/tool_servers", "/api/v1/tools/list", "/api/config", "/api/v1/users/user/settings",
                 "/api/models", "/api/v1/configs/", "/api/v1/auths/", "/api/v1/tools/id/server:mcp:open-brain"):
        try:
            r = b.get(D.OWUI + path, timeout=30)
            if K["owui"] in r.text or K["full"] in r.text:
                hits.append(f"{path} ({r.status_code})")
        except Exception:
            pass
    rec("c.B (non-admin) cannot read the lane key from Open WebUI's API", not hits, f"exposed at: {hits or 'none'}")


def main():
    for f in (p_owui_key_exposure, p_tokens, p_key_vs_token, p_headers, p_noid_writes, p_cross_user, p_concurrency, p_full_lane):
        try:
            f()
        except Exception as e:
            import traceback
            rec(f"{f.__name__} crashed", False, f"{type(e).__name__}: {str(e)[:300]} :: {traceback.format_exc()[-600:]!r}")
    mode = E.get("probe_mode", "green")
    bad = [p for p, t in RES if t == "FAIL"]
    good = [p for p, t in RES if t == "PASS"]
    print(f"== PROBES ({mode}): {len(good)} PASS / {len(bad)} FAIL / {sum(1 for _, t in RES if t == 'INFO')} INFO; R2 probes {len(R2)}", flush=True)
    if mode == "green":
        sys.exit(1 if bad else 0)
    r2_passing = [p for p in good if p in R2]
    others_failing = [p for p in bad if p not in R2]
    print(f"== RED: R2 probes failing {len([p for p in bad if p in R2])} of {len(R2)}; R2 passing (must be none): {r2_passing[:20]}", flush=True)
    if mode == "red-r2":
        print(f"== RED: non-R2 probes failing (must be none on 27504ae): {others_failing[:20]}", flush=True)
        sys.exit(0 if R2 and not r2_passing and not others_failing else 1)
    # red-r1 (51f00ea, before this item): B IS the operator there, so a probe that needs two owners' rows ("no cross-owner
    # row") cannot fail; every other R2 probe must
    single_user = [p for p in r2_passing if p.startswith("e.no cross-owner row")]
    print(f"== RED: R2 probes that need two owners and hold trivially on a one-subject base: {single_user}", flush=True)
    sys.exit(0 if R2 and not [p for p in r2_passing if p not in single_user] else 1)


if __name__ == "__main__":
    main()
