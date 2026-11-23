// C1 / C2 / C3 (editor half): a transclusion is protected - atomic, and an in-place edit is refused;
// the deliberate break leaves the text and a chip on THE SAME record; stale flags come from ids only.
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { breakTransclusionAt, createEditor, insertAtCursor, markStale } from "../src/editor";
import { protectedSpans, spansOf } from "../src/editor/protected";
import { linkCompletion } from "../src/editor";
import { R1, R2 } from "./helpers";

const DOC = `Intro {{ref:${R1}}}quoted words here{{/ref}} and a chip [@ref:${R2}] end.`;

function editor(doc = DOC) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const changes: string[] = [];
  const view = createEditor(host, { doc, onChange: (t) => changes.push(t), candidates: async () => [] });
  return { view, changes };
}

describe("protected transclusions", () => {
  it("C1: finds the transclusion and the chip as protected spans", () => {
    const spans = protectedSpans(DOC);
    expect(spans.map((s) => [s.kind, s.reference_id, s.text])).toEqual([["transclusion", R1, "quoted words here"], ["chip", R2, ""]]);
  });

  it("C1: the span is atomic (EditorView.atomicRanges carries it)", () => {
    const { view } = editor();
    const sets = view.state.facet(EditorView.atomicRanges).map((f) => f(view));
    const ranges: [number, number][] = [];
    for (const s of sets) s.between(0, view.state.doc.length, (from, to) => void ranges.push([from, to]));
    const t = spansOf(view.state).find((s) => s.kind === "transclusion")!;
    expect(ranges).toContainEqual([t.from, t.to]);
  });

  it("C1: typing inside the quoted text is refused; deleting part of it is refused", () => {
    const { view } = editor();
    const t = spansOf(view.state).find((s) => s.kind === "transclusion")!;
    const inside = t.from + `{{ref:${R1}}}`.length + 3;
    view.dispatch({ changes: { from: inside, insert: "XX" } });
    expect(view.state.doc.toString()).toBe(DOC);
    view.dispatch({ changes: { from: inside, to: inside + 4 } });
    expect(view.state.doc.toString()).toBe(DOC);
    view.dispatch({ changes: { from: t.from - 2, to: t.from + 5 } }); // across its opening edge
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("C1: editing next to it, and removing it whole, are allowed", () => {
    const { view } = editor();
    const t = spansOf(view.state).find((s) => s.kind === "transclusion")!;
    view.dispatch({ changes: { from: t.to, insert: "!" } });
    expect(view.state.doc.toString()).toContain("{{/ref}}!");
    view.dispatch({ changes: { from: t.from, to: t.to + 1 } });
    expect(view.state.doc.toString()).not.toContain(`{{ref:${R1}}}`);
  });

  it("C2: the deliberate break -> the text plus a chip naming the SAME record", () => {
    const { view } = editor();
    const t = spansOf(view.state).find((s) => s.kind === "transclusion")!;
    expect(breakTransclusionAt(view, t.from + 1)).toBe(true);
    const text = view.state.doc.toString();
    expect(text).toBe(`Intro quoted words here [@ref:${R1}] and a chip [@ref:${R2}] end.`);
    const chips = spansOf(view.state).filter((s) => s.kind === "chip").map((s) => s.reference_id);
    expect(chips).toEqual([R1, R2]);
    // and the broken text is ordinary text now: it can be edited
    view.dispatch({ changes: { from: 6, insert: "Q " } });
    expect(view.state.doc.toString().startsWith("Intro Q quoted")).toBe(true);
  });

  it("C3: stale ids mark the spans (no text needed)", () => {
    const { view } = editor();
    markStale(view, new Set([R2]));
    const stale = view.dom.querySelectorAll(".ws-stale");
    expect([...stale].map((e) => (e as HTMLElement).dataset.ref)).toEqual([R2]);
  });

  it("C6: inject puts the text at the cursor", () => {
    const { view } = editor("ab");
    view.dispatch({ selection: { anchor: 1 } });
    insertAtCursor(view, `[@ref:${R1}]`);
    expect(view.state.doc.toString()).toBe(`a[@ref:${R1}]b`);
  });
});

describe("[[ autocomplete", () => {
  it("C12/C18: keeps the server's order - a hidden source stays, last, tagged", async () => {
    const complete = linkCompletion(async () => [
      { kind: "source", id: "a", title: "Visible", insert: "[[source:a|Visible]]", tags: [] },
      { kind: "source", id: "b", title: "Hidden", insert: "[[source:b|Hidden]]", tags: ["hidden in this session"] },
    ]);
    const ctx = { matchBefore: () => ({ from: 0, to: 4, text: "[[Vi" }), explicit: true } as any;
    const r = await complete(ctx);
    expect(r!.options.map((o) => o.label)).toEqual(["Visible", "Hidden"]);
    expect(r!.options[1].detail).toContain("hidden in this session");
  });
});
