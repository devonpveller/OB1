// The "In this doc" tab strip of the document screen (rwr-doc-editor): References, Coverage, Topics, Refine,
// History, Details, Export. Each tab is a PLACEHOLDER until its own item lands (rwr-doc-refs, rwr-doc-coverage,
// rwr-doc-topics, phase 4's Refine, rwr-doc-history, rwr-doc-details-export): it says what the tab will hold and
// that it is not built yet - never an error, never a blank. A later item replaces its tab's `panel` and nothing else.
// The strip is the WAI-ARIA tabs pattern: one tab stop, Left / Right / Home / End move between tabs.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type TabId = "references" | "coverage" | "topics" | "refine" | "history" | "details" | "export";
export type TabDef = { id: TabId; label: string; will: string; panel?: ReactNode };

export const DOC_TABS: TabDef[] = [
  { id: "references", label: "References", will: "The sources waiting to be placed, the ones cited in the text, and a way to find more." },
  { id: "coverage", label: "Coverage", will: "What this document still needs, and the claims in it that rest on thin evidence." },
  { id: "topics", label: "Topics", will: "The topics your sources touch, and the ones nearby that you have not read." },
  { id: "refine", label: "Refine", will: "A focus question for the document and suggested ways to sharpen it." },
  { id: "history", label: "History", will: "Every saved version, newest first, with a way to go back to one." },
  { id: "details", label: "Details", will: "Sources, claims, words, sections and versions at a glance." },
  { id: "export", label: "Export", will: "Download the document as PDF, Word or Markdown, with the citation check." },
];

export function InThisDoc({ tabs = DOC_TABS }: { tabs?: TabDef[] }) {
  const [on, setOn] = useState<TabId>(tabs[0].id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length
      : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setOn(tabs[to].id);
    refs.current[tabs[to].id]?.focus();
  };
  const cur = tabs.find((t) => t.id === on) ?? tabs[0];
  return (
    <section className="doc-side card" aria-labelledby="in-this-doc" data-testid="in-this-doc">
      <h2 id="in-this-doc" className="sec">In this doc</h2>
      <div role="tablist" aria-label="In this doc" className="doc-tabs">
        {tabs.map((t, i) => (
          <button key={t.id} type="button" role="tab" id={`dt-${t.id}`} aria-selected={t.id === cur.id} aria-controls={`dp-${t.id}`}
            tabIndex={t.id === cur.id ? 0 : -1} className={"tab" + (t.id === cur.id ? " tabon" : "")} data-testid={`dtab-${t.id}`}
            ref={(el) => { refs.current[t.id] = el; }} onClick={() => setOn(t.id)} onKeyDown={(e) => move(e, i)}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`dp-${cur.id}`} aria-labelledby={`dt-${cur.id}`} tabIndex={0} className="doc-panel" data-testid={`dpanel-${cur.id}`}>
        {cur.panel ?? (
          <>
            <p className="soon-line">{cur.label} is not built yet.</p>
            <p className="meta">{cur.will} It arrives in a later step; nothing here needs your attention now.</p>
          </>
        )}
      </div>
    </section>
  );
}
