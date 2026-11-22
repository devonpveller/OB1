// The picker's data model and its pure filter / count / sort logic (rwr-picker). No React, no I/O: unit-tested.
// ONE model for every list search in the app: the Ctrl+K overlay (rwr-search) is built on this same file and on
// search.ts, so the picker and the overlay cannot drift.
//
// What the back end gives today (the contract search route): kind, id, title, snippet,
// state, lifecycle, page_class. Everything else a picker row can show (topics, date, quality, cited-by, author,
// private) is an OPTIONAL field: a filter on a field no result carries is not offered (see missingFacets).

export type PickerItem = {
  kind: string; // registry node_kinds today: page | source | claim | document (+ thought when the own-thoughts scope lands)
  id: string;
  title: string;
  snippet: string; // may carry the search route's inert match markers (rendered as text + <mark>, never HTML)
  state: string | null;
  lifecycle: string | null;
  type: string | null; // page_class today ("entity", ...)
  // optional: shown and filterable only when the search returns them
  author?: string | null;
  topics?: string[];
  date?: string | null; // ISO date or datetime
  quality?: "High" | "Medium" | "Low" | null;
  citedBy?: number | null; // how many of the CALLER's own documents cite it (never anyone else's)
  private?: boolean; // true = visible only to its owner (own thoughts, held sources)
};

export type PickerScope =
  | { kind: "library" }
  | { kind: "document"; label: string; topics: string[]; refineryId?: string | null }
  | { kind: "library+mine" };

export const keyOf = (i: Pick<PickerItem, "kind" | "id">) => `${i.kind}:${i.id}`;

export const KIND_LABEL: Record<string, string> = {
  page: "topic page", source: "source", claim: "claim", document: "document", thought: "thought", run: "research run", topic: "topic",
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

// ---- filters ----
export type DateBucket = "any" | "d30" | "year" | "older";
export type QualityFloor = "any" | "medium" | "high";
export type Visibility = "all" | "shared" | "private";
export type SortKey = "match" | "title" | "newest" | "cited";

export type Filters = {
  kinds: string[]; // empty = all; else any of
  types: string[];
  states: string[];
  topics: string[]; // any of
  date: DateBucket;
  quality: QualityFloor;
  visibility: Visibility;
  hideLinked: boolean;
};
export const NO_FILTERS: Filters = { kinds: [], types: [], states: [], topics: [], date: "any", quality: "any", visibility: "all", hideLinked: false };

export function anyFilter(f: Filters): boolean {
  return f.kinds.length > 0 || f.types.length > 0 || f.states.length > 0 || f.topics.length > 0 || f.date !== "any" || f.quality !== "any" || f.visibility !== "all" || f.hideLinked;
}

export type Ctx = { now: number; linked?: ReadonlySet<string> };

const DAY = 86_400_000;
function dateMs(d: string | null | undefined): number | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : t;
}
export function inBucket(item: PickerItem, b: DateBucket, now: number): boolean {
  if (b === "any") return true;
  const t = dateMs(item.date);
  if (t === null) return false;
  if (b === "d30") return t >= now - 30 * DAY;
  const start = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  return b === "year" ? t >= start : t < start;
}
const RANK = { High: 2, Medium: 1, Low: 0 } as const;
const qualityOk = (i: PickerItem, q: QualityFloor) => q === "any" || (i.quality != null && RANK[i.quality] >= (q === "high" ? 2 : 1));

export type FacetKey = "kinds" | "types" | "states" | "topics" | "date" | "quality" | "visibility" | "hideLinked";

// The per-facet predicate. `skip` leaves one facet out, which is how a facet's own live counts are made
// (each option's count = what you would get by choosing it, given every OTHER filter).
function passes(i: PickerItem, f: Filters, c: Ctx, skip?: FacetKey): boolean {
  if (skip !== "kinds" && f.kinds.length && !f.kinds.includes(i.kind)) return false;
  if (skip !== "types" && f.types.length && !(i.type && f.types.includes(i.type))) return false;
  if (skip !== "states" && f.states.length && !(i.lifecycle && f.states.includes(i.lifecycle))) return false;
  if (skip !== "topics" && f.topics.length && !(i.topics ?? []).some((t) => f.topics.includes(t))) return false;
  if (skip !== "date" && !inBucket(i, f.date, c.now)) return false;
  if (skip !== "quality" && !qualityOk(i, f.quality)) return false;
  if (skip !== "visibility" && f.visibility !== "all" && (f.visibility === "private") !== !!i.private) return false;
  if (skip !== "hideLinked" && f.hideLinked && c.linked?.has(keyOf(i))) return false;
  return true;
}

// The scope's own narrowing, only where the result carries topics (the back end cannot narrow by topic yet).
export function inScope(i: PickerItem, scope: PickerScope): boolean {
  if (scope.kind !== "document" || scope.topics.length === 0) return true;
  if (!i.topics || i.topics.length === 0) return true; // no topic data: not dropped (degrades to the library)
  const want = scope.topics.map((t) => t.toLowerCase());
  return i.topics.some((t) => want.includes(t.toLowerCase()));
}

export function applyFilters(items: PickerItem[], f: Filters, c: Ctx): PickerItem[] {
  return items.filter((i) => passes(i, f, c));
}

export type Option = { value: string; label: string; count: number };
export function countBy(items: PickerItem[], f: Filters, c: Ctx, facet: FacetKey, values: (i: PickerItem) => string[]): Option[] {
  const base = items.filter((i) => passes(i, f, c, facet));
  const m = new Map<string, number>();
  for (const i of base) for (const v of new Set(values(i))) m.set(v, (m.get(v) ?? 0) + 1);
  const all = new Set<string>();
  for (const i of items) for (const v of values(i)) all.add(v);
  return [...all].sort().map((v) => ({ value: v, label: v, count: m.get(v) ?? 0 }));
}
export function bucketCount(items: PickerItem[], f: Filters, c: Ctx, facet: "date" | "quality" | "visibility", value: string): number {
  const probe: Filters = { ...f, [facet]: value } as Filters;
  return items.filter((i) => passes(i, probe, c)).length;
}

// Which filters the current results cannot serve at all (no item carries the field): shown to the person as a
// one-line note, and listed in the findings as the back-end gap.
export function missingFacets(items: PickerItem[]): string[] {
  const out: string[] = [];
  if (items.length === 0) return out;
  if (!items.some((i) => i.topics && i.topics.length)) out.push("topic");
  if (!items.some((i) => dateMs(i.date) !== null)) out.push("date");
  if (!items.some((i) => i.quality)) out.push("quality");
  return out;
}

// ---- sort ----
export const sortAvailable = (items: PickerItem[], s: SortKey): boolean =>
  s === "match" || s === "title" || (s === "newest" ? items.some((i) => dateMs(i.date) !== null) : items.some((i) => i.citedBy != null));

export function sortItems(items: PickerItem[], s: SortKey): PickerItem[] {
  const idx = new Map(items.map((i, n) => [i, n] as const));
  const out = items.slice();
  const stable = (a: PickerItem, b: PickerItem) => idx.get(a)! - idx.get(b)!;
  if (s === "title") out.sort((a, b) => a.title.localeCompare(b.title) || stable(a, b));
  else if (s === "newest") out.sort((a, b) => (dateMs(b.date) ?? -Infinity) - (dateMs(a.date) ?? -Infinity) || stable(a, b));
  else if (s === "cited") out.sort((a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1) || stable(a, b));
  return out; // "match" = the search's own order
}

// ---- hit -> item (the contract's SearchHit) ----
export type SearchHit = {
  kind: string; id: string; title: string; snippet: string; state: string; lifecycle: string | null; page_class: string | null;
  // not returned today; read tolerantly so a later route that adds them lights up the matching filters with no picker change
  author?: unknown; topics?: unknown; date?: unknown; quality?: unknown; cited_by?: unknown;
};
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
// The search returns quality as a 0..1 number (a claim's confidence, a source's stamped admission score). The picker
// shows and filters it as a band; these cut-offs are presentation only (the number itself is what is stored).
export const QUALITY_HIGH = 0.75;
export const QUALITY_MEDIUM = 0.5;
export function qualityBand(v: unknown): "High" | "Medium" | "Low" | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) return v >= QUALITY_HIGH ? "High" : v >= QUALITY_MEDIUM ? "Medium" : "Low";
  if (typeof v === "string") { const q = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); return q === "High" || q === "Medium" || q === "Low" ? q : null; }
  return null;
}
export function itemFromHit(h: SearchHit): PickerItem {
  const q = qualityBand(h.quality);
  return {
    kind: h.kind, id: h.id, title: h.title || h.id, snippet: h.snippet ?? "", state: h.state ?? null, lifecycle: h.lifecycle ?? null,
    type: h.page_class ?? null,
    ...(typeof h.author === "string" ? { author: h.author } : {}),
    ...(strs(h.topics) ? { topics: strs(h.topics) } : {}),
    ...(typeof h.date === "string" ? { date: h.date } : {}),
    ...(q === "High" || q === "Medium" || q === "Low" ? { quality: q } : {}),
    ...(typeof h.cited_by === "number" ? { citedBy: h.cited_by } : {}),
    // a held source belongs to the caller's own idea: the route returns it only to that owner; it is marked private
    private: h.lifecycle === "held" || h.state === "held",
  };
}

// the route's inert highlight markers -> text parts (never injected as HTML)
const HL_OPEN = "<<HL>>";
const HL_CLOSE = "<</HL>>";
export function snippetParts(s: string): { text: string; hl: boolean }[] {
  const out: { text: string; hl: boolean }[] = [];
  let rest = s;
  for (;;) {
    const a = rest.indexOf(HL_OPEN);
    if (a < 0) break;
    const b = rest.indexOf(HL_CLOSE, a + HL_OPEN.length);
    if (b < 0) break;
    if (a > 0) out.push({ text: rest.slice(0, a), hl: false });
    out.push({ text: rest.slice(a + HL_OPEN.length, b), hl: true });
    rest = rest.slice(b + HL_CLOSE.length);
  }
  if (rest) out.push({ text: rest, hl: false });
  return out.map((p) => ({ ...p, text: p.text.split(HL_OPEN).join("").split(HL_CLOSE).join("") }));
}
