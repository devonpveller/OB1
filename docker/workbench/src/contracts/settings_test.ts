// deno test src/contracts/settings_test.ts - rw-p7a-tts round 2 (tester D3): the archive destination is a
// GLOBAL setting. Only an admin writes it (single-user mode: the default subject), and only to an allowed
// archive mount or a directory inside one. No database: the rules are pure.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { allowedMounts, validateDestination } from "./repo/system.ts";
import { settingsAdmin } from "./routes/system.ts";
import { BadRequest } from "./logic/scope.ts";
import type { Identity } from "../middleware/identity.ts";

const who = (o: Partial<Identity>): Identity => ({ sub: "operator", actor: "operator", name: "", key: "operator", kind: "default", admin: false, impersonating: null, ...o });
const single = { defaultSub: "operator", defaultName: "Operator", header: "X-Test-Sub", nameHeader: "", signIn: false };
const signIn = { ...single, header: "", signIn: true };

Deno.test("settings admin: single-user mode = the default subject; another header user, a service or anonymous may not", () => {
  assert(settingsAdmin(who({}), single));
  // rw-privacy-hardening (400-A4): the header is the edge's word, not the operator's - a header request is a header user even when it names the default subject
  assertEquals(settingsAdmin(who({ kind: "header" }), single), false, "a header naming the default subject is not the admin");
  assertEquals(settingsAdmin(who({ sub: "lab-bee", kind: "header" }), single), false);
  assertEquals(settingsAdmin(who({ sub: "service:internal", kind: "service" }), single), false);
  assertEquals(settingsAdmin(who({ sub: "anonymous:", kind: "anonymous" }), single), false);
});

Deno.test("settings admin: with sign-in, only a member of the admin group (the default subject alone is not enough)", () => {
  assert(settingsAdmin(who({ sub: "alice", kind: "user", admin: true }), signIn));
  assertEquals(settingsAdmin(who({ sub: "operator", kind: "user", admin: false }), signIn), false);
  assertEquals(settingsAdmin(who({ sub: "service:internal", kind: "service", admin: true }), signIn), false);
});

Deno.test("destination: only an allowed mount, or a directory inside one; everything else is 400", () => {
  const def = { type: "destination", default: { mount: "podcast-archive" } };
  const allowed = allowedMounts(def);
  assertEquals(allowed, ["podcast-archive"]);
  assertEquals(validateDestination({ mount: "podcast-archive" }, "/mounts", allowed), { mount: "podcast-archive" });
  assertEquals(validateDestination({ path: "/mounts/podcast-archive" }, "/mounts", allowed), { path: "/mounts/podcast-archive" });
  assertEquals(validateDestination({ path: "/mounts/podcast-archive/alt/" }, "/mounts", allowed), { path: "/mounts/podcast-archive/alt" });
  for (const bad of [{ mount: "other-mount" }, { path: "/tmp/tester-ephemeral" }, { path: "/app" }, { path: "/mounts" }, { path: "/mounts/podcast-archive-alt" },
    { path: "/mounts/podcast-archive/../x" }, { path: "/mounts/podcast-archive/./x" }, { path: "/mounts/podcast-archive//x" }, { path: "mounts/podcast-archive" },
    { path: "/mounts/podcast-archive/a\\b" }, { path: "/mounts/podcast-archive/a\u0000b" }, {}, { mount: "podcast-archive", path: "/mounts/podcast-archive" }, null, "x", { mount: 1 }]) {
    assertThrows(() => validateDestination(bad, "/mounts", allowed), BadRequest, undefined, JSON.stringify(bad));
  }
  // the registry entry names more mounts (a media server mounted at /mounts/media-server) -> those too
  const wider = allowedMounts({ ...def, allowed_mounts: ["podcast-archive", "media-server"] });
  assertEquals(validateDestination({ mount: "media-server" }, "/mounts", wider), { mount: "media-server" });
});
