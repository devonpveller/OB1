// rw-p8a3-room (front end): the room and scoped chat panels over a fake back end (helpers.ts). Runs with the
// rest of the workspace's vitest suite in the viewer image's workspace stage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { ChatPanel, RoomPanel } from "../src/panels/room/RoomPanels";
import { panel } from "../src/shell/registry";
import { resetState } from "../src/lib/store";
import { fakeApi, R1, S1, settle } from "./helpers";

const ROOM = "c1000000-0000-4000-8000-000000000001";
const SRC = "d1000000-0000-4000-8000-000000000001";
const PERMALINK = "https://chat.lab.invalid/team/pl/abc";
const CHAT_OFF = "chat is off: the workbench-chat key is not configured";

const view = (over: Record<string, unknown> = {}) => ({
  room: { id: ROOM, subject: { kind: "session", id: S1 }, scope: { enabled: false, sources: [] }, draft: "" },
  subject: { kind: "session", id: S1, card: { status: "done", query: "a thread question", badge: { key: "mattermost", label: "Mattermost" }, link: { kind: "external", href: PERMALINK, panel: null, params: {} } } },
  chat: { state: "on" },
  entries: [
    { id: "e1", seq: 1, kind: "user", body: "what changed?", context: [], created_at: "" },
    { id: "e2", seq: 2, kind: "assistant", body: "two things [1]", context: [{ source_id: SRC, chunk: 0, held: false }], created_at: "" },
  ],
  ...over,
});
const routes = (v: () => unknown, chat?: [unknown, number]) => [
  ["POST", "/workbench/rooms/" + ROOM + "/chat", () => chat?.[0] ?? { entries: [] }, chat?.[1] ?? 201] as const,
  ["PUT", "/workbench/rooms/" + ROOM + "/scope", (_u: string, b: any) => ({ room: { id: ROOM, scope: b } })] as const,
  ["POST", "/workbench/rooms", () => ({ room: { id: ROOM }, created: false })] as const,
  ["GET", "/workbench/rooms/" + ROOM, v] as const,
] as any;
const leafBtn = (k: string) => document.querySelector(`[data-leaf="${k}"] .ws-leaf-label`) as HTMLButtonElement;

beforeEach(() => resetState());
afterEach(() => cleanup());

describe("rw-p8a3-room panels", () => {
  it("V0: the room and the scoped chat are registered side panels", () => {
    expect(panel("room")?.kind).toBe("side");
    expect(panel("chat")?.kind).toBe("side");
  });

  it("V1: the room opens the caller's room on its subject and reads the transcript from the room store; at rest only the summary shows", async () => {
    const b = fakeApi(routes(() => view()));
    render(<RoomPanel params={{ subject_kind: "session", subject_id: S1 }} />);
    await settle();
    expect(b.bodies.find((x) => x.method === "POST")!.body).toEqual({ subject_kind: "session", subject_id: S1 });
    expect(screen.getByTestId("room-disclosure").getAttribute("data-open")).toBe("0");
    expect(screen.getByTestId("room-disclosure").textContent).toContain("2 entries");
    fireEvent.click(screen.getByTestId("room-disclosure").querySelector(".ws-summary")!);
    expect(document.querySelectorAll("[data-entry]").length).toBe(2);
    expect(document.querySelector("[data-actions]")).toBeNull();
    // every request went to the room store - nothing to Mattermost, nothing else (rw-p8a1-core, after the merge:
    // but the shared knowledge base's lifecycle lookup for the answer's sources, D5 - POST /contract/source-states)
    expect(b.log.every((l) => l.url.startsWith("/workbench/rooms") || l.url === "/workbench/contract/source-states")).toBe(true);
  });

  it("V2: a session started from a Mattermost thread shows the thread as its inlet with a link back", async () => {
    fakeApi(routes(() => view()));
    render(<RoomPanel params={{ subject_kind: "session", subject_id: S1 }} />);
    await settle();
    fireEvent.click(screen.getByTestId("room-disclosure").querySelector(".ws-summary")!);
    expect(screen.getByTestId("room-disclosure").textContent).toContain("Mattermost");
    fireEvent.click(leafBtn("subject"));
    const a = document.querySelector('[data-link="external"]') as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(PERMALINK);
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("V3: an answer's sources open from the transcript", async () => {
    fakeApi(routes(() => view()));
    render(<RoomPanel params={{ subject_kind: "session", subject_id: S1 }} />);
    await settle();
    fireEvent.click(screen.getByTestId("room-disclosure").querySelector(".ws-summary")!);
    fireEvent.click(leafBtn("entry:e2"));
    expect(document.querySelector(`[data-open-source="${SRC}"]`)).toBeTruthy();
  });

  it("V4: chat posts the question to the room and re-reads the room", async () => {
    const b = fakeApi(routes(() => view()));
    render(<ChatPanel params={{ subject_kind: "idea", subject_id: R1 }} />);
    await settle();
    fireEvent.click(screen.getByTestId("chat-disclosure").querySelector(".ws-summary")!);
    fireEvent.click(leafBtn("ask"));
    fireEvent.change(document.querySelector('[data-field="question"]')!, { target: { value: "why?" } });
    fireEvent.click(document.querySelector('[data-action="ask"]')!);
    await settle();
    const chat = b.bodies.find((x) => x.url.endsWith("/chat"))!;
    expect(chat.body).toEqual({ text: "why?" });
    expect(b.log.filter((l) => l.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("V5: chat off (as shipped): the server's one fixed message is shown as it is", async () => {
    fakeApi(routes(() => view({ chat: { state: "off" } }), [{ error: CHAT_OFF, code: "chat-off" }, 503]));
    render(<ChatPanel params={{ subject_kind: "idea", subject_id: R1 }} />);
    await settle();
    expect(screen.getByTestId("chat-disclosure").textContent).toContain("chat off");
    fireEvent.click(screen.getByTestId("chat-disclosure").querySelector(".ws-summary")!);
    fireEvent.click(leafBtn("ask"));
    fireEvent.change(document.querySelector('[data-field="question"]')!, { target: { value: "anyone?" } });
    fireEvent.click(document.querySelector('[data-action="ask"]')!);
    await settle();
    expect(screen.getByTestId("chat-msg").textContent).toBe(CHAT_OFF);
  });

  it("V6: an enabled filter with no source is saved as such (no context), never widened to the whole vault", async () => {
    const b = fakeApi(routes(() => view()));
    render(<ChatPanel params={{ subject_kind: "session", subject_id: S1 }} />);
    await settle();
    expect(screen.getByTestId("chat-disclosure").textContent).toContain("the whole knowledge database");
    fireEvent.click(screen.getByTestId("chat-disclosure").querySelector(".ws-summary")!);
    fireEvent.click(leafBtn("scope"));
    fireEvent.click(document.querySelector('[data-field="only"]')!);
    fireEvent.click(document.querySelector('[data-action="save-scope"]')!);
    await settle();
    expect(b.bodies.find((x) => x.method === "PUT")!.body).toEqual({ enabled: true, sources: [] });
    expect(screen.getByTestId("chat-msg").textContent).toContain("no context");
  });
});
