// rw-mcp-identity round 5 (PD2's integration round): GET /research/lookup?key=<research_key> was refused 403 "two
// different access keys", because the identity middleware handed the lookup's own `key` to resolveCaller. The filed,
// resend and report-isolation e2e poll that route. RED at 8adb59e: the middleware passes ?key= raw (the source check
// below), and the "the defect" test shows what that does.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadIdentityConfig, resolveCaller } from "./mcp-identity.ts";
import { accessKeyFromQuery, KEY_PARAM_NOT_ACCESS_KEY } from "./access-key-query.ts";

const FULL = "full-lane-access-key-round5-0123456789abcdef";
const PERS = "personal-lane-access-key-round5-0123456789ab";
const OP = "op-sub-round5-a1b2c3";
const RK = "research-key:what-is-the-lookup-key-1234";
const CFG = loadIdentityConfig((k) => ({ MCP_ACCESS_KEY: FULL, MCP_PERSONAL_ACCESS_KEY: PERS, WORKSPACE_DEFAULT_SUB: OP } as Record<string, string>)[k]);

// what the middleware does for one request: the headers, and the route's own ?key= through accessKeyFromQuery
async function asRoute(method: string, path: string, h: Record<string, string>, query: Record<string, string>) {
  const low = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  const params = new URLSearchParams(query);
  return await resolveCaller((n) => low[n.toLowerCase()], Object.keys(h), accessKeyFromQuery(method, path, params), CFG);
}

Deno.test("the defect (8adb59e's wiring): a lookup's research key offered as an access key is refused 403", async () => {
  const raw = await resolveCaller((n) => (n === "x-brain-key" ? FULL : undefined), ["x-brain-key"], RK, CFG);
  assertEquals(raw.ok, false);
  assertEquals((raw as { status: number }).status, 403);
});

Deno.test("GET /research/lookup: ?key= is the research key, never an access key", async () => {
  const ok = await asRoute("GET", "/research/lookup", { "x-brain-key": FULL }, { key: RK });
  assert(ok.ok, "an authenticated lookup with its research key answers");
  assertEquals([ok.caller.lane, ok.caller.subject], ["full", OP]);
  const lower = await asRoute("get", "/research/lookup", { "x-brain-key": FULL }, { key: RK });
  assert(lower.ok, "the method is compared case-insensitively");
  // the access key in the query is NOT an access key here: no header = no key = 401
  const noHeader = await asRoute("GET", "/research/lookup", {}, { key: FULL });
  assertEquals((noHeader as { status: number }).status, 401);
  // the header rules are untouched on the lookup
  const forged = await asRoute("GET", "/research/lookup", { "x-brain-key": FULL, "x-on-behalf-of": "someone" }, { key: RK });
  assertEquals((forged as { status: number }).status, 403, "a user header is still refused");
  const twoHeaders = await asRoute("GET", "/research/lookup", { "x-brain-key": FULL, "x-access-key": PERS }, { key: RK });
  assertEquals((twoHeaders as { status: number }).status, 403, "two different header keys are still refused");
  const bearer = await asRoute("GET", "/research/lookup", { "x-brain-key": FULL, authorization: "Bearer x" }, { key: RK });
  assertEquals((bearer as { status: number }).status, 403, "the full lane still never takes an Authorization header");
});

Deno.test("everywhere else ?key= IS an access key and the round-2 two-keys rule holds", async () => {
  for (const [m, p] of [["POST", "/"], ["GET", "/"], ["POST", "/mcp"], ["POST", "/research/persist"], ["GET", "/research/lookup/"], ["POST", "/research/lookup"], ["GET", "/RESEARCH/LOOKUP"]]) {
    const two = await asRoute(m, p, { "x-brain-key": FULL }, { key: PERS });
    assertEquals((two as { status: number }).status, 403, `${m} ${p}: two different keys`);
    const q = await asRoute(m, p, {}, { key: FULL });
    assert(q.ok, `${m} ${p}: the ?key= form still authenticates`);
  }
  assertEquals([...KEY_PARAM_NOT_ACCESS_KEY], ["GET /research/lookup"], "the exception list is exactly the lookup");
});

Deno.test("index.ts's identity middleware takes ?key= through accessKeyFromQuery, never raw", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const mw = src.slice(src.indexOf('app.use("*"'), src.indexOf("function researchAuthed"));
  assert(mw.length > 0, "the middleware is found");
  assert(/accessKeyFromQuery\(c\.req\.method,\s*c\.req\.path,/.test(mw), "the middleware uses accessKeyFromQuery");
  assert(!/resolveCaller\([^;]*searchParams\.get\("key"\)/.test(mw), "the middleware never hands the raw ?key= to resolveCaller");
});
