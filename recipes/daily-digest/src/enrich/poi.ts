/**
 * POI discovery — choose which of a newsletter's links are worth researching.
 *
 * The point of interest is the genuinely interesting CONTENT: news, AI tools,
 * research/papers, substantive analysis. NOT marketing, ads, promotions,
 * "upgrade to Pro", sponsorships, or navigation. An LLM judges by the anchor
 * text + domain (the anchor text is usually the headline / tool name).
 */

export type PoiChat = (system: string, user: string) => Promise<string | null>;

const POI_SYS =
  `You curate the links in a newsletter to decide which are worth researching for a podcast + digest.

KEEP links to substantive CONTENT (news, tools, and research are ALL interesting):
- news articles / reporting (e.g. a "continue reading" link to a real article)
- AI tools & products being FEATURED or reviewed — a "Trending AI Tools" item: a short
  tool/product name (Skiddee, Papera, clariBI, …) linking to the tool's own site IS content.
  KEEP it. A featured tool is NOT an ad.
- research papers, technical analyses, deep explainers

DROP ONLY links that are not content:
- explicit advertisements / sponsorships ("sponsored by", "ad", affiliate codes)
- the NEWSLETTER'S OWN marketing: "upgrade to Pro", "subscribe", "become a paid member", "our
  course", "book a call", surveys / feedback forms, merch, discounts, referral / invite
- navigation, social share, "view in browser", unsubscribe, manage preferences, profile / settings

Return ONLY JSON: {"keep":[indices]} — 0-based indices into the LINKS list, for the links to KEEP.
Keep news, featured tools, AND research; drop only explicit ads, the newsletter's own marketing,
surveys, and navigation. When unsure whether a tool/article link is content vs an ad, KEEP it.`;

function parseKeep(raw: string, n: number): number[] {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : raw) as { keep?: unknown };
    const arr = Array.isArray(j.keep) ? j.keep : [];
    const keep = arr.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < n);
    return [...new Set<number>(keep)];
  } catch {
    return [];
  }
}

/**
 * Select the POI links. Returns indices into `candidates` to KEEP (≤ maxN).
 * On 0/1 candidates or LLM failure, degrades sensibly (keep all / first N).
 */
export async function selectPOI(
  chat: PoiChat,
  newsletter: string,
  candidates: Array<{ url: string; text?: string; domain: string }>,
  maxN: number,
): Promise<number[]> {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [0];
  const list = candidates
    .map((c, i) => `${i}. [${c.domain}] ${c.text || "(no anchor text)"} — ${c.url.slice(0, 120)}`)
    .join("\n");
  const raw = await chat(POI_SYS, `NEWSLETTER: ${newsletter}\n\nLINKS:\n${list}`);
  if (!raw) return candidates.slice(0, maxN).map((_, i) => i); // LLM down → first N
  const keep = parseKeep(raw, candidates.length);
  return (keep.length ? keep : candidates.map((_, i) => i)).slice(0, maxN);
}
