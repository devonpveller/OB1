// The documents API's two outbound calls, built from the environment and SHIPPED INERT: research is
// null until configured and refetch answers the stated 503 (the route says which variables are missing).
//   research  POST <RESEARCH_URL>/research with the workspace's OWN caller key (RESEARCH_WORKSPACE_KEY,
//             declared in the research service's RESEARCH_CALLERS as workspace=workspace:<key>), so the
//             recorded origin is `workspace` because of the key, not the body (D17 item 1)
//   refetch   a held LINK's new contents (rw-workbench-fetch-posture): ONE call to the search gate's
//             POST /v1/fetch with the workbench's own key (src/fetch-gate/client.ts) - intake's clean
//             text, or the gate's refusal unchanged; no gate URL or key = the stated 503, never direct
import { type GateFetch, gateClient } from "../fetch-gate/client.ts";

export function researchClient(env = (k: string) => Deno.env.get(k)) {
  const base = (env("RESEARCH_URL") ?? "").replace(/\/+$/, "");
  const key = env("RESEARCH_WORKSPACE_KEY") ?? "";
  if (!base || !key) return null;
  return async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/research`, {
      method: "POST", headers: { "content-type": "application/json", "x-brain-key": key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.job_id) throw new Error(`the research service answered ${r.status}`);
    return { job_id: String(j.job_id) };
  };
}

export function refetchClient(fetchPage: GateFetch = gateClient()) {
  return async (url: string) => {
    const page = await fetchPage(url);
    return { title: page.title ?? "", content: page.text };
  };
}
