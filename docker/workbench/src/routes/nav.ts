// /workbench/nav (research-workbench P1b) - the explorer's data, one folder at
// a time: ?folder=<path>&offset=<n>&limit=<n>&focus=<slug>.
//
// The browser reaches it here (same origin, through Caddy's /workbench/* with
// the injected key). The ANSWER is computed by the wiki viewer's nav worker
// (its /__nav on :8082, docker/wiki-viewer/lib/nav-worker.mjs + nav-tree.mjs), because the explorer has to agree with
// the page chrome on Quartz's URL slugs, which paths are pages, folder display
// names and the explorer's sort - rules the viewer already holds over the rows
// it presents. A second copy in SQL/TypeScript would drift from the pages.
// This route forwards the query (clamped), the ETag validators and the answer,
// and fails SOFT (503 JSON): the explorer shows nothing new, pages still render.
import { Hono } from "hono";

export const nav = new Hono();

// The viewer's NAV WORKER (its own thread and port, so the page renderer's
// garbage collection never delays the explorer - docker/wiki-viewer/lib/nav-worker.mjs).
const VIEWER_NAV_URL = (Deno.env.get("VIEWER_NAV_URL") || "http://openbrain-wiki-viewer:8082").replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(500, Number(Deno.env.get("NAV_TIMEOUT_MS") || "5000"));
const MAX_LIMIT = 2000;

// PURE, exported for tests: only these four parameters reach the viewer, each
// a bounded string; the folder and focus are values, never a path we resolve.
export function navQuery(raw: Record<string, string | undefined>): string {
  const out = new URLSearchParams();
  const folder = (raw.folder ?? "").slice(0, 1024);
  out.set("folder", folder);
  const off = Number(raw.offset ?? 0);
  if (Number.isFinite(off) && off > 0) out.set("offset", String(Math.trunc(off)));
  const lim = Number(raw.limit ?? 0);
  if (Number.isFinite(lim) && lim > 0) out.set("limit", String(Math.min(MAX_LIMIT, Math.trunc(lim))));
  const focus = (raw.focus ?? "").slice(0, 1024);
  if (focus) out.set("focus", focus);
  return out.toString();
}

nav.get("/", async (c) => {
  const q = navQuery({
    folder: c.req.query("folder"),
    offset: c.req.query("offset"),
    limit: c.req.query("limit"),
    focus: c.req.query("focus"),
  });
  const headers: Record<string, string> = {};
  const inm = c.req.header("if-none-match");
  if (inm) headers["if-none-match"] = inm;
  try {
    const r = await fetch(`${VIEWER_NAV_URL}/__nav?${q}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const out = new Headers();
    for (const h of ["content-type", "cache-control", "etag", "x-wiki-nav", "server-timing"]) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    if (r.status === 304) return new Response(null, { status: 304, headers: out });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out });
  } catch (err) {
    console.error("[nav] viewer unreachable:", (err as Error).message);
    return c.json({ error: "nav_unavailable" }, 503);
  }
});
