/**
 * GmailClient — wraps the Gmail send endpoint. Single responsibility:
 * given (from, to, subject, html), put an HTML message in the user's
 * inbox via gmail.send scope. Knows nothing about digests or content.
 */

import { GoogleOAuth } from "./google-oauth.ts";

export interface GmailClientOptions {
  oauth: GoogleOAuth;
}

export interface SendArgs {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
}

export class GmailClient {
  constructor(private readonly opts: GmailClientOptions) {}

  async sendHtml(args: SendArgs): Promise<void> {
    const accessToken = await this.opts.oauth.getAccessToken();
    const raw = this.buildRawMessage(args);

    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: base64UrlEncode(raw) }),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Gmail send failed: ${res.status} ${err}`);
    }
  }

  private buildRawMessage({ from, to, subject, htmlBody }: SendArgs): string {
    // RFC 2822 with UTF-8 subject via encoded-word + 8bit HTML body.
    const encodedSubject = `=?UTF-8?B?${
      base64UrlEncode(subject).replace(/-/g, "+").replace(/_/g, "/")
    }?=`;
    return [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      "",
      htmlBody,
    ].join("\r\n");
  }
}

function base64UrlEncode(text: string): string {
  const utf8 = unescape(encodeURIComponent(text));
  return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
