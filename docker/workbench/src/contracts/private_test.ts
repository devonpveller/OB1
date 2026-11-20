// deno test src/contracts/private_test.ts - rw-owner-private-view (slot 480): the private routes' eligibility, with no
// database (a recording stand-in) and no embedder (a counting stand-in). The contract app is mounted WITHOUT the seam;
// a stand-in middleware sets the identity the seam would have set (or none), so this is test plan case 9.2c (the
// handler's own check) and the per-mode rule of identity/private_view.ts:
//   * sign-in on: only a signed-in user acting as themselves; impersonation, on-behalf, service, anonymous, no seam -> empty
//   * sign-in off: only the default identity with WORKSPACE_DEFAULT_SUB set; a header identity, the placeholder -> empty
//   * the empty answer causes no query and no embedding call; it carries no count; by id it is the unknown-id 404
//   * semantic search without the workbench's own key, or with a failing embedder: 503 with one fixed text
//   * every answer is Cache-Control: no-store, private; a ?sub= / ?owner_sub= is ignored
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import type { Identity } from "../middleware/identity.ts";
import type { PrivateViewConfig } from "../identity/private_view.ts";

const A = "lab-owner-aaaa-0001";
const CLAIM = { id: "f5100000-0000-4000-8000-000000000001", kind: "private", text: "MARK-A claim", status: "active", epistemic_tag: "sourced", confidence: 0.5, contradicted: false, created_at: "2026-10-17T12:00:00.000Z", private_sources: [], private_parents: [], shared_sources: [] };

function rig(cfg: PrivateViewConfig, who: Identity | undefined, embed: ((t: string) => Promise<number[]>) | null = async () => [0.1, 0.2]) {
  const calls: { sql: string; args: unknown[] }[] = [];
  let embeds = 0;
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      const pd1 = sql.includes("inlet_private_job(");
      const sub = pd1 ? args[1] : args[0];
      const mine = sub === A && (pd1 ? args[0] === "f5200000-0000-4000-8000-000000000001" : true);
      let rows: unknown[] = [];
      if (sql.includes("owner_private_claims")) rows = mine && (args[1] === null || args[1] === CLAIM.id) ? [CLAIM] : [];
      else if (sql.includes("owner_private_has_sources")) rows = [{ yes: mine }];
      else if (sql.includes("owner_private_source_text") || sql.includes("owner_private_source_knn")) rows = mine ? [{ source_id: "f5000000-0000-4000-8000-000000000001", title: "MARK-A mail", kind: "email", created_at: "2026-10-17T12:00:00.000Z", idx: 0, snippet: "MARK-A", score: 0.9 }] : [];
      else if (sql.includes("owner_private_jobs")) rows = mine ? [{ id: "f5200000-0000-4000-8000-000000000001", root_job_id: null, created_at: "2026-10-17T12:00:00.000Z", state: "done", query: "MARK-A question" }] : [];
      else if (pd1) rows = mine ? [{ query: "MARK-A question", result: null, progress: null, error: null }] : [];
      return Promise.resolve(rows as T[]);
    },
    tx: () => Promise.reject(new Error("no tx here")),
  };
  const app = createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.reject(new Error("the shared embedder is never used")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 1000, log: () => {},
    privateEmbed: embed ? async (t: string) => { embeds++; return await embed(t); } : null,
    privateView: cfg,
  });
  // the seam's stand-in: sets the identity (or none) the way identitySeam does
  const outer = new Hono();
  outer.use("*", async (c, next) => { if (who) c.set("identity" as never, who as never); await next(); });
  outer.route("/", app);
  const get = async (p: string) => {
    const r = await outer.request(p);
    return { status: r.status, cache: r.headers.get("cache-control"), text: await r.text() };
  };
  return { get, calls, embeds: () => embeds };
}

const id = (o: Partial<Identity>): Identity => ({ sub: A, actor: A, name: "a", key: A, kind: "user", admin: false, impersonating: null, ...o });
const ON: PrivateViewConfig = { signIn: true, defaultSub: "" };
const OFF: PrivateViewConfig = { signIn: false, defaultSub: A };
const OFF_BLANK: PrivateViewConfig = { signIn: false, defaultSub: "" };
const ROUTES = ["/workbench/contract/private/claims", "/workbench/contract/private/sources?q=mark&mode=text", "/workbench/contract/private/sources?q=mark&mode=semantic", "/workbench/contract/private/jobs"];
const BY_ID = ["/workbench/contract/private/claims/f5100000-0000-4000-8000-000000000001", "/workbench/contract/private/jobs/f5200000-0000-4000-8000-000000000001"];

Deno.test("the owner (signed in as themselves, or the default identity with sign-in off) sees their rows", async () => {
  for (const [cfg, who] of [[ON, id({})], [OFF, id({ kind: "default" })]] as const) {
    const r = rig(cfg, who);
    for (const p of [...ROUTES, ...BY_ID]) {
      const res = await r.get(p);
      assertEquals(res.status, 200, `${p}: ${res.text}`);
      assert(res.text.includes("MARK-A"), `${p} carries the owner's marker`);
      assertEquals(res.cache, "no-store, private", p);
    }
    assertEquals(r.embeds(), 1, "exactly one embedding call (the semantic search's query)");
    assert(r.calls.every((c) => c.args[0] === A || c.args[1] === A), "every query names the owner, nobody else");
  }
});

Deno.test("anyone else gets the empty answer (lists) or the unknown-id 404, with no query, no embedding call and no count", async () => {
  const cases: [string, PrivateViewConfig, Identity | undefined][] = [
    ["B signed in", ON, id({ sub: "lab-bee-0002", actor: "lab-bee-0002", key: "lab-bee-0002" })],
    ["an admin impersonating A", ON, id({ actor: "lab-admin-0003", admin: true, impersonating: { reason: "x", since: "now" } })],
    ["an admin (not the owner)", ON, id({ sub: "lab-admin-0003", actor: "lab-admin-0003", admin: true })],
    ["openbrain-mcp on behalf of A", ON, id({ kind: "on-behalf", actor: "service:mcp" })],
    ["a service", ON, id({ sub: "service:internal", actor: "service:internal", kind: "service" })],
    ["anonymous", ON, id({ sub: "anonymous:", actor: "anonymous:", kind: "anonymous" })],
    ["no seam (sign-in on)", ON, undefined],
    ["the default identity while sign-in is on", ON, id({ kind: "default" })],
    ["a header identity naming A (sign-in off)", OFF, id({ kind: "header" })],
    ["the placeholder default (sign-in off, WORKSPACE_DEFAULT_SUB blank)", OFF_BLANK, id({ sub: "operator", actor: "operator", kind: "default" })],
    ["no seam (sign-in off)", OFF, undefined],
  ];
  const unknown = await rig(ON, id({})).get("/workbench/contract/private/claims/00000000-0000-4000-8000-000000000000");
  for (const [name, cfg, who] of cases) {
    const r = rig(cfg, who);
    for (const p of ROUTES) {
      const res = await r.get(`${p}${p.includes("?") ? "&" : "?"}sub=${A}&owner_sub=${A}&owner=${A}&user=${A}`);
      assertEquals(res.status, 200, `${name} ${p}: ${res.text}`);
      assert(!res.text.includes("MARK-A"), `${name} ${p}: no marker`);
      const body = JSON.parse(res.text);
      assertEquals(body.private, true);
      for (const k of ["claims", "hits", "jobs"]) if (k in body) assertEquals(body[k], [], `${name} ${p}: ${k} empty`);
      assert(!/total|count|length/.test(Object.keys(body).join(",")), `${name} ${p}: no count field`);
      assertEquals(body.sign_in_required === true, cfg.signIn && who?.kind !== "user", `${name} ${p}: sign_in_required`);
      assertEquals(res.cache, "no-store, private");
    }
    for (const p of BY_ID) {
      const res = await r.get(p);
      assertEquals([res.status, res.text], [404, unknown.text], `${name} ${p}: the unknown-id 404`);
    }
    // B and an admin acting as themselves are eligible for THEIR OWN rows: every query names them, never A
    if (who && who.kind === "user" && who.actor === who.sub && cfg.signIn) assert(r.calls.length > 0 && r.calls.every((c) => !c.args.includes(A)), `${name}: queries name the caller only`);
    else assertEquals(r.calls.length, 0, `${name}: no query at all`);
    assertEquals(r.embeds(), 0, `${name}: no embedding call`);
  }
});

Deno.test("semantic search: no key of its own, or a failing embedder, is 503 with one fixed text and no other call", async () => {
  const noKey = rig(OFF, id({ kind: "default" }), null);
  const a = await noKey.get("/workbench/contract/private/sources?q=mark&mode=semantic");
  assertEquals([a.status, a.text], [503, JSON.stringify({ error: "search is not available" })]);
  assertEquals(noKey.calls.length, 0, "no query before the key check");
  const text = await noKey.get("/workbench/contract/private/sources?q=mark&mode=text");
  assert(text.status === 200 && text.text.includes("MARK-A"), "text search still answers without the key");
  const failing = rig(OFF, id({ kind: "default" }), () => Promise.reject(new Error("upstream said MARK-A")));
  const b = await failing.get("/workbench/contract/private/sources?q=mark&mode=semantic");
  assertEquals([b.status, b.text], [503, JSON.stringify({ error: "search is not available" })]);
  assertEquals(failing.embeds(), 1);
});
