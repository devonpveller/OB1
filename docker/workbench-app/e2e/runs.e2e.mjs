// Headless-Chromium e2e for the Research screen (rwr-research-runs), driven over CDP. Run by run-runs-e2e.ps1 inside an --internal
// lab network with the stub in runs.stub.mjs (the fake back end of the real routes' rules). Env: APP_IP, CH (Chrome host), LAB_KEY.
// /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map(); const events = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
await send("Network.setCacheDisabled", { cacheDisabled: false });
const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
await viewport(1440, 900);

const stub = async (p, method = "GET", body) => (await fetch(`http://stub:9000${p}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0, text) => {
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const tab = (shift = false) => key("Tab", "Tab", 9, shift ? 8 : 0);
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=runs-list]') && !!document.querySelector('[data-testid=avatar]')`)) break;
  }
  await sleep(200);
};
const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && ((e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
  || e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))));
const AXE = readFileSync("/axe/axe.min.js", "utf8");
async function axe(label) {
  await ev(AXE + ";1");
  const r = await ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,160)).slice(0,4)})),pass:r.passes.length,cc:(r.passes.find(p=>p.id==='color-contrast')||{nodes:[]}).nodes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed, ${r.cc} elements checked for contrast)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
}
const axeBoth = async (label) => { for (const s of ["light", "dark"]) { await scheme(s); await axe(`${s} ${label}`); } await scheme("light"); };
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const setValue = async (sel, s) => { await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.select();})()`); await send("Input.insertText", { text: s }); };
const waitFor = async (cond, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await ev(cond)) return true; await sleep(100); } return false; };
const ids = await stub("/__ids");
const heads = () => ev(`JSON.stringify([...document.querySelectorAll('[data-testid=group-header]')].map(h=>h.firstChild.textContent.trim()))`).then(JSON.parse);
const overflow = (root) => ev(`JSON.stringify((()=>{const m=document.querySelector('main');
  const inner=[...document.querySelectorAll(${JSON.stringify(root)}+' *')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible').map(e=>e.dataset.testid||e.className||e.tagName).slice(0,6);
  const wide=[...document.querySelectorAll(${JSON.stringify(root)}+' *')].filter(e=>{const r=e.getBoundingClientRect();return r.right>window.innerWidth+1||r.left<-1}).map(e=>e.dataset.testid||e.tagName).slice(0,6);
  return {msw:m.scrollWidth,mcw:m.clientWidth,bsw:document.documentElement.scrollWidth,iw:window.innerWidth,inner,wide}})())`).then(JSON.parse);

// ---- 1. the list: counts, groupings, axe
await scheme("light"); await setMode("alice");
await go("/research");
ok((await text("h1")) === "Research", "the heading is Research");
ok((await ev(`document.title`)) === "Research - Research workbench", "the page title is the screen's, naming no run");
ok((await count("[data-testid=run-row]")) === 4, "alice sees her four runs");
const cn = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(['running','queued','done','stopped','archived'].map(k=>[k,document.querySelector('[data-testid=count-n-'+k+']').textContent])))`));
ok(JSON.stringify(cn) === JSON.stringify({ running: "1", queued: "1", done: "1", stopped: "1", archived: "0" }), `the state counts: ${JSON.stringify(cn)}`);
ok(JSON.stringify(await heads()) === JSON.stringify(["Today", "Earlier"]), "grouped by date: Today, Earlier");
await click("[data-testid=by-document]");
ok(JSON.stringify(await heads()) === JSON.stringify(["alpha sensors note", "Not attached to a document"]), "grouped by document");
await click("[data-testid=by-topic]");
ok(JSON.stringify(await heads()) === JSON.stringify(["power", "sensors", "No topic"]), "grouped by topic");
await click("[data-testid=by-date]");
await axeBoth("Research list");

// ---- 2. a finished run: the tree, the node details, no private claim, the Discussion tab
await ev(`[...document.querySelectorAll('[data-testid=run-row]')].find(r=>/two sensors/.test(r.textContent)).click()`);
ok(await waitFor(`!!document.querySelector('[data-testid=run]')`), "opening a run shows its tree");
ok((await ev(`location.search`)) === "?run=" + ids.done, "the address holds the run's id only");
ok((await count("[data-testid=tree-node]")) === 3, "the tree has the question, a steer and a gap pass");
ok(/Steer or follow-up/.test(await ev(`document.querySelector('[data-testid=tree]').textContent`)) && /Gap pass/.test(await ev(`document.querySelector('[data-testid=tree]').textContent`)), "the branches are named");
ok(/Page A/.test(await text("[data-testid=sources]")) && (await text("[data-testid=claim-count]")) === "2", "node details: the sources, and two claims (the claim drawn from a private report is neither shown nor counted)");
ok(!(await ev(`document.body.innerText`)).includes("PRIVATE-CLAIM"), "no private-report claim anywhere on the page");
await click("[data-testid=tab-discussion]");
ok(/Nothing here yet/.test(await text("[data-testid=discussion-empty]")), "the Discussion tab is empty and says so");
await click("[data-testid=tab-tree]");
await axeBoth("Research run (finished)");

// ---- 3. a running tree updates with no reload
await go("/research?run=" + ids.live);
await ev(`window.__noReload = 'still-here'`);
ok(await waitFor(`!!document.querySelector('[data-testid=run]')`), "the running run opens");
ok((await count("[data-testid=tree-node]")) === 1 && /Running/.test(await text("[data-testid=run-live]")), "it starts as one node, running");
await sleep(600);
await stub(`/__grow/${ids.live}`, "POST", { kind: "gap", status: "running", query: "ALPHA a gap pass the server just added" });
ok(await waitFor(`document.querySelectorAll('[data-testid=tree-node]').length===2`, 6000), "a node the server adds appears with NO reload");
ok((await ev(`window.__noReload`)) === "still-here", "the page was not reloaded (a marker on window survived)");
ok(/a gap pass the server just added/.test(await text("[data-testid=tree]")), "the new node carries its question");

// ---- 4. steer, follow-up, stop
await click("[data-testid=act-steer]");
await setValue("[data-testid=steer-text]", "ALPHA look at idle power");
ok((await ev(`document.querySelector('[data-testid=steer-send]').disabled`)) === false, "Steer can be sent once there are words");
await click("[data-testid=steer-send]");
ok(await waitFor(`document.querySelectorAll('[data-testid=tree-node]').length===3`, 6000), "Steer creates a child branch that shows in the tree");
ok(/queued/.test(await ev(`[...document.querySelectorAll('[data-testid=tree-node]')].map(n=>n.textContent).join('|')`)), "the new branch is queued, then runs");
ok(!/ALPHA/.test(await text("[data-testid=toasts]")), "the toast names no question");
await click("[data-testid=act-followup]");
await setValue("[data-testid=steer-text]", "ALPHA and what about heat?");
await click("[data-testid=steer-send]");
ok(await waitFor(`document.querySelectorAll('[data-testid=tree-node]').length===4`, 6000), "Add a follow-up adds another branch");
const steers = (await stub("/__log")).filter((x) => /\/steer$/.test(x.url) && x.method === "POST");
ok(steers.length === 2 && steers.every((s) => s.keyOk && s.body.step_id === "step-7" && typeof s.body.text === "string"), "both went to the steer route at the run's next steering point");
await click("[data-testid=act-stop]");
ok(await has("[data-testid=stop-confirm]"), "Stop asks first");
await axeBoth("Research run with the stop confirmation open");
await click("[data-testid=stop-ok]");
ok(await waitFor(`document.querySelector('[data-testid=run-state]').textContent==='stopped'`, 6000), "the run is stopped");

// ---- 5. archive, undo, the report as a document
await go("/research?run=" + ids.done);
await waitFor(`!!document.querySelector('[data-testid=run]')`);
await click("[data-testid=act-archive]");
ok(await waitFor(`document.querySelector('[data-testid=count-n-archived]').textContent==='1'`), "Archive: the run is counted as archived");
ok((await count("[data-testid=run-row]")) === 3 && !/two sensors/.test(await text("[data-testid=runs-list]")), "...and it left the list");
ok(!/ALPHA|sensors/.test(await text("[data-testid=toasts]")), "the toast names no title");
let st = await stub("/__state");
ok(st.archived.find((r) => r.id === ids.done).by.join() === "u-alice", "the archive mark is alice's own: nothing else moved");
await click("[data-testid=toast-undo]");
ok(await waitFor(`document.querySelector('[data-testid=count-n-archived]').textContent==='0'`), "Undo brings the run back");
await click("[data-testid=act-report]");
ok(await waitFor(`/^\\/documents\\/d\\//.test(location.pathname)`, 8000), "Open the report as a document opens a document of the caller's own");
st = await stub("/__state");
ok(st.docs.length === 1 && st.docs[0].owner === "u-alice" && st.docs[0].body === "ALPHA-REPORT-TEXT", "the document is alice's and holds the report");

// ---- 6. two identities: bob never sees alice's runs, in a field, a count or a total; a live switch drops everything
await go("/research?run=" + ids.live);
await waitFor(`!!document.querySelector('[data-testid=run]')`);
await click("[data-testid=act-steer]");
await setValue("[data-testid=steer-text]", "ALPHA half-written words");
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob");
await sleep(1000);
ok(!(await has("[data-testid=steer-form]")) && !(await has("[data-testid=stop-confirm]")), "live switch: the draft and the confirm are gone");
ok(!/ALPHA|half-written|alice/i.test(await ev(`document.body.innerText`)), "live switch: no ALPHA text, no draft, no 'alice' anywhere");
ok((await text("[data-testid=run-gone]")) === "That run is not available.", "alice's run id in the address is the one sentence of a missing run");
ok((await count("[data-testid=run-row]")) === 1 && (await text("[data-testid=count-n-done]")) === "1" && (await text("[data-testid=count-n-running]")) === "0" && (await text("[data-testid=count-n-archived]")) === "0", "bob's list and counts are bob's own");
for (const g of ["document", "topic", "date"]) { await click(`[data-testid=by-${g}]`); ok(!/ALPHA|sensors|power/.test(await text("[data-testid=runs-list]")), `bob grouped by ${g}: no header or row of alice's`); }
ok(!/ALPHA/.test(await ev(`document.documentElement.outerHTML`)), "bob's page source holds no ALPHA text at all");
ok(!/ALPHA/.test(await text("[data-testid=toasts]")), "no toast of alice's is on bob's screen");
await axeBoth("Research as bob after a live switch");
const bobReads = (await stub("/__log")).filter((x) => x.mode === "bob" && /research\/runs/.test(x.url));
ok(bobReads.length >= 2 && bobReads.every((x) => x.keyOk), "bob's reads went through the app's server with the door key");
await setMode("alice");

// ---- 7. keyboard: the tabs and every control reachable with a visible focus ring
await go("/research?run=" + ids.done);
await waitFor(`!!document.querySelector('[data-testid=run]')`);
await ev(`document.querySelector('[data-testid=tab-tree]').focus()`);
await key("ArrowRight", "ArrowRight", 39);
ok((await ev(`document.querySelector('[data-testid=tab-discussion]').getAttribute('aria-selected')`)) === "true" && (await ev(`document.activeElement.dataset.testid`)) === "tab-discussion", "ArrowRight moves to the Discussion tab and focuses it");
await key("ArrowLeft", "ArrowLeft", 37);
ok((await ev(`document.querySelector('[data-testid=tab-tree]').getAttribute('aria-selected')`)) === "true", "ArrowLeft moves back to the Tree tab");
await ev(`document.querySelector('[data-testid=start-research]').focus()`);
const stops = [];
for (let i = 0; i < 40; i++) {
  await tab();
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,24),inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const main = stops.filter((s) => s.inMain);
ok(main.length > 5 && main.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${main.length} Tab stops on the screen show a focus ring of at least 2px`);
for (const need of ["count-running", "by-date", "run-row", "act-archive", "act-report", "tab-tree", "tree-node"]) ok(main.some((s) => s.t === need), `Tab reaches ${need}`);

// ---- 8. 400 px: nothing inside main overflows (the long address, the long claim token, the deep tree)
await go("/research?run=" + ids.done);
await waitFor(`!!document.querySelector('[data-testid=run]')`);
for (const w of [800, 400]) {
  await viewport(w, 800); await sleep(300);
  const o = await overflow("[data-testid=research]");
  ok(o.msw <= o.mcw && o.bsw <= o.iw && o.wide.length === 0, `at ${w}px: no sideways push: main ${o.msw}/${o.mcw}, page ${o.bsw}/${o.iw}, outside the viewport: ${JSON.stringify(o.wide)}`);
  ok(o.inner.length === 0, `at ${w}px: no element inside Research overflows its own box: ${JSON.stringify(o.inner)}`);
}
const small = await ev(`[...document.querySelectorAll('[data-testid=research] button')].filter(b=>{const r=b.getBoundingClientRect();return r.height<24||r.width<24}).length`);
ok(small === 0, `at 400px every button is at least 24x24 CSS px (${small} smaller)`);
await axeBoth("Research at 400px");
await viewport(1440, 900);

// ---- 9. quality: no console problems, nothing kept in the browser, nothing from the cache
ok(problems().length === 0, `no console errors/warnings/exceptions on the run screen (${problems().length})` + JSON.stringify(problems().map((e) => (e.params?.entry?.text || e.params?.exceptionDetails?.text) + " " + (e.params?.entry?.url || ""))));
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0, `storage, cookies, caches and IndexedDB hold nothing beyond workbench.theme: ${JSON.stringify(keep)}`);
ok((await ev(`document.querySelectorAll('select, datalist').length`)) === 0, "no <select> or <datalist> on the screen");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
const all = await stub("/__log");
ok(all.every((x) => x.keyOk) && all.every((x) => /^\/workbench\//.test(x.url)), "every request was a /workbench/ route that carried the door key");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
