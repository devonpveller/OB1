// Headless-Chromium e2e driver for the picker (rwr-picker), run by run-picker-lab.ps1 on an --internal network.
// Drives the harness page (/picker-harness.html, built only with PICKER_HARNESS=1) of two app containers, each in front
// of its own stub (identity A, identity B), over the Chrome DevTools Protocol. Real key events, real DOM, axe-core.
// Env: CHROME_IP, APP_A, APP_B (http origins), STUB_A, STUB_B (http origins of the stubs' /__log), LAB_KEY.
import { readFileSync } from "node:fs";

const { CHROME_IP, APP_A, APP_B, STUB_A, STUB_B, LAB_KEY } = process.env;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AXE = readFileSync("/axe/axe.min.js", "utf8");

async function session() {
  const tgt = await (await fetch(`http://${CHROME_IP}:9222/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CHROME_IP}:9222`));
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  for (const d of ["Network", "Page", "Log", "Runtime"]) await send(d + ".enable");
  const key = async (k, mods = 0) => {
    const codes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 };
    const p = { key: k, code: k, windowsVirtualKeyCode: codes[k] ?? 0, modifiers: mods };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  };
  const typeText = async (t) => { await ev(`document.querySelector('[data-testid=picker-q]').focus()`); await send("Input.insertText", { text: t }); };
  const reqs = () => events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => ({ method: e.params.request.method, url: e.params.request.url, type: e.params.type }));
  const close = async () => { ws.close(); await fetch(`http://${CHROME_IP}:9222/json/close/${tgt.id}`).catch(() => {}); };
  const open = async (url) => { await send("Page.navigate", { url }); await sleep(1200); await ev(`document.querySelector('[data-testid=picker]') ? 1 : 0`); };
  const waitFor = async (js, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(js)) return true; await sleep(100); } return false; };
  return { send, ev, key, typeText, reqs, events, close, open, waitFor };
}
const keys = `[...document.querySelectorAll('[data-testid=picker-list] [role=option]')].map(e=>e.getAttribute('data-key'))`;
const stubLog = async (u) => (await (await fetch(`${u}/__log`)).json());
const csp = (b) => b.events.filter((e) => (e.method === "Log.entryAdded" && /Content Security Policy|Refused to/i.test(e.params.entry.text)) || (e.method === "Runtime.exceptionThrown"));

// ---------------- identity A: library, filters, tray, keyboard, same-as-search ----------------
const a = await session();
await a.open(`${APP_A}/picker-harness.html?mode=multi&scope=library`);
ok(await a.ev(`!!document.querySelector('[data-testid=picker]')`), "A: the harness page renders the picker");
ok((await a.ev(`document.activeElement?.getAttribute('data-testid')`)) === "picker-q", "A: focus lands in the search box");
await a.typeText("vrm");
ok(await a.waitFor(`${keys}.length===8`), "A: typing 'vrm' lists the 8 shared results");
const upA0 = (await stubLog(STUB_A)).filter((r) => r.url.startsWith("/workbench/contract/search"));
ok(upA0.length === 1 && upA0[0].url === "/workbench/contract/search?q=vrm&limit=50" && upA0[0].keyOk, `A: exactly one search reached the upstream, with the door key: ${JSON.stringify(upA0.map((x) => x.url))}`);
// same results as the search for the same query (the Ctrl+K model): fetch the route directly through the same door, compare in order
const direct = await a.ev(`fetch('/workbench/contract/search?q=vrm&limit=50').then(r=>r.json()).then(j=>j.results.map(r=>r.kind+':'+r.id))`);
const shown = await a.ev(keys);
ok(JSON.stringify(direct) === JSON.stringify(shown), "A: unfiltered, the picker lists exactly what the search route returns, in its order");
const searchesBefore = (await stubLog(STUB_A)).filter((r) => r.url.startsWith("/workbench/contract/search")).length; // includes the direct fetch above
// kind filter with a live count, tray survives
const kindClaim = await a.ev(`(()=>{const b=[...document.querySelectorAll('[role=group][aria-label=Kind] button')].find(b=>/^claim/.test(b.textContent));return b?b.textContent:null})()`);
ok(/2$/.test(kindClaim || ""), `A: Kind option shows its live count (${kindClaim})`);
await a.ev(`document.querySelector('[data-key="source:s-alpha"]').click()`);
await a.ev(`document.querySelector('[data-key="claim:c-1"]').click()`);
await a.ev(`[...document.querySelectorAll('[role=group][aria-label=Kind] button')].find(b=>/^topic page/.test(b.textContent)).click()`);
await sleep(200);
ok(JSON.stringify(await a.ev(keys)) === JSON.stringify(["page:workstation-hardware", "page:cooling"]), "A: the kind filter narrows the list");
ok((await a.ev(`document.querySelector('[data-testid=picker-nsel]').textContent`)) === "Selected (2)", "A: the selected tray still holds both after the filter changed");
const upA1 = (await stubLog(STUB_A)).filter((r) => r.url.startsWith("/workbench/contract/search"));
ok(upA1.length === searchesBefore, "A: changing the kind filter, picking and the tray made no further request");
ok(JSON.stringify(await a.ev(`[...document.querySelectorAll('[data-testid=picker-tray] li')].map(e=>e.getAttribute('data-key'))`)) === JSON.stringify(["source:s-alpha", "claim:c-1"]), "A: tray rows are the two picked, in pick order");
// keyboard only
await a.ev(`[...document.querySelectorAll('button')].find(b=>/Clear all filters/.test(b.textContent)).click()`);
await a.ev(`document.querySelector('[data-testid=picker-q]').focus()`);
await a.key("ArrowDown"); await a.key("Enter"); // the 2nd row
await a.key("Enter", 2); // Ctrl+Enter confirms
await sleep(200);
const res = await a.ev(`document.querySelector('[data-testid=result]').textContent`);
ok(JSON.parse(res || "[]").length === 3 && JSON.parse(res).includes("source:s-beta"), `A: keyboard alone (Down, Enter, Ctrl+Enter) confirmed the selection: ${res}`);
ok(csp(a).length === 0, "A: no CSP violation or page exception");
ok(a.reqs().every((r) => r.url.startsWith(APP_A + "/")), "A: every browser request was same-origin");
await a.close();

// ---------------- identity A: private items, then B must not see them ----------------
const a2 = await session();
await a2.open(`${APP_A}/picker-harness.html?mode=multi&scope=mine&refinery=refinery-a`);
await a2.typeText("plan");
ok(await a2.waitFor(`${keys}.length===1`), "A: own-thoughts scope lists A's one thought");
ok((await a2.ev(`document.querySelector('[data-key="thought:t-A"] [data-testid=private-tag]')?.textContent`)) === "private", "A: A's thought carries the private tag");
await a2.ev(`document.querySelector('[data-key="thought:t-A"]').click()`);
// held source in A's own refinery (document scope)
await a2.open(`${APP_A}/picker-harness.html?mode=multi&scope=document&refinery=refinery-a`);
await a2.typeText("vrm");
ok(await a2.waitFor(`${keys}.includes('source:held-A')`), "A: A's own held source is offered inside A's own refinery scope, marked private");
ok((await a2.ev(`document.querySelector('[data-key="source:held-A"] [data-testid=private-tag]')?.textContent`)) === "private", "A: the held source shows the private tag");
const privA = await a2.ev(`[...document.querySelectorAll('[role=group][aria-label="Who can see it"] button')].map(b=>b.textContent)`);
ok(privA.some((t) => /Private to me.*1$/.test(t)), `A: private count is 1 (${JSON.stringify(privA)})`);
// storage after A's session
const store = async (s) => s.ev(`(async()=>({ls:Object.keys(localStorage),ss:Object.keys(sessionStorage),cookie:document.cookie,idb:(await indexedDB.databases()).length,caches:typeof caches==='undefined'?0:(await caches.keys()).length,html:document.documentElement.outerHTML.includes('A-SECRET')}))()`);
const stA = await store(a2);
ok(stA.ss.length === 0 && stA.cookie === "" && stA.idb === 0 && stA.caches === 0 && stA.ls.every((k) => k === "workbench.theme"), `A: nothing stored in the browser by the picker: ${JSON.stringify(stA)}`);
await a2.close();

const b = await session();
await b.open(`${APP_B}/picker-harness.html?mode=multi&scope=mine&refinery=refinery-a`);
await b.typeText("plan");
ok(await b.waitFor(`${keys}.length===1`), "B: own-thoughts scope lists B's one thought");
const bPage = await b.ev(`document.body.innerText`);
ok(!/A-SECRET/.test(bPage) && (await b.ev(keys)).join() === "thought:t-B", "B: A's private thought is not offered, listed or shown anywhere on B's page");
ok((await b.ev(`document.querySelector('[data-testid=picker-nsel]').textContent`)) === "Selected (0)", "B: B's tray starts empty (nothing carried over from A)");
// B asks inside A's refinery id: the route scopes nothing; no held source, no private count
await b.open(`${APP_B}/picker-harness.html?mode=multi&scope=document&refinery=refinery-a`);
await b.typeText("vrm");
ok(await b.waitFor(`${keys}.length===5`), "B: B's document scope (A's refinery id) lists only shared results (5 after the topic narrowing), no held source");
const bKeys = await b.ev(keys);
ok(!bKeys.includes("source:held-A") && !/HELD-A/.test(await b.ev(`document.body.innerText`)), "B: A's held source is not offered or shown");
ok((await b.ev(`document.querySelector('[role=group][aria-label="Who can see it"]')`)) === null, "B: no 'Who can see it' facet and so no private count at all (nothing private to count)");
const logB = JSON.stringify(await stubLog(STUB_B));
ok(!/A-SECRET|held-A/.test(logB), "B: B's upstream never saw A's private text or ids");
ok(await b.ev(`document.documentElement.outerHTML.indexOf('A-SECRET')`) === -1, "B: A's text is nowhere in B's DOM");
await b.close();


// ---------------- the contract's new hit fields: filters and sorts light up (identity A, then B's own cited_by) ----------------
const f = await session();
await f.open(`${APP_A}/picker-harness.html?mode=multi&scope=library`);
await f.typeText("vrm");
ok(await f.waitFor(`${keys}.length===8`), "fields: A's library search lists 8");
ok(await f.ev(`!document.querySelector('[data-testid=picker-missing]')`), "fields: no 'filters appear when the search returns them' note: the search returns them");
const groups = await f.ev(`[...document.querySelectorAll('[role=group]')].map(g=>g.getAttribute('aria-label'))`);
ok(["Topics (any of)", "When", "Quality"].every((g) => groups.includes(g)), `fields: Topics, When and Quality groups appear (${JSON.stringify(groups)})`);
const clickBtn = (label, group) => f.ev(`[...document.querySelectorAll('${group ? "[role=group][aria-label=\"" + group + "\"] " : ""}button')].find(b=>b.textContent.startsWith(${JSON.stringify(label)})).click()`);
await clickBtn("High only");
ok(JSON.stringify(await f.ev(keys)) === JSON.stringify(["source:s-alpha", "source:s-delta", "claim:c-1"].sort((a, b) => direct.indexOf(a) - direct.indexOf(b))), "fields: Quality 'High only' (0.8, 0.76 and 0.9 are at or over the 0.75 cut-off) keeps s-alpha, s-delta and c-1");
await clickBtn("Clear all filters");
await clickBtn("Last 30 days");
ok(JSON.stringify((await f.ev(keys)).sort()) === JSON.stringify(["claim:c-1", "page:cooling", "page:workstation-hardware", "source:s-alpha", "source:s-delta"]), "fields: 'Last 30 days' keeps the five recent rows");
await clickBtn("Clear all filters");
await clickBtn("airflow", "Topics (any of)");
ok(JSON.stringify(await f.ev(keys)) === JSON.stringify(["source:s-delta"]), "fields: Topics 'airflow' keeps s-delta");
await clickBtn("Clear all filters");
await clickBtn("Newest");
const newest = await f.ev(keys);
ok(newest[0] === "page:workstation-hardware" && newest.at(-1) === "source:s-gamma", `fields: sort Newest puts the 1-day-old page first and the 2024 source last (${newest[0]} ... ${newest.at(-1)})`);
ok((await f.ev(`document.querySelector('[data-key="source:s-alpha"]').textContent`)).includes("Ada Lovelace") && (await f.ev(`document.querySelector('[data-key="source:s-alpha"]').textContent`)).includes("in 1 of your documents"), "fields: A's row shows the author and 'in 1 of your documents'");
await clickBtn("Most cited");
ok((await f.ev(keys))[0] === "source:s-alpha", "fields: sort Most cited puts s-alpha first");
await f.close();
const fb = await session();
await fb.open(`${APP_B}/picker-harness.html?mode=multi&scope=library`);
await fb.typeText("vrm");
ok(await fb.waitFor(`${keys}.length===8`), "fields: B's library search lists 8");
ok((await fb.ev(`document.querySelector('[data-key="source:s-alpha"]').textContent`)).includes("in 2 of your documents"), "fields: B sees ITS OWN count (2), not A's (1) and not 3");
await fb.close();

// ---------------- accessibility: axe, light and dark ----------------
for (const theme of ["light", "dark"]) {
  const s = await session();
  await s.open(`${APP_A}/picker-harness.html?mode=multi&scope=mine&linked=1`);
  await s.ev(`localStorage.setItem('workbench.theme','${theme}')`);
  await s.open(`${APP_A}/picker-harness.html?mode=multi&scope=mine&linked=1`);
  await s.typeText("vrm");
  await s.waitFor(`${keys}.length>=8`);
  await s.ev(`document.querySelector('[data-key="source:s-alpha"]').click()`);
  await s.ev(`document.querySelector('[data-testid=picker-q]').focus()`);
  const bg = await s.ev(`getComputedStyle(document.body).backgroundColor`);
  ok(theme === "light" ? bg === "rgb(246, 245, 241)" : bg === "rgb(20, 24, 26)", `${theme}: the page is really in the ${theme} theme (${bg})`);
  await s.ev(AXE);
  const r = await s.ev(`axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}).then(r=>({v:r.violations.map(v=>({id:v.id,n:v.nodes.length,t:v.nodes.slice(0,3).map(n=>n.target.join(' '))})),passes:r.passes.length,cc:r.passes.some(p=>p.id==='color-contrast'),inc:r.incomplete.map(i=>i.id+':'+i.nodes.map(n=>n.target.join(' ')+' '+(n.any[0]&&n.any[0].message||'')).join('|'))}))`);
  ok(r.v.length === 0, `${theme}: axe WCAG 2.1 A/AA violations: ${JSON.stringify(r.v)} (rules passed: ${r.passes}, colour-contrast evaluated: ${r.cc}, incomplete: ${JSON.stringify(r.inc)})`);
  await s.close();
}

console.log(fails ? `PICKER LAB FAIL (${fails})` : "PICKER LAB PASS");
process.exit(fails ? 1 : 0);
void LAB_KEY;
