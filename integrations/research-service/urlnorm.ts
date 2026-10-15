/**
 * URL normalisation for source-trust decisions (kp-contract, 2026-10-15).
 *
 * ONE implementation of "which host and which path does this URL name", for every
 * check that matches a URL against a host or host/path-prefix entry: the per-job
 * contract (contract.ts) now, the web gate later. Ported from agent-bridge
 * `knowledge_package.normalise_url` / `url_ok` / `_path_escapes_ok` (kp-research
 * .. kp-harden, every tester probe in those rounds); the parity corpus
 * fixtures/url-normalise-corpus.json pins the two to the same verdicts.
 *
 * What it does, on the RAW string (never on a parser's already-folded view):
 *   - printable ASCII only (a real URL's non-ASCII is percent-encoded on the wire);
 *   - http or https, no userinfo (`@` anywhere), no port, no backslash;
 *   - host: lower case, ONE trailing root dot stripped, DNS labels only, a letter
 *     TLD, no numeric label (no IP literal), no punycode (`xn--`), no internal /
 *     wildcard-DNS / reserved name;
 *   - path: refuse raw dot segments (`.`, `..`, `...`), encoded dots / slashes /
 *     backslashes (`%2e` `%2f` `%5c`), `;`, `%25`, a bare `%`, an escaped control or
 *     space byte, and an escaped byte >= 0x80 unless it is strict UTF-8 that NFKC
 *     leaves unchanged and holds no dot/slash look-alike;
 *   - then decode escaped UNRESERVED characters (RFC 3986 6.2.2.2) and remove dot
 *     segments (RFC 3986 5.2.4), and split into path segments.
 * Finally the WHATWG parser (what `fetch` uses) must agree on host and segments,
 * or the URL is refused: a URL two parsers read differently is never matched.
 *
 * The match is at the PARSER level; a server that folds further (NFKC, `%00`
 * trimming, overlong UTF-8) is why those forms are refused outright, but no shape
 * check can know every server. Pure module: no I/O, no imports.
 */

/** The normalised view a host / host+path-prefix entry is matched against. */
export interface NormalisedUrl {
  host: string;
  /** Path segments after the leading `/` (`/a/b/` -> ["a", "b", ""]; `/` -> [""]). */
  segs: string[];
}

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_RE = /^(?:\/[A-Za-z0-9._~%!$&'()*+,;=:\/-]*)?$/;
const BAD_HOST_SUFFIXES = [
  ".local", ".lan", ".internal", ".localdomain", ".corp", ".home", ".intranet",
  ".svc", ".nip.io", ".sslip.io", ".xip.io", ".localtest.me", ".lvh.me",
  ".test", ".example", ".invalid", ".onion", ".arpa",
];
const BAD_HOSTS = new Set(["localhost", "nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me"]);
const ENCODED_DOT_SLASH_RE = /%(?:2e|2f|5c)/i;
const PCT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;
const BAD_PCT_RE = /%(?![0-9A-Fa-f]{2})/;
const PSEUDO_SCHEME_RE = /(?:javascript|vbscript|data|file)\s*:/;
/** Dot / slash / backslash look-alikes a lenient server may fold to `.` `..` `/` `\`. */
const LOOKALIKE_DOT_SLASH = new Set(
  "․‥…︙︰﹒．／＼﹨。",
);
/** scheme://authority path ?query #fragment, split WITHOUT any folding. */
const SPLIT_RE = /^(https?):\/\/([^\/?#]*)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/;

/** Every %XX run decodes to bytes: no byte <= 0x20; bytes >= 0x80 only as strict
 *  UTF-8 (shortest form, no surrogates) that NFKC leaves unchanged and that holds
 *  no dot/slash look-alike. (agent-bridge `_path_escapes_ok`, kp-harden R3.) */
export function pathEscapesOk(path: string): boolean {
  for (const m of path.matchAll(PCT_RUN_RE)) {
    const hex = m[0].replace(/%/g, "");
    const raw = new Uint8Array(hex.length / 2);
    for (let i = 0; i < raw.length; i++) raw[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    if (raw.some((b) => b <= 0x20)) return false;
    if (raw.every((b) => b < 0x80)) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      return false;
    }
    if (text.normalize("NFKC") !== text) return false;
    for (const ch of text) if (LOOKALIKE_DOT_SLASH.has(ch)) return false;
  }
  return true;
}

/** RFC 3986 6.2.2.2: decode escaped UNRESERVED characters only; upper-case the rest. */
export function decodeUnreserved(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (m, h: string) => {
    const ch = String.fromCharCode(parseInt(h, 16));
    return /^[A-Za-z0-9\-._~]$/.test(ch) ? ch : m.toUpperCase();
  });
}

/** RFC 3986 5.2.4 remove_dot_segments. */
export function removeDotSegments(path: string): string {
  let inp = path;
  const out: string[] = [];
  while (inp) {
    if (inp.startsWith("../")) inp = inp.slice(3);
    else if (inp.startsWith("./")) inp = inp.slice(2);
    else if (inp.startsWith("/./")) inp = inp.slice(2);
    else if (inp === "/.") inp = "/";
    else if (inp.startsWith("/../")) { inp = inp.slice(3); out.pop(); }
    else if (inp === "/..") { inp = "/"; out.pop(); }
    else if (inp === "." || inp === "..") inp = "";
    else {
      const i = inp.indexOf("/", 1);
      const seg = i === -1 ? inp : inp.slice(0, i);
      inp = i === -1 ? "" : inp.slice(i);
      out.push(seg);
    }
  }
  return out.join("");
}

const toSegs = (rawPath: string): string[] =>
  (removeDotSegments(decodeUnreserved(rawPath || "/")) || "/").split("/").slice(1);

/** A DNS host the trust checks can name: labels, letter TLD, no IP, no punycode,
 *  nothing internal. `host` is already lower-cased and stripped of one root dot. */
export function hostShapeOk(host: string): boolean {
  if (!host) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((lb) => HOST_LABEL_RE.test(lb))) return false;
  if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1])) return false;
  if (labels.some((lb) => /^[0-9]+$/.test(lb))) return false;
  if (labels.some((lb) => lb.startsWith("xn--"))) return false;
  if (BAD_HOSTS.has(host) || BAD_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/**
 * `{host, segs}` as host / host+path-prefix entries compare them, or null when the
 * URL cannot be named safely (see the module header). Null is a REFUSAL: callers
 * that decide trust treat it as "not shown to be allowed".
 */
export function normaliseUrl(url: unknown): NormalisedUrl | null {
  if (typeof url !== "string" || !url) return null;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return null;           // printable ASCII only (no space/tab/NUL/non-ASCII)
  }
  if (url.includes("@") || url.includes("\\")) return null;
  const m = SPLIT_RE.exec(url);
  if (!m) return null;
  const [, scheme, authority, rawPath] = m;
  if (PSEUDO_SCHEME_RE.test(url.slice(scheme.length + 1).toLowerCase())) return null;
  // Host and port: the port is the text after the FIRST ':' (urlsplit's rule); an
  // empty port names the default one, any other port is refused.
  const colon = authority.indexOf(":");
  let host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  if (colon !== -1 && authority.slice(colon + 1) !== "") return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!hostShapeOk(host)) return null;
  // Path: a plain path, no hidden-segment forms.
  if (!PATH_RE.test(rawPath)) return null;
  if (ENCODED_DOT_SLASH_RE.test(rawPath)) return null;          // %2e %2f %5c
  if (rawPath.includes(";") || rawPath.includes("%25") || BAD_PCT_RE.test(rawPath)) return null;
  if (!pathEscapesOk(rawPath)) return null;
  if (rawPath.split("/").some((seg) => seg !== "" && /^\.+$/.test(seg))) return null;
  const segs = toSegs(rawPath);
  // The fetch parser (WHATWG) must read the same host and the same segments.
  let w: URL;
  try { w = new URL(url); } catch { return null; }
  const wHost = w.hostname.toLowerCase().replace(/\.$/, "");
  if (wHost !== host || w.port !== "" || w.username !== "" || w.password !== "") return null;
  const wSegs = toSegs(w.pathname);
  if (wSegs.length !== segs.length || wSegs.some((s, i) => s !== segs[i])) return null;
  return { host, segs };
}
