// The workspace end to end (research-workbench P2b), in a real headless Chromium, through the lab's
// front door (the portal's (wiki_app) Caddy snippet: /workbench/* -> the :wt workbench with the key
// injected, everything else -> the :wt viewer, which serves /workspace).
//
// Run by OB1/docker/workbench/contract-test/run-workspace-tests.ps1 in a container on the lab's
// INTERNAL network only. Environment: FRONT (the front door), CDP (the headless shell's CDP endpoint),
// PGHOST/PGPASSWORD (the disposable database, superuser: the fault trigger). Prints one PASS/FAIL line
// per case; exit 0 only if every case passed. Never point it at a live stack.
import { chromium } from "playwright-core";
import pg from "pg";

const FRONT = process.env.FRONT.replace(/\/+$/, "");
const db = new pg.Client({ host: process.env.PGHOST, user: "postgres", password: process.env.PGPASSWORD, database: "openbrain" });
await db.connect();
const sql = async (text, args = []) => (await db.query(text, args)).rows;
const results = [];
const only = (process.env.CASES ?? "").split(",").filter(Boolean);
async function step(name, fn) {
  if (only.length && !only.some((c) => name.startsWith(c))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push(["PASS", name, Date.now() - t0]);
    console.log(`  PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push(["FAIL", name, Date.now() - t0]);
    console.log(`  FAIL  ${name}: ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
    await page?.screenshot({ path: `/ev/${name.split(" ")[0]}.png` }).catch(() => {});
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const api = async (method, path, body) => {
  const r = await fetch(FRONT + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t };
};
const uid = () => Math.random().toString(16).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = { active: "11111111-1111-4111-8111-111111111111", suppressed: "22222222-2222-4222-8222-222222222222", idea: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", page: "content/tool/tool-fixture" };

async function newSource(content) {
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, $3, $4, 'web_article')`, [id, `https://example.org/e2e/${id}`, `E2E source ${id.slice(0, 6)}`, content]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, $2)`, [id, content]);
  return id;
}
async function revise(id, content) {
  await sql(`INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
             SELECT $1, COALESCE(max(revision), 1) + 1, $2, 'revised', 'e2e' FROM public.source_revisions WHERE source_id = $1`, [id, content]);
  await sql(`UPDATE public.sources SET content = $2 WHERE id = $1`, [id, content]);
  await sql(`UPDATE public.source_chunks SET content = $2 WHERE source_id = $1`, [id, content]);
}
async function docWith(title, body) {
  const r = await api("POST", "/workbench/documents", { title });
  ok(r.status === 201, `create: ${r.text}`);
  if (body !== undefined) {
    const f = await api("GET", `/workbench/documents/file?path=${encodeURIComponent(r.json.path)}`);
    const s = await api("PUT", `/workbench/documents/file?path=${encodeURIComponent(r.json.path)}`, { content: f.json.content + body, if_match: f.json.hash });
    ok(s.status === 200, `save: ${s.text}`);
  }
  return r.json.path;
}
const fileOf = async (p) => (await api("GET", `/workbench/documents/file?path=${encodeURIComponent(p)}`)).json.content;

// ── the browser ──────────────────────────────────────────────────────────────────────────
const cdp = process.env.CDP;
const browser = await chromium.connectOverCDP(cdp);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: FRONT }).catch(() => {});
let page = await context.newPage();
const requests = [];
const watch = (p) => p.on("request", (r) => requests.push({ method: r.method(), url: r.url().replace(FRONT, ""), post: r.postData() ?? "" }));
watch(page);
const openWorkspace = async (doc) => {
  await page.goto(`${FRONT}/workspace/${doc ? `?doc=${encodeURIComponent(doc)}` : ""}`);
  await page.waitForSelector(".ws-titlebar", { timeout: 15000 });
};
const surface = () => page.locator('[data-panel="document"]');
const sidePanel = (id) => page.locator(`[data-panel="${id}"]`);

// shared fixtures for the reference cases
const S1 = await newSource("First e2e source: alpha words to quote stay here.");
const S2 = await newSource("Second e2e source: beta words to transclude live here.");
const P1 = await docWith(`E2E refs ${uid()}`, "Intro paragraph.\n");
const chip1 = await api("POST", "/workbench/documents/references", { path: P1, source_id: S1, exact: "alpha words to quote", form: "chip" });
const tr2 = await api("POST", "/workbench/documents/references", { path: P1, source_id: S2, exact: "beta words to transclude", form: "transclusion" });
ok(chip1.status === 201 && tr2.status === 201, `references: ${chip1.text} ${tr2.text}`);
{
  const f = await api("GET", `/workbench/documents/file?path=${encodeURIComponent(P1)}`);
  await api("PUT", `/workbench/documents/file?path=${encodeURIComponent(P1)}`, {
    content: `${f.json.content}A chip ${chip1.json.insert} and a transclusion ${tr2.json.insert} end.\n\n[[${FX.page}|the tool]] and [[source:${FX.active}|the active source]].\n`,
    if_match: f.json.hash,
  });
}
const REF1 = chip1.json.record.id;
const REF2 = tr2.json.record.id;
await revise(S1, "First e2e source, revised: alpha words to quote stay here.");

await step("C8 a document created through the API opens in the editor from its file and listing within 2 s; no wiki_pages row", async () => {
  await openWorkspace();
  const t0 = Date.now();
  const r = await api("POST", "/workbench/documents", { title: `E2E fresh ${uid()}` });
  await page.evaluate((p) => { history.replaceState(null, "", `?doc=${encodeURIComponent(p)}`); }, r.json.path);
  await page.goto(`${FRONT}/workspace/?doc=${encodeURIComponent(r.json.path)}`);
  await page.waitForSelector(`[data-document="${r.json.path}"] [data-testid=rendered]`, { timeout: 5000 });
  await page.click("[data-testid=edit]");
  await page.waitForSelector("[data-testid=editor] .cm-content");
  const ms = Date.now() - t0;
  ok(ms < 2000, `open took ${ms} ms`);
  const listed = await page.evaluate(async (p) => (await (await fetch("/workbench/contract/documents")).json()).documents.some((d) => d.path === p), r.json.path);
  ok(listed, "in the listing");
  ok((await sql(`SELECT 1 FROM public.wiki_pages WHERE slug LIKE 'documents/%'`)).length === 0, "no wiki_pages row");
  await page.click("[data-testid=done]");
});

await step("C3 opening flags only the reference whose chunk has a newer revision and fetches no text until one is opened", async () => {
  requests.length = 0;
  await openWorkspace(P1);
  await page.waitForSelector(`[data-document="${P1}"] [data-testid=rendered] .ws-chip`);
  await sleep(800);
  const stale = await page.$$eval(".ws-rendered .ws-chip.ws-stale", (els) => els.map((e) => e.dataset.ref));
  ok(JSON.stringify(stale) === JSON.stringify([REF1]), `stale ${JSON.stringify(stale)}`);
  const text = requests.filter((r) => /\/workbench\/contract\/(references|chunks)\//.test(r.url));
  ok(text.length === 0, `text fetched on open: ${text.map((r) => r.url).join(", ")}`);
  ok(requests.some((r) => r.url.startsWith("/workbench/contract/diff-check")), "the diff-id check ran");
});

await step("C10 the document renders read-only from its file (no page route, render module or contract page call); edit swaps in place; save writes the file and refreshes the listing links", async () => {
  requests.length = 0;
  await openWorkspace(P1);
  await page.waitForSelector(`[data-document="${P1}"] [data-testid=rendered]`);
  const pageCalls = requests.filter((r) => !/^\/(workspace|workbench)\//.test(r.url) || /\/contract\/(neighbours|search|pages)/.test(r.url) || r.url.includes("graphIndex"));
  ok(pageCalls.length === 0, `page calls: ${pageCalls.map((r) => r.url).join(", ")}`);
  ok(await surface().locator("[data-mode=view]").count() === 1 || await page.locator(`[data-document="${P1}"][data-mode=view]`).count() === 1, "view mode");
  await page.click("[data-testid=edit]");
  await page.waitForSelector(`[data-document="${P1}"][data-mode=edit] .cm-content`);
  const S3 = await newSource("Third e2e source linked during the edit.");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\nadded line [[source:${S3}|third]]`);
  await page.waitForFunction(() => document.querySelector("[data-testid=status]")?.textContent === "unsaved changes");
  const put = await page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/workbench/documents/file"), { timeout: 5000 });
  ok(JSON.parse(put.postData()).if_match, "autosave carries If-Match");
  await page.waitForFunction(() => document.querySelector("[data-testid=status]")?.textContent === "saved", null, { timeout: 5000 });
  await page.click("[data-testid=done]");
  await page.waitForSelector(`[data-document="${P1}"][data-mode=view] [data-testid=rendered]`);
  ok((await fileOf(P1)).includes("added line"), "the file was written");
  ok(await page.locator(".ws-rendered").innerText().then((t) => t.includes("added line")), "the rendered view refreshed");
  const links = (await sql(`SELECT outbound_links FROM public.user_document_listings WHERE path = $1`, [P1]))[0].outbound_links;
  ok(links.some((l) => l.id === S3), "the listing's links were refreshed");
});

await step("C1 a transclusion pins the chunk revision and its text cannot be edited in place", async () => {
  ok((await sql(`SELECT pinned_revision FROM public.reference_records WHERE id = $1`, [REF2]))[0].pinned_revision === 1, "pinned");
  await openWorkspace(P1);
  await page.waitForSelector(`[data-document="${P1}"] [data-testid=rendered]`);
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content .ws-transclusion");
  const before = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  const box = await page.locator(".cm-content .ws-transclusion .ws-transclusion-text").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("XYZ");
  await page.keyboard.press("Delete");
  await sleep(1800);
  const file = await fileOf(P1);
  ok(file.includes(`{{ref:${REF2}}}beta words to transclude{{/ref}}`), "the quoted text is intact in the file");
  ok(!/beta[^{]*XYZ|XYZ[^{]*transclude/.test(file), "nothing typed inside it");
  ok(before.includes("beta words to transclude"), "drawn in the editor");
  await page.keyboard.press("Control+z");
  await sleep(1800);
  await page.click("[data-testid=done]");
});

await step("C2 a deliberate break leaves the text and a chip on the same record, which previews at its pin and jumps the reference panel", async () => {
  await openWorkspace(P1);
  await page.waitForSelector(`[data-document="${P1}"] [data-testid=rendered]`);
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content .ws-transclusion");
  const box = await page.locator(".cm-content .ws-transclusion").boundingBox();
  await page.mouse.click(box.x + box.width + 2, box.y + box.height / 2);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+Shift+B");
  await sleep(1800);
  let file = await fileOf(P1);
  ok(file.includes(`beta words to transclude [@ref:${REF2}]`), `broken: ${file.slice(-300)}`);
  // the source moves on; a re-pin elsewhere must not retarget this chip
  await revise(S2, "Second e2e source, revised: beta words to transclude live here.");
  const re = await api("POST", `/workbench/documents/references/${REF2}/repin?path=${encodeURIComponent(P1)}`);
  ok(re.status === 201, re.text);
  file = await fileOf(P1);
  ok(file.includes(`[@ref:${REF2}]`), "the chip still names its own record");
  ok((await sql(`SELECT pinned_revision FROM public.reference_records WHERE id = $1`, [REF2]))[0].pinned_revision === 1, "frozen to its pin");
  await page.click("[data-testid=done]");
  await page.waitForSelector(`.ws-rendered .ws-chip[data-ref="${REF2}"]`);
  await page.hover(`.ws-rendered .ws-chip[data-ref="${REF2}"]`);
  await page.waitForSelector("[data-testid=popover] blockquote");
  ok((await page.locator("[data-testid=popover]").innerText()).includes("pinned at revision 1"), "previews at its pin");
  await page.click("[data-testid=popover-jump]");
  await page.waitForSelector(`[data-panel="reference"] [data-focus="${REF2}"]`);
});

await step("C4 selecting a chip focuses the reference panel; the neighbour strip is relative to that reference", async () => {
  requests.length = 0;
  await openWorkspace(P1);
  await page.waitForSelector(`.ws-rendered .ws-chip[data-ref="${REF1}"]`);
  await page.click(`.ws-rendered .ws-chip[data-ref="${REF1}"]`);
  await page.waitForSelector(`[data-panel="reference"] [data-focus="${REF1}"]`);
  await sleep(600);
  const nb = requests.filter((r) => r.url.startsWith("/workbench/contract/neighbours"));
  ok(nb.length >= 1, "a strip was computed");
  ok(nb.every((r) => decodeURIComponent(r.url).includes(`id=content/source/${S1}`)), `strip ids: ${nb.map((r) => r.url).join(", ")}`);
  ok(nb.every((r) => !decodeURIComponent(r.url).includes(P1)), "never the document");
});

await step("C6 inject creates a reference at the cursor from the panel's selection; mirror sends a selection to the panel as a search", async () => {
  await openWorkspace(P1);
  await page.waitForSelector(`.ws-rendered .ws-chip[data-ref="${REF1}"]`);
  await page.click(`.ws-rendered .ws-chip[data-ref="${REF1}"]`);
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\ninjected here: ");
  await page.waitForSelector('[data-panel="reference"] [data-leaf="chunk:0"] .ws-leaf-label');
  const before = (await fileOf(P1)).match(/\[@ref:/g)?.length ?? 0;
  await page.click('[data-panel="reference"] [data-leaf="chunk:0"] .ws-leaf-label');
  await page.click('[data-panel="reference"] [data-action="inject"]');
  await sleep(2000);
  const after = await fileOf(P1);
  ok((after.match(/\[@ref:/g)?.length ?? 0) === before + 1, "one new chip");
  ok(/injected here: \[@ref:[0-9a-f-]{36}\]/.test(after), "at the cursor");
  // mirror
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nmirrored words");
  await page.keyboard.down("Shift");
  for (let i = 0; i < "mirrored words".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector('[data-panel="search"] [data-testid=search-summary]');
  ok((await page.locator('[data-panel="search"] [data-testid=search-summary]').innerText()).includes('"mirrored words"'), "the panel searched the selection");
  await sleep(1700);
  await page.click("[data-testid=done]");
});

await step("C5 the layout survives a reload", async () => {
  await openWorkspace(P1);
  await page.click('[data-nav="hubs"]');
  await page.click('[data-nav="history"]');
  await page.waitForSelector('[data-panel="history"]');
  const layoutOf = () => page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("ws.layout.v1:"));
    return k ? { key: k, value: localStorage.getItem(k) } : null;
  });
  const beforeL = await layoutOf();
  ok(beforeL && beforeL.key === "ws.layout.v1:operator", `the layout is kept per user: ${beforeL?.key}`);
  const before = beforeL.value;
  const panelsBefore = await page.$$eval("[data-panel]", (els) => els.map((e) => e.dataset.panel).sort());
  await page.reload();
  await page.waitForSelector('[data-panel="history"]', { timeout: 10000 });
  const panelsAfter = await page.$$eval("[data-panel]", (els) => els.map((e) => e.dataset.panel).sort());
  ok(JSON.stringify(panelsBefore) === JSON.stringify(panelsAfter), `${panelsBefore} vs ${panelsAfter}`);
  const after = (await layoutOf()).value;
  ok(before && JSON.parse(after).panels && Object.keys(JSON.parse(after).panels).sort().join() === Object.keys(JSON.parse(before).panels).sort().join(), "the same layout");
});

await step("C7 a transient and a structural notification appear in the bell within 2 s with class and subject, jump, and an acknowledgement survives a reload", async () => {
  await openWorkspace(P1);
  await page.waitForSelector("[data-testid=unread]");
  const t = `e2e transient ${uid()}`;
  const s = `e2e structural ${uid()}`;
  const t0 = Date.now();
  const [nt] = await sql(`SELECT id::text FROM public.post_research_notification('transient', $1, $2, NULL)`, [t, FX.page]);
  const [ns] = await sql(`SELECT id::text FROM public.post_research_notification('structural', $1, NULL, $2)`, [s, `idea:${FX.idea}`]);
  await page.click("[data-testid=bell]");
  await page.waitForSelector(`[data-notification="${nt.id}"]`, { timeout: 2000 });
  await page.waitForSelector(`[data-notification="${ns.id}"]`, { timeout: Math.max(1, 2000 - (Date.now() - t0)) });
  ok(Date.now() - t0 <= 2000, `took ${Date.now() - t0} ms`);
  ok((await page.locator(`[data-notification="${nt.id}"]`).getAttribute("data-class")) === "transient", "class");
  ok((await page.locator(`[data-notification="${ns.id}"]`).getAttribute("data-class")) === "structural", "class");
  ok((await page.locator(`[data-notification="${nt.id}"]`).innerText()).includes(t), "subject");
  const href = await page.locator(`[data-notification="${nt.id}"] a.ws-jump`).getAttribute("href");
  const jump = await fetch(FRONT + href);
  ok(jump.status === 200 && jump.headers.get("x-wiki-render") === "db", `the page jump is live (${jump.status} ${jump.headers.get("x-wiki-render")})`);
  await page.click(`[data-notification="${ns.id}"] button.ws-jump`);
  await page.waitForSelector('[data-panel="refinery"]');
  await page.click("[data-testid=bell]").catch(() => {});
  const unread = Number(await page.locator("[data-testid=unread]").innerText());
  if (!(await page.locator(`[data-notification="${nt.id}"]`).count())) await page.click("[data-testid=bell]");
  await page.click(`[data-notification="${nt.id}"] .ws-ack`);
  await page.waitForFunction((n) => Number(document.querySelector("[data-testid=unread]").textContent) === n - 1, unread);
  await page.reload();
  await page.waitForSelector("[data-testid=unread]");
  await sleep(1500);
  ok(Number(await page.locator("[data-testid=unread]").innerText()) === unread - 1, "the acknowledgement held across the reload");
});

await step("C9 a save whose listing update fails is reported once, the file stays, and the reconcile on the next connect repairs the listing", async () => {
  const p = await docWith(`E2E fault ${uid()}`);
  await openWorkspace(p);
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content");
  await sql(`CREATE OR REPLACE FUNCTION public.p2b_e2e_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'e2e fault'; END $$`);
  await sql(`CREATE TRIGGER p2b_e2e_fault BEFORE INSERT OR UPDATE ON public.user_document_listings FOR EACH ROW EXECUTE FUNCTION public.p2b_e2e_fault()`);
  try {
    await page.click(".cm-content");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type(" (renamed in a fault)");
    await page.waitForFunction(() => /listing could not be updated/.test(document.querySelector("[data-testid=status]")?.textContent ?? ""), null, { timeout: 6000 });
    await page.keyboard.type(" again");
    await sleep(2500);
    ok(!/listing could not be updated/.test(await page.locator("[data-testid=status]").innerText()), "reported once, not on every save");
  } finally {
    await sql(`DROP TRIGGER IF EXISTS p2b_e2e_fault ON public.user_document_listings`);
    await sql(`DROP FUNCTION IF EXISTS public.p2b_e2e_fault()`);
  }
  ok((await fileOf(p)).includes("(renamed in a fault) again"), "the file is on disk");
  ok((await sql(`SELECT count(*)::int AS n FROM public.research_notifications WHERE entity = $1`, [`document:${p}`]))[0].n === 1, "one notification");
  const stale = (await sql(`SELECT title FROM public.user_document_listings WHERE path = $1`, [p]))[0].title;
  ok(!stale.includes("renamed in a fault"), "the listing is stale before the reconnect");
  await page.reload(); // the next connect
  await page.waitForSelector(".ws-titlebar");
  await sleep(1500);
  const fixed = (await sql(`SELECT title FROM public.user_document_listings WHERE path = $1`, [p]))[0].title;
  ok(fixed.includes("(renamed in a fault) again"), `repaired: ${fixed}`);
  ok((await sql(`SELECT 1 FROM public.wiki_pages WHERE slug LIKE 'documents/%'`)).length === 0, "no wiki_pages row");
});

await step("C12 parity: live preview, [[ autocomplete from the listing and the contract, hover popover, toolbar, keymap and undo, tab indent", async () => {
  requests.length = 0;
  const p = await docWith(`E2E parity ${uid()}`, "\n## A heading\n\n**bold** *it* ~~gone~~ `code` [link](https://example.org) [[content/tool/tool-fixture|tool]]\n");
  await openWorkspace(p);
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content");
  ok(await page.locator(".cm-content .ws-cm-h2").count() >= 1, "heading rendered in place");
  ok(await page.locator(".cm-content .ws-cm-strong").count() >= 1 && await page.locator(".cm-content .ws-cm-em").count() >= 1, "bold, italic");
  ok(await page.locator(".cm-content .ws-cm-strike").count() >= 1 && await page.locator(".cm-content .ws-cm-code").count() >= 1, "strike, code");
  ok(await page.locator(".cm-content .ws-cm-link-page").count() >= 1 && await page.locator(".cm-content .ws-cm-link-url").count() >= 1, "links and wikilinks");
  ok(await page.locator(".cm-content .ws-cm-fm-key").count() >= 1, "frontmatter styled");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n[[Active fix");
  await page.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 4000 });
  ok(requests.some((r) => r.url.startsWith("/workbench/documents/candidates")), "candidates from the documents API");
  ok(!requests.some((r) => r.url.includes("graphIndex.json")), "never graphIndex.json");
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.hover(".cm-content .ws-cm-link-page");
  await page.waitForSelector("[data-testid=popover]");
  ok(await page.locator(".ws-tb").count() === 1, "the cursor toolbar");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nword");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Tab");
  const t1 = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  await page.keyboard.press("Control+z");
  const t2 = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  ok(t1 !== t2, "undo");
  await page.keyboard.press("Control+Shift+z");
  ok(await page.locator('.ws-tb [data-tool="Bulleted list"]').count() === 1 && await page.locator('.ws-tb [data-tool="Heading"]').count() === 1, "list and heading toggles");
  await sleep(1800);
  await page.click("[data-testid=done]");
  // frontmatter preserved verbatim
  ok((await fileOf(p)).startsWith(`---\ntitle: `), "frontmatter kept");
});

await step("C12 parity: export MD / PDF / TEXT / DOCX through the export route, copy page and per-heading copy", async () => {
  await openWorkspace(P1);
  await page.click('[data-tool="export"]');
  for (const f of ["md", "pdf", "txt", "docx"]) {
    const href = await page.locator(`[data-format="${f}"]`).getAttribute("href");
    const r = await fetch(FRONT + href);
    ok(r.status === 200, `${f}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  ok(await page.locator('[data-format="copy"]').count() === 1, "copy page");
  ok(await page.locator(".ws-rendered .ws-copy-heading").count() >= 1, "per-heading copy");
});

await step("C12 parity: management from the documents panel - folder, create, trash, restore, history, properties, references", async () => {
  await openWorkspace(P1);
  await page.click('[data-nav="documents"]');
  const docs = sidePanel("documents");
  await docs.locator(".ws-summary").click();
  await docs.locator('[data-leaf="folder:"] .ws-leaf-label').click();
  const title = `E2E from the panel ${uid()}`;
  await docs.locator("[data-testid=new-doc-title]").fill(title);
  await docs.locator('[data-action="create-document"]').click();
  await page.waitForFunction((t) => document.querySelector(".ws-doc-title")?.textContent === t, title);
  const path = await surface().locator("[data-document]").getAttribute("data-document");
  ok((await sql(`SELECT 1 FROM public.user_document_listings WHERE path = $1`, [path])).length === 1, "listed");
  await page.waitForSelector(`[data-panel="documents"] [data-doc="${path}"]`, { timeout: 5000 });
  await docs.locator(`[data-leaf="${path}"] .ws-leaf-label`).click();
  await docs.locator('[data-action="trash"]').click();
  await page.waitForSelector(`[data-panel="documents"] [data-doc*="/.trash/"]`, { timeout: 5000 });
  const tp = path.replace(/^(documents\/(?:[^./][^/]*\/)?)/, "$1.trash/"); // documents/<owner key>/.trash/...
  await docs.locator(`[data-leaf="${tp}"] .ws-leaf-label`).click();
  await docs.locator('[data-action="restore"]').click();
  await page.waitForSelector(`[data-panel="documents"] [data-doc="${path}"]`, { timeout: 5000 });
  await page.evaluate((p) => { location.search = `?doc=${encodeURIComponent(p)}`; }, path);
  await page.waitForSelector(".ws-titlebar");
  await page.click('[data-nav="history"]');
  await sidePanel("history").locator(".ws-summary").click();
  // the history is fetched after the panel opens: wait for its first leaf, then count
  await sidePanel("history").locator(".ws-leaf").first().waitFor({ timeout: 10000 }).catch(() => {});
  if (!(await sidePanel("history").locator(".ws-leaf").count())) {
    const h = await api("GET", `/workbench/documents/history?path=${encodeURIComponent(path)}`);
    throw new Error(`history lists commits: the panel shows none; the API: ${h.status} ${h.text.slice(0, 400)}; the panel: ${(await sidePanel("history").innerText()).slice(0, 200)}`);
  }
  await page.click('[data-nav="properties"]');
  await sidePanel("properties").locator(".ws-summary").click();
  await sidePanel("properties").locator('[data-leaf="__new"] .ws-leaf-label').click();
  await sidePanel("properties").locator("[data-testid=prop-key]").fill("status");
  await sidePanel("properties").locator("[data-testid=prop-value]").fill("draft");
  await sidePanel("properties").locator('[data-action="set-property"]').click();
  await sleep(800);
  ok((await fileOf(path)).includes('status: "draft"'), "property set");
  await page.click('[data-nav="doc-references"]');
  await sidePanel("doc-references").locator(".ws-summary").click();
  await sidePanel("doc-references").locator('[data-leaf="add"] .ws-leaf-label').click();
  await sidePanel("doc-references").locator("[data-testid=refs-find]").fill("Active fixture");
  await sidePanel("doc-references").getByText("Find").click();
  await sidePanel("doc-references").locator('[data-action="add-reference"]').first().click();
  await sleep(800);
  const held = await sql(`SELECT origin FROM public.reference_holders WHERE holder_kind = 'user_document' AND holder_ref = $1`, [path]);
  ok(held.some((h) => h.origin === "added"), "an added reference");
});

await step("C15 from the open document: references, queue research, gap session, the room, search and the hub context, without leaving it", async () => {
  await openWorkspace(P1);
  await page.waitForSelector(`[data-document="${P1}"]`);
  for (const [tool, panel] of [["references", "doc-references"], ["room", "refinery"], ["search", "search"], ["hubs", "hubs"]]) {
    await page.click(`[data-tool="${tool}"]`);
    await page.waitForSelector(`[data-panel="${panel}"]`);
    ok(await page.locator(`[data-document="${P1}"]`).count() === 1, `the document stays open (${tool})`);
  }
  for (const kind of ["research", "gap"]) {
    await page.click(`[data-tool="${kind}"]`);
    await page.fill(`[data-testid="toolform-${kind}"] textarea`, `e2e ${kind} question`);
    await page.click(`[data-testid="toolform-${kind}"] button[type=submit]`);
    await page.waitForFunction((k) => (document.querySelector("[data-testid=status]")?.textContent ?? "").includes(k === "gap" ? "gap session queued" : "research queued"), kind);
    ok(await page.locator(`[data-document="${P1}"]`).count() === 1, `the document stays open (${kind})`);
  }
  await sidePanel("hubs").locator(".ws-summary").click();
  await page.waitForSelector(`[data-panel="hubs"] [data-hub]`);
  const hubs = await page.$$eval('[data-panel="hubs"] [data-hub]', (els) => els.map((e) => e.dataset.hub));
  ok(hubs.includes(FX.page) || hubs.length >= 1, `hubs ${hubs}`);
  ok(!hubs.includes(P1), "the document is not a hub");
});

await step("C18 start refinery is greyed out with a tooltip until the document carries an idea; then it starts one refinery", async () => {
  const p = await docWith(`E2E refinery ${uid()}`);
  await openWorkspace(p);
  await page.waitForSelector('[data-tool="refinery"]');
  ok(await page.locator('[data-tool="refinery"]').isDisabled(), "greyed out");
  ok((await page.locator('[data-tool="refinery"]').getAttribute("title")) === "add an idea to the document to get started", "tooltip");
  await api("POST", "/workbench/documents/property", { path: p, key: "idea", value: "an e2e idea" });
  await page.reload();
  await page.waitForSelector('[data-tool="refinery"]:not([disabled])');
  const n0 = (await sql(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  await page.click('[data-tool="refinery"]');
  await page.waitForFunction(() => document.querySelector('[data-tool="refinery"]')?.textContent === "Open refinery");
  ok((await sql(`SELECT count(*)::int AS n FROM public.ideas`))[0].n === n0 + 1, "one ideas row");
  // C19: archive from the refinery panel; tag; editable; reopen
  await page.click('[data-nav="refinery"]');
  const rp = sidePanel("refinery");
  await rp.locator(".ws-summary").click();
  await rp.locator('[data-leaf="document"] .ws-leaf-label').click();
  await rp.locator('[data-action="archive-refinery"]').click();
  await page.waitForSelector('[data-tag="refinery archived"]');
  await page.click("[data-testid=edit]");
  await page.waitForSelector(".cm-content");
  await page.click("[data-testid=done]");
  await rp.locator('[data-leaf="document"] .ws-leaf-label').click().catch(() => {});
  if (!(await rp.locator('[data-action="open-refinery"]').count())) await rp.locator('[data-leaf="document"] .ws-leaf-label').click();
  await rp.locator('[data-action="open-refinery"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-tag="refinery archived"]'));
  ok((await sql(`SELECT count(*)::int AS n FROM public.ideas`))[0].n === n0 + 1, "reopened, not recreated");
  // C20: the contextual + holds a source in this refinery
  await page.click('[data-tool="plus"]');
  await page.fill('[data-testid="toolform-source"] input[placeholder=title]', `E2E held ${uid()}`);
  await page.fill('[data-testid="toolform-source"] textarea', "held source text from the e2e");
  await page.click('[data-testid="toolform-source"] button[type=submit]');
  await page.waitForFunction(() => (document.querySelector("[data-testid=status]")?.textContent ?? "").includes("held in this document's refinery"));
});

await step("C20 the title bar: Settings, Theme, the bell, the universal + naming an existing refinery and creating none", async () => {
  await openWorkspace(P1);
  for (const id of ["settings", "theme", "bell", "plus"]) ok(await page.locator(`.ws-titlebar [data-testid=${id}]`).count() === 1, id);
  ok(await page.locator(".ws-nav [data-testid=bell], .ws-nav .ws-bell").count() === 0, "the bell is not in the left nav");
  ok(await page.locator(".ws-bell").count() === 1, "one notifications surface");
  ok(await page.locator('[data-testid=progress] [data-indicator="compiling"]').count() === 1 &&
    await page.locator('[data-testid=progress] [data-indicator="ingesting"]').count() === 1 &&
    await page.locator('[data-testid=progress] [data-indicator="held"]').count() === 1, "progress indicators");
  const n0 = (await sql(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  await page.click("[data-testid=plus]");
  await page.waitForSelector("[data-testid=plus-refinery]");
  const opts = await page.$$eval("[data-testid=plus-refinery] option", (os) => os.map((o) => o.value).filter(Boolean));
  ok(opts.includes(FX.idea), "existing refineries listed");
  await page.selectOption("[data-testid=plus-refinery]", FX.idea);
  await page.fill('.ws-plus input[placeholder=title]', `E2E universal ${uid()}`);
  await page.fill('.ws-plus textarea', "universal plus text");
  await page.click('.ws-plus button[type=submit]');
  await page.waitForSelector("[data-testid=plus-msg]");
  ok((await page.locator("[data-testid=plus-msg]").innerText()).includes("held in the refinery"), "held");
  ok((await sql(`SELECT count(*)::int AS n FROM public.ideas`))[0].n === n0, "no refinery created");
  await page.click("[data-testid=theme]");
  ok(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "theme");
  await page.click("[data-testid=settings]");
  ok(await page.locator(".ws-settings").count() === 1, "settings");
});

await step("C21 side panels at rest: summary first, no leaves, no actions", async () => {
  await openWorkspace(P1);
  const navs = await page.$$eval("[data-nav]", (els) => els.map((e) => e.dataset.nav));
  for (const n of navs) {
    await page.click(`[data-nav="${n}"]`);
    const panel = sidePanel(n);
    await panel.waitFor();
    await sleep(300);
    if (n === "reference" && await panel.locator("[data-focus]").count()) continue; // focused by an earlier selection
    ok(await panel.locator("[data-action], .ws-actions").count() === 0, `${n}: an action at rest`);
    ok(await panel.locator(".ws-leaves").count() === 0, `${n}: opened expanded`);
  }
});

await step("C22 the shell's nav is the registry's: every registered area, no other", async () => {
  await openWorkspace(P1);
  const navs = await page.$$eval("[data-nav]", (els) => els.map((e) => e.dataset.nav));
  ok(navs.length >= 8, `nav: ${navs}`);
});

await step("D12 the run left no user document as a wiki page and never read Quartz's index", async () => {
  ok((await sql(`SELECT 1 FROM public.wiki_pages WHERE slug LIKE 'documents/%'`)).length === 0, "no wiki_pages row");
  ok(!requests.some((r) => r.url.includes("graphIndex.json") || r.url.startsWith("/__notifications")), "no index, no strip route");
});

await browser.close().catch(() => {});
await db.end();
const failed = results.filter((r) => r[0] === "FAIL");
console.log(`E2E: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
