// deno test src/sessions/cards_test.ts - research-workbench P4b (rw-p4b-sessions), pure: one card
// shape for every origin (D17), its origin badge and link back, what it is waiting on, where an
// interjection lands, the branch tree, and who may steer or cancel from it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  adminOf, badgeOf, cardOf, CARD_KEYS, type CardInput, linkOf, mayActOn, nextSteeringPoint, owuiBase, treeOf, waitingOn,
} from "./cards.ts";

const J = "99999999-9999-4999-8999-999999999999";
const IDEA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const base = (o: Partial<CardInput> = {}): CardInput => ({
  id: J, status: "running", origin: "workspace", caller: "workspace", inlet_ref: null, refinery_id: null, query: "q",
  progress: { phase: "gather" }, created_at: "2026-10-30T00:00:00Z", started_at: null, finished_at: null, queue_position: null,
  foreign: false, can_act: true,
  branches: [{ id: J, parent_job_id: null, branch_kind: "root", rooted_step_id: null, status: "running", query: "q", created_at: "2026-10-30T00:00:00Z" }],
  events: [], ...o,
});

Deno.test("P4b badge: every origin has a badge; an idea's job reads Idea Refinery", () => {
  for (const o of ["workspace", "owui", "mattermost", "notebook", "manual"]) {
    const b = badgeOf(o, null);
    assertEquals(b.key, o);
    assert(b.label.length > 0);
  }
  assertEquals(badgeOf("mattermost", { kind: "idea", id: IDEA }).key, "idea_refinery");
  assertEquals(badgeOf("mattermost", { kind: "idea", id: IDEA }).label, "Idea Refinery");
  // an unknown future origin still gets a badge (its key), never nothing
  assertEquals(badgeOf("podcast", null).key, "podcast");
});

Deno.test("P4b link back: OWUI under the base-URL setting only; workspace, refinery room, own session; none invented", () => {
  const owui = { kind: "chat_id", id: "chat-1/../x" };
  assertEquals(linkOf("owui", owui, J, ""), null, "the setting ships blank: no link");
  assertEquals(linkOf("owui", owui, J, "https://chat.example/"), { kind: "external", href: "https://chat.example/c/chat-1%2F..%2Fx" });
  assertEquals(linkOf("workspace", { kind: "document", id: "documents/u/a.md" }, J, ""), { kind: "panel", panel: "document", params: { path: "documents/u/a.md" } });
  assertEquals(linkOf("workspace", { kind: "refinery", id: IDEA }, J, ""), { kind: "panel", panel: "refinery", params: { idea_id: IDEA, focus: "room" } });
  assertEquals(linkOf("mattermost", { kind: "idea", id: IDEA }, J, ""), { kind: "panel", panel: "refinery", params: { idea_id: IDEA, focus: "room" } });
  assertEquals(linkOf("manual", null, J, ""), { kind: "panel", panel: "sessions", params: { session: J } });
  // badge-only: Mattermost and notebook carry no reference today - no link is invented
  assertEquals(linkOf("mattermost", null, J, "https://chat.example"), null);
  assertEquals(linkOf("notebook", null, J, "https://chat.example"), null);
  // a reference the card does not know how to open is not guessed at
  assertEquals(linkOf("mattermost", { kind: "thread_permalink", id: "javascript:alert(1)" }, J, ""), null);
  // a foreign card's inlet is null (owner-only), so it links nowhere - but a manual card still opens its session
  assertEquals(linkOf("owui", null, J, "https://chat.example"), null);
});

Deno.test("P4b the OWUI base URL: http(s) only, else blank", () => {
  assertEquals(owuiBase((k) => ({ WORKSPACE_OWUI_BASE_URL: "https://chat.example/" } as Record<string, string>)[k]), "https://chat.example");
  for (const bad of ["", "javascript:alert(1)", "ftp://x", "not a url"]) {
    assertEquals(owuiBase((k) => (k === "WORKSPACE_OWUI_BASE_URL" ? bad : undefined)), "");
  }
});

Deno.test("P4b waiting-on: the queue, the model, open branches, the stage", () => {
  assertEquals(waitingOn("queued", "queued", 0, 3).kind, "queue");
  assertEquals(waitingOn("queued", "queued", 0, 3).detail, "position 3");
  assertEquals(waitingOn("running", "model_down", 0, null).kind, "model");
  assertEquals(waitingOn("done", "done", 2, null).kind, "branches");
  assertEquals(waitingOn("running", "gather", 0, null), { kind: "stage", detail: "gather" });
  assertEquals(waitingOn("done", "done", 0, null).kind, "nothing");
});

Deno.test("P4b next steering point: the latest steering stage; due-process stages are never one", () => {
  const ev = [
    { id: 1, job_id: J, step_id: "s1", type: "stage", kind: "due_process", payload: { phase: "reuse" }, trail: null, created_at: "t" },
    { id: 2, job_id: J, step_id: "s2", type: "stage", kind: "steering", payload: { phase: "plan" }, trail: null, created_at: "t" },
    { id: 3, job_id: J, step_id: "s3", type: "stage", kind: "due_process", payload: { phase: "gather" }, trail: null, created_at: "t" },
  ];
  assertEquals(nextSteeringPoint(J, ev, true), { step_id: "s2", phase: "plan" });
  // one who may not act never gets a step id (rw-identity round 5)
  assertEquals(nextSteeringPoint(J, ev, false), { step_id: null, phase: "plan" });
  assertEquals(nextSteeringPoint(J, ev.filter((e) => e.kind === "due_process"), true), null);
});

Deno.test("P4b tree: every branch open or closed; a foreign viewer gets no branch text and no step", () => {
  const rows = [
    { id: J, parent_job_id: null, branch_kind: "root", rooted_step_id: null, status: "running", query: "the prompt", created_at: "t" },
    { id: "c1", parent_job_id: J, branch_kind: "steer", rooted_step_id: "s2", status: "queued", query: "my steer text", created_at: "t" },
    { id: "c2", parent_job_id: J, branch_kind: "gap", rooted_step_id: "s2", status: "done", query: "gap q", created_at: "t" },
  ];
  const t = treeOf(rows, false, true);
  assertEquals(t.map((b) => [b.id, b.open, b.pending]), [[J, true, false], ["c1", true, true], ["c2", false, false]]);
  const f = treeOf(rows, true, false);
  assert(f.every((b) => b.query === "" && b.rooted_step_id === null), JSON.stringify(f));
});

Deno.test("P4b authority: a user's job is its owner's; a service's job an admin's; an ownerless job the default subject's", () => {
  const alice = { sub: "alice" }, admin = { sub: "boss" };
  assertEquals(mayActOn("alice", alice, "prof", false), true);
  assertEquals(mayActOn("alice", admin, "prof", true), false, "an admin never acts on a USER's job (only while impersonating, as that user)");
  assertEquals(mayActOn("service:agent-org", admin, "prof", true), true);
  assertEquals(mayActOn("service:agent-org", alice, "prof", false), false, "a non-admin never acts on a service's job");
  assertEquals(mayActOn(null, { sub: "prof" }, "prof", false), true);
  assertEquals(mayActOn(null, alice, "prof", true), false);
  assertEquals(mayActOn(null, alice, null, true), false);
});

Deno.test("P4b admin: the token's admin group (not while impersonating); single-user mode's default subject", () => {
  assertEquals(adminOf({ sub: "boss", admin: true, impersonating: null }, { signIn: true, defaultSub: "prof" }), true);
  assertEquals(adminOf({ sub: "alice", admin: true, impersonating: { reason: "r", since: "t" } }, { signIn: true, defaultSub: "prof" }), false);
  assertEquals(adminOf({ sub: "prof", admin: false }, { signIn: true, defaultSub: "prof" }), false, "signed in, the default subject is no admin by itself");
  assertEquals(adminOf({ sub: "prof", admin: false }, { signIn: false, defaultSub: "prof" }), true);
  assertEquals(adminOf({ sub: "someone-from-a-header", admin: false }, { signIn: false, defaultSub: "prof" }), false);
});

Deno.test("P4b one card shape for every origin: the same keys, foreign or not", () => {
  const shapes = new Set<string>();
  for (const o of ["workspace", "owui", "mattermost", "notebook", "manual"]) {
    for (const foreign of [false, true]) {
      const c = cardOf(base({ origin: o, foreign, can_act: !foreign, query: foreign ? "" : "q" }), "");
      shapes.add(JSON.stringify(Object.keys(c).sort()));
      assertEquals(Object.keys(c).sort(), [...CARD_KEYS].sort());
      assert(c.tree.length >= 1, "a card always carries its tree");
    }
  }
  assertEquals(shapes.size, 1);
  // a foreign card carries no prompt and no inlet
  const f = cardOf(base({ origin: "owui", foreign: true, can_act: false, query: "", inlet_ref: null }), "https://chat.example");
  assertEquals([f.query, f.link], ["", null]);
  assertEquals(f.can_act, false);
});

Deno.test("P4b current artifact: the latest source when one arrived, else the stage; a source URL is shared", () => {
  const ev = [
    { id: 1, job_id: J, step_id: "s1", type: "stage", kind: "due_process", payload: { phase: "gather", message: "fetching" }, trail: null, created_at: "t" },
    { id: 2, job_id: J, step_id: null, type: "source", kind: "due_process", payload: { url: "https://ex.org/a", outcome: "admitted" }, trail: { kind: "admitted" }, created_at: "t" },
  ];
  assertEquals(cardOf(base({ events: ev }), "").current_artifact, { kind: "source", label: "https://ex.org/a" });
  assertEquals(cardOf(base({ events: ev.slice(0, 1) }), "").current_artifact, { kind: "stage", label: "gather" });
});
