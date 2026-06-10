/**
 * Raw-Gmail reader — fetch a newsletter's ORIGINAL HTML so every link survives.
 *
 * The pull stores email bodies with `htmlToText` (hrefs stripped), so the brain
 * keeps only the bare text/plain URLs — typically just the post permalink. The
 * genuinely interesting links (news items, tools, papers) are HTML anchors that
 * never make it into storage. To find them we re-fetch the raw message from
 * Gmail (readonly) and parse the HTML part's anchors directly.
 *
 * Reuses the GoogleOAuth helper pointed at the open-brain-email readonly token.
 */

import { GoogleOAuth } from "../clients/google-oauth.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/** Walk the MIME tree, preferring text/html; fall back to text/plain. */
function extractHtmlPart(part: GmailPart | undefined): string {
  if (!part) return "";
  let html = "";
  let plain = "";
  const walk = (p: GmailPart) => {
    if (p.mimeType === "text/html" && p.body?.data) html += decodeBase64Url(p.body.data);
    else if (p.mimeType === "text/plain" && p.body?.data) plain += decodeBase64Url(p.body.data);
    for (const sub of p.parts ?? []) walk(sub);
  };
  walk(part);
  return html || plain;
}

export class GmailReader {
  constructor(private readonly oauth: GoogleOAuth) {}

  /** Raw HTML body of a message (by gmail id). Throws on API failure. */
  async fetchHtml(gmailId: string): Promise<string> {
    const token = await this.oauth.getAccessToken();
    const res = await fetch(`${GMAIL_API}/messages/${gmailId}?format=full`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`gmail get ${gmailId}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    const msg = await res.json() as { payload?: GmailPart };
    return extractHtmlPart(msg.payload);
  }
}

/** Extract <a href> anchors (url + visible text) from raw HTML. */
export function extractAnchors(html: string): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    out.push({ url, text });
  }
  return out;
}
