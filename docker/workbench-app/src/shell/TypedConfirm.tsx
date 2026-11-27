// The typed-word confirm: for an action that cannot be taken back, the person types a given word before
// the button works. Exact match (spaces at the ends ignored); the button stays disabled until then.
import { useId, useState } from "react";

// `target` (optional) names what the confirmation is for (data-target): a screen keys it to ONE row, so a confirmation never
// carries over to another row.
export function TypedConfirm({ word, prompt, confirmLabel, onConfirm, onCancel, target }:
  { word: string; prompt: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; target?: string }) {
  const [typed, setTyped] = useState("");
  const id = useId();
  const match = typed.trim() === word;
  return (
    <form className="typed" data-testid="typed-confirm" data-target={target} onSubmit={(e) => { e.preventDefault(); if (match) onConfirm(); }}>
      <p id={id + "p"}>{prompt}</p>
      <label htmlFor={id}>Type <code>{word}</code> to continue</label>
      <input id={id} data-testid="typed-input" value={typed} onChange={(e) => setTyped(e.target.value)}
        autoComplete="off" spellCheck={false} aria-describedby={id + "p"} />
      <div className="typed-actions">
        <button type="button" onClick={onCancel} data-testid="typed-cancel">Cancel</button>
        <button type="submit" className="danger" disabled={!match} data-testid="typed-ok">{confirmLabel}</button>
      </div>
    </form>
  );
}
