// rwr-research-sources: the Start research dialog's Sources choice - preset from the person's own default (read per
// mount, never kept in the browser), sent in the one body the preview and the start share, shown in "What leaves",
// and disabled with the plain reason while an admin has community sources switched off. A fake back end.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { COMMUNITY_CONSENSUS_LABEL, COMMUNITY_LABEL, sourcesText } from "../src/screens/research-start/start-data";

let who: "alice" | "bob" = "alice";
let defaults: Record<string, "credible" | "community"> = {};
let allowed = true;
let previews: any[] = [];
let starts: any[] = [];
const REASON = "An admin has switched community sources off, so research reads credible sources only.";
const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const SRC_ROW = { key: "research.sources_default", tier: "user", type: "enum", section: "research", position: 120, label: "Sources for my research",
  help: "Credible only, or also community.", default: "credible", env: null, read_by: "x", validation: { enum: ["credible", "community"] }, editable: true,
  tag: "only_you", value: null, is_default: true, version: 0, updated_at: null };

function stub() {
  previews = []; starts = [];
  setFetcher(async (u, init) => {
    const path = new URL(u, "http://x").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: "u-" + who, actor_sub: "u-" + who, name: who });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth" });
    if (path === "/workbench/settings") return j({ admin: false, settings: [SRC_ROW] });
    if (path === "/workbench/contract/documents") return j({ documents: [] });
    if (path === "/workbench/research/options") {
      return j({ sources_default: allowed ? (defaults[who] ?? "credible") : "credible", community_allowed: allowed, reason: allowed ? null : REASON });
    }
    if (path === "/workbench/research/preview" || path === "/workbench/research") {
      const isStart = path === "/workbench/research";
      (isStart ? starts : previews).push(body);
      if (body.sources === "community" && !allowed) return j({ error: REASON, code: "community_off" }, 403);
      const shown = { question: "clean: " + body.question, topic: "t", links: [], depth: null, refusal: null, sources: body.sources };
      if (!isStart) return j({ ok: true, ...shown });
      return j({ started: true, job_id: "d0d0d0d0-0000-4000-8000-000000000001", ...shown }, 202);
    }
    return j({}, 404);
  });
}
const openStart = async () => {
  window.history.pushState({}, "", "/research/start");
  render(<App />);
  await screen.findByTestId("start-dialog");
};
const type = (t: string) => fireEvent.change(screen.getByTestId("start-question"), { target: { value: t } });
const pressed = (id: string) => screen.getByTestId(id).getAttribute("aria-pressed");

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; defaults = {}; allowed = true;
  window.localStorage.clear(); window.sessionStorage.clear();
  stub();
});
afterEach(() => cleanup());

describe("the Sources choice", () => {
  it("opens on credible only when the person saved nothing, and the preview and start send it", async () => {
    await openStart();
    await waitFor(() => expect(pressed("sources-credible")).toBe("true"));
    type("heat pump noise?");
    await waitFor(() => expect(previews.length).toBeGreaterThan(0), { timeout: 2500 });
    expect(previews.at(-1).sources).toBe("credible");
    expect((await screen.findByTestId("leaves-sources")).textContent).toBe(sourcesText("credible"));
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(starts.length).toBe(1));
    expect(starts[0].sources).toBe("credible");
  });

  it("is pre-set from the person's own default; another person's default never shows", async () => {
    defaults = { alice: "community" };
    await openStart();
    await waitFor(() => expect(pressed("sources-community")).toBe("true"));
    cleanup(); resetState(); who = "bob"; stub();
    await openStart();
    await waitFor(() => expect(pressed("sources-credible")).toBe("true"));
  });

  it("a change is sent in the next preview, and what leaves says community posts are labelled", async () => {
    await openStart();
    await waitFor(() => expect((screen.getByTestId("sources-community") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("sources-community"));
    type("heat pump noise?");
    await waitFor(() => expect(previews.at(-1)?.sources).toBe("community"), { timeout: 2500 });
    expect((await screen.findByTestId("leaves-sources")).textContent).toMatch(/labelled/);
  });

  it("with community switched off: the choice is disabled, the plain reason shows, and credible is what is sent", async () => {
    allowed = false; defaults = { alice: "community" };
    await openStart();
    const c = await screen.findByTestId("sources-community");
    await waitFor(() => expect((c as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("sources-off-reason").textContent).toBe(REASON);
    expect(pressed("sources-credible")).toBe("true");
    type("heat pump noise?");
    await waitFor(() => expect(previews.length).toBeGreaterThan(0), { timeout: 2500 });
    expect(previews.every((p) => p.sources === "credible")).toBe(true);
  });

  it("nothing about the choice is kept in the browser", async () => {
    defaults = { alice: "community" };
    await openStart();
    await waitFor(() => expect(pressed("sources-community")).toBe("true"));
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it("the labels say plainly that a community claim is not credible", () => {
    expect(COMMUNITY_LABEL).toMatch(/not a credible rating/);
    expect(COMMUNITY_CONSENSUS_LABEL).toMatch(/consensus/i);
    expect(COMMUNITY_CONSENSUS_LABEL).not.toMatch(/credible/i);
  });
});

describe("Settings: research.sources_default", () => {
  const openSettings = async () => {
    window.history.pushState({}, "", "/settings");
    render(<App />);
    await screen.findByTestId("setting-research.sources_default");
  };
  it("is a choice the person can change while community is allowed", async () => {
    await openSettings();
    const radios = screen.getByTestId("setting-research.sources_default").querySelectorAll("input[type=radio]");
    await waitFor(() => expect(Array.from(radios).every((r) => !(r as HTMLInputElement).disabled)).toBe(true));
    expect(screen.queryByTestId("locked-research.sources_default")).toBeNull();
  });
  it("is disabled with the plain reason while an admin has community sources switched off", async () => {
    allowed = false;
    await openSettings();
    expect((await screen.findByTestId("locked-research.sources_default")).textContent).toBe(REASON);
    const radios = screen.getByTestId("setting-research.sources_default").querySelectorAll("input[type=radio]");
    expect(Array.from(radios).every((r) => (r as HTMLInputElement).disabled)).toBe(true);
  });
});
