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
];

/** File extensions we never treat as article content. */
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf|mp4|mov|pdf)(\?|#|$)/i;

/** Known redirect/tracker wrapper hosts — unwrap these before ingest + dedup. */
const REDIRECT_HOST_SUBSTR = [
  "link.mail.beehiiv.com",
  "elink.beehiiv.com",
  "substack.com/redirect",
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

/**
 * Resolve a tracker/redirect URL to its final destination. Follows redirects
 * with a hop cap and a short timeout; falls back to the input on any failure
 * (never throws). Uses GET (many trackers 405 on HEAD) but we don't read the
 * body — we only want the final URL.
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
      res.body?.cancel().catch(() => {});
      // The browser/Deno may have already resolved to res.url on a final hop.
      return res.url && res.url !== "" ? res.url : current;
    } catch {
      return current; // network/timeout → use what we have
    }
  }
  return current;
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
