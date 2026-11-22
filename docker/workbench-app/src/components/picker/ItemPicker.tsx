// THE item picker (rwr-picker): the one searchable, filterable, single- or multi-select list for choosing library
// items, reused by every screen that picks things. There is no other: test/picker-single.test.ts fails if a second
// picker or list-search component appears. It asks the shared search hook (search.ts, the Ctrl+K overlay's) and
// filters its answer with the shared model (model.ts).
//
// Privacy: nothing the picker shows is written anywhere - no storage, no URL, no module-level cache. A private row
// carries a "private" tag; the selected tray holds items in component state only.
// Keyboard: the search box is a combobox over the result list - Up/Down move, Enter picks, Ctrl+Enter confirms,
// Esc cancels; every filter, sort, tray and footer control is a button in the tab order.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  NO_FILTERS, anyFilter, applyFilters, bucketCount, countBy, inScope, keyOf, kindLabel, missingFacets, snippetParts, sortAvailable, sortItems,
  type DateBucket, type Filters, type PickerItem, type PickerScope, type QualityFloor, type SortKey, type Visibility,
} from "./model";
import { MIN_QUERY, useLibrarySearch, type MineSearch } from "./search";
import "./picker.css";

export type ItemPickerProps = {
  mode: "single" | "multi";
  title?: string;
  /** what the screen is choosing for; shown under the title */
  subtitle?: string;
  /** the initial scope: the locked document's topics, the whole library, or the library and my thoughts */
  scope?: PickerScope;
  /** quick scopes offered as chips (the first is used when `scope` is not given) */
  scopes?: PickerScope[];
  onScopeChange?: (s: PickerScope) => void;
  initialQuery?: string;
  defaultSelected?: PickerItem[];
  /** keys ("kind:id") the caller already holds; offered as "hide what is already linked" and marked on rows */
  alreadyLinked?: ReadonlySet<string>;
  /** the own-thoughts search (rwr-own-thoughts-search-api): absent until it lands */
  mineSearch?: MineSearch;
  onChange?: (selected: PickerItem[]) => void;
  onConfirm: (selected: PickerItem[]) => void;
  onCancel?: () => void;
  confirmLabel?: (n: number) => string;
  /** test seam: the clock for the date filter */
  now?: number;
  debounceMs?: number;
};

const LIB: PickerScope = { kind: "library" };
const scopeKeyOf = (s: PickerScope) => s.kind;
export const scopeLabel = (s: PickerScope) =>
  s.kind === "library" ? "Whole library" : s.kind === "document" ? `From ${s.label}` : "Library and my thoughts";

const DATE_OPTS: [DateBucket, string][] = [["any", "Any time"], ["d30", "Last 30 days"], ["year", "This year"], ["older", "Before this year"]];
const QUALITY_OPTS: [QualityFloor, string][] = [["any", "Any"], ["medium", "Medium or better"], ["high", "High only"]];
const VIS_OPTS: [Visibility, string][] = [["all", "Everything I can see"], ["shared", "Shared"], ["private", "Private to me"]];
const SORT_OPTS: [SortKey, string][] = [["match", "Best match"], ["title", "Title A to Z"], ["newest", "Newest"], ["cited", "Most cited"]];

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function FilterGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
  <div className="ip-group" role="group" aria-label={name}>
    <div className="ip-gh">{name}</div>
    {children}
  </div>
  );
}
function Opt({ on, label: l, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
  <button type="button" className={"ip-opt" + (on ? " on" : "")} aria-pressed={on} onClick={onClick}>
    <span>{l}</span>
    {count !== undefined && <span className="ip-n">{count}</span>}
  </button>
  );
}

// THE private marker: every view the picker exports (ItemPicker's rows and tray, PickerResults' rows) renders a private
// item through this one component, so no view can show a private result unmarked (acceptance 3).
export function PrivateTag({ item, testId }: { item: Pick<PickerItem, "private">; testId?: string }) {
  return item.private ? <span className="ip-tag priv" data-testid={testId}>private</span> : null;
}

export function ItemPicker(props: ItemPickerProps) {
  const { mode, scopes, alreadyLinked, mineSearch, onChange, onConfirm, onCancel } = props;
  const uid = useId();
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [scopeState, setScopeState] = useState<PickerScope>(props.scope ?? scopes?.[0] ?? LIB);
  const scope = scopeState; // `props.scope` is the INITIAL scope (remount with a key to reset it)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>("match");
  const [sel, setSel] = useState<Map<string, PickerItem>>(() => new Map((props.defaultSelected ?? []).map((i) => [keyOf(i), i])));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLUListElement>(null);
  const trayHeadRef = useRef<HTMLElement>(null);
  const focusAfter = useRef<number | null>(null); // tray index to focus after a keyboard removal (-1 = the heading)

  const found = useLibrarySearch(query, scope, { mineSearch, debounceMs: props.debounceMs });
  const ctx = useMemo(() => ({ now: props.now ?? Date.now(), linked: alreadyLinked }), [props.now, alreadyLinked]);
  const pool = useMemo(() => found.items.filter((i) => inScope(i, scope)), [found.items, scope]);
  const shown = useMemo(() => sortItems(applyFilters(pool, filters, ctx), sort), [pool, filters, ctx, sort]);
  const missing = useMemo(() => missingFacets(pool), [pool]);

  const kindOpts = useMemo(() => countBy(pool, filters, ctx, "kinds", (i) => [i.kind]), [pool, filters, ctx]);
  const typeOpts = useMemo(() => countBy(pool, filters, ctx, "types", (i) => (i.type ? [i.type] : [])), [pool, filters, ctx]);
  const stateOpts = useMemo(() => countBy(pool, filters, ctx, "states", (i) => (i.lifecycle ? [i.lifecycle] : [])), [pool, filters, ctx]);
  const topicOpts = useMemo(() => countBy(pool, filters, ctx, "topics", (i) => i.topics ?? []), [pool, filters, ctx]);
  const hasPrivate = pool.some((i) => i.private);
  const hasDate = !missing.includes("date") && pool.length > 0;
  const hasQuality = !missing.includes("quality") && pool.length > 0;

  const setF = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setActive(0); };
  const setSelection = (m: Map<string, PickerItem>) => { setSel(m); onChange?.([...m.values()]); };
  const pick = (i: PickerItem) => {
    const k = keyOf(i);
    if (mode === "single") return setSelection(new Map([[k, i]]));
    const m = new Map(sel);
    if (m.has(k)) m.delete(k); else m.set(k, i);
    setSelection(m);
  };
  const remove = (k: string) => {
    const at = [...sel.keys()].indexOf(k);
    focusAfter.current = sel.size <= 1 ? -1 : Math.min(at, sel.size - 2); // the item that takes its place, else the one before
    const m = new Map(sel); m.delete(k); setSelection(m);
  };
  const clearSel = () => { focusAfter.current = -1; setSelection(new Map()); };
  // the removed button is gone: put keyboard focus on the next tray item (or the tray heading), never on <body>
  useEffect(() => {
    const at = focusAfter.current;
    if (at === null) return;
    focusAfter.current = null;
    const btns = trayRef.current?.querySelectorAll<HTMLElement>("button");
    (at >= 0 && btns && btns[at] ? btns[at] : trayHeadRef.current)?.focus();
  }, [sel]);
  const chosen = [...sel.values()];
  const confirm = () => { if (chosen.length) onConfirm(chosen); };

  const listId = `${uid}-list`;
  const optId = (n: number) => `${uid}-opt-${n}`;
  const at = Math.min(active, Math.max(shown.length - 1, 0));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(at + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setActive(Math.max(shown.length - 1, 0)); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirm(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[at]) pick(shown[at]); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel?.(); }
  };

  const privCount = chosen.filter((i) => i.private).length;
  const n = chosen.length;
  const label = props.confirmLabel ? props.confirmLabel(n) : mode === "single" ? "Use this" : `Use these ${n}`;
  const q = found.query;
  const tooShort = q.length < MIN_QUERY;

  return (
    <section className="ip" role="dialog" aria-label={props.title ?? "Find items"} data-testid="picker" data-mode={mode} onKeyDown={(e) => { if (e.key === "Escape" && e.target !== inputRef.current) onCancel?.(); }}>
      <header className="ip-head">
        <h2>{props.title ?? "Find items"}</h2>
        {props.subtitle && <span className="ip-meta">{props.subtitle}</span>}
        {onCancel && <button type="button" className="ip-btn" onClick={onCancel}>Cancel</button>}
      </header>

      <div className="ip-search">
        <input
          ref={inputRef}
          autoFocus
          type="search"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={shown.length ? optId(at) : undefined}
          aria-autocomplete="list"
          aria-label="Search the library"
          placeholder="Search titles, claims and topics"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKey}
          data-testid="picker-q"
        />
      </div>

      {(scopes && scopes.length > 0) && (
        <div className="ip-scopes" role="group" aria-label="Start from">
          <span className="ip-meta">Start from</span>
          {scopes.map((s) => {
            const on = scopeKeyOf(s) === scopeKeyOf(scope) && (s.kind !== "document" || (scope.kind === "document" && scope.label === s.label));
            return (
              <button key={scopeKeyOf(s) + (s.kind === "document" ? s.label : "")} type="button" className={"ip-pill" + (on ? " on" : "")} aria-pressed={on}
                onClick={() => { setScopeState(s); props.onScopeChange?.(s); setActive(0); }}>{scopeLabel(s)}</button>
            );
          })}
        </div>
      )}
      {scope.kind === "document" && scope.topics.length > 0 && (
        <p className="ip-note" data-testid="picker-scope-note">
          Topics: {scope.topics.join(", ")}.{missing.includes("topic") && pool.length > 0 ? " The search does not return topics yet, so this shows the whole library." : ""}
        </p>
      )}
      {found.mineUnavailable && <p className="ip-note" data-testid="picker-mine-note">Your own thoughts are not searchable here yet; showing the library only.</p>}

      <div className="ip-body">
        <div className="ip-filters" role="group" aria-label="Filters">
          <FilterGroup name="Kind">
            {kindOpts.length === 0 && <span className="ip-meta">Search first.</span>}
            {kindOpts.map((o) => <Opt key={o.value} on={filters.kinds.includes(o.value)} label={kindLabel(o.value)} count={o.count} onClick={() => setF({ kinds: toggle(filters.kinds, o.value) })} />)}
          </FilterGroup>
          {typeOpts.length > 0 && (
            <FilterGroup name="Type">
              {typeOpts.map((o) => <Opt key={o.value} on={filters.types.includes(o.value)} label={o.label} count={o.count} onClick={() => setF({ types: toggle(filters.types, o.value) })} />)}
            </FilterGroup>
          )}
          {stateOpts.length > 1 && (
            <FilterGroup name="State">
              {stateOpts.map((o) => <Opt key={o.value} on={filters.states.includes(o.value)} label={o.label} count={o.count} onClick={() => setF({ states: toggle(filters.states, o.value) })} />)}
            </FilterGroup>
          )}
          {topicOpts.length > 0 && (
            <FilterGroup name="Topics (any of)">
              {topicOpts.map((o) => <Opt key={o.value} on={filters.topics.includes(o.value)} label={o.label} count={o.count} onClick={() => setF({ topics: toggle(filters.topics, o.value) })} />)}
            </FilterGroup>
          )}
          {hasDate && (
            <FilterGroup name="When">
              {DATE_OPTS.map(([v, l]) => <Opt key={v} on={filters.date === v} label={l} count={bucketCount(pool, filters, ctx, "date", v)} onClick={() => setF({ date: v })} />)}
            </FilterGroup>
          )}
          {hasQuality && (
            <FilterGroup name="Quality">
              {QUALITY_OPTS.map(([v, l]) => <Opt key={v} on={filters.quality === v} label={l} count={bucketCount(pool, filters, ctx, "quality", v)} onClick={() => setF({ quality: v })} />)}
            </FilterGroup>
          )}
          {hasPrivate && (
            <FilterGroup name="Who can see it">
              {VIS_OPTS.map(([v, l]) => <Opt key={v} on={filters.visibility === v} label={l} count={bucketCount(pool, filters, ctx, "visibility", v)} onClick={() => setF({ visibility: v })} />)}
            </FilterGroup>
          )}
          {alreadyLinked && (
            <FilterGroup name="Already linked">
              <label className="ip-switch">
                <input type="checkbox" checked={filters.hideLinked} onChange={(e) => setF({ hideLinked: e.target.checked })} />
                <span>{filters.hideLinked ? "Hidden" : "Shown, and marked"}</span>
              </label>
            </FilterGroup>
          )}
          {missing.length > 0 && <p className="ip-note" data-testid="picker-missing">Filters by {missing.join(", ")} appear when the search returns them.</p>}
          <button type="button" className="ip-btn" onClick={() => { setFilters(NO_FILTERS); setSort("match"); setActive(0); }} disabled={!anyFilter(filters) && sort === "match"}>Clear all filters</button>
        </div>

        <div className="ip-results">
          <div className="ip-bar">
            <strong aria-live="polite" data-testid="picker-count">{tooShort ? "Type at least two letters" : found.loading ? "Searching" : `${shown.length} ${shown.length === 1 ? "match" : "matches"}`}</strong>
            {!tooShort && !found.loading && pool.length !== shown.length && <span className="ip-meta">of {pool.length} found</span>}
            <span className="ip-meta ip-sortl">Sort</span>
            <div className="ip-seg" role="group" aria-label="Sort">
              {SORT_OPTS.map(([v, l]) => {
                const ok = sortAvailable(pool, v);
                return <button key={v} type="button" className={"ip-sg" + (sort === v ? " on" : "")} aria-pressed={sort === v} disabled={!ok} title={ok ? undefined : "The search does not return this yet"} onClick={() => setSort(v)}>{l}</button>;
              })}
            </div>
          </div>
          {found.error && <p className="ip-note ip-err" role="alert">The search did not answer ({found.error}). Try again.</p>}
          <ul id={listId} role="listbox" aria-label="Results" aria-multiselectable={mode === "multi"} className="ip-list" data-testid="picker-list">
            {shown.map((i, idx) => {
              const k = keyOf(i);
              const on = sel.has(k);
              const linked = alreadyLinked?.has(k);
              return (
                <li key={k} id={optId(idx)} role="option" aria-selected={on} className={"ip-row" + (on ? " sel" : "") + (idx === at ? " act" : "")} data-key={k} onClick={() => { pick(i); setActive(idx); inputRef.current?.focus(); }}>
                  <span className={"ip-cb" + (mode === "single" ? " radio" : "")} aria-hidden="true">{on ? "✓" : ""}</span>
                  <span className="ip-main">
                    <span className="ip-line">
                      <span className="ip-title">{i.title}</span>
                      <span className="ip-tag">{kindLabel(i.kind)}</span>
                      {i.type && <span className="ip-meta">{i.type}</span>}
                      <PrivateTag item={i} testId="private-tag" />
                      {linked && <span className="ip-tag linked">already linked</span>}
                    </span>
                    {(i.author || i.date) && <span className="ip-meta ip-blk">{[i.author, i.date?.slice(0, 10)].filter(Boolean).join(" · ")}</span>}
                    {i.topics && i.topics.length > 0 && <span className="ip-chips">{i.topics.map((t) => <span className="ip-chip" key={t}>{t}</span>)}</span>}
                    {i.snippet && <span className="ip-snip">{snippetParts(i.snippet).map((p, n) => (p.hl ? <mark key={n}>{p.text}</mark> : <span key={n}>{p.text}</span>))}</span>}
                  </span>
                  <span className="ip-side">
                    {i.quality && <span className={"ip-tag q-" + i.quality.toLowerCase()}>{i.quality}</span>}
                    {i.citedBy != null && <span className="ip-meta">{i.citedBy ? `in ${i.citedBy} of your documents` : "not in your documents"}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {!tooShort && !found.loading && !found.error && shown.length === 0 && <p className="ip-note" data-testid="picker-empty">Nothing matches. Loosen a filter or change the search.</p>}
        </div>

        <aside className="ip-tray" aria-label="Selected">
          <div className="ip-trayh">
            <strong data-testid="picker-nsel" ref={trayHeadRef} tabIndex={-1}>Selected ({n})</strong>
            {n > 0 && <button type="button" className="ip-btn" onClick={clearSel}>Clear</button>}
          </div>
          <span className="ip-meta">{n ? (mode === "single" ? "Picking another one replaces it." : "Review before using; × takes one out.") : mode === "single" ? "Pick one." : "Pick as many as you like. They stay here while you search and filter."}</span>
          <ul className="ip-tl" data-testid="picker-tray" ref={trayRef}>
            {chosen.map((i) => (
              <li key={keyOf(i)} className="ip-ti" data-key={keyOf(i)}>
                <span className="ip-main">
                  <span className="ip-title">{i.title}</span>
                  <span className="ip-meta ip-blk">{kindLabel(i.kind)}{i.private && " "}<PrivateTag item={i} /></span>
                </span>
                <button type="button" className="ip-btn" aria-label={`Remove ${i.title}`} onClick={() => remove(keyOf(i))}>{"×"}</button>
              </li>
            ))}
          </ul>
          {privCount > 0 && <p className="ip-note"><span className="ip-tag priv">private</span> {privCount} private item{privCount === 1 ? "" : "s"}: they work for you, but anything built from them is not shareable until they are removed.</p>}
        </aside>
      </div>

      <footer className="ip-foot">
        <span className="ip-meta ip-kbd">Up/Down move &middot; Enter picks &middot; Ctrl+Enter confirms &middot; Esc cancels</span>
        {onCancel && <button type="button" className="ip-btn" onClick={onCancel}>Cancel</button>}
        <button type="button" className="ip-btn pri" disabled={n === 0} onClick={confirm} data-testid="picker-ok">{label}</button>
      </footer>
    </section>
  );
}

// The picker's read-only results view, for a screen that OPENS what it finds instead of picking it (Home's ask box in
// phase 0; rwr-quick-ask later). It is the picker, not a second list search: the same hook (useLibrarySearch), the
// same query shape (searchUrl, with an optional smaller `limit`), the same hit mapping (itemFromHit, snippetParts).
// The screen supplies only the submitted query and the link a row opens; remount it (a `key`) to ask again.
export type PickerResultsProps = {
  /** the submitted query; shorter than MIN_QUERY asks nothing */
  query: string;
  scope?: PickerScope;
  /** at most this many per kind (clamped to the route's ceiling) */
  limit?: number;
  /** the list's accessible name */
  label: string;
  /** wraps a row's content in the screen's own link (the screen decides where a hit goes) */
  open: (item: PickerItem, content: ReactNode) => ReactNode;
  /** prefix for the empty / failed lines' test ids: `${testId}-none`, `${testId}-failed` */
  testId?: string;
  debounceMs?: number;
};

export function PickerResults({ query, scope = LIB, limit, label, open, testId = "picker-results", debounceMs = 0 }: PickerResultsProps) {
  const found = useLibrarySearch(query, scope, { limit, debounceMs });
  const q = query.trim();
  if (q.length < MIN_QUERY) return null;
  const done = !found.loading && found.query === q;
  if (found.loading || !done) return <p className="meta">Searching...</p>;
  if (found.error) return <p className="meta" data-testid={testId + "-failed"}>The search did not answer. Try again.</p>;
  const shown = found.items.filter((i) => inScope(i, scope));
  if (shown.length === 0) return <p className="empty" data-testid={testId + "-none"}>Nothing in the library matches "{q}".</p>;
  return (
    <ul className="hits" aria-label={label}>
      {shown.map((i) => {
        const snip = snippetParts(i.snippet).map((p) => p.text).join("");
        return (
          <li key={keyOf(i)}>
            {open(i, <>
              <span className="row-main"><span className="row-title">{i.title || "(untitled)"}</span>{snip && <span className="meta">{snip}</span>}</span>
              <span className="pill">{i.kind}</span>
              <PrivateTag item={i} testId="private-tag" />
            </>)}
          </li>
        );
      })}
    </ul>
  );
}
