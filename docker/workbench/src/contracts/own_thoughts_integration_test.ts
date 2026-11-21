// deno test src/contracts/own_thoughts_integration_test.ts - rwr-own-thoughts-search-api, over a REAL Postgres.
// SKIPPED unless OWN_THOUGHTS_DB_HOST is set. contract-test/run-own-thoughts-tests.ps1 runs it on a DISPOSABLE internal
// network against a throwaway pgvector database (a thoughts table of the real columns this search reads, a NON-superuser
// login role with SELECT only - the production shape of the workbench's role). Planted data: two users each with a
// thought carrying their own marker, one unowned (shared) thought, and a few hostile rows. The real SQL (repo/own_thoughts.ts),
// the real pool, the real identity seam with signed-in tokens. Never point it at a live stack. Only counts and pass/fail
// are printed; a marker is never printed.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { Hono } from "hono";
import { identitySeam, seamDeps } from "../middleware/identity.ts";
import { poolDb } from "./db.ts";
import { newApp } from "./routes/http.ts";
import { registerOwnThoughts } from "./routes/own_thoughts.ts";

const HOST = Deno.env.get("OWN_THOUGHTS_DB_HOST");
const off = !HOST;
const port = Number(Deno.env.get("OWN_THOUGHTS_DB_PORT") ?? 5432);
const SU = { user: Deno.env.get("OWN_THOUGHTS_SU") ?? "postgres", password: Deno.env.get("OWN_THOUGHTS_SU_PW") ?? "" };
const APP = { user: "ob_probe_app", password: Deno.env.get("OWN_THOUGHTS_APP_PW") ?? "" };
const mk = (c: { user: string; password: string }) => new Pool({ hostname: HOST!, port, database: "openbrain", ...c }, 2, true);

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
const MARK_A = "PLANTED-A-0d2f4b61", MARK_B = "PLANTED-B-93ac17e8", MARK_SHARED = "PLANTED-SHARED-5be6c0";
const PATH = "/workbench/contract/own-thoughts/search";

Deno.test({
  name: "own thoughts over a real database: owner finds, B/admin/service/anonymous never see A's, planted marker nowhere else",
  ignore: off, sanitizeOps: false, sanitizeResources: false,
  fn: async () => {
    const su = mk(SU), app = mk(APP);
    try {
      const s = await su.connect();
      try {
        await s.queryObject("DELETE FROM public.thoughts");
        const plant = (c: string, u: string | null, meta = "{}") => s.queryObject(`INSERT INTO public.thoughts (content, user_id, metadata) VALUES ($1, $2, $3::jsonb)`, [c, u, meta]);
        await plant(`A's own note: gardens ${MARK_A} and compost\nsecond line`, A);
        await plant(`A's other note on compost ${MARK_A}-2`, A, JSON.stringify({ people: ["B's friend"], link: `thought/${MARK_B}` }));
        await plant(`B's own note: gardens ${MARK_B}`, B);
        await plant(`A shared (unowned) note: gardens ${MARK_SHARED}`, null);
        await plant(`a 100% literal_underscore note`, A);
        await plant(`empty-owner row gardens ${MARK_SHARED}-empty`, "");
      } finally {
        s.release();
      }
      const a = new Hono();
      a.use("/workbench/*", identitySeam(seamDeps(null, (k) => (FA as Record<string, string>)[k])));
      const contract = newApp();
      registerOwnThoughts(contract, { db: poolDb(app) } as never);
      a.route("/", contract);
      const get = async (q: string, h: Record<string, string>) => {
        const r = await a.request(`http://h${PATH}?q=${encodeURIComponent(q)}`, { headers: h });
        return { status: r.status, text: await r.text() };
      };
      const hits = (t: string) => (JSON.parse(t).results as { id: string; snippet: string; private: boolean; marker: string }[]);

      // A finds both of theirs, newest first, each private to them
      const mine = await get("compost", await as(A));
      assertEquals(mine.status, 200);
      const ah = hits(mine.text);
      assertEquals(ah.length, 2);
      assert(ah.every((h) => h.private === true && h.marker === "private to you"));
      assert(ah.some((h) => h.snippet.includes("<<HL>>compost<</HL>>")));
      // never the shared, unowned or empty-owner rows - even for a word they hold
      const g = await get("gardens", await as(A));
      assert(!g.text.includes(MARK_SHARED) && !g.text.includes(MARK_B), "A got a row that is not theirs");
      assertEquals(hits(g.text).length, 1);
      // B: no A marker, name, link or nested field in the answer, for every word A's thoughts hold
      for (const q of [MARK_A, "compost", "gardens", "second line", "friend", "thought/", "A's own"]) {
        const r = await get(q, await as(B));
        assertEquals(r.status, 200);
        const seen = JSON.stringify({ ...JSON.parse(r.text), query: "" });
        assert(!seen.includes(MARK_A) && !seen.includes("compost") && !seen.includes("A's") && !seen.includes("friend"), `B saw A's text for q=${q}`);
        assert(!seen.includes(MARK_SHARED), "B saw a shared row");
      }
      // B searching for A's marker answers exactly as B searching for nothing at all (no count, no hint)
      const miss = JSON.parse((await get("zzz-nothing-zzz", await as(B))).text);
      assertEquals(JSON.parse((await get(MARK_A, await as(B))).text), { ...miss, query: MARK_A });
      assertEquals(hits((await get(MARK_B, await as(B))).text).length, 1);
      // an admin who is not the owner: the admin's own thoughts (none), never A's
      const admin = await get(MARK_A, await as("root-admin", ["users", "admins"]));
      assert(!JSON.stringify({ ...JSON.parse(admin.text), query: "" }).includes(MARK_A));
      assertEquals(hits(admin.text).length, 0);
      // a service key: refused, nothing returned
      const svc = await get(MARK_A, { "x-brain-key": "service-key-0123456789" });
      assertEquals(svc.status, 403);
      assert(!svc.text.includes(MARK_A) && !svc.text.includes("results"));
      // no sign-in: refused
      assertEquals((await get(MARK_A, { "x-brain-key": FA.WORKSPACE_DOOR_KEY })).status, 401);
      // a forged subject in the query string or a header changes nothing
      for (const extra of ["&sub=" + A, "&user_id=" + A, "&owner=" + A]) {
        const r = await a.request(`http://h${PATH}?q=${MARK_A}${extra}`, { headers: await as(B) });
        assertEquals(JSON.parse(await r.text()).results, []);
      }
      // LIKE wildcards are literal characters: '%%' and '_' match nothing wider; '100%' finds the one row
      assertEquals(hits((await get("%%", await as(A))).text).length, 0);
      assertEquals(hits((await get("literal_underscore", await as(A))).text).length, 1);
      assertEquals(hits((await get("100%", await as(A))).text).length, 1);
      assertEquals(hits((await get("literal-underscore", await as(A))).text).length, 0);
      // the database role of the workbench cannot write a thought through this path (read only)
      const w = await app.connect();
      try {
        let code = "";
        try {
          await w.queryObject(`INSERT INTO public.thoughts (content, user_id) VALUES ('x', 'y')`);
        } catch (e) {
          code = String((e as { fields?: { code?: string } }).fields?.code);
        }
        assertEquals(code, "42501");
      } finally {
        w.release();
      }
    } finally {
      await su.end();
      await app.end();
    }
  },
});
