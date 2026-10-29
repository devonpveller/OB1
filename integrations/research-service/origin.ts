/**
 * Origin is bound to the CALLER'S KEY, not to the body (research-workbench P0, D17 item 1).
 *
 * Callers are declared in RESEARCH_CALLERS, one entry per key:
 *   RESEARCH_CALLERS="owui-tool=owui:<key>;agent-org=mattermost:<key>;digest=notebook:<key>"
 *   (name=origin:key; `;` or newline between entries; the origin must be a key of the
 *   `origins` registry - research_jobs.origin is a foreign key to it since 230-init-research-
 *   contract.sql, so an undeclared origin cannot be stored.)
 * The shared MCP_ACCESS_KEY keeps authenticating (nothing an existing caller sends today is
 * rejected), but it names no caller, so its jobs are recorded under RESEARCH_SHARED_KEY_ORIGIN
 * (default `manual`). A body `origin` never decides the recorded value: when it disagrees it
 * is kept as origin_claimed and logged ONCE per (caller, claimed value), naming the caller.
 *
 * Inlet reference (what the front end links back to): the OWUI chat id from callback.chat_id;
 * an explicit body `inlet_ref: {kind, id}` (a Mattermost permalink, a notebook run id); an Idea
 * Refinery job gets its idea id from the database when the refinery stamps the job on the idea
 * revision (trigger trg_idea_revisions_inlet) - the refinery sends nothing new.
 */
export interface Caller {
  name: string;
  origin: string;
  key: string;
  shared: boolean;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function parseCallers(raw: string | undefined, sharedKey: string, sharedOrigin: string): Caller[] {
  const out: Caller[] = [];
  for (const entry of (raw ?? "").split(/[;\n]/).map((e) => e.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([^:]+):(.+)$/.exec(entry);
    if (!m || !NAME.test(m[1].trim()) || !NAME.test(m[2].trim()) || m[3].trim().length < 16) {
      throw new Error(`RESEARCH_CALLERS entry is not name=origin:key (key >= 16 chars): ${entry.replace(/:.*/, ":***")}`);
    }
    out.push({ name: m[1].trim(), origin: m[2].trim(), key: m[3].trim(), shared: false });
  }
  const keys = new Set(out.map((c) => c.key));
  if (keys.size !== out.length) throw new Error("RESEARCH_CALLERS: two callers share one key");
  if (sharedKey && keys.has(sharedKey)) throw new Error("RESEARCH_CALLERS: a caller key equals MCP_ACCESS_KEY");
  if (sharedKey) out.push({ name: "shared-key", origin: sharedOrigin, key: sharedKey, shared: true });
  return out;
}

export function callerFor(key: string | null | undefined, callers: Caller[]): Caller | null {
  if (!key) return null;
  return callers.find((c) => c.key === key) ?? null;
}

export interface Resolved {
  origin: string; // what is recorded
  claimed: string | null; // the body's value, when it disagreed
  queueOrigin: string; // which per-origin queue lane the job rides
}

/** The recorded origin is the key's, always. Transitional: a job on the SHARED key rides the
 *  queue lane its body names when that lane exists (the digest's batch lane), so the overnight
 *  lane does not regress before the digest has its own key - the record is still the key's. */
export function resolveOrigin(caller: Caller, bodyOrigin: unknown, lanes: Record<string, string>): Resolved {
  const claimedRaw = typeof bodyOrigin === "string" ? bodyOrigin.trim() : "";
  const claimed = claimedRaw && claimedRaw !== caller.origin ? claimedRaw.slice(0, 64) : null;
  const queueOrigin = caller.shared && claimed && lanes[claimed] ? claimed : caller.origin;
  return { origin: caller.origin, claimed, queueOrigin };
}

export function inletRef(body: Record<string, unknown>): { kind: string; id: string } | null {
  const explicit = body.inlet_ref as Record<string, unknown> | undefined;
  if (explicit && typeof explicit.kind === "string" && typeof explicit.id === "string" && explicit.kind && explicit.id) {
    return { kind: explicit.kind.slice(0, 32), id: explicit.id.slice(0, 500) };
  }
  const chat = (body.callback as Record<string, unknown> | undefined)?.chat_id;
  if (typeof chat === "string" && chat.trim()) return { kind: "chat_id", id: chat.trim().slice(0, 200) };
  return null;
}

/** Logs a disagreement once per (caller, claimed value) for the life of the process. */
export class MismatchLog {
  #seen = new Set<string>();
  constructor(private sink: (line: string) => void = console.warn) {}
  note(caller: Caller, claimed: string | null, recorded: string): boolean {
    if (!claimed) return false;
    const k = `${caller.name}\u0000${claimed}`;
    if (this.#seen.has(k)) return false;
    this.#seen.add(k);
    this.sink(`[research] origin mismatch: caller=${caller.name} claimed=${claimed} recorded=${recorded} (D17: the key decides)`);
    return true;
  }
}

/**
 * On behalf of a user (rw-identity, 07-MULTI-USER; operator 2026-10-28: "research ... started from
 * Open WebUI lands in the same user's research front end"). The Open WebUI deep-research tool sends
 * its user's Authentik subject as `on_behalf_of`; it is accepted ONLY from a caller whose key is
 * bound to the `owui` origin (P0's RESEARCH_CALLERS) - any other key naming a user is refused
 * (403), so no other caller can file research under someone else's name, and the shared key never
 * can. Without it: the workspace records its own signed-in user (the workbench writes that row),
 * and every other caller's research is recorded under its service identity `service:<caller>`.
 */
export const ON_BEHALF_ORIGINS: ReadonlySet<string> = new Set(["owui"]);

export type OnBehalf = { sub: string | null } | { error: string; status: 400 | 403 };

export function onBehalfOf(caller: Caller, body: Record<string, unknown>): OnBehalf {
  const raw = body.on_behalf_of;
  if (raw === undefined || raw === null || raw === "") return { sub: null };
  if (caller.shared || !ON_BEHALF_ORIGINS.has(caller.origin)) {
    return { error: "on_behalf_of is accepted only from Open WebUI's caller key", status: 403 };
  }
  if (typeof raw !== "string") return { error: "on_behalf_of is the user's subject id (a string)", status: 400 };
  const sub = raw.trim();
  if (!sub || sub.length > 255 || /[\u0000-\u001f\u007f]/.test(sub) || /^(service|system|anonymous):/i.test(sub)) {
    return { error: "on_behalf_of is not a usable subject id", status: 400 };
  }
  return { sub };
}

/** Who the job's original prompt belongs to (research_prompts), or null when the caller records
 *  it itself (the workspace's own key: the workbench writes its signed-in user's row). */
export function promptOwner(caller: Caller, onBehalf: string | null): { owner_sub: string; actor_sub: string } | null {
  if (onBehalf) return { owner_sub: onBehalf, actor_sub: onBehalf };
  if (caller.origin === "workspace" && !caller.shared) return null;
  const svc = `service:${caller.name}`;
  return { owner_sub: svc, actor_sub: svc };
}
