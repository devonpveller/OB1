// The one read of the person's settings list (GET /workbench/settings), shared by everything the shell starts at once (the
// account state in lib/state.ts and the look in lib/appearance.ts): while one read is in flight, a second caller gets the
// SAME answer instead of sending another request. A read that has finished is never reused.
// A different person on the page forgets the read in flight (forgetSettingsRead), so the next caller always asks again and
// the earlier person's answer can only reach the consumers that were already waiting for it (each drops it by its own epoch).
import { api } from "./api";

export type SettingsList = { admin?: boolean; settings?: unknown[] };
let inflight: Promise<SettingsList> | null = null;

export function readSettings(): Promise<SettingsList> {
  if (inflight) return inflight;
  const p: Promise<SettingsList> = api<SettingsList>("GET", "/workbench/settings").then((r) => r.data);
  inflight = p;
  const done = () => { if (inflight === p) inflight = null; };
  p.then(done, done);
  return p;
}
export function forgetSettingsRead() { inflight = null; }
