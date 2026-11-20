// The digest's owner comes from ONE place (owner-sub.ts): the database's record for the run's inlet connection
// (rw-inlet-stamp, plan 08 PD2, slot 470; rw-boundary-digest round 2 F6 made it one function). No env owner variable,
// no literal, no fallback; no other file of the recipe reads an owner variable or carries an "operator" fallback.
// Run: deno test --allow-read src/enrich/owner-sub.test.ts
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { digestOwner, digestOwnerResolver, InletOwnerError, inletConnection, ownerArg, subjectOk } from "./owner-sub.ts";

function rest(answers: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), body });
    const a = answers[String(body.p_id)] ?? { status: 404, body: { message: "no owner" } };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { f, calls };
}
const envOf = (m: Record<string, string>) => (k: string) => m[k];

Deno.test("the owner is the record's for INLET_CONNECTION, asked through rpc/inlet_connection_owner", async () => {
  const { f, calls } = rest({ gmail: { status: 200, body: "sub-a" }, "gmail-b": { status: 200, body: "sub-b" } });
  assertEquals(await digestOwner("http://rest/", envOf({ INLET_CONNECTION: "gmail" }), f), "sub-a");
  assertEquals(await digestOwner("http://rest", envOf({ INLET_CONNECTION: " gmail-b " }), f), "sub-b");
  assertEquals(calls.map((c) => c.url), ["http://rest/rest/v1/rpc/inlet_connection_owner", "http://rest/rest/v1/rpc/inlet_connection_owner"]);
  assertEquals(calls.map((c) => c.body.p_id), ["gmail", "gmail-b"]);
});

Deno.test("no connection, no record, or an owner that is not a subject: refused, and no env owner is ever read", async () => {
  const { f, calls } = rest({ gmail: { status: 200, body: "operator" }, svc: { status: 200, body: "service:podcast" }, blank: { status: 200, body: "" } });
  const owners = { DIGEST_OWNER_SUB: "sub-x", PODCAST_OWNER_SUB: "sub-y", WORKSPACE_DEFAULT_SUB: "sub-z" };
  await assertRejects(() => digestOwner("http://rest", envOf(owners), f), InletOwnerError, "INLET_CONNECTION is not set");
  assertEquals(calls.length, 0); // nothing asked, nothing read
  await assertRejects(() => digestOwner("http://rest", envOf({ ...owners, INLET_CONNECTION: "Gmail!" }), f), InletOwnerError, "not a connection id");
  await assertRejects(() => digestOwner("http://rest", envOf({ ...owners, INLET_CONNECTION: "nobody" }), f), InletOwnerError, "no owner is recorded");
  for (const c of ["gmail", "svc", "blank"]) {
    await assertRejects(() => digestOwner("http://rest", envOf({ ...owners, INLET_CONNECTION: c }), f), InletOwnerError, "not a valid subject");
  }
  const down = (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch;
  await assertRejects(() => digestOwner("http://rest", envOf({ INLET_CONNECTION: "gmail" }), down), InletOwnerError, "could not be read");
});

Deno.test("the resolver keeps a good answer and asks again after a refusal", async () => {
  let up = false;
  const f = (async () => up ? new Response(JSON.stringify("sub-a")) : new Response("{}", { status: 404 })) as typeof fetch;
  const r = digestOwnerResolver("http://rest", envOf({ INLET_CONNECTION: "gmail" }), f);
  await assertRejects(() => r(), InletOwnerError);
  up = true;
  assertEquals(await r(), "sub-a");
  up = false;
  assertEquals(await r(), "sub-a");
});

Deno.test("subjectOk is the database's inlet_subject_ok; inletConnection and ownerArg refuse what it refuses", () => {
  for (const ok of ["sub-a", "a1b2c3d4e5f6", "user@example.org", "https://idp.example/u/1"]) assert(subjectOk(ok), ok);
  for (const bad of ["", " sub", "sub a", "operator", "OPERATOR", "service:x", "System:y", "anonymous:z", "-lead", 'q"uote', null, 7]) {
    assert(!subjectOk(bad), String(bad));
  }
  assertEquals(inletConnection(envOf({ INLET_CONNECTION: "gmail" })), "gmail");
  assertEquals(ownerArg(["capture", "--owner=sub-a"]), "sub-a");
  assertThrows(() => ownerArg(["capture"]), InletOwnerError, "--owner=<subject> is required");
  assertThrows(() => ownerArg(["capture", "--owner=operator"]), InletOwnerError, "not a valid subject");
  assertThrows(() => ownerArg(["capture", "--owner="]), InletOwnerError, "not a valid subject");
});

Deno.test("no other file of the recipe reads an owner variable or carries the operator fallback", async () => {
  const root = new URL("../../", import.meta.url);
  const offenders: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) { if (!["node_modules", ".git"].includes(e.name)) await walk(u); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || u.pathname.endsWith("/src/enrich/owner-sub.ts")) continue;
      const src = await Deno.readTextFile(u);
      if (/(DIGEST_OWNER_SUB|PODCAST_OWNER_SUB|WORKSPACE_DEFAULT_SUB)/.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")) ||
          /\|\|\s*"operator"/.test(src) || /OWNER_SUB",\s*"operator"/.test(src)) offenders.push(u.pathname.split("/daily-digest/")[1]);
    }
  };
  await walk(root);
  assertEquals(offenders, []);
});
