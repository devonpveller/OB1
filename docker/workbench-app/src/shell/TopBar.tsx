// The top bar: brand, the search box (opens Ctrl+K), the locked-document chip, + Start research, the avatar.
import type { DocRef } from "../lib/state";
import { Link } from "./Link";

const initials = (name: string) =>
  name.split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function TopBar({ who, locked, onSearch, onUnlock }:
  { who: { subject: string; name: string } | null; locked: DocRef | null; onSearch: () => void; onUnlock: () => void }) {
  return (
    <header className="top" data-testid="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 19V5l8 4 8-4v14l-8 4-8-4z" /></svg>
        Workbench
      </div>
      <button type="button" className="search" onClick={onSearch} aria-haspopup="dialog" aria-keyshortcuts="Control+K" data-testid="search-box">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <span className="search-text">Search documents, sources, claims and thoughts</span>
        <kbd className="kbd">Ctrl K</kbd>
      </button>
      {locked && (
        <span className="lock" data-testid="lock-chip" title="Cites from anywhere go to this document's queue">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
          <span className="lock-title">Locked: {locked.title}</span>
          <Link to="/documents" data-testid="lock-swap">Swap</Link>
          <button type="button" onClick={onUnlock} data-testid="lock-unlock">Unlock</button>
        </span>
      )}
      <Link to="/research/start" className="btn pri" data-testid="start-research">+ Start research</Link>
      <div className="top-right">
        {who && <div className="avatar" role="img" aria-label={`Signed in as ${who.name}`} title={who.name} data-testid="avatar">{initials(who.name)}</div>}
      </div>
    </header>
  );
}
