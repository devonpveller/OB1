// What the shell reads about the signed-in person: who they are and the three menu counts. Every read is
// a GET through lib/api.ts for the subject the server resolves (no user is named by this code). Nothing
// read here is written to storage, cached by the page, or logged; a failed read leaves its value unknown
// (the menu then shows no count) rather than inventing a number.
//
// The six reads are independent: each lands in the menu on its own (a slow or failing read never holds
// back the avatar or another count). A count whose read came back FULL (it hit the limit the shell asked
// for) is a lower bound and is shown as "N+". Counts are parsed strictly: an answer of the wrong shape, or
// a number that is not a finite non-negative whole number, is unknown and shows nothing.
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { resetState } from "./state";

export type Count = { n: number; more: boolean };
export type ShellData = {
  loaded: boolean;
  who: { subject: string; name: string } | null;
  defaultSubject: boolean;
  running?: Count;      // MY research sessions queued or running (cards I own, not everyone's)
  failedJobs?: Count;   // intake jobs that offer a retry
  cleanup?: Count;      // suppressed or unlinked sources + reopen candidates
};
export const EMPTY: ShellData = { loaded: false, who: null, defaultSubject: false };
export const POLL_MS = 30000;
// the limits the shell asks for; a list this long may have more behind it
export const SESSIONS_LIMIT = 200;
export const JOBS_LIMIT = 100;
export const CANDIDATES_LIMIT = 500;

export const countText = (c: Count, word: string) => `${c.n}${c.more ? "+" : ""} ${word}`;
const whole = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

const ok = async <T,>(p: Promise<{ data: T }>): Promise<T | undefined> => { try { return (await p).data; } catch { return undefined; } };

// What one read says, as a patch of ShellData (an unreadable answer patches its keys to undefined).
type Patch = Partial<ShellData>;
const KIND_DEFAULT = "default";

export function parseWhoami(who: any): { who: ShellData["who"]; defaultKind: boolean } {
  if (!who || typeof who.subject_sub !== "string") return { who: null, defaultKind: false };
  return { who: { subject: who.subject_sub, name: String(who.name ?? who.subject_sub) }, defaultKind: who.kind === KIND_DEFAULT };
}
export function parseSessions(r: any): Count | undefined {
  if (!r || !Array.isArray(r.sessions)) return undefined;
  if (r.sessions.some((c: any) => typeof c?.mine !== "boolean")) return undefined; // no owner flag: no guess
  return { n: r.sessions.filter((c: any) => c.mine === true).length, more: r.sessions.length >= SESSIONS_LIMIT };
}
export function parseJobs(r: any): Count | undefined {
  if (!r || !Array.isArray(r.jobs)) return undefined;
  const n = r.jobs.filter((j: any) => Array.isArray(j?.detail?.actions) && j.detail.actions.includes("retry")).length;
  return { n, more: r.jobs.length >= JOBS_LIMIT };
}
export function parseCleanup(src: any, cand: any): Count | undefined {
  if (!src || !whole(src.total) || !cand || !Array.isArray(cand.candidates)) return undefined;
  const n = src.total + cand.candidates.filter((c: any) => Array.isArray(c?.evidence) && c.evidence.length > 0).length;
  return whole(n) ? { n, more: cand.candidates.length >= CANDIDATES_LIMIT } : undefined;
}

// Starts the six reads; `emit` gets a patch as each one lands. Resolves with everything, once all have.
export async function loadShellData(emit: (p: Patch) => void = () => {}): Promise<ShellData> {
  const all: ShellData = { loaded: true, who: null, defaultSubject: false };
  const put = (p: Patch) => { Object.assign(all, p); emit(p); };
  let whoamiDefault = false, meKnown = false, meDefault = false;
  const banner = () => put({ defaultSubject: meKnown ? meDefault : whoamiDefault });
  let srcRes: any, candRes: any, srcDone = false, candDone = false;
  const cleanup = () => { if (srcDone && candDone) put({ cleanup: parseCleanup(srcRes, candRes) }); };
  await Promise.allSettled([
    ok(api("GET", "/workbench/workspace/whoami")).then((w) => {
      const p = parseWhoami(w); whoamiDefault = p.defaultKind; put({ who: p.who }); banner();
    }),
    // /auth/me: the identity KIND of this request ("default" = no identity at all, whatever the server's mode)
    ok(api("GET", "/workbench/auth/me")).then((m: any) => {
      meKnown = !!m && typeof m.kind === "string"; meDefault = meKnown && m.kind === KIND_DEFAULT; banner();
    }),
    ok(api("GET", `/workbench/contract/sessions?state=running&limit=${SESSIONS_LIMIT}`)).then((r) => put({ running: parseSessions(r) })),
    ok(api("GET", `/workbench/intake/jobs?limit=${JOBS_LIMIT}`)).then((r) => put({ failedJobs: parseJobs(r) })),
    ok(api("GET", "/workbench/contract/cleanup/sources?limit=1")).then((r) => { srcRes = r; srcDone = true; cleanup(); }),
    ok(api("GET", `/workbench/contract/cleanup/reopen-candidates?limit=${CANDIDATES_LIMIT}`)).then((r) => { candRes = r; candDone = true; cleanup(); }),
  ]);
  return all;
}

// `load` is the shell's one read of "who am I and the menu counts"; a test passes its own (which may
// ignore `emit` and just resolve with everything).
export type Load = (emit: (p: Patch) => void) => Promise<ShellData>;
export function useShellData(load: Load = loadShellData): ShellData {
  const [data, setData] = useState<ShellData>(EMPTY);
  const latest = useRef<ShellData>(EMPTY);
  const lastSubject = useRef<string | null>(null); // survives a read that fails for a moment
  useEffect(() => {
    let live = true;
    // a different person on this page: forget the previous person's document slot and counts at once
    const take = (p: Patch) => {
      if (!live) return;
      const prev = latest.current;
      let next: ShellData = { ...prev, ...p, loaded: true };
      if (p.who) {
        const was = lastSubject.current;
        lastSubject.current = p.who.subject;
        if (was !== null && was !== p.who.subject) {
          resetState();
          next = { ...next, running: undefined, failedJobs: undefined, cleanup: undefined, ...p };
        }
      }
      latest.current = next;
      setData(next);
    };
    const run = () => { load(take).then((d) => { take({ ...d }); }).catch(() => {}); };
    run();
    const t = setInterval(run, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [load]);
  return data;
}
