// deno test origin.test.ts - D17 item 1: the caller's key decides the recorded origin.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { callerFor, inletRef, MismatchLog, onBehalfOf, parseCallers, promptOwner, resolveOrigin } from "./origin.ts";

const OWUI = "owui-key-0123456789abcdef";
const AO = "agent-org-key-0123456789ab";
const SHARED = "shared-mcp-key-0123456789";
const callers = parseCallers(`owui-tool=owui:${OWUI};agent-org=mattermost:${AO}`, SHARED, "manual");
const lanes = { notebook: "ob-research" };

Deno.test("each key names its caller; the shared key still authenticates as shared-key", () => {
  assertEquals(callerFor(OWUI, callers)?.name, "owui-tool");
  assertEquals(callerFor(AO, callers)?.origin, "mattermost");
  assertEquals(callerFor(SHARED, callers)?.shared, true);
  assertEquals(callerFor("nope", callers), null);
  assertEquals(callerFor("", callers), null);
});

Deno.test("the OWUI tool (sends origin=owui) is recorded owui; agent-org (sends agent / agent-org) is recorded mattermost", () => {
  assertEquals(resolveOrigin(callerFor(OWUI, callers)!, "owui", lanes), { origin: "owui", claimed: null, queueOrigin: "owui" });
  for (const sent of ["agent", "agent-org", "agent-org-advisory"]) {
    const r = resolveOrigin(callerFor(AO, callers)!, sent, lanes);
    assertEquals([r.origin, r.claimed], ["mattermost", sent]);
  }
});

Deno.test("a self-declared origin never wins over the key", () => {
  const r = resolveOrigin(callerFor(OWUI, callers)!, "notebook", lanes);
  assertEquals(r.origin, "owui");
  assertEquals(r.claimed, "notebook");
  assertEquals(r.queueOrigin, "owui", "a keyed caller cannot claim another lane");
  const s = resolveOrigin(callerFor(SHARED, callers)!, "workspace", lanes);
  assertEquals(s.origin, "manual");
});

Deno.test("transitional: a shared-key job keeps the digest's queue lane, but is RECORDED under the key's origin", () => {
  const r = resolveOrigin(callerFor(SHARED, callers)!, "notebook", lanes);
  assertEquals([r.origin, r.claimed, r.queueOrigin], ["manual", "notebook", "notebook"]);
});

Deno.test("the mismatch is logged once per caller and claimed value, naming the caller", () => {
  const lines: string[] = [];
  const log = new MismatchLog((l) => lines.push(l));
  const ao = callerFor(AO, callers)!;
  assert(log.note(ao, "agent", "mattermost"));
  assertEquals(log.note(ao, "agent", "mattermost"), false);
  assert(log.note(ao, "agent-org", "mattermost"));
  assertEquals(log.note(ao, null, "mattermost"), false);
  assertEquals(lines.length, 2);
  assert(lines[0].includes("caller=agent-org") && lines[0].includes("claimed=agent") && lines[0].includes("recorded=mattermost"));
});

Deno.test("inlet reference: an explicit inlet_ref, else the OWUI chat id", () => {
  assertEquals(inletRef({ callback: { chat_id: "c-1", message_id: "m" } }), { kind: "chat_id", id: "c-1" });
  assertEquals(inletRef({ inlet_ref: { kind: "mattermost_permalink", id: "https://mm/x/pl/abc" } }),
    { kind: "mattermost_permalink", id: "https://mm/x/pl/abc" });
  assertEquals(inletRef({}), null);
});

Deno.test("RESEARCH_CALLERS is validated: shape, key length, no shared or duplicate keys", () => {
  assertThrows(() => parseCallers("broken", SHARED, "manual"));
  assertThrows(() => parseCallers("a=owui:short", SHARED, "manual"));
  assertThrows(() => parseCallers(`a=owui:${OWUI};b=mattermost:${OWUI}`, SHARED, "manual"));
  assertThrows(() => parseCallers(`a=owui:${SHARED}`, SHARED, "manual"));
  assertEquals(parseCallers("", SHARED, "manual").map((c) => c.name), ["shared-key"]);
  // the error never echoes the key
  try {
    parseCallers(`Bad Name=owui:${OWUI}`, SHARED, "manual");
  } catch (e) {
    assertEquals(String((e as Error).message).includes(OWUI), false);
  }
});

// rw-identity: research started from Open WebUI is filed under its user - accepted from OWUI's key only.
Deno.test("on_behalf_of: accepted from the owui caller only; any other key naming a user is refused (403)", () => {
  const ws = parseCallers(`owui-tool=owui:${OWUI};agent-org=mattermost:${AO};workspace=workspace:ws-key-0123456789abcd`, SHARED, "manual");
  const by = (k: string) => callerFor(k, ws)!;
  assertEquals(onBehalfOf(by(OWUI), { on_behalf_of: " ak-alice " }), { sub: "ak-alice" });
  for (const k of [AO, "ws-key-0123456789abcd", SHARED]) {
    const r = onBehalfOf(by(k), { on_behalf_of: "ak-alice" });
    assert("error" in r && r.status === 403, `${by(k).name}: ${JSON.stringify(r)}`);
  }
  // none given = none (every caller)
  for (const k of [OWUI, AO, SHARED]) assertEquals(onBehalfOf(by(k), {}), { sub: null });
  // a reserved or malformed subject is refused even from OWUI
  for (const bad of ["service:internal", "system:backfill", "anonymous:", "a\nb", "x".repeat(256), 7, { sub: "x" }]) {
    const r = onBehalfOf(by(OWUI), { on_behalf_of: bad });
    assert("error" in r && r.status === 400, `${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
  }
});

Deno.test("promptOwner: the user named by OWUI; the workspace records its own user; every other caller is a service identity", () => {
  const ws = parseCallers(`owui-tool=owui:${OWUI};agent-org=mattermost:${AO};workspace=workspace:ws-key-0123456789abcd`, SHARED, "manual");
  const by = (k: string) => callerFor(k, ws)!;
  assertEquals(promptOwner(by(OWUI), "ak-alice"), { owner_sub: "ak-alice", actor_sub: "ak-alice" });
  assertEquals(promptOwner(by(OWUI), null), { owner_sub: "service:owui-tool", actor_sub: "service:owui-tool" });
  assertEquals(promptOwner(by(AO), null), { owner_sub: "service:agent-org", actor_sub: "service:agent-org" });
  assertEquals(promptOwner(by(SHARED), null), { owner_sub: "service:shared-key", actor_sub: "service:shared-key" });
  assertEquals(promptOwner(by("ws-key-0123456789abcd"), null), null);
});
