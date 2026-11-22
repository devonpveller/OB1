// The picker's public face. Screens import ONLY from here ("components/picker"); the search hook and model are
// exported so the Ctrl+K overlay (rwr-search) is built on the same ones. PickerResults is the picker's read-only view for
// a screen that opens results rather than picks them (Home's ask box): same hook, same query shape, same hit mapping.
export { ItemPicker, PickerResults, scopeLabel, type ItemPickerProps, type PickerResultsProps } from "./ItemPicker";
export { useLibrarySearch, searchLibrary, searchUrl, MIN_QUERY, SEARCH_LIMIT, SEARCH_URL, type MineSearch, type SearchState, type SearchSpec } from "./search";
export * from "./model";
