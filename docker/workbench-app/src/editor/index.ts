// The writing surface's editor: CodeMirror 6 (pinned by package-lock.json) with the legacy notes
// editor's parity set (D12 items 1-4: live preview, [[ autocomplete, link hover popover, the cursor
// toolbar, the standard keymap, undo/redo history, tab indent, the placeholder) and the P2b
// reference behaviour (protected transclusions, chips, the deliberate break, stale flags, inject
// at the cursor, mirror a selection to the panels).
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { breakTransclusionAt, protectedExtension, spansOf, type ProtectedSpan, setStale } from "./protected";
import { livePreview, type LinkHandlers } from "./livepreview";
import { cursorToolbar } from "./toolbar";

export interface Candidate {
  kind: string;
  id: string;
  title: string;
  insert: string;
  tags: string[];
}

export interface EditorOptions extends LinkHandlers {
  doc: string;
  onChange: (text: string) => void;
  candidates: (q: string) => Promise<Candidate[]>;
  onSelectSpan?: (span: ProtectedSpan, pos: number) => void;
  onHoverSpan?: (span: ProtectedSpan, dom: HTMLElement) => void;
  onMirror?: (selection: string) => void;
  // rwr-doc-editor: the selected text (empty = none) after every change of the selection, and the keyboard doors
  // the pointer-only parts of the surface need (Tab leaves the box; Escape does too, to the Save button)
  onSelection?: (text: string) => void;
  onResearch?: () => void;      // Mod-Alt-r: research the selected text
  onLeave?: () => void;         // Escape: hand the focus back to the page
  label?: string;               // the text box's accessible name
}

export function linkCompletion(candidates: EditorOptions["candidates"]) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const before = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!before || before.from === before.to) return null;
    const q = before.text.slice(2);
    const list = await candidates(q);
    if (!list.length) return null;
    return {
      from: before.from,
      filter: false,
      // the server's order is kept: a source hidden in the refinery is LAST, tagged, never dropped
      options: list.slice(0, 30).map((c, i) => ({
        label: c.title,
        detail: [c.kind, ...c.tags].join(" · "),
        type: c.tags.length ? "hidden" : "link",
        boost: -i,
        apply: c.insert,
      })),
    };
  };
}

// CodeMirror adds a <style> element to the page; the app's Content-Security-Policy allows only one carrying the
// per-response nonce the server put in <meta name="csp-nonce"> (serve.mjs). No nonce (dev server, tests) = none given.
export function cspNonce(): string | null {
  const v = typeof document === "undefined" ? "" : document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? "";
  return /^[A-Za-z0-9+/]{16,}={0,2}$/.test(v) ? v : null;
}

export function createEditor(parent: HTMLElement, o: EditorOptions): EditorView {
  const nonce = cspNonce();
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
        history(),
        keymap.of([
          { key: "Mod-Shift-b", run: (v) => breakTransclusionAt(v) },
          { key: "Mod-Alt-r", run: () => { o.onResearch?.(); return true; } },
          { key: "Escape", run: () => { o.onLeave?.(); return !!o.onLeave; } },
          {
            // the keyboard's way to a citation: with the caret beside a chip or transclusion, Alt-Enter opens its source
            key: "Alt-Enter", run: (v) => {
              const head = v.state.selection.main.head;
              const s = spansOf(v.state).find((x) => head >= x.from && head <= x.to);
              if (!s || !o.onSelectSpan) return false;
              o.onSelectSpan(s, s.from);
              return true;
            },
          },
          {
            key: "Mod-Shift-f", run: (v) => {
              const s = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
              if (s.trim()) o.onMirror?.(s);
              return true;
            },
          },
          ...defaultKeymap, ...historyKeymap, // no indentWithTab: Tab moves focus on (no keyboard trap); Mod-[ and Mod-] indent
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": o.label ?? "Document text" }),
        markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
        syntaxHighlighting(defaultHighlightStyle),
        protectedExtension({ onSelect: o.onSelectSpan, onHover: o.onHoverSpan }),
        livePreview({ onLinkHover: o.onLinkHover, onLinkOpen: o.onLinkOpen }),
        cursorToolbar,
        autocompletion({ override: [linkCompletion(o.candidates)] }),
        placeholder("Write in markdown - type [[ to link a document or a source."),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const r = u.state.selection.main;
            o.onSelection?.(r.empty ? "" : u.state.sliceDoc(r.from, r.to));
          }
        }),
      ],
    }),
  });
}

export function insertAtCursor(view: EditorView, text: string) {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: text }, selection: EditorSelection.cursor(pos + text.length), userEvent: "input.inject" });
  view.focus();
}

export function markStale(view: EditorView, ids: Set<string>) {
  view.dispatch({ effects: setStale.of(ids) });
}

export { breakTransclusionAt };
