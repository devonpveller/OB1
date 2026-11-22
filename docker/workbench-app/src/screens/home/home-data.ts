// What the Home screen reads. Every read is a GET through lib/api.ts (the one door) for the subject the
// server resolves: no user is named by this code, and nothing read here is written to storage, a cache or
// the console. Each card has its own read and its own state, so one failing read blanks one card, never the
// screen. A read that fails says so (state "failed"); it never shows an invented number.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { SEARCH_URL } from "../../components/picker";

export type CardState<T> = { state: "loading" } | { state: "failed" } | { state: "ok"; data: T };

export const SHOW = 5; // rows a card lists; the card title opens the screen with the rest
export const WEEK_MS = 7 * 24 * 3600 * 1000;

export type DocRow = { title: string; path: string; href: string; updated: string; refs: number };
export type SessionRow = { id: string; query: string; status: string; waiting: string; waitKind: string; branches: number; at: string };
export type PodcastRow = { id: string; title: string; kind: "episode" | "request"; label: string; detail: string; at: string };
export type IdeaRow = { id: string; title: string; status: string; at: string };
export type NewInLibrary = { sources: { id: string; title: string }[]; sourcesTotal: number; claimsTotal: number };
export type SessionsRead = { rows: SessionRow[]; capped: boolean };
export const SESSIONS_LIMIT = 200; // the shell asks the same: the read is every user's sessions, newest first
export type ClaimsWaiting = { total: number; samples: { id: string; text: string }[] };
export type SearchHit = { kind: string; id: string; title: string; snippet: string };

const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
// The list a read must hold. A 200 that is not the expected JSON (a login page, a wrong shape) is a FAILURE of
// the card, never an empty list: api() turns unparsable text into {text}, which has no such key.
const listOf = (data: any, key: string): any[] => {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error("unexpected answer: no " + key);
  return data[key];
};
const time = (s: unknown) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : 0; };

// contract/documents lists the signed-in subject's own documents (title, path, updated, outbound links).
export async function readDocuments(): Promise<DocRow[]> {
  const { data } = await api("GET", "/workbench/contract/documents?limit=100");
  return listOf(data, "documents")
    // the row link is built HERE: a path that cannot be encoded fails this read (the card says so), never the render
    .map((d) => ({ title: String(d.title ?? ""), path: String(d.path ?? ""), href: "/documents/" + encodeURIComponent(String(d.path ?? "")), updated: String(d.updated ?? ""), refs: arr(d.outbound_links).length }))
    .sort((a, b) => time(b.updated) - time(a.updated));
}

// contract/sessions (state=recent: open sessions + those finished in the last day). The read returns every
// user's sessions (research is shared). Each card carries `mine` (the viewer owns it); Home shows only those,
// so nothing of anyone else's appears, not even a count, and an admin sees only their own.
export async function readSessions(): Promise<SessionsRead> {
  const { data } = await api("GET", "/workbench/contract/sessions?state=recent&limit=" + SESSIONS_LIMIT);
  const all = listOf(data, "sessions");
  const rows: SessionRow[] = all
    .filter((s) => s?.mine === true) // the server's owner flag: an admin acting on someone else's or a service job is not "mine"
    .map((s) => ({
      id: String(s.id), query: typeof s.query === "string" ? s.query : "", status: String(s.status ?? ""),
      waiting: String(s.waiting_on?.kind === "nothing" ? "" : s.waiting_on?.detail ?? ""), waitKind: String(s.waiting_on?.kind ?? ""),
      branches: Math.max(0, arr(s.tree).length - 1), at: String(s.finished_at ?? s.started_at ?? s.created_at ?? ""),
    }));
  // a full page means older sessions were not read: the card must not claim there is none of mine
  return { rows, capped: all.length >= SESSIONS_LIMIT };
}

// contract/podcasts (the caller's own episodes and the shared renders) + contract/podcasts/requests (the
// caller's own requests). A request that is already an episode is not listed twice.
export async function readPodcasts(now = Date.now()): Promise<PodcastRow[]> {
  const [eps, reqs] = await Promise.all([
    api("GET", "/workbench/contract/podcasts?limit=20"),
    api("GET", "/workbench/contract/podcasts/requests?limit=20"),
  ]);
  const episodes = listOf(eps.data, "podcasts");
  const have = new Set(episodes.map((e) => String(e.id)));
  const pending: PodcastRow[] = listOf(reqs.data, "requests")
    .filter((r) => !(r.episode_id && have.has(String(r.episode_id))) && r.state !== "done" && now - time(r.created_at) < WEEK_MS) // an old request never pushes an episode off the card
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
  return [...done, ...pending]; // ready episodes first, requests in flight after
}

// contract/ideas: the caller's own ideas, newest first.
export async function readIdeas(): Promise<IdeaRow[]> {
  const { data } = await api("GET", "/workbench/contract/ideas?limit=20");
  return listOf(data, "ideas").map((i) => ({ id: String(i.id), title: String(i.title ?? ""), status: String(i.status ?? ""), at: String(i.updated_at ?? "") }));
}

// "New in the library this week": the server's own read (contract/library/recent) - the active sources first added in
// the last seven days with their titles, and the exact totals of new sources and claims over the whole library.
// "Claims waiting for a second source": contract/library/waiting-claims - active, uncontradicted claims backed by
// exactly one active source, counted by the server over EVERY claim. Both are shared-library material only. A
// total that is not a number is a failed read (the cards then say so), never an empty line.
const intOf = (x: unknown, what: string): number => {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) throw new Error("unexpected answer: " + what);
  return x;
};
export async function readNewInLibrary(): Promise<NewInLibrary> {
  const { data } = await api("GET", "/workbench/contract/library/recent?days=7&limit=" + SHOW);
  const sources = listOf(data, "sources").map((s) => ({ id: String(s.id), title: String(s.title ?? "") }));
  return { sources, sourcesTotal: intOf(data.sources_total, "sources_total"), claimsTotal: intOf(data.claims_total, "claims_total") };
}

export async function readClaimsWaiting(): Promise<ClaimsWaiting> {
  const { data } = await api("GET", "/workbench/contract/library/waiting-claims?limit=" + SHOW);
  const claims = listOf(data, "claims");
  return { total: intOf(data.total, "total"), samples: claims.slice(0, 3).map((c) => ({ id: String(c.id), text: String(c.text ?? "") })) };
}

// The ask box, in phase 0: a library search (pages, claims and sources; never a user document).
export async function runSearch(q: string): Promise<SearchHit[]> {
  const { data } = await api("GET", SEARCH_URL + "?q=" + encodeURIComponent(q) + "&limit=10");
  return listOf(data, "results").map((r) => ({ kind: String(r.kind), id: String(r.id), title: String(r.title ?? ""), snippet: String(r.snippet ?? "").replace(/<<\/?HL>>/g, "") }));
}

// One read per card, its own state, a retry.
export const READ_TIMEOUT_MS = 20000;
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

export function useCard<T>(read: () => Promise<T>): [CardState<T>, () => void] {
  const [s, setS] = useState<CardState<T>>({ state: "loading" });
  const live = useRef(true);
  const run = useCallback(() => {
    setS({ state: "loading" });
    withTimeout(read(), READ_TIMEOUT_MS).then((data) => { if (live.current) setS({ state: "ok", data }); }, () => { if (live.current) setS({ state: "failed" }); });
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
