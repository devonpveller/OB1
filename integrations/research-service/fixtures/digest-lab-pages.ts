/**
 * rw-boundary-digest: the digest lab's PUBLIC pages, in their own container on the lab's internal network (network
 * alias news.example.org on a documentation-range subnet, so the boundary's resolver judges the address public; 420's
 * TF6). Synthetic content only. Unlike boundary-lab-pages.ts, the article answers WITH a query string too: the
 * pre-PD0c digest fetched the newsletter's link as it was (with `?u=<marker>`), and the RED run must see that fetch
 * succeed (and the marker reach this log - the egress). GET /_log returns the request log (host, path and query).
 *   deno run --allow-net fixtures/digest-lab-pages.ts   (PORT, default 8080)
 */
import { MK } from "./boundary-markers.ts";

const PORT = Number(Deno.env.get("PORT") ?? "8080");
const log: string[] = [];
const page = (title: string, body: string) => new Response(`<html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } });

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => {
  const u = new URL(req.url);
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (u.pathname === "/_log") return Response.json({ log });
  log.push(`${host}${u.pathname}${u.search}`);
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
  if (host === "news.example.org" && u.pathname === "/solar-roofs") {
    return page("Community solar roofs cut winter bills",
      `Community solar roofs cut winter bills by 18 percent in 2024, a survey of cooperative installations found. The ${MK.PUB} method is described in the appendix. `.repeat(8));
  }
  return new Response("not found", { status: 404 });
});
