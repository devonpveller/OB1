/**
 * notifications - the research notifications strip in the page chrome
 * (research-workbench P1b; D13 item 7: "research notifications have a home in
 * the front end before the React shell"; P2b's widget replaces it).
 *
 * READ ONLY, FRONT END ONLY: the strip reads the retrieval contract's read
 * endpoint (P0: GET /workbench/contract/notifications, producers post through
 * public.post_research_notification) and renders it into the page the reader
 * asked for. Nothing here posts to a chat channel, the status pipe or any
 * other sink.
 *
 * Server-rendered, no script: unread count, then the newest unread (class,
 * subject, origin, count, a jump link to the page or entity), and an
 * "acknowledge" link. Unread = last_seen newer than the reader's
 * acknowledgement cookie (the contract has no per-reader state, and adding one
 * is the contract owner's call); acknowledging moves the cookie to the newest
 * notification's last_seen and sends the reader back (/__notifications/ack).
 *
 * Freshness: a cached copy younger than WIKI_NOTIFY_TTL_MS (5 s) is used;
 * an older one is refreshed before the page renders, bounded by
 * WIKI_NOTIFY_TIMEOUT_MS (1 s) - so a notification posted more than the TTL
 * ago is on the next page load, and an endpoint that does not answer costs a
 * page at most the timeout, then the strip says it is unavailable.
 */
import { urlSlugOf } from "./shared/quartz-slug.mjs";

const WB_URL = () => (process.env.WORKBENCH_URL || "http://openbrain-workbench:8000").replace(/\/+$/, "");
const WB_KEY = () => process.env.WORKBENCH_KEY || process.env.MCP_ACCESS_KEY || "";
const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const TTL_MS = () => Math.max(0, Number(process.env.WIKI_NOTIFY_TTL_MS ?? "5000"));
const TIMEOUT_MS = () => Math.max(100, Number(process.env.WIKI_NOTIFY_TIMEOUT_MS || "1000"));
export const ACK_COOKIE = "wiki_notif_ack";
const SHOW = 5;
// Theme variables are Quartz's (index.css), so the strip follows dark/light mode.
const STRIP_CSS = ".wiki-notifications{font-size:.85rem;border:1px solid var(--lightgray);border-radius:6px;" +
  "padding:.35rem .6rem;margin:.6rem 0 0}.wiki-notifications .wn-list{margin:.3rem 0 0;padding-left:1.1rem}" +
  ".wiki-notifications .wn-class{font-weight:600;color:var(--secondary)}.wiki-notifications .wn-origin," +
  ".wiki-notifications .wn-count,.wiki-notifications .wn-note{color:var(--gray)}.wiki-notifications .wn-ack{margin-left:.6rem}";

let _cache = { at: 0, list: null, error: null };
let _inflight = null;
const _entitySlug = new Map(); // entity id -> slug | null (rows rarely move; cleared with the cache)

async function fetchList() {
  const r = await fetch(`${WB_URL()}/workbench/contract/notifications?limit=100`, {
    headers: { "x-brain-key": WB_KEY() },
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  if (!r.ok) throw new Error(`notifications endpoint ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.notifications)) throw new Error("notifications endpoint: unexpected shape");
  return j.notifications;
}

function refresh() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const list = await fetchList();
      _cache = { at: Date.now(), list, error: null };
    } catch (e) {
      _cache = { at: Date.now(), list: _cache.list, error: String(e?.message || e).slice(0, 200) };
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** { list, error } - fresh within the TTL; never throws. */
export async function currentNotifications() {
  if (!_cache.at || Date.now() - _cache.at >= TTL_MS()) await refresh();
  return { list: _cache.list, error: _cache.error };
}

// The page an entity notification points at: a compile entity id ("906",
// "#906") is the entity page whose row frontmatter names it.
async function entityHref(entity) {
  const m = /^#?(\d+)$/.exec(String(entity ?? "").trim());
  if (!m) return null;
  const id = m[1];
  if (!_entitySlug.has(id)) {
    try {
      const r = await fetch(`${OB_URL()}/rest/v1/wiki_pages?select=slug&frontmatter->>entity_id=eq.${id}&limit=1`, {
        headers: { apikey: "local-trust" }, signal: AbortSignal.timeout(TIMEOUT_MS()),
      });
      const rows = r.ok ? await r.json() : [];
      _entitySlug.set(id, Array.isArray(rows) && rows[0]?.slug ? rows[0].slug : null);
    } catch {
      return null; // not cached: try again next time
    }
  }
  const slug = _entitySlug.get(id);
  return slug ? "/" + urlSlugOf(slug).split("/").map(encodeURIComponent).join("/") : null;
}

/** The jump target of one notification: its page, its entity's page, else its entry in the list. */
export async function jumpHref(n) {
  if (n.slug) return "/" + urlSlugOf(String(n.slug)).split("/").map(encodeURIComponent).join("/");
  return (await entityHref(n.entity)) || `/__notifications#n-${encodeURIComponent(n.id)}`;
}

export function ackOf(cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === ACK_COOKIE) {
      const t = Date.parse(decodeURIComponent(v.join("=")));
      return Number.isFinite(t) ? t : 0;
    }
  }
  return 0;
}

export const isUnread = (n, ack) => Date.parse(n.last_seen) > ack;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The strip's HTML for one request (cookie = the request's Cookie header, back = its URL). */
export async function stripHtml({ cookie, back }) {
  const { list, error } = await currentNotifications();
  const open = '<div class="wiki-notifications" data-wiki-notifications="1"';
  const style = `<style>${STRIP_CSS}</style>`;
  if (!list) {
    return `${open} data-unread="unknown">${style}<span class="wn-head">Research notifications unavailable</span>` +
      `<span class="wn-note">${esc(error || "not loaded yet")}</span></div>`;
  }
  const ack = ackOf(cookie);
  const unread = list.filter((n) => isUnread(n, ack));
  const newest = list.reduce((m, n) => (Date.parse(n.last_seen) > m ? Date.parse(n.last_seen) : m), 0);
  const items = [];
  for (const n of unread.slice(0, SHOW)) {
    items.push(`<li class="wn-item" data-class="${esc(n.class)}" data-id="${esc(n.id)}">` +
      `<span class="wn-class">${esc(n.class)}</span> <a class="wn-jump" href="${esc(await jumpHref(n))}">${esc(n.subject)}</a>` +
      (n.origin ? ` <span class="wn-origin">${esc(n.origin)}</span>` : "") +
      (n.count > 1 ? ` <span class="wn-count">x${esc(n.count)}</span>` : "") + "</li>");
  }
  const ackLink = unread.length
    ? ` <a class="wn-ack" href="/__notifications/ack?until=${encodeURIComponent(new Date(newest).toISOString())}&amp;back=${encodeURIComponent(safeBack(String(back || "/").split(/[?#]/)[0]))}">acknowledge</a>`
    : "";
  return `${open} data-unread="${unread.length}">${style}` +
    `<span class="wn-head"><a href="/__notifications">${unread.length === 1 ? "1 unread research notification" : `${unread.length} unread research notifications`}</a></span>` +
    ackLink + (items.length ? `<ul class="wn-list">${items.join("")}</ul>` : "") + "</div>";
}

/** The full list page (/__notifications): every notification, newest first, each anchored. */
export async function listDocument({ cookie }) {
  const { list, error } = await currentNotifications();
  const ack = ackOf(cookie);
  const rows = [];
  for (const n of list || []) {
    rows.push(`<li id="n-${esc(n.id)}" class="${isUnread(n, ack) ? "unread" : "read"}"><b>${esc(n.class)}</b> ` +
      `<a href="${esc(await jumpHref(n))}">${esc(n.subject)}</a>` +
      `${n.origin ? ` <i>${esc(n.origin)}</i>` : ""} <span>x${esc(n.count)}</span> <time>${esc(n.last_seen)}</time>` +
      `${n.slug ? ` <code>${esc(n.slug)}</code>` : ""}${n.entity ? ` <code>${esc(n.entity)}</code>` : ""}` +
      `${n.error ? `<pre>${esc(n.error)}</pre>` : ""}</li>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Research notifications</title><style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;` +
    `background:#1e1e24;color:#d4d4dc}a{color:#84a9ff}li{margin:.6rem 0}.unread b{color:#ffb86c}pre{white-space:pre-wrap;color:#9a9ba6}</style></head>` +
    `<body data-wiki-notification-list="1"><h1>Research notifications</h1>` +
    (list ? `<ul>${rows.join("") || "<li>None.</li>"}</ul>` : `<p>The notification endpoint is unavailable: ${esc(error)}</p>`) +
    `<p><a href="/">&larr; Knowledge Vault home</a></p></body></html>`;
}

/**
 * The acknowledgement's redirect target (rw-p1b-ready fix round 1, tester
 * attempt 1 defect 4: a deny-list let "/<TAB>/evil.example" through - browsers
 * strip TAB from a URL, so Location "/<TAB>/evil.example/x" went to
 * http://evil.example/x). An ALLOW-list now: the value must be a same-origin
 * absolute PATH of only ^/[A-Za-z0-9._~/%-]*$ (no query, no fragment, no
 * scheme, no host), and its one-time percent-decoding must not contain a
 * control character (C0, DEL, C1, U+2028/2029), a backslash or "//". Anything
 * else is "/". The strip itself passes the page's path only (stripHtml).
 */
const BACK_ALLOWED = /^\/[A-Za-z0-9._~\/%-]*$/;
const BACK_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]|\/\//;
export function safeBack(raw) {
  if (typeof raw !== "string" || !BACK_ALLOWED.test(raw) || BACK_FORBIDDEN.test(raw)) return "/";
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return "/"; }
  if (!decoded.startsWith("/") || BACK_FORBIDDEN.test(decoded)) return "/";
  return raw;
}

export function _resetNotificationsForTests() {
  _cache = { at: 0, list: null, error: null };
  _inflight = null;
  _entitySlug.clear();
}
