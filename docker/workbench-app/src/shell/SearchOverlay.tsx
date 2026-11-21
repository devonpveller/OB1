// The Ctrl+K overlay. In this item it is EMPTY on purpose: the search itself is rwr-search (phase 2).
// It is a modal dialog: focus moves into it, Tab stays inside it, Esc or the close button (or a click on the
// backdrop) closes it, and focus returns to what had it before.
import { useEffect, useRef } from "react";

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => { before?.focus?.(); };
  }, []);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key === "Tab") {
      const f = box.current?.querySelectorAll<HTMLElement>("button, input, a[href]");
      if (!f || f.length === 0) return;
      const first = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    }
  };
  return (
    <div className="overlay-back" data-testid="search-overlay-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="overlay" role="dialog" aria-modal="true" aria-label="Search" data-testid="search-overlay" onKeyDown={key}>
        <p className="overlay-empty">Search is coming in phase 2. Press Esc to close.</p>
        <button type="button" ref={closeBtn} onClick={onClose} data-testid="search-close">Close</button>
      </div>
    </div>
  );
}
