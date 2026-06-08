/**
 * Fetch + extract one article to plain text (S3 / P1.3), with robots respect
 * and paywall/stub detection (P1.8).
 *
 * Best-effort and time-boxed: a hung crawl, dead link, paywall, robots block,
 * or thin stub → `{ ok: false }` with a reason, and the runner falls the link
 * back to `email-only`. Never throws, never retries in a storm.
 *
 * `extractTextFromHtml` is copied from OB1/integrations/research-service/lib.ts
 * (kept self-contained rather than coupling the recipe to the research-service
 * deployable — it's ~20 lines of pure string work).
 */

import { ExtractResult } from "./types.ts";
import { proxiedFetch } from "./egress.ts";

const UA = "openbrain-digest/1.0 (+https://github.com/; respectful link follower)";

/** A fetched page shorter than this (after extraction) is treated as a stub. */
const MIN_ARTICLE_CHARS = 400;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** HTML → readable text. Drops non-content elements; keeps paragraph breaks. */
export function extractTextFromHtml(html: string): string {
  let s = String(html || "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(nav|header|footer|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
}

/** Pull the document <title>, decoded + trimmed. */
export function extractTitle(html: string): string {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// ── robots.txt (minimal, per-origin cached) ─────────────────────────────────
const robotsCache = new Map<string, string[]>(); // origin → Disallow paths for *

async function disallowedPaths(origin: string, timeoutMs: number): Promise<string[]> {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!;
  let disallows: string[] = [];
  try {
    const res = await proxiedFetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": UA },
    });
    if (res.ok) {
      const txt = await res.text();
      disallows = parseRobots(txt);
    } else {
      res.body?.cancel().catch(() => {});
    }
  } catch {
    disallows = []; // no robots / unreachable → allow (best-effort)
  }
  robotsCache.set(origin, disallows);
  return disallows;
}

/** Extract Disallow paths that apply to `User-agent: *`. */
export function parseRobots(txt: string): string[] {
  const lines = String(txt || "").split(/\r?\n/);
  const disallows: string[] = [];
  let appliesToStar = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      appliesToStar = ua[1].trim() === "*";
      continue;
    }
    if (!appliesToStar) continue;
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis) {
      const path = dis[1].trim();
      if (path) disallows.push(path);
    }
  }
  return disallows;
}

/** True if `url`'s path is blocked by a `User-agent: *` Disallow rule. */
export async function robotsBlocked(url: string, timeoutMs = 8_000): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const disallows = await disallowedPaths(u.origin, timeoutMs);
  return disallows.some((d) => d === "/" || u.pathname.startsWith(d));
}

/**
 * Fetch + extract one URL. Respects robots, time-boxes the fetch, and flags
 * paywall/stub responses. Returns `{ ok:false, reason }` for every fallback
 * path so the runner can mark the link `email-only`.
 */
export async function fetchAndExtract(
  url: string,
  opts: { timeoutMs?: number; respectRobots?: boolean } = {},
): Promise<ExtractResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  if (opts.respectRobots !== false && (await robotsBlocked(url))) {
    return { ok: false, status: 0, title: "", text: "", reason: "robots-blocked" };
  }

  let res: Response;
  try {
    res = await proxiedFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
  } catch (err) {
    return { ok: false, status: 0, title: "", text: "", reason: `fetch-failed: ${err}` };
  }

  if (res.status === 401 || res.status === 403 || res.status === 451) {
    res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, title: "", text: "", reason: `blocked-${res.status}` };
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, title: "", text: "", reason: `http-${res.status}` };
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(ctype)) {
    res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, title: "", text: "", reason: `non-html: ${ctype}` };
  }

  const html = await res.text();
  const text = extractTextFromHtml(html);
  const title = extractTitle(html);

  if (text.length < MIN_ARTICLE_CHARS) {
    return { ok: false, status: res.status, title, text, reason: "thin-stub/paywall" };
  }

  return { ok: true, status: res.status, title, text };
}
