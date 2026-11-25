// "Flag for cleanup" (rwr-flag-buttons): what the dialog sends and reads. Every call goes through lib/api.ts (the one door) to
// the flags routes of rwr-flags-api: POST /workbench/contract/flags (create) and GET (the caller's own list, for the Cleanup
// screen's "Flagged by you"). This file never names a user (whose flag it is comes from the server's identity seam), keeps
// nothing in the browser and never puts a title, a note or an id into a message.
//
// A flag changes NOTHING about the flagged item (the route only checks that it exists), so there is nothing here to undo.
import { api, ApiError } from "../../lib/api";
import { resolveDocument } from "../../lib/state";
import { docHref } from "../../screens/documents/docs-data";

// The six reasons of the approved Cleanup mockup, in the order they are shown: the keys are the flag_reasons registry's
// (slot 500, plus slot 680 for outdated and broken_link), the words are the person's. test/flag-reasons-catalog.test.ts
// fails if this list and the registry's migrations ever differ.
export const REASONS = [
  { key: "wrong_claim", label: "Wrong claim" },
  { key: "low_quality", label: "Low quality" },
  { key: "duplicate", label: "Duplicate" },
  { key: "outdated", label: "Outdated" },
  { key: "broken_link", label: "Broken link" },
  { key: "other", label: "Other" },
] as const;
export type ReasonKey = (typeof REASONS)[number]["key"];

export type FlagItem = { kind: "source" | "claim" | "reference"; id: string };
// where the flag is made from: a document (its vault path, the route's own shape) or a source (its id)
export type FlagFrom = { kind: "document" | "source"; ref: string };

export const NOTE_MAX = 2000; // the route's cap
// the route refuses these (a NUL would reach the database); tab, newline and carriage return are fine
export const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type FlagOutcome =
  | { kind: "flagged" }
  | { kind: "gone" }      // the item (or where it was flagged from) is not available: missing and someone else's are ONE answer
  | { kind: "refused" }   // the back end did not accept the flag (a value it does not know, a note it will not take)
  | { kind: "failed" };   // nothing could be said (a network failure, a 5xx, an answer that is not a flag)

// One flag. The outcome carries no text of the server's: its 404 says which thing was missing, and a person who is not
// allowed to know that is told one sentence either way.
export async function flagItem(item: FlagItem, reason: ReasonKey, note: string, from: FlagFrom): Promise<FlagOutcome> {
  try {
    const body: Record<string, unknown> = { item_kind: item.kind, item_id: item.id, reason, from: { kind: from.kind, ref: from.ref } };
    if (note.trim() !== "") body.note = note;
    const { data } = await api<any>("POST", "/workbench/contract/flags", body);
    return data && typeof data.id === "string" ? { kind: "flagged" } : { kind: "failed" };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404) return { kind: "gone" };
      if (e.status === 400 || e.status === 422) return { kind: "refused" };
    }
    return { kind: "failed" };
  }
}

export type MyFlag = {
  id: string; item: FlagItem; reason: string; note: string; from: FlagFrom; state: string; createdAt: string;
};
// The caller's own flags, newest first (what Cleanup > Flagged by you lists). `total` is the caller's own count.
export async function readMyFlags(limit = 100): Promise<{ flags: MyFlag[]; total: number }> {
  const { data } = await api<any>("GET", `/workbench/contract/flags?limit=${encodeURIComponent(String(limit))}`);
  if (!data || !Array.isArray(data.flags) || typeof data.total !== "number") throw new Error("unexpected answer");
  return {
    total: data.total,
    flags: data.flags.map((f: any) => ({
      id: String(f.id), item: { kind: f.item_kind, id: String(f.item_id) }, reason: String(f.reason), note: String(f.note ?? ""),
      from: { kind: f.from?.kind, ref: String(f.from?.ref ?? "") }, state: String(f.state), createdAt: String(f.created_at ?? ""),
    })),
  };
}

// The link back to where a flag was made. A document is reached through its opaque id (never its path or its title in an
// address): the id is read for the person's own live document, and a document that is gone has no link (null). A source has
// no screen of its own yet (the Library's Source screen is phase 2): the Library with the source named in the address, which
// that screen will read.
export async function flagBackLink(from: FlagFrom): Promise<string | null> {
  if (from.kind === "source") return "/library?source=" + encodeURIComponent(from.ref);
  const d = await resolveDocument(from.ref);
  return d?.ref ? docHref(d.ref) : null;
}
