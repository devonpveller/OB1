// rw-owner-private-view (slot 480): "My private material", over a fake back end (helpers.ts). The panel is marked private,
// keeps what it shows in its own state (nothing in localStorage or the dock params), offers no cite / insert / share
// action, escapes a snippet before it bolds the inert markers, says when semantic search is not available, and shows
// the sign-in notice and the default-identity line when the workbench says so.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { navEntries, panel } from "../src/shell/registry";
import { highlight, PrivatePanel } from "../src/panels/private/PrivatePanel";
import { setMe } from "../src/lib/auth";
import { resetState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const MARK = "pvtestmark";
const CLAIM = {
  id: "f5100000-0000-4000-8000-000000000001", kind: "mixed", text: `a claim ${MARK}`, status: "active", epistemic_tag: "sourced", confidence: 0.5,
  contradicted: false, created_at: "2026-10-17T12:00:00.000Z",
  private_sources: [{ id: "f5000000-0000-4000-8000-000000000001", title: `mail ${MARK}`, kind: "email", created_at: "2026-10-17T12:00:00.000Z" }],
  private_parents: [], shared_sources: [{ id: "11111111-1111-4111-8111-111111111111", title: "shared source", url: "https://example.org/a" }],
};
const me = (private_views: string) => ({ mode: "default", signed_in: true, kind: "default", subject_sub: "a", actor_sub: "a", name: "A", actor_name: "A", admin: false, impersonating: null, logout: null, private_views } as any);

beforeEach(() => {
  resetState();
  try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); setMe(null); });

describe("My private material", () => {
  it("is registered as its own panel and nav entry", () => {
    expect(panel("private")?.title).toBe("My private material");
    expect(navEntries().some((n) => n.id === "private" && n.panel === "private")).toBe(true);
  });

  it("lists the owner's claims marked private; a mixed claim shows the private link beside the shared sources; no share action; nothing stored", async () => {
    const { log } = fakeApi([["GET", "/workbench/contract/private/claims", () => ({ private: true, claims: [CLAIM], next: null })]]);
    setMe(me("signed-in"));
    render(<PrivatePanel params={{}} />);
    await act(async () => { await settle(); });
    expect(screen.getByTestId("private-banner").textContent).toMatch(/only you can see this/);
    expect(screen.getAllByText("Private").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(`a claim ${MARK}`));
    const detail = screen.getByTestId("private-claim-detail");
    expect(detail.querySelector("[data-private-source]")).toBeTruthy();
    expect(detail.querySelector("[data-shared-source]")).toBeTruthy();
    expect(document.querySelector('[data-action="cite"], [data-action="link"], [data-action="share"]')).toBeNull();
    expect(log.every((r) => r.url.startsWith("/workbench/contract/private/"))).toBe(true);
    expect(JSON.stringify({ ...localStorage })).not.toContain(MARK);
    expect(screen.queryByTestId("private-default-identity")).toBeNull();
  });

  it("escapes a snippet before it bolds the inert markers", () => {
    expect(highlight("<img src=x onerror=alert(1)> <<HL>>word<</HL>>")).toBe("&lt;img src=x onerror=alert(1)&gt; <b>word</b>");
  });

  it("semantic search not available (503): says so, shows no hit", async () => {
    fakeApi([
      ["GET", "/workbench/contract/private/claims", () => ({ private: true, claims: [], next: null })],
      ["GET", "/workbench/contract/private/sources", () => ({ error: "search is not available" }), 503],
    ]);
    render(<PrivatePanel params={{}} />);
    await act(async () => { await settle(); });
    fireEvent.click(screen.getByText("Search"));
    fireEvent.change(screen.getByTestId("private-search-mode"), { target: { value: "semantic" } });
    fireEvent.change(screen.getByTestId("private-search-q"), { target: { value: "anything" } });
    await act(async () => { fireEvent.submit(screen.getByTestId("private-search-q").closest("form")!); await settle(); });
    expect(screen.getByTestId("private-search-msg").textContent).toMatch(/not available/);
  });

  it("the sign-in notice on the empty answer, and the default-identity line when sign-in is off", async () => {
    fakeApi([["GET", "/workbench/contract/private/claims", () => ({ private: true, claims: [], next: null, sign_in_required: true })]]);
    setMe(me("default-identity"));
    render(<PrivatePanel params={{}} />);
    await act(async () => { await settle(); });
    expect(screen.getByTestId("private-sign-in")).toBeTruthy();
    expect(screen.getByTestId("private-default-identity").textContent).toMatch(/Sign-in is off/);
  });
  it("Research tab: More fetches the next page with the cursor and appends it; the button goes when next is null", async () => {
    const J = (n: number) => ({ id: `f5200000-0000-4000-8000-00000000000${n}`, root_job_id: null, created_at: "2026-10-17T12:00:00.000Z", state: "done", query: `question ${MARK} ${n}` });
    const CUR = "opaque-cursor-1";
    const { log } = fakeApi([["GET", "/workbench/contract/private/jobs", (url) => (url.includes(`before=${CUR}`) ? { private: true, jobs: [J(2)], next: null } : { private: true, jobs: [J(1)], next: CUR })]]);
    setMe(me("signed-in"));
    render(<PrivatePanel params={{}} />);
    await act(async () => { await settle(); });
    fireEvent.click(screen.getByText("Research"));
    await act(async () => { await settle(); });
    expect(screen.getByText(`question ${MARK} 1`)).toBeTruthy();
    expect(screen.queryByText(`question ${MARK} 2`)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("More")); await settle(); });
    expect(log.some((r) => r.url.includes(`/private/jobs`) && r.url.includes(`before=${CUR}`))).toBe(true);
    expect(screen.getByText(`question ${MARK} 1`)).toBeTruthy();
    expect(screen.getByText(`question ${MARK} 2`)).toBeTruthy();
    expect(screen.queryByText("More")).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain(MARK);
    expect(document.querySelector('[data-action="cite"], [data-action="link"], [data-action="share"]')).toBeNull();
  });
});
