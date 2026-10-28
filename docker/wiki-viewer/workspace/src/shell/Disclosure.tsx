// The at-rest rule for side panels (D1 disclosure default): a panel opens on its SUMMARY; its leaves
// show only when the summary is selected; a leaf's actions show only when that leaf is selected.
// Every side panel renders through this, so no panel can open expanded or show actions at rest.
import { type ReactNode, useEffect, useState } from "react";

export interface Leaf {
  key: string;
  label: ReactNode;
  detail?: ReactNode;
  badges?: string[];
}

export function Disclosure(props: {
  summary: ReactNode;
  leaves: Leaf[];
  actions: (leaf: Leaf) => ReactNode;
  // a panel that is FOCUSED on something (the reference panel after a chip is selected) opens its
  // leaves - the focus is the selection; it still shows no action until a leaf is selected
  open?: boolean;
  selected?: string | null;
  onSelect?: (leaf: Leaf | null) => void;
  empty?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(!!props.open);
  const [sel, setSel] = useState<string | null>(props.selected ?? null);
  useEffect(() => setOpen(!!props.open), [props.open]);
  useEffect(() => setSel(props.selected ?? null), [props.selected]);
  const pick = (l: Leaf) => {
    const next = sel === l.key ? null : l.key;
    setSel(next);
    props.onSelect?.(next ? l : null);
  };
  return (
    <div className="ws-disclosure" data-testid={props.testId} data-open={open ? "1" : "0"}>
      <button type="button" className="ws-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ws-caret">{open ? "▾" : "▸"}</span> {props.summary}
      </button>
      {open && (
        <ul className="ws-leaves" role="list">
          {props.leaves.length === 0 && <li className="ws-empty">{props.empty ?? "nothing here"}</li>}
          {props.leaves.map((l) => (
            <li key={l.key} className={`ws-leaf${sel === l.key ? " ws-selected" : ""}`} data-leaf={l.key}>
              <button type="button" className="ws-leaf-label" aria-pressed={sel === l.key} onClick={() => pick(l)}>
                {l.label}
                {(l.badges ?? []).map((b) => <span key={b} className={`ws-badge ws-badge-${b.replace(/\W+/g, "-")}`}>{b}</span>)}
              </button>
              {sel === l.key && (
                <div className="ws-leaf-body">
                  {l.detail && <div className="ws-leaf-detail">{l.detail}</div>}
                  <div className="ws-actions" data-actions={l.key}>{props.actions(l)}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
