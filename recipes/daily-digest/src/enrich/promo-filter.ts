/**
 * promo-filter.ts — keep advertisements out of the brain.
 *
 * Operator rule: ads are poison. No promo/marketing in any source, claim, or
 * podcast. And a newsletter BODY is never a source — the linked ARTICLE is; toss
 * the body, and if it's mostly ad, drop it (salvaging any legit link first).
 *
 * Layers:
 *   1. BLOCKLIST — a persisted JSON of promo domains. Promos reuse the same
 *      links, so a domain we've already judged promo is dropped INSTANTLY, no LLM
 *      call. The classifier grows this list (self-optimizing).
 *   2. LINK classifier (`isPromo`, nothink, fast) — every external candidate:
 *      "PROMO or CONTENT?" PROMO → drop + remember its domain. A featured tool
 *      linking to its own site is CONTENT, not an ad.
 *   3. BODY classifier (`isPromoBody`, THINK model, conservative) — the
 *      body-fallback decision, where dropping a legit single-post essay is a real
 *      cost. DROPs only a PRIMARILY-promotional body; KEEPs anything substantive
 *      (defaults to KEEP on any doubt). Samples a large, cleaned excerpt.
 */

export type ClassifyChat = (system: string, user: string) => Promise<string | null>;

const CLASSIFY_SYS =
  `You are an advertisement filter for a research pipeline. Classify the item as PROMO or CONTENT.

PROMO = advertising, marketing, or sales material:
- subscription / membership pitches ("upgrade to Pro", "X% off", "paid members", "every plan", "join now")
- sponsorships ("sponsored by", "presented by", "brought to you by"), affiliate or discount codes
- the newsletter selling ITS OWN course / membership / merch / event / "book a call"
- urgency hooks ("limited time", "expires today"), surveys, referrals, "share this post"

CONTENT = substantive material worth researching:
- news / reporting, AI tools or products being featured or reviewed (a featured tool linking to
  its own site IS content), research papers, technical analysis, explainers

Answer with ONLY one word: PROMO or CONTENT.`;

const BODY_SYS =
  `You decide whether to KEEP or DROP a newsletter email body as a research source. Be CONSERVATIVE — when unsure, KEEP.

DROP only if the email is PRIMARILY an advertisement: its main purpose is selling a subscription, membership, product, course, or event, with little or no substantive content. Examples: "our members' favorite tutorials, 20% off every plan", a pure sponsor blast, an "upgrade to PRO" push.

KEEP if the body contains substantive NEWS, RESEARCH, ANALYSIS, or REPORTING — EVEN IF it also carries some promotional lines, a sponsor blurb, or "subscribe" CTAs. A news roundup or an essay with an embedded ad is still CONTENT (the ad is filtered later; the reporting is worth keeping). A real story behind a headline (e.g. an Anthropic research result) is CONTENT.

Reason briefly if you like, then end your reply with EXACTLY one line:
VERDICT: KEEP
or
VERDICT: DROP`;

export interface Blocklist {
  domains: Set<string>;
  /** Manually-curated full-URL prefixes (operator-editable). */
  urlPrefixes: string[];
}

export async function loadBlocklist(path: string): Promise<Blocklist> {
  try {
    const j = JSON.parse(await Deno.readTextFile(path)) as { domains?: string[]; urlPrefixes?: string[] };
    return { domains: new Set((j.domains ?? []).map((d) => d.toLowerCase())), urlPrefixes: j.urlPrefixes ?? [] };
  } catch {
    return { domains: new Set(), urlPrefixes: [] };
  }
}

export async function saveBlocklist(path: string, bl: Blocklist): Promise<void> {
  try {
    const body = JSON.stringify(
      { domains: [...bl.domains].sort(), urlPrefixes: [...bl.urlPrefixes].sort() },
      null,
      2,
    );
    await Deno.writeTextFile(path, body);
  } catch (err) {
    console.warn(`[promo-filter] blocklist save failed (non-fatal): ${err}`);
  }
}

export function isBlocked(bl: Blocklist, domain: string | undefined, url: string): boolean {
  if (domain && bl.domains.has(domain.toLowerCase())) return true;
  return bl.urlPrefixes.some((p) => url.startsWith(p));
}

/**
 * One nothink classify for a LINK. Returns true = PROMO. `defaultIfUnknown` is
 * the verdict when the model is down or ambiguous (links pass `false` — keep, POI
 * is a backstop).
 */
export async function isPromo(
  chat: ClassifyChat,
  item: { title?: string; text?: string; domain?: string; content?: string },
  defaultIfUnknown = false,
): Promise<boolean> {
  const desc = [
    item.domain ? `Domain: ${item.domain}` : "",
    item.title ? `Title: ${item.title}` : "",
    item.text ? `Link text: ${item.text}` : "",
    item.content ? `Excerpt: ${item.content.replace(/\s+/g, " ").trim().slice(0, 600)}` : "",
  ].filter(Boolean).join("\n");
  if (!desc.trim()) return defaultIfUnknown;
  let raw: string | null;
  try {
    raw = await chat(CLASSIFY_SYS, desc);
  } catch {
    return defaultIfUnknown;
  }
  if (!raw) return defaultIfUnknown;
  const v = raw.toUpperCase();
  const promo = v.includes("PROMO");
  const content = v.includes("CONTENT");
  if (promo === content) return defaultIfUnknown; // both or neither → ambiguous
  return promo;
}

/** Strip email zero-width / format chars (soft hyphen, combining grapheme
 *  joiner, zero-width spaces/joiners, bidi marks) and collapse whitespace, so the
 *  classifier sees real text not invisible spacer junk. Uses code points (no
 *  literal invisible chars in source). `\s` already covers nbsp/BOM/separators. */
const ZERO_WIDTH = new Set([0x00ad, 0x034f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);
function cleanText(s: string): string {
  let out = "";
  for (const ch of String(s || "")) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !ZERO_WIDTH.has(cp)) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Conservative body classifier — for the body-fallback decision, where dropping
 * a legit single-post essay is a real cost. DROPs only a PRIMARILY-promotional
 * body; KEEPs anything with substantive content (the default on any doubt).
 * Pass a THINK-model chat (no :nothink) for precision; samples a large, cleaned
 * excerpt rather than just the promo-heavy intro.
 */
export async function isPromoBody(
  chat: ClassifyChat,
  title: string,
  body: string,
  sampleChars = 3000,
): Promise<boolean> {
  const sample = cleanText(body).slice(0, sampleChars);
  if (sample.length < 40) return false; // too little to judge → keep
  let raw: string | null;
  try {
    raw = await chat(BODY_SYS, `SUBJECT: ${title || "(none)"}\n\nBODY:\n${sample}`);
  } catch {
    return false; // conservative: keep on model failure
  }
  if (!raw) return false;
  const m = [...raw.matchAll(/VERDICT:\s*(KEEP|DROP)/gi)];
  if (m.length) return m[m.length - 1][1].toUpperCase() === "DROP";
  const v = raw.toUpperCase(); // no structured line → only drop if unambiguous
  if (v.includes("DROP") && !v.includes("KEEP")) return true;
  return false; // default KEEP
}

export interface DroppedCandidate {
  url: string;
  domain?: string;
  text?: string;
  reason: "blocklist" | "classified";
}

/**
 * Filter a newsletter's external candidates: blocklist (free) then nothink
 * classify (the rest), at bounded concurrency. PROMO domains are added to the
 * blocklist in-place. Returns the content links to keep + what was dropped.
 */
export async function filterCandidates<T extends { url: string; text?: string; domain?: string }>(
  chat: ClassifyChat,
  bl: Blocklist,
  candidates: T[],
  concurrency = 4,
): Promise<{ kept: T[]; dropped: DroppedCandidate[] }> {
  const kept: T[] = [];
  const dropped: DroppedCandidate[] = [];
  const toClassify: T[] = [];
  for (const c of candidates) {
    if (isBlocked(bl, c.domain, c.url)) dropped.push({ url: c.url, domain: c.domain, text: c.text, reason: "blocklist" });
    else toClassify.push(c);
  }
  const verdict = new Array<boolean>(toClassify.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), toClassify.length) || 1 }, async () => {
      while (i < toClassify.length) {
        const idx = i++;
        verdict[idx] = await isPromo(chat, { domain: toClassify[idx].domain, text: toClassify[idx].text });
      }
    }),
  );
  toClassify.forEach((c, idx) => {
    if (verdict[idx]) {
      if (c.domain) bl.domains.add(c.domain.toLowerCase());
      dropped.push({ url: c.url, domain: c.domain, text: c.text, reason: "classified" });
    } else {
      kept.push(c);
    }
  });
  return { kept, dropped };
}
