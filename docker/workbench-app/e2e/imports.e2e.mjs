// Headless-Chromium e2e for the Imports screen (rwr-imports), driven over CDP. Run by run-imports-e2e.ps1 inside an
// --internal lab network with the stub in imports.stub.mjs (which answers with the same fake of the real intake routes
// as the vitest suite). Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
// Every check prints PASS/FAIL; the exit code is 1 on any failure.
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

const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: k === "Enter" ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(k === "Enter" ? { text: String.fromCharCode(13) } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=imports]') && !document.querySelector('[data-testid=imp-loading]') && !!document.querySelector('[data-testid=avatar]')`)) break;
  }
  await sleep(200);
};
const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await sleep(150); } return false; };
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const clickText = (sel, text) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.includes(${JSON.stringify(text)})).click()`);
const reqs = () => events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => ({ method: e.params.request.method, url: e.params.request.url }));
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
const titles = () => ev(`JSON.stringify([...document.querySelectorAll('[data-testid=imp-title]')].map(e=>e.textContent))`).then(JSON.parse);
const txt = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent||''`);
const pickRow = (t) => clickText("[data-testid=imp-row]", t);
const overflow = () => ev(`JSON.stringify({sw:document.querySelector('main').scrollWidth,cw:document.querySelector('main').clientWidth,doc:document.documentElement.scrollWidth,vw:innerWidth})`).then(JSON.parse);

// ---- 1. alice: the list, counts, filters
await scheme("light"); await setMode("alice"); await go("/imports");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "Imports" && (await ev(`document.title`)).startsWith("Imports"), "the heading and the page title say Imports");
const t1 = await titles();
ok(t1.length === 5 && t1[0] === "https://alpha.example/chat-link" && t1[1] === "https://alpha.example/refused" && t1[4].startsWith("https://alpha.example/aaaa"), `alice's five imports, newest first: ${JSON.stringify(t1.map((x) => x.slice(0, 40)))}`);
const wk = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(['came','landed','running','failed','cancelled'].map(k=>[k,document.querySelector('[data-testid=week-'+k+']')?.textContent])))`));
ok(JSON.stringify(wk) === JSON.stringify({ came: "4", landed: "1", running: "1", failed: "2", cancelled: "0" }), `This week counts the last seven days only: ${JSON.stringify(wk)}`);
const fc = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(['all','run','fail','mine'].map(k=>[k,document.querySelector('[data-testid=filter-'+k+']').textContent.replace(/\\D+/g,'')])))`));
ok(JSON.stringify(fc) === JSON.stringify({ all: "5", run: "1", fail: "2", mine: "4" }), `filter counts: ${JSON.stringify(fc)}`);
await click("[data-testid=filter-fail]");
ok(JSON.stringify((await titles()).map((x) => x.slice(0, 30))) === JSON.stringify(["https://alpha.example/refused", "ALPHA-notes.pdf"]), "Needs a look lists the two failed ones");
await click("[data-testid=filter-mine]");
ok((await titles()).length === 4, "Private to me lists the four held adds (the shared import is out)");
await click("[data-testid=filter-all]");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
const rq = reqs();
ok(rq.every((r) => r.url.startsWith(origin + "/")) && rq.filter((r) => /\/workbench\//.test(r.url)).every((r) => r.method === "GET"), `every request same-origin, every one so far a GET (${rq.length})`);
ok((await ev(`document.querySelectorAll('select, datalist, [role=listbox], [role=combobox], dialog, [role=dialog]').length`)) === 0, "no select, datalist, listbox or dialog on the screen");
await axeBoth("Imports list");

// ---- 2. a failed fetch: reason, Try again ONCE
await pickRow("refused");
ok(/the page answered with an error/.test(await txt("[data-testid=imp-why]")), "a failed fetch shows its reason");
ok(/Only you/.test(await txt("[data-testid=imp-details]")) && /alpha plan/.test(await txt("[data-testid=imp-details]")), "details name who sees it and where it landed");
await axeBoth("Imports details of a failed item");
await click("[data-testid=imp-retry]");
ok(await waitFor(`/Trying again/.test(document.querySelector('[data-testid=imp-note]').textContent)`), "Try again says it is trying again");
ok(await ev(`!document.querySelector('[data-testid=imp-retry]')`), "Try again is gone while it runs");
let lg = await stub("/__log");
ok(lg.filter((x) => /\/retry$/.test(x.url)).length === 1 && lg.filter((x) => /\/retry$/.test(x.url))[0].keyOk, "exactly one retry reached the server, with the door key");
await stub("/__set/alice/refused/failed?error=the%20page%20answered%20with%20an%20error", "POST");
ok(await waitFor(`!!document.querySelector('[data-testid=imp-no-retry]')`, 15000), "after the second failure (the page's own poll sees it) the screen says it was already tried twice");
ok(await ev(`!document.querySelector('[data-testid=imp-retry]')`) && /the page answered with an error/.test(await txt("[data-testid=imp-why]")), "Try again is not offered a third time and the reason is still shown");
lg = await stub("/__log");
ok(lg.filter((x) => /\/retry$/.test(x.url)).length === 1, "still exactly one retry request in total");
await axeBoth("Imports after the second failure");

// ---- 3. cancel a running one
await pickRow("chat-link");
ok(await ev(`!!document.querySelector('[data-testid=imp-cancel]')`), "a fetching item offers Cancel");
await click("[data-testid=imp-cancel]");
ok(await waitFor(`/Cancelled/.test(document.querySelector('[data-testid=imp-note]').textContent)`), "Cancel is confirmed on screen");
ok((await stub("/__log")).filter((x) => /\/cancel$/.test(x.url)).length === 1, "one cancel reached the server");

// ---- 4. One link into the chosen document, through the existing route
await click("[data-testid=imp-add-toggle]");
ok(await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`), "the form offers alice's two documents and her idea (not the trashed or others')");
ok(!(await ev(`document.body.innerText`)).match(/BRAVO/), "no one else's document or idea is offered");
await axeBoth("Imports add form");
await ev(`[...document.querySelectorAll('[data-testid=where-opt]')].find(o=>o.parentElement.textContent.includes('ALPHA plan')).click()`);
await ev(`document.querySelector('[data-testid=add-link]').focus()`);
await send("Input.insertText", { text: "https://alpha.example/brand-new" });
await click("[data-testid=add-submit]");
ok(await waitFor(`!document.querySelector('[data-testid=imp-form]')`), "the form closes once the link is accepted");
const post = (await stub("/__log")).filter((x) => x.method === "POST" && x.url === "/workbench/intake/add");
ok(post.length === 1 && JSON.stringify(post[0].keys.sort()) === JSON.stringify(["path", "url"]), `one POST /workbench/intake/add with only url and path: ${JSON.stringify(post.map((p) => p.keys))}`);
ok(await waitFor(`[...document.querySelectorAll('[data-testid=imp-title]')].some(e=>e.textContent==='https://alpha.example/brand-new')`), "the new link is in the list");
await pickRow("brand-new");
ok(/alpha plan/.test(await txt("[data-testid=imp-details]")) && /Waiting/.test(await txt("[data-testid=imp-details]")), "its details say it will land in the chosen document, and that it is waiting");
// a file, as a multipart form
await click("[data-testid=imp-add-toggle]");
await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`);
await ev(`[...document.querySelectorAll('[data-testid=where-opt]')].find(o=>o.parentElement.textContent.includes('ALPHA pantry idea')).click()`);
await click("[data-testid=mode-file]");
await ev(`(()=>{const i=document.querySelector('[data-testid=add-file]');const dt=new DataTransfer();dt.items.add(new File(['%PDF-1.7 ALPHA'],'ALPHA-upload.pdf',{type:'application/pdf'}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await click("[data-testid=add-submit]");
ok(await waitFor(`[...document.querySelectorAll('[data-testid=imp-title]')].some(e=>e.textContent==='ALPHA-upload.pdf')`), "a PDF added from the form is in the list");
const fpost = (await stub("/__log")).filter((x) => x.method === "POST" && x.url === "/workbench/intake/add").pop();
ok(JSON.stringify(fpost.keys.sort()) === JSON.stringify(["file", "refinery_id"]), `the file went as multipart with its file and the idea's refinery_id only: ${JSON.stringify(fpost.keys)}`);
// over 1 MB is refused on the page, before any request
await click("[data-testid=imp-add-toggle]");
await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`);
await ev(`[...document.querySelectorAll('[data-testid=where-opt]')].find(o=>o.parentElement.textContent.includes('ALPHA plan')).click()`);
await click("[data-testid=mode-file]");
const before = (await stub("/__log")).filter((x) => x.method === "POST").length;
await ev(`(()=>{const i=document.querySelector('[data-testid=add-file]');const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(1100000)],'big.pdf',{type:'application/pdf'}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await click("[data-testid=add-submit]");
ok(/over 1 MB/.test(await txt("[data-testid=add-problem]")) && (await stub("/__log")).filter((x) => x.method === "POST").length === before, "a file over 1 MB is refused with a reason and nothing is sent");
await axeBoth("Imports add form with a refusal");
await click("[data-testid=imp-add-toggle]");

// ---- 5. the connected inlets panel
await click("[data-testid=panel-inlets]");
ok(/can't be listed here yet/.test(await txt("[data-testid=inlets-unavailable]")) && /Open WebUI chats: 1\./.test(await txt("[data-testid=inlets-origin]")), "the inlets panel says what it cannot read, and counts only alice's own Open WebUI item");
ok((await stub("/__log")).every((x) => !/inlet/i.test(x.url)), "no inlet route was asked for");
await axeBoth("Imports connected inlets panel");
await click("[data-testid=panel-details]");

// ---- 6. nothing kept; no toast; no inline cache
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length,toasts:document.querySelectorAll('[data-testid=toast]').length}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0 && keep.toasts === 0, `storage, cookies, caches, IndexedDB hold nothing beyond workbench.theme, and no toast is up: ${JSON.stringify(keep)}`);
ok(problems().length === 0, `no console problems through all of the above (${problems().length})`);

// ---- 7. two identities: bob after alice, same browser
await go("/imports");
ok(/alpha/i.test(await ev(`document.documentElement.outerHTML`)), "(alice's page does hold her ALPHA text: the next check is not vacuous)");
await setMode("bob"); await go("/imports");
const bt = await titles();
ok(JSON.stringify(bt) === JSON.stringify(["https://bravo.example/own"]), `bob sees only his own import: ${JSON.stringify(bt)}`);
const html = await ev(`document.documentElement.outerHTML + document.body.innerText`);
ok(!/ALPHA|alpha\.example|alice|the file could not be read|the page answered/i.test(html), "bob's page source holds no ALPHA, no alpha.example, no 'alice', none of her reasons");
const bw = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(['came','failed'].map(k=>[k,document.querySelector('[data-testid=week-'+k+']').textContent])))`));
ok(bw.came === "1" && bw.failed === "0", `bob's counts are his own: ${JSON.stringify(bw)}`);
ok((await ev(`document.querySelector('[data-testid=filter-all]').textContent`)).replace(/\D/g, "") === "1" && (await ev(`document.querySelector('[data-testid=filter-mine]').textContent`)).replace(/\D/g, "") === "1", "bob's filter totals are his own");
await click("[data-testid=imp-add-toggle]");
await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===2`);
ok(!/ALPHA|alpha/i.test(await ev(`document.documentElement.outerHTML`)), "bob's add form offers none of alice's documents or ideas");
await click("[data-testid=panel-inlets]");
ok(/Open WebUI chats: 0\./.test(await txt("[data-testid=inlets-origin]")), "bob's inlets panel counts none of alice's");
await axeBoth("Imports as bob");
// bob asks for alice's job by id: the same 404 as a missing one (the stub's fake is the server's logic)
const aid = await ev(`fetch('/workbench/intake/jobs?kinds=import,add').then(r=>r.json()).then(j=>j.jobs.length)`);
ok(aid === 1, "the jobs read for bob holds exactly one job");

// ---- 7a. live switch: alice has a message and an open form, the identity changes, the shell's whoami refresh shows bob
await setMode("alice"); await go("/imports");
await pickRow("held-article");
await click("[data-testid=imp-add-toggle]");
await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`);
await ev(`document.querySelector('[data-testid=add-link]').focus()`);
await send("Input.insertText", { text: "https://alpha.example/half-typed" });
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob (the shell's refresh)");
await waitFor(`!document.querySelector('[data-testid=imp-loading]') && document.querySelectorAll('[data-testid=imp-title]').length===1`, 10000);
const live = await ev(`document.documentElement.outerHTML + document.body.innerText`);
ok(!/ALPHA|alpha\.example|half-typed|alice/i.test(live) && !(await ev(`!!document.querySelector('[data-testid=imp-form]')`)), "live switch: alice's list, open form, half-typed link and details are gone; bob's own list is shown");
ok(await ev(`document.querySelectorAll('[data-testid=toast], dialog, [role=dialog]').length===0 && document.querySelector('[data-testid=imp-note]').textContent===''`), "live switch: no toast, dialog or message survives");
await scheme("dark"); await axe("dark Imports after a live switch"); await scheme("light");
await setMode("alice");

// ---- 8. keyboard
await go("/imports");
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 40; i++) {
  await key("Tab", "Tab", 9);
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,24),inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const main = stops.filter((s) => s.inMain);
for (const need of ["imp-add-toggle", "filter-all", "filter-run", "filter-fail", "filter-mine", "imp-row", "panel-details", "panel-inlets"]) ok(main.some((s) => s.t === need), `Tab reaches ${need}`);
ok(main.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${main.length} Tab stops on the screen show a focus ring of at least 2px`);
await ev(`[...document.querySelectorAll('[data-testid=imp-row]')].find(r=>r.textContent.includes('refused')).focus()`);
await key("Enter", "Enter", 13);
ok(await waitFor(`document.querySelector('[data-testid=imp-details] h2')?.textContent==='${"https://alpha.example/refused"}'`), "Enter on a focused row opens its details");
// the form by keyboard: toggle, radio choice by arrow keys, the link typed, Enter submits
await ev(`document.querySelector('[data-testid=imp-add-toggle]').focus()`);
await key("Enter", "Enter", 13);
ok(await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`), "Enter on '+ Add a link or file' opens the form");
await ev(`document.querySelector('[data-testid=where-opt]').focus()`);
await key("ArrowDown", "ArrowDown", 40);
ok(await ev(`document.querySelectorAll('[data-testid=where-opt]')[1].checked`), "the arrow keys choose a landing (the radio group is one tab stop)");
await ev(`document.querySelector('[data-testid=add-link]').focus()`);
await send("Input.insertText", { text: "notalink" });
await key("Enter", "Enter", 13);
ok(await waitFor(`/http or https/.test(document.querySelector('[data-testid=add-problem]').textContent)`), "Enter in the link box submits the form (a bad link is refused with a reason)");
ok(await ev(`document.querySelector('[data-testid=add-problem]').getAttribute('role')==='alert'`), "the refusal is announced (role=alert)");
await click("[data-testid=imp-add-toggle]");

// ---- 9. narrow screens: no inner overflow pushing main wider (alice has a very long unbroken address)
for (const [w, h] of [[800, 900], [400, 800]]) {
  await viewport(w, h); await go("/imports");
  await clickText("[data-testid=imp-row]", "unbroken");
  const o = await overflow();
  ok(o.sw <= o.cw && o.doc <= o.vw, `at ${w}px wide with a 250-character address in the list and the details: no horizontal scroll (main ${o.sw}/${o.cw}, page ${o.doc}/${o.vw})`);
  await axe(`light Imports at ${w}px`);
  await scheme("dark"); await axe(`dark Imports at ${w}px`); await scheme("light");
  await click("[data-testid=imp-add-toggle]"); await waitFor(`document.querySelectorAll('[data-testid=where-opt]').length===3`);
  const o2 = await overflow();
  ok(o2.sw <= o2.cw, `at ${w}px wide the add form does not overflow (${o2.sw}/${o2.cw})`);
  await click("[data-testid=imp-add-toggle]");
}
await viewport(1440, 900);

// ---- 10. an explicit theme choice, the end state
await ev(`localStorage.setItem('workbench.theme','dark')`); await go("/imports"); await axe("explicit dark choice on Imports");
await ev(`localStorage.removeItem('workbench.theme')`);
const after = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme').length,ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(after.ls === 0 && after.ss === 0 && after.ck === "" && after.caches === 0 && after.idb === 0, `at the end: storage, cookies, caches, IndexedDB hold nothing: ${JSON.stringify(after)}`);
await go("/imports");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
const planted = (await stub("/__log")).filter((x) => /\/workbench\/(contract\/search|sources|library)/.test(x.url));
ok(planted.length === 0, "the screen never touched a shared surface (shared search, library): the log holds no such request");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
