// The documents API's two outbound calls, built from the environment and SHIPPED INERT: each is
// null (the route answers 503 and says which variable is missing) until configured.
//   research  POST <RESEARCH_URL>/research with the workspace's OWN caller key (RESEARCH_WORKSPACE_KEY,
//             declared in the research service's RESEARCH_CALLERS as workspace=workspace:<key>), so the
//             recorded origin is `workspace` because of the key, not the body (D17 item 1)
//   refetch   a held LINK's new contents, fetched through the egress proxy FETCH_PROXY_URL only (the
//             export resolver's rule: never direct); a blank proxy means no refetch
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

const MAX_BYTES = 2_000_000;

export function htmlToText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

export function refetchClient(env = (k: string) => Deno.env.get(k)) {
  const proxy = (env("FETCH_PROXY_URL") ?? "").trim();
  if (!proxy) return null;
  let client: Deno.HttpClient;
  try {
    client = Deno.createHttpClient({ proxy: { url: proxy } });
  } catch {
    return null;
  }
  return async (url: string) => {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("refetch: not an http(s) URL");
    const r = await fetch(url, { client, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`refetch: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer()).slice(0, MAX_BYTES);
    const raw = new TextDecoder().decode(buf);
    const isHtml = /html/i.test(r.headers.get("content-type") ?? "");
    const title = isHtml ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "").trim() : "";
    return { title, content: isHtml ? htmlToText(raw) : raw };
  };
}
