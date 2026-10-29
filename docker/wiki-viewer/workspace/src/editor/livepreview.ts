// Live preview, Obsidian style (D12 parity item 1): headings, bold, italic, strikethrough, inline
// code, links and [[wikilinks]] render in place while typing; the line the caret is on shows its raw
// markdown; the frontmatter block is styled as properties and kept VERBATIM (the editor edits the
// text as it is - nothing rewrites it on save). Ported from the legacy notes editor's engine
// (wiki-viewer/quartz-overlay/.../NotesEditor.inline.ts), with the document grammar's typed links.
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { classifyTarget } from "../lib/grammar";
import { spansOf } from "./protected";

export interface LinkHandlers {
  onLinkHover?: (target: { kind: string; id: string }, dom: HTMLElement) => void;
  onLinkOpen?: (target: { kind: string; id: string }) => void;
}

class LinkWidget extends WidgetType {
  constructor(readonly kind: string, readonly id: string, readonly label: string, readonly h: LinkHandlers) {
    super();
  }
  eq(o: LinkWidget) {
    return o.kind === this.kind && o.id === this.id && o.label === this.label;
  }
  toDOM() {
    const a = document.createElement("span");
    a.className = `ws-cm-link ws-cm-link-${this.kind}`;
    a.dataset.kind = this.kind;
    a.dataset.id = this.id;
    a.textContent = this.label;
    a.addEventListener("mouseenter", () => this.h.onLinkHover?.({ kind: this.kind, id: this.id }, a));
    a.addEventListener("mousedown", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.h.onLinkOpen?.({ kind: this.kind, id: this.id });
      }
    });
    return a;
  }
  ignoreEvent() {
    return false;
  }
}

function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

const WIKI = /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g;

function frontmatter(state: EditorState, active: Set<number>, out: Range<Decoration>[]) {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== "---") return;
  let close = 0;
  for (let n = 2; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text.trim() === "---") {
      close = n;
      break;
    }
  }
  for (let n = 1; close > 1 && n <= close; n++) {
    const line = state.doc.line(n);
    out.push(Decoration.line({ class: n === 1 || n === close ? "ws-cm-fm-fence" : "ws-cm-fm" }).range(line.from));
    if (n !== 1 && n !== close && !active.has(n)) {
      const ci = line.text.indexOf(":");
      if (ci > 0) out.push(Decoration.mark({ class: "ws-cm-fm-key" }).range(line.from, line.from + ci));
    }
  }
}

function build(view: EditorView, h: LinkHandlers): DecorationSet {
  const state = view.state;
  const active = activeLines(state);
  const raw = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const protectedRanges = spansOf(state);
  const isProtected = (a: number, b: number) => protectedRanges.some((s) => a < s.to && b > s.from);
  const out: Range<Decoration>[] = [];
  frontmatter(state, active, out);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        if (isProtected(node.from, node.to)) return false;
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          if (!raw(node.from)) out.push(Decoration.line({ class: `ws-cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
          return;
        }
        if (raw(node.from)) return;
        if (name === "HeaderMark" || name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          out.push(Decoration.replace({}).range(node.from, node.to));
        } else if (name === "StrongEmphasis") out.push(Decoration.mark({ class: "ws-cm-strong" }).range(node.from, node.to));
        else if (name === "Emphasis") out.push(Decoration.mark({ class: "ws-cm-em" }).range(node.from, node.to));
        else if (name === "InlineCode") out.push(Decoration.mark({ class: "ws-cm-code" }).range(node.from, node.to));
        else if (name === "Strikethrough") out.push(Decoration.mark({ class: "ws-cm-strike" }).range(node.from, node.to));
        else if (name === "Link") {
          const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(state.doc.sliceString(node.from, node.to));
          if (m) {
            out.push(Decoration.replace({ widget: new LinkWidget("url", m[2], m[1], h) }).range(node.from, node.to));
            return false;
          }
        }
      },
    });
    const text = state.doc.sliceString(from, to);
    WIKI.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI.exec(text))) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (raw(start) || isProtected(start, end)) continue;
      const t = classifyTarget(m[1]);
      out.push(Decoration.replace({ widget: new LinkWidget(t.kind, t.id, (m[3] ?? m[1]).trim(), h) }).range(start, end));
    }
  }
  return Decoration.set(out, true);
}

export function livePreview(h: LinkHandlers = {}) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, h);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view, h);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
