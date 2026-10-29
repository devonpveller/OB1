// Whose workspace this is (rw-p2b-workspace, operator 2026-10-28: the front-end context is per user).
// The workbench's identity seam answers GET /workbench/workspace/whoami; every per-user thing the
// browser keeps - the layout, the theme, the toolbar's state - is keyed by that subject, so two users
// on one browser never see each other's layout. Nothing here decides who the user is.
import { get, W } from "./api";

let subject = "";

export function setOwner(sub: string) {
  subject = sub;
}

export function owner(): string {
  return subject;
}

// the per-user key of a browser-kept value
export function ownedKey(base: string): string {
  return `${base}:${subject || "unknown"}`;
}

export async function loadOwner(): Promise<string> {
  try {
    const w = await get(`${W}/whoami`);
    setOwner(String(w.subject_sub ?? ""));
  } catch {
    setOwner("");
  }
  return subject;
}
