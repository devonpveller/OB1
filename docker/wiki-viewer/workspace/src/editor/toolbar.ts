// The cursor-following, collapsible formatting toolbar (D12 parity item 4): bold, italic, strike,
// inline code, heading, quote, bulleted and numbered list toggles, link and [[ - ported from the
// legacy notes editor - plus "break into citation" while the caret is on a transclusion.
import { EditorSelection, type EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";
import { breakTransclusionAt, transclusionAt } from "./protected";
import { ownedKey } from "../lib/owner";

function wordAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  let s = pos - line.from;
  let e = s;
  while (s > 0 && /\w/.test(line.text[s - 1])) s--;
  while (e < line.text.length && /\w/.test(line.text[e])) e++;
  return { from: line.from + s, to: line.from + e };
}

// Toggle an inline format by the markdown syntax tree: inside a node of `typeName` -> remove that
// node's own marks; otherwise wrap with `marker`.
export function formatToggle(view: EditorView, typeName: string, marker: string) {
  const state = view.state;
  view.dispatch(state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) ({ from, to } = wordAt(state, from));
    let target: any = null;
    for (let n: any = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
      if (n.name === typeName && n.from <= from && n.to >= to) {
        target = n;
        break;
      }
    }
    if (target) {
      const marks: { from: number; to: number }[] = [];
      for (let c: any = target.firstChild; c; c = c.nextSibling) if (c.name.endsWith("Mark")) marks.push({ from: c.from, to: c.to });
      if (marks.length >= 2) {
        const open = marks[0];
        const close = marks[marks.length - 1];
        const lo = open.to - open.from;
        return {
          changes: [{ from: open.from, to: open.to, insert: "" }, { from: close.from, to: close.to, insert: "" }],
          range: EditorSelection.range(from - lo, to - lo),
        };
      }
    }
    const sel = state.sliceDoc(from, to);
    return { changes: { from, to, insert: marker + sel + marker }, range: EditorSelection.range(from + marker.length, from + marker.length + sel.length) };
  }));
  view.focus();
}

export function toggleLinePrefix(view: EditorView, prefix: string) {
  const state = view.state;
  const changes: { from: number; to?: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (line.text.startsWith(prefix)) changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
      else changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

function insertLink(view: EditorView) {
  view.dispatch(view.state.changeByRange((range) => {
    const insert = `[${view.state.sliceDoc(range.from, range.to)}]()`;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length - 1) };
  }));
  view.focus();
}

function insertWiki(view: EditorView) {
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: "[[]]" }, selection: EditorSelection.cursor(pos + 2) });
  view.focus();
  startCompletion(view);
}

export const TOOLBAR = [
  { t: "Bold", l: "B", run: (v: EditorView) => formatToggle(v, "StrongEmphasis", "**") },
  { t: "Italic", l: "I", run: (v: EditorView) => formatToggle(v, "Emphasis", "*") },
  { t: "Strikethrough", l: "S", run: (v: EditorView) => formatToggle(v, "Strikethrough", "~~") },
  { t: "Inline code", l: "</>", run: (v: EditorView) => formatToggle(v, "InlineCode", "`") },
  { t: "Heading", l: "H", run: (v: EditorView) => toggleLinePrefix(v, "# ") },
  { t: "Quote", l: "❝", run: (v: EditorView) => toggleLinePrefix(v, "> ") },
  { t: "Bulleted list", l: "•", run: (v: EditorView) => toggleLinePrefix(v, "- ") },
  { t: "Numbered list", l: "1.", run: (v: EditorView) => toggleLinePrefix(v, "1. ") },
  { t: "Link", l: "link", run: (v: EditorView) => insertLink(v) },
  { t: "Wikilink", l: "[[", run: (v: EditorView) => insertWiki(v) },
];

const COLLAPSED_KEY = () => ownedKey("ws.toolbar.collapsed"); // per user

export const cursorToolbar = ViewPlugin.fromClass(class {
  bar: HTMLElement;
  collapsed = false;
  raf = 0;
  constructor(readonly view: EditorView) {
    try {
      this.collapsed = localStorage.getItem(COLLAPSED_KEY()) === "1";
    } catch { /* not kept */ }
    this.bar = document.createElement("div");
    this.bar.className = "ws-tb";
    this.bar.setAttribute("role", "toolbar");
    this.render();
    this.schedule();
  }
  host() {
    return (this.view.dom.parentElement as HTMLElement) || this.view.dom;
  }
  schedule() {
    if (this.raf || typeof requestAnimationFrame === "undefined") return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.place();
    });
  }
  button(label: string, title: string, run: () => void, cls = "ws-tb-btn") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.dataset.tool = title;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run();
    });
    this.bar.appendChild(b);
  }
  render() {
    this.bar.innerHTML = "";
    this.button(this.collapsed ? "✎" : "⌄", this.collapsed ? "show formatting tools" : "collapse", () => {
      this.collapsed = !this.collapsed;
      try {
        localStorage.setItem(COLLAPSED_KEY(), this.collapsed ? "1" : "0");
      } catch { /* not kept */ }
      this.render();
      this.place();
    }, "ws-tb-toggle");
    if (this.collapsed) return;
    for (const b of TOOLBAR) this.button(b.l, b.t, () => b.run(this.view));
    if (transclusionAt(this.view.state, this.view.state.selection.main.head)) {
      this.button("break into citation", "Break into citation", () => breakTransclusionAt(this.view), "ws-tb-btn ws-tb-break");
    }
  }
  place() {
    const host = this.host();
    if (this.bar.parentElement !== host) host.appendChild(this.bar);
    if (!this.view.hasFocus) {
      this.bar.style.display = "none";
      return;
    }
    const coords = this.view.coordsAtPos(this.view.state.selection.main.head);
    if (!coords) {
      this.bar.style.display = "none";
      return;
    }
    this.bar.style.display = "inline-flex";
    const box = host.getBoundingClientRect();
    const left = Math.max(0, Math.min(coords.left - box.left, host.clientWidth - this.bar.offsetWidth - 6));
    let top = coords.top - box.top - this.bar.offsetHeight - 8;
    if (top < 0) top = coords.bottom - box.top + 8;
    this.bar.style.left = `${left}px`;
    this.bar.style.top = `${top}px`;
  }
  update(u: ViewUpdate) {
    if (u.selectionSet || u.docChanged) this.render();
    if (u.selectionSet || u.geometryChanged || u.docChanged || u.focusChanged) this.schedule();
  }
  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.bar.remove();
  }
});
