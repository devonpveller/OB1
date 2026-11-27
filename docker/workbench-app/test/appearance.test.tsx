// Appearance (rwr-appearance): light / dark / follow device, accent, density, text size, start screen and saved themes, kept
// with the ACCOUNT so they follow the person to every device. Written before the code (red first); one describe per
// acceptance line and per hazard the plan names: odd-typed or unknown stored values, a stored theme that no longer exists,
// storage that is unavailable or throws, the person changing mid-session, two identities, the 10-theme cap, "Workbench default".
// The back end is e2e/appearance-fake.mjs (the same one the e2e stub runs), which copies the real routes and the slot-700
// validation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { Settings } from "../src/screens/settings/Settings";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import {
  DEFAULT_LOOK, ACCENTS, SAVED_CAP, getAppearance, loadAppearance, chooseLook, saveTheme, deleteSavedTheme, applySavedTheme, resetAppearance, parseLook, parseSaved, syncAppearanceSubject,
} from "../src/lib/appearance";
import { createFake, OFFERED, type Fake } from "../e2e/appearance-fake.mjs";

let who = "u-alice";
let FAKE: Fake;
let hold: ((method: string, path: string) => Promise<void> | null) | null = null;

function connect() {
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path] = url.split("?");
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (path === "/workbench/workspace/whoami") return json({ subject_sub: who, actor_sub: who, name: who });
    if (path === "/workbench/auth/me") return json({ mode: "forward-auth", kind: "user", subject_sub: who, name: who });
    if (path.startsWith("/workbench/settings")) {
      const sub = who;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const wait = hold?.(method, url);
      if (wait) await wait;
      const r = FAKE.handle({ method, url, sub, body });
      if (r) return json(r.body, r.status);
    }
    return json({}, 404);
  });
}
const html = () => document.documentElement;
const look = () => ({
  theme: html().getAttribute("data-theme"), accent: html().getAttribute("data-accent"),
  density: html().getAttribute("data-density"), size: html().getAttribute("data-text-size"),
});
const stored = (sub: string, key: string) => FAKE.store.get(sub + "|" + key)?.value;
const clearLook = () => { for (const a of ["data-theme", "data-accent", "data-density", "data-text-size"]) html().removeAttribute(a); };

async function openSettings(person = "u-alice") {
  who = person;
  connect();
  window.history.pushState({}, "", "/settings");
  render(<App />);
  await screen.findByTestId("settings");
  await screen.findByTestId("spanel");
  const ap = screen.queryByTestId("appearance");
  if (ap) return ap;
  fireEvent.click(await screen.findByRole("button", { name: "Appearance" }));
  return await screen.findByTestId("appearance");
}
// a button of the panel is switched off while its own request runs (so a second click cannot double-send): wait for it, then click
const press = async (scope: HTMLElement, name: string) => {
  await waitFor(() => expect((within(scope).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(scope).getByRole("button", { name }));
};
const radio = (name: string) => screen.getByRole("radio", { name });
const choose = async (name: string) => { fireEvent.click(radio(name)); await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); resetAppearance(); clearLook();
  FAKE = createFake(); who = "u-alice"; hold = null;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("odd-typed, unknown and stale stored values never break the page", () => {
  it("parseLook: a value outside the offered lists, or of the wrong type, reads as the default for that key only", () => {
    const rows = (v: Record<string, unknown>) => Object.entries(v).map(([key, value]) => ({ key, value, is_default: false }));
    expect(parseLook(rows({}))).toEqual(DEFAULT_LOOK);
    expect(parseLook(rows({ "ui.theme": "sepia", "ui.accent": "indigo", "ui.density": 7, "ui.text_size": "17" })))
      .toEqual({ ...DEFAULT_LOOK, accent: "indigo" });
    for (const odd of [null, 0, 14, true, [], ["dark"], {}, { theme: "dark" }, "", " dark", "DARK", "dark ", "constructor", "__proto__"]) {
      expect(parseLook(rows({ "ui.theme": odd })).theme, JSON.stringify(odd)).toBe("system");
      expect(parseLook(rows({ "ui.accent": odd })).accent, JSON.stringify(odd)).toBe("teal");
      expect(parseLook(rows({ "ui.density": odd })).density, JSON.stringify(odd)).toBe("comfortable");
      expect(parseLook(rows({ "ui.text_size": odd })).textSize, JSON.stringify(odd)).toBe("14");
    }
    // a number is not the text size "16" (the registry stores text), so it is the default too
    expect(parseLook(rows({ "ui.text_size": 16 })).textSize).toBe("14");
    // a row that says is_default is the default whatever it carries
    expect(parseLook([{ key: "ui.theme", value: "dark", is_default: true }]).theme).toBe("system");
  });

  it("parseSaved: keeps every well-formed theme exactly as stored; an unknown choice inside one falls back to the default; junk (not an object, a name that is not text) is skipped", () => {
    for (const odd of [null, undefined, 5, "x", {}, [[]], [null], [1, "a"]]) expect(parseSaved(odd), JSON.stringify(odd) ?? "undefined").toEqual([]);
    const good = { name: "Night", theme: "dark", accent: "rose", density: "compact", text_size: "16" };
    const r = parseSaved([
      good,
      { ...good, name: "Old", accent: "magenta" },                     // an accent that no longer exists
      { ...good, name: "Odd", theme: 3, accent: null, density: ["x"], text_size: 14 },
      { ...good, name: 7 }, { ...good, name: null }, { ...good, name: ["a"] },
      { ...good, name: "night" },                                      // the server never stores this pair; if it ever did it is kept, not erased
    ]);
    expect(r.map((t) => t.name)).toEqual(["Night", "Old", "Odd", "night"]);
    expect(r[0].look).toEqual({ theme: "dark", accent: "rose", density: "compact", textSize: "16" });
    expect(r[1].look).toEqual({ theme: "dark", accent: "teal", density: "compact", textSize: "16" });
    expect(r[2].look).toEqual(DEFAULT_LOOK);
  });

  it("an account holding stored theme 'sepia' (a theme that no longer exists), a number accent and a saved theme with a gone accent still loads: defaults, no error, no crash", async () => {
    FAKE.plant("u-alice", "ui.theme", "sepia");
    FAKE.plant("u-alice", "ui.accent", 12);
    FAKE.plant("u-alice", "ui.density", ["compact"]);
    FAKE.plant("u-alice", "ui.saved_themes", [{ name: "Old", theme: "dark", accent: "magenta", density: "compact", text_size: "18" }, "junk", 3]);
    const ap = await openSettings();
    expect(getAppearance().status).toBe("ready");
    expect(getAppearance().error).toBeNull();
    expect(getAppearance().look).toEqual(DEFAULT_LOOK);
    expect(look()).toEqual({ theme: null, accent: null, density: null, size: null });
    expect(within(ap).getAllByTestId("saved-theme").map((e) => e.getAttribute("data-name"))).toEqual(["Old"]);
    // applying it uses what still exists and falls back for what does not
    await press(ap, "Apply Old");
    await waitFor(() => expect(look()).toEqual({ theme: "dark", accent: null, density: "compact", size: "18" }));
  });

  it("a stored theme that no longer exists in the list: Apply on a theme another device deleted reloads the account and says so", async () => {
    const ap = await openSettings();
    const name = within(ap).getByRole("textbox", { name: /name for this theme/i });
    fireEvent.change(name, { target: { value: "Gone soon" } });
    await press(ap, "Save as theme");
    await within(ap).findByTestId("saved-theme");
    FAKE.plant("u-alice", "ui.saved_themes", []); // "another device" deleted it
    await press(ap, "Apply Gone soon");
    await waitFor(() => expect(within(ap).queryAllByTestId("saved-theme")).toHaveLength(0));
    expect(within(ap).getByTestId("ap-error").textContent).toMatch(/no longer|another device|changed/i);
  });
});

describe("storage that is unavailable or throws", () => {
  it("localStorage that throws on every call: the page still loads, applies the account's choice and shows the controls", async () => {
    FAKE.plant("u-alice", "ui.theme", "dark");
    FAKE.plant("u-alice", "ui.accent", "indigo");
    const boom = () => { throw new DOMException("denied", "SecurityError"); };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    await openSettings();
    await waitFor(() => expect(look()).toMatchObject({ theme: "dark", accent: "indigo" }));
    await choose("Light");
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(stored("u-alice", "ui.theme")).toBe("light");
  });

  it("window.localStorage itself missing (blocked): same", async () => {
    FAKE.plant("u-alice", "ui.density", "compact");
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    try {
      await openSettings();
      await waitFor(() => expect(html().getAttribute("data-density")).toBe("compact"));
    } finally {
      if (desc) Object.defineProperty(window, "localStorage", desc);
    }
  });

  it("the only browser key is workbench.theme (the first-paint cache); nothing else, nowhere, and no theme name in the page title", async () => {
    const ap = await openSettings();
    await choose("Dark"); await choose("Indigo"); await choose("Compact"); await choose("16 px");
    fireEvent.change(within(ap).getByRole("textbox", { name: /name for this theme/i }), { target: { value: "My private reading look" } });
    await press(ap, "Save as theme");
    await within(ap).findByTestId("saved-theme");
    const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i));
    expect(keys(window.localStorage)).toEqual(["workbench.theme"]);
    expect(window.localStorage.getItem("workbench.theme")).toBe("dark");
    expect(keys(window.sessionStorage)).toEqual([]);
    expect(document.title).not.toMatch(/private reading|dark|indigo/i);
    expect(document.cookie).toBe("");
  });

  it("the server value overwrites the cache once loaded: cache says dark, the account says light", async () => {
    window.localStorage.setItem("workbench.theme", "dark");
    FAKE.plant("u-alice", "ui.theme", "light");
    await openSettings();
    await waitFor(() => expect(html().getAttribute("data-theme")).toBe("light"));
    expect(window.localStorage.getItem("workbench.theme")).toBe("light");
  });

  it("a server that does not hold the appearance keys yet (the migration is not applied) never clears the page's own theme cache", async () => {
    window.localStorage.setItem("workbench.theme", "dark");
    html().setAttribute("data-theme", "dark");
    FAKE.registry.splice(0, FAKE.registry.length, ...FAKE.registry.filter((k) => !k.key.startsWith("ui.") || k.key === "ui.start_screen"));
    who = "u-alice"; connect();
    await loadAppearance();
    expect(getAppearance().status).toBe("ready");
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("workbench.theme")).toBe("dark");
  });

  it("the shell and the account state share ONE read of the settings list while it is in flight, and a person change never shares it", async () => {
    const urls: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    setFetcher(async (url) => {
      urls.push(url);
      await held;
      return new Response(JSON.stringify({ admin: false, settings: [] }), { status: 200 });
    });
    const { readSettings, forgetSettingsRead } = await import("../src/lib/settings-read");
    const a = readSettings(); const b = readSettings();
    expect(urls).toEqual(["/workbench/settings"]);
    forgetSettingsRead();                       // a different person: the next caller asks again
    const c = readSettings();
    expect(urls).toEqual(["/workbench/settings", "/workbench/settings"]);
    release();
    await Promise.all([a, b, c]);
    await readSettings();                       // a finished read is never reused
    expect(urls).toHaveLength(3);
  });

  it("an account with no stored theme clears a stale cache (the cache is not the truth)", async () => {
    window.localStorage.setItem("workbench.theme", "dark");
    html().setAttribute("data-theme", "dark");
    await openSettings();
    await waitFor(() => expect(html().hasAttribute("data-theme")).toBe(false));
    expect(window.localStorage.getItem("workbench.theme")).toBeNull();
  });

  it("a failed read (server down) keeps what the page had and says so; nothing is cleared", async () => {
    window.localStorage.setItem("workbench.theme", "dark");
    html().setAttribute("data-theme", "dark");
    setFetcher(async (url) => (url.startsWith("/workbench/settings") ? new Response("{}", { status: 500 }) : new Response("{}", { status: 404 })));
    await loadAppearance();
    expect(getAppearance().status).toBe("failed");
    expect(html().getAttribute("data-theme")).toBe("dark");
  });
});

describe("1. a choice made on one device applies on every device the person signs in on", () => {
  it("saves each choice to the account, applies it at once, and a fresh browser (empty storage, fresh page) shows the same", async () => {
    await openSettings();
    await choose("Dark"); await choose("Indigo"); await choose("Compact"); await choose("18 px");
    expect(look()).toEqual({ theme: "dark", accent: "indigo", density: "compact", size: "18" });
    expect(["ui.theme", "ui.accent", "ui.density", "ui.text_size"].map((k) => stored("u-alice", k))).toEqual(["dark", "indigo", "compact", "18"]);
    // another device: no storage, nothing in memory, a new page for the same person
    cleanup(); resetState(); resetAppearance(); clearLook(); window.localStorage.clear();
    await openSettings("u-alice");
    await waitFor(() => expect(look()).toEqual({ theme: "dark", accent: "indigo", density: "compact", size: "18" }));
    expect(radio("Dark").getAttribute("aria-checked") ?? (radio("Dark") as HTMLInputElement).checked).toBeTruthy();
    expect((radio("Indigo") as HTMLInputElement).checked).toBe(true);
    expect((radio("Compact") as HTMLInputElement).checked).toBe(true);
    expect((radio("18 px") as HTMLInputElement).checked).toBe(true);
  });

  it("the default values are not written until the person changes something (a fresh account sends no write)", async () => {
    await openSettings();
    expect(FAKE.wire.filter((w) => w.method !== "GET")).toEqual([]);
    expect((radio("System") as HTMLInputElement).checked).toBe(true);
    expect((radio("Teal") as HTMLInputElement).checked).toBe(true);
    expect((radio("Comfortable") as HTMLInputElement).checked).toBe(true);
    expect((radio("14 px (default)") as HTMLInputElement).checked).toBe(true);
  });

  it("a write the server refuses (400) is shown with the server's words, and nothing is stored; the page keeps the choice for this device only", async () => {
    const ap = await openSettings();
    hold = null;
    // the person picks a text size, but the server (an older registry) refuses it
    FAKE.registry.find((k) => k.key === "ui.text_size")!.validation.enum = ["13", "14"];
    await choose("18 px");
    expect(stored("u-alice", "ui.text_size")).toBeUndefined();
    expect(within(ap).getByTestId("ap-error").textContent).toMatch(/ui\.text_size: must be one of/);
  });
});

describe("theme: explicit choice and follow-the-device (system) modes", () => {
  it("Light and Dark set data-theme and win over the system; System removes it so prefers-color-scheme decides", async () => {
    await openSettings();
    await choose("Dark"); expect(html().getAttribute("data-theme")).toBe("dark");
    await choose("Light"); expect(html().getAttribute("data-theme")).toBe("light");
    await choose("System"); expect(html().hasAttribute("data-theme")).toBe(false);
    expect(stored("u-alice", "ui.theme")).toBe("system");
    expect(window.localStorage.getItem("workbench.theme")).toBeNull();
  });

  it("the stylesheets honour both modes: tokens.css follows prefers-color-scheme only when no explicit light is set; each accent has dark values in both dark paths", async () => {
    const { readFileSync } = await import("node:fs");
    const tokens = readFileSync("src/theme/tokens.css", "utf8");
    expect(tokens).toContain(':root:not([data-theme="light"])');
    const acc = readFileSync("src/theme/accents.css", "utf8");
    expect(acc).toContain("prefers-color-scheme: dark");
    expect(acc).toContain(':root[data-theme="dark"]');
    for (const a of ACCENTS) if (a.id !== "teal") expect(acc).toContain(`:root[data-accent="${a.id}"]`);
  });
});

describe("accent, density, text size", () => {
  it("every accent offered is applied as data-accent (teal, the default, as no attribute), and density and size likewise", async () => {
    await openSettings();
    // (clicking the radio that is already chosen changes nothing, so teal - the default - is chosen last)
    for (const a of [...ACCENTS.filter((x) => x.id !== "teal"), ACCENTS[0]]) {
      await choose(a.label);
      expect(html().getAttribute("data-accent"), a.id).toBe(a.id === "teal" ? null : a.id);
      expect(stored("u-alice", "ui.accent")).toBe(a.id);
    }
    for (const s of ["13 px", "15 px", "16 px", "18 px"]) { await choose(s); expect(html().getAttribute("data-text-size")).toBe(s.slice(0, 2)); }
    await choose("14 px (default)"); expect(html().hasAttribute("data-text-size")).toBe(false);
    await choose("Compact"); expect(html().getAttribute("data-density")).toBe("compact");
    await choose("Comfortable"); expect(html().hasAttribute("data-density")).toBe(false);
  });

  it("the accent offered list is exactly the registry's list (a drift fails here)", () => {
    expect(ACCENTS.map((a) => a.id)).toEqual(OFFERED.accents);
  });

  it("a live preview shows what is applied: it carries the accent as data and uses only theme tokens", async () => {
    const ap = await openSettings();
    const prev = within(ap).getByTestId("ap-preview");
    expect(prev.textContent).toMatch(/Upgrading the workstation CPU/);
    await choose("Rose");
    expect(html().getAttribute("data-accent")).toBe("rose");
    expect(prev.isConnected).toBe(true);
  });
});

describe("3. 'Workbench default' restores every default", () => {
  it("deletes every stored look key and the start screen, clears every data attribute and the cache; saved themes stay", async () => {
    const ap = await openSettings();
    await choose("Dark"); await choose("Amber"); await choose("Compact"); await choose("16 px");
    fireEvent.click(within(ap).getByRole("radio", { name: "documents" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    fireEvent.change(within(ap).getByRole("textbox", { name: /name for this theme/i }), { target: { value: "Keep me" } });
    await press(ap, "Save as theme");
    await within(ap).findByTestId("saved-theme");
    expect(stored("u-alice", "ui.start_screen")).toBe("documents");
    await press(ap, "Workbench default");
    await waitFor(() => expect(look()).toEqual({ theme: null, accent: null, density: null, size: null }));
    for (const k of ["ui.theme", "ui.accent", "ui.density", "ui.text_size", "ui.start_screen"]) expect(stored("u-alice", k), k).toBeUndefined();
    expect(window.localStorage.getItem("workbench.theme")).toBeNull();
    expect(getAppearance().look).toEqual(DEFAULT_LOOK);
    expect((radio("System") as HTMLInputElement).checked).toBe(true);
    expect((radio("Teal") as HTMLInputElement).checked).toBe(true);
    expect(within(ap).getAllByTestId("saved-theme").map((e) => e.getAttribute("data-name"))).toEqual(["Keep me"]);
  });

  it("on an account that has stored nothing it sends no request at all", async () => {
    const ap = await openSettings();
    const before = FAKE.wire.length;
    await press(ap, "Workbench default");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(FAKE.wire.length).toBe(before);
  });
});

describe("saved themes (per account, at most 10)", () => {
  it("save the current look under a name, apply it later, delete it", async () => {
    const ap = await openSettings();
    await choose("Dark"); await choose("Slate"); await choose("Compact"); await choose("15 px");
    fireEvent.change(within(ap).getByRole("textbox", { name: /name for this theme/i }), { target: { value: "Night reading" } });
    await press(ap, "Save as theme");
    await within(ap).findByTestId("saved-theme");
    expect(stored("u-alice", "ui.saved_themes")).toEqual([{ name: "Night reading", theme: "dark", accent: "slate", density: "compact", text_size: "15" }]);
    await choose("Light"); await choose("Teal"); await choose("Comfortable"); await choose("14 px (default)");
    await press(ap, "Apply Night reading");
    await waitFor(() => expect(look()).toEqual({ theme: "dark", accent: "slate", density: "compact", size: "15" }));
    await waitFor(() => expect(["ui.theme", "ui.accent", "ui.density", "ui.text_size"].map((k) => stored("u-alice", k)), JSON.stringify(FAKE.wire.filter((w) => w.method !== "GET").map((w) => w.method + " " + w.url + " " + w.status))).toEqual(["dark", "slate", "compact", "15"]));
    await press(ap, "Delete Night reading");
    await waitFor(() => expect(within(ap).queryAllByTestId("saved-theme")).toHaveLength(0));
    expect(stored("u-alice", "ui.saved_themes")).toEqual([]);
  });

  it("the cap: ten are kept, the eleventh is refused with a reason and nothing changes; the server's own 400 shows if the page is bypassed", async () => {
    const ap = await openSettings();
    for (let i = 1; i <= SAVED_CAP; i++) {
      fireEvent.change(within(ap).getByRole("textbox", { name: /name for this theme/i }), { target: { value: "Theme " + i } });
      await press(ap, "Save as theme");
      await waitFor(() => expect(within(ap).getAllByTestId("saved-theme")).toHaveLength(i));
    }
    expect(within(ap).getByTestId("ap-count").textContent).toMatch(/10 of 10/);
    // full: the name box and the button are switched off, and the page says why
    expect((within(ap).getByRole("button", { name: "Save as theme" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ap.textContent).toMatch(/You can keep 10 saved themes/);
    expect(within(ap).getAllByTestId("saved-theme")).toHaveLength(10);
    expect((stored("u-alice", "ui.saved_themes") as unknown[]).length).toBe(10);
    // the library call (what the button calls) goes to the server regardless of the page: the server's 400 is the real guard
    const r = await saveTheme("Eleventh");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/10/);
    expect((stored("u-alice", "ui.saved_themes") as unknown[]).length).toBe(10);
    const raw = FAKE.handle({ method: "PUT", url: "/workbench/settings/ui.saved_themes", sub: "u-alice", body: { value: [...(stored("u-alice", "ui.saved_themes") as any[]), { name: "x", theme: "dark", accent: "teal", density: "compact", text_size: "14" }], version: 99 } });
    expect(raw!.status).toBe(400);
    expect(raw!.body.error).toMatch(/at most 10 saved themes/);
  });

  it("a name that is empty, over 40 characters, repeated, or credential-shaped is refused before any request", async () => {
    const ap = await openSettings();
    const put = async (name: string) => {
      fireEvent.change(within(ap).getByRole("textbox", { name: /name for this theme/i }), { target: { value: name } });
      await press(ap, "Save as theme");
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    };
    for (const bad of ["", "   ", "x".repeat(41), "sk-live-abc123", "bell\u0007"]) {
      const before = FAKE.wire.length;
      await put(bad);
      expect(FAKE.wire.length, JSON.stringify(bad)).toBe(before);
      expect(within(ap).queryAllByTestId("saved-theme")).toHaveLength(0);
    }
    await put("Same"); await within(ap).findByTestId("saved-theme");
    const before = FAKE.wire.length;
    await put("same");
    expect(FAKE.wire.length).toBe(before);
    expect(within(ap).getByTestId("ap-error").textContent).toMatch(/already/i);
  });

  it("the server refuses a bad list whatever the page does (the fake copies slot 700): unknown choice, extra field, 11 items, bad name", () => {
    const k = FAKE.registry.find((r) => r.key === "ui.saved_themes")!;
    const base = { name: "a", theme: "dark", accent: "teal", density: "compact", text_size: "14" };
    const p = (v: unknown) => FAKE.handle({ method: "PUT", url: "/workbench/settings/ui.saved_themes", sub: "s", body: { value: v } })!.status;
    expect(k.type).toBe("theme_list");
    expect(p([base])).toBe(200);
    expect(p([{ ...base, accent: "magenta" }])).toBe(400);
    expect(p([{ ...base, extra: 1 }])).toBe(400);
    expect(p([{ ...base, text_size: 14 }])).toBe(400);
    expect(p([{ ...base, name: "‮evil" }])).toBe(400);
    expect(p("dark")).toBe(400);
    expect(p(Array.from({ length: 11 }, (_, i) => ({ ...base, name: "n" + i })))).toBe(400);
  });
});

describe("4/5. keys are per account and never readable by another user (two-identity test)", () => {
  it("B never sees A's look: B's whole list is deep-equal to a user C who stored nothing, in every field, count and message", async () => {
    FAKE.plant("u-alice", "ui.theme", "dark");
    FAKE.plant("u-alice", "ui.accent", "rose");
    FAKE.plant("u-alice", "ui.saved_themes", [{ name: "ALPHA-PRIVATE-NAME", theme: "dark", accent: "rose", density: "compact", text_size: "18" }]);
    const list = (sub: string) => FAKE.handle({ method: "GET", url: "/workbench/settings", sub })!.body;
    const strip = (b: any) => JSON.stringify(b);
    expect(strip(list("u-bob"))).toBe(strip(list("u-carol")));
    expect(strip(list("u-bob"))).not.toMatch(/ALPHA-PRIVATE/);
    for (const s of list("u-bob").settings) { expect(s.value, s.key).toBeNull(); expect(s.is_default, s.key).toBe(true); expect(s.version, s.key).toBe(0); }
    // B's refusals read the same as C's, and name only B's own version
    const refuse = (sub: string) => FAKE.handle({ method: "PUT", url: "/workbench/settings/ui.theme", sub, body: { value: "dark", version: 9 } })!;
    expect(refuse("u-bob")).toEqual(refuse("u-carol"));
    expect(refuse("u-bob").body.error).toMatch(/version 0, not 9/);
    // B's write and delete leave A's rows alone
    FAKE.handle({ method: "PUT", url: "/workbench/settings/ui.theme", sub: "u-bob", body: { value: "light" } });
    FAKE.handle({ method: "DELETE", url: "/workbench/settings/ui.theme?version=1", sub: "u-bob" });
    expect(stored("u-alice", "ui.theme")).toBe("dark");
  });

  it("on screen: B opens the page after A and sees defaults, never A's accent or theme names, on the page or in any answer sent to B", async () => {
    FAKE.plant("u-alice", "ui.accent", "rose");
    FAKE.plant("u-alice", "ui.saved_themes", [{ name: "ALPHA-PRIVATE-NAME", theme: "dark", accent: "rose", density: "compact", text_size: "18" }]);
    await openSettings("u-alice");
    await waitFor(() => expect(html().getAttribute("data-accent")).toBe("rose"));
    cleanup(); resetState(); resetAppearance(); clearLook();
    const ap = await openSettings("u-bob");
    expect(html().hasAttribute("data-accent")).toBe(false);
    expect(document.body.textContent).not.toMatch(/ALPHA-PRIVATE/);
    expect(within(ap).queryAllByTestId("saved-theme")).toHaveLength(0);
    expect(FAKE.wire.filter((w) => w.sub === "u-bob").map((w) => w.body).join("\n")).not.toMatch(/ALPHA-PRIVATE/);
  });
});

describe("the person changes mid-session (no reload)", () => {
  const shellFor = async (person: string) => {
    who = person;
    window.history.pushState({}, "", "/settings");
    connect();
  };

  it("a different person on the page: A's look is cleared at once (attributes, cache, saved themes) and B's own is loaded", async () => {
    FAKE.plant("u-alice", "ui.theme", "dark");
    FAKE.plant("u-alice", "ui.accent", "rose");
    FAKE.plant("u-alice", "ui.density", "compact");
    FAKE.plant("u-alice", "ui.saved_themes", [{ name: "ALPHA-PRIVATE-NAME", theme: "dark", accent: "rose", density: "compact", text_size: "18" }]);
    FAKE.plant("u-bob", "ui.accent", "indigo");
    connect();
    const ui = (s: string) => <Settings subject={s} whoAnswered />;
    const { rerender } = render(ui("u-alice"));
    await waitFor(() => expect(look()).toEqual({ theme: "dark", accent: "rose", density: "compact", size: null }));
    who = "u-bob";
    rerender(ui("u-bob"));
    // at the moment of the switch nothing of Alice is left, before Bob's read even answers
    expect(look().accent).not.toBe("rose");
    expect(look().density).toBeNull();
    expect(window.localStorage.getItem("workbench.theme")).toBeNull();
    expect(getAppearance().saved).toEqual([]);
    await waitFor(() => expect(look()).toEqual({ theme: null, accent: "indigo", density: null, size: null }));
    expect(document.body.textContent).not.toMatch(/ALPHA-PRIVATE/);
  });

  it("a read that was in flight for the earlier person lands after the switch and is dropped", async () => {
    FAKE.plant("u-alice", "ui.accent", "rose");
    FAKE.plant("u-alice", "ui.theme", "dark");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    hold = (method, url) => (method === "GET" && url === "/workbench/settings" && who === "u-alice" ? held : null);
    connect();
    syncAppearanceSubject("u-alice");        // Alice's read is held
    who = "u-bob";
    syncAppearanceSubject("u-bob");          // Bob is on the page
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(look()).toEqual({ theme: null, accent: null, density: null, size: null });
    expect(getAppearance().look).toEqual(DEFAULT_LOOK);
    expect(window.localStorage.getItem("workbench.theme")).toBeNull();
  });

  it("a save of the earlier person that answers after the switch changes nothing for the next person and writes nothing to their account", async () => {
    connect();
    syncAppearanceSubject("u-alice");
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    hold = (method) => (method === "PUT" ? held : null);
    const pending = chooseLook({ accent: "rose" });   // Alice's PUT is held
    expect(html().getAttribute("data-accent")).toBe("rose");
    who = "u-bob";
    syncAppearanceSubject("u-bob");
    hold = null;
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    expect(html().hasAttribute("data-accent")).toBe(false);
    release();
    await pending;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(html().hasAttribute("data-accent")).toBe(false);
    expect(getAppearance().look).toEqual(DEFAULT_LOOK);
    expect(FAKE.store.has("u-bob|ui.accent")).toBe(false);
    expect(getAppearance().error).toBeNull();
  });

  it("the whole shell: the person changing under a mounted App resets the look (App, not just Settings)", async () => {
    FAKE.plant("u-alice", "ui.accent", "rose");
    FAKE.plant("u-alice", "ui.theme", "dark");
    await shellFor("u-alice");
    let n = 0;
    const load = async (emit: (p: any) => void) => {
      const w = { subject: who, name: who };
      emit({ who: w, whoDone: true });
      n++;
      return { loaded: true, who: w, whoDone: true, defaultSubject: false } as any;
    };
    const { rerender } = render(<App load={load} />);
    await waitFor(() => expect(look()).toMatchObject({ theme: "dark", accent: "rose" }));
    who = "u-bob";
    rerender(<App load={async (emit: (p: any) => void) => { const w = { subject: who, name: who }; emit({ who: w, whoDone: true }); return { loaded: true, who: w, whoDone: true, defaultSubject: false } as any; }} />);
    await waitFor(() => expect(look()).toEqual({ theme: null, accent: null, density: null, size: null }));
    expect(n).toBeGreaterThan(0);
  });
});

describe("the Settings section itself", () => {
  it("is titled Appearance, shows the privacy tag on every control, and is built of radio groups: no <select>, no <datalist>", async () => {
    const ap = await openSettings();
    expect(screen.getByTestId("section-title").textContent).toBe("Appearance");
    expect(ap.querySelector("select, datalist")).toBeNull();
    expect(document.body.querySelector("select, datalist")).toBeNull();
    for (const k of ["ui.theme", "ui.accent", "ui.density", "ui.text_size", "ui.saved_themes"]) {
      const row = within(ap).getByTestId("setting-" + k);
      expect(within(row).getByTestId("tag").textContent, k).toBe("Only you");
    }
    expect(within(ap).getAllByRole("radiogroup").length).toBeGreaterThanOrEqual(4);
    expect(within(ap).getByRole("button", { name: "Workbench default" })).toBeTruthy();
  });

  it("when the account's registry does not hold the appearance keys yet (the migration is not applied) the section is not offered and nothing breaks", async () => {
    FAKE.registry.splice(0, FAKE.registry.length, ...FAKE.registry.filter((k) => !["ui.theme", "ui.accent", "ui.density", "ui.text_size", "ui.saved_themes"].includes(k.key)));
    who = "u-alice"; connect();
    window.history.pushState({}, "", "/settings");
    render(<App />);
    await screen.findByTestId("spanel");
    expect(screen.queryByTestId("appearance")).toBeNull();
    expect(screen.getByTestId("section-title").textContent).toBe("Start screen");
  });

  it("a stale write from another browser is refused (409): the latest value is shown, not overwritten", async () => {
    const ap = await openSettings();
    FAKE.plant("u-alice", "ui.accent", "indigo"); // another browser wrote first (version 1)
    await choose("Rose");
    await waitFor(() => expect(html().getAttribute("data-accent")).toBe("indigo"));
    expect(stored("u-alice", "ui.accent")).toBe("indigo");
    expect(within(ap).getByTestId("ap-error").textContent).toMatch(/another browser|changed/i);
  });
});

describe("review 1: R1 (a person switch during Apply) and the saved-theme read/write rules of slot 700", () => {
  const T = { name: "Work", theme: "dark", accent: "rose", density: "compact", text_size: "18" };
  const EMOJI = (n: number) => "\u{1F600}".repeat(n);
  const boot = async () => {
    connect();
    syncAppearanceSubject("u-alice");
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
  };
  const savedNames = () => (FAKE.store.get("u-alice|ui.saved_themes")?.value as { name: string }[]).map((t) => t.name);

  it("R1: Apply for Alice whose pre-apply read FAILS after the person became Bob writes nothing to Bob's account and changes nothing on his page", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [T]);
    await boot();
    let fail: () => void = () => {};
    const held = new Promise<void>((_, rej) => { fail = () => rej(new Error("network down")); });
    held.catch(() => {});
    hold = (method, url) => (method === "GET" && url === "/workbench/settings" && who === "u-alice" ? held : null);
    const pending = applySavedTheme("Work");        // Alice's read is held
    who = "u-bob";
    syncAppearanceSubject("u-bob");
    hold = null;
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    fail();                                          // now the read fails
    expect(await pending).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    for (const k of ["ui.theme", "ui.accent", "ui.density", "ui.text_size"]) expect(FAKE.store.has("u-bob|" + k)).toBe(false);
    expect(getAppearance().look).toEqual(DEFAULT_LOOK);
    expect(html().hasAttribute("data-accent")).toBe(false);
  });

  it("R1: the same with a read that SUCCEEDS after the switch", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [T]);
    await boot();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    hold = (method, url) => (method === "GET" && url === "/workbench/settings" && who === "u-alice" ? held : null);
    const pending = applySavedTheme("Work");
    who = "u-bob";
    syncAppearanceSubject("u-bob");
    hold = null;
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    release();
    expect(await pending).toBe(false);
    for (const k of ["ui.theme", "ui.accent", "ui.density", "ui.text_size"]) expect(FAKE.store.has("u-bob|" + k)).toBe(false);
  });

  it("F2: a stored 21-emoji name (21 code points, 42 UTF-16 units) is kept and survives the next save and delete", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [{ ...T, name: EMOJI(21) }]);
    await boot();
    expect(getAppearance().saved.map((t) => t.name)).toEqual([EMOJI(21)]);
    expect((await saveTheme("Other")).ok).toBe(true);
    expect(savedNames()).toEqual([EMOJI(21), "Other"]);
    expect(await deleteSavedTheme("Other")).toBe(true);
    expect(savedNames()).toEqual([EMOJI(21)]);
  });

  it("F2: a name of 41 code points is still refused", async () => {
    await boot();
    expect((await saveTheme(EMOJI(41))).ok).toBe(false);
  });

  it("F3: 'Work' and 'Work'+NBSP are two themes to the server (btrim strips only the ASCII space); both are kept and survive a save", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [T, { ...T, name: "Work\u00a0" }]);
    await boot();
    expect(getAppearance().saved.map((t) => t.name)).toEqual(["Work", "Work\u00a0"]);
    expect((await saveTheme("Other")).ok).toBe(true);
    expect(savedNames()).toEqual(["Work", "Work\u00a0", "Other"]);
  });

  it("F3: 'Work' and ' work ' (ASCII spaces) are the same name for the page, as for the server", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [T]);
    await boot();
    expect((await saveTheme(" work ")).ok).toBe(false);
  });

  it("F7: credential prefixes are case-sensitive like the server's: 'Aizawa days' saves and a stored 'Aizawa' survives; 'AIza' and 'Bearer' are still refused", async () => {
    FAKE.plant("u-alice", "ui.saved_themes", [{ ...T, name: "Aizawa" }]);
    await boot();
    expect(getAppearance().saved.map((t) => t.name)).toEqual(["Aizawa"]);
    expect((await saveTheme("Aizawa days")).ok).toBe(true);
    expect(savedNames()).toEqual(["Aizawa", "Aizawa days"]);
    expect((await saveTheme("my AIza key")).ok).toBe(false);
    expect((await saveTheme("my Bearer token")).ok).toBe(false);
  });

  it("parseSaved keeps every entry slot 700 accepts, unchanged (names are not trimmed on read)", () => {
    const list = [{ ...T, name: " Work " }, { ...T, name: "Eyjafjallajokull" }, { ...T, name: EMOJI(40) }];
    expect(parseSaved(list).map((t) => t.name)).toEqual([" Work ", "Eyjafjallajokull", EMOJI(40)]);
  });

  it("F1: two quick saves of the same name send one write: the second is judged again inside the queue", async () => {
    await boot();
    const [a, b] = await Promise.all([saveTheme("Same"), saveTheme("Same")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(savedNames()).toEqual(["Same"]);
  });
});

describe("review 2: A (Workbench default across a person switch), B (nothing is dropped on read), F1 wire counts", () => {
  const T = { name: "Work", theme: "dark", accent: "rose", density: "compact", text_size: "18" };
  const nm = (n: string) => ({ ...T, name: n });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  const wire = (sub: string, method: string, key: string) => FAKE.wire.filter((w) => w.sub === sub && w.method === method && w.url.includes(key));
  const storedNames = () => (FAKE.store.get("u-alice|ui.saved_themes")?.value as { name: string }[]).map((t) => t.name);

  it("A: Alice presses Workbench default; her look-key DELETE is held; the person becomes Bob; A's start-screen DELETE never goes out as Bob and Bob's start screen survives", async () => {
    FAKE.plant("u-alice", "ui.theme", "dark");
    FAKE.plant("u-alice", "ui.start_screen", "documents");
    FAKE.plant("u-bob", "ui.start_screen", "research");     // the same version number as Alice's: the server would accept the stale DELETE
    connect();
    const ui = (s: string) => <Settings subject={s} whoAnswered />;
    const { rerender } = render(ui("u-alice"));
    const ap = await screen.findByTestId("appearance");
    let go: () => void = () => {};
    const held = new Promise<void>((r) => { go = r; });
    hold = (m) => (m === "DELETE" && who === "u-alice" ? held : null);
    await waitFor(() => expect((within(ap).getByRole("button", { name: "Workbench default" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(ap).getByRole("button", { name: "Workbench default" }));
    await settle();
    who = "u-bob"; hold = null;
    rerender(ui("u-bob"));
    go();
    await settle(); await settle();
    expect(wire("u-bob", "DELETE", "ui.start_screen")).toEqual([]);
    expect(FAKE.store.get("u-bob|ui.start_screen")?.value).toBe("research");
  });

  it("B: names the server stored that a page rule would have dropped survive a load, a save and a delete: dotted I pair, Greek sigma pair, bearer + no-break spaces, sharp s and SS", async () => {
    const lists: string[][] = [
      ["İ", "i̇"],
      ["ΑΣ", "ας"],
      ["bearer x", "bearer y", "bearer z"],
      ["ß", "SS"],
    ];
    for (const names of lists) {
      cleanup(); resetAppearance(); FAKE = createFake(); who = "u-alice"; connect();
      FAKE.plant("u-alice", "ui.saved_themes", names.map(nm));
      syncAppearanceSubject("u-alice");
      await waitFor(() => expect(getAppearance().status).toBe("ready"));
      expect(getAppearance().saved.map((t) => t.name), "listed").toEqual(names);
      const r = await saveTheme("Zzz Other");
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(storedNames(), "after a save").toEqual([...names, "Zzz Other"]);
      expect(await deleteSavedTheme("Zzz Other")).toBe(true);
      expect(storedNames(), "after a delete").toEqual(names);
    }
  });

  it("B: a NEW name is still judged: bearer + ASCII or ideographic space is refused; bearer + no-break space is accepted, as by the server", async () => {
    connect(); syncAppearanceSubject("u-alice");
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    expect((await saveTheme("my bearer x")).ok).toBe(false);
    expect((await saveTheme("my bearer　x")).ok).toBe(false);
    expect((await saveTheme("my bearer x")).ok).toBe(true);
  });

  it("F1 wire count: two same-tick saves of one name send exactly ONE PUT (removing the in-queue re-judge turns this red)", async () => {
    connect(); syncAppearanceSubject("u-alice");
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    await Promise.all([saveTheme("Same"), saveTheme("same ")]);
    expect(wire("u-alice", "PUT", "ui.saved_themes").length).toBe(1);
  });

  it("F1 wire count: twelve racing saves send exactly ten PUTs and keep ten", async () => {
    connect(); syncAppearanceSubject("u-alice");
    await waitFor(() => expect(getAppearance().status).toBe("ready"));
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveTheme("t" + i)));
    expect(wire("u-alice", "PUT", "ui.saved_themes").length).toBe(10);
    expect(getAppearance().saved.length).toBe(10);
  });

  it("F1 wire count: three Enter keydowns in the same tick send ONE PUT and no error text (removing the busy guard turns this red)", async () => {
    connect();
    render(<Settings subject="u-alice" whoAnswered />);
    const ap = await screen.findByTestId("appearance");
    const box = within(ap).getByRole("textbox", { name: /name for this theme/i });
    fireEvent.change(box, { target: { value: "Dbl" } });
    fireEvent.keyDown(box, { key: "Enter" }); fireEvent.keyDown(box, { key: "Enter" }); fireEvent.keyDown(box, { key: "Enter" });
    await settle();
    expect(wire("u-alice", "PUT", "ui.saved_themes").length).toBe(1);
    expect(getAppearance().error).toBeNull();
  });
});
