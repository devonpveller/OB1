"""driver.py - the rw-mcp-identity lab's checks (run inside the lab network with the Open WebUI image's Python).

Each case prints `PASS <case>: <what>` or `FAIL <case>: <what>`; exit 0 only when every check passed (with LAB_EXPECT=red,
exit 0 only when every RED-marked check FAILED, i.e. the base shows the defect). Markers are synthetic strings; the
driver never prints a token, a key or a row's text - only the marker names it found.

Paths exercised:
  OWUI    the REAL Open WebUI (v0.11.0) chat API: A, B and C signed in through the stub OpenID provider; the chat's
          tool_ids name the native MCP connections (server:mcp:open-brain / server:mcp:open-brain-ext), so Open WebUI's own
          code builds the per-user headers (system_oauth) and calls the MCP server.
  MCPO    the REAL openbrain-mcpo (mcpo v0.0.20, the stack's Dockerfile) in front of openbrain-mcp (the personal lane).
  RAW     a caller off Open WebUI's path: MCP requests straight to openbrain-mcp / openbrain-ext with forged headers or tokens.
"""
import base64, json, os, re, sys, time, urllib.parse, uuid
from concurrent.futures import ThreadPoolExecutor

import jwt
import psycopg2
import requests
from cryptography.hazmat.primitives.asymmetric import rsa

E = json.load(open(os.environ.get("LAB_CFG_FILE", "/state/cfg.json")))
# openbrain-ext's row owners: the operator keeps DEFAULT_USER_ID; B gets the UUIDv5 of their subject (mcp-identity.ts
# EXT_USER_NAMESPACE; Python's uuid5 is the same RFC 4122 algorithm, checked against a known vector in mcp-identity.test.ts)
E["ext_a"] = E["default_user_id"]
E["ext_b"] = str(uuid.uuid5(uuid.UUID("6f1b3c2e-9a4d-5e8f-b7c6-0d1e2f3a4b5c"), E["subs"]["b"]))
OWUI = E["owui"]            # http://owui:8080
MCP = E["mcp"]              # http://openbrain-mcp:8000/
EXT = E["ext"]              # http://openbrain-ext:8000/
MCPO = E["mcpo"]            # http://openbrain-mcpo:8000
K = E["keys"]               # full, personal, owui, mcpo
M = E["markers"]            # name -> marker string
MODE = E.get("mode", "green")
ONLY = set(filter(None, (E.get("cases") or "").split(",")))
results = []


def check(case, ok, what, red=True):
    """red=True: this check states the item's bar, so on the base (LAB_EXPECT red) it must FAIL."""
    results.append((case, bool(ok), what, red))
    print(f"{'PASS' if ok else 'FAIL'} {case}: {what}", flush=True)


def found(text, names):
    return [n for n in names if M[n] in (text or "")]


def db():
    return psycopg2.connect(E["db_dsn"])


def q1(sql, args=()):
    with db() as c, c.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone()


# ---- the OAuth sign-in through the real Open WebUI ----------------------------------------------------------------
def login(user):
    s = requests.Session()
    r = s.get(f"{OWUI}/oauth/oidc/login", allow_redirects=False, timeout=30)
    assert r.status_code in (302, 307), f"login start {r.status_code}"
    loc = r.headers["location"]
    r = s.get(loc + ("&" if "?" in loc else "?") + "lab_user=" + user, allow_redirects=False, timeout=30)
    assert r.status_code == 302, f"authorize {r.status_code}"
    r = s.get(r.headers["location"], allow_redirects=False, timeout=60)
    assert r.status_code in (302, 307), f"callback {r.status_code} {r.text[:200]}"
    tok = s.cookies.get("token")
    assert tok, "no Open WebUI session after the callback"
    s.headers["authorization"] = f"Bearer {tok}"
    me = s.get(f"{OWUI}/api/v1/auths/", timeout=30).json()
    return s, me


def chat(s, text, servers):
    body = {"model": "lab-model", "stream": False, "messages": [{"role": "user", "content": text}],
            "tool_ids": [f"server:mcp:{x}" for x in servers],
            # Open WebUI's server-side tool step (legacy function calling): the API answer then carries the tool results.
            # The connection lookup, the per-user headers (system_oauth) and the MCP client are the same code as native mode.
            "params": {"function_calling": "legacy"}}
    r = s.post(f"{OWUI}/api/chat/completions", json=body, timeout=180)
    return r.status_code, r.text


# ---- raw MCP (streamable HTTP, stateless) ----------------------------------------------------------------------------
def mcp(url, headers, tool, args, rid=1):
    h = {"content-type": "application/json", "accept": "application/json, text/event-stream", **headers}
    body = {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    r = requests.post(url, headers=h, json=body, timeout=120)
    text = r.text
    if "text/event-stream" in r.headers.get("content-type", ""):
        datas = [l[5:].strip() for l in text.splitlines() if l.startswith("data:")]
        text = "\n".join(datas)
    return r.status_code, text


def is_error(text):
    try:
        for line in text.splitlines():
            d = json.loads(line)
            if d.get("error") or (d.get("result") or {}).get("isError"):
                return True
    except Exception:
        pass
    return False


def mcpo(tool, args):
    r = requests.post(f"{MCPO}/open-brain/{tool}", headers={"authorization": f"Bearer {K['mcpo']}"}, json=args, timeout=120)
    return r.status_code, r.text


# ---- forged tokens ----------------------------------------------------------------------------------------------------
EVIL = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def forge(sub, kid=None):
    now = int(time.time())
    c = {"iss": E["iss"], "aud": E["aud"], "azp": E["aud"], "sub": sub, "iat": now, "exp": now + 600}
    return jwt.encode(c, EVIL, algorithm="RS256", headers={"kid": kid or E.get("kid", "lab")})


def resign_claims(token, **patch):
    h, p, s = token.split(".")
    pad = lambda x: x + "=" * (-len(x) % 4)
    claims = json.loads(base64.urlsafe_b64decode(pad(p)))
    claims.update(patch)
    p2 = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"{h}.{p2}.{s}"


_TOK = {}


def user_token(who):
    """An access token the stub provider issues to lab user `who` - the same kind Open WebUI holds for them (the code
    flow with the lab client's credentials, as Open WebUI's own callback does)."""
    if who not in _TOK:
        oidc = E["oidc_base"]
        r = requests.get(f"{oidc}/authorize/", params={"client_id": E["aud"], "redirect_uri": "http://driver.invalid/cb",
                                                     "response_type": "code", "state": "x", "lab_user": who}, allow_redirects=False, timeout=30)
        code = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["location"]).query)["code"][0]
        t = requests.post(f"{oidc}/token/", data={"grant_type": "authorization_code", "code": code, "redirect_uri": "http://driver.invalid/cb"},
                          auth=(E["aud"], E["client_secret"]), timeout=30).json()
        _TOK[who] = t["access_token"]
    return _TOK[who]


ALL_A = ["a_thought", "a_idea", "a_ext"]
READS = [  # (case, server, tool, args, markers that are A's private ones, shared marker expected)
    ("T1 search_thoughts", "open-brain", "search_thoughts", {"query": "lab marker", "limit": 50, "threshold": 0.0}),
    ("T1 list_thoughts", "open-brain", "list_thoughts", {"limit": 50}),
    ("T1 search", "open-brain", "search", {"query": "lab marker"}),
    ("T1 find_idea", "open-brain", "find_idea", {"query": "lab marker idea", "threshold": 0.0, "limit": 20}),
    ("T1 ext get_upcoming_dates", "open-brain-ext", "get_upcoming_dates", {"days_ahead": 400}),
]


def sel(case):
    return not ONLY or any(case.startswith(o) for o in ONLY)


STATE = "/state/sessions.json"


def save(sessions):
    json.dump({k: {"cookies": requests.utils.dict_from_cookiejar(s.cookies), "auth": s.headers["authorization"], "me": me}
               for k, (s, me) in sessions.items()}, open(STATE, "w"))


def load():
    out = {}
    for k, v in json.load(open(STATE)).items():
        s = requests.Session()
        s.cookies = requests.utils.cookiejar_from_dict(v["cookies"])
        s.headers["authorization"] = v["auth"]
        out[k] = (s, v["me"])
    return out


def main():
    if sys.argv[1:] == ["login"]:
        sessions = {u: login(u) for u in ("a", "b", "c")}
        save(sessions)
        print(json.dumps({u: me["id"] for u, (_, me) in sessions.items()}))
        return
    S = load()
    (a, me_a), (b, me_b), (c, me_c) = S["a"], S["b"], S["c"]
    check("T0 sign-in", me_a.get("role") == "admin" and me_b.get("role") == "user", "A (first) is admin, B and C are users", red=False)

    # ---- T1: B reads none of A's private rows through Open WebUI's MCP tools; A reads them --------------------------------
    for case, server, tool, args in READS:
        if not sel(case):
            continue
        call = f"CALL {tool} {json.dumps(args)}"
        _, tb = chat(b, call, [server])
        _, ta = chat(a, call, [server])
        leak = found(tb, ALL_A)
        check(case + " (B)", not leak, f"B's answer holds A's markers: {leak or 'none'}")
        if tool in ("search_thoughts", "list_thoughts", "search"):
            check(case + " (B shared)", "shared" in found(tb, ["shared"]), "B reads the shared row", red=False)
            check(case + " (A)", "a_thought" in found(ta, ALL_A), "A reads A's private thought as before", red=False)
        if tool == "find_idea":
            check(case + " (A)", "a_idea" in found(ta, ALL_A), "A finds A's idea as before", red=False)
        if tool == "get_upcoming_dates":
            check(case + " (A)", "a_ext" in found(ta, ALL_A), "A reads A's household date as before", red=False)
    # fetch by id (the ChatGPT shape) and thought_stats
    if sel("T1 fetch"):
        aid = q1("SELECT id::text FROM thoughts WHERE content LIKE %s", (f"%{M['a_thought']}%",))[0]
        _, tb = chat(b, f"CALL fetch {json.dumps({'id': aid})}", ["open-brain"])
        _, ta = chat(a, f"CALL fetch {json.dumps({'id': aid})}", ["open-brain"])
        check("T1 fetch (B)", not found(tb, ["a_thought"]), "B cannot fetch A's thought by its id")
        check("T1 fetch (A)", bool(found(ta, ["a_thought"])), "A fetches it", red=False)

    # ---- T2: B's writes are B's, invisible to A ---------------------------------------------------------------------------
    if sel("T2"):
        _, tb = chat(b, f"CALL capture_thought {json.dumps({'content': 'B capture ' + M['b_thought']})}", ["open-brain"])
        row = q1("SELECT user_id FROM thoughts WHERE content LIKE %s", (f"%{M['b_thought']}%",))
        check("T2 capture_thought owner", row is not None and row[0] == E["subs"]["b"], f"B's capture is owned by B (owner {'B' if row and row[0] == E['subs']['b'] else ('NULL' if row and row[0] is None else ('missing' if not row else 'other'))})")
        _, ta = chat(a, f"CALL search_thoughts {json.dumps({'query': 'B capture', 'limit': 50, 'threshold': 0.0})}", ["open-brain"])
        check("T2 A cannot read B's capture", not found(ta, ["b_thought"]), "A's search does not show B's capture")
        _, tb = chat(b, f"CALL capture_idea {json.dumps({'title': 'B idea', 'idea': 'B idea text ' + M['b_idea']})}", ["open-brain"])
        row = q1("SELECT owner_sub FROM ideas WHERE summary LIKE %s", (f"%{M['b_idea']}%",))
        check("T2 capture_idea owner", row is not None and row[0] == E["subs"]["b"], "B's idea is owned by B")
        _, ta = chat(a, f"CALL find_idea {json.dumps({'query': 'B idea text', 'threshold': 0.0, 'limit': 20})}", ["open-brain"])
        check("T2 A cannot find B's idea", not found(ta, ["b_idea"]), "A's find_idea does not show B's idea")
        _, tb = chat(b, f"CALL add_important_date {json.dumps({'title': 'B date ' + M['b_ext'], 'date_value': time.strftime('%Y-%m-%d', time.gmtime(time.time() + 86400 * 5))})}", ["open-brain-ext"])
        row = q1("SELECT user_id::text FROM important_dates WHERE title LIKE %s", (f"%{M['b_ext']}%",))
        check("T2 ext owner", row is not None and row[0] == E["ext_b"], f"B's household date is B's own row ({'B' if row and row[0] == E['ext_b'] else ('A' if row and row[0] == E['ext_a'] else 'missing')})")
        _, ta = chat(a, f"CALL get_upcoming_dates {json.dumps({'days_ahead': 400})}", ["open-brain-ext"])
        check("T2 A cannot read B's date", not found(ta, ["b_ext"]), "A's dates do not show B's")
        _, tb = chat(b, f"CALL get_upcoming_dates {json.dumps({'days_ahead': 400})}", ["open-brain-ext"])
        check("T2 B reads B's own date", bool(found(tb, ["b_ext"])), "B reads their own date", red=False)

    # ---- T3: no identity (C's Open WebUI user with no SSO session) = shared reads only, every write refused ------------
    if sel("T3"):
        _, tc = chat(c, f"CALL search_thoughts {json.dumps({'query': 'lab marker', 'limit': 50, 'threshold': 0.0})}", ["open-brain"])
        check("T3 no identity reads shared only", not found(tc, ALL_A + ["b_thought"]) and "shared" in found(tc, ["shared"]), f"C (no token) reads shared only (private markers: {found(tc, ALL_A + ['b_thought']) or 'none'})")
        before = q1("SELECT count(*) FROM thoughts")[0]
        _, tc = chat(c, f"CALL capture_thought {json.dumps({'content': 'C capture ' + M['c_thought']})}", ["open-brain"])
        after = q1("SELECT count(*) FROM thoughts")[0]
        check("T3 no identity cannot write", after == before and q1("SELECT count(*) FROM thoughts WHERE content LIKE %s", (f"%{M['c_thought']}%",))[0] == 0, "C's capture is refused, nothing written")
        st, t = mcp(MCP, {"x-brain-key": K["owui"]}, "create_thread", {"name": "C thread " + M["c_thought"]})
        check("T3 no identity cannot write shared knowledge", is_error(t) and q1("SELECT count(*) FROM threads WHERE name LIKE %s", (f"%{M['c_thought']}%",))[0] == 0, "a shared-knowledge write (create_thread) without identity is refused")
        _, tc = chat(c, f"CALL get_upcoming_dates {json.dumps({'days_ahead': 400})}", ["open-brain-ext"])
        check("T3 no identity: no household rows", not found(tc, ["a_ext", "b_ext"]), "C reads no one's household rows")

    # ---- T4: forged identity is refused ----------------------------------------------------------------------------------
    if sel("T4"):
        args = {"query": "lab marker", "limit": 50, "threshold": 0.0}
        for name, url, h in [
            ("full + x-on-behalf-of", MCP, {"x-brain-key": K["full"], "x-on-behalf-of": E["subs"]["b"]}),
            ("full + X-OpenWebUI-User-Id", MCP, {"x-brain-key": K["full"], "X-OpenWebUI-User-Id": me_b["id"]}),
            ("personal + bearer of B", MCP, {"x-brain-key": K["personal"], "authorization": f"Bearer {user_token('b')}"}),
            ("owui + x-on-behalf-of A", MCP, {"x-brain-key": K["owui"], "authorization": f"Bearer {user_token('b')}", "x-on-behalf-of": E["subs"]["a"]}),
            ("ext owui + x-ob-user", EXT, {"x-brain-key": K["owui"], "x-ob-user": E["subs"]["a"]}),
        ]:
            st, t = mcp(url, h, "search_thoughts" if url == MCP else "get_upcoming_dates", args if url == MCP else {"days_ahead": 400})
            check(f"T4 forged header ({name})", st == 403 and not found(t, ALL_A), f"refused 403 (got {st}; A's markers {found(t, ALL_A) or 'none'})")
        for name, tok in [
            ("a token signed by another key, naming A", forge(E["subs"]["a"])),
            ("B's token re-written to name A", resign_claims(user_token("b"), sub=E["subs"]["a"])),
            ("B's token, expired", resign_claims(user_token("b"), exp=int(time.time()) - 3600)),
            ("A's token for another audience", resign_claims(user_token("a"), aud="another-client")),
        ]:
            for url in (MCP, EXT):
                st, t = mcp(url, {"x-brain-key": K["owui"], "authorization": f"Bearer {tok}"},
                            "search_thoughts" if url == MCP else "get_upcoming_dates", args if url == MCP else {"days_ahead": 400})
                check(f"T4 forged token ({name}) @{'mcp' if url == MCP else 'ext'}", st == 401 and not found(t, ALL_A), f"refused 401 (got {st})")
        # B claiming A through Open WebUI: B's session can only ever send B's own token
        _, tb = chat(b, f"CALL search_thoughts {json.dumps({**args, 'user_id': E['subs']['a'], 'owner': E['subs']['a']})}", ["open-brain"])
        check("T4 B names A in tool arguments", not found(tb, ALL_A), "an argument naming A changes nothing")

    # ---- T5: the operator's own clients (the full lane) work as the operator ------------------------------------------------
    if sel("T5"):
        st, t = mcp(MCP, {"x-brain-key": K["full"]}, "search_thoughts", {"query": "lab marker", "limit": 50, "threshold": 0.0})
        check("T5 full lane reads as the operator", st == 200 and "a_thought" in found(t, ALL_A), f"the full key reads A's private thought ({st})", red=False)
        st, t = mcp(MCP, {"x-brain-key": K["full"]}, "capture_thought", {"content": "operator capture " + M["op_thought"]})
        row = q1("SELECT user_id FROM thoughts WHERE content LIKE %s", (f"%{M['op_thought']}%",))
        check("T5 full lane capture is the operator's", row is not None and row[0] == E["subs"]["a"], "a Claude Code capture is stamped with the operator's subject")
        st, t = mcp(MCP, {"x-brain-key": K["full"]}, "agent_memory_writeback",
                    {"workspace_id": "ai-stack", "summary": "lab memory", "content": "lab memory " + M["op_memory"], "memory_type": "lesson"})
        row = q1("SELECT t.user_id FROM thoughts t WHERE t.content LIKE %s", (f"%{M['op_memory']}%",))
        why = "" if row else f"; the tool answered {st}: {re.sub(r'eyJ[A-Za-z0-9_.-]+', '<jwt>', t)[:400]}"
        check("T5 agent memory thought is the operator's", row is not None and row[0] == E["subs"]["a"], f"the agent memory's thought is stamped with the operator ({'ok' if row and row[0] == E['subs']['a'] else ('NULL' if row else 'not written')}){why}")
        st, t = mcp(MCP, {"x-brain-key": K["full"]}, "contract_search", {"q": "lab"})
        st2, t2 = mcp(MCP, {"x-brain-key": K["owui"], "authorization": f"Bearer {user_token('b')}"}, "contract_search", {"q": "lab"})
        flat = (t + t2).lower()
        check("T5 contract tools send no user identity", "lab_workbench" in flat and "x-on-behalf-of" not in flat and "x-openwebui" not in flat and "authorization" not in flat,
              "the workbench calls (full lane and B) carry the service key and no user header: the workbench serves them its service view", red=False)

    # ---- T6: the old mcpo path is inert (shared only, no writes) -----------------------------------------------------------
    if sel("T6"):
        st, t = mcpo("search_thoughts", {"query": "lab marker", "limit": 50, "threshold": 0.0})
        check("T6 mcpo reads shared only", not found(t, ALL_A + ["b_thought"]), f"through openbrain-mcpo nobody reads a private row ({st}; {found(t, ALL_A + ['b_thought']) or 'none'})")
        st, t = mcpo("capture_thought", {"content": "mcpo capture " + M["mcpo_thought"]})
        check("T6 mcpo cannot write", q1("SELECT count(*) FROM thoughts WHERE content LIKE %s", (f"%{M['mcpo_thought']}%",))[0] == 0, f"a capture through openbrain-mcpo is refused ({st})")

    # ---- T7: concurrent users never get each other's answers ---------------------------------------------------------------
    if sel("T7"):
        def one(i):
            who = "a" if i % 2 == 0 else "b"
            st, t = mcp(MCP, {"x-brain-key": K["owui"], "authorization": f"Bearer {user_token(who)}"}, "search_thoughts",
                        {"query": "lab marker", "limit": 50, "threshold": 0.0}, rid=i)
            return who, st, t
        with ThreadPoolExecutor(16) as ex:
            out = list(ex.map(one, range(48)))
        bad = [i for i, (who, st, t) in enumerate(out) if st != 200 or (who == "b" and found(t, ALL_A)) or (who == "a" and not found(t, ["a_thought"]))]
        check("T7 48 interleaved A/B calls", not bad, f"each answer is its own caller's ({len(bad)} wrong)")

    reds = [r for r in results if r[3]]
    if MODE == "red":
        failed = [r for r in reds if not r[1]]
        print(f"== RED: {len(failed)} of {len(reds)} bar checks FAILED on the base (expected: all)")
        sys.exit(0 if reds and len(failed) == len(reds) else 1)
    bad = [r for r in results if not r[1]]
    print(f"== GREEN: {len(results) - len(bad)} PASS / {len(bad)} FAIL")
    sys.exit(0 if not bad else 1)


if __name__ == "__main__":
    main()
