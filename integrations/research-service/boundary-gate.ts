/**
 * THE GATE of the request boundary (research-workbench rw-boundary-core, plan 09 sections 2-3, PD0a; operator
 * 2026-11-04, D1: "the model proposes, the pure token gate decides; the title template is the fallback").
 *
 * PURE: no I/O, no clock, no randomness, no model. `gate()` is a function of (candidate, evidence snapshot, deny
 * set, lexicon, personal fields) only, so a recorded verdict re-runs to the same verdict (boundary-gate.test.ts).
 *
 * A candidate question is accepted only if ALL hold (section 3.2):
 *   - every token (NFKC, lowercase, [\p{L}\p{N}]+ - the tokeniser prompt-private.ts uses) is in the allow set
 *     FRAME u LEXICON u EVIDENCE, and none is in DENY (DENY always wins);
 *   - every token holding a digit appears in EVIDENCE (numbers are never lexicon words);
 *   - no run of COPY_RUN (4) consecutive tokens is copied from a personal field, unless the same run is on a fetched
 *     public page (a page's own phrase);
 *   - 3-60 tokens and at most 300 characters.
 * EVIDENCE = every token of the public pages fetched for this request (title + text). ENTITIES (shared entity
 * names) are NOT used until PD1 has cleaned them (decision D8).
 * DENY = the owner's identity tokens, every id-shaped token in the item (hex runs >= 8, a token >= 8 long mixing
 * letters and digits: Gmail ids, UUID groups, tracking ids) and every token of a URL in the item that is not one of
 * the request's public links.
 *
 * Also here, because they decide what may leave: link canonicalisation and the private-host list (section 2.3).
 */
import { LEXICON_COUNT, LEXICON_SHA256, LEXICON_SOURCE, LEXICON_WORDS } from "./boundary-lexicon.ts";

/** Bumped on any change to the rules here; every verdict records it. */
// pd0c-1 (rw-boundary-digest round 2): the private-host list gained the meeting / invite / share-link rule (shareLink)
export const BOUNDARY_VERSION = "pd0c-1";
export const COPY_RUN = 4;
export const MIN_TOKENS = 3;
export const MAX_TOKENS = 60;
export const MAX_CHARS = 300;
export const MAX_TOPIC_CHARS = 80;

/** Round 2 (tester TF1): THE string the gate judges and the boundary stores - NFKC, then every Default_Ignorable_Code_Point
 *  and every format character (Cf: soft hyphen U+00AD, zero-width U+200B-U+200D, word joiner U+2060, BOM U+FEFF,
 *  bidi marks ...) removed, BEFORE tokenising, so an invisible character can neither split a token past the gate nor
 *  survive into a shared row. NFKC runs again after the strip (a removal can join two halves NFKC composes). */
export function cleanText(s: string): string {
  return String(s ?? "").normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "").normalize("NFKC");
}

export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const m of cleanText(s).toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) out.push(m[0]);
  return out;
}

/** Round 2 (tester TF7): DENY matching normalises plurals - a token and a denied token match when their STEMS match:
 *  a trailing "es" after s / x / z / ch / sh, else a trailing "s" (not "ss"), is dropped from words of 4+ letters.
 *  Possessives need nothing more ("Dana's" is the tokens dana + s). Hyphen-, space- or punctuation-joined variants
 *  ("Quill-feather", "Quill feather") are caught by joining 2 or 3 consecutive tokens and matching that too. */
export function stem(w: string): string {
  if (w.length < 4) return w;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
export const JOIN_MAX = 3;

/** The indices of `t` that a DENY entry matches: a token itself, or a run of 2-3 tokens whose concatenation does,
 *  each compared by stem. */
export function deniedIndices(t: string[], deny: ReadonlySet<string>): Set<number> {
  const stems = new Set<string>();
  for (const d of deny) stems.add(stem(d));
  const hit = new Set<number>();
  for (let i = 0; i < t.length; i++) {
    let joined = "";
    for (let n = 0; n < JOIN_MAX && i + n < t.length; n++) {
      joined += t[i + n];
      if (stems.has(stem(joined)) || deny.has(joined)) for (let k = i; k <= i + n; k++) hit.add(k);
    }
  }
  return hit;
}

/** The frame vocabulary: question and research words a public question may always use (checked in, versioned with
 *  BOUNDARY_VERSION). Every one is also an ordinary common word: none names anything. */
export const FRAME: ReadonlySet<string> = new Set((`
a about above according across after against all also among an analysis and any applied approach approaches are
area areas as aspects assess assessed at available based be been before benefit benefits best between both but by
can case cases cause caused causes change changes characteristics common compare compared comparison conditions
consensus consequences considerations context cost costs could current currently data debate define defined
definition describe described design designs details develop developed development difference differences different
do does done during effect effective effectiveness effects efficacy elsewhere empirical evaluate evaluated evaluation
evidence example examples exist existing experience experiences explain explained explanation extent factors
far findings for found framework frameworks from function functions future general generally given guidance guide
guidelines had has have history how however impact impacts implementation implications important improve in include
includes including influence information into introduction is issue issues it its key kind kinds known latest
lessons less limitations limits literature long main major may mean meaning measure measured measures mechanism
mechanisms method methods might model models more most much need needed new not notable of on one or options other
outcome outcomes over overview particular performance perspective perspectives possible practice practices present
problem problems process processes properties public publicly published purpose quality question questions range
rate rates reason reasons recent recently relate related relationship relationships relative relevant report reported
reports research researched researchers result results review reviews risk risks role says scope several short should
show shown shows similar since so some source sources standard standards state status studies study subject such
summary support supported suggest survey systematic than that the their them then theory there these they this those
through time to today topic toward trade trends trial trials type types typical typically under understand
understanding understood use used uses using value various versus view views was way ways were what when where whether
which while who why widely will with within without work works would year years
`).trim().split(/\s+/));

export interface Lexicon { version: string; source: string; count: number; words: ReadonlySet<string> }

/** The lexicon's word list, LF-joined: a checkout that turned the module's line ends into CRLF (git autocrlf on
 *  Windows) must change neither a word nor the hash. A template literal's cooked value already turns CRLF into LF
 *  (measured: a CRLF copy of boundary-lexicon.ts passes boundary-gate.test.ts); this is the belt to those braces. */
export const lexiconText = (): string => LEXICON_WORDS.replace(/\r/g, "");

let lexiconCache: Lexicon | null = null;
/** The checked-in lexicon (boundary-lexicon.ts). Its version is the sha256 of its words (verified by the tests). */
export function lexicon(): Lexicon {
  if (!lexiconCache) {
    lexiconCache = { version: LEXICON_SHA256, source: LEXICON_SOURCE, count: LEXICON_COUNT, words: new Set(lexiconText().split("\n")) };
  }
  return lexiconCache;
}

export interface PublicPage { url: string; title: string; text: string; sha256: string }
export interface Evidence { pages: PublicPage[] }

export type GateCode = "length" | "denied_token" | "token_not_allowed" | "number_not_in_evidence" | "personal_copy";
export type GateResult = { ok: true } | { ok: false; code: GateCode; tokens: string[] };

const hasDigit = (t: string) => /\p{N}/u.test(t);

function grams(seq: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= seq.length; i++) out.add(seq.slice(i, i + n).join(" "));
  return out;
}

/** The evidence as the gate reads it: every token, and every COPY_RUN-gram, of each page's title and text. */
export function evidenceTokens(ev: Evidence): { set: Set<string>; runs: Set<string> } {
  const set = new Set<string>();
  const runs = new Set<string>();
  for (const p of ev.pages) {
    for (const part of [p.title, p.text]) {
      const t = tokens(part);
      for (const w of t) set.add(w);
      for (const g of grams(t, COPY_RUN)) runs.add(g);
    }
  }
  return { set, runs };
}

/** THE GATE (pure). `personal` = the item's personal field texts (titles, bodies, subjects, replies...). */
export function gate(candidate: string, ev: Evidence, deny: ReadonlySet<string>, lex: Lexicon, personal: string[]): GateResult {
  const c = cleanText(candidate).trim();
  const t = tokens(c);
  if (t.length < MIN_TOKENS || t.length > MAX_TOKENS || c.length > MAX_CHARS) return { ok: false, code: "length", tokens: [] };
  const e = evidenceTokens(ev);
  const di = deniedIndices(t, deny);
  const denied = t.filter((_w, i) => di.has(i));
  if (denied.length) return { ok: false, code: "denied_token", tokens: [...new Set(denied)] };
  const offList = t.filter((w) => !hasDigit(w) && !FRAME.has(w) && !lex.words.has(w) && !e.set.has(w));
  if (offList.length) return { ok: false, code: "token_not_allowed", tokens: [...new Set(offList)] };
  const numbers = t.filter((w) => hasDigit(w) && !e.set.has(w));
  if (numbers.length) return { ok: false, code: "number_not_in_evidence", tokens: [...new Set(numbers)] };
  const mine = new Set<string>();
  for (const f of personal) for (const g of grams(tokens(f), COPY_RUN)) mine.add(g);
  const copied = [...grams(t, COPY_RUN)].filter((g) => mine.has(g) && !e.runs.has(g));
  if (copied.length) return { ok: false, code: "personal_copy", tokens: [...new Set(copied.flatMap((g) => g.split(" ")))] };
  return { ok: true };
}

// ── DENY ─────────────────────────────────────────────────────────────────────────────────────
/** An id-shaped token: a hex run of 8 or more, or a token of 8 or more mixing letters and digits. */
export function idShaped(t: string): boolean {
  return /^[0-9a-f]{8,}$/.test(t) || (t.length >= 8 && /\p{N}/u.test(t) && /\p{L}/u.test(t));
}

export interface DenyInput {
  ownerSub: string;
  identity: string[];                 // the owner's identity strings (display name, email, usernames)
  fields: Record<string, string>;     // the personal fields (their id-shaped tokens)
  links: string[];                    // every URL in the item
  publicLinks: string[];              // the request's public links (canonical): their tokens are not denied
  id?: string;                        // the private inlet id
}

export function denySet(d: DenyInput): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => { for (const w of tokens(s)) out.add(w); };
  add(d.ownerSub);
  for (const s of d.identity) {
    add(s);
    // an email's local part and domain arrive as tokens already; a display name's parts too
  }
  if (d.id) add(d.id);
  for (const f of Object.values(d.fields)) for (const w of tokens(f)) if (idShaped(w)) out.add(w);
  const pub = new Set(d.publicLinks);
  for (const l of d.links) {
    const canon = canonicalLink(l);
    if ("url" in canon && pub.has(canon.url)) {
      // a public link's own tokens are public, but its query string and fragment were not part of it
      try {
        const u = new URL(l);
        add(u.search);
        add(u.hash);
        add(u.username);
        add(u.password);
      } catch { /* */ }
      continue;
    }
    add(l);
  }
  return out;
}

// ── links ────────────────────────────────────────────────────────────────────────────────────
export type LinkRefusal = "not_a_url" | "scheme" | "userinfo" | "private_host" | "token_path" | "id_in_path" | "identity_in_path";

/** decodeURIComponent that never throws (round 2, TF5): null for a malformed escape. */
export function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** Round 2 (tester TF3): a public link's PATH goes through the same rules as a question's tokens. The link is refused
 *  when any token of its decoded, cleaned path is id-shaped (`idShaped`: a hex run of 8 or more characters, or a token
 *  of 8 or more characters mixing letters and digits - the threshold, whatever the segment's length) or matches DENY
 *  (identity, the item's own ids, by stem and by joined runs). The host's labels are judged by the id-shaped rule only
 *  (the name is resolved before any fetch, so it must not carry an id; an identity rule there would refuse every host
 *  of the owner's own email domain - "gmail com"); privateHost and the resolver judge where it points. */
export function linkPathRefusal(url: string, deny: ReadonlySet<string>): LinkRefusal | null {
  let u: URL;
  try { u = new URL(url); } catch { return "not_a_url"; }
  const decoded = u.pathname.split("/").map(safeDecode);
  if (decoded.some((x) => x === null)) return "token_path";
  // the host's labels too: a name is looked up (DNS) before any fetch, so an id or identity in it must not leave either
  const t = tokens(decoded.join(" "));
  if (t.some(idShaped) || tokens(u.hostname).some(idShaped)) return "id_in_path";
  if (deniedIndices(t, deny).size) return "identity_in_path";
  return null;
}

/** The private-host list (versioned with BOUNDARY_VERSION): a URL here is never public. */
const PRIVATE_HOST_SUFFIXES = [".ts.net", ".local", ".internal", ".lan", ".home.arpa", ".localhost", ".openbrain", ".ai-stack"];
const GOOGLE_PRIVATE_PATHS = /^\/(mail|calendar|drive|docs|document|spreadsheets|presentation|forms|u\/\d+)(\/|$)/i;
const TOKEN_SEGMENT = /^(unsubscribe|unsub|manage|preferences?|email-preferences|subscription|subscriptions|optout|opt-out|view-in-browser|webversion|web-version|viewonline|track|click)$/i;

function ipv4Private(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Round 2 (tester TF6): the wildcard-DNS services that turn a name into any address (127.0.0.1.nip.io ...) - the same
 *  list as intake-fetch.ts WILDCARD_DNS (boundary-gate.test.ts checks they agree; this module imports nothing but the
 *  lexicon). The names are refused here; what any OTHER name resolves to is judged at fetch time (boundary.ts). */
export const WILDCARD_DNS = [
  "nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me",
  "lacolhost.com", "fbi.com", "readme.localtest.me", "1u.ms", "nip.direct",
];

export function privateHost(u: URL): boolean {
  const h = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (WILDCARD_DNS.some((w) => h === w || h.endsWith("." + w))) return true;
  if (/^[0-9.]+$/.test(h) && !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) return true;   // a numeric host form
  if (!h.includes(".")) return true;                     // localhost, a container name, a bare host
  if (h.startsWith("[")) return true;                    // any IPv6 literal: never a public link here
  if (ipv4Private(h)) return true;
  if (h === "mail.google.com" || h.startsWith("accounts.") || h === "myaccount.google.com") return true;
  if ((h === "google.com" || h.endsWith(".google.com")) && GOOGLE_PRIVATE_PATHS.test(u.pathname)) return true;
  if (shareLink(h, u.pathname)) return true;
  return PRIVATE_HOST_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

// ── rw-boundary-digest round 2 (tester F1): meeting, invite and share links ────────────────────────
// A link that opens a MEETING, a shared FILE or a personal page is the user's, not a public page: its code (a Meet
// code is letters and hyphens - not id-shaped) would become a shared job, a shared sources.url and a second user's
// read. Rules first, lists for the hosts no rule reaches. Versioned with BOUNDARY_VERSION; a URL here is never public.
/** Hosts whose EVERY page is the user's (meeting rooms, file drops, personal pages, booking pages, workspace apps). */
const SHARE_HOSTS = [
  "meet.google.com", "drive.google.com", "docs.google.com", "sites.google.com", "calendar.google.com", "chat.google.com",
  "hangouts.google.com", "keep.google.com", "photos.google.com", "contacts.google.com", "classroom.google.com",
  "jamboard.google.com", "script.google.com", "lookerstudio.google.com", "datastudio.google.com", "groups.google.com",
  "forms.gle", "goo.gl", "photos.app.goo.gl", "meet.goto.com", "global.gotomeeting.com", "app.gotomeeting.com", "gotomeet.me",
  "whereby.com", "meet.jit.si", "teams.live.com", "chime.aws", "bluejeans.com",
  "dl.dropboxusercontent.com", "1drv.ms", "onedrive.live.com", "we.tl", "wetransfer.com", "mega.nz", "drive.proton.me",
  "docsend.com", "icloud.com", "www.icloud.com", "forms.office.com", "forms.microsoft.com", "calendly.com", "cal.com",
  "notion.site", "docs.zoho.com", "docs.zoho.eu", "workdrive.zoho.com", "workdrive.zoho.eu", "sharepoint.com",
];
/** Host suffixes whose every page is the user's (tenant subdomains). */
const SHARE_SUFFIXES = [".sharepoint.com", ".notion.site", ".slack.com", ".my.webex.com", ".whereby.com"];
/** host (suffix match) + a path that is a meeting / share / file / invite. */
const SHARE_PATHS: Array<[string, RegExp]> = [
  ["zoom.us", /^\/(j|my|w|s|wc|rec|meeting|webinar)\//i], ["zoom.com", /^\/(j|my|w|s|wc|rec|meeting|webinar)\//i],
  ["zoomgov.com", /^\/(j|my|w|s|wc|rec)\//i],
  ["teams.microsoft.com", /^\/(l\/(meetup-join|meetup|chat|channel|team|file|message|entity)|meet)\b/i],
  ["webex.com", /^\/(meet|join|wbxmjs|m|webappng|mw3300)\b/i],
  ["gotomeeting.com", /^\/(join|meeting)\b/i], ["goto.com", /^\/(join|meeting)\b/i],
  ["dropbox.com", /^\/(s|scl|sh|t|l|request|transfer|preview)\//i], ["box.com", /^\/(s|file|folder|v|notes)\//i],
  ["airtable.com", /^\/(shr|app|embed|invite)/i], ["notion.so", /^\/./], ["figma.com", /^\/(file|design|board|proto|deck|slides)\//i],
  ["miro.com", /^\/(app|welcomeonboard)\//i], ["loom.com", /^\/(share|embed)\//i], ["trello.com", /^\/(b|c|invite)\//i],
  ["discord.gg", /^\/./], ["discord.com", /^\/invite\//i], ["zoho.com", /^\/(file|folder|meeting|meet)\b/i],
  ["office.com", /^\/(r|x|w|p|o|e)\//i], ["live.com", /^\/(redir|embed|edit)\b/i],
];
/** A path segment that hands out access (the rule for the hosts no list reaches): a share / invite / join segment
 *  followed by another segment, or a Meet-shaped code (xxx-xxxx-xxx). */
const SHARE_SEGMENT = /^(share|shared|sharing|invite|invitation|join|meeting|meetings|meetup-join)$/i;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

export function shareLink(host: string, path: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  const bare = h.replace(/^www\./, "");
  if (SHARE_HOSTS.includes(h) || SHARE_HOSTS.includes(bare)) return true;
  if (SHARE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // a meeting host by its first label (meet.<anything>, meeting(s).<anything>, join.<anything>)
  if (/^(meet|meeting|meetings|join|video|conference|conf)\./.test(bare)) return true;
  for (const [suffix, rx] of SHARE_PATHS) if ((bare === suffix || bare.endsWith("." + suffix)) && rx.test(path)) return true;
  // Google's own share shapes on any google host: /file/, /open (?id= is dropped with the query), /folders/, /share
  if ((bare === "google.com" || bare.endsWith(".google.com")) && /^\/(file|open|folders|uc|share|a\/[^/]+\/(file|open))(\/|$)/i.test(path)) return true;
  const segs = path.split("/").filter(Boolean).map((x) => safeDecode(x) ?? x);
  for (let i = 0; i < segs.length; i++) {
    if (MEET_CODE.test(segs[i])) return true;
    if (SHARE_SEGMENT.test(segs[i]) && i + 1 < segs.length) return true;
    if (/\.ics$/i.test(segs[i])) return true;   // a calendar file
  }
  return false;
}

/** A path that carries a per-recipient token (unsubscribe, preferences, view-in-browser, `/p/<token>`, a segment
 *  of more than 40 hex / base64 characters). */
export function tokenPath(u: URL): boolean {
  const segs = u.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const s = safeDecode(segs[i]);
    if (s === null) return true;   // round 2 (TF5): a malformed percent-encoding is no public link
    if (TOKEN_SEGMENT.test(s)) return true;
    if (s.toLowerCase() === "p" && i + 1 < segs.length) return true;
    if (s.length > 40 && /^[A-Za-z0-9+/=_-]+$/.test(s)) return true;
  }
  return false;
}

/** Canonical public form of a link: http(s), no userinfo, no query string, no fragment, lowercase host, no default
 *  port. A refusal names why. The query string is DROPPED: a link that only works with it is not public (its fetch
 *  without the query then fails and the link is dropped). */
export function canonicalLink(raw: string): { url: string } | { refused: LinkRefusal } {
  let u: URL;
  try { u = new URL(cleanText(String(raw ?? "")).trim()); } catch { return { refused: "not_a_url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { refused: "scheme" };
  if (u.username || u.password) return { refused: "userinfo" };
  if (privateHost(u)) return { refused: "private_host" };
  if (tokenPath(u)) return { refused: "token_path" };
  const port = u.port && !((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) ? `:${u.port}` : "";
  return { url: `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname || "/"}` };
}

// ── the fallback ─────────────────────────────────────────────────────────────────────────────
/** The template from a fetched page's title with DENY tokens removed (section 3.2 step 4); null when nothing is left. */
export function templateQuestion(title: string, deny: ReadonlySet<string>): { question: string; topic: string } | null {
  const kept: string[] = [];
  const frameLen = tokens("What is publicly known about").length;
  const tt = tokens(title);
  const di = deniedIndices(tt, deny);
  for (const [i, w] of tt.entries()) {
    if (di.has(i)) continue;
    if (kept.length + frameLen >= MAX_TOKENS) break;
    const next = [...kept, w].join(" ");
    if (`What is publicly known about "${next}"?`.length > MAX_CHARS) break;
    kept.push(w);
  }
  if (!kept.length) return null;
  const t = kept.join(" ");
  return { question: `What is publicly known about "${t}"?`, topic: t.slice(0, MAX_TOPIC_CHARS).trim() };
}

/** A topic label for an accepted model question: its own (gate-passed) tokens, at most 80 characters. */
export function topicOf(question: string): string {
  const t = tokens(question).join(" ");
  return t.length <= MAX_TOPIC_CHARS ? t : t.slice(0, MAX_TOPIC_CHARS).replace(/\s+\S*$/, "");
}
