// deno test src/contracts/own_thoughts_integration_test.ts - rwr-own-thoughts-search-api round 2, over a REAL database built from
// the real initdb chain (440, 470, 480 and 530 included).
// SKIPPED unless OWN_DB_HOST is set. contract-test/run-own-thoughts-tests.ps1 runs it on a DISPOSABLE internal network:
// the staged compose chain + slot 480 (rw-owner-private-view), ob_app_memory (non-superuser, service_role member) and
// ob_workbench (480's role, a member of ob_app_memory), planted thoughts in BOTH planes for two users, the real route over
// the real seam with signed-in tokens, the workbench connecting as ob_workbench. Never point it at a live stack. Only
// counts and pass/fail are printed; a marker is never printed.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { Hono } from "hono";
import { identitySeam, seamDeps } from "../middleware/identity.ts";
import { ownThoughtsConfig } from "../identity/own_thoughts.ts";
import { poolDb } from "./db.ts";
import { newApp } from "./routes/http.ts";
import { registerOwnThoughts } from "./routes/own_thoughts.ts";

const HOST = Deno.env.get("OWN_DB_HOST");
const off = !HOST;
const mk = (user: string, password: string) => new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user, password }, 2, true);

const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
  WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789",
  WORKSPACE_SERVICE_KEYS: "digest=service-key-0123456789",
};
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function token(sub: string, groups: string[] = ["users"]) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub, exp: now + 300, iat: now, name: sub, email: `${sub}@example`, groups })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}
const as = async (sub: string, groups?: string[]) => ({ "x-brain-key": FA.WORKSPACE_DOOR_KEY, "x-authentik-jwt": await token(sub, groups) });

const A = "user-a-sub", B = "user-b-sub";
const M = { aOps: "PLANTED-A-OPS-0d2f4b61", aPers: "PLANTED-A-PERS-93ac17e8", bOps: "PLANTED-B-OPS-51d0aa", bPers: "PLANTED-B-PERS-7e42c1", shared: "PLANTED-SHARED-5be6c0", op: "PLANTED-OPERATOR-2c9d" };
const PATH = "/workbench/contract/own-thoughts/search";

type Hit = { id: string; title: string; snippet: string; private: boolean; marker: string; date: string };
const hits = (t: string) => (JSON.parse(t).results as Hit[]);

Deno.test({
  name: "own thoughts over the real chain: both planes for the owner; B, admin, service, anonymous, other roles get nothing",
  ignore: off, sanitizeOps: false, sanitizeResources: false,
  fn: async () => {
    const su = mk("postgres", Deno.env.get("OWN_SU_PW") ?? "");
    const wb = mk("ob_workbench", Deno.env.get("OWN_WB_PW") ?? "");
    const am = mk("ob_app_memory", Deno.env.get("OWN_APP_PW") ?? "");
    try {
      // plant (superuser; 470's insert guard is switched off around the load only, as the lab does for its fixtures)
      const s = await su.connect();
      try {
        await s.queryObject("BEGIN");
        await s.queryObject("ALTER TABLE public.thoughts DISABLE TRIGGER trg_inlet_stamp_thoughts");
        await s.queryObject("DELETE FROM public.thoughts WHERE content LIKE '%PLANTED-%'"); // a re-run plants afresh
        const plant = (c: string, u: string | null, exp: "ops" | "personal") =>
          s.queryObject(`INSERT INTO public.thoughts (content, metadata, exposure, user_id) VALUES ($1, jsonb_build_object('exposure', $3::text, 'friend', 'B-friend'), $3, $2)`, [c, u, exp]);
        await plant(`A ops note: gardens ${M.aOps}\nsecond line`, A, "ops");
        await plant(`A personal note: gardens ${M.aPers} and compost`, A, "personal");
        await plant(`B ops note: gardens ${M.bOps}`, B, "ops");
        await plant(`B personal note: gardens ${M.bPers}`, B, "personal");
        await plant(`A shared (unowned) note: gardens ${M.shared}`, null, "ops");
        await plant(`operator note: gardens ${M.op}`, "operator", "personal");
        await s.queryObject("ALTER TABLE public.thoughts ENABLE ALWAYS TRIGGER trg_inlet_stamp_thoughts");
        await s.queryObject("COMMIT");
      } finally {
        s.release();
      }

      const build = (env: Record<string, string>, pool: Pool) => {
        const a = new Hono();
        a.use("/workbench/*", identitySeam(seamDeps(null, (k) => env[k])));
        const contract = newApp();
        registerOwnThoughts(contract, { db: poolDb(pool), ownThoughtsCfg: ownThoughtsConfig((k) => env[k]) } as never);
        a.route("/", contract);
        return async (q: string, h: Record<string, string>) => {
          const r = await a.request(`http://h${PATH}?q=${encodeURIComponent(q)}`, { headers: h });
          return { status: r.status, text: await r.text() };
        };
      };
      const get = build(FA, wb);
      const seen = (t: string) => JSON.stringify({ ...JSON.parse(t), query: "" }); // the caller's own query comes back to them

      // A finds their personal AND ops thoughts, newest first, each private to them
      const mine = await get("gardens", await as(A));
      assertEquals(mine.status, 200, mine.text);
      const ah = hits(mine.text);
      assertEquals(ah.length, 2);
      assert(ah.every((h) => h.private === true && h.marker === "private to you"));
      assertEquals(ah[0].title.startsWith("A personal note"), true, "newest first (the personal one was planted second)");
      assertEquals((await get(M.aPers, await as(A))).text.includes("compost"), true);
      assertEquals(hits((await get(M.aOps, await as(A))).text).length, 1);
      assertEquals(hits((await get(M.aPers, await as(A))).text).length, 1);
      // never the shared, another user's or the operator's rows
      const g = seen(mine.text);
      for (const m of [M.shared, M.bOps, M.bPers, M.op]) assert(!g.includes(m), "A got a row that is not theirs");

      // why the function exists: the workbench role's table grant sees A's personal row through no query of its own
      const c = await wb.connect();
      try {
        const direct = (await c.queryObject(`SELECT count(*)::int AS n FROM public.thoughts WHERE user_id = $1 AND exposure = 'personal'`, [A])).rows as { n: number }[];
        assertEquals(direct[0].n, 0, "a direct table read as ob_workbench must not see the personal plane (the policy)");
      } finally {
        c.release();
      }

      // B: nothing of A's, in any plane, in any field; B's own are found
      for (const q of [M.aOps, M.aPers, "compost", "gardens", "second line", "B-friend", "A personal", "A ops"]) {
        const r = await get(q, await as(B));
        assertEquals(r.status, 200);
        const t = seen(r.text);
        for (const m of [M.aOps, M.aPers, "compost", "second line", "A personal", "A ops note"]) assert(!t.includes(m), `B saw A's text for q=${q}`);
        for (const m of [M.shared, M.op]) assert(!t.includes(m));
      }
      assertEquals(hits((await get("gardens", await as(B))).text).length, 2);
      // B asking for A's marker answers exactly as B asking for nothing (no count, no hint)
      const miss = JSON.parse((await get("zzz-nothing-zzz", await as(B))).text);
      assertEquals(JSON.parse((await get(M.aPers, await as(B))).text), { ...miss, query: M.aPers });
      // a non-owner admin: their own (none), never A's; a service: 403; anonymous: 401
      const admin = await get("gardens", await as("root-admin", ["users", "admins"]));
      assertEquals(hits(admin.text).length, 0);
      const svc = await get(M.aOps, { "x-brain-key": "service-key-0123456789" });
      assertEquals(svc.status, 403);
      assert(!svc.text.includes(M.aOps) && !svc.text.includes("results"));
      assertEquals((await get(M.aOps, { "x-brain-key": FA.WORKSPACE_DOOR_KEY })).status, 401);
      // a forged subject changes nothing
      const forged = (await build(FA, wb)(`${M.aPers}&sub=${A}&user_id=${A}`, await as(B)));
      assertEquals(hits(forged.text).length, 0);

      // sign-in off: the default identity (subject set) is the one person; a blank default, 'operator' (unusable) and a header identity get nothing
      const off1 = build({ WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DEFAULT_SUB: A }, wb);
      assertEquals(hits((await off1("gardens", { "x-brain-key": "internal-key-0123456789" })).text).length, 2);
      const off2 = build({ WORKBENCH_KEY: "internal-key-0123456789" }, wb);
      assertEquals(hits((await off2("gardens", { "x-brain-key": "internal-key-0123456789" })).text).length, 0);
      const off3 = build({ WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DEFAULT_SUB: "operator" }, wb);
      assertEquals(hits((await off3(M.op, { "x-brain-key": "internal-key-0123456789" })).text).length, 0, "the placeholder subject 'operator' is nobody's, though a thought carries it");
      const off4 = build({ WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DEFAULT_SUB: A, WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" }, wb);
      assertEquals(hits((await off4("gardens", { "x-brain-key": "internal-key-0123456789", "x-test-sub": A })).text).length, 0);

      // the function itself, called with a subject the seam would never send: nothing for B / unusable subjects / a short query
      const f = async (pool: Pool, sub: string | null, q: string, n = 25) => {
        const k = await pool.connect();
        try {
          return (await k.queryObject(`SELECT * FROM public.owner_private_thoughts_search($1, $2, $3)`, [sub, q, n])).rows as Record<string, unknown>[];
        } finally {
          k.release();
        }
      };
      assertEquals((await f(wb, A, "gardens")).length, 2);
      assertEquals(Object.keys((await f(wb, A, "gardens"))[0]).sort(), ["created_at", "snippet_src", "thought_id", "title"], "only id, title, snippet source and date");
      assertEquals((await f(wb, B, M.aPers)).length, 0);
      for (const sub of ["service:digest", "system:x", "anonymous:", "operator", "OPERATOR", "", null, "a b", "x'; --"]) assertEquals((await f(wb, sub, "gardens")).length, 0, `subject ${sub}`);
      assertEquals((await f(wb, A, "g")).length, 0);
      assertEquals((await f(wb, A, " ")).length, 0);
      assertEquals((await f(wb, A, "gardens", 1)).length, 1);
      assertEquals((await f(wb, A, "gardens", -5)).length, 1);
      // another role cannot run it (ob_app_memory logs in for ten other services): refused, and through the route it reads as nothing
      let code = "";
      try {
        await f(am, A, "gardens");
      } catch (e) {
        code = String((e as { fields?: { code?: string } }).fields?.code);
      }
      assertEquals(code, "42501");
      assertEquals(hits((await build(FA, am)("gardens", await as(A))).text).length, 0);
    } finally {
      await su.end();
      await wb.end();
      await am.end();
    }
  },
});
