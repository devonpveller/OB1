// Headless-Chromium e2e for the References tab (rwr-doc-refs), driven over CDP. Run by run-refs-e2e.ps1 inside an
// --internal lab network with the stub in refs.stub.mjs (the back end is refs-fake.mjs over docs-fake.mjs, which copy the
// server's file / history / research / reference routes). Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is
// axe-core. Every check prints PASS/FAIL; exit 1 on any failure.
// "A second tab" is the driver writing the same file straight at the stub (the same route and the same if_match rule).
import { readFileSync } from "node:fs";
import { uid } from "./docs-fake.mjs";
import { C_ORPHAN, REF_COOL, REF_DRIFT, REF_POWER, REF_SOCKET, S_BARE, S_LONG, S_NEW, S_SOCKET } from "./refs-fake.mjs";

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
  // the tab is taller than the window: bring the control into view before the pointer goes to its centre
  await ev(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'center'})`); await sleep(60);
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
let axeSaid = false;
async function axe(label) {
  await ev(AXE + ";1");
  if (!axeSaid) { axeSaid = true; console.log("INFO axe-core version " + (await ev("axe.version"))); }
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

const T = (id) => `[data-testid="${id}"]`;
const text = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})?.innerText||'')`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const cited = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=cited-row]')].map(e=>e.dataset.ref))`));
const queued = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=toplace-row]')].map(e=>e.dataset.id))`));
const refsReady = `!!document.querySelector('[data-testid=cited-list]') && !!document.querySelector('[data-testid=toplace-list]')`;
const openRefs = async (p = CPU) => { await openDoc(p); return until(refsReady, 80); };
const cursorAtEnd = async () => { await ev(`(()=>{const c=document.querySelector('[data-testid=doc-editor] .cm-content'); c.focus(); const s=getSelection(); s.selectAllChildren(c); s.collapseToEnd();})()`); await sleep(100); };
const postStub = (path, body) => fetch(`http://stub:9000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const findFor = async (q) => { await ev(`document.querySelector('[data-testid=find-q]').focus()`); await send("Input.insertText", { text: q }); await mouse(T("find-go")); };
// nothing may overflow the page, and nothing may overflow INSIDE main (an inner scroll box, a child past main's edge)
const probe = async (w, label) => {
  const o = JSON.parse(await ev(`JSON.stringify((()=>{const m=document.getElementById('main'); const mr=m.getBoundingClientRect();
    const past=[...document.querySelectorAll('#main *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && r.right>mr.right+1 && getComputedStyle(e).position!=='fixed';}).slice(0,5).map(e=>e.tagName+'.'+e.className+'['+(e.dataset.testid||'')+']');
    const inner=[...document.querySelectorAll('#main [data-testid=refs-tab], #main [data-testid=refs-tab] *')].filter(e=>e.scrollWidth>e.clientWidth+1 && getComputedStyle(e).overflowX==='visible' && e.clientWidth>0).slice(0,5).map(e=>e.tagName+'.'+e.className+'['+(e.dataset.testid||'')+']');
    return {sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,msw:m.scrollWidth,mcw:m.clientWidth,past,inner};})())`));
  ok(o.sw <= o.cw && o.msw <= o.mcw + 1 && o.past.length === 0 && o.inner.length === 0, `at ${w}px ${label}: no overflow of the page (${o.sw}/${o.cw}), inside main (${o.msw}/${o.mcw}) or inside the tab` + (o.past.length || o.inner.length ? " " + JSON.stringify(o) : ""));
};

await stub("/__reset", "POST");
await scheme("light");
await setMode("alice");

// ---- 1. the tab: three lists, in the server's order, with sections and quality notes; reads only
ok(await openRefs(), "the document opens on the References tab with its lists");
ok(await ev(`document.querySelector('[data-testid=dtab-references]').getAttribute('aria-selected')`) === "true", "References is the selected tab");
ok(JSON.stringify(await cited()) === JSON.stringify([REF_SOCKET, REF_POWER, REF_DRIFT, REF_COOL]), "the cited list is the holder references in the server's order");
ok(/Socket/.test(await text(T(`cited-section-${REF_SOCKET}`))) && /Power/.test(await text(T(`cited-section-${REF_POWER}`))) && /not in the text/i.test(await text(T(`cited-section-${REF_COOL}`))), "each cited row says its section; the attached one says it is not in the text");
ok(await until(`/0\\.82/.test(document.querySelector('[data-testid="cited-quality-${REF_SOCKET}"]')?.innerText||'')`), "the quality note shows the score");
ok(await until(`/revision 3/.test(document.querySelector('[data-testid="cited-newer-${REF_SOCKET}"]')?.innerText||'')`), "a newer revision is flagged on the cited row");
ok((await queued()).length === 2, "two cites wait in To place");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
ok(reqs().every((r) => r.url.startsWith(origin + "/")), "every request same-origin");
ok((await stub("/__log")).every((x) => x.keyOk), "every request reached the stub with the door key (injected server-side)");
ok(!(await has("#main select, #main datalist")), "no select or datalist on the screen");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} References tab`); }
await scheme("light");

// ---- 2. a title opens the source at its section in the side drawer
await mouse(T(`cited-title-${REF_SOCKET}`));
ok(await until(`/LGA2066/.test(document.querySelector('[data-testid=drawer-passage]')?.innerText||'')`), "the title opens the drawer on the pinned section");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} References tab with the drawer`); }
await scheme("light");
await mouse(T("drawer-close"));

// ---- 3. Place at cursor in the real editor
const row = (await db()).pending.find((r) => r.source_id === S_NEW);
await cursorAtEnd();
await mouse(T(`place-${row.id}`));
ok(await until(`!document.querySelector('[data-testid="place-${row.id}"]')`), "the cite left To place");
ok(await until(`document.querySelectorAll('[data-testid=doc-editor] .ws-chip-wrap, [data-testid=doc-editor] .ws-chip').length>=2`), "a citation chip is in the text at the cursor");
ok(await until(`document.querySelectorAll('[data-testid=cited-row]').length===5`, 80), "the cited list gained the placed reference once the file was saved");
ok(/\[@ref:/.test((await db()).docs.find((d) => d.path === CPU).raw ?? ""), "the file on the server holds the citation");

// ---- 4. Re-pin: it shows what changed first
const nReq = (await stub("/__log")).length;
await mouse(T(`repin-${REF_SOCKET}`));
ok(await until(`!!document.querySelector('[data-testid="repin-view-${REF_SOCKET}"]')`), "Re-pin opens the view of what changed");
ok(/revision 2/.test(await text(T("repin-revisions"))) && /revision 3/.test(await text(T("repin-revisions"))) && /A new BIOS/.test(await text(T("repin-after"))), "the view names both revisions and shows the newer words");
ok(!(await stub("/__log")).slice(nReq).some((x) => /\/repin/.test(x.url)), "no move request was made by opening the view");
await axe("light re-pin view");
await scheme("dark"); await axe("dark re-pin view"); await scheme("light");
await mouse(T(`repin-move-${REF_SOCKET}`));
ok(await until(`!document.querySelector('[data-testid="repin-view-${REF_SOCKET}"]')`), "the view closes after the move");
ok(await until(`!document.querySelector('[data-testid="cited-title-${REF_SOCKET}"]')`, 80), "the old reference left the list once the file was saved");
const afterMove = await db();
ok(afterMove.records.some((r) => r.source_id === S_SOCKET && r.pinned_revision === 3) && !afterMove.docs.find((d) => d.path === CPU).raw.includes(REF_SOCKET), "a new record at revision 3 exists and the text names it instead of the old one");
await mouse(T(`repin-${REF_DRIFT}`));
ok(await until(`!!document.querySelector('[data-testid=repin-lost]')`), "words lost from the newest revision: it says so and offers no move");
ok(!(await has(T(`repin-move-${REF_DRIFT}`))), "no move button for a pin that cannot move");
await mouse(T("repin-cancel"));

// ---- 5. Find sources, Add to references; removals are confirmed, per target
await findFor("ALPHA");
ok(await until(`!!document.querySelector('[data-testid=find-results]')`), "Find sources lists results");
const ids = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=find-row]')].map(e=>e.dataset.source))`));
const cites = (await db()).records.map((r) => r.source_id);
ok(ids.length > 0 && !ids.some((i) => cites.includes(i)), `no listed source is one the document already cites (${ids.length} listed)`);
ok(ids.includes(S_BARE), "an uncited source is offered");
await mouse(T(`find-add-${S_BARE}`));
ok(await until(`document.querySelectorAll('[data-testid=toplace-row]').length===2`), "Add to references put the source in To place");
ok((await db()).pending.some((r) => r.source_id === S_BARE && r.added_from === "find"), "the queue row is the caller's, labelled find");
const q0 = await queued();
await mouse(T(`toplace-remove-${q0[0]}`));
ok((await has(T(`confirm-${q0[0]}`))) && !(await has(T(`confirm-${q0[1]}`))), "removing asks first, for that cite only");
ok(await ev(`document.querySelector('[data-testid="toplace-remove-${q0[1]}"]').disabled && document.querySelector('[data-testid="cited-remove-${REF_COOL}"]').disabled`), "the other destructive buttons are disabled while it is open");
await axe("light confirmation open");
await mouse(T("confirm-no"));
await mouse(T(`cited-remove-${REF_COOL}`));
await mouse(`${T(`confirm-${REF_COOL}`)} ${T("confirm-yes")}`);
ok(await until(`!document.querySelector('[data-testid="cited-title-${REF_COOL}"]')`), "the attached reference was removed after the confirmation");

// ---- 6. 800 and 400 px: nothing overflows, inside main included, with every state open
for (const w of [800, 400]) {
  await viewport(w, 900);
  await stub("/__reset", "POST"); await setMode("alice");
  await postStub("/workbench/contract/documents/pending-refs", { path: CPU, source_id: S_LONG, added_from: "search" });
  await openRefs();
  await probe(w, "the tab");
  await findFor("ALPHA");
  await until(`!!document.querySelector('[data-testid=find-results]')`);
  await probe(w, "with the results");
  const rid = (await cited())[0];
  await mouse(T(`repin-${rid}`));
  await until(`!!document.querySelector('[data-testid^="repin-view-"]')`);
  await probe(w, "with the re-pin view");
  await axe(`light References tab at ${w}px`);
  await mouse(T("repin-cancel"));
  const rq = (await queued())[0];
  await mouse(T(`toplace-remove-${rq}`));
  await probe(w, "with a removal being confirmed");
  await mouse(T("confirm-no"));
  await mouse(T(`cited-title-${rid}`));
  await until(`!!document.querySelector('[data-testid=drawer-body]')`);
  await probe(w, "with the drawer open");
  await key("Escape");
}
await viewport(1440, 900);

// ---- 7. two identities
await stub("/__reset", "POST"); await setMode("bob");
await go(H("documents/k-b/bravo.md"));
ok(await until(`!!document.querySelector('[data-testid=toplace-list]')`, 80), "bob's own document opens on his own tab");
const bobHtml = await ev(`document.documentElement.outerHTML`);
ok(/BRAVO private held source/.test(bobHtml) && !/ALPHA|k-a|u-alice|Hardware|Socket guide/.test(bobHtml), "bob sees his own queue and nothing of alice's");
ok(!(await stub("/__log")).some((x) => x.mode === "bob" && /ALPHA|u-alice|k-a/.test(x.body + x.url)), "nothing of alice's was asked for under bob's sign-in");
await setMode("alice");
await go(H(CPU));
await until(refsReady, 80);
ok(!/BRAVO|u-bob/.test(await ev(`document.documentElement.outerHTML`)), "alice's page holds nothing of bob's");
await findFor("secret held");
ok(await until(`!!document.querySelector('[data-testid=find-none]')`) && !/BRAVO/.test(await text("#main")), "alice's search never finds bob's held source");

// ---- 8. a live change of person: drafts, confirmations and views are gone, and nothing is sent under bob
await stub("/__reset", "POST"); await setMode("alice");
await openRefs();
await ev(`document.querySelector('[data-testid=find-q]').focus()`);
await send("Input.insertText", { text: "ALICE-FIND-DRAFT" });
await mouse(T(`cited-remove-${REF_COOL}`));
await mouse(T(`repin-${REF_SOCKET}`));
await until(`!!document.querySelector('[data-testid="repin-view-${REF_SOCKET}"]')`);
await setMode("bob");
ok(await until(`document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')==='Signed in as Bob Builder'`, 260), "the shell noticed the new person without a reload");
await sleep(500);
ok(!/ALICE-FIND-DRAFT|ALPHA/.test(await ev(`document.documentElement.outerHTML`)) && !(await has(T("refs-tab"))), "alice's draft, confirmation, re-pin view and lists are gone from the page");
ok(!(await stub("/__log")).some((x) => x.mode === "bob" && (/ALICE-FIND-DRAFT/.test(x.body + x.url) || (x.method !== "GET" && !/^\/workbench\/settings/.test(x.url)))), "nothing of the draft, and no write at all, was sent under bob's sign-in");

// ---- 9. nothing private is kept in the browser
await setMode("alice"); await stub("/__reset", "POST");
await openRefs();
await findFor("PLANTED-MARKER-4417");
await sleep(300);
await mouse(T(`repin-${REF_SOCKET}`));
await sleep(300);
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length,title:document.title,all:JSON.stringify(localStorage)+JSON.stringify(sessionStorage)}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0 && !/ALPHA|PLANTED|Socket/.test(keep.title + keep.all), `storage, cookies, caches and IndexedDB hold nothing but the theme; title "${keep.title}"`);
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
void REF_POWER; void C_ORPHAN;

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
