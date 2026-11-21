// deno test src/contracts/private_cursor_test.ts - rw-owner-private-view round 2, F1: paging `next` loses no row.
// A stand-in database holds rows whose created_at are MICROSECOND timestamps (many tied, many inside one millisecond) and
// pages them the way owner_private_claims / owner_private_jobs do: ORDER BY (created_at, id) DESC, then
// (created_at, id) < (p_before, p_before_id) over the exact value. Like deno-postgres it hands `created_at` back as a
// millisecond Date (here its ISO string) and `created_at::text` at full precision. For every limit the walk over `next`
// must see every row exactly once, for claims AND jobs; the cursor stays an opaque string.
import { assertEquals, assert } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import type { Identity } from "../middleware/identity.ts";

const A = "lab-owner-aaaa-0001";
type Row = { id: string; us: bigint }; // us = microseconds since the epoch
const uuid = (n: number) => `f5100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BASE = 1_760_000_000_000_000n;
// 12 rows: 5 share one instant, 3 more are inside the same millisecond (microseconds apart), 2 share another, 2 are alone
const OFFS = [0n, 0n, 0n, 0n, 0n, 100n, 250n, 999n, 5_000n, 5_000n, 2_000_000n, 3_000_001n];
const ROWS: Row[] = OFFS.map((o, i) => ({ id: uuid(i + 1), us: BASE + o }));
const iso = (us: bigint) => new Date(Number(us / 1000n)).toISOString();
const txt = (us: bigint) => { // what Postgres prints for timestamptz: microsecond precision, +00
  const ms = new Date(Number(us / 1000n)).toISOString().replace("T", " ").replace("Z", "");
  return `${ms.slice(0, 19)}.${String(us % 1_000_000n).padStart(6, "0")}+00`;
};
const parse = (s: string): bigint => { // exact microseconds from an ISO or a Postgres text timestamp
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d)/.exec(s)!;
  const frac = BigInt((m[3] ?? "").padEnd(6, "0"));
  return BigInt(Date.parse(`${m[1]}T${m[2]}Z`)) * 1000n + frac;
};

function rig() {
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      const claims = sql.includes("owner_private_claims");
      if (!claims && !sql.includes("owner_private_jobs")) return Promise.resolve([] as T[]);
      const [beforeAt, beforeId, limit] = claims ? [args[5], args[6], args[7]] : [args[1], args[2], args[3]];
      let rows = [...ROWS].sort((x, y) => (x.us === y.us ? (x.id < y.id ? 1 : -1) : x.us < y.us ? 1 : -1));
      if (beforeAt !== null) {
        const at = parse(String(beforeAt));
        rows = rows.filter((r) => r.us < at || (r.us === at && r.id < String(beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff")));
      }
      const wantsText = /created_at::text/.test(sql);
      return Promise.resolve(rows.slice(0, Number(limit)).map((r) => ({
        id: r.id, job_id: r.id, root_job_id: null, kind: "private", text: "t", status: "active", epistemic_tag: "sourced", confidence: "0.5", contradicted: false,
        created_at: iso(r.us), ...(wantsText ? { cursor_at: txt(r.us) } : {}), private_sources: [], private_parents: [], shared_sources: [], state: "done", query: "q",
      })) as unknown as T[]);
    },
    tx: () => Promise.reject(new Error("no tx here")),
  };
  const app = createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.reject(new Error("never")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 1000, log: () => {}, privateEmbed: null, privateView: { signIn: true, defaultSub: "" },
  });
  const who: Identity = { sub: A, actor: A, name: "a", key: A, kind: "user", admin: false, impersonating: null };
  const outer = new Hono();
  outer.use("*", async (c, next) => { c.set("identity" as never, who as never); await next(); });
  outer.route("/", app);
  return outer;
}

for (const [route, key] of [["claims", "claims"], ["jobs", "jobs"]] as const) {
  Deno.test(`paging ${route} through next sees every row exactly once, for limits 1..13, with tied and same-millisecond created_at`, async () => {
    const app = rig();
    for (let limit = 1; limit <= 13; limit++) {
      const seen: string[] = [];
      let before = "";
      for (let page = 0; page < 40; page++) {
        const r = await app.request(`/workbench/contract/private/${route}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        assertEquals(r.status, 200);
        const body = await r.json();
        for (const row of body[key]) {
          seen.push(row.id);
          assert(!("cursor_at" in row), "the full-precision stamp stays internal");
        }
        if (body.next === null) break;
        assertEquals(typeof body.next, "string");
        before = body.next;
      }
      assertEquals(seen.length, ROWS.length, `${route} limit=${limit}: saw ${seen.length} of ${ROWS.length}`);
      assertEquals(new Set(seen).size, ROWS.length, `${route} limit=${limit}: each exactly once`);
    }
  });
}

Deno.test("a malformed or forged cursor is ignored (first page), never an error", async () => {
  const app = rig();
  for (const bad of ["x", "2026-01-01T00:00:00Z,f5100000-0000-4000-8000-000000000001", "!!!", "' OR 1=1 --"]) {
    const r = await app.request(`/workbench/contract/private/claims?limit=2&before=${encodeURIComponent(bad)}`);
    assertEquals(r.status, 200);
    assertEquals((await r.json()).claims.length, 2);
  }
});

Deno.test("the cursor is opaque: not a timestamp, no id, no separator a client could build or edit", async () => {
  const body = await (await rig().request("/workbench/contract/private/claims?limit=2")).json();
  assert(/^[A-Za-z0-9_-]+$/.test(body.next), `opaque token, got ${body.next}`);
  assert(!/f5100000|2025|2026/.test(body.next));
});
