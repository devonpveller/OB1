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
  if (!v.ok) return { ok: false, refusal: v.refusal };
  return {
    ok: true, question: v.request.question, topic: v.request.topic, links: v.request.links,
    depth: run.depth ? resolveDepth(run.depth, ceilings) : null,
  };
}
