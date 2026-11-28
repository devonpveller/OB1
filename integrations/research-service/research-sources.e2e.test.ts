/**
 * rwr-research-sources - slot 750 over a REAL database (the lab). SKIPPED unless CRED_E2E_DB_HOST is set;
 * run-credibility-e2e.ps1 points it at a DISPOSABLE Postgres it builds from the real initdb chain. Never point it
 * at a live database: it writes sources and claims.
 *   - source_class_of is the twin of source-class.ts on the whole case table;
 *   - the community rule holds in BOTH SQL formulas (the live legacy claim_confidence and claim_confidence_d15):
 *     a community-only claim stays under the floor however many communities agree; a claim with credible support
 *     scores exactly what its credible sources alone give; the consensus marker needs two independent communities;
 *   - a community source neither gives nor receives corroboration;
 *   - the start door's allow-list takes `sources` on a root and a branch, nothing else new;
 *   - the class list is changed only by its owner (an app role is refused);
 *   - the two settings keys exist with their tags.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read research-sources.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { buildModel, loadCredibilityModel } from "./credibility.ts";
import { classifySource } from "./source-class.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain", user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres",
    password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 4, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
async function q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(sql, args)).rows; } finally { c.release(); }
}
async function raises(sql: string, args: unknown[] = []): Promise<string> {
  try { await q(sql, args); return ""; } catch (e) { return String((e as Error).message); }
}
const id = () => crypto.randomUUID();
const tag = id().slice(0, 8);
async function source(url: string) {
  const s = id();
  const u = url.replace("{t}", tag);
  await q(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, $3, 'c', $4)`, [s, u, u, new URL(u).hostname]);
  return s;
}
async function claim(text: string, sources: string[], edge = "states") {
  const c = id();
  await q(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, $3::jsonb, 'slow')`,
    [c, `${text} ${tag}`, JSON.stringify({ claim_kind: "practical" })]);
  for (const s of sources) await q(`SELECT public.link_claim_to_source($1, $2, $3, 1.0)`, [c, s, edge]);
  return c;
}
const legacy = async (c: string) => Number((await q<{ v: number }>(`SELECT public.claim_confidence($1) AS v`, [c]))[0].v);
const d15 = async (c: string) => Number((await q<{ v: number }>(`SELECT public.claim_confidence_d15($1) AS v`, [c]))[0].v);
const flag = async (fn: string, c: string) => (await q<{ v: boolean }>(`SELECT public.${fn}($1) AS v`, [c]))[0].v;

t("source_class_of is the twin of source-class.ts on the whole case table", async () => {
  const c = await pool!.connect();
  let m;
  try { m = await loadCredibilityModel(c); } finally { c.release(); }
  const cases: Array<[string, string | null, string | null]> =
    JSON.parse(Deno.readTextFileSync(new URL("./fixtures/source-class-cases.json", import.meta.url))).cases;
  for (const [url, kind, key] of cases) {
    const sql = (await q<{ v: { kind: string; key: string } | null }>(`SELECT public.source_class_of($1, NULL) AS v`, [url]))[0].v;
    assertEquals([sql?.kind ?? null, sql?.key ?? null], [kind, key], `SQL ${url}`);
    const ts = classifySource(m.sourceClasses, url);
    assertEquals([ts?.kind ?? null, ts?.key ?? null], [kind, key], `TS ${url}`);
  }
  assert(buildModel !== undefined);
});

t("legacy and D15: a community-only claim never reaches the floor, however many communities agree", async () => {
  const many = await Promise.all([
    "https://www.reddit.com/r/a{t}/comments/1/", "https://stackoverflow.com/questions/{t}", "https://news.ycombinator.com/item?id={t}",
    "https://forums.example-{t}.com/t/x/1", "https://x.com/u/status/{t}",
  ].map(source));
  const c = await claim("community only", many);
  assert(await legacy(c) < 0.5, `legacy ${await legacy(c)}`);
  assert(await d15(c) < 0.5, `d15 ${await d15(c)}`);
  assertEquals(await flag("claim_community_only", c), true);
  assertEquals(await flag("claim_community_consensus", c), true);
});

t("legacy and D15: credible support scores exactly what the credible sources alone give", async () => {
  const gov = await source("https://www.energy.gov/{t}");
  const alone = await claim("credible alone", [gov]);
  const gov2 = await source("https://www.energy.gov/{t}/b");
  const mixed = await claim("credible and community", [gov2,
    await source("https://www.reddit.com/r/b{t}/comments/1/"), await source("https://superuser.com/questions/{t}")]);
  assertEquals(await legacy(mixed), await legacy(alone));
  assertEquals(await d15(mixed), await d15(alone));
  assertEquals(await flag("claim_community_only", mixed), false);
});

t("consensus needs two INDEPENDENT communities: two threads in one subreddit count once", async () => {
  const c = await claim("one community", [
    await source("https://www.reddit.com/r/one{t}/comments/1/"), await source("https://old.reddit.com/r/one{t}/comments/2/")]);
  assertEquals(await flag("claim_community_consensus", c), false);
  const inferred = await claim("inferred only", [
    await source("https://www.reddit.com/r/i{t}/comments/1/"), await source("https://stackoverflow.com/q/{t}")], "inferred_from");
  assertEquals(await flag("claim_community_consensus", inferred), false);
});

t("a community source neither gives nor receives corroboration", async () => {
  const paper = await source("https://www.nature.com/articles/{t}");
  const forum = await source("https://www.reddit.com/r/c{t}/comments/1/");
  const total = async (s: string) => Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [s]))[0].v);
  const [p0, f0] = [await total(paper), await total(forum)];
  await q(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
           VALUES ($1, $2, 'weak', 0.1, 'x', 'practical', 'supports', 'd15 weights v1 paper p1'),
                  ($2, $1, 'strong', 0.2, 'x', 'practical', 'supports', 'd15 weights v1 paper p1')`, [forum, paper]);
  assertEquals(await total(paper), p0, "the forum gave the paper nothing");
  assertEquals(await total(forum), f0, "the forum received nothing");
});

t("the start door's allow-list takes sources on a root and a branch, and nothing else new", async () => {
  const ok = async (o: unknown, root: boolean) => (await q<{ v: boolean }>(`SELECT public.request_boundary_options_ok($1::jsonb, $2) AS v`, [JSON.stringify(o), root]))[0].v;
  assertEquals(await ok({ sources: "credible" }, true), true);
  assertEquals(await ok({ sources: "community" }, false), true);
  assertEquals(await ok({ sources: "all" }, true), false);
  assertEquals(await ok({ sources: ["community"] }, true), false);
  assertEquals(await ok({ contract: { budget: { rounds: 1 } }, sources: "credible" }, true), true);
  assertEquals(await ok({ contract: { sources: { allow: ["x.com"] } } }, true), false, "540's no-source-list rule stands");
});

t("the class list is changed only by its owner: an app role is refused", async () => {
  const c = await pool!.connect();
  let msg = "";
  try {
    await c.queryObject("BEGIN");
    await c.queryObject("SET LOCAL ROLE service_role");
    await c.queryObject(`INSERT INTO public.contract_registry_entries (registry, key, label, definition)
      VALUES ('source_classes', $1, 'x', '{"order":1,"kind":"forum","host_patterns":["^energy\\\\.gov$"]}')`, [`evil-${tag}`]);
  } catch (e) { msg = String((e as Error).message); } finally { await c.queryObject("ROLLBACK").catch(() => {}); c.release(); }
  assert(/permission denied|42501/.test(msg), msg);
  const bad = await raises(`INSERT INTO public.contract_registry_entries (registry, key, label, definition)
    VALUES ('source_classes', 'bad-${tag}', 'x', '{"order":1,"kind":"blog","host_patterns":["a"]}')`);
  assert(/source_class_ok|violates check/.test(bad), bad);
});

t("the two settings keys exist, with their tiers, defaults and tags", async () => {
  const rows = await q<{ key: string; tier: string; default_value: unknown; tag: string }>(
    `SELECT key, tier, default_value, tag FROM public.settings_keys WHERE key IN ('research.sources_default', 'research.community_allowed') ORDER BY key`);
  assertEquals(rows.map((r) => [r.key, r.tier, r.default_value, r.tag]), [
    ["research.community_allowed", "admin", true, "admin_all"],
    ["research.sources_default", "user", "credible", "only_you"],
  ]);
});

// lab 1 fix: the class is STORED (sources.community_key) and must never go stale. After every kind of write the stored
// value equals source_class_of() for every row (source_community_drift() = 0).
const drift = async () => Number((await q<{ v: number }>(`SELECT public.source_community_drift() AS v`))[0].v);
const keyOf = async (s: string) => (await q<{ k: string | null }>(`SELECT community_key AS k FROM public.sources WHERE id = $1`, [s]))[0].k;

t("stored class: insert, url update, domain update and a planted value all keep community_key == source_class_of", async () => {
  assertEquals(await drift(), 0, "after the migration's backfill and every test above");
  const r = await source("https://www.reddit.com/r/d{t}/comments/1/");
  assertEquals(await keyOf(r), `reddit.com/r/d${tag}`);
  await q(`UPDATE public.sources SET url = 'https://www.energy.gov/x${tag}' WHERE id = $1`, [r]);
  assertEquals(await keyOf(r), null, "a url change re-classifies");
  const noUrl = id();
  await q(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, NULL, 't', 'c', 'energy.gov')`, [noUrl]);
  assertEquals(await keyOf(noUrl), null);
  await q(`UPDATE public.sources SET domain = 'stackoverflow.com' WHERE id = $1`, [noUrl]);
  assertEquals(await keyOf(noUrl), "stackoverflow.com", "a domain change re-classifies");
  await q(`UPDATE public.sources SET community_key = 'planted.example' WHERE id = $1`, [r]);
  assertEquals(await keyOf(r), null, "a direct write is recomputed from the definition");
  await q(`UPDATE public.sources SET title = 'other' WHERE id = $1`, [noUrl]);
  assertEquals(await keyOf(noUrl), "stackoverflow.com", "an unrelated update keeps it");
  assertEquals(await drift(), 0);
});

t("stored class: a source_classes insert, update and delete re-classify every source (statement triggers)", async () => {
  const gov = await source("https://www.energy.gov/cls{t}");
  const c = await pool!.connect();
  const one = async <T>(sql: string, args: unknown[] = []) => (await c.queryObject<T>(sql, args)).rows;
  const k = async () => (await one<{ k: string | null }>(`SELECT community_key AS k FROM public.sources WHERE id = $1`, [gov]))[0].k;
  const d = async () => Number((await one<{ v: number }>(`SELECT public.source_community_drift() AS v`))[0].v);
  try {
    await one("BEGIN");
    await one(`INSERT INTO public.contract_registry_entries (registry, key, label, definition)
               VALUES ('source_classes', $1, 'probe', $2::jsonb)`, [`probe-${tag}`, JSON.stringify({ order: 5, kind: "forum", host_patterns: ["(^|\.)energy\.gov$"] })]);
    assertEquals(await k(), "energy.gov", "insert: the new class applies to existing rows");
    assertEquals(await d(), 0);
    await one(`UPDATE public.contract_registry_entries SET definition = $2::jsonb WHERE registry = 'source_classes' AND key = $1`,
      [`probe-${tag}`, JSON.stringify({ order: 5, kind: "forum", host_patterns: ["(^|\.)energy\.gov$"], key_host: "gov.example" })]);
    assertEquals(await k(), "gov.example", "update: re-classified with the new definition");
    assertEquals(await d(), 0);
    await one(`DELETE FROM public.contract_registry_entries WHERE registry = 'source_classes' AND key = $1`, [`probe-${tag}`]);
    assertEquals(await k(), null, "delete: back to not community");
    assertEquals(await d(), 0);
  } finally {
    await one("ROLLBACK").catch(() => {});
    c.release();
  }
  assertEquals(await drift(), 0);
});

// ── attempt 2 (tester attempt 1, Case 13): two sessions. A registry change and a source write that overlap must leave
// community_key == source_class_of for every row (the tester's interleavings R1-R3, scratch/race.sh). ──────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function raceRow(key: string, host: string, order: number) {
  return [`race-${key}-${tag}`, JSON.stringify({ order, kind: "forum", host_patterns: [`^${host.replace(/\./g, "\.")}$`] })];
}
async function stored(sid: string) {
  return (await q<{ k: string | null; d: string | null }>(
    `SELECT community_key AS k, public.source_class_of(url, domain) ->> 'key' AS d FROM public.sources WHERE id = $1`, [sid]))[0];
}

t("race R1: a source INSERT open while a source_classes INSERT commits leaves no stale row", async () => {
  const host = `rb1-${tag}.example.com`;
  const a = await pool!.connect(), b = await pool!.connect();
  const sid = id();
  try {
    await a.queryObject("BEGIN");
    await a.queryObject(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, 't', 'c', $3)`, [sid, `https://${host}/t/1`, host]);
    const [k, def] = await raceRow("r1", host, 66);
    const reg = (async () => { await b.queryObject(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('source_classes', $1, 'race', $2::jsonb)`, [k, def]); })();
    await sleep(1500);
    await a.queryObject("COMMIT");
    await reg;
  } finally { await a.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
  const r = await stored(sid);
  assertEquals(r.k, r.d, `stored ${r.k} vs definition ${r.d}`);
  assertEquals(r.d, host);
  assertEquals(await drift(), 0);
});

t("race R2: a source_classes INSERT open while a source INSERT commits leaves no stale row", async () => {
  const host = `rb2-${tag}.example.com`;
  const a = await pool!.connect(), b = await pool!.connect();
  const sid = id();
  try {
    const [k, def] = await raceRow("r2", host, 67);
    await b.queryObject("BEGIN");
    await b.queryObject(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('source_classes', $1, 'race', $2::jsonb)`, [k, def]);
    const src = (async () => { await a.queryObject(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, 't', 'c', $3)`, [sid, `https://${host}/t/1`, host]); })();
    await sleep(1500);
    await b.queryObject("COMMIT");
    await src;
  } finally { await b.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
  const r = await stored(sid);
  assertEquals(r.k, r.d, `stored ${r.k} vs definition ${r.d}`);
  assertEquals(r.d, host);
  assertEquals(await drift(), 0);
});

t("race R3: a source_classes DELETE open while a source url UPDATE commits leaves no stale row", async () => {
  const host = `rb3-${tag}.example.com`;
  const [k, def] = await raceRow("r3", host, 68);
  await q(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('source_classes', $1, 'race', $2::jsonb)`, [k, def]);
  const sid = await source(`https://plain-{t}.example.net/a`);
  const a = await pool!.connect(), b = await pool!.connect();
  try {
    await b.queryObject("BEGIN");
    await b.queryObject(`DELETE FROM public.contract_registry_entries WHERE registry = 'source_classes' AND key = $1`, [k]);
    const upd = (async () => { await a.queryObject(`UPDATE public.sources SET url = $2 WHERE id = $1`, [sid, `https://${host}/t/2`]); })();
    await sleep(1500);
    await b.queryObject("COMMIT");
    await upd;
  } finally { await b.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
  const r = await stored(sid);
  assertEquals(r.k, r.d, `stored ${r.k} vs definition ${r.d}`);
  assertEquals(r.d, null);
  assertEquals(await drift(), 0);
});

// ── fix round 3 (Review 1): the deadlocks, writer concurrency ─────────────────────────────────────────────────────
// I5a / I5b (tester attempt 2): S1 row-locks a source with a title UPDATE (no advisory lock), S2's registry INSERT takes the
// exclusive lock and waits on that row, then S1 INSERTs a source (it needs the shared lock): a cycle, 40P01. With the
// table lock in the reclassify, S2 waits for S1 at the TABLE, before the advisory lock, and no cycle can form.
for (const [name, delay] of [["I5a", 1500], ["I5b", 3500]] as const) {
  t(`race ${name}: a title UPDATE, a registry INSERT and a source INSERT interleave with no deadlock`, async () => {
    const host = `${name.toLowerCase()}-${tag}.example.com`;
    const x = await source(`https://${host}/x`);
    const a = await pool!.connect(), b = await pool!.connect();
    const errs: string[] = [];
    try {
      await a.queryObject("BEGIN");
      await a.queryObject(`UPDATE public.sources SET title = 'locked' WHERE id = $1`, [x]);
      const [k, def] = await raceRow(name.toLowerCase(), host, 70);
      const reg = b.queryObject(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('source_classes', $1, 'race', $2::jsonb)`, [k, def])
        .catch((e) => { errs.push(`registry: ${(e as Error).message}`); });
      await sleep(delay);
      try {
        await a.queryObject(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, 't', 'c', $3)`, [id(), `https://${name}-y-${tag}.example.net/y`, `${name}-y-${tag}.example.net`]);
        await a.queryObject("COMMIT");
      } catch (e) { errs.push(`source: ${(e as Error).message}`); }
      await reg;
    } finally { await a.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
    assertEquals(errs, [], "no deadlock, no error");
    const r = await stored(x);
    assertEquals(r.k, r.d);
    assertEquals(r.d, host);
    assertEquals(await drift(), 0);
  });
}

t("race D-a: an autocommit domain UPDATE queued behind an open registry edit finishes, with no deadlock and no drift", async () => {
  const host = `da-${tag}.example.com`;
  const x = await source(`https://${host}/x`);
  const a = await pool!.connect(), b = await pool!.connect();
  const errs: string[] = [];
  try {
    const [k, def] = await raceRow("da", host, 71);
    await b.queryObject("BEGIN");
    await b.queryObject(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('source_classes', $1, 'race', $2::jsonb)`, [k, def]);
    const upd = a.queryObject(`UPDATE public.sources SET domain = $2 WHERE id = $1`, [x, `da2-${tag}.example.com`])
      .catch((e) => { errs.push(`update: ${(e as Error).message}`); });
    await sleep(1500);
    await b.queryObject("COMMIT").catch((e) => { errs.push(`commit: ${(e as Error).message}`); });
    await upd;
  } finally { await b.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
  assertEquals(errs, []);
  const r = await stored(x);
  assertEquals(r.k, r.d);
  assertEquals(await drift(), 0);
});

// FU2: two ordinary source writers do not wait for each other. The class trigger takes the advisory lock SHARED; if it
// took it EXCLUSIVE, the second INSERT would sit behind the first writer's open transaction until that commits.
t("two source writers: the second INSERT returns while the first writer's transaction is still open", async () => {
  const a = await pool!.connect(), b = await pool!.connect();
  try {
    await a.queryObject("BEGIN");
    await a.queryObject(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, 't', 'c', $3)`, [id(), `https://w1-${tag}.example.org/a`, `w1-${tag}.example.org`]);
    const t0 = performance.now();
    const second = b.queryObject(`INSERT INTO public.sources (id, url, title, content, domain) VALUES ($1, $2, 't', 'c', $3)`, [id(), `https://w2-${tag}.example.org/a`, `w2-${tag}.example.org`]);
    const winner = await Promise.race([second.then(() => "done"), sleep(3000).then(() => "blocked")]);
    const ms = performance.now() - t0;
    await a.queryObject("COMMIT");
    await second;
    assertEquals(winner, "done", "the second writer was blocked by the first");
    assert(ms < 1000, `second INSERT took ${Math.round(ms)} ms`);
  } finally { await a.queryObject("ROLLBACK").catch(() => {}); a.release(); b.release(); }
  assertEquals(await drift(), 0);
});

// ── fix round 3 (Review 1, R1): a community contradiction does not cap a claim that has credible support ─────────────
// The curator's conflict check (research-curator/claims.ts detectConflicts) writes reciprocal claim-to-claim `contradicts`
// edges against the nearest claim; a page-controlled forum post could cap a credible claim at 0.30 through it.
const confOf = async (c: string) => Number((await q<{ v: number }>(`SELECT public.recompute_claim_confidence($1) AS v`, [c]))[0].v);
const edges = async (c: string) => Number((await q<{ n: number }>(`SELECT count(*)::int AS n FROM public.claim_sources WHERE claim_id = $1 AND edge_type = 'contradicts'`, [c]))[0].n);
async function contradict(a: string, b: string) {
  await q(`SELECT public.link_claim_to_claim($1, $2, 'contradicts', 1.0)`, [a, b]);
  await q(`SELECT public.link_claim_to_claim($1, $2, 'contradicts', 1.0)`, [b, a]);
}

t("R1: a contradiction from a community-only claim does not cap a credible claim (legacy and D15); the edge stays", async () => {
  const credible = await claim("credible claim", [await source("https://www.energy.gov/r1{t}")]);
  const [l0, d0] = [await legacy(credible), await d15(credible)];
  assert(l0 > 0.31 && d0 > 0.31, `baseline (must sit above the 0.30 cap) ${l0} ${d0}`);
  const forum = await claim("forum claim", [await source("https://www.reddit.com/r/r1{t}/comments/1/")]);
  await contradict(credible, forum);
  assertEquals(await edges(credible), 1, "the edge is kept, so the contest is visible");
  assertEquals(await edges(forum), 1);
  assertEquals(await legacy(credible), l0, "legacy: not capped");
  assertEquals(await d15(credible), d0, "d15: not capped");
  assert(await confOf(credible) > 0.31, "the stored rating is not capped either");
  assertEquals(await flag("claim_community_only", forum), true);
  assert(await legacy(forum) < 0.5 && await d15(forum) < 0.5, "the community-only claim stays under the floor");
});

t("R1: a contradiction from a community SOURCE does not cap a credible claim", async () => {
  const credible = await claim("credible claim two", [await source("https://www.energy.gov/r1b{t}")]);
  const [l0, d0] = [await legacy(credible), await d15(credible)];
  await q(`SELECT public.link_claim_to_source($1, $2, 'contradicts', 1.0)`, [credible, await source("https://stackoverflow.com/questions/r1b{t}")]);
  assertEquals(await edges(credible), 1);
  assertEquals(await legacy(credible), l0);
  assertEquals(await d15(credible), d0);
});

t("R1 control: a contradiction from a CREDIBLE claim or source still caps at 0.30", async () => {
  const a = await claim("credible a", [await source("https://www.energy.gov/r1c{t}")]);
  const b = await claim("credible b", [await source("https://www.nature.com/articles/r1c{t}")]);
  await contradict(a, b);
  assert(await legacy(a) <= 0.30 && await legacy(b) <= 0.30, `legacy ${await legacy(a)} ${await legacy(b)}`);
  assert(await d15(a) <= 0.30 && await d15(b) <= 0.30, `d15 ${await d15(a)} ${await d15(b)}`);
  const c = await claim("credible c", [await source("https://www.energy.gov/r1d{t}")]);
  await q(`SELECT public.link_claim_to_source($1, $2, 'contradicts', 1.0)`, [c, await source("https://www.nature.com/articles/r1d{t}")]);
  assert(await legacy(c) <= 0.30 && await d15(c) <= 0.30, "a credible source contradicting caps");
});

t("R1: one credible and one community contradiction together still cap (the credible one counts)", async () => {
  const a = await claim("credible mixed", [await source("https://www.energy.gov/r1e{t}")]);
  await contradict(a, await claim("forum e", [await source("https://www.reddit.com/r/r1e{t}/comments/1/")]));
  await contradict(a, await claim("credible e", [await source("https://www.nature.com/articles/r1e{t}")]));
  assert(await legacy(a) <= 0.30 && await d15(a) <= 0.30);
});

t("R1: a community-only claim contradicted by a credible claim stays capped under the floor", async () => {
  const forum = await claim("forum f", [await source("https://www.reddit.com/r/r1f{t}/comments/1/")]);
  const cred = await claim("credible f", [await source("https://www.energy.gov/r1f{t}")]);
  await contradict(forum, cred);
  assert(await legacy(forum) <= 0.30 && await d15(forum) <= 0.30);
});

// FU11: a retracted source supports nothing.
t("FU11: a retracted credible source is not credible support, and does not make a claim community-only by itself", async () => {
  const dead = id();
  await q(`INSERT INTO public.sources (id, url, title, content, domain, retracted_at, retraction_committed_at) VALUES ($1, $2, 't', 'c', $3, now(), now())`,
    [dead, `https://www.nature.com/articles/fu11-${tag}`, "www.nature.com"]);
  const forum = await source("https://www.reddit.com/r/fu11{t}/comments/1/");
  const c = await claim("retracted credible plus forum", [dead, forum]);
  assertEquals(await flag("claim_has_credible_support", c), false, "the only credible source is retracted");
  assertEquals(await flag("claim_community_only", c), true);
  assert(await legacy(c) < 0.5 && await d15(c) < 0.5, "so the forum cannot lift it");
  const live = await claim("live credible", [await source("https://www.nature.com/articles/fu11b-{t}")]);
  assertEquals(await flag("claim_has_credible_support", live), true);
  const noneLeft = await claim("retracted credible only", [dead]);
  assertEquals(await flag("claim_community_only", noneLeft), false, "a retracted credible source is not a community source either");
});

t("FU11: the legacy formula ignores a retracted source in its strong-edge term (D5 stage 1, as the 540 base)", async () => {
  const dead = id();
  await q(`INSERT INTO public.sources (id, url, title, content, domain, retracted_at, retraction_committed_at) VALUES ($1, $2, 't', 'c', $3, now(), now())`,
    [dead, `https://www.nature.com/articles/fu11c-${tag}`, "www.nature.com"]);
  const plain = await claim("inferred only", [await source("https://www.energy.gov/fu11d{t}")], "inferred_from");
  const withDead = await claim("inferred plus a retracted statement", [await source("https://www.energy.gov/fu11e{t}")], "inferred_from");
  await q(`SELECT public.link_claim_to_source($1, $2, 'states', 1.0)`, [withDead, dead]);
  assertEquals(await legacy(withDead), await legacy(plain), "the retracted 'states' edge adds no base score");
});

t("grants: the full-scan helpers are owner-only (service_role cannot run them)", async () => {
  for (const fn of ["public.source_classes_reclassify()", "public.source_community_drift()"]) {
    const ok = (await q<{ v: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS v`, [fn]))[0].v;
    assertEquals(ok, false, fn);
  }
});

