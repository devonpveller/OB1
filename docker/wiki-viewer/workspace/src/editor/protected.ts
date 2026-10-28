// Protected transclusions and citation chips on the writing surface (research-workbench P2b,
// acceptance 1-3). CodeMirror 6, pinned by package-lock.json.
//
//   a transclusion  {{ref:<id>}}text{{/ref}} is drawn as one widget over its whole span, ATOMIC
//                   (EditorView.atomicRanges: the cursor skips it; backspace takes it out in one
//                   step), and a change filter refuses any change that touches its inside without
//                   covering all of it - so the quoted text cannot be edited in place
//   a chip          [@ref:<id>] is a Decoration.widget the same way: atomic, protected, numbered
//   the break       is the ONE deliberate transaction that may rewrite a transclusion: it replaces
//                   it with its text and a chip naming THE SAME reference record (frozen to its pin)
//   stale           references the diff-id check flagged (a newer revision exists) are marked; no
//                   reference text is fetched to draw any of this - it is all in the file
import { Annotation, EditorSelection, EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { breakText, CHIP_RE, TRANSCLUSION_RE } from "../lib/grammar";

export interface ProtectedSpan {
  kind: "transclusion" | "chip";
  reference_id: string;
  from: number;
  to: number;
  text: string;
}

export const breakAnnotation = Annotation.define<boolean>();
export const setStale = StateEffect.define<Set<string>>();

export interface ProtectedOptions {
  onSelect?: (span: ProtectedSpan, pos: number) => void;
  onHover?: (span: ProtectedSpan, dom: HTMLElement) => void;
}

export function protectedSpans(text: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  const tr = new RegExp(TRANSCLUSION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = tr.exec(text))) out.push({ kind: "transclusion", reference_id: m[1].toLowerCase(), from: m.index, to: m.index + m[0].length, text: m[2] });
  const inside = (p: number) => out.some((s) => p >= s.from && p < s.to);
  const cr = new RegExp(CHIP_RE.source, "g");
  while ((m = cr.exec(text))) {
    if (!inside(m.index)) out.push({ kind: "chip", reference_id: m[1].toLowerCase(), from: m.index, to: m.index + m[0].length, text: "" });
  }
  return out.sort((a, b) => a.from - b.from);
}

const spansField = StateField.define<ProtectedSpan[]>({
  create: (s) => protectedSpans(s.doc.toString()),
  update: (v, tr) => (tr.docChanged ? protectedSpans(tr.state.doc.toString()) : v),
});

const staleField = StateField.define<Set<string>>({
  create: () => new Set(),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setStale)) return e.value;
    return v;
  },
});

class SpanWidget extends WidgetType {
  constructor(readonly span: ProtectedSpan, readonly n: number, readonly stale: boolean, readonly opts: ProtectedOptions) {
    super();
  }
  eq(o: SpanWidget) {
    return o.span.reference_id === this.span.reference_id && o.span.text === this.span.text && o.n === this.n &&
      o.stale === this.stale && o.span.kind === this.span.kind && o.span.from === this.span.from;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = this.span.kind === "transclusion" ? "ws-transclusion" : "ws-chip-wrap";
    if (this.stale) wrap.classList.add("ws-stale");
    wrap.dataset.ref = this.span.reference_id;
    wrap.setAttribute("contenteditable", "false");
    if (this.span.kind === "transclusion") {
      const t = document.createElement("span");
      t.className = "ws-transclusion-text";
      t.textContent = this.span.text;
      wrap.appendChild(t);
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ws-chip";
    chip.dataset.ref = this.span.reference_id;
    chip.textContent = `[${this.n}]`;
    if (this.stale) {
      const s = document.createElement("sup");
      s.textContent = "updated";
      chip.appendChild(s);
      chip.title = "a newer revision of this source exists";
    }
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.opts.onSelect?.(this.span, this.span.from);
    });
    chip.addEventListener("mouseenter", () => this.opts.onHover?.(this.span, chip));
    wrap.appendChild(chip);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function decorations(state: EditorState, opts: ProtectedOptions): DecorationSet {
  const spans = state.field(spansField);
  const stale = state.field(staleField);
  const numbers = new Map<string, number>();
  const b = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    if (!numbers.has(s.reference_id)) numbers.set(s.reference_id, numbers.size + 1);
    b.add(s.from, s.to, Decoration.replace({ widget: new SpanWidget(s, numbers.get(s.reference_id)!, stale.has(s.reference_id), opts) }));
  }
  return b.finish();
}

// A change may sit at a span's edge or cover it whole; one that cuts into it is refused - unless it
// is the deliberate break.
export const protectSpans = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(breakAnnotation)) return true;
  const spans = tr.startState.field(spansField, false) ?? [];
  let ok = true;
  tr.changes.iterChanges((fromA, toA) => {
    for (const s of spans) {
      const covers = fromA <= s.from && toA >= s.to;
      const touchesInside = fromA < s.to && toA > s.from && !(fromA === toA && (fromA === s.from || fromA === s.to));
      const insertInside = fromA === toA && fromA > s.from && fromA < s.to;
      if ((touchesInside || insertInside) && !covers) ok = false;
    }
  });
  return ok;
});

export function protectedExtension(opts: ProtectedOptions = {}): Extension {
  const deco = StateField.define<DecorationSet>({
    create: (s) => decorations(s, opts),
    update: (v, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setStale)) ? decorations(tr.state, opts) : v),
    provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
  });
  return [spansField, staleField, deco, protectSpans];
}

export function spansOf(state: EditorState): ProtectedSpan[] {
  return state.field(spansField, false) ?? [];
}

// The transclusion at (or touching) a position.
export function transclusionAt(state: EditorState, pos: number): ProtectedSpan | null {
  return spansOf(state).find((s) => s.kind === "transclusion" && pos >= s.from && pos <= s.to) ?? null;
}

// The deliberate break: the transclusion -> its text + a chip on the same record.
export function breakTransclusionAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const s = transclusionAt(view.state, pos);
  if (!s) return false;
  const insert = breakText({ text: s.text, reference_id: s.reference_id });
  view.dispatch({
    changes: { from: s.from, to: s.to, insert },
    selection: EditorSelection.cursor(s.from + insert.length),
    annotations: breakAnnotation.of(true),
    userEvent: "break.transclusion",
  });
  return true;
}
