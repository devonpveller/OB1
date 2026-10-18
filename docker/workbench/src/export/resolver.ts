// The export's reference resolver (research-workbench P6a): a persistent identifier -> canonical
// CSL-JSON, from the KEYED OpenAlex API with Crossref's polite pool as the fallback.
//
// EGRESS (POSTURE.md): every request goes out through the egress proxy FETCH_PROXY_URL (the search
// plane's Mullvad tunnel, http://vpn:8888 in compose), FAIL-CLOSED - a blank proxy URL, or a proxy
// client that cannot be built, leaves the resolver REFUSED. There is no direct mode.
// SHIPPED INERT: with neither OPENALEX_API_KEY nor CROSSREF_MAILTO configured the resolver is OFF.
// Off or refused, nothing is requested, and an export that needs a resolution fails, naming the
// references (routes/export.ts) - it never renders them as text.
// KEYS: an OpenAlex request without the key, or a Crossref request without the mailto, is refused
// by send() BEFORE it leaves (acceptance 3); so is any URL that is not one of the two services.
// HARD FAILURE: an identifier neither service answers with a 200 and a usable record is a
// ResolutionFailed naming what each service said. The primary's miss is not a failure when the
// fallback answers; a miss of both is, always.
//
// One client for the two services in the workbench. P3a's research-service resolver
// (integrations/research-service/scholarly.ts, not merged when this was written) resolves the same
// identifiers for credibility counts; the consolidation is recorded in the item's findings.
import { type CslItem, crossrefToCsl, MetadataIncomplete, openalexToCsl } from "./csl.ts";
import { fill, type Identifier, type IdentifierKind } from "./identifiers.ts";

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

type RawFetch = (url: string, init: RequestInit & { client?: Deno.HttpClient }) => Promise<Response>;

export interface Resolver {
  readonly status: ResolverState;
  resolve(id: Identifier, kind: IdentifierKind): Promise<Resolution>;
  // The one door every request goes through; exported so the refusal is testable on its own.
  send(service: "openalex" | "crossref", url: string): Promise<Response>;
}

export function createResolver(
  cfg: ResolverConfig,
  deps: { buildClient?: (url: string) => Deno.HttpClient; fetch?: RawFetch } = {},
): Resolver {
  const raw: RawFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  let status: ResolverState;
  let client: Deno.HttpClient | null = null;
  if (!cfg.openalexKey && !cfg.mailto) {
    status = { state: "off", reason: "the resolver is off: neither OPENALEX_API_KEY nor CROSSREF_MAILTO is configured (shipped inert)" };
  } else if (!cfg.proxyUrl) {
    status = { state: "refused", reason: "the resolver is refused: FETCH_PROXY_URL is blank, and it never goes direct" };
  } else {
    try {
      client = (deps.buildClient ?? ((url) => Deno.createHttpClient({ proxy: { url } })))(cfg.proxyUrl);
      status = {
        state: "on",
        services: [cfg.openalexKey ? "openalex" : null, cfg.mailto ? "crossref" : null].filter((s): s is string => !!s),
        egress: "proxy",
      };
    } catch (e) {
      status = { state: "refused", reason: `the resolver is refused: the egress proxy client could not be built (${(e as Error).message})` };
    }
  }

  async function send(service: "openalex" | "crossref", url: string): Promise<Response> {
    if (status.state !== "on" || !client) throw new RequestRefused((status as { reason?: string }).reason ?? "resolver not on");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RequestRefused(`refused: '${url}' is not a URL`);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (service === "openalex") {
      if (!url.startsWith(cfg.openalexBase + "/")) throw new RequestRefused(`refused: ${u.host} is not the OpenAlex API`);
      if (!cfg.openalexKey || u.searchParams.get("api_key") !== cfg.openalexKey) {
        throw new RequestRefused("refused before sending: an OpenAlex request must carry the API key");
      }
    } else {
      if (!url.startsWith(cfg.crossrefBase + "/")) throw new RequestRefused(`refused: ${u.host} is not the Crossref API`);
      if (!cfg.mailto || u.searchParams.get("mailto") !== cfg.mailto) {
        throw new RequestRefused("refused before sending: a Crossref request must carry the polite-pool mailto");
      }
      headers["user-agent"] = `OpenBrain-Workbench/P6a (mailto:${cfg.mailto})`;
    }
    return await raw(url, { headers, client, signal: AbortSignal.timeout(cfg.timeoutMs) });
  }

  // A failure reason reaches the export's 422 body (and the browser). A fetch error message can
  // carry the request URL, whose query holds the key and the mailto: query strings are cut and
  // both values masked, whatever the message.
  function redact(msg: string): string {
    let out = msg.replace(/(https?:\/\/[^\s?)'"]+)\?[^\s)'"]*/g, "$1?[query removed]");
    for (const secret of [cfg.openalexKey, encodeURIComponent(cfg.openalexKey), cfg.mailto, encodeURIComponent(cfg.mailto)]) {
      if (secret) out = out.replaceAll(secret, "[redacted]");
    }
    return out;
  }

  async function getJson(service: "openalex" | "crossref", url: string): Promise<{ status: number; body: unknown }> {
    const r = await send(service, url);
    const text = await r.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch { /* not json */ }
    return { status: r.status, body };
  }

  async function resolve(id: Identifier, kind: IdentifierKind): Promise<Resolution> {
    if (status.state !== "on") throw new ResolutionFailed(status.reason);
    const said: string[] = [];
    // 1. OpenAlex, keyed
    if (!kind.openalex_work) said.push(`OpenAlex cannot resolve a ${kind.key} identifier`);
    else if (!cfg.openalexKey) said.push("OpenAlex not tried: OPENALEX_API_KEY is not configured");
    else {
      const work = fill(kind.openalex_work, id);
      const q = new URLSearchParams({ api_key: cfg.openalexKey });
      if (cfg.mailto) q.set("mailto", cfg.mailto);
      try {
        const r = await getJson("openalex", `${cfg.openalexBase}/works/${encodeURIComponent(work)}?${q}`);
        if (r.status === 200 && r.body && typeof r.body === "object") {
          return { csl: openalexToCsl(r.body as Record<string, unknown>), via: "openalex" };
        }
        said.push(`OpenAlex answered ${r.status} for ${work}`);
      } catch (e) {
        if (e instanceof RequestRefused) throw e;
        said.push(e instanceof MetadataIncomplete ? e.message : `OpenAlex request failed: ${(e as Error).message}`);
      }
    }
    // 2. Crossref, polite pool
    const doi = kind.crossref_doi ? fill(kind.crossref_doi, id) : null;
    if (!doi) said.push(`Crossref cannot resolve a ${kind.key} identifier (no DOI)`);
    else if (!cfg.mailto) said.push("Crossref not tried: CROSSREF_MAILTO is not configured");
    else {
      try {
        const r = await getJson("crossref", `${cfg.crossrefBase}/works/${encodeURIComponent(doi)}?${new URLSearchParams({ mailto: cfg.mailto })}`);
        const msg = (r.body as Record<string, unknown> | null)?.message;
        if (r.status === 200 && msg && typeof msg === "object") {
          return { csl: crossrefToCsl(msg as Record<string, unknown>), via: "crossref" };
        }
        said.push(`Crossref answered ${r.status} for ${doi}`);
      } catch (e) {
        if (e instanceof RequestRefused) throw e;
        said.push(e instanceof MetadataIncomplete ? e.message : `Crossref request failed: ${(e as Error).message}`);
      }
    }
    throw new ResolutionFailed(redact(said.join("; ")));
  }

  return { get status() { return status; }, resolve, send };
}
