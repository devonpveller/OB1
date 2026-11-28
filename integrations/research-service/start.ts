/**
 * The start door's shared core (rwr-research-start-api). The PREVIEW (POST /research/derived/preview) and the START
 * (POST /research/derived) both form the request through formForDoor, which is formDerivedRequest - the one request
 * boundary - and nothing else. The preview never writes: it takes no database handle at all.
 *
 * approved_question: the question the owner saw in the preview. The start replaces the model's proposal with it and
 * lets the gate decide again (the gate, not the caller, decides what is public); if the result is not that very
 * question (the page changed, or the gate refused it and fell to the template) the start answers `changed` and
 * creates nothing, so what leaves is what was shown or nothing.
 */
import { type BoundaryDeps, type BoundaryVerdict, formDerivedRequest, type DerivedRun, type PersonalItem, type Purpose } from "./boundary.ts";
import { type Budget, resolveDepth } from "./depth.ts";

export interface DoorParsed { item: PersonalItem; purpose: Purpose; deliver: Record<string, unknown>; run: DerivedRun; approved?: string }

/** rwr-research-start-api, round 2: the PREVIEW refuses an idea exactly as the derived door does (slot 580 PD0b: an
 *  idea's research is queued by the database and formed by the idea drain, never through these doors), so a preview
 *  never shows what no start could do. The derived door keeps its own inline check (index.ts); this mirrors it. */
export const IDEA_DOOR_REFUSAL = "an idea's research is queued by the database (capture, update, research now); this door does not take it";
export function doorRefusesIdea(p: Pick<DoorParsed, "item" | "purpose">): boolean {
  return p.purpose === "idea-research" || p.item.kind === "idea";
}

export function approvedDeps(base: BoundaryDeps, approved?: string): BoundaryDeps {
  return approved === undefined ? base : { ...base, propose: () => Promise.resolve([approved]) };
}

export function formForDoor(parsed: DoorParsed, base: BoundaryDeps): Promise<BoundaryVerdict> {
  return formDerivedRequest(parsed.item, parsed.purpose, approvedDeps(base, parsed.approved));
}

export function startChanged(v: BoundaryVerdict, approved: string | undefined): boolean {
  return approved !== undefined && v.ok && v.request.question !== approved;
}

/** What would leave the workbench, and nothing else: the question, its topic, the public links, the depth. A refusal
 *  is its code only. */
export function previewBody(v: BoundaryVerdict, run: DerivedRun, ceilings: Budget): Record<string, unknown> {
  if (!v.ok) return { ok: false, refusal: v.refusal, sources: run.sources ?? null };
  return {
    ok: true, question: v.request.question, topic: v.request.topic, links: v.request.links,
    depth: run.depth ? resolveDepth(run.depth, ceilings) : null,
    sources: run.sources ?? null,
  };
}

/** rwr-research-sources: the admin switch (research.community_allowed) is off - the door refuses `community` (403). */
export const COMMUNITY_OFF = "community sources are switched off by an admin, so research reads credible sources only";
export function sourcesRefusal(run: DerivedRun, communityAllowed: boolean): string | null {
  return run.sources === "community" && !communityAllowed ? COMMUNITY_OFF : null;
}

/** rwr-research-sources (operator Q7): a credible-only start whose public links include community pages is refused
 *  with this reason (a refusal code, like the boundary's own), rather than dropping the links silently. */
export const COMMUNITY_LINK_REFUSAL = "community_link_in_credible_run";
export function communityLinks(run: DerivedRun, links: readonly string[], isCommunity: (url: string) => boolean): string[] {
  return run.sources === "credible" ? links.filter((l) => isCommunity(l)) : [];
}
