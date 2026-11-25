// rwr-episode-from: the pure side of "make an episode from something" - the kinds a render request can start from,
// the disclosure an owner is shown before an episode made from private material is shared, and its fingerprint.
// No database, no network: repo/episode_inputs.ts resolves the material (owner-checked), repo/podcasts.ts stores it.
//
// THE KINDS are a registry (KINDS below). openbrain-podcast keeps the matching registry on the render side
// (recipes/daily-digest/src/podcast/input-kinds.ts); a kind exists once in each, and the renderer carries no
// per-kind branch. `discussion` is registered but not usable: it waits for its store (rwr-disc-store-api).
import { BadRequest } from "./scope.ts";

export interface InputKindEntry {
  id: string;
  /** starts from the requester's personal data: the episode it makes is private to them until they share it */
  personal: boolean;
  /** false = registered, not usable yet */
  available: boolean;
}

export const KINDS: readonly InputKindEntry[] = [
  { id: "run", personal: true, available: true },
  { id: "report", personal: true, available: true },
  { id: "document", personal: true, available: true },
  { id: "idea", personal: true, available: true },
  { id: "topic", personal: false, available: true },
  { id: "discussion", personal: true, available: false },
];

export function kindEntry(id: string): InputKindEntry | undefined {
  return KINDS.find((k) => k.id === id);
}

/** The marker an item carries: `private` = only its owner can see it today; `cloud` = derived through a cloud route
 *  (none exists yet; the marker is here so the list is complete the day one does). */
export type ItemMarker = "private" | "cloud";

/** One thing that would become visible to other users if the episode were shared. */
export interface DisclosureItem {
  type: string; // run | report | document | idea | claim | source | quote | script
  id: string;
  label: string; // short, human: a title or the first words - shown to the OWNER only, in the disclosure
  marker: ItemMarker;
}

export const LABEL_MAX = 120;
export const ITEMS_MAX = 200;

export function labelOf(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1)}…` : one;
}

export function item(type: string, id: string, label: string, marker: ItemMarker = "private"): DisclosureItem {
  return { type, id, label: labelOf(label), marker };
}

/** What a caller names: a kind and the id of one thing of that kind (a document is named by its path). */
export interface FromRef {
  kind: string;
  id: string;
}

export const ID_MAX = 512;

/** The request's `from`, checked for shape only (the lookup is the owner-checked resolver's). */
export function parseFrom(raw: unknown): FromRef {
  const o = raw as { kind?: unknown; id?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.kind !== "string" || typeof o.id !== "string") {
    throw new BadRequest("from is {kind, id}");
  }
  if (!o.id.trim() || o.id.length > ID_MAX) throw new BadRequest("from.id is the id of one thing");
  if (!kindEntry(o.kind)) throw new BadRequest(`from.kind is one of ${KINDS.map((k) => k.id).join(", ")}`);
  return { kind: o.kind, id: o.id.trim() };
}

/** The sentence the owner reads before sharing (the operator's words, decision 2026-11-22). */
export function disclosureText(what: "podcast" | "discussion", items: DisclosureItem[]): string {
  const list = items.length ? items.map((i) => `${i.type}: ${i.label}${i.marker === "cloud" ? " (cloud-derived)" : ""}`).join("; ") : "nothing private";
  return `By sharing this ${what}, you'll be sharing the following private information to the users who have access to this server: [${list}]`;
}

/** A fingerprint of exactly the list the owner was shown. Confirming sends it back; a list that has changed since
 *  (another item resolved, a marker moved) no longer matches and the share is refused until it is shown again. */
export async function disclosureHash(items: DisclosureItem[]): Promise<string> {
  const canon = JSON.stringify([...items].map((i) => [i.type, i.id, i.label, i.marker]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Items recorded on a request's input (`source.items`), read defensively: the row is ours, but a shape that drifted
 *  must degrade to "less listed" never to a crash. A non-list reads as none. */
export function itemsOf(input: unknown): DisclosureItem[] {
  const src = (input as { source?: { items?: unknown } } | null)?.source;
  const raw = Array.isArray(src?.items) ? src!.items as unknown[] : [];
  const out: DisclosureItem[] = [];
  for (const r of raw) {
    const o = r as Record<string, unknown>;
    if (o && typeof o.type === "string" && typeof o.id === "string" && typeof o.label === "string" && (o.marker === "private" || o.marker === "cloud")) {
      out.push({ type: o.type, id: o.id, label: o.label, marker: o.marker });
    }
  }
  return out.slice(0, ITEMS_MAX);
}
