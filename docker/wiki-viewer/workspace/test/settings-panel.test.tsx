// rw-settings-store (front end): Settings is a regular workspace panel (registered, opened from the title bar into
// the dock, kept in the layout), the popover is gone, "Reset the layout" is kept, the user's sections read and write
// /workbench/settings, and the Admin section shows only when the workbench says the user is an admin.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { SettingsPanel } from "../src/panels/settings/SettingsPanel";
import { TitleBar } from "../src/shell/TitleBar";
import { navEntries, panel } from "../src/shell/registry";
import { layoutKey, setDock } from "../src/shell/dock";
import { resetState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const S = "/workbench/settings";
const key = (k: string, o: Record<string, unknown> = {}) => ({
  key: k, tier: "user", type: "integer", section: "refinery", position: 10, label: k, help: "", default: 14, env: "IDEA_DORMANCY_DAYS",
  read_by: "the refinery", validation: { min: 1, max: 365 }, editable: true, value: null, is_default: true, version: 0, ...o,
});
const MINE = [
  key("refinery.dormancy_days"),
  key("refinery.brainstorm", { type: "boolean", default: true, env: "IDEA_BRAINSTORM", position: 5, validation: {} }),
  key("digest.window_hours", { section: "digest", default: 24, env: "DIGEST_WINDOW_HOURS" }),
  key("digest.send_time", { section: "digest", type: "time", default: "05:00", env: null, editable: false, position: 20 }),
  key("podcast.team", { section: "digest", type: "string", default: null, env: "PODCAST_TEAM", position: 30, validation: { ref: "podcast_team" } }),
];
const ADMIN_ROWS = [
  key("podcast.archive_destination", { tier: "admin", type: "destination", section: "digest", default: { mount: "podcast-archive" }, env: null, resolved: { path: "/mounts/podcast-archive", reachable: true, via: "mount" } }),
  key("research.max_fetch", { tier: "admin", section: "research", default: 24, env: "MAX_FETCH", editable: false, read_by: "openbrain-research, every run" }),
];
const base = (admin: boolean, extra: any[] = []) => [
  ...extra,
  ["GET", `${S}/admin`, () => (admin ? { settings: ADMIN_ROWS } : { error: "only an admin" }), admin ? 200 : 403],
  ["GET", S, () => ({ admin, settings: MINE })],
  ["GET", "/workbench/contract/teams", () => ({ teams: [{ id: "team-a", name: "My team", presenters: [{ name: "Alex" }] }] })],
] as any[];
const open = async (id: string) => {
  await act(async () => { fireEvent.click(document.querySelector(`[data-section="${id}"] .ws-summary`)!); await settle(); });
};

beforeEach(() => {
  resetState();
  try {
    localStorage.clear();
  } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  setDock(null);
});
// a stand-in for the dockview api: what openPanel / defaultLayout ask of it
function fakeDock() {
  const added: any[] = [];
  let cleared = 0;
  setDock({ getPanel: () => undefined, addPanel: (o: any) => added.push(o), clear: () => { cleared++; }, toJSON: () => ({}) } as never);
  return { added, cleared: () => cleared };
}

describe("rw-settings-store: Settings is a panel", () => {
  it("P1: Settings is a registered side panel, not a nav area, and the title bar opens it in the dock (no popover)", async () => {
    expect(panel("settings")?.kind).toBe("side");
    expect(navEntries().some((n) => n.panel === "settings")).toBe(false);
    fakeApi(base(false));
    const d = fakeDock();
    render(<TitleBar />);
    fireEvent.click(screen.getByTestId("settings"));
    await settle();
    expect(d.added.map((p) => [p.id, p.component, p.title])).toEqual([["settings", "settings", "Settings"]]);
    expect(document.querySelector(".ws-popover.ws-settings")).toBeNull();
    expect(document.querySelector("[role=dialog][aria-label=settings]")).toBeNull();
  });

  it("P2: the panel keeps 'Reset the layout' (as an action at rest) and opens every section on its summary", async () => {
    fakeApi(base(false));
    const d = fakeDock();
    localStorage.setItem(layoutKey(), JSON.stringify({ panels: {} }));
    render(<SettingsPanel params={{}} />);
    await settle();
    expect(document.querySelectorAll(".ws-settings-section").length).toBe(3);
    expect(document.querySelector("[data-action]")).toBeNull();
    fireEvent.click(screen.getByTestId("reset-layout"));
    expect(localStorage.getItem(layoutKey())).toBeNull(); // the kept layout is cleared
    expect(d.cleared()).toBe(1); // and the default layout laid out again
  });

  it("P3: the schedule is the first section", async () => {
    fakeApi(base(false, [["GET", "/workbench/idea-schedule", () => ({ mode: "immediate", at_time: null, weekday: null, tz: "UTC", next_start: null })]]));
    render(<SettingsPanel params={{}} />);
    await settle();
    expect(document.querySelector(".ws-settings-section")?.getAttribute("data-section")).toBe("schedule");
    await open("schedule");
    expect(screen.getByTestId("idea-schedule")).toBeTruthy();
  });

  it("P4: My idea refinery shows my values with their defaults, and Save writes only PUT /workbench/settings/:key", async () => {
    const b = fakeApi(base(false, [["PUT", `${S}/refinery.dormancy_days`, (_u: string, body: any) => key("refinery.dormancy_days", { value: body.value, is_default: false, version: 1 })]]));
    render(<SettingsPanel params={{}} />);
    await settle();
    await open("refinery");
    const f = document.querySelector('[data-field="refinery.dormancy_days"]') as HTMLInputElement;
    expect(f.value).toBe("14");
    expect(screen.getByTestId("setting-default-refinery.dormancy_days").textContent).toContain("IDEA_DORMANCY_DAYS");
    fireEvent.change(f, { target: { value: "3" } });
    await act(async () => { fireEvent.click(document.querySelector('[data-action="save-setting"][data-key="refinery.dormancy_days"]')!); await settle(); });
    const put = b.bodies.find((x) => x.method === "PUT")!;
    expect(put.url).toBe(`${S}/refinery.dormancy_days`);
    expect(put.body).toEqual({ value: 3 });
    expect(screen.getByTestId("setting-msg-refinery.dormancy_days").textContent).toContain("saved");
    expect(document.querySelector('[data-setting="refinery.dormancy_days"]')?.getAttribute("data-default")).toBe("0");
  });

  it("P5: a refusal from the store is shown to the user", async () => {
    fakeApi(base(false, [["PUT", `${S}/digest.window_hours`, () => ({ error: "digest.window_hours: must be at most 168" }), 400]]));
    render(<SettingsPanel params={{}} />);
    await settle();
    await open("digest");
    fireEvent.change(document.querySelector('[data-field="digest.window_hours"]')!, { target: { value: "500" } });
    await act(async () => { fireEvent.click(document.querySelector('[data-action="save-setting"][data-key="digest.window_hours"]')!); await settle(); });
    expect(screen.getByTestId("setting-msg-digest.window_hours").textContent).toContain("at most 168");
  });

  it("P6: the digest section: the send time read-only, the team chosen from my teams", async () => {
    fakeApi(base(false));
    render(<SettingsPanel params={{}} />);
    await settle();
    await open("digest");
    expect(document.querySelector('[data-action="save-setting"][data-key="digest.send_time"]')).toBeNull();
    expect(document.querySelector('[data-field="digest.send_time"]')?.textContent).toBe("05:00");
    const opts = [...document.querySelectorAll('[data-field="podcast.team"] option')].map((o) => (o as HTMLOptionElement).value);
    expect(opts).toContain("team-a");
    expect(screen.getByTestId("settings-archive-note").textContent).toContain("set by an admin");
  });

  it("P7: the Admin section is shown only to an admin, and research tuning is read-only there", async () => {
    const nonAdmin = fakeApi(base(false));
    const { unmount } = render(<SettingsPanel params={{}} />);
    await settle();
    expect(document.querySelector('[data-section="admin"]')).toBeNull();
    expect(nonAdmin.bodies.some((x) => x.url.startsWith(`${S}/admin`))).toBe(false); // never even asked
    unmount();
    fakeApi(base(true));
    render(<SettingsPanel params={{}} />);
    await settle();
    expect(document.querySelector('[data-section="admin"]')).toBeTruthy();
    await open("admin");
    expect(screen.getByTestId("settings-research-tuning").textContent).toContain("MAX_FETCH");
    expect(document.querySelector('[data-action="save-setting"][data-key="research.max_fetch"]')).toBeNull();
    expect(document.querySelector('[data-action="save-setting"][data-key="podcast.archive_destination"]')).toBeTruthy();
  });
});
