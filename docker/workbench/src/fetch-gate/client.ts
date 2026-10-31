// The workbench's ONE path to a user-supplied URL (rw-workbench-fetch-posture): a call to the search
// gate's POST /v1/fetch {url} with the workbench's own per-caller key. The workbench never fetches a
// page itself, never follows a redirect, and fails closed:
//   no gate URL or no key       -> GateUnavailable 503 "fetch gate not configured ..." (no request)
//   the gate unreachable, slow,
//   3xx, non-200, or off-shape  -> GateUnavailable 503 (one request to the gate, never a retry, never direct)
//   refused / withheld / error  -> GateRefusal with the gate's reason UNCHANGED (from the allow-listed
//                                  set below; any other text is off-shape -> 503, so a site-chosen
//                                  string never reaches the caller)
//   ok (intake labelled clean)  -> GatePage: intake's clean text, the media type, the provenance
//
// The gate's contract (ai-stack search/gateway, development 3e3b72c6+): routes/gate.py fetch_and_screen
// and the FetchResponse model (models.py); the reason texts are gate.py's ERROR_NETWORK, ERROR_HTTP,
// WITHHELD and egress/guard.py's REASONS. The redirect hops are judged AT the gate (egress/fetch.py,
// max 5); an ok answer reports them in `redirects` and the final URL in `final_url`.

export const GATE_ROUTE = "/v1/fetch";
// The gate's own deadline is 20 s over resolution, every hop and the body (GATE_FETCH_TIMEOUT_SECONDS);
// this is that plus the intake hand-off and a margin.
export const GATE_TIMEOUT_MS = 30_000;
// The gate caps the page at 2 MiB; its JSON answer carries intake's text plus the fence and labels.
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

// Every non-ok reason the gate can send, verbatim (search/gateway/src/gateway/routes/gate.py and
// egress/guard.py REASONS). The workbench passes exactly these through and nothing else.
export const GATE_REASONS: ReadonlySet<string> = new Set([
  "refused: the URL is not an allowed target (scheme, credentials, port, internal name or non-public address)",
  "refused: a redirect led to a target that is not allowed",
  "refused: the name does not resolve to public addresses only",
  "refused: too many redirects",
  "refused: the content type is not on the allow-list",
  "refused: the content encoding is not supported",
  "refused: the body is over the byte cap",
  "refused: the time cap passed before a complete answer",
  "error: the page could not be fetched (network)",
  "error: the site answered with an HTTP error status",
  "withheld: intake did not label this page clean",
]);

// The gate's content-type allow-list default (config.py DEFAULT_FETCH_TYPES); an ok answer's media type.
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json",
]);

export const NOT_CONFIGURED = "fetch gate not configured: WORKBENCH_GATE_URL and WORKBENCH_GATE_KEY are both required; the workbench never fetches a URL itself";
export const UNAVAILABLE = "fetch gate unavailable: the search gate did not answer /v1/fetch; nothing was fetched or stored";
export const OFF_SHAPE = "fetch gate unavailable: the search gate's answer was not a /v1/fetch answer; nothing was stored";

export class GateUnavailable extends Error {
  readonly httpStatus = 503;
  constructor(message: string) {
    super(message);
    this.name = "GateUnavailable";
  }
}

// A refused / withheld / error answer: `reason` is the gate's text, unchanged.
export class GateRefusal extends Error {
  readonly httpStatus: number;
  constructor(readonly status: "refused" | "withheld" | "error", readonly reason: string, readonly gateHttpStatus: number | null) {
    super(reason);
    this.name = "GateRefusal";
    this.httpStatus = status === "error" ? 502 : 422;
  }
}

export interface GatePage {
  text: string;          // intake's clean text (never the raw page)
  title: string | null;  // intake's title, if any
  mediaType: string;     // the allow-listed media type, no parameters
  provenance: { via: "search-gate"; origin_url: string; final_url: string; redirects: string[]; http_status: number | null; label: string | null };
}

export type GateFetch = (url: string) => Promise<GatePage>;

// The answer body a caller of the workbench gets for a gate failure (the routes' error shape).
export function gateErrorBody(e: GateUnavailable | GateRefusal) {
  if (e instanceof GateRefusal) return { error: e.reason, gate: { status: e.status, reason: e.reason, http_status: e.gateHttpStatus } };
  return { error: e.message, gate: { status: "unavailable" } };
}

export function isGateError(e: unknown): e is GateUnavailable | GateRefusal {
  return e instanceof GateUnavailable || e instanceof GateRefusal;
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

// Judge the gate's 200 answer against FetchResponse; anything else is off-shape (fail closed).
export function readAnswer(url: string, j: unknown): GatePage {
  if (!j || typeof j !== "object") throw new GateUnavailable(OFF_SHAPE);
  const a = j as Record<string, unknown>;
  if (a.url !== url) throw new GateUnavailable(OFF_SHAPE);
  const hs = typeof a.http_status === "number" && Number.isInteger(a.http_status) ? a.http_status : null;
  if (a.status === "refused" || a.status === "withheld" || a.status === "error") {
    if (!str(a.reason) || !GATE_REASONS.has(a.reason)) throw new GateUnavailable(OFF_SHAPE);
    throw new GateRefusal(a.status, a.reason, hs);
  }
  if (a.status !== "ok") throw new GateUnavailable(OFF_SHAPE);
  if (!str(a.text) || !str(a.content_type) || !MEDIA_TYPES.has(a.content_type)) throw new GateUnavailable(OFF_SHAPE);
  const redirects = Array.isArray(a.redirects) ? a.redirects : [];
  if (!redirects.every(str)) throw new GateUnavailable(OFF_SHAPE);
  const finalUrl = str(a.final_url) ? a.final_url : url;
  return {
    text: a.text,
    title: str(a.title) && a.title.trim() ? a.title.trim() : null,
    mediaType: a.content_type,
    provenance: { via: "search-gate", origin_url: url, final_url: finalUrl, redirects: redirects as string[], http_status: hs, label: str(a.label) ? a.label : null },
  };
}

async function readCapped(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new GateUnavailable(OFF_SHAPE);
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

// The gate client, from the environment. Never null: an unconfigured client answers every call with
// the stated 503 and sends nothing, so each caller has one code path.
export function gateClient(env = (k: string) => Deno.env.get(k)): GateFetch {
  const base = (env("WORKBENCH_GATE_URL") ?? "").trim().replace(/\/+$/, "");
  const key = (env("WORKBENCH_GATE_KEY") ?? "").trim();
  let endpoint = "";
  try {
    if (base) {
      const u = new URL(base + GATE_ROUTE);
      if (u.protocol === "http:" || u.protocol === "https:") endpoint = u.href;
    }
  } catch { endpoint = ""; }
  if (!endpoint || !key) {
    return (_url: string) => Promise.reject(new GateUnavailable(NOT_CONFIGURED));
  }
  return async (url: string) => {
    let r: Response;
    try {
      // redirect: "error" - the gate answers its route itself; a 3xx here is never followed
      r = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ url }),
        redirect: "error",
        signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      });
    } catch {
      throw new GateUnavailable(UNAVAILABLE);
    }
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      throw new GateUnavailable(`${UNAVAILABLE} (gate HTTP ${r.status})`);
    }
    let j: unknown;
    try {
      j = JSON.parse(await readCapped(r));
    } catch (e) {
      if (e instanceof GateUnavailable) throw e;
      throw new GateUnavailable(OFF_SHAPE);
    }
    return readAnswer(url, j);
  };
}
