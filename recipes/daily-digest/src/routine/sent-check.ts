/**
 * "Did it go out?" - resolved by READING Gmail's Sent folder (round 3).
 *
 * Every digest / follow-up carries a header `X-OpenBrain-Digest: <date>;<kind>`
 * (GmailClient, SendArgs.marker). When a send outcome is UNKNOWN (the request
 * may have reached Gmail, no answer came), the routine lists the most recent
 * SENT messages and reads only that header (format=metadata). Found -> sent,
 * a fact. Not found -> not sent, a fact (safe to send). Check unavailable ->
 * the outcome stays unknown: no resend, the alert says so.
 *
 * Read-only, and it needs a token with `gmail.metadata` (or `gmail.readonly`).
 * The deployed digest token was minted with `gmail.send` only (setup-token.ts),
 * which cannot list messages: the check is OFF until the operator re-consents
 * (`setup-token.ts --with-sent-check`) and sets SENT_CHECK_TOKEN_PATH. Until then
 * "unknown" stays unknown (conservative: no resend, one alert).
 *
 * gmail.metadata does not allow the `q` search parameter, so the check pages
 * the SENT label (labelIds=SENT) instead of searching.
 */

import { GoogleOAuth } from "../clients/google-oauth.ts";

export type SentCheckResult = "found" | "not-found" | "unavailable";

export interface SentChecker {
  readonly enabled: boolean;
  check(date: string, kind: "digest" | "followup"): Promise<{ result: SentCheckResult; note: string }>;
}

export const MARKER_HEADER = "X-OpenBrain-Digest";
export const markerFor = (date: string, kind: "digest" | "followup") => `${date};${kind}`;

export const sentCheckDisabled: SentChecker = {
  enabled: false,
  check: () =>
    Promise.resolve({
      result: "unavailable",
      note: "Sent-folder check not enabled (digest token has gmail.send only; re-consent with --with-sent-check)",
    }),
};

export class GmailSentChecker implements SentChecker {
  readonly enabled = true;
  constructor(
    private readonly o: {
      oauth: GoogleOAuth;
      apiBase?: string; // tests: a local stub
      fetchFn?: typeof fetch;
      scanLimit?: number; // most recent SENT messages to look at (default 50)
      timeoutMs?: number;
    },
  ) {}

  async check(date: string, kind: "digest" | "followup"): Promise<{ result: SentCheckResult; note: string }> {
    const f = this.o.fetchFn ?? fetch;
    const base = `${(this.o.apiBase ?? "https://gmail.googleapis.com").replace(/\/$/, "")}/gmail/v1/users/me/messages`;
    const want = markerFor(date, kind);
    const t = this.o.timeoutMs ?? 20_000;
    try {
      const token = await this.o.oauth.getAccessToken();
      const h = { Authorization: `Bearer ${token}` };
      const lr = await f(`${base}?labelIds=SENT&maxResults=${this.o.scanLimit ?? 50}`, { headers: h, signal: AbortSignal.timeout(t) });
      if (!lr.ok) {
        await lr.body?.cancel();
        return { result: "unavailable", note: `Sent-folder list answered ${lr.status}${lr.status === 403 ? " (token lacks a read scope)" : ""}` };
      }
      const list = await lr.json() as { messages?: Array<{ id: string }> };
      for (const m of list.messages ?? []) {
        const gr = await f(`${base}/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=${MARKER_HEADER}`, {
          headers: h,
          signal: AbortSignal.timeout(t),
        });
        if (!gr.ok) {
          await gr.body?.cancel();
          return { result: "unavailable", note: `Sent-folder read answered ${gr.status}` };
        }
        const msg = await gr.json() as { payload?: { headers?: Array<{ name: string; value: string }> } };
        const v = msg.payload?.headers?.find((x) => x.name.toLowerCase() === MARKER_HEADER.toLowerCase())?.value;
        if (v === want) return { result: "found", note: `found in Sent (${want})` };
      }
      return { result: "not-found", note: `not in the latest ${list.messages?.length ?? 0} Sent messages` };
    } catch (e) {
      return { result: "unavailable", note: `Sent-folder check failed (${(e as Error)?.name ?? "error"})` };
    }
  }
}
