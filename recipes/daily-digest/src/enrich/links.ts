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

/**
 * Is this a destination a RESEARCH fetch may be pointed at?
 *
 * WHY THIS EXISTS (operator question, 2026-09-09): a redirect target is the one
 * value in this pipeline that is chosen by the page we just fetched - i.e. by
 * whoever controls the tracker - and we then FETCH it. Nothing in the codebase
 * screened it: `fetchAndExtract` fetches whatever URL it is handed.
 *
 * What is NOT a risk here, measured rather than assumed: no JavaScript is ever
 * executed. `scanDocument` reads the document as text, `LOCATION_ASSIGN_RE`
 * lifts a STRING out of a script body, and nothing evals it - there is no eval,
 * no `new Function`, no DOM, no headless browser anywhere in this path.
 *
 * What IS a risk is where that string points. Probed live 2026-09-09 through the
 * real egress (`FETCH_PROXY_URL=http://vpn:8888`): internal targets
 * (`openbrain-curator:8000`, `llama-cpp:8080`, `openbrain-db:5432`, `127.0.0.1`)
 * all came back 500 from the proxy while public URLs resolved normally - so the
 * Mullvad tunnel is ALREADY an SSRF boundary. But that is a property of the
 * network configuration, not a statement the code makes: `egress.ts` documents
 * `FETCH_PROXY_URL=""` as a supported opt-out to direct fetching, and on that
 * setting this container resolves `llm-net` and `app-net` names itself.
 *
 * So this is defence in depth, and it makes the property an assertion instead of
 * an accident. Deny-by-shape, not by list: anything that is not a public,
 * dotted, non-private host is refused.
 */
export function isPubliclyRoutableUrl(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  // A TRAILING DOT is the fully-qualified form of the SAME name, and it defeated
  // every check below (found in test 2026-09-09, round 4):
  // `http://openbrain-curator.:8000/` satisfied `host.includes(".")` and slipped
  // past the exact/suffix tests, and `http://localhost.:PORT/` was not merely
  // allowed - it CONNECTED to a live loopback listener. Normalise first, then
  // decide. Strip every trailing dot, not just one.
  host = host.replace(/\.+$/, "");
  if (!host) return false;
  // IPv6 literal. `new URL("http://[::1]/").hostname` KEEPS the brackets - an
  // earlier revision of this comment said it strips them, and the bracketed form
  // sailed through every check below until a test caught it. Strip them here.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) {
    // IPv4-MAPPED IPv6 (`::ffff:127.0.0.1`) carries a v4 address inside a v6
    // literal, and `::ffff:0:0/96` was absent from the deny set below.
    // TWO SPELLINGS, and the second is the one that matters: the WHATWG URL
    // parser NORMALISES `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a
    // dotted-form check alone never fires on a real URL. Measured 2026-09-09
    // after a first attempt matched only the dotted form and still leaked.
    // Re-check the embedded v4 address on its own terms rather than trying to
    // enumerate v6 spellings.
    const mappedDotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mappedDotted) return isPubliclyRoutableUrl("http://" + mappedDotted[1] + "/");
    const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPubliclyRoutableUrl("http://" + v4 + "/");
    }
    if (host === "::1" || host === "::") return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return false; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return false; // fe80::/10 link-local
    return true;
  }
  // IPv4 literal.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT - and the tailnet
    if (a >= 224) return false; // multicast / reserved
    return true;
  }
  // A DOCKER SERVICE NAME has no dot. `openbrain-curator`, `llama-cpp`,
  // `surrealdb` are all reachable from inside this stack and none of them can
  // appear in a legitimate newsletter link.
  if (!host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) return false;

  // ...BUT "has a dot" was not enough, and this is the miss that matters most
  // (found in test 2026-09-10). Docker's embedded DNS also answers
  // `<service>.<network>`, which HAS a dot:
  //     http://openbrain-curator.open-brain_obnet:8000/health  -> live 200
  //     http://llama-cpp.ai-stack_llm-net:8080/health          -> live 401
  // A tester reached the exact container `links.test.ts` asserts is refused, by
  // a spelling the screen accepted. Those network names are this stack's own and
  // are written down in CLAUDE.md.
  //
  // So require the RIGHTMOST label to look like a public TLD: ASCII letters, or
  // a punycode `xn--` label. Every docker network name here carries a hyphen or
  // an underscore and fails that, which closes the whole `<service>.<network>`
  // class rather than the two spellings that were demonstrated.
  //
  // KNOWN COST, stated rather than discovered later: a numeric-or-underscored
  // rightmost label on a genuinely public host would now be refused, and a
  // single-word alphabetic docker network (`mynet`) would still pass. This is a
  // shape heuristic on top of a network boundary, not a substitute for one - the
  // egress proxy remains the enforcement, and it 500s both of the URLs above.
  const rightmost = host.split(".").pop() ?? "";
  const looksLikeTld = /^[a-z]{2,63}$/.test(rightmost) || /^xn--[a-z0-9-]{1,59}$/.test(rightmost);
  if (!looksLikeTld) return false;
  return true;
}

/**
 * The escape hatch for TESTS ONLY, and it is deliberately ugly to type.
 *
 * `isPubliclyRoutableUrl` refuses loopback, which is exactly what a test stub
 * server is: `http://127.0.0.1:<port>`. Rather than weaken the policy so the
 * tests pass - the classic way a security control becomes decorative - the
 * policy stays pure and this opens a door at the CALL SITE.
 *
 * MUST NOT be set in production. `links.test.ts` sets it at import and the two
 * cases that assert the policy delete it first, so the shipping default is what
 * every other case runs against.
 */
function privateTargetsAllowed(): boolean {
  return (Deno.env.get("RESEARCH_ALLOW_PRIVATE_TARGETS") ?? "").trim() === "1";
}

/** The screen as the fetching code applies it: policy, plus the test hatch. */
function targetAllowed(url: string): boolean {
  if (privateTargetsAllowed()) return true;
  return isPubliclyRoutableUrl(url);
}

/**
 * The kill switch. `INTERSTITIAL_FOLLOW=0` restores the pre-2026-09-09
 * behaviour - follow `Location` headers only - with no code change and no
 * rebuild, so a bad day in production has a lever that is not a revert.
 *
 * Read per call rather than cached at import: a cached value cannot be changed
 * without a restart, and the whole point of a fallback is that it works when
 * you reach for it. The read is a hashtable lookup, and this runs at most a few
 * dozen times per daily run.
 */
function interstitialFollowEnabled(): boolean {
  const v = (Deno.env.get("INTERSTITIAL_FOLLOW") ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** A redirect shell is ~1–2KB. Bigger than this is not a shell, and the body is
 *  never buffered past it (see readHtmlPrefix). */
const INTERSTITIAL_MAX_BYTES = 16_384;
/** Visible text in a shell is a stray "Redirecting…" at most. An article has more. */
const INTERSTITIAL_MAX_TEXT = 200;

/**
 * Remove the regions a browser will never execute or treat as markup, so the
 * matchers below cannot be steered by something inert.
 *
 * WHY (found in test 2026-09-09, second round): narrowing the SCRIPTED matcher to
 * <script> elements was not enough, because `metaRefreshTarget` runs FIRST and
 * had never been narrowed at all. Seven inert contexts still drove the resolver -
 * a <meta refresh> or a <script> inside an HTML comment, inside <template>, or
 * inside <textarea>, and a <script> with a non-executing `type`.
 *
 * Comments were the sharp one: the visible-text guard calls extractTextFromHtml,
 * which STRIPS comments before counting - so a document that is almost entirely
 * one commented-out block reads as "no visible text" (shell-like) to the guard
 * while the matcher happily reads inside the comment. The guard and the matcher
 * disagreed about what the document contained. They now see the same thing.
 */
/**
 * A single left-to-right scan of the document, replacing the layered regex this
 * used to be. It returns the `<meta>` tags and `<script>` bodies that are
 * genuinely LIVE, plus one `ambiguous` flag - and the flag is the point.
 *
 * WHY IT IS A SCANNER NOW (found in test 2026-09-09, third round). The regex
 * version stripped inert regions with closing-tag-anchored, non-greedy patterns,
 * so a tester drove the resolver from TWELVE contexts a browser would never
 * navigate from: every UNTERMINATED inert region (`<!--` with no `-->`, an
 * unclosed `<textarea>`, an unclosed `<template>`), NESTED templates, regions it
 * had never heard of (`<style>`, `<title>`, `<noscript>`), an `iframe srcdoc`,
 * and a whole `<script>` living inside an attribute VALUE. Patching twelve
 * shapes invites a thirteenth; the shape of the tool was the defect.
 *
 * AND IT FAILS CLOSED. When the document contains something this scan cannot
 * confidently place - an unterminated raw-text element, or a nested template -
 * it reports `ambiguous` and the caller refuses to treat it as a redirect at
 * all. That direction is deliberate: refusing costs one unresolved wrapper,
 * which is logged and STILL researched, while guessing costs a wrong URL
 * silently entering the research corpus.
 */
interface DocScan {
  metaTags: string[];
  scripts: Array<{ tag: string; body: string }>;
  /** Text the scan considers LIVE - what the shell guard must measure. */
  liveText: string;
  ambiguous: boolean;
}

// Elements whose content is NOT ordinary markup. Anything inside them can never
// be a live <meta>, and (except for script itself) can never be live JS either.
const RAW_TEXT_ELEMENTS = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"];

/** `<plaintext>` is TERMINAL: the tokenizer never leaves that state, so nothing
 *  after it is markup, ever. The regex version handled this and the scanner that
 *  replaced it dropped it - a regression found in test 2026-09-09, round 4. */
const TERMINAL_ELEMENTS = ["plaintext"];

/** Foreign content and content models where a `<meta>` is not a document-level
 *  meta and a `<script>` does not run as one: `<math>` is not on the HTML
 *  breakout list, and `<select>` only admits option/optgroup. Both were used to
 *  steer the resolver. Their whole subtree is skipped. */
const INERT_SUBTREE_ELEMENTS = ["math", "select", "svg"];

function scanDocument(html: string): DocScan {
  const out: DocScan = { metaTags: [], scripts: [], liveText: "", ambiguous: false };
  const s = String(html || "");
  let i = 0;
  let noscriptDepth = 0;
  // Text found in the regions the scan calls LIVE, accumulated as it goes.
  // THE POINT (found in test 2026-09-09, round 4): the shell guard used to call
  // extractTextFromHtml on the RAW document, which erases <svg>, <nav>,
  // <header>, <footer>, <aside> and <form> before counting - so a <nav>-wrapped
  // meta refresh read as "no visible text" to the guard and as a live redirect
  // to the matcher. That is the same guard/matcher disagreement this scanner was
  // written to end for comments, still open for six more elements. Measuring the
  // text HERE, from the same walk that decides what is live, makes the two
  // incapable of disagreeing rather than merely agreeing today.
  const liveChunks: string[] = [];
  const pushText = (from: number, to: number) => {
    if (to > from) liveChunks.push(s.slice(from, to));
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { pushText(i, s.length); break; }
    pushText(i, lt);

    // Comment. An unterminated one means the rest of the document is inert to a
    // browser but was fully visible to the old regex - the sharpest bypass.
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) { out.ambiguous = true; return out; }
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", lt)) { // doctype and friends
      const end = s.indexOf(">", lt);
      if (end < 0) { out.ambiguous = true; return out; }
      i = end + 1;
      continue;
    }

    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(lt, lt + 40));
    if (!nameMatch) {
      // A BOGUS COMMENT (found in test 2026-09-09, round 4). `<?foo`, `</3`,
      // `<%` and friends put the tokenizer in the bogus-comment state, which
      // runs to the NEXT `>` and is not markup. Skipping only this `<` walked
      // straight INTO it, so `<?foo <meta http-equiv=refresh ...> ?>` had its
      // meta read as live - the `>` that ends the bogus comment is the meta's
      // own. Consume to the first `>`, exactly as a browser does.
      const bogusEnd = s.indexOf(">", lt);
      if (bogusEnd < 0) { out.ambiguous = true; return out; }
      i = bogusEnd + 1;
      continue;
    }
    const isClose = s[lt + 1] === "/";
    const name = nameMatch[1].toLowerCase();

    // Find the end of THIS tag, honouring quoted attribute values so that a
    // `<div title="--><script>...">` cannot smuggle markup out of an attribute.
    let j = lt + 1 + (isClose ? 1 : 0) + name.length;
    let quote = "";
    let tagEnd = -1;
    while (j < s.length) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        tagEnd = j;
        break;
      }
      j++;
    }
    if (tagEnd < 0) { out.ambiguous = true; return out; }
    const tagText = s.slice(lt, tagEnd + 1);

    if (isClose) {
      if (name === "noscript" && noscriptDepth > 0) noscriptDepth--;
      i = tagEnd + 1;
      continue;
    }

    if (TERMINAL_ELEMENTS.includes(name)) {
      // Nothing AFTER this is markup - but it is all TEXT, and a browser renders
      // it. Counting it is what stops `<plaintext>` erasing the shell guard:
      // appending it to a full article made that article resolve, because the
      // early return skipped the liveText assignment entirely (found in test
      // 2026-09-10, and it falsified this commit's own claim that the guard and
      // the matcher were "incapable of disagreeing").
      pushText(tagEnd + 1, s.length);
      break;
    }

    // A subtree that cannot hold a live meta or an executing script - but whose
    // TEXT a browser still renders. Skip it for matching, KEEP it for the guard:
    // `<select>` options, `<svg><text>`, `<math><mtext>` are all visible, and
    // dropping them let an article's prose be hidden from the guard while the
    // document stayed a "shell". Counted like <template> so nesting cannot walk
    // out of it.
    if (INERT_SUBTREE_ELEMENTS.includes(name)) {
      let depth = 1;
      let k = tagEnd + 1;
      const subRe = new RegExp("<(/?)" + name + "\\b", "gi");
      subRe.lastIndex = k;
      let sm: RegExpExecArray | null;
      while ((sm = subRe.exec(s))) {
        depth += sm[1] ? -1 : 1;
        k = sm.index + sm[0].length;
        if (depth === 0) break;
      }
      if (depth !== 0) { out.ambiguous = true; return out; }
      const subClose = s.indexOf(">", k);
      const subEnd = subClose < 0 ? s.length : subClose + 1;
      // Its text counts; its tags do not.
      liveChunks.push(s.slice(tagEnd + 1, subEnd).replace(/<[^>]*>/g, " "));
      i = subEnd;
      continue;
    }

    // <template> content is inert. Nesting defeats a non-greedy match, so count.
    if (name === "template") {
      let depth = 1;
      let k = tagEnd + 1;
      const tagRe = /<(\/?)template\b/gi;
      tagRe.lastIndex = k;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(s))) {
        depth += m[1] ? -1 : 1;
        k = m.index + m[0].length;
        if (depth === 0) break;
      }
      if (depth !== 0) { out.ambiguous = true; return out; }
      const close = s.indexOf(">", k);
      i = close < 0 ? s.length : close + 1;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.includes(name)) {
      const closeRe = new RegExp("</" + name + "\\b", "i");
      const rest = s.slice(tagEnd + 1);
      const rel = rest.search(closeRe);
      if (rel < 0) { out.ambiguous = true; return out; }
      const body = rest.slice(0, rel);
      // A <script> inside <noscript> is NOT executed by a scripting browser.
      if (name === "script" && noscriptDepth === 0) out.scripts.push({ tag: tagText, body });
      // <textarea> and <title> content is RENDERED, so it counts toward the
      // shell guard even though it can never be markup. <script>/<style> are
      // not rendered and must not count. <iframe> fallback content is only
      // shown when the frame fails, but a document that is mostly iframe text
      // is not a redirect shell either - count it, which also closes the fourth
      // way a tester erased the guard (found in test 2026-09-10).
      if (name === "textarea" || name === "title" || name === "iframe" || name === "xmp") {
        liveChunks.push(body.replace(/<[^>]*>/g, " "));
      }
      i = tagEnd + 1 + rel;
      continue;
    }

    // <noscript> is TRANSPARENT for <meta>, not inert: a no-JS client honours a
    // refresh inside it, and that is exactly where the real Substack
    // interstitial puts its own. Its scripts, however, never run.
    if (name === "noscript") { noscriptDepth++; i = tagEnd + 1; continue; }

    if (name === "meta") out.metaTags.push(tagText);
    i = tagEnd + 1;
  }
  out.liveText = decodeEntities(liveChunks.join(" ")).replace(/\s+/g, " ").trim();
  return out;
}

/** `<meta http-equiv="refresh" content="0; url=…">` — the target, if the delay
 *  is an immediate 0. A timed refresh (`content="5;…"`) is a page that means to
 *  be READ first, so it is not a redirect. */
function metaRefreshTarget(metaTags: string[]): string | null {
  for (const tag of metaTags) {
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

/**
 * `location.replace("…")` / `location.assign("…")` / `location.href = "…"`, but
 * ONLY inside a <script> element.
 *
 * The script-only restriction is not tidiness (found in test 2026-09-09): run
 * over raw HTML, the pattern matched `<div data-location = "eu-west">` — a plain
 * attribute, no script anywhere — because `\b` sits happily after the hyphen in
 * `data-location`. It also matched `window.analytics.location = "…"`, an
 * unrelated property assignment, and would have steered the researcher to
 * whatever URL that held. Narrow the haystack to actual script bodies, and
 * require the reference to be a real global (`location`, `window.location`,
 * `document.location`) rather than the tail of some longer identifier.
 */
// The reference must be a real global, not the tail of a longer identifier. A
// NEGATIVE LOOKBEHIND says that once, instead of enumerating the characters that
// may precede it: `data-location` (hyphen), `analytics.location` (dot) and
// `mylocation` (word char) are all excluded, while `)` and `>` are allowed.
//
// Those two matter (found in test 2026-09-09, second round): the previous
// version listed allowed prefixes as `[;{}\s(]`, which silently stopped
// following `setTimeout(()=>location.replace("..."),0)` and
// `if(!a)location.href="..."` - both shapes attempt 1 DID follow, and both are
// what a minified interstitial actually looks like. Narrowing to kill a false
// positive had quietly introduced false negatives in the common case.
const LOCATION_ASSIGN_RE =
  /(?<![\w$.\-])(?:(?:window|document|self|top)\s*\.\s*)?location\s*(?:\.\s*(?:replace|assign)\s*\(\s*|\.\s*href\s*=\s*|\s*=\s*)["']([^"']+)["']/i;

/** A <script> the browser actually runs: no `type`, or a JavaScript one. A
 *  `type="text/template"` / `"text/plain"` block is inert data. */
function isExecutableScriptTag(tag: string): boolean {
  const t = tag.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
  if (!t) return true;
  return /^(module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|text\/jscript)$/.test(t);
}

function scriptedLocationTarget(scripts: Array<{ tag: string; body: string }>): string | null {
  for (const sc of scripts) {
    if (!isExecutableScriptTag(sc.tag)) continue;
    const hit = sc.body.match(LOCATION_ASSIGN_RE);
    if (hit?.[1]) return hit[1];
  }
  return null;
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
  // One scan, and the guard and BOTH matchers read what IT says is live. The
  // guard used to call extractTextFromHtml on the raw document, which erases a
  // different set of elements than the scan does - so the two could disagree
  // about what the document contained, and did, for six of them.
  const scan = scanDocument(html);
  if (scan.liveText.length > INTERSTITIAL_MAX_TEXT) return null;
  // Fail closed. If the document contains something the scan cannot place, we do
  // not guess: refusing costs one wrapper that is logged and still researched,
  // guessing costs a wrong URL entering the corpus silently.
  if (scan.ambiguous) return null;
  const raw = metaRefreshTarget(scan.metaTags) ?? scriptedLocationTarget(scan.scripts);
  if (!raw) return null;
  let abs: string;
  try {
    abs = new URL(decodeEntities(raw).trim(), baseUrl).toString();
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(abs)) return null;
  // The target is about to be FETCHED. Screen it here, at the point it is
  // derived from attacker-influenced content - see isPubliclyRoutableUrl.
  if (!targetAllowed(abs)) return null;
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
        let next: string;
        try {
          next = new URL(loc, current).toString();
        } catch {
          return current;
        }
        // Screen the HEADER hop too. This path is older than the interstitial
        // one and had the same unscreened power all along: a `Location:
        // http://openbrain-db:5432/` was followed without question. Stopping
        // here means we return the wrapper, which is then logged as unresolved
        // and still researched - the safe direction.
        if (!targetAllowed(next)) return current;
        current = next;
        continue;
      }
      // Not a 3xx. The browser/Deno may have already resolved to res.url on a
      // final hop. Before calling it arrived, check whether this 200 is really
      // a redirect shell (meta-refresh / location.replace) and take that hop.
      const landed = res.url && res.url !== "" ? res.url : current;
      // THE FALLBACK LEVER (operator, 2026-09-09). INTERSTITIAL_FOLLOW=0 turns
      // this whole path off and restores the pre-2026-09-09 behaviour - 3xx
      // only - without a code change, a rebuild or a redeploy. Set it in the
      // gitignored OB1/recipes/daily-digest/.env and recreate the container.
      // The cost of pulling it is precisely the outage this item fixed: every
      // Substack wrapper goes back to being logged as unresolved and researched
      // from the newsletter body. It is not free, and it is not a disaster.
      if (!interstitialFollowEnabled()) return landed;
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
 * Should the research stage fetch this candidate?
 *
 * THE ONE PLACE that decision is made, exported so a test can pin the REAL
 * expression. It lived inline in link-enrich.ts until 2026-09-09, where nothing
 * could reach it: link-enrich.ts is a top-level script that runs work at import,
 * so no test may import it, and the test that claimed to guard the rule asserted
 * a hand-typed COPY of the filter. A tester put the regression back into the
 * real filter and the whole suite stayed green.
 *
 * `unresolvedWrapper` is DELIBERATELY not consulted. Marking a wrapper we could
 * not resolve is right; refusing to research it is not - `isRedirectWrapper`
 * matches bare substrings against the whole URL, so a genuine article can carry
 * the mark, and a tracker whose unwrap merely timed out used to survive here and
 * be followed by extract.ts at fetch time. Keeping it restores that exactly; the
 * log line is what ends the silence.
 */
export function isResearchable(c: LinkCandidate): boolean {
  if (!c.domain) return false;
  // The newsletter's own posts: the email body already covers them and the web
  // posts are often paywalled.
  if (c.domain.endsWith("substack.com")) return false;
  return true;
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
