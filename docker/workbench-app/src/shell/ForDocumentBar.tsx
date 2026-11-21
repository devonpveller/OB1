// The amber "For document" bar: shown on a screen that is working FOR one document (the Library choosing
// sources for it, say). Amber = this only makes sense with a document; it always names the document and
// has a way back to it.
import type { ReactNode } from "react";
import { Link } from "./Link";

export function ForDocumentBar({ title, backTo, backLabel = "Back to the document", children }:
  { title: string; backTo: string; backLabel?: string; children?: ReactNode }) {
  return (
    <div className="fordoc" role="region" aria-label="Working for a document" data-testid="for-document">
      <span className="fordoc-tag">For document</span>
      <strong className="fordoc-title" data-testid="for-document-title">{title}</strong>
      {children}
      <Link to={backTo} className="fordoc-back" data-testid="for-document-back">{backLabel}</Link>
    </div>
  );
}
