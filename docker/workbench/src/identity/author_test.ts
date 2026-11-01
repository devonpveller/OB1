// deno test src/identity/author_test.ts - edge-b5-portal-retire (tester t-edge-b5 D1).
// The change author written into the vault history, the source revisions and the contract trail
// comes from the identity SEAM only - the signed-in user (a verified Authentik token) or a configured
// edge identity header - never from a header any client can send. Remote-User, X-Forwarded-User,
// X-Remote-User and X-Forwarded-Preferred-Username were the retired portal's (Authelia behind Caddy,
// which stripped client copies). With the portal gone nothing sets them legitimately and the tailnet
// route reaches the viewer directly, so a client-sent copy must change nothing.
// The image build runs this file (src/identity/ is in the test stage's gate). The notes, sources and
// note-history routers cannot be imported here (their repositories need the /recipes/_shared runtime
// mount), so they are held to the one author function by the last test, and measured end to end in
// the edge-b5 lab (journal/evidence/edge-b5-portal-retire/round2/).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono, type Context } from "hono";
import { identitySeam, seamDeps } from "../middleware/identity.ts";
import { authorOf as contractAuthor } from "../contracts/routes/http.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
};
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function hs256(claims: Record<string, unknown>) {
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}
const now = () => Math.floor(Date.now() / 1000);

const FORGED = {
  "Remote-User": "forged-author", "X-Forwarded-User": "forged-author", "X-Remote-User": "forged-author",
  "X-Forwarded-Preferred-Username": "forged-author",
};

// What a request's author is, under the real seam (a GET on a route a service key is served on too).
// `changeAuthor` is imported lazily so the RED run on the base (no such module) still reports the
// contract author it gets.
async function authors(e: Record<string, string>, headers: Record<string, string>) {
  let changeAuthor: ((c: Context, f: string) => string) | null = null;
  try { changeAuthor = (await import("./author.ts")).changeAuthor; } catch { /* base: absent */ }
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(e))));
  app.get("/workbench/contract/sources", (c: Context) => c.json({
    route: changeAuthor ? changeAuthor(c, "operator") : "(no author.ts)",
    contract: contractAuthor(c) ?? null, contractFallback: contractAuthor(c, "fallback"),
  }));
  const r = await app.request("http://h/workbench/contract/sources", { headers });
  assertEquals(r.status, 200, await r.clone().text());
  return await r.json();
}

Deno.test("no sign-in, the shipped default: a client-sent Remote-User / X-Forwarded-User / ... names no author", async () => {
  const e = { WORKBENCH_KEY: "internal-key-0123456789" };
  assertEquals(await authors(e, { "x-brain-key": "internal-key-0123456789", ...FORGED }), { route: "operator", contract: null, contractFallback: "fallback" });
});

Deno.test("a named internal service key: a header it sends names no author either", async () => {
  const e = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_SERVICE_KEYS: "digest=service-key-0123456789" };
  assertEquals(await authors(e, { "x-brain-key": "service-key-0123456789", ...FORGED }), { route: "operator", contract: null, contractFallback: "fallback" });
});

Deno.test("the configured edge identity header (no sign-in) is the author; the legacy headers are ignored", async () => {
  const e = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_IDENTITY_HEADER: "X-Test-Sub", WORKSPACE_IDENTITY_NAME_HEADER: "X-Test-Name" };
  const got = await authors(e, { "x-brain-key": "internal-key-0123456789", "x-test-sub": "bob", "x-test-name": "Bob", ...FORGED });
  assertEquals(got, { route: "Bob", contract: "Bob", contractFallback: "Bob" });
});

Deno.test("sign-in (the LAN door: Traefik + Authentik): the verified token's user is the author; the legacy headers are ignored", async () => {
  const e = { ...FA, WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789" };
  const token = await hs256({ iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub: "ak-sub-alice", exp: now() + 300, iat: now(), name: "Alice", email: "alice@example", groups: ["users"] });
  const got = await authors(e, { "x-brain-key": "door-key-0123456789", "x-authentik-jwt": token, ...FORGED });
  assertEquals(got, { route: "Alice", contract: "Alice", contractFallback: "Alice" });
});

// The routers that cannot be imported here: each one's author function is the shared one, and no
// non-test source under src/ reads a legacy identity header at all (any spelling or case).
Deno.test("every route module takes its author from the shared function; no source reads a legacy identity header", async () => {
  const root = new URL("../", import.meta.url);
  const legacy = /["'`](remote-user|x-forwarded-user|x-remote-user|x-forwarded-preferred-username)["'`]/i;
  const offenders: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      const r = rel + e.name;
      if (e.isDirectory) await walk(new URL(e.name + "/", dir), r + "/");
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") && legacy.test(await Deno.readTextFile(new URL(e.name, dir)))) offenders.push(r);
    }
  }
  await walk(root, "");
  assertEquals(offenders, []);
  for (const f of ["routes/notes.ts", "routes/sources.ts", "routes/note-history.ts", "contracts/routes/http.ts"]) {
    assert((await Deno.readTextFile(new URL(f, root))).includes("changeAuthor(c"), `${f} delegates to changeAuthor`);
  }
});
