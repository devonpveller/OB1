// A toast with Undo: a short message at the bottom that offers to take the action back. It is announced
// politely to a screen reader, stays 8 seconds (hovering or focusing it holds it, so a keyboard user has
// time), and Undo runs the caller's function once.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToastSpec = { message: string; undoLabel?: string; onUndo?: () => void; ms?: number };
type Item = ToastSpec & { id: number };
const Ctx = createContext<(t: ToastSpec) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const show = useCallback((t: ToastSpec) => setItems((l) => [...l, { ...t, id: ++seq.current }]), []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
        {items.map((t) => <ToastView key={t.id} t={t} dismiss={dismiss} />)}
      </div>
    </Ctx.Provider>
  );
}

function ToastView({ t, dismiss }: { t: Item; dismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const h = setTimeout(() => dismiss(t.id), t.ms ?? 8000);
    return () => clearTimeout(h);
  }, [held, t.id, t.ms, dismiss]);
  return (
    <div className="toast" data-testid="toast" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <span>{t.message}</span>
      {t.onUndo && (
        <button type="button" className="toast-undo" data-testid="toast-undo"
          onClick={() => { const f = t.onUndo; dismiss(t.id); f?.(); }}>{t.undoLabel ?? "Undo"}</button>
      )}
      <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>x</button>
    </div>
  );
}
