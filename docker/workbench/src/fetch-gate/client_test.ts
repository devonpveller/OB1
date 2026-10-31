// rw-workbench-fetch-posture: the gate client against a loopback stub of the search gate's POST /v1/fetch
// (its request/answer shape: ai-stack search/gateway/src/gateway/routes/gate.py + models.py FetchResponse),
// and the static search of every fetcher file (acceptance 6 and 8). No network beyond 127.0.0.1.
//   deno test --allow-net --allow-env --allow-read src/fetch-gate/
// FETCH_POSTURE_SRC=<a tree's src dir> runs the static search against another tree (the RED on bc6d3a6).
// GATE_SRC=<ai-stack search/gateway/src/gateway> also checks the reason allow-list against the gate's code.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  GATE_REASONS, GATE_ROUTE, GateRefusal, GateUnavailable, NOT_CONFIGURED, OFF_SHAPE, UNAVAILABLE, gateClient,
  gateErrorBody, readAnswer,
} from "./client.ts";
import { refetchClient } from "../documents/clients.ts";

const KEY = "k".repeat(40);
const REFUSED_TARGET = "refused: the URL is not an allowed target (scheme, credentials, port, internal name or non-public address)";
const WITHHELD = "withheld: intake did not label this page clean";
const ERROR_HTTP = "error: the site answered with an HTTP error status";

type Seen = { method: string; path: string; auth: string | null; body: unknown };

// A stub gate on a loopback port: `answer` decides the response for each request.
async function withGate(answer: (s: Seen) => Response, run: (base: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const ac = new AbortController();
  const srv = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const s: Seen = { method: req.method, path: u.pathname, auth: req.headers.get("authorization"), body: await req.json().catch(() => null) };
    seen.push(s);
    return answer(s);
  });
  try {
    await run(`http://127.0.0.1:${srv.addr.port}`, seen);
  } finally {
    ac.abort();
    await srv.finished;
  }
}
const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
const env = (m: Record<string, string | undefined>) => (k: string) => m[k];

Deno.test("A1/A4: blank WORKBENCH_GATE_KEY or WORKBENCH_GATE_URL = the stated 503, and no request leaves", async () => {
  await withGate(() => json({}), async (base, seen) => {
    for (const e of [{ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: "" }, { WORKBENCH_GATE_URL: "", WORKBENCH_GATE_KEY: KEY }, {}]) {
      const err = await assertRejects(() => gateClient(env(e))("http://target.example/a"), GateUnavailable);
      assertEquals([err.httpStatus, err.message], [503, NOT_CONFIGURED]);
      assert(err.message.startsWith("fetch gate not configured"));
    }
    assertEquals(seen.length, 0, "nothing was sent");
  });
});

Deno.test("A1: the one request is POST <gate>/v1/fetch {url} with the Bearer key", async () => {
  const url = "http://target.example/page?x=1";
  await withGate(() => json({ status: "ok", url, final_url: url, redirects: [], http_status: 200, content_type: "text/html", text: "clean text", fenced: "<<UNTRUSTED-n>> clean text <<END-n>>", label: "clean", labels: {} }), async (base, seen) => {
    const page = await gateClient(env({ WORKBENCH_GATE_URL: base + "/", WORKBENCH_GATE_KEY: KEY }))(url);
    assertEquals(seen.length, 1);
    assertEquals([seen[0].method, seen[0].path, seen[0].auth], ["POST", GATE_ROUTE, `Bearer ${KEY}`]);
    assertEquals(seen[0].body, { url });
    assertEquals(page.text, "clean text", "intake's text, not the fence");
    assertEquals(page.mediaType, "text/html");
  });
});

Deno.test("A2: an ok answer after redirects at the gate: the hops and the final URL are the provenance; one call", async () => {
  const url = "http://target.example/r1";
  const hops = ["http://target.example/r2", "http://target.example/final"];
  await withGate(() => json({ status: "ok", url, final_url: hops[1], redirects: hops, http_status: 200, content_type: "text/plain", title: " T ", text: "body", label: "clean" }), async (base, seen) => {
    const page = await gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY }))(url);
    assertEquals(seen.length, 1);
    assertEquals(page.provenance, { via: "search-gate", origin_url: url, final_url: hops[1], redirects: hops, http_status: 200, label: "clean" });
    assertEquals(page.title, "T");
  });
});

Deno.test("A2: a 3xx FROM the gate itself is never followed (one request, the stated 503)", async () => {
  await withGate((s) => s.path === GATE_ROUTE ? new Response(null, { status: 307, headers: { location: "/elsewhere" } }) : json({}), async (base, seen) => {
    const err = await assertRejects(() => gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY }))("http://target.example/a"), GateUnavailable);
    assertEquals(err.httpStatus, 503);
    assertEquals(seen.map((s) => s.path), [GATE_ROUTE], "the Location was not requested");
  });
});

Deno.test("A3: refused / withheld / error keep the gate's reason unchanged; one call, never a retry", async () => {
  const url = "http://target.example/a";
  for (const [status, reason, code] of [["refused", REFUSED_TARGET, 422], ["withheld", WITHHELD, 422], ["error", ERROR_HTTP, 502]] as const) {
    await withGate(() => json({ status, url, reason, http_status: status === "error" ? 404 : null, redirects: [] }), async (base, seen) => {
      const err = await assertRejects(() => gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY }))(url), GateRefusal);
      assertEquals([err.status, err.reason, err.message, err.httpStatus], [status, reason, reason, code]);
      assertEquals(gateErrorBody(err).error, reason);
      assertEquals(seen.length, 1, "never retried");
    });
  }
});

Deno.test("A3: a reason outside the gate's allow-list, an unknown status or a foreign url is off-shape (503, the text is dropped)", () => {
  const url = "http://target.example/a";
  for (const a of [
    { status: "refused", url, reason: "refused: <script>site-chosen</script>" },
    { status: "withheld", url },
    { status: "maybe", url, text: "x", content_type: "text/html" },
    { status: "ok", url: "http://other.example/", text: "x", content_type: "text/html" },
    { status: "ok", url, content_type: "text/html" },
    { status: "ok", url, text: "x", content_type: "application/pdf" },
    { status: "ok", url, text: "x", content_type: "text/html", redirects: [1] },
    null,
  ]) {
    let e: unknown = null;
    try { readAnswer(url, a); } catch (x) { e = x; }
    assert(e instanceof GateUnavailable, JSON.stringify(a));
    assertEquals((e as GateUnavailable).message, OFF_SHAPE);
  }
});

Deno.test("A4: the gate unreachable, answering 401/403/503, or answering junk = the stated 503", async () => {
  const unreachable = await assertRejects(() => gateClient(env({ WORKBENCH_GATE_URL: "http://127.0.0.1:9", WORKBENCH_GATE_KEY: KEY }))("http://target.example/a"), GateUnavailable);
  assertEquals([unreachable.httpStatus, unreachable.message], [503, UNAVAILABLE]);
  for (const code of [401, 403, 422, 500, 503]) {
    await withGate(() => json({ detail: "x" }, code), async (base) => {
      const err = await assertRejects(() => gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY }))("http://target.example/a"), GateUnavailable);
      assertEquals(err.httpStatus, 503);
      assert(err.message.startsWith(UNAVAILABLE));
    });
  }
  await withGate(() => new Response("<html>not json</html>"), async (base) => {
    const err = await assertRejects(() => gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY }))("http://target.example/a"), GateUnavailable);
    assertEquals(err.message, OFF_SHAPE);
  });
});

Deno.test("A8: the held-link refetch is the same gate client: clean text + the gate's title, or the gate's error", async () => {
  const url = "http://target.example/held";
  await withGate(() => json({ status: "ok", url, final_url: url, content_type: "text/html", title: "Held", text: "clean held text" }), async (base, seen) => {
    const r = await refetchClient(gateClient(env({ WORKBENCH_GATE_URL: base, WORKBENCH_GATE_KEY: KEY })))(url);
    assertEquals(r, { title: "Held", content: "clean held text" });
    assertEquals(seen.length, 1);
  });
  await assertRejects(() => refetchClient(gateClient(env({})))(url), GateUnavailable, "fetch gate not configured");
});

// ── the static search (acceptance 6 + 8) ────────────────────────────────────────────────────────
// A "bare fetch" is a fetch( call whose first argument is not one of the named internal endpoints:
// the gate endpoint (client.ts), the extract sidecar (import.ts) and the research service (clients.ts).
const SRC_ENV = Deno.env.get("FETCH_POSTURE_SRC");
const SRC = SRC_ENV ? new URL("file://" + ("/" + SRC_ENV.split("\\").join("/") + "/").replace(/^\/+/, "/").replace(/\/+$/, "/")) : new URL("../", import.meta.url);
const FILES = ["routes/import.ts", "repositories/sources.ts", "documents/clients.ts", "fetch-gate/client.ts"];
const ALLOWED_FIRST_ARG = [/^endpoint\b/, /^`\$\{config\.extractUrl\}\/extract`/, /^`\$\{base\}\/research`/];

function code(text: string): string {
  // comments out (line comments and block comments), strings kept
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
}

Deno.test("A6/A8: no bare fetch, no redirect: 'follow', no FETCH_PROXY_URL, no proxy client in the fetcher files", async () => {
  const hits: string[] = [];
  for (const f of FILES) {
    let text: string;
    try { text = await Deno.readTextFile(new URL(f, SRC)); } catch { if (f === "fetch-gate/client.ts") { hits.push(`${f}: missing (the shared gate client)`); continue; } throw new Error(`${f} not found under ${SRC}`); }
    const c = code(text);
    for (const m of c.matchAll(/\bfetch\(\s*([^,)]*)/g)) {
      if (!ALLOWED_FIRST_ARG.some((rx) => rx.test(m[1].trim()))) hits.push(`${f}: bare fetch(${m[1].trim()}`);
    }
    if (/redirect\s*:\s*["'`]follow["'`]/.test(c)) hits.push(`${f}: redirect: "follow"`);
    if (/FETCH_PROXY_URL/.test(c)) hits.push(`${f}: FETCH_PROXY_URL`);
    if (/createHttpClient/.test(c)) hits.push(`${f}: a proxy client`);
  }
  assertEquals(hits, [], hits.join("\n"));
});

Deno.test("A3: the reason allow-list is the gate's own text (gate.py + egress/guard.py), when the gate source is at hand", { ignore: !Deno.env.get("GATE_SRC") }, async () => {
  const dir = Deno.env.get("GATE_SRC")!;
  const gate = await Deno.readTextFile(`${dir}/routes/gate.py`);
  const guard = await Deno.readTextFile(`${dir}/egress/guard.py`);
  const fromGate = [...gate.matchAll(/^(?:ERROR_NETWORK|ERROR_HTTP|WITHHELD) = "([^"]+)"/gm)].map((m) => m[1]);
  const block = /REASONS = \{([\s\S]*?)\n\}/.exec(guard)![1];
  const fromGuard = [...block.matchAll(/"[a-z-]+":\s*((?:"[^"]*"\s*)+),/g)].map((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).join(""));
  assertEquals(fromGate.length, 3);
  assertEquals(fromGuard.length, 8);
  assertEquals(new Set([...fromGate, ...fromGuard]), new Set(GATE_REASONS));
});
