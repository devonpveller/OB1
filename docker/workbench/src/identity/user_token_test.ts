// deno test --allow-env --allow-read src/identity/user_token_test.ts - rw-mcp-identity round 2 (tester F1): openbrain-mcp's
// contract calls are served as THEIR caller. The workbench's service key `mcp` alone is service:mcp (nobody); with
// x-ob-user-token it is the token's sub - after the workbench verified the token itself against the static JWKS. Written
// to FAIL on 27504ae's workbench (no such header: an mcp-key call with A's or B's token is service:mcp there; the
// operator's WORKBENCH_KEY is what openbrain-mcp sent for everyone, and it is the default subject).
import { assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import * as seamMod from "../middleware/identity.ts";
import { identityOf, identitySeam, seamDeps } from "../middleware/identity.ts";

const ISS = "https://auth.lab.invalid/application/o/open-webui/";
const AUD = "owui-client";
const WB = "internal-key-0123456789abcdef";
const MCPK = "mcp-svc-key-0123456789abcdef";
const OWUIK = "owui-svc-key-0123456789abcdef";
const OP = "ak-operator-1";

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const enc = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)));
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
async function tok(sub: string, extra: Record<string, unknown> = {}, key: CryptoKey = kp.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const si = `${enc({ alg: "RS256", kid: "k1" })}.${enc({ iss: ISS, aud: AUD, azp: AUD, sub, iat: now, exp: now + 300, ...extra })}`;
  return `${si}.${b64(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(si)))}`;
}
const ENV: Record<string, string> = {
  WORKBENCH_KEY: WB, WORKSPACE_DEFAULT_SUB: OP, WORKSPACE_SERVICE_KEYS: `mcp=${MCPK};owui=${OWUIK}`,
  MCP_OWUI_OIDC_ISSUER: ISS, MCP_OWUI_OIDC_AUDIENCE: AUD, MCP_OWUI_OIDC_JWKS: JSON.stringify({ keys: [pub] }),
};

function app(env: Record<string, string>) {
  const a = new Hono();
  a.use("*", identitySeam(seamDeps(null, (k) => env[k])));
  const who = async (c: Parameters<typeof identityOf>[0]) => { const w = await identityOf(c); return c.json({ sub: w.sub, actor: w.actor, kind: w.kind }); };
  a.get("/workbench/contract/ideas", who);
  a.post("/workbench/contract/diff-check", who);
  a.post("/workbench/contract/sessions/x/steer", who);
  a.get("/workbench/sources", who);
  return a;
}
async function call(a: Hono, path: string, h: Record<string, string>, method = "GET") {
  const r = await a.request(path, { method, headers: { host: "workbench", ...h } });
  const j = r.status === 200 ? await r.json() : null;
  return { status: r.status, ...(j ?? {}) } as { status: number; sub?: string; actor?: string; kind?: string };
}

Deno.test("the mcp service key alone is service:mcp (nobody), never the operator", async () => {
  const r = await call(app(ENV), "/workbench/contract/ideas", { "x-brain-key": MCPK });
  assertEquals([r.status, r.sub, r.kind], [200, "service:mcp", "service"]);
  const op = await call(app(ENV), "/workbench/contract/ideas", { "x-brain-key": WB });
  assertEquals([op.status, op.sub], [200, OP], "WORKBENCH_KEY stays the operator (the full lane)");
});

Deno.test("mcp key + a verified user token = that user (A, and B), actor service:mcp", async () => {
  const a = app(ENV);
  for (const sub of [OP, "ak-user-b"]) {
    const r = await call(a, "/workbench/contract/ideas", { "x-brain-key": MCPK, "x-ob-user-token": await tok(sub) });
    assertEquals([r.status, r.sub, r.actor, r.kind], [200, sub, "service:mcp", "on-behalf"]);
  }
  const d = await call(a, "/workbench/contract/diff-check", { "x-brain-key": MCPK, "x-ob-user-token": await tok("ak-user-b") }, "POST");
  assertEquals([d.status, d.sub], [200, "ak-user-b"], "the one POST contract read");
});

Deno.test("a bad token is 401 (never a downgrade); the header from any other key, route or alongside x-on-behalf-of is 403", async () => {
  const a = app(ENV);
  const bad: Array<[string, string]> = [
    ["another key", await tok("ak-user-b", {}, other.privateKey)], ["expired", await tok("ak-user-b", { exp: 1 })],
    ["wrong audience", await tok("ak-user-b", { aud: "x", azp: "x" })], ["wrong issuer", await tok("ak-user-b", { iss: "https://evil.invalid/" })],
    ["the placeholder", await tok("operator")], ["a service sub", await tok("service:internal")], ["not a JWT", "abc"],
  ];
  for (const [why, t] of bad) {
    const r = await call(a, "/workbench/contract/ideas", { "x-brain-key": MCPK, "x-ob-user-token": t });
    assertEquals(r.status, 401, why);
  }
  const good = await tok("ak-user-b");
  for (const [why, h, path, method] of [
    ["WORKBENCH_KEY (the operator) + token", { "x-brain-key": WB, "x-ob-user-token": good }, "/workbench/contract/ideas", "GET"],
    ["owui's service key + token", { "x-brain-key": OWUIK, "x-ob-user-token": good }, "/workbench/contract/ideas", "GET"],
    ["no key + token", { "x-ob-user-token": good }, "/workbench/contract/ideas", "GET"],
    ["a non-contract route", { "x-brain-key": MCPK, "x-ob-user-token": good }, "/workbench/sources", "GET"],
    ["a contract WRITE", { "x-brain-key": MCPK, "x-ob-user-token": good }, "/workbench/contract/sessions/x/steer", "POST"],
    ["with x-on-behalf-of", { "x-brain-key": MCPK, "x-ob-user-token": good, "x-on-behalf-of": OP }, "/workbench/contract/ideas", "GET"],
  ] as Array<[string, Record<string, string>, string, string]>) {
    const r = await call(a, path, h, method);
    assertEquals(r.status === 403 || r.status === 401, true, `${why}: got ${r.status}`);
    assertEquals(r.sub, undefined, `${why}: served nobody`);
  }
  // no provider configured: the header is refused, the key alone still nobody
  const noProv = { ...ENV, MCP_OWUI_OIDC_ISSUER: "", MCP_OWUI_OIDC_AUDIENCE: "", MCP_OWUI_OIDC_JWKS: "" };
  assertEquals((await call(app(noProv), "/workbench/contract/ideas", { "x-brain-key": MCPK, "x-ob-user-token": good })).status, 403);
});

Deno.test("configuration: the provider is all three or none", () => {
  const cfg = (seamMod as Record<string, unknown>).userTokenConfig as (e: (k: string) => string | undefined) => unknown;
  let threw = false;
  try { cfg((k) => ({ MCP_OWUI_OIDC_ISSUER: ISS } as Record<string, string>)[k]); } catch { threw = true; }
  assertEquals(threw, true);
  assertEquals(cfg(() => undefined), null);
});

Deno.test("the module is a byte-identical copy of openbrain-mcp's", async () => {
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const here = norm(await Deno.readTextFile(new URL("./mcp_identity.ts", import.meta.url)));
  let theirs = "";
  try { theirs = norm(await Deno.readTextFile(new URL("../../../../integrations/kubernetes-deployment/mcp-identity.ts", import.meta.url))); } catch { return; } // the image has only this tree
  assertEquals(here, theirs);
});
