// The Settings frame (rwr-settings-shell): sections (Yours / Admin only), the tags legend and a tag on every row, save as you
// go with "Saved", admin sections only when the SERVER says admin (and nothing about them requested otherwise), a value saved
// in one browser shown in another, two identities, and the privacy stance wording.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { Settings } from "../src/screens/settings/Settings";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";

type Row = {
  key: string; tier: "user" | "admin"; type: string; section: string; position: number; label: string; help: string; default: unknown;
  env: string | null; validation: Record<string, unknown>; editable: boolean; tag: string | null;
};
const R = (o: Partial<Row> & Pick<Row, "key" | "tier" | "type" | "section" | "label">): Row =>
  ({ position: 10, help: "", default: null, env: null, validation: {}, editable: true, tag: o.tier === "admin" ? "admin_all" : "only_you", ...o });

const REGISTRY: Row[] = [
  R({ key: "ui.start_screen", tier: "user", type: "enum", section: "ui", label: "Start screen", validation: { enum: ["home", "library", "chat"] } }),
  R({ key: "ui.locked_document", tier: "user", type: "string", section: "ui", position: 20, label: "Locked document", validation: { ref: "doc_path" } }),
  R({ key: "library.recent", tier: "user", type: "ref_list", section: "ui", position: 30, label: "Recently viewed" }),
  R({ key: "refinery.brainstorm", tier: "user", type: "boolean", section: "refinery", label: "Brainstorm on my ideas", default: true, tag: "on_server" }),
  R({ key: "refinery.dormancy_days", tier: "user", type: "integer", section: "refinery", position: 20, label: "Days before a quiet idea goes dormant", default: 14, tag: "on_server", validation: { min: 1, max: 365 } }),
  R({ key: "digest.send_time", tier: "user", type: "time", section: "digest", label: "Send time", default: "05:00", editable: false, tag: "on_server" }),
  R({ key: "podcast.team", tier: "user", type: "string", section: "digest", position: 30, label: "The team that voices my daily episode", tag: "on_server" }),
  R({ key: "research.max_fetch", tier: "admin", type: "integer", section: "research", label: "ADMINONLY Pages retrieved per run", default: 24, editable: false }),
  R({ key: "curator.shortlist_k", tier: "admin", type: "integer", section: "research", position: 110, label: "ADMINONLY Curator: thread candidates", default: 5, editable: false }),
  R({ key: "podcast.archive_destination", tier: "admin", type: "destination", section: "digest", position: 40, label: "ADMINONLY Podcast archive destination", default: { mount: "podcast-archive" } }),
];

// One "server": the registry, a stored value per (person, key) with versions that never go back, and who is an admin.
function makeServer() {
  const store = new Map<string, { value: unknown; version: number }>();
  const tomb = new Map<string, number>();
  const wire: string[] = []; // every response body, as sent
  return { store, tomb, wire };
}
type Server = ReturnType<typeof makeServer>;
let SRV: Server;
let nextRefusal: { status: number; error: string } | null = null;

function connect(srv: Server, who: string, admin: boolean, tag?: (k: Row) => string | null) {
  const out = (k: Row, owner: string) => {
    const s = srv.store.get(owner + "|" + k.key);
    return { ...k, tag: tag ? tag(k) : k.tag, value: s ? s.value : null, is_default: !s, version: s?.version ?? srv.tomb.get(owner + "|" + k.key) ?? 0, updated_at: s ? "2026-11-22T00:00:00Z" : null };
  };
  setFetcher(async (url, init) => {
    const method = init?.method ?? "GET";
    const [path] = url.split("?");
    const send = (o: unknown, status = 200) => { const body = JSON.stringify(o); srv.wire.push(`${who} ${method} ${url} -> ${status} ${body}`); return new Response(body, { status }); };
    if (path === "/workbench/workspace/whoami") return send({ subject_sub: who, actor_sub: who, name: who });
    if (path === "/workbench/auth/me") return send({ mode: "forward-auth", kind: "user", subject_sub: who, name: who });
    if (path === "/workbench/settings" && method === "GET") return send({ admin, settings: REGISTRY.filter((k) => k.tier === "user").map((k) => out(k, who)) });
    if (path === "/workbench/settings/admin" && method === "GET") {
      return admin ? send({ settings: REGISTRY.filter((k) => k.tier === "admin").sort((a, b) => a.section.localeCompare(b.section) || a.position - b.position).map((k) => out(k, "*")) }) : send({ error: "only an admin may read or change the shared settings" }, 403);
    }
    // rwr-settings-defaults: the research limits are presets in groups (the panel replaces the per-key rows in that section)
    if (path === "/workbench/settings/admin/limits" && method === "GET") {
      return admin ? send({ groups: [{ group: "run_size", label: "ADMINONLY run size", help: "", current: "standard", presets: [{ preset: "small", label: "Small", help: "", values: [] }, { preset: "standard", label: "Standard", help: "", values: [] }], values: [] }] }) : send({ error: "only an admin may read or change the shared settings" }, 403);
    }
    const m = path.match(/^\/workbench\/settings\/(?:admin\/)?([^/]+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const k = REGISTRY.find((r) => r.key === key && (path.includes("/admin/") ? r.tier === "admin" : r.tier === "user"));
      if (!k) return send({ error: `${key} is not a setting` }, 404);
      const owner = k.tier === "admin" ? "*" : who;
      const id = owner + "|" + key;
      if (nextRefusal) { const r = nextRefusal; nextRefusal = null; return send({ error: r.error }, r.status); }
      const cur = srv.store.get(id)?.version ?? srv.tomb.get(id) ?? 0;
      if (method === "PUT") {
        const b = JSON.parse(String(init?.body));
        if (k.tier === "user" && b.version !== undefined && b.version !== cur) return send({ error: `the setting changed since it was read (version ${cur}, not ${b.version})` }, 409);
        const v = b.value;
        if (k.type === "integer" && typeof v === "number" && k.validation.max !== undefined && v > Number(k.validation.max)) return send({ error: `${key}: must be at most ${k.validation.max}` }, 400);
        srv.store.set(id, { value: v, version: cur + 1 });
        return send(out(k, owner));
      }
      if (method === "DELETE") {
        const q = new URLSearchParams(url.split("?")[1] ?? "");
        if (q.has("version") && Number(q.get("version")) !== cur) return send({ error: "stale" }, 409);
        srv.store.delete(id); srv.tomb.set(id, cur + 1);
        return send(out(k, owner));
      }
    }
    return send({}, 404);
  });
}

const ADMIN_LABEL = /ADMINONLY/;
const open = async (who: string, admin: boolean, srv = SRV) => {
  connect(srv, who, admin);
  window.history.pushState({}, "", "/settings");
  render(<App />);
  await screen.findByTestId("settings");
  await screen.findByTestId("spanel");
};
const pick = async (name: RegExp | string) => { fireEvent.click(await screen.findByRole("button", { name })); };

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); SRV = makeServer(); nextRefusal = null;
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
});

describe("the frame: sections, legend, stance", () => {
  it("opens the Settings screen from the menu route (not a 'coming in phase' placeholder) with Yours sections only for a non-admin", async () => {
    await open("u-alice", false);
    expect(screen.queryByTestId("placeholder")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const nav = screen.getByTestId("snav");
    expect(within(nav).getByText("Yours")).toBeTruthy();
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Start screen", "My ideas", "Daily digest and podcast"]);
    expect(screen.queryByTestId("admin-heading")).toBeNull();
    expect(screen.queryByText("Admin only")).toBeNull();
  });

  it("an admin (the server says so) also gets 'Admin only' with the shared sections", async () => {
    await open("u-root", true);
    const nav = screen.getByTestId("snav");
    expect(within(nav).getByText("Admin only")).toBeTruthy();
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Start screen", "My ideas", "Daily digest and podcast", "Podcast archive", "Research and curator limits"]);
    await pick("Research and curator limits");
    expect(screen.getByTestId("section-title").textContent).toBe("Research and curator limits");
    // the research limits are one preset group with its own tag (no per-key number rows: rwr-settings-defaults)
    expect(await screen.findByTestId("limits")).toBeTruthy();
    expect(within(screen.getByTestId("spanel")).getAllByTestId("tag").map((t) => t.textContent)).toEqual(["Admin changes it for everyone"]);
  });

  it("the legend names the four tags, and the cloud tag says no setting carries it yet", async () => {
    await open("u-alice", false);
    expect(within(screen.getByTestId("legend")).getAllByRole("listitem").map((l) => l.querySelector(".tag")!.textContent)).toEqual([
      "Only you", "Stays on this server", "Sent to a cloud provider", "Admin changes it for everyone"]);
    expect(screen.getByTestId("legend-cloud").textContent).toMatch(/No setting carries this tag yet/);
  });

  it("the privacy stance block says nothing about cloud (its wording waits for the cloud items)", async () => {
    await open("u-alice", false);
    const stance = screen.getByTestId("stance").cloneNode(true) as HTMLElement;
    stance.querySelector("[data-testid=legend]")!.remove(); // the legend defines the tag; the stance prose must not claim anything
    expect(stance.textContent).not.toMatch(/cloud/i);
    expect(stance.textContent).toMatch(/only to you/);
  });

  it("every row carries a tag from its registry row; a row without one says 'No tag' (never a guessed one)", async () => {
    connect(SRV, "u-alice", false, (k) => (k.key === "refinery.brainstorm" ? null : k.tag));
    window.history.pushState({}, "", "/settings");
    render(<App />);
    await screen.findByTestId("spanel");
    expect(within(screen.getByTestId("setting-ui.start_screen")).getByTestId("tag").textContent).toBe("Only you");
    await pick("My ideas");
    expect(within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("tag").textContent).toBe("Stays on this server");
    expect(within(screen.getByTestId("setting-refinery.brainstorm")).getByTestId("tag").textContent).toBe("No tag");
  });

  it("the app's own state keys (locked document, Recently viewed) are not offered as a form", async () => {
    await open("u-alice", false);
    expect(screen.queryByTestId("setting-ui.locked_document")).toBeNull();
    expect(screen.queryByTestId("setting-library.recent")).toBeNull();
    expect(screen.getByTestId("setting-ui.start_screen")).toBeTruthy();
  });
});

describe("a non-admin never receives an admin key (the wire, not the CSS)", () => {
  it("asks only for the user tier, and no response it received holds an admin key or label", async () => {
    await open("u-alice", false);
    await pick("My ideas"); await pick(/Daily digest/);
    // (the shell itself also reads GET /workbench/settings for the account's UI state; nothing ever asks for the shared tier)
    const urls = requestLog().map((r) => r.method + " " + r.url).filter((u) => /settings/.test(u));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u === "GET /workbench/settings")).toBe(true);
    expect(SRV.wire.filter((w) => /settings/.test(w)).join("\n")).not.toMatch(/ADMINONLY|research\.max_fetch|curator\.|archive_destination/);
    expect(document.body.textContent).not.toMatch(ADMIN_LABEL);
  });
  it("an admin reads the shared tier through the admin route only after the server said admin: true", async () => {
    await open("u-root", true);
    const urls = requestLog().map((r) => r.method + " " + r.url).filter((u) => /settings/.test(u));
    expect(urls.filter((u) => /\/admin/.test(u))).toEqual(["GET /workbench/settings/admin"]);
    expect(urls.every((u) => u.startsWith("GET "))).toBe(true);
  });
  it("if a non-admin's call to the admin route is refused, nothing of it reaches the screen", async () => {
    connect(SRV, "u-alice", false);
    const { loadSettings } = await import("../src/screens/settings/settings-data");
    const got = await loadSettings();
    expect(got.admin).toBe(false);
    expect(got.shared).toEqual([]);
  });
});

describe("save as you go", () => {
  it("a number saves when you leave the field: PUT with the version last read, 'Saved', then the next save sends the new version", async () => {
    await open("u-alice", false);
    await pick("My ideas");
    const row = screen.getByTestId("setting-refinery.dormancy_days");
    const input = within(row).getByTestId("control") as HTMLInputElement;
    expect(input.value).toBe("14");
    expect(row.textContent).toMatch(/Using the default: 14/);
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("saved-refinery.dormancy_days").textContent).toBe("Saved"));
    expect(SRV.store.get("u-alice|refinery.dormancy_days")).toEqual({ value: 30, version: 1 });
    expect(row.textContent).toMatch(/Set by you/);
    fireEvent.change(input, { target: { value: "31" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(SRV.store.get("u-alice|refinery.dormancy_days")).toEqual({ value: 31, version: 2 }));
    const puts = requestLog().filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
  });

  it("a switch saves at once; a choice 'Default' goes back to the default with the version", async () => {
    await open("u-alice", false);
    await pick("My ideas");
    const sw = within(screen.getByTestId("setting-refinery.brainstorm")).getByTestId("control") as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(SRV.store.get("u-alice|refinery.brainstorm")?.value).toBe(false));
    await pick("Start screen");
    const grp = within(screen.getByTestId("setting-ui.start_screen")).getByTestId("control");
    expect(grp.getAttribute("role")).toBe("radiogroup");
    expect(grp.querySelector("select")).toBeNull(); // the one-picker rule: no native <select> outside ItemPicker
    expect(within(grp).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["", "home", "library", "chat"]);
    expect((within(grp).getByRole("radio", { name: /Default/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(grp).getByRole("radio", { name: "library" }));
    await waitFor(() => expect(SRV.store.get("u-alice|ui.start_screen")?.value).toBe("library"));
    await waitFor(() => expect((within(grp).getByRole("radio", { name: "library" }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(within(grp).getByRole("radio", { name: /Default/ }));
    await waitFor(() => expect(SRV.store.has("u-alice|ui.start_screen")).toBe(false));
    expect(requestLog().some((r) => r.method === "DELETE" && /ui\.start_screen\?version=1$/.test(r.url))).toBe(true);
  });

  it("'Back to default' clears a value", async () => {
    SRV.store.set("u-alice|refinery.dormancy_days", { value: 40, version: 3 });
    await open("u-alice", false);
    await pick("My ideas");
    fireEvent.click(within(screen.getByTestId("setting-refinery.dormancy_days")).getByText("Back to default"));
    await waitFor(() => expect(SRV.store.has("u-alice|refinery.dormancy_days")).toBe(false));
    await waitFor(() => expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("14"));
  });

  it("a value the server refuses is shown in the server's words and the field goes back to what is stored", async () => {
    await open("u-alice", false);
    await pick("My ideas");
    const input = within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    const err = await screen.findByTestId("error-refinery.dormancy_days");
    expect(err.textContent).toMatch(/Not saved: .*must be at most 365/);
    expect(input.value).toBe("14");
    expect(SRV.store.has("u-alice|refinery.dormancy_days")).toBe(false);
    expect(screen.getByTestId("saved-refinery.dormancy_days").textContent).toBe("");
  });

  it("a change made on another browser meanwhile is not overwritten: the stale save is refused and the latest value shown", async () => {
    await open("u-alice", false);
    await pick("My ideas");
    SRV.store.set("u-alice|refinery.dormancy_days", { value: 77, version: 5 }); // the other browser
    const input = within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect((await screen.findByTestId("error-refinery.dormancy_days")).textContent).toMatch(/Changed on another browser/);
    await waitFor(() => expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("77"));
    expect(SRV.store.get("u-alice|refinery.dormancy_days")?.value).toBe(77);
  });

  it("a read-only setting has no control", async () => {
    await open("u-alice", false);
    await pick(/Daily digest/);
    const row = screen.getByTestId("setting-digest.send_time");
    expect(within(row).getByTestId("readonly").textContent).toBe("05:00 (default)");
    expect(within(row).queryByTestId("control")).toBeNull();
  });

  it("an admin changes a shared setting at the admin route, tagged 'Admin changes it for everyone'", async () => {
    SRV.store.set("*|podcast.archive_destination", { value: { mount: "podcast-archive" }, version: 1 });
    await open("u-root", true);
    await pick("Podcast archive");
    const row = screen.getByTestId("setting-podcast.archive_destination");
    expect(within(row).getByTestId("tag").textContent).toBe("Admin changes it for everyone");
    expect(within(row).getByTestId("readonly").textContent).toMatch(/mount: podcast-archive/); // a destination has its own editor, later
  });
});

describe("one account, any browser, and two people", () => {
  it("a value saved in one browser shows in another (a fresh page against the same server)", async () => {
    await open("u-alice", false);
    await pick("My ideas");
    const input = within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("saved-refinery.dormancy_days").textContent).toBe("Saved"));
    cleanup(); clearRequestLog(); resetState(); window.localStorage.clear(); window.sessionStorage.clear();
    await open("u-alice", false); // the second browser: nothing carried over but the account
    await pick("My ideas");
    expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("45");
  });

  it("user B never sees user A's values, versions or 'Set by you' marks", async () => {
    SRV.store.set("u-alice|refinery.dormancy_days", { value: 123, version: 4 });
    SRV.store.set("u-alice|podcast.team", { value: "ALPHA-TEAM", version: 2 });
    await open("u-bob", false);
    await pick("My ideas");
    const row = screen.getByTestId("setting-refinery.dormancy_days");
    expect((within(row).getByTestId("control") as HTMLInputElement).value).toBe("14");
    expect(row.textContent).toMatch(/Using the default/);
    await pick(/Daily digest/);
    expect(document.body.textContent).not.toMatch(/ALPHA-TEAM|123/);
    expect(SRV.wire.filter((w) => w.startsWith("u-bob")).join("\n")).not.toMatch(/ALPHA-TEAM|123/);
  });

  it("switching person remounts the screen: the second person's page is built from their own read", async () => {
    SRV.store.set("u-alice|refinery.dormancy_days", { value: 123, version: 4 });
    await open("u-alice", false);
    await pick("My ideas");
    expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("123");
    cleanup(); resetState();
    await open("u-bob", false);
    await pick("My ideas");
    expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("14");
  });
});

describe("a save answer that lands after the person changed (tester attempt 1, case 5)", () => {
  it("is dropped: the next person's screen shows their own value, not the earlier person's save", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let who = "u-alice";
    const row = (v: unknown, version: number, isDefault: boolean) => ({
      key: "refinery.dormancy_days", tier: "user", type: "integer", section: "refinery", position: 20, label: "Days before a quiet idea goes dormant",
      help: "", default: 14, env: null, validation: { min: 1, max: 365 }, editable: true, tag: "on_server", value: v, is_default: isDefault, version, updated_at: null,
    });
    setFetcher(async (url, init) => {
      const [path] = url.split("?");
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
      if (path === "/workbench/workspace/whoami") return json({ subject_sub: who, actor_sub: who, name: who });
      if (path === "/workbench/auth/me") return json({ mode: "forward-auth", kind: "user", subject_sub: who, name: who });
      if (path === "/workbench/settings" && (init?.method ?? "GET") === "GET") return json({ admin: false, settings: [row(null, 0, true)] });
      if (path === "/workbench/settings/refinery.dormancy_days" && init?.method === "PUT") { await held; return json(row(30, 1, false)); }
      return json({}, 404);
    });
    const ui = (subject: string) => <Settings subject={subject} whoAnswered />;
    const { rerender } = render(ui("u-alice"));
    await pick("My ideas");
    const input = within(await screen.findByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input); // alice's PUT is held
    who = "u-bob";
    rerender(ui("u-bob"));
    await pick("My ideas");
    await waitFor(() => expect((within(screen.getByTestId("setting-refinery.dormancy_days")).getByTestId("control") as HTMLInputElement).value).toBe("14"));
    release(); // alice's answer lands now
    await new Promise((r) => setTimeout(r, 50));
    const r2 = screen.getByTestId("setting-refinery.dormancy_days");
    expect((within(r2).getByTestId("control") as HTMLInputElement).value).toBe("14");
    expect(r2.textContent).toMatch(/Using the default/);
    expect(r2.textContent).not.toMatch(/Set by you/);
  });
});

describe("failure and lane", () => {
  it("a failed read says so, with a way to try again", async () => {
    setFetcher(async (u) => (u.startsWith("/workbench/settings") ? new Response("{}", { status: 500 }) : new Response("{}", { status: 200 })));
    render(<Settings />);
    expect(await screen.findByTestId("settings-failed")).toBeTruthy();
    connect(SRV, "u-alice", false);
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByTestId("spanel")).toBeTruthy();
  });

  it("the screen makes its reads only through lib/api.ts, keeps nothing in the browser, and adds no search or list-search component", () => {
    for (const f of readdirSync("src/screens/settings")) {
      const src = readFileSync("src/screens/settings/" + f, "utf8").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join(" ");
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
      expect(src, f).not.toMatch(/type=["']search["']|role=["']search(box)?["']|searchbox|onSearch|runSearch/i);
    }
  });
});
