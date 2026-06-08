/**
 * Reconstruct a newsletter's full body from its stored chunks.
 *
 * The gmail pull splits each email into embed-safe chunks, one `thoughts` row
 * each, sharing `gmail_id` and carrying `chunk_index`/`chunk_count`
 * (OB1/recipes/email-history-import/pull-gmail.ts). AiNewsSection only keeps
 * chunk-0's snippet, but newsletter links can sit in any chunk — so the link
 * stage must reassemble the whole body in `chunk_index` order.
 *
 * ⚠️ Link recovery is best-effort. The pull prefers the email's text/plain part
 * and, when only HTML exists, `htmlToText` strips tags **including href** — so
 * HTML-only newsletters lose their anchor links here. Plain-text-bearing
 * newsletters (beehiiv/Substack multipart/alternative) keep bare inline URLs.
 * The runner logs zero-link emails so a run measures how big that gap is; the
 * complete fix (re-fetch raw Gmail HTML) is a later enhancement.
 */

import { BrainClient } from "../clients/postgrest.ts";

/** Strip the `[Email from … | Subject: … | Date: …]` header the pull prepends. */
function stripEmailHeader(content: string): string {
  return content.replace(/^\[Email from[^\]]*\]\s*/, "");
}

/**
 * Fetch every chunk for one gmail_id and concatenate in chunk order. Returns
 * the full reconstructed body (header prefix stripped). Empty string when the
 * email has no stored chunks.
 */
export async function reconstructEmailBody(
  brain: BrainClient,
  gmailId: string,
): Promise<string> {
  const chunks = await brain.fetchThoughtsByGmailId(gmailId);
  if (chunks.length === 0) return "";

  chunks.sort(
    (a, b) => Number(a.metadata?.chunk_index ?? 0) - Number(b.metadata?.chunk_index ?? 0),
  );

  return chunks
    .map((c, i) => (i === 0 ? stripEmailHeader(c.content) : c.content))
    .join("\n")
    .trim();
}
