// What the shell reads about the signed-in person: who they are and the three menu counts. Every read is
// a GET through lib/api.ts for the subject the server resolves (no user is named by this code). Nothing
// read here is written to storage, cached by the page, or logged; a failed read leaves its value unknown
// (the menu then shows no count) rather than inventing a number.
import { useEffect, useState } from "react";
import { api } from "./api";

export type ShellData = {
  loaded: boolean;
  who: { subject: string; name: string } | null;
  defaultSubject: boolean;
  running?: number;      // research sessions queued or running
  failedJobs?: number;   // intake jobs that offer a retry
  cleanup?: number;      // suppressed or unlinked sources + reopen candidates
};
export const EMPTY: ShellData = { loaded: false, who: null, defaultSubject: false };
export const POLL_MS = 30000;

const ok = async <T,>(p: Promise<{ data: T }>): Promise<T | undefined> => { try { return (await p).data; } catch { return undefined; } };

export async function loadShellData(): Promise<ShellData> {
  const [who, me, ses, jobs, src, cand] = await Promise.all([
    ok(api("GET", "/workbench/workspace/whoami")),
    ok(api("GET", "/workbench/auth/me")),
    ok(api("GET", "/workbench/contract/sessions?state=running&limit=200")),
    ok(api("GET", "/workbench/intake/jobs?limit=100")),
    ok(api("GET", "/workbench/contract/cleanup/sources?limit=1")),
    ok(api("GET", "/workbench/contract/cleanup/reopen-candidates?limit=500")),
  ]);
  const d: ShellData = { loaded: true, who: null, defaultSubject: false };
  if (who && typeof who.subject_sub === "string") d.who = { subject: who.subject_sub, name: String(who.name ?? who.subject_sub) };
  // /auth/me names the sign-in mode: "default" = the shipped single identity, no sign-in
  if (me && me.mode === "default") d.defaultSubject = true;
  if (ses && Array.isArray(ses.sessions)) d.running = ses.sessions.length;
  if (jobs && Array.isArray(jobs.jobs)) d.failedJobs = jobs.jobs.filter((j: any) => j?.detail?.actions?.includes?.("retry")).length;
  if (src && typeof src.total === "number" && cand && Array.isArray(cand.candidates)) {
    d.cleanup = src.total + cand.candidates.filter((c: any) => c?.evidence?.length).length;
  }
  return d;
}

export function useShellData(load: () => Promise<ShellData> = loadShellData): ShellData {
  const [data, setData] = useState<ShellData>(EMPTY);
  useEffect(() => {
    let live = true;
    const run = () => { load().then((d) => { if (live) setData(d); }).catch(() => {}); };
    run();
    const t = setInterval(run, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [load]);
  return data;
}
