// Headless-Chromium e2e for the Coverage tab (rwr-doc-coverage), driven over CDP. Run by run-coverage-e2e.ps1 inside an
// --internal lab network with the stub in coverage.stub.mjs (the documents back end is docs-fake.mjs, which copies the
// server's file / history / research / reference routes). Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is
// axe-core. Every check prints PASS/FAIL; exit 1 on any failure.
// "A second tab" is the driver writing the same file straight at the stub (the same route and the same if_match rule).
import { readFileSync } from "node:fs";
import { uid } from "./docs-fake.mjs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map(); const events = [];
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); return; }
  events.push(d);
  // the page warns before it is closed or reloaded with text that was not written (beforeunload): the driver says yes
  if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
await send("Network.setCacheDisabled", { cacheDisabled: false });
const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
await viewport(1440, 900);

const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, End: 35, Home: 36, a: 65, s: 83, r: 82 };
const key = async (k, modifiers = 0, commands) => {
  const vk = KEYS[k] ?? k.toUpperCase().charCodeAt(0);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k.length === 1 ? "Key" + k.toUpperCase() : k, windowsVirtualKeyCode: vk, modifiers, ...(commands ? { commands } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k.length === 1 ? "Key" + k.toUpperCase() : k, windowsVirtualKeyCode: vk, modifiers });
};
const CTRL = 2, ALT = 1, SHIFT = 8;
const until = async (x, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(x)) return true; await sleep(150); } return false; };
const settled = `!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && document.querySelectorAll('main [role=status]').length===0`;
const go = async (path) => { events.length = 0; await send("Page.navigate", { url: origin + path }); await until(settled); await sleep(200); };
const reload = async () => { events.length = 0; await send("Page.reload", { ignoreCache: false }); await sleep(300); await until(settled); await sleep(200); };
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
const mouse = async (sel) => {
  const r = JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()`) || "null");
  if (!r) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  return true;
};
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
const db = () => stub("/__db");
// a document's address is its opaque id (the fake keeps it through every move: the SEEDED path names it)
const H = (p) => "/documents/d/" + uid(p);
const CPU = "documents/k-a/Hardware/cpu.md";
const SEL_TEXT = `(document.querySelector('[data-testid=doc-editor] .cm-content')?.innerText||'')`;
const version = () => ev(`document.querySelector('[data-testid=doc-version]')?.textContent||''`);
const typeIn = async (text) => { await ev(`document.querySelector('[data-testid=doc-editor] .cm-content').focus()`); await send("Input.insertText", { text }); await sleep(120); };
const typeAtEnd = async (text) => { await ev(`(()=>{const c=document.querySelector('[data-testid=doc-editor] .cm-content'); c.focus(); const s=getSelection(); s.selectAllChildren(c); s.collapseToEnd();})()`); await sleep(60); await typeIn(text); };
const fileOf = async (p = CPU) => (await (await fetch(`http://stub:9000/workbench/documents/file?path=${encodeURIComponent(p)}`)).json());
const putOther = async (p, content, ifMatch) => (await fetch(`http://stub:9000/workbench/documents/file?path=${encodeURIComponent(p)}&commit=1`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, if_match: ifMatch }) })).status;
const REF_A = "a1000000-0000-4000-8000-0000000000a1";
const openDoc = async (p = CPU) => { await go(H(p)); return until(`!!document.querySelector('[data-testid=doc-editor] .cm-content') && /^v\\d/.test(document.querySelector('[data-testid=doc-version]')?.textContent||'')`); };

const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const typeInto = async (sel, s) => { await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await send("Input.insertText", { text: s }); };
const axeBoth = async (label) => { for (const s of ["light", "dark"]) { await scheme(s); await axe(`${s} ${label}`); } await scheme("light"); };
const asApp = async (path, method = "GET", body) => ev(`fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)}, headers:${body ? '{"content-type":"application/json"}' : "{}"}, body:${body ? JSON.stringify(JSON.stringify(body)) : "undefined"}, cache:"no-store"}).then(async r=>({status:r.status, body: await r.text()}))`);
const MARK = "PRIVATE-GAP-MARKER-7731";
const BRAVO = "documents/k-b/bravo.md";
const tab = () => text("[data-testid=dtab-coverage]");
const items = (id) => ev(`[...document.querySelectorAll('[data-testid=${id}] > li')].map(l=>l.innerText)`);
const gapReqs = async (mode, pred = () => true) => (await stub("/__log")).filter((x) => x.mode === mode && x.url.startsWith("/workbench/contract/gaps") && pred(x));
const overflowing = () => ev(`(()=>{const m=document.querySelector('main'); const bad=[]; for(const e of m.querySelectorAll('*')){ if(e.closest('.cm-editor')) continue; const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') continue; if(e.scrollWidth>e.clientWidth+1) bad.push(e.tagName+'.'+String(e.className).slice(0,40)+' '+e.scrollWidth+'>'+e.clientWidth); } if(m.scrollWidth>m.clientWidth+1) bad.push('main '+m.scrollWidth+'>'+m.clientWidth); if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1) bad.push('page '+document.documentElement.scrollWidth+'>'+document.documentElement.clientWidth); return bad.slice(0,8)})()`);
const openCov = async (p = CPU) => { const o = await openDoc(p); await click("[data-testid=dtab-coverage]"); return o && await until(`!!document.querySelector('[data-testid=cov-box]')`); };
const gapId = (needle) => ev(`(()=>{const l=[...document.querySelectorAll('[data-testid^=gap-]')].find(e=>/^gap-[0-9a-f-]{36}$/.test(e.dataset.testid)&&e.innerText.includes(${JSON.stringify(needle)})); return l?l.dataset.testid.slice(4):null})()`);

await stub("/__reset", "POST");
await scheme("light");
await setMode("alice");

// ---- 1. the tab: the count of open gaps, your gaps, and what research found (never added by itself)
ok(await openDoc(), "alice's document opens");
const tabN = (n) => until(`document.querySelector('[data-testid=dtab-coverage]').textContent===${JSON.stringify("Coverage " + n)}`);
ok(await tabN(2), `the tab says how many gaps are open: "${await tab()}"`);
await click("[data-testid=dtab-coverage]");
ok(await until(`!!document.querySelector('[data-testid=cov-box]') && !!document.querySelector('[data-testid=cov-found]')`), "the Coverage tab opens: the box and the research-found list");
ok((await items("cov-mine")).length === 2, "two open gaps are listed, and the tab's number is 2");
const found = await items("cov-found");
ok(found.length === 4 && found.every((t) => /Run of \d+ \w+ 2026/.test(t)), `four research-found items, each with its run: ${found.length}`);
ok(!found.some((t) => /socket wattage/.test(t)), "an answered need is not offered");
await sleep(400);
const d0 = await db();
ok(d0.gaps.length === 3 && (await gapReqs("alice", (x) => x.method !== "GET")).length === 0, "nothing research found was added by itself: still the planted gaps, no write");
ok(!(await has("select, datalist, [role=listbox], [role=combobox]")), "no select, datalist or listbox on the page");

// ---- 2. add: the box, a research-found need, and the selected text with its link to the passage
await typeInto("[data-testid=cov-box]", "ALPHA how loud is it?");
await click("[data-testid=cov-add]");
ok(await tabN(3), "adding from the box: the number is 3");
ok((await ev(`document.querySelector('[data-testid=cov-box]').value`)) === "", "...and the box is empty again");
await ev(`[...document.querySelectorAll('[data-testid=need]')].find(n=>n.innerText.includes('price of the 7950X')).querySelector('button').click()`);
ok(await tabN(4), "Add to my gaps on a research-found need: the number is 4");
ok(/On your list/.test(await ev(`[...document.querySelectorAll('[data-testid=need]')].find(n=>n.innerText.includes('price of the 7950X')).innerText`)), "...and that need now says it is on your list");
ok((await gapReqs("alice", (x) => x.method === "POST")).map((x) => JSON.parse(x.body).origin).join() === "user,research", "the origins sent were user and research");
await ev(`document.querySelector('[data-testid=doc-editor] .cm-content').focus()`);
await key("a", CTRL, ["selectAll"]);
ok(await until(`!document.querySelector('[data-testid=cov-add-sel]').disabled`), "selecting text turns Add as a gap on");
await click("[data-testid=cov-add-sel]");
ok(await tabN(5), "Add as a gap: the number is 5");
const selGap = (await db()).gaps.find((g) => g.origin === "selection");
ok(!!selGap && selGap.text.includes("body of the CPU plan"), "the gap holds the selected passage, origin selection");
await ev(`(()=>{const c=document.querySelector('[data-testid=doc-editor] .cm-content'); c.focus(); const s=getSelection(); s.selectAllChildren(c); s.collapseToEnd();})()`);
await ev(`document.querySelector('[data-testid=dtab-coverage]').focus()`);
await click(`[data-testid=gap-${selGap.id}] .cov-sub button`);
ok(await until(`(getSelection().toString()||'').includes('body of the CPU plan')`), "Show in the text selects that passage again");

// ---- 3. research the ticked gaps in one run; the run ends and rotates out
for (const n of ["how loud is it", "which cooler fits"]) await click(`[data-testid=gap-tick-${await gapId(n)}]`);
ok((await text("[data-testid=cov-research]")) === "Research the 2 ticked gaps (one run)", `the button says: ${await text("[data-testid=cov-research]")}`);
await click("[data-testid=cov-research]");
ok(await until(`document.querySelectorAll('[data-testid=cov-researching] > li').length===2`), "both gaps move to Being researched");
const rr = await gapReqs("alice", (x) => x.url.endsWith("/gaps/research"));
ok(rr.length === 1 && JSON.parse(rr[0].body).ids.length === 2, "ONE research request carrying both ids");
const runs = (await db()).runs;
ok(runs.length === 1 && (await db()).gaps.filter((g) => g.job_id === runs[0]).length === 2, "one run, both gaps carry its id");
ok(await tabN(3), `the number dropped to the open ones: ${await tab()}`);
await stub("/__finish/1?cover=1", "POST");
await click("[data-testid=cov-recheck]");
ok(await until(`document.querySelectorAll('[data-testid=cov-covered] > li').length===2 && !document.querySelector('[data-testid=cov-researching]')`), "the finished run covered both: they rotate into Covered");
ok(await tabN(3), "the number still counts only the open ones");

// ---- 4. Remove asks first, for that gap only
const g2 = await gapId("socket take");
await click(`[data-testid=gap-${g2}] .danger-line`);
ok(await has(`[data-testid=gap-remove-ok-${g2}]`), "Remove asks 'Remove this gap from your list?'");
const others = await ev(`[...document.querySelectorAll('[data-testid=cov-mine] .cov-sub .danger-line')].map(b=>b.disabled)`);
ok(others.length > 0 && others.every((x) => x), `the other Remove buttons are disabled while it is open (${others.length})`);
ok(await ev(`document.querySelector('[data-testid=cov-research]').disabled`), "Research is off while the question is open");
await click(`[data-testid=gap-${g2}] .cov-confirm button:not([data-testid])`);
ok(!(await has("[data-testid^=gap-remove-ok]")), "Keep closes it");
ok((await gapReqs("alice", (x) => x.method === "DELETE")).length === 0, "nothing was deleted");
await click(`[data-testid=gap-${g2}] .danger-line`);
await click(`[data-testid=gap-remove-ok-${g2}]`);
ok(await tabN(2), "confirming removes only that gap: the number is 2");

// ---- 5. research is off: said in words, the gaps stay
await ev(`document.querySelectorAll('.toast-x').forEach((b) => b.click())`); // the earlier "Research started" toast is dismissed
await stub("/__queue/off", "POST");
await click(`[data-testid=gap-tick-${await gapId("price of the 7950X")}]`);
await click("[data-testid=cov-research]");
ok(await until(`/Research is not available/.test(document.querySelector('[data-testid=cov-err]')?.textContent||'')`), "the 503 says research is not available");
ok(!(await ev(`/Research started/.test(document.querySelector('[data-testid=toasts]').textContent)`)), "...and no 'started' message");
await stub("/__queue/ok", "POST");

// ---- 6. two identities
await stub("/__reset", "POST"); await setMode("bob");
ok(await openCov(BRAVO), "bob opens his own document and the Coverage tab");
ok(await tabN(1), "bob's tab counts his own one gap");
await until(`document.querySelectorAll('[data-testid=cov-found] > li').length===1`);
const bobHtml = await ev(`document.documentElement.outerHTML`);
ok(!/ALPHA|PRIVATE-GAP|u-alice|k-a/.test(bobHtml) && /BRAVO own gap/.test(bobHtml), "bob's page holds nothing of alice's gaps or needs");
const aliceGap = (await db()).gaps.find((g) => g.owner_sub === "u-alice").id;
const bobRes = await asApp("/workbench/contract/gaps/" + aliceGap);
const bobNone = await asApp("/workbench/contract/gaps/9a900000-0000-4000-8000-00000000ffff");
ok(bobRes.status === 404 && bobRes.body === bobNone.body, `another person's gap and a missing one answer alike on the wire: ${bobRes.body}`);
const bobList = JSON.parse((await asApp("/workbench/contract/gaps")).body);
ok(bobList.total === 1 && !JSON.stringify(bobList).includes(MARK), "bob's list total and counts are his own");
const bobSess = await asApp("/workbench/contract/sessions/5e550000-0000-4000-8000-000000000002/coverage");
const bobSess2 = await asApp("/workbench/contract/sessions/5e550000-0000-4000-8000-0000000000ff/coverage");
ok(bobSess.status === 404 && bobSess.body === bobSess2.body, "alice's research run and a missing one answer alike");
await go(H(CPU)); await until(`!!document.querySelector('[data-testid=doc-gone]')`);
ok(!(await has("[data-testid=in-this-doc]")), "bob opening alice's document gets the missing-document sentence, no tab");
const bobLog = (await stub("/__log")).filter((x) => x.mode === "bob");
ok(!bobLog.some((x) => /k-a/.test(x.url) && /gaps|coverage/.test(x.url) && x.method !== "GET"), "bob never wrote a gap for alice's path");

// ---- 7. a live change of person: the draft, the open question and the message go; nothing is sent under bob
await stub("/__reset", "POST"); await setMode("alice");
ok(await openCov(), "alice opens the Coverage tab");
await typeInto("[data-testid=cov-box]", `ALPHA ${MARK} unsent draft`);
await click(`[data-testid=gap-${await gapId("socket take")}] .danger-line`);
await stub("/__queue/off", "POST");
await click(`[data-testid=gap-tick-${await gapId("which cooler")}]`);
await click("[data-testid=cov-research]");
await until(`!!document.querySelector('[data-testid=cov-err]')`);
await setMode("bob");
ok(await until(`document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')==='Signed in as Bob Builder'`, 260), "the shell noticed the new person without a reload");
await sleep(500);
ok(!/ALPHA|PRIVATE-GAP/.test(await ev(`document.documentElement.outerHTML`)) && !(await has("[data-testid=cov-box]")), "alice's draft, question, message and gaps are gone");
const log7 = await stub("/__log");
ok(!log7.some((x) => x.mode === "bob" && (/PRIVATE-GAP/.test(x.body + x.url) || (x.method !== "GET" && x.url.includes("contract/gaps")))), "nothing of alice's was sent, and no gap write was made, under bob");
await stub("/__queue/ok", "POST");

// ---- 8. nothing private in the browser
await setMode("alice"); await stub("/__reset", "POST");
await openCov();
await typeInto("[data-testid=cov-box]", `ALPHA ${MARK} typed for storage`);
await click("[data-testid=cov-add]");
await tabN(3);
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length,title:document.title,all:JSON.stringify(localStorage)+JSON.stringify(sessionStorage)}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0 && !/ALPHA|PRIVATE-GAP/.test(keep.title + keep.all), `storage, cookies, caches, IndexedDB hold nothing; title "${keep.title}"`);
const acct = (await stub("/__log")).filter((x) => x.url.startsWith("/workbench/settings") && x.method !== "GET");
ok(acct.every((x) => !/PRIVATE-GAP|ALPHA/.test(x.body)), "the account keys written hold identifiers only");
ok(events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker)).length === 0, "no /workbench/ read was answered from the browser's cache");
ok(problems().length === 0, "no console error or warning" + (problems().length ? " " + JSON.stringify(problems().slice(0, 2)) : ""));

// ---- 9. widths and accessibility: nothing overflows inside main at 800 and 400 px, with every state up
for (const w of [1440, 800, 400]) {
  await viewport(w, 900);
  await stub("/__reset", "POST"); await setMode("alice");
  await openCov();
  await until(`document.querySelectorAll('[data-testid=cov-found] > li').length===4`);
  await typeInto("[data-testid=cov-box]", "ALPHA a draft with a long unbroken word " + "z".repeat(90));
  await click(`[data-testid=gap-${await gapId("which cooler")}] .danger-line`);
  const o = await overflowing();
  ok(o.length === 0, `at ${w}px nothing overflows inside main (gaps, research-found with a long word, the confirmation, the draft)` + (o.length ? " " + JSON.stringify(o) : ""));
  await axeBoth(`Coverage tab at ${w}px`);
}
await viewport(1440, 900);

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
