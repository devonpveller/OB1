// deno test src/inlet/owner_private_view_integration_test.ts - rw-owner-private-view (plan 08 PD-PV, slot 480): the
// owner sees and searches their own private material in the workbench, and no one else can - over REAL workbenches,
// the real database (440 + 470 + 480 applied, [5r]'s migrated plant plus contract-test/owner-private-view-plant.sql) and
// a counting stub embedder. SKIPPED unless PV_WB_S is set. contract-test/run-workspace-tests.ps1 [5s] runs it on a
// DISPOSABLE internal network, after [5r]. Three workbenches of the same image, all logging in as ob_workbench:
//   PV_WB_S  sign-in ON (forward-auth, the lab signer): A = the 440 owner, B = another user with B's own private rows,
//            C = an admin who is not the owner (and C impersonating A); the private-search key set
//   PV_WB_U  sign-in OFF, WORKSPACE_DEFAULT_SUB = A, the identity header ON (lab), the private-search key BLANK
//   PV_WB_OFF the lab's main workbench (sign-in off, WORKSPACE_DEFAULT_SUB blank, the header on), behind PV_VIEWER
// Only counts, route names and pass/fail are printed, never a row's content. Never point it at a live stack.
// Cases (test plan, test-plans/rw-owner-private-view.md): 1.x the owner; 2.x B, C, C-as-A, no identity; 4.x shared
// surfaces and caching; 9.x the identity modes. The catalog cases (3.x) and the migration cases (7.x) are the runner's.
// Environment: PV_WB_S, PV_WB_U, PV_WB_OFF, PV_VIEWER, PV_KEY (WORKBENCH_KEY), PV_DOOR (the door key of PV_WB_S),
// PV_FA_ISSUER / PV_FA_CLIENT / PV_FA_SECRET, PV_A, PV_B, PV_C, PV_MARK (A's 440 marker), PV_MA, PV_MB, PV_STUB,
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser), PV_EXPECT ("green" | "red": on the base, every case must fail).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const env = (k: string) => Deno.env.get(k) ?? "";
const WB_S = env("PV_WB_S").replace(/\/+$/, ""), WB_U = env("PV_WB_U").replace(/\/+$/, ""), WB_OFF = env("PV_WB_OFF").replace(/\/+$/, "");
const VIEWER = env("PV_VIEWER").replace(/\/+$/, "");
const KEY = env("PV_KEY"), DOOR = env("PV_DOOR"), STUB = env("PV_STUB").replace(/\/+$/, "");
const A = env("PV_A"), B = env("PV_B"), C = env("PV_C");
const MARK = env("PV_MARK"), MA = env("PV_MA"), MB = env("PV_MB");
const off = !WB_S || !WB_U || !env("CONTRACT_TEST_DB_HOST");
const P = "/workbench/contract/private";
const pool = !off
  ? new Pool({ hostname: env("CONTRACT_TEST_DB_HOST"), port: 5432, database: "openbrain", user: env("CONTRACT_TEST_DB_USER") || "postgres", password: env("CONTRACT_TEST_DB_PASSWORD") }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: off, fn, sanitizeOps: false, sanitizeResources: false });

// deno-lint-ignore no-explicit-any
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}

// the lab signer: Authentik's outpost token shape (HS256 with the lab proxy provider's client secret)
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encJ = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function token(sub: string, groups: string[] = []): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encJ({ alg: "HS256", typ: "JWT" })}.${encJ({ iss: env("PV_FA_ISSUER"), aud: env("PV_FA_CLIENT"), sub, iat: now, exp: now + 3600, name: sub, preferred_username: sub, groups })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("PV_FA_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}

// deno-lint-ignore no-explicit-any
interface Res { status: number; text: string; cache: string; json: Record<string, any> }
async function req(base: string, path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<Res> {
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, cache: r.headers.get("cache-control") ?? "", json };
}
const calls = async (): Promise<{ private: number; mcp: number; other: number }> => (await fetch(`${STUB}/calls`)).json();

// A's personal marker: the token NOT preceded by 'ctl' (the shared controls carry 'ctl' + the token); B's marker
const hasA = (s: string) => new RegExp(`(?<!ctl)${MARK}`).test(s) || s.includes(MA);
const hasB = (s: string) => s.includes(MB);

let as: Record<string, Record<string, string>> = {};
const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

t("setup: the plant, the three users signed in, C an admin who is not the owner", async () => {
  as = {
    A: { "x-brain-key": DOOR, "x-authentik-jwt": await token(A) },
    B: { "x-brain-key": DOOR, "x-authentik-jwt": await token(B) },
    C: { "x-brain-key": DOOR, "x-authentik-jwt": await token(C, ["research-admins"]) },
  };
  for (const u of ["A", "B", "C"]) {
    const me = await req(WB_S, "/workbench/auth/me", as[u]);
    assertEquals([me.status, me.json.signed_in, me.json.private_views], [200, true, "signed-in"], `${u} signed in: ${me.status}`);
  }
  assertEquals((await req(WB_S, "/workbench/auth/me", as.C)).json.admin, true, "C is an admin");
});

// ── 1. the owner sees and searches their own (acceptance 1) ───────────────────────────────────────────────────────
t("1.1-1.2 A sees every private claim and every mixed claim, with the private sources, the chain parents and the shared side", async () => {
  const priv = await sql<{ id: string }>(`SELECT id::text FROM public.inlet_private_claims WHERE inlet_owner_sub = $1`, [A]);
  const mixed = await sql<{ id: string }>(`SELECT DISTINCT claim_id::text AS id FROM public.inlet_private_claim_links WHERE owner_sub = $1`, [A]);
  const parents = await sql<{ id: string; parent: string }>(`SELECT claim_id::text AS id, parent_claim_id::text AS parent FROM public.inlet_private_claim_sources WHERE owner_sub = $1 AND parent_claim_id IS NOT NULL`, [A]);
  assert(priv.length >= 1 && mixed.length >= 1, `the plant gives A private (${priv.length}) and mixed (${mixed.length}) claims`);
  const all = await req(WB_S, `${P}/claims?limit=200`, as.A);
  assertEquals(all.status, 200, all.text);
  assertEquals(all.cache, "no-store, private");
  assertEquals(idsOf(all.json.claims), [...priv, ...mixed].map((r) => r.id).sort(), "A's list is exactly A's private + mixed claims");
  assert(hasA(all.text) && !hasB(all.text), "A's marker present, B's absent");
  assertEquals(idsOf((await req(WB_S, `${P}/claims?kind=private&limit=200`, as.A)).json.claims), idsOf(priv), "kind=private");
  assertEquals(idsOf((await req(WB_S, `${P}/claims?kind=mixed&limit=200`, as.A)).json.claims), idsOf(mixed), "kind=mixed");
  // deno-lint-ignore no-explicit-any
  for (const c of all.json.claims as any[]) {
    if (c.kind === "mixed") {
      assert(c.private_sources.length >= 1 && c.shared_sources.length >= 1, `mixed ${c.id}: the private link beside the shared sources`);
    } else {
      assertEquals(c.shared_sources, [], `private ${c.id}: no shared side`);
    }
    for (const p of parents.filter((x) => x.id === c.id)) assert(c.private_parents.some((pp: { id: string }) => pp.id === p.parent), `private ${c.id}: its chain parent`);
    const one = await req(WB_S, `${P}/claims/${c.id}`, as.A);
    assertEquals([one.status, one.json.claim?.id], [200, c.id], `claims/{id} ${c.id}`);
    for (const s of c.private_sources) {
      const f = await req(WB_S, `${P}/claims?source_id=${s.id}&limit=200`, as.A);
      assert(f.json.claims.some((x: { id: string }) => x.id === c.id), `source_id=${s.id} lists ${c.id}`);
    }
  }
  assert(parents.length >= 1, "the plant has a chain parent");
  console.log(`pv: A private ${priv.length}, mixed ${mixed.length}, chain parents ${parents.length}`);
});

t("1.3 A's text search finds the moved email body and the podcast transcript", async () => {
  const r = await req(WB_S, `${P}/sources?mode=text&q=${MARK}&limit=50`, as.A);
  assertEquals(r.status, 200, r.text);
  const kinds = new Set((r.json.hits as { kind: string }[]).map((h) => h.kind));
  assert(kinds.has("email") && kinds.has("podcast"), `email and podcast hits (${[...kinds]})`);
  assert(r.text.includes("<<HL>>"), "inert highlight markers");
  assert(!hasB(r.text));
});

t("1.4 A's semantic search: the planted nearest chunk first, exactly one embedding call, with the workbench's own key", async () => {
  const plant = (await sql<{ v: Record<string, string> }>(`SELECT v FROM public.lab_owner_private_view_plant WHERE k = 'plant'`))[0].v;
  const before = await calls();
  const r = await req(WB_S, `${P}/sources?mode=semantic&q=${encodeURIComponent("nearest probe")}&limit=5`, as.A);
  const after = await calls();
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.hits[0]?.source_id, plant.a_source, "A's probe chunk ranks first");
  assert(!hasB(r.text), "B's chunk (the same vector) is not A's");
  assertEquals([after.private - before.private, after.mcp - before.mcp, after.other - before.other], [1, 0, 0], "one call, the private key");
});

t("1.5 A's private jobs: the list, and each one's original text through inlet_private_job", async () => {
  const want = await sql<{ id: string; q: string }>(
    `SELECT DISTINCT p.job_id::text AS id, x.query AS q FROM public.inlet_private_jobs p JOIN public.research_jobs j ON j.id = p.job_id
       CROSS JOIN LATERAL public.inlet_private_job(p.job_id, $1) x WHERE p.owner_sub = $1`, [A]);
  const live = want;
  assert(live.length >= 1, `A has a seeded job (${live.length})`);
  const r = await req(WB_S, `${P}/jobs?limit=200`, as.A);
  assertEquals(r.status, 200, r.text);
  assertEquals(idsOf(r.json.jobs), idsOf(live), "exactly A's seeded jobs");
  for (const w of live) {
    const one = await req(WB_S, `${P}/jobs/${w.id}`, as.A);
    assertEquals([one.status, one.json.job?.query], [200, w.q], `jobs/${w.id}: the original question`);
  }
  if (live.some((w) => hasA(w.q ?? ""))) assert(hasA(r.text), "the original question carries A's marker");
});

t("1.6 A opens a moved source (PD1's route)", async () => {
  const src = (await sql<{ id: string }>(`SELECT id::text FROM public.inlet_private_sources WHERE inlet_owner_sub = $1 ORDER BY id LIMIT 1`, [A]))[0].id;
  const r = await req(WB_S, `/workbench/sources/${src}`, as.A);
  assertEquals([r.status, r.json.source?.private], [200, true], r.text.slice(0, 80));
});

// ── 2. B, C, C impersonating A, no identity (acceptance 2) ────────────────────────────────────────────────────────
async function aIds() {
  const c = await sql<{ id: string }>(`SELECT id::text FROM public.inlet_private_claims WHERE inlet_owner_sub = $1 UNION SELECT claim_id::text FROM public.inlet_private_claim_links WHERE owner_sub = $1`, [A]);
  const s = await sql<{ id: string }>(`SELECT id::text FROM public.inlet_private_sources WHERE inlet_owner_sub = $1`, [A]);
  const j = await sql<{ id: string }>(`SELECT DISTINCT job_id::text AS id FROM public.inlet_private_jobs WHERE owner_sub = $1`, [A]);
  return { claims: c.map((x) => x.id), sources: s.map((x) => x.id), jobs: j.map((x) => x.id) };
}
const HINTS = (sub: string) => `sub=${encodeURIComponent(sub)}&owner=${encodeURIComponent(sub)}&owner_sub=${encodeURIComponent(sub)}&user=${encodeURIComponent(sub)}`;

async function nothingOfA(label: string, base: string, h: Record<string, string>, own: (s: string) => boolean = () => true) {
  const ids = await aIds();
  const unknownClaim = await req(base, `${P}/claims/00000000-0000-4000-8000-000000000000`, h);
  const unknownJob = await req(base, `${P}/jobs/00000000-0000-4000-8000-000000000000`, h);
  const lists = [`${P}/claims?limit=200`, `${P}/claims?kind=private&limit=200`, `${P}/claims?kind=mixed&limit=200`, `${P}/jobs?limit=200`,
    `${P}/sources?mode=text&q=${MARK}`, `${P}/sources?mode=text&q=${MA}`, `${P}/claims?q=${MARK}`,
    ...ids.sources.map((s) => `${P}/claims?source_id=${s}`)];
  for (const p of lists) {
    for (const path of [p, `${p}&${HINTS(A)}`]) {
      const r = await req(base, path, h);
      assertEquals(r.status, 200, `${label} ${path}: ${r.text}`);
      assert(!hasA(r.text), `${label} ${path}: no marker of A's`);
      assert(!/"(total|count|length)"/.test(r.text), `${label} ${path}: no count`);
      assertEquals(r.cache, "no-store, private");
      assert(own(r.text), `${label} ${path}`);
    }
  }
  for (const id of ids.claims) {
    const r = await req(base, `${P}/claims/${id}?${HINTS(A)}`, h);
    assertEquals([r.status, r.text], [404, unknownClaim.text], `${label} claims/<A's ${id}>: the unknown-id 404`);
  }
  for (const id of ids.jobs) {
    const r = await req(base, `${P}/jobs/${id}?${HINTS(A)}`, h);
    assertEquals([r.status, r.text], [404, unknownJob.text], `${label} jobs/<A's ${id}>: the unknown-id 404`);
  }
  for (const id of ids.sources) {
    const r = await req(base, `/workbench/sources/${id}`, h);
    assertEquals(r.status, 404, `${label} /workbench/sources/<A's>: 404`);
  }
}

t("2.1-2.4 B gets nothing of A's - lists, ids, words, subject hints - and sees B's own rows", async () => {
  const before = await calls();
  await nothingOfA("B", WB_S, as.B);
  const textB = await req(WB_S, `${P}/sources?mode=text&q=${MB}`, as.B);
  assert(textB.json.hits.length >= 1 && hasB(textB.text), "B finds B's own moved source");
  const claimsB = await req(WB_S, `${P}/claims?limit=200`, as.B);
  const plant = (await sql<{ v: Record<string, string> }>(`SELECT v FROM public.lab_owner_private_view_plant WHERE k = 'plant'`))[0].v;
  assertEquals(idsOf(claimsB.json.claims), [plant.b_claim, plant.b_mixed].sort(), "B's own private and mixed claims");
  const jobsB = await req(WB_S, `${P}/jobs`, as.B);
  assertEquals(idsOf(jobsB.json.jobs), [plant.b_job], "B's own seeded job");
  const after = await calls();
  assertEquals(after.private + after.mcp + after.other, before.private + before.mcp + before.other, "no embedding call for B's lists and text searches");
  // the reverse: A never sees B's
  for (const p of [`${P}/claims?limit=200`, `${P}/jobs?limit=200`, `${P}/sources?mode=text&q=${MB}`, `${P}/claims/${plant.b_claim}`, `${P}/jobs/${plant.b_job}`]) {
    assert(!hasB((await req(WB_S, p, as.A)).text), `A ${p}: nothing of B's`);
  }
});

t("2.5 C (an admin, not the owner) gets nothing of A's; C impersonating A gets the same as B, every request audited (D2)", async () => {
  const before = await calls();
  await nothingOfA("C", WB_S, as.C, (s) => !hasB(s));
  const go = await req(WB_S, "/workbench/auth/impersonate", as.C, "POST", { sub: A, reason: "lab check of the private view isolation" });
  assertEquals(go.status, 200, go.text);
  try {
    const audited0 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit WHERE actor_sub = $1 AND subject_sub = $2 AND action = 'request'`, [C, A]))[0].n;
    await nothingOfA("C as A", WB_S, as.C, (s) => !hasB(s));
    const sem = await req(WB_S, `${P}/sources?mode=semantic&q=${encodeURIComponent("nearest probe")}`, as.C);
    assertEquals([sem.status, sem.json.hits], [200, []], "C as A: semantic empty");
    // 2.6: PD1's session overlay gives C-as-A the neutral text, not A's own
    const job = (await aIds()).jobs[0];
    const own = await req(WB_S, `/workbench/contract/sessions/${job}`, as.A);
    const imp = await req(WB_S, `/workbench/contract/sessions/${job}`, as.C);
    assert(!hasA(imp.text), "C as A: the session overlay shows no private text");
    assert(own.status === 200, "A reads the session");
    const audited1 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit WHERE actor_sub = $1 AND subject_sub = $2 AND action = 'request'`, [C, A]))[0].n;
    assert(audited1 > audited0, `C's requests as A are audited (${audited1 - audited0})`);
  } finally {
    assertEquals((await req(WB_S, "/workbench/auth/impersonate/end", as.C, "POST", {})).status, 200);
  }
  const after = await calls();
  assertEquals(after.private + after.mcp + after.other, before.private + before.mcp + before.other, "2.7: no embedding call for C or C as A");
});

t("2.8 no identity: no token 401, a service key 403 (generic), a bad or expired token 401", async () => {
  const before = await calls();
  for (const p of [`${P}/claims`, `${P}/sources?mode=semantic&q=nearest+probe`, `${P}/jobs`]) {
    const none = await req(WB_S, p, { "x-brain-key": DOOR });
    assertEquals(none.status, 401, `no token ${p}`);
    assert(!hasA(none.text) && !/"(claims|hits|jobs)"/.test(none.text), "the seam's text only");
    const bad = await req(WB_S, p, { "x-brain-key": DOOR, "x-authentik-jwt": (await token(A)).slice(0, -3) + "AAA" });
    assertEquals(bad.status, 401, `bad token ${p}`);
    const svc = await req(WB_S, p, { "x-brain-key": KEY });
    assertEquals([svc.status, svc.json.error], [403, "a service has no user front end; sign in as a user"], `service ${p}`);
  }
  const after = await calls();
  assertEquals(after.private + after.mcp + after.other, before.private + before.mcp + before.other, "no embedding call");
});

// ── 9. the identity modes (D4) ─────────────────────────────────────────────────────────────────────────────────────
t("9.1a-d sign-in off: the default identity is A and sees A's rows; a subject hint changes nothing; a header identity gets the empty shape", async () => {
  const me = await req(WB_U, "/workbench/auth/me", { "x-brain-key": KEY });
  assertEquals(me.json.private_views, "default-identity");
  const mine = await req(WB_U, `${P}/claims?limit=200`, { "x-brain-key": KEY });
  assert(mine.status === 200 && mine.json.claims.length >= 2 && hasA(mine.text) && !hasB(mine.text), "the default identity (A) sees A's claims");
  const hinted = await req(WB_U, `${P}/claims?limit=200&${HINTS(B)}`, { "x-brain-key": KEY });
  assertEquals(hinted.text, mine.text, "?sub=B etc. change nothing");
  const jobs = await req(WB_U, `${P}/jobs`, { "x-brain-key": KEY });
  assert(jobs.json.jobs.length >= 1, "A's jobs");
  for (const who of [B, A]) {
    for (const p of [`${P}/claims?limit=200`, `${P}/jobs`, `${P}/sources?mode=text&q=${MARK}`, `${P}/sources?mode=text&q=${MB}`]) {
      const r = await req(WB_U, p, { "x-brain-key": KEY, "X-Test-Sub": who });
      assertEquals(r.status, 200, p);
      assert(!hasA(r.text) && !hasB(r.text), `the header naming ${who === A ? "A" : "B"}: the empty shape (${p})`);
    }
  }
});

t("1.7 sign-in off workbench without its own embedding key: semantic 503 with the fixed text and ZERO embedding calls; text still answers", async () => {
  const before = await calls();
  const r = await req(WB_U, `${P}/sources?mode=semantic&q=${encodeURIComponent("nearest probe")}`, { "x-brain-key": KEY });
  assertEquals([r.status, r.text], [503, JSON.stringify({ error: "search is not available" })]);
  const tx = await req(WB_U, `${P}/sources?mode=text&q=${MARK}`, { "x-brain-key": KEY });
  assert(tx.status === 200 && tx.json.hits.length >= 1, "text search answers");
  const after = await calls();
  assertEquals([after.private - before.private, after.mcp - before.mcp, after.other - before.other], [0, 0, 0], "no call with any key (the MCP key never)");
});

t("9.1e/f the main lab workbench (WORKSPACE_DEFAULT_SUB blank): private_views off, every private route the empty shape", async () => {
  const me = await req(WB_OFF, "/workbench/auth/me", { "x-brain-key": KEY });
  assertEquals(me.json.private_views, "off");
  for (const p of [`${P}/claims?limit=200`, `${P}/jobs`, `${P}/sources?mode=text&q=${MARK}`]) {
    const r = await req(WB_OFF, p, { "x-brain-key": KEY });
    assert(r.status === 200 && !hasA(r.text) && !hasB(r.text), p);
  }
});

// ── 4. shared surfaces and caches (acceptance 3) ──────────────────────────────────────────────────────────────────
t("4.1 the shared contract reads answer A and B byte-identically, with no private marker", async () => {
  for (const p of [`/workbench/contract/search?q=${MARK}`, `/workbench/contract/search?q=${MA}`, `/workbench/contract/search?q=${MB}`,
    `/workbench/contract/claims?q=${MARK}&limit=200`, `/workbench/contract/claims?limit=200`, `/workbench/contract/search?q=nearest+probe`,
    `/workbench/contract/timeline?limit=200`, `/workbench/search?q=${MARK}`]) {
    const a = await req(WB_S, p, as.A), b = await req(WB_S, p, as.B);
    assertEquals([a.status, a.text], [b.status, b.text], `${p}: the same for A and B`);
    assert(!hasA(a.text) && !hasB(a.text), `${p}: no private marker`);
  }
});

t("4.2-4.3 no private row reached a shared store: wiki_pages, the shared sources and chunks (what the room's KNN reads)", async () => {
  const like = [`%${MA}%`, `%${MB}%`];
  const n = await sql<{ n: number }>(
    `SELECT ((SELECT count(*) FROM public.wiki_pages WHERE body LIKE ANY($1) OR title LIKE ANY($1))
           + (SELECT count(*) FROM public.sources WHERE content LIKE ANY($1) OR title LIKE ANY($1))
           + (SELECT count(*) FROM public.source_chunks WHERE content LIKE ANY($1)))::int AS n`, [like]);
  assertEquals(n[0].n, 0);
});

t("4.6 no-store on every private answer, directly and through the viewer's forwarder", async () => {
  for (const p of [`${P}/claims`, `${P}/sources?q=ab`, `${P}/jobs`, `${P}/claims/00000000-0000-4000-8000-000000000000`]) {
    assertEquals((await req(WB_S, p, as.A)).cache, "no-store, private", `direct ${p}`);
    if (VIEWER) assertEquals((await req(VIEWER, p, {})).cache, "no-store, private", `viewer ${p}`);
  }
});
