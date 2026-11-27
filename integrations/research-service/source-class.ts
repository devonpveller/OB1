/**
 * source-class.ts - is a source a COMMUNITY source? (research-workbench redesign, rwr-research-sources)
 *
 * The operator-confirmed class list (2026-11-27) lives in the `source_classes` registry (seeded by
 * docker/init-research-sources.sql, slot 750); this module is the TS twin of its SQL classifier
 * `source_class_of(url, domain)`. Both are held to one case table (fixtures/source-class-cases.json).
 *
 * A source is classified by its URL ONLY - host, and path for mixed hosts - never by its content: a page
 * cannot talk its way out of its class. Archive, translate and AMP wrappers are classified as the URL they
 * wrap (up to three levels). No match = not community: the D15 model scores it exactly as before.
 *
 * Pure: no I/O. The rows come from the credibility model's one registry read (credibility.ts).
 */

export const COMMUNITY_KINDS = ["qa", "forum", "social", "code_discussion", "self_published"] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];

export interface SourceClassEntry {
  key: string;
  order: number;
  kind: CommunityKind;
  hosts: RegExp[];
  paths: RegExp[] | null;
  keyHost: string | null;
  keySegments: number;
}

export interface SourceClass {
  kind: CommunityKind;
  /** the registry entry that matched */
  entry: string;
  /** the community it belongs to: sources with different keys are independent (the consensus marker) */
  key: string;
}

export class SourceClassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceClassError";
  }
}

/** Build the entries from registry rows (registry 'source_classes'), validating as source_class_def_ok does. */
export function buildSourceClasses(rows: Array<{ registry: string; key: string; definition: Record<string, unknown>; retired_at?: string | null }>): SourceClassEntry[] {
  const out: SourceClassEntry[] = [];
  for (const r of rows) {
    if (r.registry !== "source_classes" || r.retired_at) continue;
    const d = r.definition;
    const kind = d.kind as CommunityKind;
    const bad = (why: string) => new SourceClassError(`source_classes.${r.key}: ${why}`);
    if (!(COMMUNITY_KINDS as readonly string[]).includes(String(kind))) throw bad(`kind ${JSON.stringify(d.kind ?? null)} is not a community kind`);
    if (typeof d.order !== "number" || !Number.isInteger(d.order) || d.order < 0 || d.order > 999999) throw bad("order is not an integer");
    if (!Array.isArray(d.host_patterns) || !d.host_patterns.length) throw bad("host_patterns is empty");
    if (d.path_patterns !== undefined && !Array.isArray(d.path_patterns)) throw bad("path_patterns is not a list");
    if (d.key_host !== undefined && (typeof d.key_host !== "string" || !/^[a-z0-9.-]+$/.test(d.key_host))) throw bad("key_host is not a host");
    if (d.key_segments !== undefined && (typeof d.key_segments !== "number" || ![0, 1, 2, 3].includes(d.key_segments))) throw bad("key_segments is 0-3");
    const re = (s: unknown) => {
      try { return new RegExp(String(s), "i"); } catch { throw bad(`pattern ${JSON.stringify(s)} does not compile`); }
    };
    out.push({
      key: r.key, order: d.order, kind,
      hosts: (d.host_patterns as unknown[]).map(re),
      paths: Array.isArray(d.path_patterns) ? (d.path_patterns as unknown[]).map(re) : null,
      keyHost: typeof d.key_host === "string" ? d.key_host : null,
      keySegments: typeof d.key_segments === "number" ? d.key_segments : 0,
    });
  }
  // the SQL twin orders by (order, key)
  return out.sort((a, b) => (a.order - b.order) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function rawHost(u: string): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/.exec(u);
  if (!m) return null;
  return m[1].toLowerCase().replace(/^[^@]*@/, "").replace(/:[0-9]+$/, "");
}

/** The URL a wrapper stands for (web.archive.org, *.translate.goog, *.cdn.ampproject.org), up to three levels. */
export function unwrapUrl(url: string): string {
  let u = String(url ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const h = rawHost(u) ?? "";
    const rest = u.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+/, "");
    if ((h === "web.archive.org" || h === "archive.org") && /^\/web\/[0-9a-z_*]+\/.+/i.test(rest)) {
      u = /^\/web\/[0-9a-z_*]+\/(.+)$/i.exec(rest)![1];
      if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^https?:\/+/i, "");
    } else if (/\.translate\.goog$/.test(h)) {
      const enc = h.replace(/\.translate\.goog$/, "");
      const dec = enc.replace(/--/g, "\u0001").replace(/-/g, ".").replace(/\u0001/g, "-");
      u = "https://" + dec + (/^(\/[^?#]*)/.exec(rest)?.[1] ?? "/");
    } else if (/\.cdn\.ampproject\.org$/.test(h) && /^\/[cv]\/(s\/)?[^/]+/.test(rest)) {
      u = "https://" + /^\/[cv]\/(?:s\/)?(.+)$/.exec(rest)![1];
    } else {
      break;
    }
  }
  return u;
}

/** The community class of a URL, or null (not community). `domain` is used when the URL names no host. */
export function classifySource(entries: ReadonlyArray<SourceClassEntry>, url: string | null | undefined, domain?: string | null): SourceClass | null {
  const u = unwrapUrl(String(url ?? ""));
  let h = SCHEME.test(u) ? rawHost(u) : null;
  if (h === null) h = (domain ?? "").trim().toLowerCase() || null;
  if (!h) return null;
  h = h.replace(/^[^@]*@/, "").replace(/:[0-9]+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  const path = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)/.exec(u)?.[1] ?? "/";
  for (const e of entries) {
    if (!e.hosts.some((re) => re.test(h!))) continue;
    if (e.paths && !e.paths.some((re) => re.test(path))) continue;
    const segs = path.replace(/^\/+|\/+$/g, "").split("/").filter((s) => s !== "").slice(0, e.keySegments).map((s) => s.toLowerCase());
    return { kind: e.kind, entry: e.key, key: (e.keyHost ?? h) + (segs.length ? "/" + segs.join("/") : "") };
  }
  return null;
}

/** The run's source mode (the start door's `sources`): credible = no community source is fetched or admitted;
 *  community = they are admitted through the same gates; null = the option was not given (every other inlet:
 *  today's behaviour, unchanged). */
export type SourcesMode = "credible" | "community";
export function sourcesModeOf(v: unknown): SourcesMode | null {
  return v === "credible" || v === "community" ? v : null;
}
