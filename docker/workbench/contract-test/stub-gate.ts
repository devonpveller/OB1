// A STUB of the search gate's POST /v1/fetch for the disposable test networks only
// (rw-workbench-fetch-posture). It speaks the real route's request/answer shape - ai-stack
// search/gateway/src/gateway/routes/gate.py (fetch_and_screen, the fetch route), models.py
// (FetchRequest {url}, FetchResponse), deps.py (Bearer per-caller key: 401 "missing or invalid bearer
// token"), egress/guard.py REASONS - and its outcomes, with a lab "guard" (only STUB_GATE_ALLOW hosts
// are targets) and a lab "intake" (strips the markup; /withheld/* is not labelled clean).
//   POST /v1/fetch {url}   Authorization: Bearer <STUB_GATE_KEY>
//   GET  /__log            every /v1/fetch request [{from, auth_ok, body}]  (not itself logged)
// Behaviour by the target path (it fetches the target itself, redirect: manual, judging each hop):
//   /gate-redirect/*  the GATE answers 307 Location: <the url>    (3xx at the gate)
//   /gate-500/*       the GATE answers 500                         (a broken gate)
//   /refuse/*         refused, REASONS.target, nothing fetched
//   anything else     fetched; a hop to a host outside STUB_GATE_ALLOW = refused (redirect-target);
//                     > 5 hops = refused (redirects); status >= 300 = error (ERROR_HTTP); a type off the
//                     allow-list = refused (type); /withheld/* = withheld; else ok with intake's text.
const KEY = Deno.env.get("STUB_GATE_KEY") ?? "";
const ALLOW = new Set((Deno.env.get("STUB_GATE_ALLOW") ?? "stub-target:8080").split(",").map((s) => s.trim()).filter(Boolean));
const REASONS = {
  target: "refused: the URL is not an allowed target (scheme, credentials, port, internal name or non-public address)",
  "redirect-target": "refused: a redirect led to a target that is not allowed",
  redirects: "refused: too many redirects",
  type: "refused: the content type is not on the allow-list",
};
const ERROR_NETWORK = "error: the page could not be fetched (network)";
const ERROR_HTTP = "error: the site answered with an HTTP error status";
const WITHHELD = "withheld: intake did not label this page clean";
const TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"]);
const MAX_REDIRECTS = 5;
const log: { from: string; auth_ok: boolean; body: unknown }[] = [];

const allowed = (u: URL) => (u.protocol === "http:" || u.protocol === "https:") && ALLOW.has(u.host);
const intake = (raw: string) =>
  "screened: " + raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<title[\s\S]*?<\/title>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function fetchAndScreen(url: string) {
  let cur: URL;
  try { cur = new URL(url); } catch { return { status: "refused", url, reason: REASONS.target, redirects: [] }; }
  if (!allowed(cur)) return { status: "refused", url, reason: REASONS.target, redirects: [] };
  if (cur.pathname.startsWith("/refuse/")) return { status: "refused", url, reason: REASONS.target, redirects: [] };
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    let r: Response;
    try {
      r = await fetch(cur.href, { redirect: "manual", headers: { "x-stub-gate": "1" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      return { status: "error", url, reason: ERROR_NETWORK, redirects: [] };
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel();
      if (hop >= MAX_REDIRECTS) return { status: "refused", url, reason: REASONS.redirects, redirects: [] };
      const next = new URL(r.headers.get("location")!, cur);
      if (!allowed(next)) return { status: "refused", url, reason: REASONS["redirect-target"], redirects: [] };
      cur = next;
      redirects.push(cur.href);
      continue;
    }
    if (r.status >= 300) { await r.body?.cancel(); return { status: "error", url, http_status: r.status, reason: ERROR_HTTP, redirects: [] }; }
    const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES.has(ct)) { await r.body?.cancel(); return { status: "refused", url, reason: REASONS.type, redirects: [] }; }
    const raw = await r.text();
    if (cur.pathname.startsWith("/withheld/")) return { status: "withheld", url, label: "suspicious", http_status: r.status, reason: WITHHELD, redirects: [] };
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "").trim() || null;
    const text = ct === "text/html" || ct === "application/xhtml+xml" ? intake(raw) : raw;
    const nonce = crypto.randomUUID().slice(0, 8);
    return {
      status: "ok", url, final_url: cur.href, redirects, http_status: r.status, content_type: ct, label: "clean",
      title, text, fenced: `<<UNTRUSTED-${nonce} src=${cur.href} verdict=clean>>\n${text}\n<<END-${nonce}>>`, labels: { verdict: "clean" },
    };
  }
}

Deno.serve({ port: 8080 }, async (req, info) => {
  const u = new URL(req.url);
  if (u.pathname === "/__log" && req.method === "GET") return Response.json(log);
  if (u.pathname !== "/v1/fetch" || req.method !== "POST") return Response.json({ detail: "Not Found" }, { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  const [scheme, token] = [auth.split(" ")[0] ?? "", auth.slice(auth.indexOf(" ") + 1)];
  const authOk = !!KEY && scheme.toLowerCase() === "bearer" && token === KEY;
  const body = await req.json().catch(() => null);
  log.push({ from: (info.remoteAddr as Deno.NetAddr).hostname, auth_ok: authOk, body });
  if (!authOk) return Response.json({ detail: "missing or invalid bearer token" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  const url = body && typeof body.url === "string" ? body.url : "";
  if (!url || url.length > 4096) return Response.json({ detail: [{ type: "string_too_short", loc: ["body", "url"] }] }, { status: 422 });
  const path = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
  if (path.startsWith("/gate-redirect/")) return new Response(null, { status: 307, headers: { location: url } });
  if (path.startsWith("/gate-500/")) return new Response("Internal Server Error", { status: 500 });
  return Response.json(await fetchAndScreen(url));
});
