// The Ctrl+K overlay. In this item it is EMPTY on purpose: the search itself is rwr-search (phase 2).
// It is a modal dialog: focus moves into it, Tab stays inside it, Esc or the close button (or a click on the
// backdrop) closes it, and focus returns to what had it before. The keys are handled at the DOCUMENT while
// it is open (a click on its own text drops focus to <body>, and a handler on the dialog would never hear
// Esc then); the page behind it is made inert by App (the dialog is rendered outside that region).
import { useEffect, useRef } from "react";

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab") return;
      const f = box.current?.querySelectorAll<HTMLElement>("button, input, a[href]");
      if (!f || f.length === 0) return;
      const first = f[0], lastEl = f[f.length - 1];
      const here = document.activeElement;
      const inside = !!here && box.current!.contains(here);
      if (!inside) { e.preventDefault(); (e.shiftKey ? lastEl : first).focus(); }
      else if (e.shiftKey && here === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && here === lastEl) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); before?.focus?.(); };
  }, []);
  return (
    <div className="overlay-back" data-testid="search-overlay-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="overlay" role="dialog" aria-modal="true" aria-label="Search" data-testid="search-overlay"
        onMouseDown={() => { /* a click on its own text keeps focus in it */ if (!box.current?.contains(document.activeElement)) closeBtn.current?.focus(); }}>
        <p className="overlay-empty">Search is coming in phase 2. Press Esc to close.</p>
        <button type="button" ref={closeBtn} onClick={onClose} data-testid="search-close">Close</button>
      </div>
    </div>
  );
}
