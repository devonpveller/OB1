// The Cast and voices screen (rwr-voices): the caller's presenters, teams and formats, their editors, the voice picker, the sample,
// what a save writes, the two-identity planted-marker test, a person switch without a reload, and nothing kept in the browser.
// The back end is e2e/voices-fake.mjs, the SAME module the headless-Chromium lab serves (test/voices-drift.test.ts holds it to
// the server's own source).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { App } from "../src/App";
import { Voices } from "../src/screens/voices/Voices";
import { ToastProvider } from "../src/shell/Toast";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, type Who } from "../e2e/voices-fake.mjs";

let fake = createFake();
let who: Who = "alice";
let ids: Record<string, string> = {};
const MARK_A = "ALPHA-PLANTED-9f3c", MARK_B = "BRAVO-PLANTED-71d2";

function seed() {
  fake = createFake();
  ids = {};
  const A = fake.people.alice.sub, B = fake.people.bob.sub;
  ids.vMorgan = fake.seed.voice(A, { voice: "bm_george", speed: 1 });
  ids.vShared = fake.seed.voice(A, { voice: "af_bella", speed: 1.1 });
  ids.vBob = fake.seed.voice(B, { voice: "am_adam", speed: 1 });
  ids.morgan = fake.seed.presenter(A, { name: "Morgan", role: "host", personality: "Calm and precise", backstory: `${MARK_A} a researcher`, voice_id: ids.vMorgan, notes: `${MARK_A} note: too formal last time`, grounded_in: [{ kind: "topic", ref: "retrieval", label: "retrieval" }, { kind: "source", ref: "s-1", label: "A private source of mine", private: true }] });
  ids.sam = fake.seed.presenter(A, { name: "Sam", role: "co-host", voice_id: ids.vShared });
  ids.alex = fake.seed.presenter(A, { name: "Alex", role: "guest", voice_id: ids.vShared });
  ids.bobP = fake.seed.presenter(B, { name: "Bobbie", backstory: `${MARK_B} bob's`, voice_id: ids.vBob, notes: `${MARK_B} notes` });
  ids.team = fake.seed.team(A, { name: "Morning team", members: [ids.morgan, ids.sam], user_seat: 1, description: "The daily two" });
  ids.bobTeam = fake.seed.team(B, { name: "Bob's team", members: [ids.bobP], user_seat: 0 });
  ids.fmt = fake.seed.format(A, { name: "Daily brief", team_id: ids.team, kind: "briefing", use_for: ["daily"], is_default: true, briefing: "Run through the points." });
  ids.bobFmt = fake.seed.format(B, { name: "Bob's format", team_id: ids.bobTeam });
}

function stub() {
  setFetcher(async (u, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const a = fake.handle((init?.method ?? "GET").toUpperCase(), u, body, who);
    if (a.wav) return new Response(a.wav as BlobPart, { status: a.status, headers: { "content-type": "audio/wav" } });
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
}

const open = async () => {
  window.history.pushState({}, "", "/cast");
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId("voices-loading")).toBeNull());
  await screen.findByTestId("voices");
  await waitFor(() => expect(screen.queryAllByTestId("row").length).toBeGreaterThan(0));
};
const rowNames = () => screen.queryAllByTestId("row").map((r) => r.querySelector(".row-name")!.textContent);
const pick = async (name: string) => {
  fireEvent.click(screen.queryAllByTestId("row").find((r) => r.querySelector(".row-name")!.textContent === name)!);
  await waitFor(() => expect(screen.getByTestId("editor-name").textContent).toBe(name));
};
const tab = async (k: "presenters" | "teams" | "formats") => { fireEvent.click(screen.getByTestId("tab-" + k)); await waitFor(() => expect(screen.getByTestId("tab-" + k).getAttribute("aria-selected")).toBe("true")); };
const writes = () => requestLog().filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url.replace("/workbench/contract/cast", ""));
// a text field by its label (a kind radio can carry the same words as a field, e.g. Briefing)
const type = (label: string | RegExp, value: string) => {
  const els = screen.getAllByLabelText(label).filter((e) => e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !["radio", "checkbox"].includes((e as HTMLInputElement).type)));
  expect(els.length, String(label)).toBe(1);
  fireEvent.change(els[0], { target: { value } });
};

class FakeAudio {
  static made: FakeAudio[] = [];
  src: string; paused = true; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(src: string) { this.src = src; FakeAudio.made.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; seed(); stub(); FakeAudio.made = [];
  vi.stubGlobal("Audio", FakeAudio);
  (URL as any).createObjectURL = vi.fn(() => "blob:fake-sample");
  (URL as any).revokeObjectURL = vi.fn();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the lists", () => {
  it("asks only for the caller's own rows (scope=mine) and lists them with their totals", async () => {
    await open();
    const gets = requestLog().filter((r) => r.method === "GET").map((r) => r.url);
    for (const k of ["voices", "presenters", "teams", "formats"]) expect(gets.some((u) => u.startsWith(`/workbench/contract/cast/${k}?scope=mine`)), k).toBe(true);
    expect(gets.every((u) => !/scope=shared/.test(u))).toBe(true);
    expect(rowNames()).toEqual(["Alex", "Morgan", "Sam"]);
    expect(screen.getByTestId("tab-presenters").textContent).toMatch(/Presenters.*3/);
    await tab("teams");
    expect(rowNames()).toEqual(["Morning team"]);
    await tab("formats");
    expect(rowNames()).toEqual(["Daily brief"]);
  });
  it("never shows another person's rows, notes or counts (two identities, planted markers)", async () => {
    await open();
    expect(document.body.textContent).not.toMatch(/Bobbie|Bob's|BRAVO/);
    who = "bob";
    resetState();
    cleanup();
    await open();
    expect(rowNames()).toEqual(["Bobbie"]);
    expect(document.body.textContent).not.toMatch(/Morgan|ALPHA|Morning team|Daily brief/);
    expect(document.body.textContent).toMatch(/BRAVO-PLANTED-71d2 notes/);
  });
  it("a person with nothing sees empty states, not errors", async () => {
    who = "nobody";
    window.history.pushState({}, "", "/cast");
    render(<App />);
    await screen.findByTestId("voices-empty-presenters");
    await tab("teams");
    expect(screen.getByTestId("voices-empty-teams")).toBeTruthy();
    await tab("formats");
    expect(screen.getByTestId("voices-empty-formats")).toBeTruthy();
  });
  it("a list that cannot be read says so and offers Try again; it is never an empty list", async () => {
    fake.state.failList = true;
    window.history.pushState({}, "", "/cast");
    render(<App />);
    await screen.findByTestId("voices-failed");
    expect(screen.queryByTestId("voices-empty-presenters")).toBeNull();
    fake.state.failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rowNames()).toEqual(["Alex", "Morgan", "Sam"]));
  });
});

describe("a presenter: the fields, the stored-or-not-shown rule", () => {
  it("shows exactly the fields the server stores, a pitch note, and the Untested marker; no model route, no pitch control", async () => {
    await open();
    await pick("Morgan");
    for (const l of ["Name", "Role", "Personality", "Backstory", "Language", "Focus", "Stance", "Tone", "Speaking style", "Notes (only you see these)"]) expect(screen.getByLabelText(l), l).toBeTruthy();
    expect(screen.getByTestId("pitch-note").textContent).toBe("Pitch is not available on this voice engine.");
    expect(screen.getByTestId("untested").textContent).toMatch(/Untested/);
    const ed = screen.getByTestId("editor");
    expect(ed.textContent).not.toMatch(/model/i);
    expect(ed.querySelectorAll("input[type=range]").length).toBe(0);
    expect(within(ed).queryByLabelText(/pitch/i)).toBeNull();
    expect(document.querySelectorAll("select, datalist").length).toBe(0);
  });
  it("shows where the presenter is grounded, read-only and honest that the show does not use the links yet, with a private marker", async () => {
    await open();
    await pick("Morgan");
    const g = screen.getByTestId("grounded");
    expect(g.textContent).toMatch(/retrieval/);
    expect(g.textContent).toMatch(/A private source of mine/);
    expect(g.textContent).toMatch(/private to you/);
    expect(g.textContent).toMatch(/not used by the show yet/);
    expect(g.querySelectorAll("input, button").length).toBe(0);
  });
  it("Save writes only what changed, and the list and editor then show the saved values", async () => {
    await open();
    await pick("Morgan");
    type("Tone", "warm and unhurried");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(writes()).toEqual([`PATCH /presenters/${ids.morgan}`]);
    expect(JSON.parse(JSON.stringify(fake.handle("GET", `/workbench/contract/cast/presenters/${ids.morgan}`, undefined, "alice").body.tone))).toBe("warm and unhurried");
    expect(requestLog().filter((r) => r.method === "PATCH").length).toBe(1);
    expect((screen.getByLabelText("Tone") as HTMLInputElement).value).toBe("warm and unhurried");
    expect(fake.t.presenters.get(ids.morgan).personality).toBe("Calm and precise");
  });
  it("Save is off until something changed; a refused name says why and keeps the draft", async () => {
    await open();
    await pick("Morgan");
    expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(true);
    type("Name", "Sam");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("form-error");
    expect(screen.getByTestId("form-error").textContent).toMatch(/already taken/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sam");
    expect(fake.t.presenters.get(ids.morgan).name).toBe("Morgan");
  });
  it("with an own prompt the other profile fields are not offered, and the screen says only the prompt is used", async () => {
    await open();
    await pick("Morgan");
    fireEvent.click(screen.getByLabelText("My own prompt"));
    expect(screen.getByLabelText("System prompt")).toBeTruthy();
    expect(screen.queryByLabelText("Backstory")).toBeNull();
    expect(screen.getByTestId("own-note").textContent).toMatch(/only this text/);
    type("System prompt", "You are Morgan. Be brief.");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(fake.t.presenters.get(ids.morgan).system_prompt_mode).toBe("own");
    expect(fake.t.presenters.get(ids.morgan).system_prompt).toBe("You are Morgan. Be brief.");
  });
  it("notes are the owner's: 'Add notes to the profile' moves them into the backstory draft, saved only on Save", async () => {
    await open();
    await pick("Morgan");
    fireEvent.click(screen.getByTestId("notes-to-profile"));
    expect((screen.getByLabelText("Backstory") as HTMLTextAreaElement).value).toMatch(/a researcher[\s\S]*too formal last time/);
    expect((screen.getByLabelText("Notes (only you see these)") as HTMLTextAreaElement).value).toBe("");
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(fake.t.presenters.get(ids.morgan).notes).toBe("");
    expect(fake.t.presenters.get(ids.morgan).backstory).toMatch(/too formal last time/);
  });
  it("a new presenter gets its own voice link first, then the presenter; a failed presenter leaves no voice behind", async () => {
    await open();
    fireEvent.click(screen.getByTestId("new"));
    type("Name", "Riley");
    fireEvent.click(screen.getByLabelText("af_heart"));
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(writes().map((w) => w.replace(/^(\w+ \/\w+).*/, "$1"))).toEqual(["POST /voices", "POST /presenters"]);
    const riley = [...fake.t.presenters.values()].find((p) => p.name === "Riley")!;
    expect(fake.t.voices.get(riley.voice_id).voice).toBe("af_heart");
    expect(fake.t.voices.get(riley.voice_id).route).toBe("local-tts");
    // a name that is taken: nothing is left behind
    const before = fake.t.voices.size;
    fireEvent.click(screen.getByTestId("new"));
    type("Name", "Sam");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("form-error");
    await waitFor(() => expect(fake.t.voices.size).toBe(before));
  });
});

describe("the voice: picker, speed, and the sample", () => {
  it("offers the Kokoro voices as a radio list (no select), keeps a voice that is not in the list, and says pitch is not available", async () => {
    fake.t.voices.get(ids.vMorgan).voice = "zz_custom";
    await open();
    await pick("Morgan");
    const v = screen.getByTestId("voice-picker");
    expect(v.querySelectorAll("input[type=radio]").length).toBeGreaterThanOrEqual(24);
    expect((within(v).getByLabelText("zz_custom") as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll("select, datalist").length).toBe(0);
  });
  it("changing the voice of a presenter whose voice link only it uses edits that link; a speed outside the range is refused before sending", async () => {
    await open();
    await pick("Morgan");
    fireEvent.click(screen.getByLabelText("bf_emma"));
    type("Speed", "1.25");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(writes()).toEqual([`PATCH /voices/${ids.vMorgan}`]);
    expect(fake.t.voices.get(ids.vMorgan)).toMatchObject({ voice: "bf_emma", speed: 1.25 });
    clearRequestLog();
    type("Speed", "9");
    expect(screen.getByTestId("speed-error").textContent).toMatch(/between 0.5 and 2/);
    expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
  it("changing the voice of a presenter that shares its voice link makes it a link of its own: the other presenters keep theirs", async () => {
    await open();
    await pick("Sam");
    fireEvent.click(screen.getByLabelText("am_michael"));
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(writes().map((w) => w.replace(/^(\w+ \/\w+).*/, "$1"))).toEqual(["POST /voices", "PATCH /presenters"]);
    expect(fake.t.voices.get(ids.vShared).voice).toBe("af_bella");
    expect(fake.t.voices.get(fake.t.presenters.get(ids.sam).voice_id).voice).toBe("am_michael");
    expect(fake.t.presenters.get(ids.alex).voice_id).toBe(ids.vShared);
  });
  it("Play sample asks the workbench's sample route for THIS voice link and nothing else, then plays it", async () => {
    await open();
    await pick("Morgan");
    fireEvent.click(screen.getByTestId("sample-play"));
    await waitFor(() => expect(FakeAudio.made.length).toBe(1));
    expect(FakeAudio.made[0].paused).toBe(false);
    expect(fake.state.samples).toEqual([{ sub: "u-alice", id: ids.vMorgan, route: "local-tts", voice: "bm_george", speed: 1 }]);
    const urls = requestLog().map((r) => r.url);
    expect(urls.every((u) => u.startsWith("/workbench/"))).toBe(true);
    expect(urls.filter((u) => /sample/.test(u))).toEqual([`/workbench/contract/cast/voices/${ids.vMorgan}/sample`]);
    expect(urls.some((u) => /kokoro|audio\/speech|:8880|llama-cpp/i.test(u))).toBe(false);
  });
  it("an unsaved voice cannot be sampled: the button says to save first and sends nothing", async () => {
    await open();
    await pick("Morgan");
    fireEvent.click(screen.getByLabelText("bf_emma"));
    const b = screen.getByTestId("sample-play") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.getByTestId("sample-hint").textContent).toMatch(/Save to hear/);
    fireEvent.click(b);
    expect(requestLog().filter((r) => /sample/.test(r.url))).toEqual([]);
  });
  it("a sample that cannot be played says why in a sentence and never looks like it played", async () => {
    await open();
    await pick("Morgan");
    for (const [mode, text] of [["unset", /not set up/], ["down", /did not answer/]] as const) {
      fake.hook("sample", { mode });
      fireEvent.click(screen.getByTestId("sample-play"));
      await waitFor(() => expect(screen.getByTestId("sample-msg").textContent).toMatch(text));
    }
    expect(FakeAudio.made.length).toBe(0);
    fake.hook("busy", { sub: "u-alice", on: true });
    fake.hook("sample", { mode: "ok" });
    fireEvent.click(screen.getByTestId("sample-play"));
    await waitFor(() => expect(screen.getByTestId("sample-msg").textContent).toMatch(/Wait a moment/));
  });
  it("the sample of another person's voice is not reachable: the fake answers the one 404 and the screen has no way to ask", async () => {
    const mine = fake.handle("POST", `/workbench/contract/cast/voices/${ids.vBob}/sample`, undefined, "alice");
    const missing = fake.handle("POST", `/workbench/contract/cast/voices/voice-nope/sample`, undefined, "alice");
    expect([mine.status, mine.body]).toEqual([missing.status, missing.body]);
    await open();
    for (const k of ["vBob"]) expect(document.documentElement.outerHTML).not.toContain(ids[k]);
  });
});

describe("teams", () => {
  it("shows the order with the user's seat, moves a member, takes one out, adds one, and saves the new order and seat", async () => {
    await open();
    await tab("teams");
    await pick("Morning team");
    const order = () => within(screen.getByTestId("team-order")).getAllByRole("listitem").map((li) => li.querySelector(".seat-name")!.textContent);
    expect(order()).toEqual(["Morgan", "You", "Sam"]);
    fireEvent.click(screen.getByRole("button", { name: "Move You up" }));
    expect(order()).toEqual(["You", "Morgan", "Sam"]);
    fireEvent.click(screen.getByRole("button", { name: "Take Sam out" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Alex" }));
    expect(order()).toEqual(["You", "Morgan", "Alex"]);
    expect(screen.getByTestId("seat-count").textContent).toMatch(/3 of 26 seats/);
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(writes()).toEqual([`PATCH /teams/${ids.team}`]);
    expect(fake.t.teams.get(ids.team)).toMatchObject({ members: [ids.morgan, ids.alex], user_seat: 0 });
  });
  it("offers only the caller's own presenters to add, and stops at 26 seats with the reason", async () => {
    const A = fake.people.alice.sub;
    const many: string[] = [];
    for (let i = 0; i < 24; i++) many.push(fake.seed.presenter(A, { name: "Extra " + String(i).padStart(2, "0"), voice_id: ids.vShared }));
    await open();
    await tab("teams");
    await pick("Morning team");
    expect(screen.queryByRole("button", { name: /Add Bobbie/ })).toBeNull();
    for (let i = 0; i < 23; i++) fireEvent.click(screen.getByRole("button", { name: "Add Extra " + String(i).padStart(2, "0") }));
    expect(screen.getByTestId("seat-count").textContent).toMatch(/26 of 26 seats/);
    expect(screen.getAllByRole("button", { name: /^Add / }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByTestId("seat-full").textContent).toMatch(/at most 26 seats, yours included/);
  });
  it("a team with a format cannot be deleted: the refusal names the format", async () => {
    await open();
    await tab("teams");
    await pick("Morning team");
    fireEvent.click(screen.getByTestId("delete"));
    const c = screen.getByTestId("typed-confirm");
    fireEvent.change(within(c).getByTestId("typed-input"), { target: { value: "delete" } });
    fireEvent.click(within(c).getByTestId("typed-ok"));
    await screen.findByTestId("form-error");
    expect(screen.getByTestId("form-error").textContent).toMatch(/"Daily brief"/);
    expect(fake.t.teams.has(ids.team)).toBe(true);
  });
  it("creates a team from chosen presenters", async () => {
    await open();
    await tab("teams");
    fireEvent.click(screen.getByTestId("new"));
    type("Name", "Evening team");
    fireEvent.click(screen.getByRole("button", { name: "Add Alex" }));
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    const t = [...fake.t.teams.values()].find((x) => x.name === "Evening team")!;
    expect(t.members).toEqual([ids.alex]);
    expect(t.owner_sub).toBe("u-alice");
  });
});

describe("formats", () => {
  it("edits kind, uses, team, default and the briefing; kind and uses are radios and checkboxes", async () => {
    await open();
    await tab("formats");
    await pick("Daily brief");
    expect((screen.getByLabelText("Debate") as HTMLInputElement).type).toBe("radio");
    expect((screen.getByLabelText("a research run") as HTMLInputElement).type).toBe("checkbox");
    fireEvent.click(screen.getByLabelText("Debate"));
    fireEvent.click(screen.getByLabelText("a research run"));
    type("Briefing", "Take sides.");
    type("Segments", "5");
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(fake.t.formats.get(ids.fmt)).toMatchObject({ kind: "debate", use_for: ["daily", "research"], briefing: "Take sides.", segments: 5, is_default: true });
    expect(document.querySelectorAll("select, datalist").length).toBe(0);
  });
  it("a new format picks one of the caller's teams, and the default moves to it (one default)", async () => {
    await open();
    await tab("formats");
    fireEvent.click(screen.getByTestId("new"));
    type("Name", "Weekend");
    fireEvent.click(screen.getByLabelText("Morning team"));
    fireEvent.click(screen.getByLabelText("Make this my default format"));
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    const w = [...fake.t.formats.values()].find((f) => f.name === "Weekend")!;
    expect(w).toMatchObject({ team_id: ids.team, is_default: true });
    expect(fake.t.formats.get(ids.fmt).is_default).toBe(false);
    expect(screen.queryByLabelText("Bob's team")).toBeNull();
  });
});

describe("deleting", () => {
  it("a delete is confirmed by typing a word, keyed to its target; while it is open every other delete is off; moving to another row drops it", async () => {
    await open();
    await pick("Alex");
    fireEvent.click(screen.getByTestId("delete"));
    expect(screen.getByTestId("typed-confirm").getAttribute("data-target")).toBe(ids.alex);
    expect((screen.getByTestId("new") as HTMLButtonElement).disabled).toBe(true);
    await pick("Sam");
    expect(screen.queryByTestId("typed-confirm")).toBeNull();
    expect(writes()).toEqual([]);
  });
  it("deleting a presenter that is in a team is refused by the server and the screen says which team; one that is free is deleted with its own voice link", async () => {
    await open();
    await pick("Sam");
    fireEvent.click(screen.getByTestId("delete"));
    fireEvent.change(screen.getByTestId("typed-input"), { target: { value: "delete" } });
    fireEvent.click(screen.getByTestId("typed-ok"));
    await screen.findByTestId("form-error");
    expect(screen.getByTestId("form-error").textContent).toMatch(/"Morning team"/);
    clearRequestLog();
    await pick("Alex");
    fireEvent.click(screen.getByTestId("delete"));
    fireEvent.change(screen.getByTestId("typed-input"), { target: { value: "delete" } });
    fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(fake.t.presenters.has(ids.alex)).toBe(false));
    expect(fake.t.voices.has(ids.vShared)).toBe(true); // Sam still uses it
  });
});

describe("a person switch, and nothing private is kept", () => {
  it("a switch of person without a reload drops the lists, the open editor, an unsaved draft, a delete in progress and the sample", async () => {
    const view = render(<ToastProvider><Voices subject="u-alice" whoAnswered /></ToastProvider>);
    await waitFor(() => expect(rowNames().length).toBe(3));
    await pick("Morgan");
    type("Tone", `${MARK_A} unsent draft`);
    fireEvent.click(screen.getByTestId("sample-play"));
    await waitFor(() => expect(FakeAudio.made.length).toBe(1));
    who = "bob";
    resetState();
    view.rerender(<ToastProvider><Voices subject="u-bob" whoAnswered /></ToastProvider>);
    await waitFor(() => expect(rowNames()).toEqual(["Bobbie"]));
    expect(FakeAudio.made[0].paused).toBe(true);
    expect((URL as any).revokeObjectURL).toHaveBeenCalled();
    expect(document.documentElement.outerHTML).not.toMatch(/ALPHA|unsent draft|Morgan|Morning team/);
  });
  it("the page title, the URL, storage and the console carry no presenter, team or format text", async () => {
    const spies = (["log", "error", "warn"] as const).map((m) => vi.spyOn(console, m));
    await open();
    await pick("Morgan");
    type("Tone", `${MARK_A} tone`);
    fireEvent.click(screen.getByTestId("save"));
    await screen.findByTestId("saved");
    expect(document.title).toBe("Cast and voices - Research workbench");
    expect(window.location.href).not.toMatch(/Morgan|ALPHA/);
    expect(JSON.stringify({ ...window.localStorage })).toBe("{}");
    expect(JSON.stringify({ ...window.sessionStorage })).toBe("{}");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it("the screen's source writes nothing to storage, cookies or the console", () => {
    for (const f of ["Voices.tsx", "voices-data.ts"]) {
      const src = readFileSync(`src/screens/voices/${f}`, "utf8");
      expect(src, f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\./);
      expect(src, f).not.toMatch(/<select|<datalist|\bmodel_route\b|\bpitch\b.*type=/i);
    }
  });
});
