/**
 * rw-boundary-core round 2: the lab's PUBLIC pages, in their own container on the lab's internal network (network
 * aliases news.example.org and blog.example.org on a documentation-range subnet, so the names resolve - through the
 * lab's own DNS - to an address the boundary's resolver judges public; TF6). Synthetic content only. GET /_log returns
 * the request log (path + query) for the sweep; /changing serves a different page on every request (TF4: a page that
 * changes between the gate and the run must not be used).
 *   deno run --allow-net fixtures/boundary-lab-pages.ts   (PORT, default 8080)
 */
import { MK } from "./boundary-markers.ts";

const PORT = Number(Deno.env.get("PORT") ?? "8080");
const log: string[] = [];
let changing = 0;
const page = (title: string, body: string) => new Response(`<html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } });

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => {
  const u = new URL(req.url);
  const host = (req.headers.get("host") ?? "").split(":")[0];
  if (u.pathname === "/_log") return Response.json({ log });
  log.push(`${host}${u.pathname}${u.search}`);
  if (host === "news.example.org" && u.pathname === "/solar-roofs" && !u.search) {
    return page("Community solar roofs cut winter bills", `Community solar roofs cut winter bills by 18 percent in 2024, a survey found. The ${MK.PUB} method is described. `.repeat(8));
  }
  if (host === "news.example.org" && u.pathname === "/changing") {
    changing++;
    return page("Heat pump efficiency in cold climates", `Heat pump efficiency in cold climates, edition ${changing}. `.repeat(8));
  }
  if (host === "blog.example.org" && u.pathname === "/hello") {
    return page("Hello Dana Quillfeather", "Hello Dana Quillfeather, here is your weekly letter about heat pumps. ".repeat(8));
  }
  return new Response("not found", { status: 404 });
});
