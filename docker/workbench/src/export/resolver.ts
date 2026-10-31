// The export's reference resolver (research-workbench P6a): a persistent identifier -> canonical
// CSL-JSON, from the KEYED OpenAlex API with Crossref's polite pool as the fallback.
//
// EGRESS (POSTURE.md): every request goes out through the egress proxy FETCH_PROXY_URL (the search
// plane's Mullvad tunnel, http://vpn:8888 in compose), FAIL-CLOSED - a blank proxy URL, or a proxy
// client that cannot be built, leaves the resolver REFUSED. There is no direct mode.
// SHIPPED INERT: with neither OPENALEX_API_KEY nor CROSSREF_MAILTO configured the resolver is OFF.
// Off or refused, nothing is requested, and an export that needs a resolution fails, naming the
// references (export/exporter.ts) - it never renders them as text.
// THE DOOR (send): a request may only target the configured OpenAlex or Crossref ORIGIN (scheme, host,
// port; no user info), an OpenAlex request must carry the key and a Crossref request the mailto - all
// checked BEFORE it leaves (acceptance 3). Redirects are NEVER followed (redirect: "manual"): a 3xx
// answer is a hard failure of the reference (reason code `redirect`) and nothing from it is used or
// cached - so no request ever leaves for a host, or without a credential, the door did not check
// (rw-p6a-resolve attempt 2: fetch's default "follow" sent a Crossref 302's target to OpenAlex
// without the key, an OpenAlex 302's to Crossref without the mailto, and the key to a third host).
// HARD FAILURE: an identifier neither service answers with a 200 and a usable record is a
// ResolutionFailed naming what each service said. The primary's miss is not a failure when the
// fallback answers; a miss of both is, always.
// WHAT THE BROWSER SEES (attempt 2, ADV-2a): a failure reason is built from a closed vocabulary - the
// service, its HTTP status or `redirect`, or `request failed (egress: timeout|network error)`. A
// transport error's own message (which names the request URL, local and remote addresses) goes to
// the server log only, query strings cut and the key and mailto masked.
// WHAT IS STORED (attempt 2, ADV-3): a record whose strings carry the key, the mailto, an
// `api_key=`/`mailto=` assignment or a URL with a query string is refused - never cached, never
// rendered (the rule of P3a's safeScholarlyRecord, applied to the CSL item).
//
// One client for the two services in the workbench. P3a's research-service resolver
// (integrations/research-service/scholarly.ts, not merged when this was written) resolves the same
// identifiers for credibility counts; the consolidation is recorded in the item's findings.
import { type CslItem, crossrefToCsl, MetadataIncomplete, openalexToCsl } from "./csl.ts";
import { accessionOk, fill, type Identifier, type IdentifierKind } from "./identifiers.ts";
import { credentialShaped, secretForms, secretIn } from "./credentials.ts";
import { sameKey } from "../identity/keys.ts";

export interface ResolverConfig {
  openalexKey: string;
  mailto: string;
  proxyUrl: string;
  openalexBase: string; // https://api.openalex.org (a test points it at its stub)
  crossrefBase: string; // https://api.crossref.org
  timeoutMs: number;
}

export function resolverConfigFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): ResolverConfig {
  return {
    openalexKey: (env("OPENALEX_API_KEY") ?? "").trim(),
    mailto: (env("CROSSREF_MAILTO") ?? "").trim(),
    proxyUrl: (env("FETCH_PROXY_URL") ?? "").trim(),
    openalexBase: (env("RESOLVER_OPENALEX_BASE") || "https://api.openalex.org").replace(/\/+$/, ""),
    crossrefBase: (env("RESOLVER_CROSSREF_BASE") || "https://api.crossref.org").replace(/\/+$/, ""),
    timeoutMs: parseInt(env("RESOLVER_TIMEOUT_MS") || "10000", 10),
  };
}

export type ResolverState =
  | { state: "on"; services: string[]; egress: string }
  | { state: "off"; reason: string }
  | { state: "refused"; reason: string };

export interface Resolution {
  csl: CslItem;
  via: "openalex" | "crossref";
}

export class ResolutionFailed extends Error {}
export class RequestRefused extends Error {}
class Redirected extends Error {}

type RawFetch = (url: string, init: RequestInit & { client?: Deno.HttpClient }) => Promise<Response>;
type Service = "openalex" | "crossref";
const NAME: Record<Service, string> = { openalex: "OpenAlex", crossref: "Crossref" };
const MAX_BODY = 4 * 1024 * 1024;

export interface Resolver {
  readonly status: ResolverState;
  resolve(id: Identifier, kind: IdentifierKind): Promise<Resolution>;
  // The one door every request goes through; exported so the refusal is testable on its own.
  send(service: Service, url: string): Promise<Response>;
  // Whether a CSL item (fresh or cached) carries credential-shaped text under this configuration.
  unsafe(csl: unknown): boolean;
  // The configured key and mailto (and their URL-encoded forms): no output may carry them.
  readonly secrets: string[];
  close(): void; // the proxy client (a test closes it; the workbench keeps one for its lifetime)
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

function originOf(base: string): URL | null {
  try {
    const u = new URL(base);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash ? u : null;
  } catch {
    return null;
  }
}

export function createResolver(
  cfg: ResolverConfig,
  deps: { buildClient?: (url: string) => Deno.HttpClient; fetch?: RawFetch; log?: (m: string) => void } = {},
): Resolver {
  const raw: RawFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const log = deps.log ?? ((m: string) => console.error(m));
  const secrets = secretForms([cfg.openalexKey, cfg.mailto]);
  // A message for the server log: query strings cut, user info cut, both secrets masked.
  const redact = (msg: string) => {
    let out = msg.replace(/(https?:\/\/[^\s?)'"]+)\?[^\s)'"]*/g, "$1?[query removed]").replace(/(\w+:\/\/)[^/\s@]+@/g, "$1[userinfo removed]@");
    for (const s of secrets) out = out.replaceAll(s, "[redacted]");
    return out;
  };
  const origins: Record<Service, URL | null> = { openalex: originOf(cfg.openalexBase), crossref: originOf(cfg.crossrefBase) };

  let status: ResolverState;
  let client: Deno.HttpClient | null = null;
  if (!cfg.openalexKey && !cfg.mailto) {
    status = { state: "off", reason: "the resolver is off: neither OPENALEX_API_KEY nor CROSSREF_MAILTO is configured (shipped inert)" };
  } else if (!cfg.proxyUrl) {
    status = { state: "refused", reason: "the resolver is refused: FETCH_PROXY_URL is blank, and it never goes direct" };
  } else if ((cfg.openalexKey && !origins.openalex) || (cfg.mailto && !origins.crossref)) {
    status = { state: "refused", reason: "the resolver is refused: a service base URL is not a plain http(s) origin" };
  } else {
    try {
      client = (deps.buildClient ?? ((url) => Deno.createHttpClient({ proxy: { url } })))(cfg.proxyUrl);
      status = {
        state: "on",
        services: [cfg.openalexKey ? "openalex" : null, cfg.mailto ? "crossref" : null].filter((s): s is string => !!s),
        egress: "proxy",
      };
    } catch (e) {
      log(`[export resolver] the egress proxy client could not be built: ${redact((e as Error).message)}`);
      status = { state: "refused", reason: "the resolver is refused: FETCH_PROXY_URL is not a usable egress proxy (the workbench log says why)" };
    }
  }

  async function send(service: Service, url: string): Promise<Response> {
    if (status.state !== "on" || !client) throw new RequestRefused((status as { reason?: string }).reason ?? "resolver not on");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RequestRefused("refused: not a URL");
    }
    const o = origins[service];
    // the origin, then the path under the base: nothing else may be requested
    if (!o || u.protocol !== o.protocol || u.host !== o.host || u.username || u.password || !u.pathname.startsWith(o.pathname.replace(/\/?$/, "/"))) {
      throw new RequestRefused(`refused before sending: the request is not to the configured ${NAME[service]} API`);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (service === "openalex") {
      if (!cfg.openalexKey || !sameKey(u.searchParams.get("api_key") ?? "", cfg.openalexKey)) {
        throw new RequestRefused("refused before sending: an OpenAlex request must carry the API key");
      }
    } else {
      if (!cfg.mailto || u.searchParams.get("mailto") !== cfg.mailto) {
        throw new RequestRefused("refused before sending: a Crossref request must carry the polite-pool mailto");
      }
      headers["user-agent"] = `OpenBrain-Workbench/P6a (mailto:${cfg.mailto})`;
    }
    const r = await raw(url, { headers, client, redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs) });
    if ((r.status >= 300 && r.status < 400) || r.type === "opaqueredirect" || r.redirected) {
      await r.body?.cancel().catch(() => {});
      throw new Redirected(`${NAME[service]} answered a redirect (3xx), not followed`);
    }
    return r;
  }

  // attempt 3: judged on the NORMALISED text (credentials.ts) - tags stripped, entities and escapes
  // undone, invisible characters removed, whitespace collapsed and removed - so a key split by an
  // empty `<i></i>`, `<b></b>`, `<sc></sc>` or `<span class="nocase"></span>` is the key; and on the
  // strings of one record joined, so a key split across two fields is too.
  // attempt 4 (tester ADV-4): secretIn searches the raw text and its forms (credentials.ts), never
  // only a normalised one; and the record is also judged on the UPSTREAM strings as they came
  // (carries, below), before the CSL conversion removed anything - `<KEY>` is a tag to the CSL
  // clean-up, but it is the key.
  const unsafe = (csl: unknown) => {
    const all = strings(csl);
    return all.some((s) => credentialShaped(s) || secretIn(s, secrets) !== null) || secretIn(all.join(""), secrets) !== null;
  };
  const carries = (body: unknown) => {
    const all = strings(body);
    return all.some((s) => secretIn(s, secrets) !== null) || secretIn(all.join(""), secrets) !== null;
  };

  async function getJson(service: Service, url: string): Promise<{ status: number; body: unknown }> {
    const r = await send(service, url);
    const text = await r.text();
    let body: unknown = null;
    if (text.length <= MAX_BODY) {
      try {
        body = JSON.parse(text);
      } catch { /* not json */ }
    }
    return { status: r.status, body };
  }

  // One service's attempt: a CSL item, or what it said (pushed to `said`). A redirect ends the
  // whole resolution (hard failure); a refusal at the door is a bug, raised as is.
  async function attempt(service: Service, url: string, said: string[], toCsl: (body: unknown) => CslItem | null, what: string) {
    try {
      const r = await getJson(service, url);
      const csl = r.status === 200 ? toCsl(r.body) : null;
      if (csl) {
        if (unsafe(csl) || carries(r.body)) {
          said.push(`${NAME[service]} returned a record carrying credential-shaped text (refused)`);
          return null;
        }
        return csl;
      }
      said.push(`${NAME[service]} answered ${r.status} for ${what}`);
    } catch (e) {
      if (e instanceof RequestRefused) throw e;
      if (e instanceof Redirected) {
        said.push(e.message);
        throw new ResolutionFailed(said.join("; "));
      }
      if (e instanceof MetadataIncomplete) said.push(e.message);
      else {
        const n = (e as { name?: string })?.name ?? "";
        log(`[export resolver] ${NAME[service]} request for ${what} failed: ${redact(String((e as Error)?.message ?? e))}`);
        said.push(`${NAME[service]} request failed (egress: ${n === "TimeoutError" || n === "AbortError" ? "timeout" : "network error"})`);
      }
    }
    return null;
  }

  async function resolve(id: Identifier, kind: IdentifierKind): Promise<Resolution> {
    if (status.state !== "on") throw new ResolutionFailed(status.reason);
    if (id.kind !== kind.key || !accessionOk(kind, id.accession)) {
      throw new ResolutionFailed(`the identifier is malformed for its kind (${kind.key}); nothing was requested`);
    }
    const said: string[] = [];
    // 1. OpenAlex, keyed
    if (!kind.openalex_work) said.push(`OpenAlex cannot resolve a ${kind.key} identifier`);
    else if (!cfg.openalexKey) said.push("OpenAlex not tried: OPENALEX_API_KEY is not configured");
    else {
      const work = fill(kind.openalex_work, id);
      const q = new URLSearchParams({ api_key: cfg.openalexKey });
      if (cfg.mailto) q.set("mailto", cfg.mailto);
      const csl = await attempt("openalex", `${cfg.openalexBase}/works/${encodeURIComponent(work)}?${q}`, said,
        (b) => b && typeof b === "object" ? openalexToCsl(b as Record<string, unknown>) : null, work);
      if (csl) return { csl, via: "openalex" };
    }
    // 2. Crossref, polite pool
    const doi = kind.crossref_doi ? fill(kind.crossref_doi, id) : null;
    if (!doi) said.push(`Crossref cannot resolve a ${kind.key} identifier (no DOI)`);
    else if (!cfg.mailto) said.push("Crossref not tried: CROSSREF_MAILTO is not configured");
    else {
      const csl = await attempt("crossref", `${cfg.crossrefBase}/works/${encodeURIComponent(doi)}?${new URLSearchParams({ mailto: cfg.mailto })}`, said,
        (b) => {
          const msg = (b as Record<string, unknown> | null)?.message;
          return msg && typeof msg === "object" ? crossrefToCsl(msg as Record<string, unknown>) : null;
        }, doi);
      if (csl) return { csl, via: "crossref" };
    }
    throw new ResolutionFailed(said.join("; "));
  }

  const close = () => {
    try {
      client?.close();
    } catch { /* already closed */ }
  };
  return { get status() { return status; }, resolve, send, unsafe, secrets, close };
}
