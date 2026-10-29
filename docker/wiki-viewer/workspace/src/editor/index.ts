// The writing surface's editor: CodeMirror 6 (pinned by package-lock.json) with the legacy notes
// editor's parity set (D12 items 1-4: live preview, [[ autocomplete, link hover popover, the cursor
// toolbar, the standard keymap, undo/redo history, tab indent, the placeholder) and the P2b
// reference behaviour (protected transclusions, chips, the deliberate break, stale flags, inject
// at the cursor, mirror a selection to the panels).
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { breakTransclusionAt, protectedExtension, type ProtectedSpan, setStale } from "./protected";
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

export function createEditor(parent: HTMLElement, o: EditorOptions): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-Shift-b", run: (v) => breakTransclusionAt(v) },
          {
            key: "Mod-Shift-f", run: (v) => {
              const s = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
              if (s.trim()) o.onMirror?.(s);
              return true;
            },
          },
          ...defaultKeymap, ...historyKeymap, indentWithTab,
        ]),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, extensions: [Strikethrough] }),
        syntaxHighlighting(defaultHighlightStyle),
        protectedExtension({ onSelect: o.onSelectSpan, onHover: o.onHoverSpan }),
        livePreview({ onLinkHover: o.onLinkHover, onLinkOpen: o.onLinkOpen }),
        cursorToolbar,
        autocompletion({ override: [linkCompletion(o.candidates)] }),
        placeholder("Write in markdown - type [[ to link, select text and use the reference panel to cite it..."),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onChange(u.state.doc.toString());
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
