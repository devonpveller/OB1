/**
 * Link extraction + hygiene + redirect unwrapping (S3 / P1.2).
 *
 * Newsletter bodies are mostly noise. We pull candidate URLs from the stored
 * text, drop the obvious junk (unsubscribe / view-in-browser / social / assets
 * / mailto), unwrap tracker-redirect wrappers to their real destination, then
 * dedup and cap per email. Aggressive on purpose — the quality of the episode
 * lives here. Start permissive and tune from the eyeball run.
 *
 * The pure functions (extract/classify/host) are dependency-free; only
 * `unwrapRedirect` and `gatherLinks` touch the network.
 */

import { LinkCandidate } from "./types.ts";
import { proxiedFetch } from "./egress.ts";
import { decodeEntities, extractTextFromHtml } from "./extract.ts";

// Bare URLs as they appear inline in plain-text newsletters. Trailing
// punctuation (".,)]" and quotes) is trimmed off by `tidyUrl`.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Hosts whose links are navigation/tracking chrome, never article content. */
const NOISE_HOST_SUBSTR = [
  "unsubscribe",
  "list-manage.com", // mailchimp manage/unsub
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com/channel",
  "t.me",
  "whatsapp.com",
  "mailto:",
  "open.substack.com", // "READ IN APP" duplicate of the post
  "substackcdn.com", // image / asset CDN, never content
];

/** Path/query markers that signal a non-content link even on a content host. */
const NOISE_PATH_SUBSTR = [
  "/unsubscribe",
  "/manage",
  "/preferences",
  "/email-preferences",
  "view-in-browser",
  "viewinbrowser",
  "/forward",
  "utm_unsub",
  // Substack (and similar) machinery — seen slipping to the robots/403 stage in
  // the P1 eyeball; drop pre-fetch so we don't waste a Tor round-trip on them.
  "/action/", // /action/disable_email, /action/... — newsletter plumbing
  "/subscribe", // subscribe CTA, not article content
  "disable_email",
  "/comments", // comment threads, not the article body
  "support.substack.com",
  "/hc/", // zendesk-style help-center articles
  // Substack meta — author profiles, signup/referral. Not content. NOTE:
  // `/app-link/post` is NOT dropped here — it is the link to the newsletter's
  // own post, which IS the content for single-post emails. It's treated as a
  // redirect wrapper (below) and unwrapped to the real /p/ URL instead.
  "/@", // substack.com/@author profile
  "/profile/", // substack.com/profile/<id>
  "/signup",
  "/leaderboard",
  "/lead", // leader/leaderboard/invite-friends programs
];

/** File extensions we never treat as article content. */
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf|mp4|mov|pdf)(\?|#|$)/i;

/** Known redirect/tracker wrapper hosts — unwrap these before ingest + dedup. */
const REDIRECT_HOST_SUBSTR = [
  "link.mail.beehiiv.com",
  "elink.beehiiv.com",
  "substack.com/redirect",
  "substack.com/app-link", // deep-link to a post → unwrap to the real /p/ URL
  "email.mg",
  "mandrillapp.com",
  "list-manage.com/track",
  "sendgrid.net",
  "click.",
  "/ss/c/", // sparkpost/hubspot click wrappers
  "ct.sendgrid",
  "links.",
  "trk.",
  "email.",
];

/** Trim trailing punctuation that bleeds in from prose. */
function tidyUrl(u: string): string {
  let s = u.trim();
  // Drop common trailing punctuation not part of a URL.
  while (/[.,;:!?)\]}>'"]$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Best-effort host extraction; "" when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Pull every http(s) URL out of a block of text, tidied + de-duplicated. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(text || "").match(URL_RE) ?? []) {
    const u = tidyUrl(m);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Is this a tracker/redirect wrapper we should resolve before using? */
export function isRedirectWrapper(url: string): boolean {
  const lower = url.toLowerCase();
  return REDIRECT_HOST_SUBSTR.some((s) => lower.includes(s));
}

/**
 * Classify a (preferably already-unwrapped) URL. Returns a drop-reason string
 * for noise, or undefined for a keep.
 */
export function classifyLink(url: string): string | undefined {
  const lower = url.toLowerCase();
  if (lower.startsWith("mailto:")) return "mailto";
  const host = hostOf(url);
  if (!host) return "unparseable";
  if (ASSET_EXT_RE.test(lower)) return "asset";
  if (NOISE_HOST_SUBSTR.some((s) => lower.includes(s))) return "social/nav-host";
  if (NOISE_PATH_SUBSTR.some((s) => lower.includes(s))) return "nav-path";
  return undefined;
}

// ── 200-that-is-really-a-redirect ────────────────────────────────────────────
//
// Publishers increasingly answer a tracker URL with a tiny HTML SHELL that
// bounces the browser on (a zero-delay <meta http-equiv="refresh"> in a
// <noscript>, plus a `location.replace(...)`) instead of sending a 302.
// Substack switched its /redirect/<uuid> endpoint to this shape around
// 2026-09-06, and because unwrapRedirect() only followed a `Location` header
// every wrapper "resolved" to substack.com and was then dropped by
// link-enrich's newsletter-self-link filter: the daily digest researched ZERO
// external articles for three days while every log line stayed green.
//
// Honouring the meta-refresh form is not a heuristic — a zero-delay refresh IS
// the HTML spec's client-side redirect. The scripted form is honoured only in a
// document that is a SHELL, so an ordinary article that happens to contain the
// string `location.replace` is never treated as a redirect. Nothing here knows
// about Substack; the next publisher to do this is handled by the same code.

/** A redirect shell is ~1–2KB. Bigger than this is not a shell, and the body is
 *  never buffered past it (see readHtmlPrefix). */
const INTERSTITIAL_MAX_BYTES = 16_384;
/** Visible text in a shell is a stray "Redirecting…" at most. An article has more. */
const INTERSTITIAL_MAX_TEXT = 200;

/** `<meta http-equiv="refresh" content="0; url=…">` — the target, if the delay
 *  is an immediate 0. A timed refresh (`content="5;…"`) is a page that means to
 *  be READ first, so it is not a redirect. */
function metaRefreshTarget(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?refresh["']?/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const [delayPart, ...rest] = content.split(";");
    const delay = Number(delayPart.trim());
    if (!Number.isFinite(delay) || delay !== 0) continue;
    const target = rest.join(";").replace(/^\s*url\s*=\s*/i, "").trim()
      .replace(/^["']|["']$/g, "");
    if (target) return target;
  }
  return null;
}

/** `location.replace("…")` / `location.assign("…")` / `location.href = "…"`. */
function scriptedLocationTarget(html: string): string | null {
  const m = html.match(
    /\blocation\s*(?:\.\s*(?:replace|assign)\s*\(\s*|\.\s*href\s*=\s*|\s*=\s*)["']([^"']+)["']/i,
  );
  return m?.[1] ?? null;
}

/**
 * The destination a redirect SHELL points at, or null when this document is not
 * one. Two independent conditions have to hold before any target is honoured —
 * the document is small AND it has no visible text — so a real article is never
 * mistaken for a redirect no matter what its scripts contain.
 *
 * Exported for tests: the parsing is the part worth pinning down.
 */
export function interstitialTarget(html: string, baseUrl: string): string | null {
  if (html.length > INTERSTITIAL_MAX_BYTES) return null;
  if (extractTextFromHtml(html).length > INTERSTITIAL_MAX_TEXT) return null;
  const raw = metaRefreshTarget(html) ?? scriptedLocationTarget(html);
  if (!raw) return null;
  let abs: string;
  try {
    abs = new URL(decodeEntities(raw).trim(), baseUrl).toString();
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(abs)) return null;
  // A page that refreshes to itself is a loop, not a hop — report "arrived".
  if (abs.split("#")[0] === baseUrl.split("#")[0]) return null;
  return abs;
}

/**
 * Read at most `maxBytes` of an HTML response and return it; null when the body
 * is not HTML or is too big to be a redirect shell. Bounded on purpose: this
 * runs on every tracker URL, and an article page must never be buffered whole
 * just to find out it is not a redirect.
 */
async function readHtmlPrefix(res: Response, maxBytes: number): Promise<string | null> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !/text\/html|application\/xhtml\+xml/i.test(ct)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    return null; // truncated/failed read → treat as "not a shell", never throw
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total > maxBytes) return null; // too big to be a shell; stopped reading
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Resolve a tracker/redirect URL to its final destination. Follows redirects
 * with a hop cap and a short timeout; falls back to the input on any failure
 * (never throws). Uses GET (many trackers 405 on HEAD). A 3xx is followed by
 * its `Location`; a 2xx is read (bounded) and followed only when it is a
 * redirect shell — both count as a hop against `maxHops`.
 */
export async function unwrapRedirect(
  url: string,
  opts: { maxHops?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxHops = opts.maxHops ?? 5;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    try {
      const res = await proxiedFetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        // Generic UA — don't fingerprint the automated follower (see extract.ts).
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
        },
      });
      // Manual mode: a 3xx exposes Location; a 2xx/other means we've arrived.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        res.body?.cancel().catch(() => {});
        if (!loc) return current;
        current = new URL(loc, current).toString();
        continue;
      }
      // Not a 3xx. The browser/Deno may have already resolved to res.url on a
      // final hop. Before calling it arrived, check whether this 200 is really
      // a redirect shell (meta-refresh / location.replace) and take that hop.
      const landed = res.url && res.url !== "" ? res.url : current;
      const html = await readHtmlPrefix(res, INTERSTITIAL_MAX_BYTES);
      const target = html === null ? null : interstitialTarget(html, landed);
      if (target) {
        current = target;
        continue;
      }
      return landed;
    } catch {
      return current; // network/timeout → use what we have
    }
  }
  return current;
}

/** Anchor-text patterns that mark a link as navigation/promo/chrome. */
const NOISE_TEXT_RE =
  /\b(unsubscribe|subscribe|sign ?up|manage (your )?(subscription|preferences|account)|view (this )?in (your )?browser|read in app|update your profile|invite (friends|a friend)|share|tweet|re-?stack|forward (this|to a friend)|follow us|privacy policy|terms of service|upgrade|annual plan|become a (paid )?(member|subscriber)|\d+% off)\b/i;

/** Substack encodes the real destination in redirect/2/<base64-json>.{e}.
 *  Decode it locally (no network). Returns the destination URL or null. */
function decodeSubstackRedirect(url: string): string | null {
  const m = url.match(/substack\.com\/redirect\/2\/([A-Za-z0-9_-]+)/i);
  if (!m) return null;
  try {
    const obj = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof obj?.e === "string" && /^https?:\/\//i.test(obj.e) ? obj.e : null;
  } catch {
    return null;
  }
}

/**
 * Pre-filter + RESOLVE raw HTML anchors so POI sees real destinations, not
 * opaque tracker wrappers. Resolves locally where possible (substack base64),
 * network-unwraps the rest (bounded by maxUnwrap), and drops noise on the
 * RESOLVED url + anchor text. Returns candidates carrying anchor text.
 */
export async function gatherAnchors(
  anchors: Array<{ url: string; text: string }>,
  opts: { maxRaw?: number; maxUnwrap?: number; unwrapTimeoutMs?: number } = {},
): Promise<LinkCandidate[]> {
  const max = opts.maxRaw ?? 80;
  const maxUnwrap = opts.maxUnwrap ?? 25;
  const kept: LinkCandidate[] = [];
  const seen = new Set<string>();
  let unwraps = 0;
  for (const a of anchors) {
    const raw = tidyUrl(a.url);
    if (!/^https?:\/\//i.test(raw)) continue;
    if (a.text && NOISE_TEXT_RE.test(a.text)) continue; // text-based noise (free)

    // Resolve to the real destination so POI/hygiene see a real URL. Substack
    // base64 decodes for free; cap the NETWORK unwraps for opaque wrappers.
    let url = decodeSubstackRedirect(raw) ?? raw;
    let unresolvedWrapper = false;
    if (url === raw && isRedirectWrapper(raw)) {
      if (unwraps >= maxUnwrap) continue; // out of unwrap budget → skip opaque wrapper
      unwraps++;
      url = await unwrapRedirect(raw, { timeoutMs: opts.unwrapTimeoutMs });
      // The unwrap was ATTEMPTED and the URL did not move: the destination is
      // unknown. Only a candidate that went through this branch can be marked,
      // so a real destination that merely LOOKS wrapper-ish is never flagged.
      unresolvedWrapper = url === raw;
    }

    if (classifyLink(url)) continue; // noise on the RESOLVED url (catches substack meta)
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({
      rawUrl: a.url,
      url,
      domain: hostOf(url),
      text: a.text?.replace(/\s+/g, " ").trim().slice(0, 160),
      ...(unresolvedWrapper ? { unresolvedWrapper: true } : {}),
    });
    if (kept.length >= max) break;
  }
  return kept;
}

/**
 * Full pipeline for one email's body text: extract → unwrap wrappers →
 * classify → dedup by final URL → cap. Kept candidates have `dropped`
 * undefined; dropped ones carry the reason (returned too, for the report's
 * transparency, but the runner only fetches the kept ones).
 */
export async function gatherLinks(
  bodyText: string,
  opts: { maxLinks?: number; unwrapTimeoutMs?: number } = {},
): Promise<LinkCandidate[]> {
  const maxLinks = opts.maxLinks ?? 5;
  const rawUrls = extractUrls(bodyText);

  const kept: LinkCandidate[] = [];
  const seenFinal = new Set<string>();

  for (const rawUrl of rawUrls) {
    // Cheap pre-filter on the raw URL before paying for a network unwrap.
    const preDrop = classifyLink(rawUrl);
    if (preDrop && !isRedirectWrapper(rawUrl)) {
      continue; // obvious noise, not a wrapper — skip silently
    }

    const url = isRedirectWrapper(rawUrl)
      ? await unwrapRedirect(rawUrl, { timeoutMs: opts.unwrapTimeoutMs })
      : rawUrl;

    const drop = classifyLink(url);
    if (drop) continue;

    // Dedup on the final destination, ignoring the fragment.
    const dedupKey = url.split("#")[0];
    if (seenFinal.has(dedupKey)) continue;
    seenFinal.add(dedupKey);

    kept.push({ rawUrl, url, domain: hostOf(url) });
    if (kept.length >= maxLinks) break; // cap per email (bound crawl cost)
  }

  return kept;
}
