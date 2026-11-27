// Research, Library and Podcast defaults, and the admin research limits (rwr-settings-defaults): the sections, the ceiling a default may
// not pass (the page keeps the server's rules and its words), presets and never a raw number for an admin, the log, the person-epoch
// guard (a held answer that lands after the person changed is dropped), hidden suggestions, and the Start research dialog's own
// defaults (depth offered first, ask before a big run). A fake back end that applies the rules of the real routes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { Settings } from "../src/screens/settings/Settings";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { numberProblem, sectionsOf, type Setting } from "../src/screens/settings/settings-data";

const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const row = (o: Partial<Setting> & Pick<Setting, "key" | "type" | "section" | "label">): Setting => ({
  tier: "user", position: 10, help: "", default: null, env: null, validation: {}, editable: true, tag: "only_you", value: null, is_default: true, version: 0, ...o,
});
const USER_KEYS = (): Setting[] => [
  row({ key: "ui.start_screen", type: "enum", section: "ui", label: "Start screen", validation: { enum: ["home", "library"] } }),
  row({ key: "library.recent", type: "ref_list", section: "ui", label: "Recently viewed" }),
  row({ key: "refinery.brainstorm", type: "boolean", section: "refinery", label: "Brainstorm on my ideas", default: true, tag: "on_server" }),
  row({ key: "research.default_depth", type: "enum", section: "research", label: "Default research depth", default: "standard", validation: { enum: ["quick", "standard", "deep"] } }),
  row({ key: "research.ask_over_fetch", type: "integer", section: "research", position: 20, label: "Ask me before a run reads more than this many pages", validation: { min: 1, max: 200 } }),
  row({ key: "library.how_far_out", type: "integer", section: "ui", position: 110, label: "How far out the Library looks", default: 2, validation: { min: 1, max: 3 } }),
  row({ key: "library.recent_size", type: "integer", section: "ui", position: 120, label: "Recently viewed: how many items to keep", default: 24, validation: { min: 1, max: 24 } }),
  row({ key: "library.clear_on_signout", type: "boolean", section: "ui", position: 130, label: "Clear Recently viewed when I sign out", default: false }),
  row({ key: "library.hidden_suggestions", type: "ref_list", section: "ui", position: 140, label: "Hidden suggestions", validation: { max_items: 100 } }),
  row({ key: "podcast.episode_minutes", type: "integer", section: "digest", position: 120, label: "Episode length (minutes)", default: 10, validation: { min: 3, max: 30 }, tag: "on_server" }),
];

type Group = { group: string; label: string; help: string; current: string; presets: { preset: string; label: string; help: string; values: { key: string; label: string; value: unknown }[] }[]; values: any[] };
const GROUPS = (): Group[] => [
  { group: "run_size", label: "How big a research run is", help: "Pages, rounds and time.", current: "standard",
    presets: ["small", "standard", "large"].map((p) => ({ preset: p, label: p[0].toUpperCase() + p.slice(1), help: "", values: [] })),
    values: [{ key: "research.max_fetch", label: "Pages retrieved per run", value: 24, is_default: true, min: 6, max: 60 }] },
  { group: "judgement", label: "How strict research is about evidence", help: "", current: "standard",
    presets: ["strict", "standard", "open"].map((p) => ({ preset: p, label: p[0].toUpperCase() + p.slice(1), help: "", values: [] })), values: [] },
];

type Srv = {
  who: string; admin: boolean; ceiling: number; stored: Map<string, { value: unknown; version: number }>; groups: Group[]; log: any[];
  hold: { path: RegExp; release: () => void; gate: Promise<void> } | null; puts: { path: string; body: any }[];
};
let srv: Srv;
const newSrv = (): Srv => ({ who: "u-alice", admin: false, ceiling: 24, stored: new Map(), groups: GROUPS(), log: [], hold: null, puts: [] });

function connect(s: Srv) {
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path] = url.split("?");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const me = s.who;
    const adminOnly = () => (s.admin ? null : j({ error: "only an admin may read or change the shared settings" }, 403));
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: me, actor_sub: me, name: me });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: me, name: me });
    if (path === "/workbench/settings" && method === "GET") {
      const list = USER_KEYS().map((k) => {
        const st = s.stored.get(me + "|" + k.key);
        const withCeil = k.key === "research.ask_over_fetch" ? { ceiling: s.ceiling, ceiling_phrase: "the most pages one research run may read, set by an admin" } : {};
        return { ...k, ...withCeil, value: st ? st.value : null, is_default: !st, version: st?.version ?? 0 };
      });
      return j({ admin: s.admin, settings: list });
    }
    if (path === "/workbench/settings/admin" && method === "GET") return adminOnly() ?? j({ settings: [row({ key: "research.max_fetch", tier: "admin", type: "integer", section: "research", label: "ADMINONLY Pages", default: 24, editable: false, tag: "admin_all", validation: { min: 6, max: 60 } })] });
    if (path === "/workbench/settings/admin/limits" && method === "GET") return adminOnly() ?? j({ groups: s.groups });
    if (path === "/workbench/settings/admin/limits/log") return adminOnly() ?? j({ log: s.log });
    const lm = path.match(/^\/workbench\/settings\/admin\/limits\/([a-z_]+)$/);
    if (lm) {
      const deny = adminOnly();
      if (deny) return deny;
      s.puts.push({ path: method + " " + path, body });
      if (s.hold && s.hold.path.test(path)) await s.hold.gate;
      const g = s.groups.find((x) => x.group === lm[1]);
      if (!g) return j({ error: "no such group" }, 404);
      if (method === "PUT") {
        if (!g.presets.some((p) => p.preset === body.preset)) return j({ error: "there is no such preset" }, 404);
        s.log.unshift({ id: s.log.length + 1, at: "2026-11-26T10:00:00Z", actor: me, action: "set", key: "research.max_fetch", old_value: 24, new_value: body.preset === "small" ? 12 : 40, group: g.group, preset: body.preset });
        g.current = body.preset;
        g.values = g.values.map((v) => ({ ...v, value: body.preset === "small" ? 12 : 40, is_default: false }));
        return j(g);
      }
      g.current = "standard"; g.values = g.values.map((v) => ({ ...v, value: 24, is_default: true }));
      return j(g);
    }
    const um = path.match(/^\/workbench\/settings\/([^/]+)$/);
    if (um) {
      const key = decodeURIComponent(um[1]);
      const k = USER_KEYS().find((x) => x.key === key);
      if (!k) return j({ error: `${key} is not a setting` }, 404);
      const id = me + "|" + key;
      const cur = s.stored.get(id)?.version ?? 0;
      if (method === "PUT") {
        s.puts.push({ path: "PUT " + path, body });
        if (body.version !== undefined && body.version !== cur) return j({ error: "the setting changed since it was read" }, 409);
        if (key === "research.ask_over_fetch" && body.value > s.ceiling) return j({ error: `research.ask_over_fetch: must be at most ${s.ceiling} (the most pages one research run may read, set by an admin)` }, 400);
        s.stored.set(id, { value: body.value, version: cur + 1 });
        const st = s.stored.get(id)!;
        return j({ ...k, value: st.value, is_default: false, version: st.version });
      }
      if (method === "DELETE") {
        s.puts.push({ path: "DELETE " + url, body });
        s.stored.delete(id);
        return j({ ...k, value: null, is_default: true, version: cur + 1 });
      }
    }
    return j({}, 404);
  });
}
const openSettings = async (admin = false) => {
  srv.admin = admin;
  connect(srv);
  window.history.pushState({}, "", "/settings");
  render(<App />);
  await screen.findByTestId("settings");
  await screen.findByTestId("spanel");
};
const pick = async (name: RegExp | string) => { fireEvent.click(await screen.findByRole("button", { name })); };

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); srv = newSrv();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
});
afterEach(() => cleanup());

describe("the sections of your defaults", () => {
  it("shows Research defaults, My ideas, Library and the podcast section for a person; the Library's keys are their own section", async () => {
    await openSettings(false);
    const names = within(screen.getByTestId("snav")).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Start screen", "My ideas", "Research defaults", "Library", "Daily digest and podcast"]);
    await pick("Library");
    const keys = [...screen.getByTestId("spanel").querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key"));
    expect(keys).toEqual(["library.how_far_out", "library.recent_size", "library.clear_on_signout", "library.hidden_suggestions"]);
    expect(screen.queryByText("Recently viewed")).toBeNull(); // the app's own state key is not a form row
  });

  it("sectionsOf puts library.* in Library whatever section the registry says, and hides app-state keys except the hidden list", () => {
    const list = USER_KEYS();
    const secs = sectionsOf("user", list);
    expect(secs.map((s) => s.id)).toEqual(["user-ui", "user-refinery", "user-research", "user-library", "user-digest"]);
    expect(secs.find((s) => s.id === "user-library")!.keys.map((k) => k.key)).toContain("library.hidden_suggestions");
    expect(secs.find((s) => s.id === "user-ui")!.keys.map((k) => k.key)).toEqual(["ui.start_screen"]);
  });
});

describe("a default may not pass the admin's ceiling", () => {
  it("shows the ceiling, refuses a value above it BEFORE sending, in the server's words, and saves one at it", async () => {
    await openSettings(false);
    await pick("Research defaults");
    const field = within(screen.getByTestId("setting-research.ask_over_fetch")).getByTestId("control") as HTMLInputElement;
    expect(screen.getByTestId("ceiling-research.ask_over_fetch").textContent).toMatch(/Highest allowed: 24 \(the most pages one research run may read, set by an admin\)/);
    expect(field.max).toBe("24");
    fireEvent.change(field, { target: { value: "25" } });
    fireEvent.blur(field);
    const err = await screen.findByTestId("error-research.ask_over_fetch");
    expect(err.textContent).toBe("Not saved: research.ask_over_fetch: must be at most 24 (the most pages one research run may read, set by an admin)");
    expect(srv.puts.filter((p) => p.path.startsWith("PUT"))).toEqual([]); // nothing was sent
    fireEvent.change(field, { target: { value: "24" } });
    fireEvent.blur(field);
    await screen.findByText("Saved");
    expect(srv.puts.at(-1)!.body).toEqual({ value: 24, version: 0 });
  });

  it("the page's number rule is the server's: whole numbers, min, max, ceiling", () => {
    const k = row({ key: "research.ask_over_fetch", type: "integer", section: "research", label: "x", validation: { min: 1, max: 200 }, ceiling: 12, ceiling_phrase: "set by an admin" });
    expect(numberProblem(k, 0)).toBe("must be at least 1");
    expect(numberProblem(k, 1.5)).toBe("must be a whole number");
    expect(numberProblem(k, 13)).toBe("must be at most 12 (set by an admin)");
    expect(numberProblem(k, 12)).toBeNull();
    expect(numberProblem(k, NaN)).toBe("must be a number");
    expect(numberProblem({ ...k, ceiling: undefined }, 201)).toBe("must be at most 200");
    expect(numberProblem({ ...k, type: "number" }, 1.5)).toBeNull();
  });

  it("a stored value above a lowered ceiling is shown as stored, with the ceiling beside it; nothing is altered on read", async () => {
    srv.stored.set("u-alice|research.ask_over_fetch", { value: 24, version: 1 });
    srv.ceiling = 12;
    await openSettings(false);
    await pick("Research defaults");
    const f = within(screen.getByTestId("setting-research.ask_over_fetch")).getByTestId("control") as HTMLInputElement;
    expect(f.value).toBe("24");
    expect(screen.getByTestId("ceiling-research.ask_over_fetch").textContent).toMatch(/Highest allowed: 12.*Your saved value is above it, so runs use 12/);
    expect(srv.puts).toEqual([]);
  });
});

describe("the admin research limits are presets, never numbers", () => {
  it("a non-admin never asks for, sees or can reach the limits (no request, no text)", async () => {
    await openSettings(false);
    expect(screen.queryByTestId("limits")).toBeNull();
    expect(screen.queryByText(/How big a research run is/)).toBeNull();
    expect(requestLog().some((r) => /admin/.test(r.url))).toBe(false);
  });

  it("an admin sees each group as radio presets and no number or text input; a preset sends only its name and shows what is in force", async () => {
    await openSettings(true);
    await pick("Research and curator limits");
    const panel = await screen.findByTestId("limits");
    expect(panel.querySelectorAll("input[type=number], input[type=text], input:not([type])").length).toBe(0);
    expect(panel.querySelectorAll("select, datalist").length).toBe(0);
    expect(within(panel).getAllByRole("radiogroup").length).toBe(2);
    expect(screen.getByTestId("limits-now-run_size").textContent).toMatch(/In force: Standard\..*Pages retrieved per run: 24 \(the server's own\)/);
    fireEvent.click(screen.getByTestId("preset-run_size-small"));
    await waitFor(() => expect(screen.getByTestId("limits-saved-run_size").textContent).toBe("Saved"));
    expect(srv.puts.find((p) => p.path === "PUT /workbench/settings/admin/limits/run_size")!.body).toEqual({ preset: "small" });
    expect(screen.getByTestId("limits-now-run_size").textContent).toMatch(/In force: Small\..*Pages retrieved per run: 12$/);
    expect((screen.getByTestId("preset-run_size-small") as HTMLInputElement).checked).toBe(true);
  });

  it("a refusal is shown in the server's words and nothing changes; 'the server's own values' resets", async () => {
    await openSettings(true);
    await pick("Research and curator limits");
    await screen.findByTestId("limits");
    srv.groups[0].presets = srv.groups[0].presets.slice(0, 2); // the server no longer has Large
    fireEvent.click(screen.getByTestId("preset-run_size-large"));
    const err = await screen.findByTestId("limits-error-run_size");
    expect(err.textContent).toBe("Not saved: there is no such preset");
    expect(screen.getByTestId("limits-now-run_size").textContent).toMatch(/In force: Standard/);
    fireEvent.click(screen.getByTestId("preset-run_size-small"));
    await waitFor(() => expect(screen.getByTestId("limits-now-run_size").textContent).toMatch(/In force: Small/));
    fireEvent.click(screen.getByTestId("limits-reset-run_size"));
    await waitFor(() => expect(screen.getByTestId("limits-now-run_size").textContent).toMatch(/In force: Standard\..*\(the server's own\)/));
  });

  it("the log shows who changed what, old and new, with the preset", async () => {
    await openSettings(true);
    await pick("Research and curator limits");
    await screen.findByTestId("limits");
    fireEvent.click(screen.getByTestId("preset-run_size-small"));
    await waitFor(() => expect(screen.getByTestId("limits-saved-run_size").textContent).toBe("Saved"));
    fireEvent.click(screen.getByTestId("log-show"));
    const line = await screen.findByTestId("log-line");
    expect(line.textContent).toBe("2026-11-26 10:00:00: u-alice set Pages retrieved per run: 24 to 12 (preset small)");
  });

  it("the epoch guard: a preset answer that lands after the person changed is dropped, never shown to the next person", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    srv.hold = { path: /limits\/run_size$/, release, gate };
    srv.admin = true;
    connect(srv);
    const { rerender } = render(<Settings subject="u-root" whoAnswered />);
    await screen.findByTestId("spanel");
    await pick("Research and curator limits");
    await screen.findByTestId("limits");
    fireEvent.click(screen.getByTestId("preset-run_size-large")); // in flight, held by the server
    await waitFor(() => expect(srv.puts.some((p) => p.path === "PUT /workbench/settings/admin/limits/run_size")).toBe(true));
    // the person on the page changes to a non-admin before the answer lands
    srv.who = "u-bob"; srv.admin = false; srv.hold = null;
    rerender(<Settings subject="u-bob" whoAnswered />);
    await screen.findByTestId("spanel");
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("limits")).toBeNull();
    expect(screen.queryByText(/Large/)).toBeNull();
    expect(screen.queryByTestId("limits-saved-run_size")).toBeNull();
    expect(screen.queryByTestId("admin-heading")).toBeNull();
  });
});

describe("hidden suggestions", () => {
  it("shows how many are hidden (the count, never the items) and shows them again with a versioned delete", async () => {
    srv.stored.set("u-alice|library.hidden_suggestions", { value: [{ kind: "topic", id: "SECRET-TOPIC" }, { kind: "gap", id: "g1" }], version: 3 });
    await openSettings(false);
    await pick("Library");
    expect(screen.getByTestId("hidden-count").textContent).toBe("2 hidden.");
    expect(screen.getByTestId("spanel").textContent).not.toMatch(/SECRET-TOPIC/);
    fireEvent.click(screen.getByTestId("hidden-show-again"));
    await screen.findByText("Saved");
    expect(srv.puts.at(-1)!.path).toBe("DELETE /workbench/settings/library.hidden_suggestions?version=3");
    expect(screen.getByTestId("hidden-count").textContent).toBe("None hidden.");
    expect((screen.getByTestId("hidden-show-again") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the Start research dialog uses your defaults", () => {
  const preview = (depth: string) => ({ ok: true, question: "clean q", topic: "t", links: [], depth: { name: depth, rounds: 2, max_fetch: depth === "deep" ? 80 : depth === "standard" ? 40 : 12, wall_ms: 600000 }, refusal: null });
  let fetchSettings: (u: string, i?: RequestInit) => Promise<Response>;
  const openStart = async (stored: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(stored)) srv.stored.set("u-alice|" + k, { value: v, version: 1 });
    setFetcher(async (url, init) => {
      const path = url.split("?")[0];
      if (path === "/workbench/research/preview") return j(preview(JSON.parse(String(init?.body)).depth));
      if (path === "/workbench/contract/documents") return j({ documents: [] });
      return fetchSettings(url, init);
    });
    window.history.pushState({}, "", "/research/start");
    render(<App />);
    await screen.findByTestId("start-dialog");
  };
  beforeEach(() => {
    fetchSettings = async (u, i) => {
      const method = (i?.method ?? "GET").toUpperCase();
      const path = u.split("?")[0];
      if (path === "/workbench/workspace/whoami") return j({ subject_sub: "u-alice", actor_sub: "u-alice", name: "alice" });
      if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: "u-alice", name: "alice" });
      if (path === "/workbench/settings" && method === "GET") {
        return j({ admin: false, settings: ["research.default_depth", "research.ask_over_fetch"].map((k) => {
          const st = srv.stored.get("u-alice|" + k);
          return { key: k, value: st ? st.value : null, is_default: !st, version: st?.version ?? 0 };
        }) });
      }
      return j({}, 404);
    };
  });

  it("offers your default depth first, but never replaces a depth you chose", async () => {
    await openStart({ "research.default_depth": "deep" });
    await waitFor(() => expect(screen.getByTestId("depth-deep").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByTestId("depth-quick"));
    expect(screen.getByTestId("depth-quick").getAttribute("aria-pressed")).toBe("true");
  });

  it("a value that is not a depth is no default (the dialog stays on Standard)", async () => {
    await openStart({ "research.default_depth": "extreme" });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("depth-standard").getAttribute("aria-pressed")).toBe("true");
  });

  it("asks first when the depth may read more pages than your limit: the note names both numbers and Start becomes Start anyway", async () => {
    await openStart({ "research.ask_over_fetch": 20 });
    fireEvent.change(screen.getByTestId("start-question"), { target: { value: "what is x" } });
    await screen.findByTestId("leaves-ok", undefined, { timeout: 3000 });
    const ask = await screen.findByTestId("ask-first");
    expect(ask.textContent).toMatch(/up to 40 pages, more than the 20 you asked to be asked about/);
    expect(screen.getByTestId("start-go").textContent).toBe("Start anyway");
    fireEvent.click(screen.getByTestId("depth-quick")); // 12 pages: under the limit
    await waitFor(() => expect(screen.queryByTestId("ask-first")).toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId("start-go").textContent).toBe("Start");
  });

  it("does not ask with no limit set", async () => {
    await openStart({});
    fireEvent.change(screen.getByTestId("start-question"), { target: { value: "what is x" } });
    await screen.findByTestId("leaves-ok", undefined, { timeout: 3000 });
    expect(screen.queryByTestId("ask-first")).toBeNull();
    expect(screen.getByTestId("start-go").textContent).toBe("Start");
  });
});
