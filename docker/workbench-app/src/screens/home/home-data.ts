// What the Home screen reads. Every read is a GET through lib/api.ts (the one door) for the subject the
// server resolves: no user is named by this code, and nothing read here is written to storage, a cache or
// the console. Each card has its own read and its own state, so one failing read blanks one card, never the
// screen. A read that fails says so (state "failed"); it never shows an invented number.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

export type CardState<T> = { state: "loading" } | { state: "failed" } | { state: "ok"; data: T };

export const SHOW = 5; // rows a card lists; the card title opens the screen with the rest
export const WEEK_MS = 7 * 24 * 3600 * 1000;

export type DocRow = { title: string; path: string; updated: string; refs: number };
export type SessionRow = { id: string; query: string; status: string; waiting: string; branches: number; at: string };
export type PodcastRow = { id: string; title: string; kind: "episode" | "request"; label: string; detail: string; at: string };
export type IdeaRow = { id: string; title: string; status: string; at: string };
export type NewInLibrary = { sources: number; claims: number; capped: boolean };
export type ClaimsWaiting = { count: number; capped: boolean; samples: { id: string; text: string }[] };
export type SearchHit = { kind: string; id: string; title: string; snippet: string };

const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const time = (s: unknown) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : 0; };

// contract/documents lists the signed-in subject's own documents (title, path, updated, outbound links).
export async function readDocuments(): Promise<DocRow[]> {
  const { data } = await api("GET", "/workbench/contract/documents?limit=100");
  return arr(data?.documents)
    .map((d) => ({ title: String(d.title ?? ""), path: String(d.path ?? ""), updated: String(d.updated ?? ""), refs: arr(d.outbound_links).length }))
    .sort((a, b) => time(b.updated) - time(a.updated));
}

// contract/sessions (state=recent: open sessions + those finished in the last day). The read returns every
// user's sessions (research is shared). Each card carries `mine` (the viewer owns it); Home shows only those,
// so nothing of anyone else's appears, not even a count, and an admin sees only their own.
export async function readSessions(): Promise<SessionRow[]> {
  const { data } = await api("GET", "/workbench/contract/sessions?state=recent&limit=50");
  return arr(data?.sessions)
    .filter((s) => s?.mine === true) // the server's owner flag: an admin acting on someone else's or a service job is not "mine"
    .map((s) => ({
      id: String(s.id), query: String(s.query), status: String(s.status ?? ""),
      waiting: String(s.waiting_on?.kind === "nothing" ? "" : s.waiting_on?.detail ?? ""),
      branches: Math.max(0, arr(s.tree).length - 1), at: String(s.finished_at ?? s.started_at ?? s.created_at ?? ""),
    }));
}

// contract/podcasts (the caller's own episodes and the shared renders) + contract/podcasts/requests (the
// caller's own requests). A request that is already an episode is not listed twice.
export async function readPodcasts(): Promise<PodcastRow[]> {
  const [eps, reqs] = await Promise.all([
    api("GET", "/workbench/contract/podcasts?limit=20"),
    api("GET", "/workbench/contract/podcasts/requests?limit=20"),
  ]);
  const episodes = arr(eps.data?.podcasts);
  const have = new Set(episodes.map((e) => String(e.id)));
  const pending: PodcastRow[] = arr(reqs.data?.requests)
    .filter((r) => !(r.episode_id && have.has(String(r.episode_id))) && r.state !== "done")
    .map((r) => ({
      id: "req-" + String(r.id), title: String(r.title ?? ""), kind: "request" as const,
      label: r.state === "failed" ? "failed" : r.state === "rendering" ? "rendering" : "queued",
      detail: r.state === "failed" ? "the render did not finish" : "your request", at: String(r.created_at ?? ""),
    }));
  const done: PodcastRow[] = episodes.map((e) => ({
    id: String(e.id), title: String(e.title ?? ""), kind: "episode" as const, label: "ready",
    detail: [e.mine ? "yours" : e.shared ? "shared" : "", typeof e.seconds === "number" ? Math.max(1, Math.round(e.seconds / 60)) + " min" : ""].filter(Boolean).join(" · "),
    at: String(e.created_at ?? ""),
  }));
  return [...pending, ...done];
}

// contract/ideas: the caller's own ideas, newest first.
export async function readIdeas(): Promise<IdeaRow[]> {
  const { data } = await api("GET", "/workbench/contract/ideas?limit=20");
  return arr(data?.ideas).map((i) => ({ id: String(i.id), title: String(i.title ?? ""), status: String(i.status ?? ""), at: String(i.updated_at ?? "") }));
}

// "New in the library this week": the timeline from seven days ago. A source is new when its first revision
// (revision 1) is in the window; a claim is new on its claim_created event. Only counts: the timeline names
// no source title, and a source that is not active now is not counted.
export async function readNewInLibrary(now = Date.now()): Promise<NewInLibrary> {
  const from = new Date(now - WEEK_MS).toISOString();
  const { data } = await api("GET", "/workbench/contract/timeline?from=" + encodeURIComponent(from) + "&limit=200");
  const ev = arr(data?.events);
  const sources = new Set<string>();
  let claims = 0;
  for (const e of ev) {
    if (e.kind === "source_revision" && e.lifecycle === "active" && /^revision 1 /.test(String(e.summary)) && e.source_id) sources.add(String(e.source_id));
    if (e.kind === "claim_created") claims++;
  }
  return { sources: sources.size, claims, capped: ev.length >= 200 };
}

// "Claims waiting for a second source": active claims, not contradicted, backed by exactly one active
// source and no corroborator (the claims read's own corroborations count).
export async function readClaimsWaiting(): Promise<ClaimsWaiting> {
  const { data } = await api("GET", "/workbench/contract/claims?status=active&limit=200");
  const all = arr(data?.claims);
  const waiting = all.filter((c) => {
    const act = new Set(arr(c.sources).filter((s) => s.lifecycle === "active" && s.edge_type !== "contradicts").map((s) => String(s.source_id)));
    return c.corroborations === 0 && !c.contradicted && !c.contradicted_by_newer && act.size === 1;
  });
  return { count: waiting.length, capped: all.length >= 200, samples: waiting.slice(0, 3).map((c) => ({ id: String(c.id), text: String(c.text ?? "") })) };
}

// The ask box, in phase 0: a library search (pages, claims and sources; never a user document).
export async function runSearch(q: string): Promise<SearchHit[]> {
  const { data } = await api("GET", "/workbench/contract/search?q=" + encodeURIComponent(q) + "&limit=10");
  return arr(data?.results).map((r) => ({ kind: String(r.kind), id: String(r.id), title: String(r.title ?? ""), snippet: String(r.snippet ?? "").replace(/<<\/?HL>>/g, "") }));
}

// One read per card, its own state, a retry.
export function useCard<T>(read: () => Promise<T>): [CardState<T>, () => void] {
  const [s, setS] = useState<CardState<T>>({ state: "loading" });
  const live = useRef(true);
  const run = useCallback(() => {
    setS({ state: "loading" });
    read().then((data) => { if (live.current) setS({ state: "ok", data }); }, () => { if (live.current) setS({ state: "failed" }); });
  }, [read]);
  useEffect(() => { live.current = true; run(); return () => { live.current = false; }; }, [run]);
  return [s, run];
}

// "2 h ago", "yesterday", "3 days ago"
export function ago(iso: string, now = Date.now()): string {
  const t = time(iso);
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " h ago";
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d + " days ago";
}
