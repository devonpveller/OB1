// The archive Undo's own guard (rwr-ideas): an Undo that outlives a switch of person does nothing. The shell's toast already
// drops every toast on a switch (ideas.test.tsx), so this test captures the Undo function itself, as a toast that was
// still held would run it, and calls it after the switch: Ideas.tsx's epoch check is the second line of defence.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Ideas } from "../src/screens/ideas/Ideas";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake } from "../e2e/ideas-fake.mjs";

const specs: { message: string; onUndo?: () => void }[] = [];
vi.mock("../src/shell/Toast", () => ({
  useToast: () => (t: { message: string; onUndo?: () => void }) => { specs.push(t); },
  ToastProvider: ({ children }: { children: unknown }) => children,
}));

describe("the archive Undo's epoch check", () => {
  beforeEach(() => { cleanup(); resetState(); specs.length = 0; clearRequestLog(); });
  it("an Undo run after the person changed sends nothing; run before, it reopens", async () => {
    const fake = createFake();
    const id = fake.addIdea(fake.people.alice.sub, { title: "Plan", summary: "words", status: "researched" });
    let who: "alice" | "bob" = "alice";
    setFetcher(async (u, init) => {
      const a = fake.handle((init?.method ?? "GET").toUpperCase(), u, init?.body ? JSON.parse(String(init.body)) : undefined, who);
      return new Response(JSON.stringify(a.body), { status: a.status });
    });
    const view = render(<Ideas subject="u-alice" whoAnswered />);
    await screen.findByTestId("idea-view");
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(specs.length).toBe(1));
    const undo = specs[0].onUndo!;
    who = "bob"; resetState();
    view.rerender(<Ideas subject="u-bob" whoAnswered />);
    clearRequestLog();
    undo();
    await new Promise((r) => setTimeout(r, 30));
    expect(requestLog()).toEqual([]);
    expect(fake.ideas.get(id).status).toBe("archived");
    // and for the same person, the same function reopens
    specs.length = 0; who = "alice";
    const again = fake.addIdea(fake.people.alice.sub, { title: "Two", summary: "more", status: "researched" });
    view.rerender(<Ideas subject="u-alice" whoAnswered />);
    await screen.findByTestId("idea-view");
    fireEvent.click(screen.getAllByTestId("idea-row").find((r) => r.textContent!.startsWith("Two"))!);
    await waitFor(() => expect(screen.getByTestId("idea-title").textContent).toBe("Two"));
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(specs.length).toBe(1));
    specs[0].onUndo!();
    await waitFor(() => expect(fake.ideas.get(again).status).toBe("researched"));
  });
});
