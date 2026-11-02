// The intake's ONE fetch (rw-p5a-intake): POST <RESEARCH_URL>/intake/fetch with the workspace's own caller
// key (RESEARCH_WORKSPACE_KEY - declared in the research service's RESEARCH_CALLERS as
// workspace=workspace:<key>). The research service fetches the link through its FETCH_PROXY_URL client
// (the Mullvad proxy) - its proxy-bound fetch (research-service/intake-fetch.ts) - and answers the text
// (web page, transcript) or the PDF's bytes. The workbench never fetches a user's link for an add itself,
// and never through openbrain-mcp's fetch. SHIPPED INERT like the documents API's research client: null
// until RESEARCH_URL and RESEARCH_WORKSPACE_KEY are set; the add then answers 503 naming them.
// rw-identity-harden2 (D8): another service's error text never reaches a caller - the research service's
// fixed refusal codes are kept (an allow-list), anything else is a fixed code with the answer in the log.
import { logRefusal } from "../identity/refusal_log.ts";
import type { IntakeContentType } from "./content_types.ts";

export interface IntakeFetched {
  content_type: IntakeContentType;
  title: string;
  text?: string;
  bytes_b64?: string;
  final_url: string;
  redirects: string[];
  egress: string;
}

export class IntakeFetchError extends Error {
  constructor(public code: string, public httpStatus: number) {
    super(code);
    this.name = "IntakeFetchError";
  }
}

// the research service's own fixed codes (intake-fetch.ts IntakeRefused), safe to show as they are
export const RESEARCH_FETCH_CODES = new Set([
  "refused_target", "unsupported_type", "type_mismatch", "too_large", "no_transcript", "empty_extract",
  "upstream_status", "network", "timeout", "too_many_redirects", "fetch_failed",
]);

export type IntakeFetch = (url: string, declared: IntakeContentType | null) => Promise<IntakeFetched>;

export function researchIntakeFetch(env = (k: string) => Deno.env.get(k)): IntakeFetch | null {
  const base = (env("RESEARCH_URL") ?? "").replace(/\/+$/, "");
  const key = env("RESEARCH_WORKSPACE_KEY") ?? "";
  if (!base || !key) return null;
  const timeoutMs = parseInt(env("INTAKE_FETCH_TIMEOUT_MS") ?? "", 10) || 90_000;
  return async (url, declared) => {
    let r: Response;
    try {
      r = await fetch(`${base}/intake/fetch`, {
        method: "POST", headers: { "content-type": "application/json", "x-brain-key": key },
        body: JSON.stringify({ url, ...(declared ? { content_type: declared } : {}) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      logRefusal("intake: research unreachable", `[intake] the research service did not answer: ${(e as Error).message}`);
      throw new IntakeFetchError("research_unavailable", 503);
    }
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.ok && j.ok === true) {
      return {
        content_type: j.content_type as IntakeContentType, title: String(j.title ?? ""),
        text: typeof j.text === "string" ? j.text : undefined, bytes_b64: typeof j.bytes_b64 === "string" ? j.bytes_b64 : undefined,
        final_url: String(j.final_url ?? url), redirects: Array.isArray(j.redirects) ? j.redirects.map(String) : [], egress: String(j.egress ?? ""),
      };
    }
    const code = typeof j.error === "string" && RESEARCH_FETCH_CODES.has(j.error) ? j.error : "upstream_error";
    if (code === "upstream_error") {
      logRefusal("intake: research upstream", `[intake] the research service answered ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    }
    throw new IntakeFetchError(code, r.status === 401 || r.status === 403 ? 503 : r.status >= 500 ? 502 : 422);
  };
}
