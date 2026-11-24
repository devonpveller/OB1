// deno test src/contracts/cast_test.ts - rwr-cast-edit-api (slot 560) without a database: the request schemas (no user
// field, no URL as a route, at most 26 seats, no per-presenter model route), the routes in the document, user-only
// routes, and the fixed messages a refusal carries. The behaviour over a real database and two users is
// cast_integration_test.ts (contract-test/run-cast-tests.ps1).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CastFormatCreate, CastPresenterCreate, CastPresenterUpdate, CastTeamCreate, CastTeamUpdate, CastVoiceCreate, CastVoiceUpdate, ROUTE_RE,
} from "./schemas/cast.ts";
import { buildDocument } from "./gen.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import { castError, NO_SUCH } from "./repo/cast.ts";
import { Conflict } from "./repo/lifecycle.ts";
import { BadRequest } from "./logic/scope.ts";

type J = Record<string, unknown>;
const doc = buildDocument() as J;
const paths = doc.paths as Record<string, Record<string, J>>;

Deno.test("every cast route is in the document: voices, presenters, teams, formats - list, create, read, change, delete, copy", () => {
  const want: [string, string[]][] = [
    ["/workbench/contract/cast/voices", ["get", "post"]],
    ["/workbench/contract/cast/voices/{id}", ["get", "patch", "delete"]],
    ["/workbench/contract/cast/presenters", ["get", "post"]],
    ["/workbench/contract/cast/presenters/{id}", ["get", "patch", "delete"]],
    ["/workbench/contract/cast/presenters/{id}/copy", ["post"]],
    ["/workbench/contract/cast/presenters/{id}/share-preview", ["get"]],
    ["/workbench/contract/cast/teams/{id}/share-preview", ["get"]],
    ["/workbench/contract/cast/formats/{id}/share-preview", ["get"]],
    ["/workbench/contract/cast/teams", ["get", "post"]],
    ["/workbench/contract/cast/teams/{id}", ["get", "patch", "delete"]],
    ["/workbench/contract/cast/teams/{id}/copy", ["post"]],
    ["/workbench/contract/cast/formats", ["get", "post"]],
    ["/workbench/contract/cast/formats/{id}", ["get", "patch", "delete"]],
    ["/workbench/contract/cast/formats/{id}/copy", ["post"]],
  ];
  for (const [p, methods] of want) {
    assert(paths[p], `${p} is in the document`);
    assertEquals(Object.keys(paths[p]).sort(), [...methods].sort(), p);
  }
  // no MCP tool over a person's cast (D14 reads only; and the cast is per user)
  for (const [p, item] of Object.entries(paths)) {
    if (p.includes("/cast/")) for (const op of Object.values(item)) assertEquals(op["x-mcp-tool"], undefined, p);
  }
});

Deno.test("the cast routes are user-only: a service key has no cast", () => {
  for (const p of ["/workbench/contract/cast/presenters", "/workbench/contract/cast/teams/x/copy", "/workbench/contract/cast/voices"]) {
    assert(USER_ONLY.test(p), p);
  }
  assertEquals(USER_ONLY.test("/workbench/contract/presenters"), false, "slot 330's read stays as it was");
});

Deno.test("no body names a user, and an unknown field is refused", () => {
  const v = { route: "local-tts", voice: "bm_george" };
  for (const extra of [{ owner_sub: "someone" }, { user: "someone" }, { actor_sub: "x" }]) {
    assertEquals(CastVoiceCreate.safeParse({ ...v, ...extra }).success, false);
    assertEquals(CastPresenterCreate.safeParse({ name: "a", voice_id: "v", ...extra }).success, false);
    assertEquals(CastTeamCreate.safeParse({ name: "t", members: ["p"], ...extra }).success, false);
    assertEquals(CastFormatCreate.safeParse({ name: "f", team_id: "t", ...extra }).success, false);
  }
});

Deno.test("a row is made private: no create body can share it (sharing is its own step, after the preview)", () => {
  assertEquals(CastPresenterCreate.safeParse({ name: "a", voice_id: "v", shared: true }).success, false);
  assertEquals(CastTeamCreate.safeParse({ name: "t", members: ["p"], shared: true }).success, false);
  assertEquals(CastFormatCreate.safeParse({ name: "f", team_id: "t", shared: true }).success, false);
  assert(CastPresenterUpdate.safeParse({ shared: true, share_digest: "abc" }).success);
  assert(CastTeamUpdate.safeParse({ shared: false }).success);
});

Deno.test("a presenter has no model route field (phase J, operator-gated): naming one is refused", () => {
  for (const k of ["model_route", "model", "route", "url", "endpoint"]) {
    assertEquals(CastPresenterCreate.safeParse({ name: "a", voice_id: "v", [k]: "local-large" }).success, false, k);
    assertEquals(CastPresenterUpdate.safeParse({ [k]: "local-large" }).success, false, k);
  }
});

Deno.test("a route is a LiteLLM model name, never a URL (voice links and a format's script route)", () => {
  for (const ok of ["local-tts", "local-large", "local-large:nothink", "qwen3.6-27b"]) assert(ROUTE_RE.test(ok), ok);
  for (const bad of ["http://evil.example/v1", "https://api.openai.com", "//host/x", "local tts", "a/b", "", "-x", "llama-cpp:8080/v1"]) {
    assertEquals(ROUTE_RE.test(bad), false, bad);
    assertEquals(CastVoiceCreate.safeParse({ route: bad, voice: "bm_george" }).success, false, bad);
    assertEquals(CastVoiceUpdate.safeParse({ route: bad }).success, false, bad);
    assertEquals(CastFormatCreate.safeParse({ name: "f", team_id: "t", script_route: bad }).success, false, bad);
  }
});

Deno.test("a team: 1..25 presenters in order plus the user's seat (26 seats at most), the seat 0..25", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  assert(CastTeamCreate.safeParse({ name: "t", members: ids(25), user_seat: 25 }).success);
  assertEquals(CastTeamCreate.safeParse({ name: "t", members: ids(26) }).success, false, "26 presenters leave no seat for the user");
  assertEquals(CastTeamCreate.safeParse({ name: "t", members: [] }).success, false);
  assertEquals(CastTeamCreate.safeParse({ name: "t", members: ["p"], user_seat: -1 }).success, false);
  assertEquals(CastTeamCreate.safeParse({ name: "t", members: ["p"], user_seat: 26 }).success, false);
  assertEquals(CastTeamUpdate.safeParse({ user_seat: 1.5 }).success, false);
});

Deno.test("text fields refuse control characters (a NUL never reaches Postgres) and blank names", () => {
  assertEquals(CastPresenterCreate.safeParse({ name: "a", voice_id: "v", stance: "x\u0000y" }).success, false);
  assertEquals(CastPresenterCreate.safeParse({ name: "   ", voice_id: "v" }).success, false);
  assert(CastPresenterCreate.safeParse({ name: "a", voice_id: "v", backstory: "line one\nline two\ttab" }).success);
});

Deno.test("a database refusal becomes a fixed message: no row text, no value, reaches a caller or a log", () => {
  const pg = (code: string, message: string) => Object.assign(new Error(message), { fields: { code, message } });
  const dup = castError(pg("23505", 'duplicate key value violates unique constraint "podcast_teams_owner_sub_name_key" DETAIL: Key (owner_sub, name)=(sub-a, SecretTeamName)'));
  assert(dup instanceof Conflict);
  assertEquals((dup as Error).message.includes("SecretTeamName"), false);
  // the one-default-format index is its own message (not "name already taken")
  const def = castError(Object.assign(new Error("dup"), { fields: { code: "23505", constraint: "uq_podcast_formats_default", message: 'duplicate key value violates unique constraint "uq_podcast_formats_default"' } }));
  assert(def instanceof Conflict);
  assert(/default format/.test((def as Error).message) && !/name/.test((def as Error).message), (def as Error).message);
  assert(/name is already taken/.test((dup as Error).message));
  assert(castError(pg("23503", "violates foreign key")) instanceof Conflict);
  assert(castError(pg("23514", "violates check")) instanceof BadRequest);
  const other = new Error("x");
  assertEquals(castError(other), other);
});

Deno.test("another user's row and a missing one share one message per kind", () => {
  assertEquals(NO_SUCH, { voice: "no such voice", presenter: "no such presenter", team: "no such team", format: "no such format", source: "no such source" });
});
