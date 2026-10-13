/**
 * GmailClient — wraps the Gmail send endpoint. Single responsibility:
 * given (from, to, subject, html), put an HTML message in the user's
 * inbox via gmail.send scope. Knows nothing about digests or content.
 */

import { GoogleOAuth } from "./google-oauth.ts";

export interface GmailClientOptions {
  oauth: GoogleOAuth;
  /** Tests only: a local stub Gmail API. Production leaves it unset. */
  apiBase?: string;
  fetchFn?: typeof fetch;
}

export interface SendArgs {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
}

/** What the digest needs from a mail transport (tests inject a recorder). */
export interface MailTransport {
  sendHtml(args: SendArgs): Promise<void>;
}

/**
 * A failed send, classified for the send-once marker (mr-routine-outage):
 * `definite` = the message certainly did NOT go out (no token, or Gmail
 * answered non-2xx) so a retry cannot duplicate it; otherwise the request may
 * have reached Gmail (network error / timeout mid-request) and the caller must
 * NOT retry blindly.
 */
export class MailSendError extends Error {
  constructor(message: string, readonly definite: boolean, readonly status = 0) {
    super(message);
    this.name = "MailSendError";
  }
}

export class GmailClient implements MailTransport {
  constructor(private readonly opts: GmailClientOptions) {}

  async sendHtml(args: SendArgs): Promise<void> {
    let accessToken: string;
    try {
      accessToken = await this.opts.oauth.getAccessToken();
    } catch (e) {
      throw new MailSendError(`Gmail send failed: no access token (${(e as Error).message})`, true);
    }
    const raw = this.buildRawMessage(args);

    let res: Response;
    try {
      res = await (this.opts.fetchFn ?? fetch)(
        `${(this.opts.apiBase ?? "https://gmail.googleapis.com").replace(/\/$/, "")}/gmail/v1/users/me/messages/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: base64UrlEncode(raw) }),
          signal: AbortSignal.timeout(120_000),
        },
      );
    } catch (e) {
      throw new MailSendError(`Gmail send: no answer (${(e as Error).name}) - may or may not have been sent`, false);
    }

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new MailSendError(`Gmail send failed: ${res.status} ${err}`, true, res.status);
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
