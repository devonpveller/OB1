// The shared search hook and its fetch (rwr-picker). The Ctrl+K overlay (rwr-search) calls these same exports,
// so the picker and the overlay ask the same route the same way and get the same results.
// Through lib/api.ts only (same-origin /workbench/*). NOTHING is cached here or anywhere: no module-level
// store, no browser storage - a private result lives only in the state of the component showing it.
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { itemFromHit, type PickerItem, type PickerScope, type SearchHit } from "./model";

export const MIN_QUERY = 2; // the route's own minimum (q min 2)
export const SEARCH_LIMIT = 50; // the route's own ceiling (per kind)
export const SEARCH_URL = "/workbench/contract/search";

export type SearchSpec = { q: string; scope: PickerScope };
export type MineSearch = (q: string, signal: AbortSignal) => Promise<PickerItem[]>;

// One request, ALL kinds: kind (and every other) filter is applied to this answer by model.ts, so the filtered
// list is always a subset of what Ctrl+K gets for the same query and scope, and counts are live without extra calls.
export function searchUrl(spec: SearchSpec): string {
  const p = new URLSearchParams({ q: spec.q.trim(), limit: String(SEARCH_LIMIT) });
  if (spec.scope.kind === "document" && spec.scope.refineryId) p.set("refinery_id", spec.scope.refineryId);
  return `${SEARCH_URL}?${p.toString()}`;
}

export async function searchLibrary(spec: SearchSpec): Promise<PickerItem[]> {
  const r = await api<{ results?: SearchHit[] }>("GET", searchUrl(spec));
  return (r.data.results ?? []).map(itemFromHit);
}

export type SearchState = { items: PickerItem[]; loading: boolean; error: string | null; query: string; mineUnavailable: boolean };

export function useLibrarySearch(q: string, scope: PickerScope, opts: { mineSearch?: MineSearch; debounceMs?: number } = {}): SearchState {
  const { mineSearch, debounceMs = 250 } = opts;
  const [state, setState] = useState<SearchState>({ items: [], loading: false, error: null, query: "", mineUnavailable: false });
  const seq = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // scope identity is by key: an inline `{kind:"library"}` literal must not restart the search every render
  const scopeKey = scope.kind === "document" ? `document:${scope.refineryId ?? ""}` : scope.kind;
  useEffect(() => {
    const query = q.trim();
    const my = ++seq.current;
    if (query.length < MIN_QUERY) {
      setState({ items: [], loading: false, error: null, query, mineUnavailable: false });
      return;
    }
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const t = setTimeout(async () => {
      try {
        const sc = scopeRef.current;
        const wantMine = sc.kind === "library+mine";
        const [lib, mine] = await Promise.all([
          searchLibrary({ q: query, scope: sc }),
          wantMine && mineSearch ? mineSearch(query, ctl.signal).catch(() => null) : Promise.resolve([] as PickerItem[]),
        ]);
        if (my !== seq.current) return;
        // an item the own-thoughts search returns is private by definition; the library's own keep their flag
        const mineMarked = (mine ?? []).map((i) => ({ ...i, private: true }));
        setState({ items: [...lib, ...mineMarked], loading: false, error: null, query, mineUnavailable: wantMine && (!mineSearch || mine === null) });
      } catch (e) {
        if (my !== seq.current) return;
        setState({ items: [], loading: false, error: e instanceof Error ? e.message : "search failed", query, mineUnavailable: false });
      }
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, scopeKey, mineSearch, debounceMs]);
  return state;
}
