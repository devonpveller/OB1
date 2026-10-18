"""The e2e client (runs in a throwaway container on the internal test network, like a connector).

    python client.py <plan.json> <out.json>

The plan is a list of steps:
  {"name", "method", "path", "headers": {...}, "body_b64": "...", "declare": "<Content-Length>",
   "no_body": true}                       one request; the response status, JSON body and time
  {"name", "wait_healthz": seconds}       poll GET /healthz until 200 (or give up)
  {"name", "sleep": seconds}
  {"name", "build": {"kind": "shape"|"fixture", "id", "external_id", "connector", "source"},
   "headers": {...}}                      the envelope is built HERE from tests/e2e/shapes.py (raw
                                          as base64), then POSTed to /v1/intake
The host is INTAKE_E2E_HOST (default openbrain-intake), port 8000. Standard library only.
"""
import base64
import http.client
import json
import os
import sys
import time

HOST = os.environ.get("INTAKE_E2E_HOST", "openbrain-intake")


def request(step):
    conn = http.client.HTTPConnection(HOST, 8000, timeout=float(step.get("timeout", 300)))
    body = base64.b64decode(step["body_b64"]) if step.get("body_b64") else b""
    t0 = time.monotonic()
    try:
        conn.putrequest(step.get("method", "POST"), step["path"], skip_accept_encoding=True)
        headers = dict(step.get("headers") or {})
        if "declare" in step:
            headers["Content-Length"] = step["declare"]
        elif step.get("method", "POST") == "POST":
            headers["Content-Length"] = str(len(body))
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders()
        if body and not step.get("no_body"):
            try:
                conn.send(body)
            except OSError:
                pass  # the server answered (413) and closed before the body was sent
        resp = conn.getresponse()
        data = resp.read()
        try:
            doc = json.loads(data)
        except ValueError:
            doc = data.decode("utf-8", "replace")[:4000]
        return {"status": resp.status, "body": doc, "seconds": round(time.monotonic() - t0, 3)}
    except Exception as e:  # noqa: BLE001
        return {"status": None, "error": f"{type(e).__name__}: {e}", "seconds": round(time.monotonic() - t0, 3)}
    finally:
        conn.close()


_CACHE = {}


def build(spec):
    from tests.e2e import shapes
    kind = spec["kind"]
    if kind not in _CACHE:
        _CACHE[kind] = ({n: (r, ct) for n, r, ct in shapes.slow_shapes()} if kind == "shape"
                        else {n: (r, ct) for n, r, ct, _e in shapes.fixtures()})
    raw, ct = _CACHE[kind][spec["id"]]
    env = {"source": spec.get("source", "e2e"), "connector": spec.get("connector", "research"),
           "external_id": spec.get("external_id", spec["id"]), "fetched_at": "2026-10-18T12:00:00+00:00",
           "content_type": ct, "raw_encoding": "base64",
           "raw": base64.b64encode(raw.encode("utf-8", "surrogatepass")).decode("ascii")}
    return json.dumps(env).encode("utf-8")


def main():
    plan = json.load(open(sys.argv[1], encoding="utf-8"))
    out = []
    for step in plan:
        if "sleep" in step:
            time.sleep(step["sleep"])
            out.append({"name": step["name"], "slept": step["sleep"]})
        elif "wait_healthz" in step:
            end = time.monotonic() + step["wait_healthz"]
            r = None
            while time.monotonic() < end:
                r = request({"method": "GET", "path": "/healthz", "timeout": 10})
                if r.get("status") == 200:
                    break
                time.sleep(2)
            out.append({"name": step["name"], **(r or {})})
        else:
            if "build" in step:
                step = {**step, "path": "/v1/intake", "method": "POST",
                        "body_b64": base64.b64encode(build(step["build"])).decode("ascii")}
            r = request(step)
            # like a connector's outbox: a 503 (no worker free / a killed worker still being
            # replaced / the store down) is retried, up to retry_503 seconds; each try is kept
            tries = [r]
            end = time.monotonic() + float(step.get("retry_503", 0))
            while r.get("status") == 503 and time.monotonic() < end:
                time.sleep(3)
                r = request(step)
                tries.append(r)
            if len(tries) > 1:
                r = {**r, "retried_503": len(tries) - 1,
                     "seconds_total": round(sum(t.get("seconds") or 0 for t in tries) + 3 * (len(tries) - 1), 3)}
            if isinstance(r.get("body"), dict) and r["body"].get("text") and len(r["body"]["text"]) > 400:
                r["body"]["text"] = r["body"]["text"][:400] + "...[cut by the client]"
            out.append({"name": step["name"], **r})
        json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), indent=1)
    print(json.dumps({"steps": len(out)}))


if __name__ == "__main__":
    main()
