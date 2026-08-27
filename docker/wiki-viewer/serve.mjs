// Minimal static file server for the compiled Quartz site (Research Engine /
// wiki availability rework). Always serves the CURRENT good build via the
// /srv/current symlink — the entrypoint rebuilds into a new versioned dir and
// atomically re-points the symlink only when the viewer is idle, so a reader
// NEVER sees a "rebuilding" splash. Records request activity to
// /tmp/last-access so the rebuild loop can tell when the viewer is in use.
//
// 2026-08-23 perf rework: fully async I/O, ETag/Last-Modified validators with
// 304 handling (the site is served `no-cache` so browsers/CDNs always
// revalidate — before this there were NO validators, so every visit
// re-downloaded everything, including the multi-MB index), throttled
// last-access bookkeeping, and a cached readiness probe.
import http from "node:http";
// Phase B (no-rebuild): DB-rendered fallback. lib/ is COPYed next to this
// file at /quartz/serve.mjs so Quartz's own node_modules resolve the
// unified/remark imports (ESM ignores NODE_PATH).
import { renderMarkdown } from "./lib/render-page.mjs";
import { pageDocument, notAvailableDocument } from "./lib/page-document.mjs";
import { fetchWikiPage, dbRenderEnabled } from "./lib/wiki-db.mjs";
import { getNavIndex, navIndexEnabled } from "./lib/nav-index.mjs";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = "/srv/current"; // a symlink → /srv/build-N (swapped atomically)
// The builder's LIVE output. Fallback for a just-created note/folder that the
// incremental watcher has already emitted but the idle-gated snapshot hasn't
// published yet — so user-created content appears in ~seconds instead of waiting
// out the idle gate (2026-06-17). Serving an individual fresh page from here is
// safe: render assets (css/js) still come from the complete snapshot.
const LIVE = "/quartz/public";
const PUBLISH_FLAG = "/tmp/ne-publish"; // serve.mjs sets it; the entrypoint loop
// honors it to publish promptly (bypassing the idle gate) so the nav/index catch up.
const PORT = parseInt(process.env.PORT || "8080", 10);
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".xml": "application/xml", ".txt": "text/plain",
  ".map": "application/json", ".webmanifest": "application/manifest+json",
};

// Quartz emits the client bundle + styles under STABLE names (postscript.js,
// prescript.js, index.css) whose CONTENT changes every rebuild. `no-cache`
// forces revalidation on every use; the ETag/Last-Modified validators below
// turn that revalidation into a cheap 304 instead of a re-download. True
// static (fonts/images) may cache for a day.
const REBUILDABLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml", ".map", ".webmanifest", ".txt"]);
const cacheControl = (ext) =>
  REBUILDABLE.has(ext) ? "no-cache, must-revalidate" : "public, max-age=86400";

// Snapshot dirs are immutable once published, so size+mtime is a sound ETag.
const etagOf = (st) => `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;

async function resolveIn(root, p) {
  const base = normalize(join(root, p || "/"));
  if (!base.startsWith(root)) return null; // path traversal guard
  const candidates = p === "" || p === "/"
    ? [join(root, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  for (const c of candidates) {
    try {
      const st = await stat(c);
      if (st.isFile()) return { file: c, st };
    } catch { /* next */ }
  }
  return null;
}
async function resolve(urlPath) {
  // Quartz prettyURLs emit `foo/index.html`; also tolerate `foo.html`.
  let p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p = p.slice(0, -1);
  // Published snapshot first (stable, gated); fall back to the LIVE builder
  // output for a page that exists there but isn't snapshotted yet (a brand-new
  // note/folder), so it's reachable in ~seconds.
  return (await resolveIn(ROOT, p)) || (await resolveIn(LIVE, p));
}

// No good build yet (cold start / very first compile, before /srv/current is
// published)? Serve a self-refreshing splash so a reader who arrives mid-build
// sees "Building…" rather than a connection error. Once a snapshot exists this
// never shows again — nightly rebuilds keep serving the previous snapshot.
//
// COMPLETENESS gate (2026-06-15): a build is "ready" ONLY if it has index.html
// AND the core ComponentResources (styles + client JS). Requiring the full set
// means an incomplete /srv/current falls back to the splash instead of serving
// a broken, unstyled page. (Belt-and-suspenders with the entrypoint publish
// gate.) static/contentIndex.json = the search index; static/graphIndex.json =
// the lean graph/explorer index derived at publish time (2026-08-23) — a
// snapshot missing either falls back to the splash.
const REQUIRED = [
  "index.html", "index.css", "prescript.js", "postscript.js",
  // contentIndex.json was dropped here in wiki-dynamic-index P2: Quartz's
  // ContentIndex emitter is switched off (it was the last non-incremental
  // emitter), so the file no longer exists and requiring it would pin
  // buildReady() false forever -> the splash on every request.
  "static/graphIndex.json",
];
// Readiness only changes when the /srv/current symlink is re-pointed — cache
// the probe briefly instead of stat()ing 6 files on EVERY request.
let _ready = { at: 0, ok: false };
async function buildReady() {
  const now = Date.now();
  if (now - _ready.at < 2000) return _ready.ok;
  let ok = true;
  try {
    for (const f of REQUIRED) {
      if (!(await stat(join(ROOT, f))).isFile()) { ok = false; break; }
    }
  } catch { ok = false; }
  _ready = { at: now, ok };
  return ok;
}

// Throttled request-activity marker (was a SYNCHRONOUS write per request).
// lastAccessMs is exact (in memory) — the file write for the snapshot loop
// stays throttled. Exposed at /__last-access so the COMPILER can defer its
// bulk backfill while a human is actually using the wiki (operator
// 2026-08-24: drain waits until 15min after the last interaction).
let lastAccessMs = 0;
let _lastAccessWrote = 0;
function markAccess() {
  const now = Date.now();
  lastAccessMs = now;
  if (now - _lastAccessWrote < 5000) return;
  _lastAccessWrote = now;
  writeFile("/tmp/last-access", String(Math.floor(now / 1000))).catch(() => {});
}

// ── Truthful miss-handling (2026-08-23) ─────────────────────────────────────
// The vault is mounted read-only at /wiki, so an HTML miss can be told apart:
//   1. JUST-CREATED — the markdown exists but the builder hasn't emitted the
//      page yet → an auto-refreshing "building" page (+ prompt-publish flag),
//      instead of the 404 that made a fresh note look broken.
//   2. REGISTERED-BUT-UNBUILT — the slug is in the compiler's planned.json
//      (entities the brain knows whose page hasn't been synthesized yet — the
//      truthful wiki-filler queue) → a "queued for synthesis" page.
//   3. Anything else → the real 404.
const WIKI = "/wiki";

let _planned = { at: 0, mtimeMs: 0, map: {}, byBase: {} };
async function plannedFor(urlPath) {
  const key = decodeURIComponent(urlPath.split("?")[0].split("#")[0])
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const now = Date.now();
  if (now - _planned.at > 10_000) {
    _planned.at = now;
    try {
      const file = join(WIKI, "planned.json");
      const st = await stat(file);
      if (st.mtimeMs !== _planned.mtimeMs) {
        const map = JSON.parse(await readFile(file, "utf8")).planned ?? {};
        // Quartz renders a wikilink to a nonexistent page as its BASENAME url
        // (`/organization-anthropic`, not `/content/organization/…`), so the
        // queue must also answer by basename.
        const byBase = {};
        for (const [k, v] of Object.entries(map)) byBase[k.split("/").pop()] = v;
        _planned = { at: now, mtimeMs: st.mtimeMs, map, byBase };
      }
    } catch {
      _planned = { at: now, mtimeMs: 0, map: {}, byBase: {} };
    }
  }
  return _planned.map[key] ?? (key.includes("/") ? null : _planned.byBase[key] ?? null);
}

async function findFreshMarkdown(urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0].split("#")[0])
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!rel || extname(rel)) return null; // page URLs only, never assets
  const base = normalize(join(WIKI, rel));
  if (!base.startsWith(WIKI)) return null; // traversal guard
  const candidates = [`${base}.md`, join(base, "index.md")];
  // Quartz slugifies spaces to dashes; author-owned trees may hold the
  // space-named original of a dash URL.
  if (/^(notes|content\/notebooks)\//.test(rel) && rel.includes("-")) {
    candidates.push(`${normalize(join(WIKI, rel.replace(/-/g, " ")))}.md`);
  }
  for (const c of candidates) {
    try {
      const st = await stat(c);
      // Only a RECENT file counts as "just created, still building" — an old
      // markdown with no emitted HTML is some other condition, not a build lag.
      if (st.isFile() && Date.now() - st.mtimeMs < 3600_000) {
        return { file: c, isNote: rel.startsWith("notes/"), mtimeMs: st.mtimeMs };
      }
    } catch { /* next */ }
  }
  return null;
}

// Interim rendering for a just-created page: the CONTENT is available (we
// have the markdown) even though the built page isn't — show it. For user
// notes this matters most (operator 2026-08-24: notes are the user's own
// editable documents, not knowledge-base pages — a bare "wait for the build"
// screen made a fresh note unusable). Minimal, safe markdown-ish rendering:
// escaped text with headings/paragraph breaks preserved.
function renderInterimContent(md) {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, ""); // drop frontmatter
  const blocks = esc(body).split(/\n{2,}/).map((b) => {
    const h = b.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(6, h[1].length + 1);
      return `<h${lvl}>${h[2]}</h${lvl}>`;
    }
    return `<p>${b.replace(/\n/g, "<br>")}</p>`;
  });
  return blocks.join("\n");
}

const miniPage = (title, heading, body, refresh) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${title}</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:#1e1e24;color:#d4d4dc}
.box{text-align:center;max-width:34rem;padding:2rem}
.badge{display:inline-block;padding:.15rem .6rem;border:1px solid #44454f;border-radius:1rem;
font-size:.75rem;color:#9a9ba6;margin-bottom:1rem}
h1{font-size:1.15rem;font-weight:600;margin:0 0 .5rem}
p{font-size:.9rem;color:#9a9ba6;margin:.3rem 0;line-height:1.55}
a{color:#84a9ff;text-decoration:none}</style>
</head><body><div class="box"><div class="badge">${title}</div><h1>${heading}</h1>
${body}<p><a href="/">← Knowledge Vault home</a></p></div></body></html>`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SPLASH = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="6"><title>Building the wiki…</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:#1e1e24;color:#d4d4dc}
.box{text-align:center;max-width:30rem;padding:2rem}
.spin{width:2.4rem;height:2.4rem;border:3px solid #44454f;border-top-color:#84a9ff;border-radius:50%;
margin:0 auto 1.2rem;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
h1{font-size:1.1rem;font-weight:600;margin:0 0 .4rem}p{font-size:.85rem;color:#9a9ba6;margin:.2rem 0;line-height:1.5}</style>
</head><body><div class="box"><div class="spin"></div><h1>Building the wiki…</h1>
<p>The site is compiling. This page refreshes automatically and will load as soon as a complete build is ready.</p>
</div></body></html>`;

// 304 when the client's validator still matches (site is no-cache → every use
// revalidates; this makes that revalidation ~free).
function notModified(req, st) {
  const inm = req.headers["if-none-match"];
  if (inm) return inm === etagOf(st);
  const ims = req.headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    return Number.isFinite(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

function baseHeaders(st, ext) {
  return {
    etag: etagOf(st),
    "last-modified": new Date(st.mtimeMs).toUTCString(),
    "cache-control": cacheControl(ext),
  };
}

async function handle(req, res) {
  // Machine probe — must NOT count as user interaction.
  if (req.url === "/__last-access") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ts: lastAccessMs }));
    return;
  }
  markAccess();
  if (!(await buildReady())) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "6" });
    res.end(SPLASH);
    return;
  }
  // Phase C: serve the nav/graph index LIVE from wiki_pages. Same url, same
  // shape, so the Explorer/graph/autocomplete need no change - but a page
  // created seconds ago is in the sidebar on the next load instead of waiting
  // for a snapshot swap. Falls back to the published file if the DB is
  // unavailable (handled by returning null).
  if (navIndexEnabled() && (req.url || "").split("?")[0].endsWith("/static/graphIndex.json")) {
    const nav = await getNavIndex();
    if (nav) {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
        etag: nav.etag,
        "x-wiki-nav": "db",
      };
      if (req.headers["if-none-match"] === nav.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(nav.json) });
      res.end(req.method === "HEAD" ? undefined : nav.json);
      return;
    }
  }

  // Alias for clients cached from before the index change (see above).
  if ((req.url || "").split("?")[0].endsWith("/static/contentIndex.json")) {
    const lean = join(ROOT, "static", "graphIndex.json");
    try {
      const st = await stat(lean);
      res.writeHead(200, {
        ...baseHeaders(st, ".json"),
        "content-type": "application/json; charset=utf-8",
        "content-length": st.size,
      });
      createReadStream(lean).pipe(res);
      return;
    } catch { /* no lean index either - fall through to the normal 404 */ }
  }
  const hit = await resolve(req.url || "/");
  if (hit) {
    const { file, st } = hit;
    // Served from the LIVE builder output ⇒ this page isn't in the published
    // snapshot yet (a just-created note/folder). Signal the snapshot loop to
    // publish promptly (bypassing the idle gate) so the nav/index catch up.
    if (file.startsWith(LIVE)) writeFile(PUBLISH_FLAG, "1").catch(() => {});
    const ext = extname(file);
    if (notModified(req, st)) {
      res.writeHead(304, baseHeaders(st, ext));
      res.end();
      return;
    }
    const head = { ...baseHeaders(st, ext), "content-type": MIME[ext] || "application/octet-stream" };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...head, "content-length": st.size });
      res.end();
      return;
    }
    if (ext === ".html") {
      // Legacy dev-mode hot-reload strip. The builder no longer injects the
      // ws://localhost reload client (patched out in the Dockerfile), so this
      // only fires for pages built before that patch; the cheap substring
      // check keeps the streaming path for everything else.
      const html = await readFile(file, "utf8");
      const cleaned = html.includes("ws://localhost")
        ? html.replace(
            /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?ws:\/\/localhost(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
            "",
          )
        : html;
      res.writeHead(200, { ...head, "content-length": Buffer.byteLength(cleaned) });
      res.end(cleaned);
      return;
    }
    res.writeHead(200, { ...head, "content-length": st.size });
    createReadStream(file).pipe(res);
    return;
  }
  const urlPath = req.url || "/";
  // 1. Phase B — the page is not in any build but IS in Open Brain: render it
  // from wiki_pages with the REAL markdown renderer. Read-only, no client
  // bundle (audit A-1); no-store so a cached transient fallback can never pin
  // itself over the real page (audit A-4). Runs BEFORE the fresh-file interim
  // so drain-written pages get the real render; a brand-new NOTE (file exists,
  // row not yet synced) falls through to the interim below.
  if (dbRenderEnabled()) {
    const key = decodeURIComponent(urlPath.split("?")[0].split("#")[0])
      .replace(/^\/+/, "").replace(/\/+$/, "");
    if (key && !extname(key)) {
      const row = await fetchWikiPage(key);
      if (row) {
        writeFile(PUBLISH_FLAG, "1").catch(() => {});
        let bodyHtml = "";
        try { bodyHtml = renderMarkdown(row.body); } catch { /* render never blocks the page */ }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-wiki-render": "db",
        });
        res.end(pageDocument({ title: row.title, bodyHtml, slug: row.slug, updatedAt: row.updated_at }));
        return;
      }
    }
  }

  // 1. Just-created page: markdown exists, HTML not emitted yet — serve the
  // CONTENT immediately (readable interim render) with an auto-refresh, and
  // ask the snapshot loop to publish promptly. A fresh user note is the
  // user's own document — it must be readable the second it exists.
  const fresh = await findFreshMarkdown(urlPath);
  if (fresh) {
    // A file exists but has no build and no DB row yet (a note saved seconds
    // ago). Render it with the SAME renderer + themed document as the DB path:
    // the old bespoke interim markup linked NO stylesheet, which is exactly the
    // unstyled "white screen with a title" the operator hit (2026-08-26).
    writeFile(PUBLISH_FLAG, "1").catch(() => {});
    let md = "";
    try { md = await readFile(fresh.file, "utf8"); } catch { /* vanished */ }
    let bodyHtml = "";
    let title = "";
    try {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
      const body = fm ? md.slice(fm[0].length) : md;
      const t = fm ? /^title:\s*(.*)$/m.exec(fm[1]) : null;
      title = t ? t[1].trim().replace(/^["']|["']$/g, "") : "";
      bodyHtml = renderMarkdown(body);
    } catch { /* never block the page on a render error */ }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-wiki-render": "fresh",
    });
    res.end(pageDocument({
      title, bodyHtml,
      slug: decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, ""),
      editable: fresh.isNote,
    }));
    return;
  }
  // 2. Registered-but-unbuilt entity: honest status page from planned.json.
  // `unlinked` entries (below the sweep's link threshold — see the wiki
  // service's lib/entity-links.mjs) are NOT in the backfill queue, so
  // promising "an upcoming compile" for them would be a lie.
  const planned = await plannedFor(urlPath);
  if (planned) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(miniPage(
      planned.unlinked ? "Known, not yet cited" : "Queued for synthesis",
      esc(planned.name || "This page"),
      planned.unlinked
        ? `<p><strong>${esc(planned.name || "This entity")}</strong> (${esc(planned.type || "entity")})
       is registered in Open Brain, but no thought or source cites it yet.
       A wiki page is synthesized automatically once something links to it.</p>`
        : `<p><strong>${esc(planned.name || "This entity")}</strong> (${esc(planned.type || "entity")})
       is registered in Open Brain but its wiki page hasn't been synthesized yet.
       It will appear automatically on an upcoming compile — no action needed.</p>`,
      null,
    ));
    return;
  }
  // 3. Nothing anywhere. For a wiki-looking (extension-less) path this is
  // almost always a link to a RETIRED page class, so answer with a themed
  // explanation rather than a bare 404: the client prefetches links for
  // popovers and a non-2xx there logs a console error on every hover
  // (operator, 2026-08-26). Assets and anything with an extension still 404.
  {
    const p3 = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
    if (!extname(p3) && p3 !== "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-wiki-render": "not-available",
      });
      res.end(notAvailableDocument({ slug: p3.replace(/^\/+/, "") }));
      return;
    }
  }

  // 3. True 404 — fall back to Quartz's generated 404 page if present.
  try {
    const nf = join(ROOT, "404.html");
    await stat(nf);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    createReadStream(nf).pipe(res);
    return;
  } catch { /* no 404 page */ }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[wiki-viewer] request failed:", e?.message || e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  })
  .listen(PORT, () => console.log(`[wiki-viewer] static idle-swap server on :${PORT}`));
