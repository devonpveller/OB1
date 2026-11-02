// rw-p8a2-cleanup: the cleanup view (D5 items 4-7) over a fake back end (helpers.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { panel } from "../src/shell/registry";
import { CleanupPanel } from "../src/panels/cleanup/CleanupPanel";
import { resetState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const SUP = "22222222-2222-4222-8222-222222222222";
const UNL = "33333333-3333-4333-8333-333333333333";
const UNL_DEP = "33333333-3333-4333-8333-333333333334";
const T1 = "66666666-6666-4666-8666-666666666661";
const T2 = "66666666-6666-4666-8666-666666666662";
const AT = "2026-11-01T00:00:00.000Z";

const src = (id: string, lifecycle: string, blocking: number, severable: number, counts: Record<string, number>) => ({
  id, title: `source ${id.slice(-4)}`, url: null, lifecycle, reason: "test reason", suppressed_at: AT, unlinked_at: lifecycle === "unlinked" ? AT : null,
  counts, blocking, severable, total: blocking, erase_allowed: lifecycle === "unlinked" && blocking === 0,
});
const SOURCES = [
  src(SUP, "suppressed", 2, 2, { chunk: 1, claim_edge: 1 }),
  src(UNL, "unlinked", 0, 0, { trail_event: 2 }),
  // unlinked yet with a blocking connection: the server says erase_allowed false; the view must not offer it
  src(UNL_DEP, "unlinked", 1, 0, { document_link: 1 }),
];
const CANDS = [
  {
    kind: "proposed_contesting",
    tombstone: { id: T1, source_id: "55555555-5555-4555-8555-555555555551", url: "https://e.org/1", title: "debunked one", reason_type: "debunked", note: "was debunked", eraser_kind: "user", erased_by_you: true, erased_at: AT, confidence: 0.4, score_version: "v1" },
    evidence: [{ path: "intake", outcome: "candidate", session_id: null, note: null, attempted_at: AT, reason: "re-scored 0.9 >= floor 0.5", score: { available: true, value: 0.9, floor: 0.5, version: "v2" } }],
    dispute_preview: { criticism: { tombstone_id: T1, reason_type: "debunked", note: "was debunked", erased_at: AT }, score: { value: 0.9, floor: 0.5 } },
  },
  {
    kind: "reopen_note",
    tombstone: { id: T2, source_id: "55555555-5555-4555-8555-555555555552", url: "https://e.org/2", title: "deliberate one", reason_type: "deliberate", note: null, eraser_kind: "user", erased_by_you: false, erased_at: AT, confidence: null, score_version: null },
    evidence: [{ path: "query", outcome: "note_appended", session_id: "sess-7", note: "returned by a query; looks promising", attempted_at: AT, reason: null, score: null }],
    dispute_preview: null,
  },
  // a malformed candidate without evidence is never shown
  { kind: "reopen_note", tombstone: { id: "66666666-6666-4666-8666-666666666663", source_id: "x", url: "u", title: "no evidence", reason_type: "deliberate", note: null, eraser_kind: "user", erased_by_you: false, erased_at: AT, confidence: null, score_version: null }, evidence: [], dispute_preview: null },
];

function backend() {
  return fakeApi([
    ["GET", "/workbench/contract/cleanup/sources", () => ({ sources: SOURCES, total: SOURCES.length })],
    ["GET", "/workbench/contract/cleanup/reopen-candidates", () => ({ candidates: CANDS })],
    ["GET", "/workbench/contract/registries/erasure_reasons", () => ({ name: "erasure_reasons", entries: [{ key: "debunked" }, { key: "credibility" }, { key: "deliberate" }, { key: "retired-one", retired_at: AT }] })],
    ["GET", "/workbench/contract/sources/", () => ({ connections: [
      { kind: "chunk", ref: "0", detail: {}, blocks_erase: true, severable: true },
      { kind: "document_link", ref: "another-user-document:1", detail: { owner: "another user" }, blocks_erase: true, severable: false },
    ] })],
    ["POST", "/workbench/contract/cleanup/sources/", (u) => (u.endsWith("/erase") ? { action: {}, tombstone_id: T1, reason_type: "deliberate", note: null } : { action: {}, severed: [{ kind: "chunk", ref: "0" }], lifecycle: "suppressed", blocking: 1, rescored_claims: 0, pending_compile: [] })],
    ["POST", "/workbench/contract/cleanup/process-all", (_u, b) => ({ action: {}, reason_type: b.reason_type, erased: 1, items: b.source_ids.map((id: string, i: number) => ({ source_id: id, outcome: i === 1 ? "erased" : "blocked", severed: 0, blocking: 0, tombstone_id: null, detail: null })) })],
    ["POST", "/workbench/contract/cleanup/tombstones/", () => ({ action: {}, tombstone_id: T1, lifted_at: AT })],
  ]);
}

const leaf = (attr: string, id: string) => document.querySelector(`[${attr}="${id}"]`)!.closest("button")!;
async function open(testId: string) {
  await act(async () => { fireEvent.click(screen.getByTestId(testId).querySelector(".ws-summary")!); });
  await settle();
}

beforeEach(() => resetState());
afterEach(() => cleanup());

describe("the cleanup view (D5)", () => {
  it("is a registered side panel with a nav entry", () => {
    expect(panel("cleanup")?.kind).toBe("side");
  });

  it("lists every suppressed and unlinked source with its status and dependence counts, at rest on its summary", async () => {
    backend();
    render(<CleanupPanel params={{}} />);
    await settle();
    expect(screen.getByTestId("cleanup-summary").textContent).toBe("3 suppressed or unlinked sources");
    expect(document.querySelector("[data-cleanup-source]")).toBeNull(); // at rest: summary only
    expect(document.querySelectorAll("[data-action], .ws-actions, .ws-leaves").length).toBe(0); // with data: no leaf, no action
    await open("cleanup-sources");
    for (const s of SOURCES) {
      const el = document.querySelector(`[data-cleanup-source="${s.id}"]`)!;
      expect(el.getAttribute("data-lifecycle")).toBe(s.lifecycle);
      expect(el.closest("button")!.textContent).toContain(s.lifecycle); // the status badge
    }
    await act(async () => { fireEvent.click(leaf("data-cleanup-source", SUP)); });
    expect(document.querySelector(`[data-counts="${SUP}"]`)!.textContent).toContain("2 blocking, 2 severable: chunk 1, claim_edge 1");
  });

  it("offers erase only on an unlinked source without dependence; sever one / all on a suppressed one", async () => {
    const { bodies } = backend();
    render(<CleanupPanel params={{}} />);
    await settle();
    await open("cleanup-sources");
    // suppressed with dependence: sever all, no erase
    await act(async () => { fireEvent.click(leaf("data-cleanup-source", SUP)); });
    let acts = document.querySelector(`[data-actions="${SUP}"]`)!;
    expect(acts.querySelector('[data-action="erase"]')).toBeNull();
    expect(acts.querySelector('[data-action="sever-all"]')).toBeTruthy();
    await act(async () => { fireEvent.click(acts.querySelector('[data-action="connections"]')!); });
    await settle();
    expect(acts.querySelectorAll('[data-action="sever-one"]').length).toBe(1); // the document link is resolved by hand
    expect(acts.textContent).toContain("resolved by hand (another user)");
    await act(async () => { fireEvent.click(acts.querySelector('[data-action="sever-one"]')!); });
    await settle();
    expect(bodies.find((b) => b.url.endsWith(`/cleanup/sources/${SUP}/sever`))?.body).toEqual({ kind: "chunk", ref: "0" });
    // unlinked but still blocked: no erase
    await act(async () => { fireEvent.click(leaf("data-cleanup-source", UNL_DEP)); });
    acts = document.querySelector(`[data-actions="${UNL_DEP}"]`)!;
    expect(acts.querySelector('[data-action="erase"]')).toBeNull();
    // unlinked, nothing blocking: erase is offered
    await act(async () => { fireEvent.click(leaf("data-cleanup-source", UNL)); });
    acts = document.querySelector(`[data-actions="${UNL}"]`)!;
    expect(acts.querySelector('[data-action="erase"]')).toBeTruthy();
  });

  it("a manual erase takes a reason type (required) and an optional note; no user is sent", async () => {
    const { bodies } = backend();
    render(<CleanupPanel params={{}} />);
    await settle();
    await open("cleanup-sources");
    await act(async () => { fireEvent.click(leaf("data-cleanup-source", UNL)); });
    await act(async () => { fireEvent.click(document.querySelector('[data-action="erase"]')!); });
    const confirm = document.querySelector('[data-action="erase-confirm"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no reason type yet
    const opts = [...(screen.getByTestId("erase-reason") as HTMLSelectElement).options].map((o) => o.value);
    expect(opts).toEqual(["", "debunked", "credibility", "deliberate"]); // retired reasons are not offered
    await act(async () => { fireEvent.change(screen.getByTestId("erase-reason"), { target: { value: "credibility" } }); });
    await act(async () => { fireEvent.change(screen.getByTestId("erase-note"), { target: { value: "  why it went  " } }); });
    await act(async () => { fireEvent.submit(screen.getByTestId("erase-form")); });
    await settle();
    expect(bodies.find((b) => b.url.endsWith(`/cleanup/sources/${UNL}/erase`))?.body).toEqual({ reason_type: "credibility", note: "why it went" });
  });

  it("process all takes ONE reason type for the batch and prompts for no note", async () => {
    const { bodies } = backend();
    render(<CleanupPanel params={{}} />);
    await settle();
    expect(document.querySelector('[data-action="process-all"]')).toBeNull(); // at rest: no action
    await open("cleanup-sources");
    await act(async () => { fireEvent.click(screen.getByTestId("process-all-leaf").closest("button")!); });
    const form = screen.getByTestId("process-all");
    expect(form.querySelector("textarea, input")).toBeNull(); // no note field of any kind
    expect(form.querySelectorAll("select").length).toBe(1);
    expect((form.querySelector('[data-action="process-all"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.change(screen.getByTestId("bulk-reason"), { target: { value: "deliberate" } }); });
    await act(async () => { fireEvent.submit(form); }); // arms
    expect(bodies.some((b) => b.url.endsWith("/cleanup/process-all"))).toBe(false);
    expect(form.querySelector("textarea, input")).toBeNull(); // the confirm step prompts for nothing more
    await act(async () => { fireEvent.submit(form); });
    await settle();
    const sent = bodies.find((b) => b.url.endsWith("/cleanup/process-all"))!.body;
    expect(sent).toEqual({ reason_type: "deliberate", source_ids: SOURCES.map((s) => s.id) });
    expect(screen.getByTestId("cleanup-msg").textContent).toContain("processed 3: 1 erased, 2 blocked");
  });

  it("lists reopen candidates with their evidence, the dispute previewed, and a lift; one without evidence is not shown", async () => {
    const { bodies } = backend();
    render(<CleanupPanel params={{}} />);
    await settle();
    expect(screen.getByTestId("candidates-summary").textContent).toBe("2 reopen candidates");
    await open("cleanup-candidates");
    expect(document.querySelector('[data-candidate="66666666-6666-4666-8666-666666666663"]')).toBeNull();
    await act(async () => { fireEvent.click(leaf("data-candidate", T1)); });
    const ev = document.querySelector(`[data-evidence="${T1}"]`)!;
    expect(ev.textContent).toContain("intake candidate: scored 0.9 (floor 0.5)");
    expect(ev.textContent).toContain("(by you)");
    expect(screen.getByTestId("dispute-preview").textContent).toContain("debunked verdict");
    await act(async () => { fireEvent.click(leaf("data-candidate", T2)); });
    const ev2 = document.querySelector(`[data-evidence="${T2}"]`)!;
    expect(ev2.textContent).toContain("query note_appended, session sess-7 - returned by a query; looks promising");
    expect(ev2.textContent).toContain("(by a user)");
    await act(async () => { fireEvent.click(document.querySelector(`[data-actions="${T2}"] [data-action="lift"]`)!); });
    await settle();
    const lift = bodies.find((b) => b.url.endsWith(`/cleanup/tombstones/${T2}/lift`))!;
    expect(lift.body).toEqual({});
  });
});
