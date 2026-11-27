// What the Cleanup screen reads and does (rwr-cleanup). Every call goes through lib/api.ts (the one door):
//   ready to erase   GET  contract/cleanup/sources            shared: suppressed / unlinked sources; only those the server says may be erased
//   worth reopening  GET  contract/cleanup/reopen-candidates  erased sources whose address came back with evidence
//   flagged by you   GET  contract/flags?state=open           the caller's OWN flags (never scope=all)
//   reasons          GET  contract/registries/flag_reasons    the words for a flag's reason: the server's registry, no list here
//   dismissals       GET/POST/DELETE contract/cleanup/dismissals   the caller's own "not again for this" (rwr-cleanup, slot 710)
//   Erase for good   POST contract/cleanup/sources/:id/erase
//   Apply to all     POST contract/cleanup/process-all          ONE reason for the whole batch
//   Reopen           POST contract/cleanup/tombstones/:id/lift
//   Take a flag back PATCH contract/flags/:id {state: withdrawn}
// Nothing here names a person (the server's identity seam says whose rows these are), nothing read is kept in the browser,
// and the server's own words are never shown: a refusal is one plain sentence (plainFailure), so another person's row and a
// missing one read the same.
import { api } from "../../lib/api";
import { dependsOn } from "../removals/removals-data";
import { flagBackLink, type FlagFrom } from "../../components/flag/flag-data";

const listOf = (data: any, key: string): any[] => {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error("unexpected answer: no " + key);
  return data[key];
};
const str = (x: unknown) => (typeof x === "string" ? x : "");
const enc = encodeURIComponent;

// ---- ready to erase
export type ReadyItem = { id: string; title: string; url: string | null; why: string; at: string; affects: { shared: string[]; private: boolean } };
export async function readReady(): Promise<ReadyItem[]> {
  const { data } = await api("GET", "/workbench/contract/cleanup/sources?limit=500");
  return listOf(data, "sources")
    .filter((s) => s && s.erase_allowed === true) // the server's gate: unlinked with nothing blocking
    .map((s) => ({
      id: str(s.id), title: str(s.title), url: typeof s.url === "string" ? s.url : null, why: str(s.reason), at: str(s.suppressed_at),
      affects: dependsOn(s.counts && typeof s.counts === "object" ? s.counts : {}),
    }));
}

// ---- worth reopening
export type Candidate = {
  tombstoneId: string; title: string; url: string; reasonType: string; note: string; byYou: boolean; at: string;
  evidence: { note: string; reason: string; at: string }[]; disputes: boolean;
};
export async function readCandidates(): Promise<Candidate[]> {
  const { data } = await api("GET", "/workbench/contract/cleanup/reopen-candidates?limit=100");
  return listOf(data, "candidates").map((c) => {
    const t = c?.tombstone ?? {};
    return {
      tombstoneId: str(t.id), title: str(t.title), url: str(t.url), reasonType: str(t.reason_type), note: str(t.note), byYou: t.erased_by_you === true, at: str(t.erased_at),
      evidence: (Array.isArray(c?.evidence) ? c.evidence : []).map((e: any) => ({ note: str(e?.note), reason: str(e?.reason), at: str(e?.attempted_at) })),
      disputes: c?.dispute_preview != null,
    };
  }).filter((c) => c.tombstoneId !== "");
}

// ---- flagged by you
export type FlagItem = { id: string; itemKind: string; reason: string; note: string; from: FlagFrom; at: string };
export async function readFlags(): Promise<FlagItem[]> {
  const { data } = await api("GET", "/workbench/contract/flags?state=open&limit=500");
  return listOf(data, "flags").map((f) => ({
    id: str(f.id), itemKind: str(f.item_kind), reason: str(f.reason), note: str(f.note), from: { kind: (f.from?.kind === "source" ? "source" : "document") as FlagFrom["kind"], ref: str(f.from?.ref) }, at: str(f.created_at),
  })).filter((f) => f.id !== "");
}

// The words for the flag reasons come from the server's registry (flag_reasons): a reason added there shows with no change
// here. A key the registry did not list (or a registry that could not be read) still reads sensibly: a well-formed key is
// spoken as words ("stale_data" -> "Stale data"); anything else is "Another reason". The raw text is never shown.
export type ReasonWords = Map<string, string>;
export async function readReasonWords(): Promise<ReasonWords> {
  const { data } = await api("GET", "/workbench/contract/registries/flag_reasons");
  const m: ReasonWords = new Map();
  for (const e of listOf(data, "entries")) if (typeof e?.key === "string" && typeof e?.label === "string" && e.retired_at == null) m.set(e.key, e.label);
  return m;
}
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function reasonLabel(key: string, words: ReasonWords | null): string {
  const w = words?.get(key);
  if (w && w.trim() !== "" && w.length <= 60) return sentence(w.trim());
  if (/^[a-z][a-z_]{0,38}$/.test(key)) return sentence(key.replace(/_/g, " "));
  return "Another reason";
}
const ITEM_WORDS: Record<string, string> = { source: "a source", claim: "a claim", reference: "a reference" };
export const itemWords = (kind: string) => ITEM_WORDS[kind] ?? "an item";

// The reasons an erase may be recorded with (plain words for the contract's erasure_reasons keys, as on Removals).
export const ERASE_REASONS: [string, string][] = [
  ["deliberate", "On purpose: I do not want it"],
  ["credibility", "It was not credible enough"],
  ["debunked", "It was shown to be wrong"],
];
export const eraseReasonWords = (key: string) => ERASE_REASONS.find(([k]) => k === key)?.[1] ?? "Another reason";

// ---- suggestions: the scan (rwr-cleanup-scan) lands later; until then there is nothing to read and nothing is requested.
export type Suggestion = { key: string; title: string; why: string; affects: string; preview: string };
export async function readSuggestions(): Promise<Suggestion[]> { return []; }
// What a person still sees: their dismissals take a suggestion out of THEIR list (a different person's list is not touched).
export const visibleSuggestions = (all: Suggestion[], dismissed: Map<string, string>) => all.filter((s) => !dismissed.has(s.key));

// ---- dismissals: the caller's own. kind -> ref -> the dismissal's id (to take it back)
export type DismissKind = "reopen_candidate" | "suggestion";
export async function readDismissals(kind: DismissKind): Promise<Map<string, string>> {
  const { data } = await api("GET", `/workbench/contract/cleanup/dismissals?kind=${enc(kind)}&limit=1000`);
  const m = new Map<string, string>();
  for (const d of listOf(data, "dismissals")) if (typeof d?.ref === "string" && typeof d?.id === "string") m.set(d.ref, d.id);
  return m;
}
export async function dismiss(kind: DismissKind, ref: string): Promise<string> {
  const { data } = await api("POST", "/workbench/contract/cleanup/dismissals", { kind, ref });
  if (typeof data?.id !== "string") throw new Error("unexpected answer");
  return data.id;
}
export const undismiss = (id: string) => api("DELETE", `/workbench/contract/cleanup/dismissals/${enc(id)}`);

// ---- actions
export const eraseSource = (id: string, reason_type: string) => api("POST", `/workbench/contract/cleanup/sources/${enc(id)}/erase`, { reason_type });
export const liftMarker = (id: string) => api("POST", `/workbench/contract/cleanup/tombstones/${enc(id)}/lift`, {});
export const withdrawFlag = (id: string) => api("PATCH", `/workbench/contract/flags/${enc(id)}`, { state: "withdrawn" });

export type BatchResult = { erased: number; others: { id: string; outcome: string }[] };
export async function applyAll(reason_type: string, source_ids: string[]): Promise<BatchResult> {
  const { data } = await api("POST", "/workbench/contract/cleanup/process-all", { reason_type, source_ids });
  const items = listOf(data, "items");
  const others = items.filter((i) => i?.outcome !== "erased").map((i) => ({ id: str(i?.source_id), outcome: str(i?.outcome) }));
  return { erased: items.length - others.length, others };
}

// The link back to where a flag was made (an opaque document id or the source's address): never a path or a title.
export const backLink = flagBackLink;

// A refusal in plain words (the server's text is never shown). `what` says which action it was.
export { plainFailure } from "../removals/removals-data";
