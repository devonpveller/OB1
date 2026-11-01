/**
 * rw-p5a-intake - the research service's proxy-bound fetch for a USER'S ADD (POST /intake/fetch).
 *
 * The ingestion model (brainstorm 2026-09-25, agreed 19:59): one fetch path for every inlet - the
 * workspace panel's general add (a link from the title bar), its contextual add (from inside a
 * refinery or its document) and the Open WebUI inlet all reach the workbench's one add path, which
 * asks THIS service to fetch the link. The fetch goes out through the service's FETCH_PROXY_URL client
 * (the Mullvad proxy, http://vpn:8888 in compose) - the same egress as the page fetcher and the
 * scholarly resolver, built by proxiedFetch() and refused otherwise - never openbrain-mcp's fetch.
 *
 * Declared content types (INTAKE_CONTENT_TYPES; public.content_types keys): a web page
 * (web_article), a PDF (pdf: the bytes come back, the workbench's extractor - openbrain-extract, the
 * one the file import uses - turns them into text) and a YouTube transcript (youtube_transcript: the
 * watch page's caption track, fetched through the same proxy). Nothing else is fetched into a source.
 *
 * A user-supplied URL is judged before any byte leaves (intakeTarget): http/https only, no
 * credentials, never an IP literal in a loopback / private / link-local / CGNAT / multicast /
 * reserved range, never a single-label or internal-looking name (the proxy can reach the Docker
 * networks its firewall opens - 172.16.0.0/12 - so "the proxy resolves it" is no guard). Redirects are
 * never followed by the client: each hop (at most INTAKE_MAX_REDIRECTS) is judged again and fetched
 * through the proxy. Every failure is a fixed code (IntakeRefused.code) - an upstream page's text never
 * reaches the caller.
 *
 * Own code (D9): written here, nothing adopted. The YouTube caption read follows the page's own
 * public player-response JSON (`captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`);
 * no library is used.
 */
import { decodeEntities, extractTextFromHtml, extractTitle } from "./lib.ts";
import { isProxiedFetch } from "./scholarly.ts";
import type { Caller } from "./origin.ts";

export const INTAKE_CONTENT_TYPES = ["web_article", "pdf", "youtube_transcript"] as const;
export type IntakeContentType = typeof INTAKE_CONTENT_TYPES[number];

export const INTAKE_MAX_REDIRECTS = 5;
export const INTAKE_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const INTAKE_DEFAULT_TIMEOUT_MS = 30_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

/** A refusal or failure with a fixed code; `message` never carries an upstream body. */
export class IntakeRefused extends Error {
  constructor(public code: string, message: string, public status = 422) {
    super(message);
    this.name = "IntakeRefused";
  }
}

export interface IntakeFetched {
  url: string;
  final_url: string;
  redirects: string[];
  content_type: IntakeContentType;
  mime: string;
  title: string;
  text?: string; // web page, transcript
  bytes_b64?: string; // pdf
  egress: string; // proxiedFetch's egress ("proxy" / the explicit direct)
}

export interface IntakeDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>; // must be built by proxiedFetch()
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Only the workspace's caller key asks for an intake fetch (the workbench's one add path). */
export function mayIntakeFetch(caller: Caller | null): boolean {
  return !!caller && !caller.shared && caller.origin === "workspace";
}

// ── the target (judged before any byte leaves) ───────────────────────────────
const INTERNAL_SUFFIX = /\.(local|localhost|internal|intranet|lan|home|corp|docker|arpa|test|invalid|example)$/i;

function v4Blocked(a: number[]): boolean {
  const [x, y] = a;
  return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 192 && y === 0) ||
    (x === 198 && (y === 18 || y === 19)) || x >= 224;
}

export function intakeTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "only http and https links" };
  if (u.username || u.password) return { ok: false, reason: "a link with credentials" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "no host" };
  if (host.startsWith("[")) return { ok: false, reason: "an IP literal is not a public page" }; // IPv6 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = v4.slice(1).map(Number);
    if (a.some((n) => n > 255) || v4Blocked(a)) return { ok: false, reason: "a private, loopback or reserved address" };
    return { ok: true, url: u };
  }
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: "a numeric host" };
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIX.test(host)) return { ok: false, reason: "an internal name" };
  return { ok: true, url: u };
}

// ── YouTube ──────────────────────────────────────────────────────────────────
const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeId(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (YT_HOSTS.has(host)) {
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(seg[0] ?? "")) id = seg[1] ?? null;
  }
  return id && YT_ID.test(id) ? id : null;
}

// the JSON object assigned after `marker` in a page (brace-matched; strings and escapes respected)
function jsonAfter(page: string, marker: RegExp): unknown {
  const m = marker.exec(page);
  if (!m) return null;
  let i = page.indexOf("{", m.index + m[0].length - 1);
  if (i < 0) return null;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < page.length; i++) {
    const ch = page[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(page.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

interface Track { baseUrl?: string; languageCode?: string; kind?: string }

function pickTrack(tracks: Track[]): Track | null {
  const ok = tracks.filter((t) => {
    if (typeof t.baseUrl !== "string") return false;
    try {
      const u = new URL(t.baseUrl);
      return u.protocol === "https:" && YT_HOSTS.has(u.hostname.toLowerCase()) && u.pathname === "/api/timedtext";
    } catch { return false; }
  });
  const en = (t: Track) => (t.languageCode ?? "").toLowerCase().startsWith("en");
  return ok.find((t) => en(t) && t.kind !== "asr") ?? ok.find(en) ?? ok[0] ?? null;
}

function transcriptText(body: string): string {
  try {
    const j = JSON.parse(body) as { events?: { segs?: { utf8?: string }[] }[] };
    if (Array.isArray(j?.events)) {
      return j.events.flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? "")).join(" ").replace(/\s+/g, " ").trim();
    }
  } catch { /* the XML form */ }
  const parts = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ── the fetch ────────────────────────────────────────────────────────────────
async function getHop(url: string, deps: Required<IntakeDeps>, signal: AbortSignal, accept: string) {
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    const t = intakeTarget(current);
    if (!t.ok) throw new IntakeRefused("refused_target", `refused: ${t.reason}`);
    let r: Response;
    try {
      r = await deps.fetch(t.url.href, { redirect: "manual", signal, headers: { "user-agent": UA, accept, "accept-language": "en" } });
    } catch (e) {
      const timeout = signal.aborted || (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";
      throw new IntakeRefused(timeout ? "timeout" : "network", timeout ? "the page did not answer in time" : "the page could not be reached", 502);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel().catch(() => {});
      if (hop >= deps.maxRedirects) throw new IntakeRefused("too_many_redirects", "too many redirects", 502);
      current = new URL(r.headers.get("location")!, t.url).href;
      redirects.push(current);
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      throw new IntakeRefused("upstream_status", `the page answered ${r.status}`, 502);
    }
    return { r, final: t.url.href, redirects };
  }
}

async function readCapped(r: Response, max: number): Promise<Uint8Array> {
  const len = Number(r.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) {
    await r.body?.cancel().catch(() => {});
    throw new IntakeRefused("too_large", `larger than ${max} bytes`);
  }
  const reader = r.body?.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new IntakeRefused("too_large", `larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Fetch one user-added link through the proxy-bound fetch. `declared` (optional) is the content type
 * the user chose; a link that is not that type is refused (type_mismatch), never coerced.
 */
export async function intakeFetch(url: string, d: IntakeDeps, declared?: IntakeContentType | null): Promise<IntakeFetched> {
  if (!isProxiedFetch(d.fetch)) throw new Error("intake fetch refused: its fetch must be the proxy-bound one built by proxiedFetch() (the FETCH_PROXY_URL egress)");
  if (declared && !(INTAKE_CONTENT_TYPES as readonly string[]).includes(declared)) {
    throw new IntakeRefused("unsupported_type", `not a declared content type: ${declared}`);
  }
  const deps: Required<IntakeDeps> = {
    fetch: d.fetch, timeoutMs: d.timeoutMs ?? INTAKE_DEFAULT_TIMEOUT_MS, maxBytes: d.maxBytes ?? INTAKE_DEFAULT_MAX_BYTES,
    maxRedirects: d.maxRedirects ?? INTAKE_MAX_REDIRECTS,
  };
  const egress = (d.fetch as { egress?: string }).egress ?? "proxy";
  const t = intakeTarget(url);
  if (!t.ok) throw new IntakeRefused("refused_target", `refused: ${t.reason}`);
  const signal = AbortSignal.timeout(deps.timeoutMs);
  const yt = youtubeId(t.url.href);
  if (declared === "youtube_transcript" && !yt) throw new IntakeRefused("type_mismatch", "not a YouTube video link");

  if (yt) {
    if (declared && declared !== "youtube_transcript") throw new IntakeRefused("type_mismatch", `a YouTube video is a youtube_transcript, not ${declared}`);
    const watch = `https://www.youtube.com/watch?v=${yt}`;
    const page = await getHop(watch, deps, signal, "text/html");
    const html = new TextDecoder().decode(await readCapped(page.r, deps.maxBytes));
    const player = jsonAfter(html, /ytInitialPlayerResponse\s*=\s*\{/) as Record<string, any> | null;
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const track = Array.isArray(tracks) ? pickTrack(tracks) : null;
    if (!track) throw new IntakeRefused("no_transcript", "this video has no caption track this service can read");
    const cap = await getHop(`${track.baseUrl}&fmt=json3`, deps, signal, "application/json, text/xml");
    const text = transcriptText(new TextDecoder().decode(await readCapped(cap.r, deps.maxBytes)));
    if (!text) throw new IntakeRefused("no_transcript", "the caption track is empty");
    const title = String(player?.videoDetails?.title ?? "").slice(0, 300) || `YouTube ${yt}`;
    return { url, final_url: watch, redirects: page.redirects, content_type: "youtube_transcript", mime: "text/plain", title, text, egress };
  }

  const got = await getHop(t.url.href, deps, signal, "text/html, application/xhtml+xml, text/plain, application/pdf");
  const mime = (got.r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = await readCapped(got.r, deps.maxBytes);
  const isPdf = mime === "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (isPdf) {
    if (declared && declared !== "pdf") throw new IntakeRefused("type_mismatch", `this link is a PDF, not ${declared}`);
    const name = decodeURIComponent(new URL(got.final).pathname.split("/").pop() || "document.pdf");
    return { url, final_url: got.final, redirects: got.redirects, content_type: "pdf", mime: "application/pdf", title: name.slice(0, 300), bytes_b64: b64(bytes), egress };
  }
  if (!/^(text\/html|application\/xhtml\+xml|text\/plain)$/.test(mime)) throw new IntakeRefused("unsupported_type", `not a web page, PDF or YouTube video (${mime || "no media type"})`);
  if (declared && declared !== "web_article") throw new IntakeRefused("type_mismatch", `this link is a web page, not ${declared}`);
  const body = new TextDecoder().decode(bytes);
  const text = mime === "text/plain" ? body.replace(/\s+/g, " ").trim() : extractTextFromHtml(body);
  if (!text) throw new IntakeRefused("empty_extract", "no readable text on the page");
  const title = (mime === "text/plain" ? "" : extractTitle(body)) || new URL(got.final).hostname;
  return { url, final_url: got.final, redirects: got.redirects, content_type: "web_article", mime, title: title.slice(0, 300), text, egress };
}
