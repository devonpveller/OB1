/**
 * Telegram alert for the morning routine (mr-routine-outage).
 *
 * The SAME out-of-band channel the host uses (documentation/sysadmin-out-of-
 * band-channel.md, Layer 1: scripts/sysadmin-mcp/telegram_notify.py): the
 * sysadmin bot, the operator's chat, Bot API `sendMessage`. Same credentials
 * by name - SYSADMIN_TELEGRAM_BOT_TOKEN / SYSADMIN_TELEGRAM_CHAT_ID - passed to
 * openbrain-digest through OB1/docker/.env. Unset = inert: the alert is
 * logged (and recorded in the day state as not delivered), nothing is sent.
 *
 * Content-free by construction: the text is built ONLY from step names,
 * counts, states and times (buildAlertText). No subject, no email content, no
 * link, no error body. Never throws.
 */

export interface AlertSender {
  readonly configured: boolean;
  send(text: string): Promise<boolean>;
}

export class TelegramNotifier implements AlertSender {
  constructor(
    private readonly opts: {
      token?: string;
      chatId?: string;
      apiBase?: string; // default https://api.telegram.org (tests point it at a stub)
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  get configured(): boolean {
    return !!(this.opts.token && this.opts.chatId);
  }

  async send(text: string): Promise<boolean> {
    if (!this.configured) return false;
    const f = this.opts.fetchFn ?? fetch;
    const base = (this.opts.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    try {
      const res = await f(`${base}/bot${this.opts.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ chat_id: this.opts.chatId!, text, disable_web_page_preview: "true" }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 12_000),
      });
      const body = await res.json().catch(() => ({})) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false; // never echo the error: it can carry the token-bearing URL
    }
  }
}

export interface AlertFacts {
  date: string;
  tz: string;
  checkedAt: string; // "HH:MM tz (HH:MMZ)"
  digest: { sent: boolean; attempts: number; state: string };
  podcast: { produced: boolean; state: string };
}

/** The only way alert text is made: fixed words + the allowed facts. */
export function buildAlertText(f: AlertFacts): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9 :()/._+-]/g, "").slice(0, 80);
  const lines = [`[openbrain] morning routine ${safe(f.date)}: problem at ${safe(f.checkedAt)}`];
  lines.push(
    f.digest.sent
      ? `- digest: sent`
      : `- digest: NOT sent (${f.digest.attempts} attempt(s); ${safe(f.digest.state)})`,
  );
  lines.push(f.podcast.produced ? `- podcast: produced` : `- podcast: NOT produced (${safe(f.podcast.state)})`);
  lines.push(`Check: docker logs openbrain-digest / openbrain-podcast; state in D:\\_data\\routine\\${safe(f.date)}.*`);
  return lines.join("\n");
}
