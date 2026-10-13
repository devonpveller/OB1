/**
 * Handing a down dependency to the system that owns it (round 3).
 *
 * What exists in this stack (read 2026-10-13, scripts/ + documentation/):
 *  - model / inference (llm-gateway, llm-queue, llama-cpp-upstream): owned by the
 *    host StackWatchdog (scripts/checks/stack-watchdog.ps1, Scheduled Task every
 *    10 min). It probes inference through the gateway, auto-repairs, and pages
 *    the `inference` / `llm-gateway` catastrophe keys by Telegram when repair
 *    fails. It has NO inbound request API (no HTTP port, no inbox) - it acts on
 *    its own schedule. The human-facing owner channel is the #sysadmin
 *    Mattermost thread, served by the sysadmin bridge persona (@sysadmin,
 *    scripts/sysadmin-mcp/charter.md: read-only stack_health / container_status
 *    / container_logs, gated actions only with operator approval).
 *  - research engine (openbrain-research): owns its own recovery - its
 *    dispatcher probes the model every 60 s and resumes when it answers
 *    (mr-research-failfast). Unreachable -> container owner = the watchdog's
 *    crash-loop census + #sysadmin.
 *  - Gmail auth (OAuth token): owned by the operator (re-consent with
 *    setup-token.ts); no automated owner exists.
 *  - The ops gateway (openbrain-ops-gateway :8062) is an agent-memory proxy, not
 *    an operations API - not usable for this.
 * So the hand-off is ONE post per dependency per day into #sysadmin through the
 * Mattermost REST API (the same path openbrain-idea-refinery uses:
 * host.docker.internal:8065, a bot token, POST /api/v4/posts). It names the
 * dependency, its owner and the time - no content. The "response" is observed,
 * not received: the routine re-checks the dependency on a bounded timer (the
 * watchdog repairs, or the operator / @sysadmin acts) and proceeds, or records
 * FAILED with the reason. Unconfigured (no token/channel) = inert, logged.
 * Note: the sysadmin bridge only ACTS on posts from its configured operators;
 * a bot post is a visible request in the thread, not a command.
 */

export type Dep = "model" | "research" | "gmail-auth";

export const OWNERS: Record<Dep, string> = {
  model: "StackWatchdog inference check + #sysadmin (llm-gateway / llama-cpp)",
  research: "openbrain-research self-probe; container: StackWatchdog + #sysadmin",
  "gmail-auth": "operator (re-consent: recipes/daily-digest/setup-token.ts)",
};

export interface OwnerChannel {
  readonly configured: boolean;
  request(dep: Dep, text: string): Promise<"posted" | "failed" | "unconfigured">;
}

export class MattermostOwnerChannel implements OwnerChannel {
  constructor(
    private readonly o: { url?: string; token?: string; channelId?: string; fetchFn?: typeof fetch; timeoutMs?: number },
  ) {}
  get configured(): boolean {
    return !!(this.o.url && this.o.token && this.o.channelId);
  }
  async request(_dep: Dep, text: string): Promise<"posted" | "failed" | "unconfigured"> {
    if (!this.configured) return "unconfigured";
    try {
      const r = await (this.o.fetchFn ?? fetch)(`${this.o.url!.replace(/\/$/, "")}/api/v4/posts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: this.o.channelId, message: text }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
      await r.body?.cancel();
      return r.ok ? "posted" : "failed";
    } catch {
      return "failed";
    }
  }
}

/** The hand-off text: dependency, owner, reason class, times. Nothing else. */
export function handoffText(date: string, dep: Dep, reason: string, at: string, waitUntil: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9 :()/._+-]/g, "").slice(0, 100);
  return [
    `@sysadmin [openbrain morning routine ${safe(date)}] dependency NOT operational: ${dep}`,
    `- reason: ${safe(reason)}`,
    `- owner: ${OWNERS[dep]}`,
    `- seen at ${safe(at)}; the routine re-checks it and waits until ${safe(waitUntil)}, then records FAILED.`,
    `Please check availability (stack_health / container_status).`,
  ].join("\n");
}
