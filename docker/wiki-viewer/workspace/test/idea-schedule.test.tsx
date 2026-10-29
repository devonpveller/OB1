// rw-idea-schedule (front end): the schedule control in Settings and "Research now" in the refinery
// panel, over a fake back end (helpers.ts). Runs with the rest of the workspace's vitest suite in the
// viewer image's workspace stage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { TitleBar } from "../src/shell/TitleBar";
import { RefineryPanel } from "../src/panels/refinery/RefineryPanel";
import { resetState, setState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const SCHED = "/workbench/idea-schedule";
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const IMMEDIATE = { mode: "immediate", at_time: null, weekday: null, tz: "UTC", next_start: null };

async function openSettings() {
  render(<TitleBar />);
  fireEvent.click(screen.getByTestId("settings"));
  await settle();
}
const field = (n: string) => document.querySelector(`[data-testid="idea-schedule"] [data-field="${n}"]`) as HTMLInputElement;

beforeEach(() => {
  resetState();
  try {
    localStorage.clear();
  } catch { /* none */ }
});
afterEach(() => cleanup());

describe("rw-idea-schedule UI", () => {
  it("U1: Settings shows the schedule, defaulting to immediately with the browser's time zone", async () => {
    fakeApi([["GET", SCHED, () => IMMEDIATE]]);
    await openSettings();
    expect(screen.getByTestId("idea-schedule")).toBeTruthy();
    expect(field("mode").value).toBe("immediate");
    expect(field("tz").value).toBe(BROWSER_TZ);
    expect(document.querySelector('[data-testid="idea-schedule"] [data-field="at_time"]')).toBeNull();
  });

  it("U2: daily at HH:MM saves mode, time and the time zone through /workbench/idea-schedule", async () => {
    const b = fakeApi([["GET", SCHED, () => IMMEDIATE], ["PUT", SCHED, (_u, body) => ({ ...body, next_start: "2026-03-08 09:00:00+00" })]]);
    await openSettings();
    fireEvent.change(field("mode"), { target: { value: "daily" } });
    fireEvent.change(field("at_time"), { target: { value: "09:30" } });
    fireEvent.click(document.querySelector('[data-action="save-schedule"]')!);
    await settle();
    const put = b.bodies.find((x) => x.method === "PUT")!;
    expect(put.url).toBe(SCHED);
    expect(put.body).toEqual({ mode: "daily", at_time: "09:30", weekday: null, tz: BROWSER_TZ });
    expect(screen.getByTestId("idea-schedule-next").textContent).toContain("2026-03-08");
  });

  it("U3: weekly asks for a day and sends it", async () => {
    const b = fakeApi([["GET", SCHED, () => IMMEDIATE], ["PUT", SCHED, (_u, body) => ({ ...body, next_start: null })]]);
    await openSettings();
    fireEvent.change(field("mode"), { target: { value: "weekly" } });
    fireEvent.change(field("weekday"), { target: { value: "3" } });
    fireEvent.change(field("at_time"), { target: { value: "18:00" } });
    fireEvent.change(field("tz"), { target: { value: "Asia/Kolkata" } });
    fireEvent.click(document.querySelector('[data-action="save-schedule"]')!);
    await settle();
    expect(b.bodies.find((x) => x.method === "PUT")!.body).toEqual({ mode: "weekly", at_time: "18:00", weekday: 3, tz: "Asia/Kolkata" });
  });

  it("U4: a stored schedule is shown, and a refusal is shown to the user", async () => {
    fakeApi([
      ["GET", SCHED, () => ({ mode: "weekly", at_time: "07:15", weekday: 5, tz: "Europe/Berlin", next_start: null })],
      ["PUT", SCHED, () => ({ error: "unknown time zone Mars/Olympus" }), 400],
    ]);
    await openSettings();
    expect(field("mode").value).toBe("weekly");
    expect(field("at_time").value).toBe("07:15");
    expect(field("weekday").value).toBe("5");
    expect(field("tz").value).toBe("Europe/Berlin");
    fireEvent.click(document.querySelector('[data-action="save-schedule"]')!);
    await settle();
    expect(screen.getByTestId("idea-schedule-msg").textContent).toContain("unknown time zone");
  });

  it("U5: the refinery panel has Research now, which posts the idea to /workbench/idea-schedule/research-now", async () => {
    const b = fakeApi([
      ["GET", "/workbench/documents/state", () => ({ path: "documents/a.md", carries_idea: true, refinery: { id: "11111111-1111-1111-1111-111111111111", archived: false } })],
      ["GET", "/workbench/contract/ideas/", () => ({ id: "11111111-1111-1111-1111-111111111111", title: "An idea", status: "new", room: { state: "none", note: "" }, refinery: { members: { sessions: [] }, user_sources: [] } })],
      ["POST", `${SCHED}/research-now/11111111-1111-1111-1111-111111111111`, () => ({ queued: true, job_id: "j1" })],
    ]);
    setState({ documentPath: "documents/a.md" });
    render(<RefineryPanel params={{}} />);
    await settle();
    fireEvent.click(screen.getByTestId("refinery-disclosure").querySelector(".ws-summary")!);
    fireEvent.click(document.querySelector('[data-leaf="document"] .ws-leaf-label')!);
    fireEvent.click(document.querySelector('[data-action="research-now"]')!);
    await settle();
    expect(b.bodies.some((x) => x.method === "POST" && x.url.endsWith("/research-now/11111111-1111-1111-1111-111111111111"))).toBe(true);
    expect(screen.getByTestId("refinery-msg").textContent).toContain("research");
  });
});
