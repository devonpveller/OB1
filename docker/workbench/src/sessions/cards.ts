// Running-session cards (research-workbench P4b, rw-p4b-sessions): the pure half. Every research job,
// whatever started it, is ONE card of ONE shape (D17): its origin badge, a link back to its inlet where
// the job carries a reference to one, its phase, the artifact it is on, what it is waiting on, where an
// interjection would land (the next steering point), its branch tree with open and closed branches, and
// whether the viewer may steer or cancel it from the card.
//
// Privacy (07-MULTI-USER): the repository decides `foreign` in SQL (documents/ownership.ts FOREIGN_JOB)
// and hands this module a row whose private fields are already empty for anyone but the owner - the
// original prompt (query), the inlet reference, the refinery, the branch texts, the step ids and the
// per-source events. This module never re-derives ownership from a field it was not given.
//
// Authority (operator 2026-10-30, option "Admins"): a user's job is its owner's; a job a SERVICE owns
// (service:<caller>, e.g. Mattermost / agent-org) an admin's too; a job with no recorded owner the
// default subject's (rw-identity round 3). The research service enforces the same rule (viewer.ts
// MAY_ACT_SQL); the card only hides what would be refused.

export interface InletRef {
  kind?: string;
  id?: string;
}

export interface BranchRow {
  id: string;
  parent_job_id: string | null;
  branch_kind: string;
  rooted_step_id: string | null;
  status: string;
  query: string;
  created_at: string;
}

export interface EventRow {
  id: number | string;
  job_id: string;
  step_id: string | null;
  type: string;
  kind: string;
  payload: Record<string, unknown> | null;
  trail: Record<string, unknown> | null;
  created_at: string;
}

export interface CardInput {
  id: string;
  status: string;
  origin: string;
  caller: string | null;
  inlet_ref: InletRef | null;
  refinery_id: string | null;
  query: string;
  progress: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number | null;
  foreign: boolean;
  // the job came from an idea (inlet kind idea): not private - it decides the badge for every viewer
  idea_inlet?: boolean;
  can_act: boolean;
  branches: BranchRow[];
  events: EventRow[];
}

export type Link =
  | { kind: "external"; href: string }
  | { kind: "panel"; panel: string; params: Record<string, string> };

const OPEN = new Set(["queued", "running"]);
export const isOpen = (status: string) => OPEN.has(status);

// ── the origin badge ───────────────────────────────────────────────────────────────────────────
const LABELS: Record<string, string> = {
  workspace: "Workspace", owui: "Open WebUI", mattermost: "Mattermost", notebook: "Notebook", manual: "Manual",
  idea_refinery: "Idea Refinery",
};
// An Idea Refinery job rides the agent key (origin mattermost) until the refinery is rebuilt into the
// front end (D17, settled 2026-09-25); its inlet reference names the idea - that is its badge.
export function badgeOf(origin: string, inlet: InletRef | null): { key: string; label: string } {
  const key = inlet?.kind === "idea" ? "idea_refinery" : (origin || "manual");
  return { key, label: LABELS[key] ?? key };
}

// ── the link back to the inlet (operator 2026-10-30, option "Badge now, links later") ───────────
// OWUI: the chat, under WORKSPACE_OWUI_BASE_URL (shipped blank = no link). Workspace: the document or
// the refinery room. Idea Refinery: the idea's refinery room (its ideas-panel entry lands with P8a).
// Manual: its own session. Mattermost and notebook: the badge only - agent-org sends no thread
// permalink and the digest no run id today, and no link is invented for a reference that is absent.
export function linkOf(origin: string, inlet: InletRef | null, sessionId: string, owui: string): Link | null {
  const kind = inlet?.kind ?? "";
  const id = typeof inlet?.id === "string" ? inlet.id : "";
  if (kind === "chat_id" && id) return owui ? { kind: "external", href: `${owui.replace(/\/+$/, "")}/c/${encodeURIComponent(id)}` } : null;
  if (kind === "document" && id) return { kind: "panel", panel: "document", params: { path: id } };
  if ((kind === "refinery" || kind === "idea") && id) return { kind: "panel", panel: "refinery", params: { idea_id: id, focus: "room" } };
  if (origin === "manual") return { kind: "panel", panel: "sessions", params: { session: sessionId } };
  return null;
}

// WORKSPACE_OWUI_BASE_URL, an http(s) URL without its trailing slash, or "" (no link).
export function owuiBase(env = (k: string) => Deno.env.get(k)): string {
  const raw = (env("WORKSPACE_OWUI_BASE_URL") ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return raw.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ── what the session is waiting on ─────────────────────────────────────────────────────────────
export function waitingOn(status: string, phase: string, openBranches: number, queuePos: number | null): { kind: string; detail: string } {
  if (status === "queued") return { kind: "queue", detail: queuePos ? `position ${queuePos}` : "the queue" };
  if (phase === "model_down") return { kind: "model", detail: "the model is unreachable; the job waits for it" };
  if (openBranches > 0) return { kind: "branches", detail: `${openBranches} open branch${openBranches === 1 ? "" : "es"}` };
  if (status === "running") return { kind: "stage", detail: phase || "running" };
  return { kind: "nothing", detail: status };
}

// ── where an interjection lands: the job's latest STEERING stage (P4a STAGE_KINDS) ─────────────
// A due-process stage (recall, screening, fetching, judging, filing) is never a steering point.
// Only a viewer who may act gets the step id (rw-identity round 5: step ids serve the owner's steering).
export function nextSteeringPoint(jobId: string, events: EventRow[], canAct: boolean): { step_id: string | null; phase: string } | null {
  const st = events.filter((e) => e.job_id === jobId && e.type === "stage" && e.kind === "steering" && e.step_id);
  const last = st[st.length - 1];
  if (!last) return null;
  return { step_id: canAct ? last.step_id : null, phase: String(last.payload?.phase ?? "") };
}

// ── the branch tree ────────────────────────────────────────────────────────────────────────────
export function treeOf(rows: BranchRow[], foreign: boolean, canAct: boolean) {
  return rows.map((b) => ({
    id: b.id,
    parent_job_id: b.parent_job_id,
    branch_kind: b.branch_kind,
    status: b.status,
    open: isOpen(b.status),
    // a steer's branch that has not started yet: what the card shows the moment a steer is accepted
    pending: b.branch_kind !== "root" && b.status === "queued",
    rooted_step_id: canAct ? b.rooted_step_id : null,
    query: foreign ? "" : b.query,
    created_at: b.created_at,
  }));
}

// ── authority ──────────────────────────────────────────────────────────────────────────────────
// owner: the root's research_prompts.owner_sub (null = no recorded owner); ownerless: who owns those.
export function mayActOn(owner: string | null, who: { sub: string }, ownerless: string | null, admin: boolean): boolean {
  if (owner === null) return ownerless !== null && ownerless === who.sub;
  if (owner === who.sub) return true;
  return admin && owner.startsWith("service:");
}

// The admin group from the signed-in token, re-read on every request (rw-identity); never while
// impersonating (the admin then acts as that user). In single-user mode (no sign-in configured) the
// default subject counts as admin (operator 2026-10-30).
export function adminOf(
  who: { sub: string; admin?: boolean; impersonating?: unknown },
  cfg: { signIn?: boolean; defaultSub: string },
): boolean {
  if (cfg.signIn) return !!who.admin && !who.impersonating;
  return who.sub === cfg.defaultSub;
}

// ── the card ───────────────────────────────────────────────────────────────────────────────────
export const CARD_KEYS = [
  "id", "status", "state", "origin", "badge", "link", "caller", "query", "phase", "current_artifact", "waiting_on",
  "next_steering_point", "tree", "can_act", "created_at", "started_at", "finished_at",
] as const;

export function currentArtifact(jobId: string, events: EventRow[], phase: string): { kind: string; label: string } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "source" && typeof e.payload?.url === "string") return { kind: "source", label: e.payload.url };
    if (e.type === "stage" && e.job_id === jobId) break;
  }
  return { kind: "stage", label: phase };
}

// The contract has no unions (schemas/common.ts rule 1): a link is one flat shape on the wire.
export function flatLink(l: Link | null) {
  if (!l) return null;
  return l.kind === "external"
    ? { kind: l.kind, href: l.href, panel: null, params: {} as Record<string, string> }
    : { kind: l.kind, href: null, panel: l.panel, params: l.params };
}

export function cardOf(r: CardInput, owui: string) {
  const phase = String(r.progress?.phase ?? r.status);
  const tree = treeOf(r.branches, r.foreign, r.can_act);
  const openChildren = tree.filter((b) => b.id !== r.id && b.open).length;
  return {
    id: r.id,
    status: r.status,
    state: isOpen(r.status) || openChildren > 0 ? "loading" : "current",
    origin: r.origin,
    badge: badgeOf(r.origin, r.idea_inlet ? { kind: "idea" } : r.inlet_ref),
    link: flatLink(linkOf(r.origin, r.foreign ? null : r.inlet_ref, r.id, owui)),
    caller: r.caller,
    query: r.foreign ? "" : r.query,
    phase,
    current_artifact: currentArtifact(r.id, r.events, phase),
    waiting_on: waitingOn(r.status, phase, openChildren, r.queue_position),
    next_steering_point: nextSteeringPoint(r.id, r.events, r.can_act),
    tree,
    can_act: r.can_act,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}
export type Card = ReturnType<typeof cardOf>;
