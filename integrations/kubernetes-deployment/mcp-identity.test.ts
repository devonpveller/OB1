// deno test --allow-read mcp-identity.test.ts - rw-mcp-identity: who a request acts for (no network, no database).
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  callerStore, currentCaller, EXT_USER_NAMESPACE, extUserId, uuidV5, loadIdentityConfig, resolveCaller, validSubject, verifyUserToken,
  type IdentityConfig,
} from "./mcp-identity.ts";

const FULL = "full-key-0123456789abcdef0123456789abcdef";
const PERS = "personal-key-0123456789abcdef0123456789ab";
const OWUI = "owui-key-0123456789abcdef0123456789abcdef";
const ISS = "https://auth.lab.invalid/application/o/open-webui/";
const AUD = "owui-client-id";
const OP = "ak-operator-0001";
const NOW = 1_800_000_000;

const enc = (o: unknown) => btoa(typeof o === "string" ? o : JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function rsaKey(kid: string) {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pub = { ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid, use: "sig", alg: "RS256" };
  return { priv: k.privateKey, pub };
}
async function ecKey(kid: string) {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = { ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid, use: "sig" };
  return { priv: k.privateKey, pub };
}
async function mint(priv: CryptoKey, head: Record<string, unknown>, claims: Record<string, unknown>) {
  const si = `${enc(head)}.${enc(claims)}`;
  const algo = priv.algorithm.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const sig = await crypto.subtle.sign(algo, priv, new TextEncoder().encode(si));
  return `${si}.${b64(sig)}`;
}
const claims = (sub: string, extra: Record<string, unknown> = {}) => ({ iss: ISS, aud: AUD, sub, exp: NOW + 300, iat: NOW - 10, ...extra });

const rsa = await rsaKey("k1");
const ec = await ecKey("k2");
const other = await rsaKey("k1"); // same kid, a key the JWKS does not hold
const ENV: Record<string, string> = {
  MCP_ACCESS_KEY: FULL, MCP_PERSONAL_ACCESS_KEY: PERS, MCP_OWUI_ACCESS_KEY: OWUI, WORKSPACE_DEFAULT_SUB: OP,
  MCP_OWUI_OIDC_ISSUER: ISS, MCP_OWUI_OIDC_AUDIENCE: AUD, MCP_OWUI_OIDC_JWKS: JSON.stringify({ keys: [rsa.pub, ec.pub] }),
};
const cfgOf = (e: Record<string, string | undefined>) => loadIdentityConfig((k) => e[k]);
const CFG: IdentityConfig = cfgOf(ENV);

async function call(h: Record<string, string>, cfg = CFG, key: string | null = null) {
  const low = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return await resolveCaller((n) => low[n.toLowerCase()], Object.keys(h), key, cfg, NOW);
}

Deno.test("validSubject: the seam's rule, never the placeholder", () => {
  for (const s of ["ak-1", "0123abcd", "a".repeat(256)]) assertEquals(validSubject(s), s);
  for (const s of ["", " ak", "ak ", "operator", "OPERATOR", "service:x", "System:y", "anonymous:", "a b", "a\u0000b", "a".repeat(257), 42, null]) {
    assertEquals(validSubject(s), null, JSON.stringify(s));
  }
});

Deno.test("config: the owui lane is all four or none; it needs the operator's subject; keys never reused", () => {
  const off = cfgOf({ MCP_ACCESS_KEY: FULL, WORKSPACE_DEFAULT_SUB: OP });
  assertEquals([off.oidc, off.owuiKey, off.operatorSub], [null, "", OP]);
  const blank = cfgOf({ MCP_ACCESS_KEY: FULL });
  assertEquals(blank.operatorSub, null);
  assert(blank.warnings.some((w) => /no identity/i.test(w)));
  for (const k of ["MCP_OWUI_ACCESS_KEY", "MCP_OWUI_OIDC_ISSUER", "MCP_OWUI_OIDC_AUDIENCE", "MCP_OWUI_OIDC_JWKS"]) {
    assertThrows(() => cfgOf({ ...ENV, [k]: "" }), Error, "half-configured");
  }
  assertThrows(() => cfgOf({ ...ENV, WORKSPACE_DEFAULT_SUB: "" }), Error, "WORKSPACE_DEFAULT_SUB");
  assertThrows(() => cfgOf({ ...ENV, WORKSPACE_DEFAULT_SUB: "operator" }), Error, "not a usable subject");
  assertThrows(() => cfgOf({ ...ENV, WORKSPACE_DEFAULT_SUB: "service:x" }), Error, "not a usable subject");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_ACCESS_KEY: FULL }), Error, "must differ");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_ACCESS_KEY: PERS }), Error, "must differ");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_ACCESS_KEY: "short" }), Error, "32");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_OIDC_ISSUER: "http://auth.lab.invalid/" }), Error, "https");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_OIDC_JWKS: "{" }), Error, "not JSON");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_OIDC_JWKS: JSON.stringify({ keys: [{ kty: "oct", k: "x" }] }) }), Error, "no usable");
  assertThrows(() => cfgOf({ ...ENV, MCP_OWUI_OIDC_JWKS: JSON.stringify({ keys: [{ ...rsa.pub, d: "private" }] }) }), Error, "no usable");
  assertThrows(() => cfgOf({ ...ENV, MCP_ACCESS_KEY: "" }), Error, "MCP_ACCESS_KEY");
});

Deno.test("lanes: unknown key 401; the full lane is the operator; the personal lane has no identity", async () => {
  assertEquals((await call({ "x-brain-key": "nope" })).ok, false);
  assertEquals(((await call({})) as { status: number }).status, 401);
  const f = await call({ "x-brain-key": FULL });
  assert(f.ok); assertEquals([f.caller.lane, f.caller.subject, f.caller.operator], ["full", OP, true]);
  const q = await call({}, CFG, FULL); // ?key= form
  assert(q.ok); assertEquals(q.caller.subject, OP);
  const p = await call({ "x-brain-key": PERS });
  assert(p.ok); assertEquals([p.caller.lane, p.caller.subject], ["personal", null]);
  const o = await call({ "x-brain-key": OWUI });
  assert(o.ok); assertEquals([o.caller.lane, o.caller.subject], ["owui", null], "no token = no identity, not refused");
  const blank = cfgOf({ MCP_ACCESS_KEY: FULL });
  const fb = await call({ "x-brain-key": FULL }, blank);
  assert(fb.ok); assertEquals(fb.caller.subject, null, "no WORKSPACE_DEFAULT_SUB = no identity, never 'operator'");
});

Deno.test("forged identity off Open WebUI's token is refused (403), never ignored", async () => {
  const tok = await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b"));
  for (const key of [FULL, PERS, OWUI]) {
    for (const [h, v] of [["x-on-behalf-of", OP], ["X-OpenWebUI-User-Id", "u1"], ["x-openwebui-user-email", "a@b"], ["X-OpenWebUI-User-Jwt", tok],
      ["x-authentik-uid", OP], ["x-ob-user", OP], ["x-ob-subject", OP], ["x-user-id", OP], ["remote-user", OP], ["x-forwarded-user", OP]]) {
      const r = await call({ "x-brain-key": key, [h]: v });
      assertEquals(r.ok ? 200 : r.status, 403, `${key.slice(0, 4)} + ${h}`);
    }
  }
  for (const key of [FULL, PERS]) {
    const r = await call({ "x-brain-key": key, authorization: `Bearer ${tok}` });
    assertEquals(r.ok ? 200 : r.status, 403, `a user token on the ${key.slice(0, 4)} lane`);
  }
});

Deno.test("the owui lane: the token's sub is the subject; the operator only by its own sub", async () => {
  const a = await call({ "x-brain-key": OWUI, authorization: `Bearer ${await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims(OP))}` });
  assert(a.ok); assertEquals([a.caller.subject, a.caller.operator, a.caller.via], [OP, true, "token"]);
  const b = await call({ "x-brain-key": OWUI, authorization: `Bearer ${await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { aud: [AUD, "x"], azp: AUD }))}` });
  assert(b.ok); assertEquals([b.caller.subject, b.caller.operator], ["ak-user-b", false]);
  const e = await call({ "x-brain-key": OWUI, authorization: `Bearer ${await mint(ec.priv, { alg: "ES256", kid: "k2" }, claims("ak-user-c"))}` });
  assert(e.ok); assertEquals(e.caller.subject, "ak-user-c");
  const nokid = await call({ "x-brain-key": OWUI, authorization: `Bearer ${await mint(rsa.priv, { alg: "RS256" }, claims("ak-user-d"))}` });
  assert(nokid.ok); assertEquals(nokid.caller.subject, "ak-user-d");
});

Deno.test("a bad user token is 401, never a downgrade to no identity", async () => {
  const bTok = await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b"));
  const [h, , s] = bTok.split(".");
  const cases: Array<[string, string]> = [
    ["signed by a key the JWKS does not hold", await mint(other.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b"))],
    ["B's token re-written to name A", `${h}.${enc(claims(OP))}.${s}`],
    ["expired", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { exp: NOW - 120 }))],
    ["no expiry", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, { iss: ISS, aud: AUD, sub: "ak-user-b" })],
    ["not yet valid", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { nbf: NOW + 600 }))],
    ["issued in the future", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { iat: NOW + 600 }))],
    ["wrong issuer", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { iss: "https://evil.invalid/" }))],
    ["wrong audience", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { aud: "another-client" }))],
    ["wrong azp", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b", { azp: "another-client" }))],
    ["unknown kid", await mint(rsa.priv, { alg: "RS256", kid: "k9" }, claims("ak-user-b"))],
    ["alg none", `${enc({ alg: "none" })}.${enc(claims(OP))}.`],
    ["alg HS256", `${enc({ alg: "HS256", kid: "k1" })}.${enc(claims(OP))}.${s}`],
    ["RS256 header on the EC key", await mint(ec.priv, { alg: "RS256", kid: "k2" }, claims("ak-user-b"))],
    ["crit header", await mint(rsa.priv, { alg: "RS256", kid: "k1", crit: ["x"] }, claims("ak-user-b"))],
    ["the placeholder subject", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("operator"))],
    ["a service subject", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("service:internal"))],
    ["no subject", await mint(rsa.priv, { alg: "RS256", kid: "k1" }, { iss: ISS, aud: AUD, exp: NOW + 300 })],
    ["garbage", "a.b.c"],
  ];
  for (const [why, t] of cases) {
    const r = await call({ "x-brain-key": OWUI, authorization: `Bearer ${t}` });
    assertEquals(r.ok ? 200 : r.status, 401, why);
    if (!r.ok) assert(!r.error.includes(t.slice(0, 20)) || t === "a.b.c", `${why}: the refusal must not echo the token`);
  }
  for (const auth of ["Basic abc", "Bearer", `bearer ${bTok}`, `Bearer ${bTok} x`]) {
    const r = await call({ "x-brain-key": OWUI, authorization: auth });
    assertEquals(r.ok ? 200 : r.status, 401, auth.slice(0, 12));
  }
  await assertRejects(() => verifyUserToken(bTok, CFG.oidc!, NOW + 400), Error, "expired");
});

Deno.test("the subject lives only inside the request's scope; concurrent scopes never mix", async () => {
  assertThrows(() => currentCaller(), Error, "no default subject");
  const seen: string[] = [];
  await Promise.all(Array.from({ length: 40 }, (_, i) => {
    const sub = i % 2 ? "ak-user-b" : OP;
    return callerStore.run({ lane: "owui", subject: sub, via: "token", operator: sub === OP }, async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 15));
      await Promise.resolve();
      seen.push(`${i % 2}:${currentCaller().subject}`);
    });
  }));
  assertEquals(seen.filter((x) => x === `0:${OP}` || x === "1:ak-user-b").length, 40);
});

Deno.test("openbrain-ext's row owner: the operator keeps DEFAULT_USER_ID, everyone else a stable UUIDv5 of their own", async () => {
  const D = "11111111-2222-4333-8444-555555555555";
  assertEquals(await extUserId(OP, OP, D), D);
  const b1 = await extUserId("ak-user-b", OP, D), b2 = await extUserId("ak-user-b", OP, D), c = await extUserId("ak-user-c", OP, D);
  assertEquals(b1, b2);
  assert(b1 !== D && c !== b1);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b1), b1);
  // a known vector checks the algorithm itself: v5(DNS namespace, "www.example.com")
  assertEquals(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  assertEquals(b1, await uuidV5(EXT_USER_NAMESPACE, "ak-user-b"));
});

Deno.test("openbrain-ext carries a byte-identical copy of this module", async () => {
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const here = norm(await Deno.readTextFile(new URL("./mcp-identity.ts", import.meta.url)));
  const ext = norm(await Deno.readTextFile(new URL("../../docker/extensions-server/mcp-identity.ts", import.meta.url)));
  assertEquals(ext, here, "docker/extensions-server/mcp-identity.ts drifted from integrations/kubernetes-deployment/mcp-identity.ts");
});

Deno.test("the workbench carries a byte-identical copy too (it verifies openbrain-mcp's x-ob-user-token with it)", async () => {
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const here = norm(await Deno.readTextFile(new URL("./mcp-identity.ts", import.meta.url)));
  const wb = norm(await Deno.readTextFile(new URL("../../docker/workbench/src/identity/mcp_identity.ts", import.meta.url)));
  assertEquals(wb, here, "docker/workbench/src/identity/mcp_identity.ts drifted");
});

Deno.test("round 2 (tester b): two DIFFERENT keys on one request are refused 403, the same key twice is fine", async () => {
  const tb = await mint(rsa.priv, { alg: "RS256", kid: "k1" }, claims("ak-user-b"));
  const r1 = await call({ "x-brain-key": OWUI, authorization: `Bearer ${tb}` }, CFG, FULL);
  assertEquals(r1.ok ? 200 : r1.status, 403, "owui header + full ?key= + B token");
  const r2 = await call({ "x-brain-key": FULL }, CFG, OWUI);
  assertEquals(r2.ok ? 200 : r2.status, 403, "full header + owui ?key=");
  const r3 = await call({ "x-brain-key": OWUI, "x-access-key": FULL });
  assertEquals(r3.ok ? 200 : r3.status, 403, "x-brain-key + a different x-access-key");
  const r4 = await call({ "x-brain-key": FULL }, CFG, FULL);
  assertEquals(r4.ok && r4.caller.lane, "full", "the same key twice");
  const r5 = await call({ "x-brain-key": OWUI, authorization: `Bearer ${tb}` });
  assertEquals(r5.ok && r5.caller.token === tb, true, "the verified token is kept on the caller (for the workbench call)");
});
