// What the Library shell reads and writes (rwr-lib-shell). Every call goes through lib/api.ts (the one door), for the subject the
// server resolves: this code never names a user. Nothing read here is stored in the browser, cached across people or logged, and
// nothing is sent to a model.
//
// Three routes, all landed:
//  - POST contract/source-states: the lifecycle of up to 200 shared sources by id. A HELD source and an unknown id are simply absent
//    from the answer (never a hint), so "absent" is read as "not available to you", whoever you are.
//  - POST contract/documents/pending-refs: add a cite (a source OR a claim) to one of the caller's own documents' "to place" list.
//  - GET contract/documents: the caller's own documents, for the picker that asks which document "add all" is for.
// There is no read of one source or one claim by id yet (rwr-source-reader-api / rwr-source build it), so a chip's TITLE is the one
// the page was handed when the person opened the item (lib/recent.ts titles(), memory only). A claim this page never read has no
// title and is never offered for citing: the shared search does not filter a claim drawn from someone's private report today, so
// "this page read it for this person" is the only evidence a claim is safe to offer.
import { api, ApiError } from "../../lib/api";
import type { PickerItem, MineSearch } from "../../components/picker";
import { tabOf } from "../documents/docs-data";
import { keyOf, titles } from "../../lib/recent";
import type { RecentItem } from "../../lib/state";

export type ChipState = "checking" | "active" | "suppressed" | "unlinked" | "erased" | "unavailable" | "unknown" | "unverified";
export const OPENABLE = ["source", "claim"] as const;
export const isOpenable = (k: string) => (OPENABLE as readonly string[]).includes(k);
export const itemUrl = (kind: string, id: string) => `/library?${kind}=${encodeURIComponent(id)}`;

export const KIND_NAME: Record<string, string> = { source: "Source", claim: "Claim", topic: "Topic", gap: "Gap", document: "Document", idea: "Idea", run: "Research run" };
const short = (id: string) => id.replace(/^documents\//, "").slice(0, 8);

export const SOURCE_STATES_URL = "/workbench/contract/source-states";
const CHUNK = 200;

// The lifecycle of each id, by lower-cased id. An id the answer does not hold is "unavailable". Throws when the read fails or the
// answer is not the expected JSON (the caller then shows "unknown", never a guess).
export async function readSourceStates(ids: string[]): Promise<Map<string, ChipState>> {
  const out = new Map<string, ChipState>();
  const all = [...new Set(ids.map((x) => x.toLowerCase()))];
  for (let i = 0; i < all.length; i += CHUNK) {
    const part = all.slice(i, i + CHUNK);
    const { data } = await api<{ by_id?: unknown }>("POST", SOURCE_STATES_URL, { ids: part });
    const by = data && typeof data === "object" ? (data as { by_id?: unknown }).by_id : undefined;
    if (!by || typeof by !== "object" || Array.isArray(by)) throw new Error("unexpected answer");
    for (const id of part) {
      const row = (by as Record<string, { lifecycle?: unknown } | undefined>)[id];
      const lc = row && typeof row === "object" ? row.lifecycle : undefined;
      out.set(id, lc === "active" || lc === "suppressed" || lc === "unlinked" || lc === "erased" ? lc : lc === undefined ? "unavailable" : "unknown");
    }
  }
  return out;
}

export function stateOf(item: { kind: string; id: string }, states: Map<string, ChipState> | null, failed: boolean): ChipState {
  if (item.kind === "source") {
    if (failed) return "unknown";
    if (!states) return "checking";
    return states.get(item.id.toLowerCase()) ?? "checking";
  }
  if (item.kind === "claim") return titles.get("claim", item.id) ? "active" : "unverified";
  return "active";
}

// What a chip says. A state other than active / unknown / checking is shown INSTEAD of the title, never beside it: nothing of an
// item the caller cannot read (or that is hidden) is on the page.
export function chipLabel(item: { kind: string; id: string }, state: ChipState): string {
  const name = KIND_NAME[item.kind] ?? item.kind;
  const s = short(item.id);
  if (item.kind === "source") {
    switch (state) {
      case "suppressed": return `Hidden source (${s})`;
      case "unlinked": return `Cut-loose source (${s})`;
      case "erased": return `Erased source (${s})`;
      case "unavailable": return `Source ${s} is no longer available`;
      case "checking": return `${name} ${s}`;
      default: return titles.get("source", item.id) ?? `${name} ${s}`;
    }
  }
  if (item.kind === "claim") return titles.get("claim", item.id) ?? `${name} ${s}`;
  return `${name} ${s}`;
}

export const STATE_TEXT: Partial<Record<ChipState, string>> = {
  suppressed: "This source is hidden. Its title and text are not shown.",
  unlinked: "This source was cut loose from the library. Its title and text are not shown.",
  erased: "This source was erased. Nothing of it is shown.",
  unavailable: "This source is no longer available to you. Nothing of it is shown.",
  unknown: "The state of this source could not be checked just now.",
  checking: "Checking this source.",
  unverified: "This claim has not been read in this page, so its text is not available here. Open it from a search result.",
};

// Why a chip cannot be added to a "to place" list, or null when it can.
export function whyNotCitable(item: RecentItem, state: ChipState): string | null {
  if (item.kind === "source") {
    if (state === "active") return null;
    if (state === "checking") return "its state is still being checked";
    if (state === "unknown") return "its state could not be checked";
    return state === "suppressed" ? "it is hidden" : state === "unlinked" ? "it was cut loose" : state === "erased" ? "it was erased" : "it is no longer available to you";
  }
  if (item.kind === "claim") return state === "active" ? null : "this page has not read it";
  return "only sources and claims can be cited";
}

export type AddOutcome = "added" | "already" | "full" | "gone" | "no-document" | "failed";
export const PENDING_URL = "/workbench/contract/documents/pending-refs";

// One cite into one of the caller's own documents' to-place list. The wording of a refusal is the app's own, never the server's.
export async function addToPlace(path: string, item: { kind: "source" | "claim"; id: string }): Promise<AddOutcome> {
  try {
    await api("POST", PENDING_URL, { path, ...(item.kind === "source" ? { source_id: item.id } : { claim_id: item.id }), added_from: "library" });
    return "added";
  } catch (e) {
    if (!(e instanceof ApiError)) return "failed";
    const msg = String(e.body?.error ?? "");
    if (e.status === 409) return (e.body?.detail as { pending_ref_id?: unknown } | undefined)?.pending_ref_id ? "already" : "full";
    if (e.status === 404) return /document/.test(msg) ? "no-document" : "gone";
    return "failed";
  }
}

export const OUTCOME_WHY: Record<Exclude<AddOutcome, "added" | "already">, string> = {
  full: "that document's to-place list is full",
  gone: "it is no longer there to cite",
  "no-document": "that document is not available",
  failed: "it could not be added just now",
};

// The caller's own live documents whose title holds the words: the picker's "my own" search for the document "add all" is for.
export const searchMyDocuments: MineSearch = async (q) => {
  const { data } = await api<{ documents?: unknown }>("GET", "/workbench/contract/documents?limit=500");
  const list = data && typeof data === "object" && Array.isArray((data as { documents?: unknown }).documents) ? ((data as { documents: any[] }).documents) : null;
  if (!list) throw new Error("unexpected answer");
  const want = q.trim().toLowerCase();
  const out: PickerItem[] = [];
  for (const d of list) {
    if (!d || typeof d.path !== "string" || tabOf(d.path) !== "active") continue;
    const title = String(d.title ?? "");
    if (!title.toLowerCase().includes(want)) continue;
    out.push({ kind: "document", id: d.path, title, snippet: "", state: null, lifecycle: null, type: null, date: typeof d.updated === "string" ? d.updated : null });
    if (out.length === 50) break;
  }
  return out;
};

export { keyOf };
