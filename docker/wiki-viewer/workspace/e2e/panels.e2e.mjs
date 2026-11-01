// research-workbench P8a-1 (rw-p8a1-core): the timeline, trail and page graph panels end to end in a real
// headless Chromium, through the lab's front door (the :wt viewer, which serves /workspace and forwards
// /workbench/* to the :wt workbench). Run by OB1/docker/workbench/contract-test/run-panels-tests.ps1 on the
// lab's INTERNAL network only. Environment: FRONT, CDP, PGHOST/PGPASSWORD (the disposable database). One
// PASS/FAIL line per case; exit 0 only if every case passed. Never point it at a live stack.
import { chromium } from "playwright-core";
import pg from "pg";

const FRONT = process.env.FRONT.replace(/\/+$/, "");
const db = new pg.Client({ host: process.env.PGHOST, user: "postgres", password: process.env.PGPASSWORD, database: "openbrain" });
await db.connect();
const sql = async (text, args = []) => (await db.query(text, args)).rows;
const results = [];
const only = (process.env.CASES ?? "").split(",").filter(Boolean);
let page, setupError = null;
async function step(name, fn) {
  if (only.length && !only.some((c) => name.startsWith(c))) return;
  const t0 = Date.now();
  try {
    if (setupError) throw new Error(`the shared setup failed: ${setupError.message}`);
    await fn();
    results.push(["PASS", name]);
    console.log(`  PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push(["FAIL", name]);
    console.log(`  FAIL  ${name}: ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
    await page?.screenshot({ path: `/ev/${name.split(" ")[0]}.png` }).catch(() => {});
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(16).slice(2, 10);
const api = async (method, path, body) => {
  const headers = { "content-type": "application/json", ...(["GET", "HEAD"].includes(method) ? {} : { origin: FRONT }) };
  const r = await fetch(FRONT + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t };
};
const FX = { active: "11111111-1111-4111-8111-111111111111", suppressed: "22222222-2222-4222-8222-222222222222", tomb: "66666666-6666-4666-8666-666666666666" };
const R = uid();
const W = {
  job: crypto.randomUUID(), lead: crypto.randomUUID(), path: crypto.randomUUID(), tomb: crypto.randomUUID(), erased: crypto.randomUUID(),
  urlLead: `https://example.org/e2e-p8a1/${R}/lead`, urlTarget: "https://example.org/active",
  hubA: [0, 1, 2, 3].map((i) => `content/e2e-p8a1-${R}/a${i}`), hubB: [0, 1, 2, 3].map((i) => `content/e2e-p8a1-${R}/b${i}`),
  big: `content/e2e-p8a1-${R}/big`,
};

// ── the shared plants ────────────────────────────────────────────────────────────────────
let DOC;
try {
  // P3a lead + found_via path to the active fixture source, and the P4a per-source event of the same entry
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query) VALUES ($1, 'done', 'workspace', 'e2e p8a1')`, [W.job]);
  const adm = `INSERT INTO public.research_admission_trail (id, job_id, url, url_key, kind, claim_kind, family, score, floor, model_version, reasons, found_via, path, source_id)
               VALUES ($1, $2, $3, public.contract_url_key($3), $4, 'general', 'general', $5, 0.4, 'd15', $6::jsonb, $7, $8::jsonb, $9)`;
  await sql(adm, [W.lead, W.job, W.urlLead, "lead", 0.2, '["below floor"]', null, "[]", null]);
  await sql(adm, [W.path, W.job, W.urlTarget, "lead_path", 0.7, '["reached through a lead"]', W.lead,
    JSON.stringify([{ kind: "lead", url: W.urlLead }, { kind: "lead_path", url: W.urlTarget }]), FX.active]);
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, trail, payload) VALUES ($1, $1, 'source', 'due_process', $2::jsonb, $3::jsonb)`,
    [W.job, JSON.stringify({ id: W.path, url: W.urlTarget, kind: "lead_path", score: 0.7, floor: 0.4, family: "general", reasons: ["reached through a lead"], found_via: W.lead, path: [] }), JSON.stringify({ url: W.urlTarget, outcome: "lead_path" })]);
  // a tombstone to lift
  await sql(`INSERT INTO public.source_tombstones (id, source_id, url, url_key, title, reason_type, note, eraser_kind, eraser_user)
             VALUES ($1, $2, $3, public.contract_url_key($3), 'E2E erased', 'deliberate', 'e2e tombstone note', 'user', 'e2e')`,
    [W.tomb, W.erased, `https://example.org/e2e-p8a1/${R}/erased`]);
  // two hubs of four pages joined by one link, the A hub linking the suppressed fixture source's leaf
  const page_ = (slug, links) => sql(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links) VALUES ($1, 'entity', 'tool', $2, 'e2e', $3::jsonb)`,
    [slug, slug.split("/").pop(), JSON.stringify(links)]);
  const full = (c, i) => c.filter((_x, j) => j !== i);
  for (let i = 0; i < 4; i++) await page_(W.hubA[i], [...full(W.hubA, i), ...(i === 0 ? [W.hubB[0], `content/source/${FX.suppressed}`] : [])]);
  for (let i = 0; i < 4; i++) await page_(W.hubB[i], full(W.hubB, i));
  // a user document linking into hub A and hub B (D12: its listing record's links)
  const d = await api("POST", "/workbench/documents", { title: `E2E P8a1 doc ${R}` });
  ok(d.status === 201, `create: ${d.text}`);
  DOC = d.json.path;
  const f = await api("GET", `/workbench/documents/file?path=${encodeURIComponent(DOC)}`);
  const s = await api("PUT", `/workbench/documents/file?path=${encodeURIComponent(DOC)}`, { content: `${f.json.content}\nLinks [[${W.hubA[1]}|a]] and [[${W.hubB[2]}|b]].\n`, if_match: f.json.hash });
  ok(s.status === 200 || s.status === 207, `save: ${s.text}`);
  // 800 pages around one root: 40 hubs of 20 pages, each hub a ring with chords, hubs joined in a ring
  const rows = [];
  for (let h = 0; h < 40; h++) for (let k = 0; k < 20; k++) {
    const id = (hh, kk) => `${W.big}/h${hh}/p${kk}`;
    const links = [id(h, (k + 1) % 20), id(h, (k + 5) % 20), id(h, (k + 9) % 20)];
    if (k === 0) links.push(id((h + 1) % 40, 0));
    rows.push([id(h, k), links]);
  }
  rows.push([W.big, Array.from({ length: 40 }, (_x, h) => `${W.big}/h${h}/p0`)]);
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await sql(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links)
               SELECT x.slug, 'entity', 'tool', x.slug, 'big', x.links FROM jsonb_to_recordset($1::jsonb) AS x(slug text, links jsonb)`,
      [JSON.stringify(chunk.map(([slug, links]) => ({ slug, links })))]);
  }
} catch (e) {
  setupError = e;
}

const browser = await chromium.connectOverCDP(process.env.CDP);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
page = await context.newPage();
const openWorkspace = async () => {
  await page.goto(`${FRONT}/workspace/`);
  await page.waitForSelector(".ws-titlebar", { timeout: 15000 });
};
const side = (id) => page.locator(`[data-panel="${id}"]`);
const openNav = async (id) => {
  await page.click(`[data-nav="${id}"]`);
  await side(id).waitFor();
};
const expand = async (id) => {
  await side(id).locator(".ws-summary").first().click();
  await sleep(200);
};

await step("E1 the minimum set: timeline, trail, page graph and search are in the nav and open", async () => {
  await openWorkspace();
  for (const id of ["timeline", "trail", "graph", "search"]) {
    ok(await page.locator(`[data-nav="${id}"]`).count() === 1, `nav ${id}`);
    await openNav(id);
  }
});

await step("E2 the trail renders P3a's lead entries with the found_via path and P4a's per-source event", async () => {
  await openWorkspace();
  await openNav("trail");
  await page.waitForSelector('[data-panel="trail"] [data-testid=trail-summary]');
  await expand("trail");
  const adm = side("trail").locator(`[data-trail-origin="admission"][data-stage="lead_path"][data-url="${W.urlTarget}"]`);
  await adm.first().waitFor({ timeout: 5000 });
  ok(await side("trail").locator(`[data-trail-origin="session"][data-url="${W.urlTarget}"]`).count() >= 1, "the session event");
  await adm.first().click();
  await side("trail").locator("[data-testid=found-via]").first().waitFor();
  ok((await side("trail").locator("[data-testid=found-via]").first().textContent()) === W.lead, "found via the lead");
  ok(await side("trail").locator("[data-testid=found-via-path] li").count() === 2, "the found_via path");
});

await step("E3 a tombstone opens from the trail with link, reason and note; lift lifts it", async () => {
  await openWorkspace();
  await openNav("trail");
  await expand("trail");
  const row = side("trail").locator(`[data-tombstone="${W.tomb}"]`).first();
  await row.waitFor({ timeout: 5000 });
  await row.click();
  await side("trail").locator('[data-action="open-tombstone"]').click();
  const t = side("trail").locator("[data-testid=tombstone]");
  await t.waitFor();
  ok((await t.locator("[data-testid=tombstone-link]").getAttribute("href")).endsWith("/erased"), "the link");
  ok((await t.locator("[data-testid=tombstone-reason]").textContent()) === "deliberate", "the reason");
  ok((await t.locator("[data-testid=tombstone-note]").textContent()) === "e2e tombstone note", "the note");
  page.once("dialog", (d) => d.accept("lifted in the e2e"));
  await t.locator('[data-action="lift"]').click();
  for (let i = 0; i < 20; i++) {
    if ((await sql(`SELECT lifted_at FROM public.source_tombstones WHERE id = $1`, [W.tomb]))[0]?.lifted_at) break;
    await sleep(250);
  }
  ok((await sql(`SELECT lifted_at FROM public.source_tombstones WHERE id = $1`, [W.tomb]))[0]?.lifted_at, "lifted in the database");
});

await step("E4 the suppressed fixture source shows its status in the trail, the timeline, search and the page graph", async () => {
  await openWorkspace();
  await openNav("trail");
  await expand("trail");
  ok(await side("trail").locator(`.ws-leaf:has([data-source="${FX.suppressed}"]) .ws-badge-suppressed`).count() >= 1, "trail");
  await openNav("timeline");
  await expand("timeline");
  await sleep(300);
  ok(await side("timeline").locator(`.ws-leaf:has([data-source="${FX.suppressed}"]) .ws-badge-suppressed`).count() >= 1, "timeline");
  await openNav("search");
  await side("search").locator("[data-testid=search-input]").fill("Suppressed fixture");
  await side("search").locator("[data-testid=search-input]").press("Enter");
  await side("search").locator("[data-testid=search-summary]").waitFor();
  await expand("search");
  ok(await side("search").locator(`.ws-leaf:has([data-result="${FX.suppressed}"]) .ws-badge-suppressed`).count() === 1, "search");
  await openNav("graph");
  await side("graph").locator("[data-testid=graph-root]").fill(W.hubA[0]);
  await side("graph").locator("[data-testid=graph-root]").press("Enter");
  const n = side("graph").locator(`[data-node="content/source/${FX.suppressed}"]`);
  await n.waitFor({ timeout: 8000 });
  ok((await n.getAttribute("data-lifecycle")) === "suppressed", "graph node lifecycle");
  ok((await n.textContent()).includes("[suppressed]"), "graph node label");
});

await step("E5 the page graph: the user document links out only, two density neighbourhoods, the lone bridge marked thin", async () => {
  await openWorkspace();
  await openNav("graph");
  await side("graph").locator("[data-testid=graph-root]").fill(W.hubA[0]);
  await side("graph").locator("[data-testid=graph-root]").press("Enter");
  const doc = side("graph").locator(`[data-node="doc:${DOC}"]`);
  await doc.waitFor({ timeout: 8000 });
  ok((await doc.getAttribute("data-neighbourhood")) === "", "a document is no hub");
  const edges = await side("graph").locator("[data-edge]").evaluateAll((els) => els.map((e) => [e.dataset.edge, e.dataset.kind]));
  const docEdges = edges.filter(([e]) => e.includes(`doc:${DOC}`));
  ok(docEdges.length === 2 && docEdges.every(([e, k]) => e.startsWith(`doc:${DOC}>`) && k === "document_link"), `outbound only: ${JSON.stringify(docEdges)}`);
  ok(!edges.some(([e]) => e.split(">")[1].startsWith("doc:")), "no edge into a document");
  const hubOf = async (slug) => side("graph").locator(`[data-node="${slug}"]`).getAttribute("data-neighbourhood");
  ok((await hubOf(W.hubA[1])) === (await hubOf(W.hubA[2])) && (await hubOf(W.hubA[1])) !== (await hubOf(W.hubB[1])), "two neighbourhoods");
  ok(await side("graph").locator(`[data-edge="${W.hubA[0]}>${W.hubB[0]}"].ws-g-thin`).count() === 1, "the bridge is thin");
  const fence = await side("graph").locator("[data-testid=graph-density]").evaluate((g) => ({ filter: g.getAttribute("filter"), shapes: g.querySelectorAll("path, polygon, polyline, rect").length }));
  ok(fence.filter === "url(#ws-g-blur)" && fence.shapes === 0, `density, no fence: ${JSON.stringify(fence)}`);
});

await step("E6 the page graph at 800 pages renders and stays interactive (zoom, pan, pick)", async () => {
  await openWorkspace();
  await openNav("graph");
  await side("graph").locator('input[type="number"]').fill("5");
  const t0 = Date.now();
  await side("graph").locator("[data-testid=graph-root]").fill(W.big);
  await side("graph").locator("[data-testid=graph-root]").press("Enter");
  await page.waitForFunction(() => Number(document.querySelector("[data-testid=graph-canvas]")?.getAttribute("data-nodes") ?? 0) >= 800, null, { timeout: 30000 });
  const render = Date.now() - t0;
  const nodes = Number(await side("graph").locator("[data-testid=graph-canvas]").getAttribute("data-nodes"));
  const canvas = side("graph").locator("[data-testid=graph-canvas]");
  const box = await canvas.boundingBox();
  const timed = async (fn) => { const a = Date.now(); await fn(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); return Date.now() - a; };
  const zoom = await timed(() => page.mouse.wheel(0, -200).then(() => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)));
  const pan = await timed(async () => {
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
    await page.mouse.up();
  });
  const target = side("graph").locator(`[data-node="${W.big}/h3/p0"]`);
  const pick = await timed(() => target.dispatchEvent("click"));
  await side("graph").locator("[data-testid=graph-picked]").waitFor({ timeout: 3000 });
  console.log(`    800-page graph: ${nodes} nodes, render ${render} ms, zoom ${zoom} ms, pan ${pan} ms, pick ${pick} ms`);
  ok(nodes >= 800, `${nodes} nodes`);
  ok(zoom < 1500 && pan < 3000 && pick < 1500, `interactive: zoom ${zoom} pan ${pan} pick ${pick}`);
});

await browser.close().catch(() => {});
await db.end();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`E2E: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
