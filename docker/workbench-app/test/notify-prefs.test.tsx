// Settings > Notifications (rwr-notify-prefs): the rows, the disabled email column, the always-on sign-in row, versioned saves that
// show exactly what the server stored, and the person-switch rule (a save held across a change of person never writes to,
// or shows in, the next person). The fake server follows the REAL one: slot 720's registry (three booleans, the sign-in key an
// enum of "on"), setting_problem's refusals and its words, versions that never go back.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Settings } from "../src/screens/settings/Settings";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";

type Row = {
  key: string; tier: "user"; type: string; section: string; position: number; label: string; help: string; default: unknown;
  env: string | null; validation: Record<string, unknown>; editable: boolean; tag: string | null;
};
const N = (key: string, type: string, position: number, label: string, def: unknown, validation: Record<string, unknown> = {}): Row =>
  ({ key, tier: "user", type, section: "ui", position, label, help: `help for ${label}`, default: def, env: null, validation, editable: true, tag: "only_you" });
const REGISTRY: Row[] = [
  { ...N("ui.start_screen", "enum", 10, "Start screen", null, { enum: ["home", "library"] }), help: "" },
  N("notify.informational", "boolean", 100, "Events about your work", true),
  N("notify.structural", "boolean", 110, "Problems that need a fix", true),
  N("notify.transient", "boolean", 120, "The model did not perform", true),
  N("notify.sign_in_new_device", "enum", 130, "Sign-in from a new device", "on", { enum: ["on"] }),
];

function makeServer() {
  const store = new Map<string, { value: unknown; version: number }>();
  const puts: { who: string; key: string; body: any }[] = [];
  return { store, puts, hold: null as null | { key: string; who: string; gate: Promise<void>; release: () => void }, refuse: null as null | { status: number; error: string } };
}
type Server = ReturnType<typeof makeServer>;
let SRV: Server;

function connect(srv: Server, who: string) {
  const out = (k: Row) => {
    const s = srv.store.get(who + "|" + k.key);
    return { ...k, value: s ? s.value : null, is_default: !s, version: s?.version ?? 0, updated_at: null };
  };
  setFetcher(async (url, init) => {
    const method = init?.method ?? "GET";
    const [path] = url.split("?");
    const send = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (path === "/workbench/workspace/whoami") return send({ subject_sub: who, actor_sub: who, name: who });
    if (path === "/workbench/settings" && method === "GET") return send({ admin: false, settings: REGISTRY.map(out) });
    const m = path.match(/^\/workbench\/settings\/([^/]+)$/);
    if (m && method === "PUT") {
      const key = decodeURIComponent(m[1]);
      const k = REGISTRY.find((r) => r.key === key);
      const b = JSON.parse(String(init?.body));
      srv.puts.push({ who, key, body: b });
      if (srv.hold && srv.hold.key === key && srv.hold.who === who) { const h = srv.hold; srv.hold = null; await h.gate; }
      if (srv.refuse) { const r = srv.refuse; srv.refuse = null; return send({ error: r.error }, r.status); }
      if (!k) return send({ error: `${key} is not a setting` }, 404);
      const cur = srv.store.get(who + "|" + key)?.version ?? 0;
      if (b.version !== undefined && b.version !== cur) return send({ error: `the setting changed since it was read (version ${cur}, not ${b.version})` }, 409);
      if (k.type === "boolean" && typeof b.value !== "boolean") return send({ error: `${key}: must be true or false` }, 400);
      if (k.type === "enum" && !(typeof b.value === "string" && (k.validation.enum as string[]).includes(b.value))) {
        return send({ error: `${key}: must be one of ${JSON.stringify(k.validation.enum)}` }, 400);
      }
      srv.store.set(who + "|" + key, { value: b.value, version: cur + 1 });
      return send(out(k));
    }
    return send({}, 404);
  });
}

const open = async (who: string, props: { subject?: string | null } = {}) => {
  connect(SRV, who);
  const r = render(<Settings subject={props.subject ?? who} whoAnswered />);
  await screen.findByTestId("spanel");
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await screen.findByTestId("notifications");
  return r;
};
const cb = (key: string) => within(screen.getByTestId("setting-" + key)).getByTestId("control") as HTMLInputElement;
const hold = (who: string, key: string) => {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  SRV.hold = { key, who, gate, release };
  return release;
};

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); SRV = makeServer();
  window.localStorage.clear(); window.sessionStorage.clear();
});

describe("the Notifications section", () => {
  it("is a section of Yours beside the start screen, with a row per kind: the three classes switchable, sign-in always on", async () => {
    await open("u-alice");
    expect(within(screen.getByTestId("snav")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Start screen", "Notifications"]);
    expect(screen.getByTestId("section-title").textContent).toBe("Notifications");
    const rows = within(screen.getByTestId("notifications")).getAllByTestId(/^setting-/).map((r) => r.getAttribute("data-key"));
    expect(rows).toEqual(["notify.informational", "notify.structural", "notify.transient", "notify.sign_in_new_device"]);
    for (const k of ["notify.informational", "notify.structural", "notify.transient"]) {
      expect(cb(k).checked).toBe(true);
      expect(cb(k).disabled).toBe(false);
    }
    expect(screen.queryByTestId("setting-ui.start_screen")).toBeNull(); // the other panel's key is not drawn here
  });

  it("the email column is shown disabled with 'Needs a mail service' on every row, and nothing can be sent from it", async () => {
    await open("u-alice");
    const mails = screen.getAllByTestId("email-control") as HTMLInputElement[];
    expect(mails).toHaveLength(4);
    for (const m of mails) { expect(m.disabled).toBe(true); expect(m.checked).toBe(false); fireEvent.click(m); expect(m.checked).toBe(false); }
    expect(screen.getAllByTestId("email-note").map((n) => n.textContent)).toEqual(Array(4).fill("Needs a mail service"));
    expect(screen.getAllByText("Email")).toHaveLength(4);
    expect(SRV.puts).toEqual([]); // no click on it reached the server
  });

  it("the sign-in row is on and disabled; clicking it sends nothing; the server's own refusal of an off is not reachable from the page", async () => {
    await open("u-alice");
    const s = cb("notify.sign_in_new_device");
    expect(s.checked).toBe(true);
    expect(s.disabled).toBe(true);
    expect(screen.getByTestId("always-on").textContent).toBe("Always on");
    fireEvent.click(s);
    await new Promise((r) => setTimeout(r, 20));
    expect(SRV.puts).toEqual([]);
    // and the same row stays on after every other save
    fireEvent.click(cb("notify.transient"));
    await waitFor(() => expect(screen.getByTestId("saved-notify.transient").textContent).toBe("Saved"));
    expect(cb("notify.sign_in_new_device").checked).toBe(true);
    expect(SRV.puts.every((p) => p.key !== "notify.sign_in_new_device")).toBe(true);
  });

  it("no native select or datalist, and no text or number field: a switch per kind", async () => {
    await open("u-alice");
    const panel = screen.getByTestId("notifications");
    expect(panel.querySelector("select, datalist, input[type=text], input[type=number]")).toBeNull();
  });
});

describe("saving", () => {
  it("a switch saves at once: PUT {value, version}, 'Saved', the checkbox shows what the server stored, and the next save sends the new version", async () => {
    await open("u-alice");
    fireEvent.click(cb("notify.informational"));
    await waitFor(() => expect(screen.getByTestId("saved-notify.informational").textContent).toBe("Saved"));
    expect(SRV.puts).toEqual([{ who: "u-alice", key: "notify.informational", body: { value: false, version: 0 } }]);
    expect(SRV.store.get("u-alice|notify.informational")).toEqual({ value: false, version: 1 });
    expect(cb("notify.informational").checked).toBe(false);
    fireEvent.click(cb("notify.informational"));
    await waitFor(() => expect(cb("notify.informational").checked).toBe(true));
    expect(SRV.puts[1].body).toEqual({ value: true, version: 1 });
    // the others were never touched
    expect(cb("notify.structural").checked).toBe(true);
    expect(SRV.store.has("u-alice|notify.structural")).toBe(false);
  });

  it("a stored off is shown as off after a reload (the account holds it, not the browser); nothing is kept in browser storage", async () => {
    SRV.store.set("u-alice|notify.transient", { value: false, version: 3 });
    await open("u-alice");
    expect(cb("notify.transient").checked).toBe(false);
    expect(cb("notify.informational").checked).toBe(true);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(document.title).not.toMatch(/notif|bell/i);
  });

  it("a refusal is shown in the server's own words and the switch stays what is stored", async () => {
    await open("u-alice");
    SRV.refuse = { status: 400, error: "notify.structural: must be true or false" };
    fireEvent.click(cb("notify.structural"));
    await waitFor(() => expect(screen.getByTestId("error-notify.structural").textContent).toBe("Not saved: notify.structural: must be true or false"));
    expect(cb("notify.structural").checked).toBe(true);
    expect(SRV.store.has("u-alice|notify.structural")).toBe(false);
  });

  it("a stale version (changed on another browser) is a 409: it says so and reloads the latest", async () => {
    await open("u-alice");
    SRV.store.set("u-alice|notify.transient", { value: false, version: 4 }); // another browser saved meanwhile
    fireEvent.click(cb("notify.transient"));
    await waitFor(() => expect(screen.getByTestId("error-notify.transient").textContent).toMatch(/Changed on another browser/));
    await waitFor(() => expect(cb("notify.transient").checked).toBe(false)); // the latest value is shown
  });

  it("a second click before the first save answers sends one request", async () => {
    await open("u-alice");
    const release = hold("u-alice", "notify.transient");
    fireEvent.click(cb("notify.transient"));
    fireEvent.click(cb("notify.transient"));
    await new Promise((r) => setTimeout(r, 20));
    expect(SRV.puts.filter((p) => p.key === "notify.transient")).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByTestId("saved-notify.transient").textContent).toBe("Saved"));
  });
});

describe("two identities and the person switch", () => {
  it("B never sees A's choices: B's list is B's own, and A's switch does not change B's panel", async () => {
    SRV.store.set("u-a|notify.transient", { value: false, version: 1 });
    const r = await open("u-b");
    expect(cb("notify.transient").checked).toBe(true);
    expect(document.body.textContent).not.toMatch(/u-a/);
    r.unmount();
  });

  it("a save held across a change of person is dropped: it is never shown to the next person, and the next person's list is not written", async () => {
    const r = await open("u-a");
    const release = hold("u-a", "notify.informational");
    fireEvent.click(cb("notify.informational")); // A's save is now in flight, held
    await waitFor(() => expect(SRV.puts).toHaveLength(1));
    // the person changes: the shell tells Settings a different subject; the fake now answers as B
    connect(SRV, "u-b");
    r.rerender(<Settings subject="u-b" whoAnswered />);
    await screen.findByTestId("spanel");
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    await screen.findByTestId("notifications");
    expect(cb("notify.informational").checked).toBe(true);
    // the held answer for A lands now
    release();
    await new Promise((x) => setTimeout(x, 30));
    expect(screen.queryByTestId("saved-notify.informational")?.textContent ?? "").toBe(""); // no "Saved" for B
    expect(cb("notify.informational").checked).toBe(true); // A's off is not shown to B
    expect(SRV.puts.every((p) => p.who === "u-a")).toBe(true); // nothing was sent as B
    expect(SRV.store.has("u-b|notify.informational")).toBe(false); // nothing was written to B
    expect(SRV.store.get("u-a|notify.informational")).toEqual({ value: false, version: 1 }); // A's own save did land, for A
  });

  it("a held refusal for the earlier person is not shown to the next person either", async () => {
    const r = await open("u-a");
    const release = hold("u-a", "notify.structural");
    SRV.refuse = { status: 400, error: "notify.structural: A-only words" };
    fireEvent.click(cb("notify.structural"));
    await waitFor(() => expect(SRV.puts).toHaveLength(1));
    connect(SRV, "u-b");
    r.rerender(<Settings subject="u-b" whoAnswered />);
    await screen.findByTestId("spanel");
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    await screen.findByTestId("notifications");
    release();
    await new Promise((x) => setTimeout(x, 30));
    expect(document.body.textContent).not.toMatch(/A-only words/);
    expect(screen.queryByTestId("error-notify.structural")).toBeNull();
  });
});
