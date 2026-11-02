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
  // round 2 (tester T-F2): every hop's NAME is resolved and every answer judged before the hop is fetched
  // (dohResolver over the same proxy-bound fetch; required - no resolver, no fetch)
  resolve: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Only the workspace's caller key asks for an intake fetch (the workbench's one add path). */
export function mayIntakeFetch(caller: Caller | null): boolean {
  return !!caller && !caller.shared && caller.origin === "workspace";
}

// ── the target (judged before any byte leaves) ───────────────────────────────
// round 3 (reviewer R1): + localdomain, private and ts.net - the search gate's INTERNAL_SUFFIXES (egress/guard.py)
const INTERNAL_SUFFIX = /\.(local|localhost|localdomain|internal|intranet|lan|home|corp|private|docker|arpa|test|invalid|example|ts\.net)$/i;
// round 3 (reviewer R1): only the web's ports, as the gate (its default 80, 443) - a link to :8080, :22 or :5432 is no page
const ALLOWED_PORTS = new Set(["", "80", "443"]);

// round 2 (tester T-F2): the wildcard-DNS services that turn a name into any IP (127.0.0.1.nip.io, *.sslip.io,
// localtest.me ...) are refused by NAME - the search gate's list (search/gateway/src/gateway/egress/guard.py
// WILDCARD_DNS, kept in step by hand)
export const WILDCARD_DNS = [
  "nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me",
  "lacolhost.com", "fbi.com", "readme.localtest.me", "1u.ms", "nip.direct",
];

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
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: "only ports 80 and 443" };
  // round 4 (reviewer N1): EVERY trailing dot goes (x.ts.net.. is x.ts.net to a resolver), and an empty label is no name
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "no host" };
  if (/(^|\.)\.|\.\./.test(host)) return { ok: false, reason: "a name with an empty label" };
  if (host.startsWith("[")) return { ok: false, reason: "an IP literal is not a public page" }; // IPv6 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = v4.slice(1).map(Number);
    if (a.some((n) => n > 255) || v4Blocked(a)) return { ok: false, reason: "a private, loopback or reserved address" };
    return { ok: true, url: u };
  }
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: "a numeric host" };
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIX.test(host)) return { ok: false, reason: "an internal name" };
  if (WILDCARD_DNS.some((w) => host === w || host.endsWith("." + w))) return { ok: false, reason: "a wildcard-DNS name" };
  return { ok: true, url: u };
}

// ── round 2 (tester T-F2): what a name resolves to ───────────────────────────
// IPv6: only global unicast 2000::/3 may be fetched, and inside it not the documentation range, 6to4 or Teredo
// (each can embed or reach an internal IPv4). So loopback, ULA fc00::/7, link-local fe80::/10, mapped ::ffff:0:0/96,
// NAT64 64:ff9b::/96 and every other non-2000::/3 address are refused.
function v6Bytes(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/%.*$/, "");
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  let tail: number[] = [];
  if (v4tail) {
    tail = v4tail[1].split(".").map(Number);
    if (tail.some((n) => n > 255)) return null;
    a = a.slice(0, -v4tail[1].length) + "0:0";
  }
  const parts = a.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (parts.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(fill).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  if (v4tail) bytes.splice(12, 4, ...tail);
  return bytes;
}
function v6Blocked(b: number[]): boolean {
  if ((b[0] & 0xe0) !== 0x20) return true; // not 2000::/3
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
  return false;
}
/** Every resolved address of `host` must be public; an empty or mixed answer refuses the name. */
export function judgeAddresses(host: string, addrs: string[]): { ok: true } | { ok: false; reason: string } {
  if (!addrs.length) return { ok: false, reason: `${host} does not resolve` };
  for (const a of addrs) {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (v4) {
      const n = v4.slice(1).map(Number);
      if (n.some((x) => x > 255) || v4Blocked(n)) return { ok: false, reason: `${host} resolves to a private, loopback or reserved address` };
      continue;
    }
    const b = v6Bytes(a);
    if (!b || v6Blocked(b)) return { ok: false, reason: `${host} resolves to a non-public IPv6 address` };
  }
  return { ok: true };
}

// DNS-over-HTTPS (RFC 8484, wire format), the request itself going through the proxy-bound fetch, so no lookup
// leaves the container outside the tunnel - the search gate's approach (egress/resolve.py). Own code (D9).
export function dnsQuery(name: string, type: number): Uint8Array {
  const id = Math.floor(Math.random() * 65536);
  const labels = name.replace(/\.$/, "").split(".").flatMap((l) => { const b = new TextEncoder().encode(l); return [b.length, ...b]; });
  return new Uint8Array([id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, type >> 8, type & 255, 0, 1]);
}
function dnsAnswers(m: Uint8Array): string[] {
  if (m.length < 12 || (m[3] & 0x0f) !== 0) return []; // NXDOMAIN / SERVFAIL / a short message: no address
  let o = 12;
  const skipName = () => {
    while (o < m.length) {
      const len = m[o];
      if ((len & 0xc0) === 0xc0) { o += 2; return; }
      o += 1 + len;
      if (len === 0) return;
    }
  };
  const qd = (m[4] << 8) | m[5], an = (m[6] << 8) | m[7];
  for (let i = 0; i < qd; i++) { skipName(); o += 4; }
  const out: string[] = [];
  for (let i = 0; i < an && o < m.length; i++) {
    skipName();
    const type = (m[o] << 8) | m[o + 1], rdlen = (m[o + 8] << 8) | m[o + 9];
    const rd = m.subarray(o + 10, o + 10 + rdlen);
    o += 10 + rdlen;
    if (type === 1 && rd.length === 4) out.push([...rd].join("."));
    if (type === 28 && rd.length === 16) {
      const g = Array.from({ length: 8 }, (_, k) => ((rd[2 * k] << 8) | rd[2 * k + 1]).toString(16));
      let best = -1, bestLen = 0;
      for (let k = 0; k < 8;) {
        if (g[k] !== "0") { k++; continue; }
        let e = k;
        while (e < 8 && g[e] === "0") e++;
        if (e - k > bestLen && e - k > 1) { best = k; bestLen = e - k; }
        k = e;
      }
      out.push(best < 0 ? g.join(":") : `${g.slice(0, best).join(":")}::${g.slice(best + bestLen).join(":")}`);
    }
  }
  return out;
}
export function dohResolver(f: (url: string, init?: RequestInit) => Promise<Response>, endpoint: string, timeoutMs = 8_000) {
  const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return async (host: string): Promise<string[]> => {
    const one = async (type: number) => {
      const r = await f(`${endpoint}?dns=${b64u(dnsQuery(host, type))}`, {
        headers: { accept: "application/dns-message" }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual",
      });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`DoH answered ${r.status}`); }
      return dnsAnswers(new Uint8Array(await r.arrayBuffer()));
    };
    const [a, aaaa] = await Promise.all([one(1), one(28)]);
    return [...a, ...aaaa];
  };
}

// The judged answer is NOT pinned (said here because the search gate pins): this fetch goes through an HTTP proxy
// (CONNECT host:port for https, absolute-form for http), and the proxy is handed the NAME and resolves it again.
// Deno's fetch has no resolve / SNI override (Deno.createHttpClient takes a proxy, CA certs and a client cert - no
// address map), and asking for the judged IP instead would break the https name check. The window between the two
// lookups (a rebinding answer) is closed by the egress itself: gluetun refuses private answers (its DNS rebinding
// protection; measured by the tester, findings "Tester t-p5a-intake": a nip.io name pointing at a search-net
// address answered 500 / CONNECT 503 through vpn:8888).
async function resolvedOk(host: string, deps: Required<IntakeDeps>): Promise<void> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return; // a public IPv4 literal (intakeTarget judged it)
  let addrs: string[];
  try {
    addrs = await deps.resolve(host);
  } catch {
    throw new IntakeRefused("refused_target", "refused: the name could not be resolved");
  }
  const j = judgeAddresses(host, addrs);
  if (!j.ok) throw new IntakeRefused("refused_target", `refused: ${j.reason}`);
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
    await resolvedOk(t.url.hostname.toLowerCase().replace(/\.+$/, ""), deps); // round 2: every hop's name, before the hop
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
  if (typeof d.resolve !== "function") throw new Error("intake fetch refused: no resolver (every hop's name is resolved and judged before it is fetched)");
  if (declared && !(INTAKE_CONTENT_TYPES as readonly string[]).includes(declared)) {
    throw new IntakeRefused("unsupported_type", `not a declared content type: ${declared}`);
  }
  const deps: Required<IntakeDeps> = {
    fetch: d.fetch, resolve: d.resolve, timeoutMs: d.timeoutMs ?? INTAKE_DEFAULT_TIMEOUT_MS, maxBytes: d.maxBytes ?? INTAKE_DEFAULT_MAX_BYTES,
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
