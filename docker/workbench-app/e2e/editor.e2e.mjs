// Headless-Chromium e2e for the writing surface (rwr-doc-editor), driven over CDP. Run by run-editor-e2e.ps1 inside an
// --internal lab network with the stub in docs.stub.mjs (the documents back end is docs-fake.mjs, which copies the
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

await stub("/__reset", "POST");
await scheme("light");
await setMode("alice");

// ---- 1. open: breadcrumb, version, text; reads only, same origin, door key, no console problem
ok(await openDoc(), "the document opens in the writing surface");
ok(/^Documents \/ Hardware \/$/.test(await ev(`document.querySelector('[data-testid=breadcrumb]').textContent`)), "breadcrumb: Documents / Hardware /");
ok(/^v1 · saved 2 h ago$/.test(await version()), `the indicator: ${await version()}`);
ok((await ev(SEL_TEXT)).trim() === "ALPHA body of the CPU plan.\nSecond line.", "the body is in the box (the front matter is not)");
ok(await ev(`document.querySelector('h1').textContent`) === "ALPHA Upgrading the CPU", "the title is the heading");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
ok(reqs().every((r) => r.url.startsWith(origin + "/")), "every request same-origin");
ok((await stub("/__log")).every((x) => x.keyOk), "every request reached the stub with the door key (injected server-side)");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} document screen (editor)`); }
await scheme("light");

// ---- 2. acceptance 1: edit, save, reload
await typeAtEnd("\nThird line, typed in Chromium.");
ok(/^v1 · unsaved changes$/.test(await version()), `unsaved: ${await version()}`);
await click("[data-testid=doc-save]");
ok(await until(`/^v2 · saved/.test(document.querySelector('[data-testid=doc-version]').textContent)`), `saved as a new version: ${await version()}`);
let f = await fileOf();
ok(f.content === `---\ntitle: "ALPHA Upgrading the CPU"\n---\nALPHA body of the CPU plan.\nSecond line.\nThird line, typed in Chromium.`, "the file on the server is the front matter + the typed body, byte for byte");
await reload();
ok(await openDoc(), "reopened after a reload");
ok(/Third line, typed in Chromium\./.test(await ev(SEL_TEXT)) && /^v2 · saved/.test(await version()), `after the reload: text kept, ${await version()}`);

// ---- 3. a pause in typing writes the file; no version
await typeAtEnd(" more");
ok(await until(`/^v2 · saved/.test(document.querySelector('[data-testid=doc-version]').textContent)`, 40), "autosave: back to 'saved' after a pause");
f = await fileOf();
ok(/Chromium\. more$/.test(f.content), "the autosaved text is on the server");
ok((await db()).docs.find((d) => d.path === CPU).history.length === 2, "autosave made no version (history unchanged: created + one edit)");

// ---- 4. acceptance 2: a concurrent edit from a second tab is refused, never overwritten, nothing lost
const base = await fileOf();
const theirs = base.content.replace("Second line.", "Tab B's line.");
ok((await putOther(CPU, theirs, base.hash)) === 200, "tab B writes the file (200)");
await typeAtEnd(" TAB-A-WORDS");
await click("[data-testid=doc-save]");
ok(await until(`!!document.querySelector('[data-testid=doc-conflict]')`), "tab A's save is refused with a message");
ok(/changed somewhere else/.test(await ev(`document.querySelector('[data-testid=doc-conflict]').textContent`)), "the message says the document changed elsewhere and nothing was overwritten");
ok((await fileOf()).content === theirs, "tab B's text is on the server, untouched");
ok(/TAB-A-WORDS/.test(await ev(SEL_TEXT)), "tab A's text is still in A's box");
ok(/not saved/.test(await version()), `the indicator says so: ${await version()}`);
await sleep(1900);
ok((await fileOf()).content === theirs, "no autosave wrote into the conflict");
await scheme("dark"); await axe("dark conflict state"); await scheme("light"); await axe("light conflict state");
await click("[data-testid=doc-close]");
await sleep(500);
ok((await ev("location.pathname")) === H(CPU), "Close does not close while the text is unsaved");
await click("[data-testid=doc-take-other]");
ok(/lost unless you copied it/.test(await ev(`document.querySelector('[data-testid=doc-conflict]').textContent`)) && /TAB-A-WORDS/.test(await ev(SEL_TEXT)), "Load the other version asks first; A's text is still there");
await click("[data-testid=doc-take-other-ok]");
ok(await until(`/Tab B's line\\./.test(${SEL_TEXT}) && !document.querySelector('[data-testid=doc-conflict]')`), "after the second click the other version is in the box");

// ---- 5. acceptance 3: a citation chip opens the cited section of the pinned revision
await stub("/__reset", "POST"); await setMode("alice");
{
  const b = await fileOf();
  await putOther(CPU, `---\ntitle: "ALPHA Upgrading the CPU"\n---\nThe board supports it [@ref:${REF_A}] as stated.`, b.hash);
}
await reload();
ok(await openDoc(), "the document with a citation opens");
ok((await ev(`document.querySelector('button.ws-chip')?.textContent`)) === "[1]", "the citation shows as [1]");
await mouse("button.ws-chip");
ok(await until(`!!document.querySelector('[data-testid=drawer-body]')`), "clicking [1] opens the side drawer");
const dr = JSON.parse(await ev(`JSON.stringify({t:document.querySelector('[data-testid=drawer-title]').textContent,pin:document.querySelector('[data-testid=drawer-pin]').textContent,q:document.querySelector('[data-testid=drawer-quote]').textContent,hit:document.querySelector('[data-target=true]')?.textContent})`));
ok(dr.t === "SRC-ALPHA Socket guide" && /Pinned at revision 2/.test(dr.pin) && /newer revision \(3\)/.test(dr.pin) && dr.q === "the LGA2066 socket takes a 165 W part" && /^Chunk two/.test(dr.hit), `the drawer shows the pinned section: ${JSON.stringify(dr)}`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} with the source drawer open`); }
await scheme("light");
await key("Escape");
ok(await until(`!document.querySelector('[data-testid=source-drawer]')`), "Esc closes the drawer");

// ---- 6. the In this doc tabs
const names = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=in-this-doc] [role=tab]')].map(t=>t.textContent))`));
ok(JSON.stringify(names) === JSON.stringify(["References", "Coverage", "Topics", "Refine", "History", "Details", "Export"]), `seven tabs: ${names}`);
let allSoon = true;
for (const t of names) {
  await click(`[data-testid=dtab-${t.toLowerCase()}]`);
  const c = JSON.parse(await ev(`JSON.stringify({p:document.querySelector('[role=tabpanel]').textContent,a:document.querySelectorAll('[data-testid=in-this-doc] [role=alert]').length})`));
  if (!(c.p.includes(`${t} is not built yet`) && c.a === 0)) allSoon = false;
}
ok(allSoon, "every tab renders a 'not built yet' placeholder, never an error");
await ev(`document.querySelector('[data-testid=dtab-references]').click(); document.querySelector('[data-testid=dtab-references]').focus()`);
await key("ArrowRight"); await key("End");
ok(await ev(`document.activeElement.textContent`) === "Export" && await ev(`document.activeElement.getAttribute('aria-selected')`) === "true", "ArrowRight and End move between the tabs");
await click("[data-testid=dtab-references]");

// ---- 7. selected-text toolbar: Research this (keyboard and mouse)
ok(await ev(`document.querySelector('[data-testid=research-this]').disabled`), "Research this is off with nothing selected");
await ev(`document.querySelector('[data-testid=doc-editor] .cm-content').focus()`);
await key("a", CTRL, ["selectAll"]);
ok(await until(`!document.querySelector('[data-testid=research-this]').disabled`), "selecting text turns Research this on");
await click("[data-testid=research-this]");
ok(await until(`/Research queued on the selected text\\./.test(document.querySelector('[data-testid=toasts]').textContent)`), "Research this queues it (a toast, without the words)");
const rs = (await db()).research;
ok(rs.length === 1 && rs[0].path === CPU && rs[0].kind === "research" && rs[0].query.includes("The board supports it"), `the document's research route got the selection: ${JSON.stringify(rs[0])}`);

// ---- 8. keyboard only: Tab order, focus rings, Escape out of the box, Ctrl+S, Ctrl+Alt+R
await stub("/__reset", "POST"); await setMode("alice");
await openDoc();
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 44; i++) {
  await key("Tab");
  await sleep(90);
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const host=e.closest('.cm-editor')||e;const cs=getComputedStyle(host);return JSON.stringify({t:e.dataset.testid||e.getAttribute('role')||e.tagName,inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible'),cm:!!e.closest('.cm-editor')})})()`)));
  if (stops[stops.length - 1].t === "tab") { /* the strip is one stop */ }
}
const main = stops.filter((s) => s.inMain);
for (const need of ["doc-lock", "doc-save", "doc-close", "dtab-", "dpanel-"]) ok(main.some((s) => s.t.startsWith(need)), `Tab reaches ${need.replace(/-$/, "")}`);
ok(main.some((s) => s.cm), "Tab reaches the text box");
ok(main.every((s) => s.fv && s.os !== "none" && s.ow >= 1), `all ${main.length} Tab stops on the screen show a focus indicator` + (main.every((s) => s.fv && s.os !== "none" && s.ow >= 1) ? "" : " " + JSON.stringify(main)));
await ev(`document.querySelector('[data-testid=doc-editor] .cm-content').focus()`);
await key("Escape");
ok(await ev(`document.activeElement.dataset.testid`) === "doc-save", "Escape leaves the text box for the Save button");
await typeAtEnd(" keyboard words");
await key("s", CTRL);
ok(await until(`/^v2 · saved/.test(document.querySelector('[data-testid=doc-version]').textContent)`), "Ctrl+S saves a version from the box");
await key("Home", CTRL);
await key("ArrowRight", SHIFT);
await key("ArrowRight", SHIFT);
await key("ArrowRight", SHIFT);
const selNow = await ev(`getSelection().toString()`);
await key("r", CTRL | ALT);
ok(await until(`/Research queued/.test(document.querySelector('[data-testid=toasts]').textContent)`), `Ctrl+Alt+R researches the selection (selected: ${JSON.stringify(selNow)}; bar: ${await ev(`document.querySelector('[data-testid=sel-bar]').textContent`)})`);

// ---- 9. Lock / Unlock / Swap, and Close then open from Documents lands at the top
await stub("/__reset", "POST"); await setMode("alice");
{
  const b = await fileOf();
  await putOther(CPU, `---\ntitle: "ALPHA Upgrading the CPU"\n---\n` + Array.from({ length: 160 }, (_, i) => `Line ${i + 1} of a long plan.`).join("\n\n"), b.hash);
}
await openDoc();
ok((await ev(`document.querySelector('[data-testid=doc-lock]').textContent`)) === "Lock", "Lock");
await click("[data-testid=doc-lock]");
ok(await until(`document.querySelector('[data-testid=doc-lock]').textContent==='Unlock' && /Locked: ALPHA Upgrading the CPU/.test(document.querySelector('[data-testid=lock-chip]')?.textContent||'')`), "locked: the button says Unlock and the top bar shows the chip");
await click("[data-testid=doc-lock]");
ok(await until(`document.querySelector('[data-testid=doc-lock]').textContent==='Lock' && !document.querySelector('[data-testid=lock-chip]')`), "unlocked");
await ev(`document.getElementById('main').scrollTop = 900`);
await click("[data-testid=doc-close]");
ok(await until(`location.pathname==='/documents' && document.querySelectorAll('[data-testid=doc-row]').length>=3`), "Close returns to Documents");
await ev(`[...document.querySelectorAll('[data-testid=doc-row]')].find(r=>r.querySelector('[data-testid=doc-title]').textContent==='ALPHA Upgrading the CPU').querySelector('[data-testid=doc-title]').click()`);
ok(await until(`!!document.querySelector('[data-testid=doc-editor] .cm-content')`), "opened again from Documents");
await sleep(300);
const top = JSON.parse(await ev(`JSON.stringify({st:document.getElementById('main').scrollTop, first:(document.querySelector('.cm-line')?.textContent||'')})`));
ok(top.st === 0 && top.first === "Line 1 of a long plan.", `the same document at the top: ${JSON.stringify(top)}`);

// ---- 10. 800 and 400 px: no overflow, with the editor, the conflict message and the drawer
for (const w of [800, 400]) {
  await viewport(w, 900);
  await stub("/__reset", "POST"); await setMode("alice");
  { const b = await fileOf(); await putOther(CPU, `---\ntitle: "ALPHA Upgrading the CPU"\n---\nThe board supports it [@ref:${REF_A}] as stated, with a long unbroken word ${"x".repeat(80)}.`, b.hash); }
  await openDoc();
  const probe = async (label) => {
    const o = JSON.parse(await ev(`JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,wide:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>document.documentElement.clientWidth+1&&getComputedStyle(e).position!=='absolute'&&!e.closest('.sr-only')}).slice(0,6).map(e=>(e.dataset.testid||e.className||e.tagName)+':'+Math.round(e.getBoundingClientRect().right))})`));
    ok(o.sw <= o.cw && o.wide.length === 0, `at ${w}px ${label}: no horizontal page scroll (${o.sw}/${o.cw}) and no element past the edge` + (o.wide.length ? " " + JSON.stringify(o.wide) : ""));
  };
  await probe("the editor");
  await axe(`light editor at ${w}px`);
  await mouse("button.ws-chip");
  await until(`!!document.querySelector('[data-testid=drawer-body]')`);
  await probe("with the drawer open");
  await axe(`light drawer at ${w}px`);
  await key("Escape");
  // a conflict state
  const b2 = await fileOf();
  await putOther(CPU, b2.content + " other tab", b2.hash);
  await typeAtEnd(" mine");
  await click("[data-testid=doc-save]");
  await until(`!!document.querySelector('[data-testid=doc-conflict]')`);
  await probe("with the conflict message");
  await axe(`light conflict at ${w}px`);
}
await viewport(1440, 900);

// ---- 11. acceptance 7: two identities
await stub("/__reset", "POST"); await setMode("alice");
await openDoc();
await click("[data-testid=doc-lock]");
await until(`document.querySelector('[data-testid=doc-lock]').textContent==='Unlock'`);
await setMode("bob");
const seen = [];
for (const p of [CPU, "documents/k-a/.trash/Hardware/dup.md", "documents/k-b/no-such.md"]) {
  await go(H(p)); await until(`!!document.querySelector('[data-testid=doc-gone]')`);
  seen.push(await ev(`document.querySelector('main').innerText`));
}
ok(seen.length === 3 && new Set(seen).size === 1 && !/ALPHA/.test(seen[0]), `bob opening alice's document (live or trashed) sees exactly what a missing document shows: ${JSON.stringify(seen[0])}`);
const bobHtml = await ev(`document.documentElement.outerHTML`);
ok(!/ALPHA|k-a|u-alice|Hardware|Upgrading/.test(bobHtml) && !(await ev(`!!document.querySelector('[data-testid=lock-chip]')`)), "bob's page holds nothing of alice's text, title, path, lock or last document");
await go(H("documents/k-b/bravo.md")); await until(`!!document.querySelector('[data-testid=doc-editor] .cm-content')`);
ok(/BRAVO text\./.test(await ev(SEL_TEXT)) && !(await ev(`!!document.querySelector('[data-testid=lock-chip]')`)) && !/ALPHA/.test(await ev(`document.documentElement.outerHTML`)), "bob's own document opens, with no lock of alice's on his bar");
const log0 = await stub("/__log");
ok(log0.filter((x) => x.mode === "bob" && x.method !== "GET" && !x.url.startsWith("/workbench/settings")).length === 0, "bob made no change request");
await scheme("dark"); await axe("dark document as bob"); await scheme("light");

// ---- 12. the unsent draft of one person never reaches the next (a live change of person, no reload)
await stub("/__reset", "POST"); await setMode("alice");
await openDoc();
await typeAtEnd(" ALICE-DRAFT-MARKER");
await setMode("bob");
const switched = await until(`document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')==='Signed in as Bob Builder'`, 260);
ok(switched, "the shell noticed the new person without a reload");
await sleep(500);
ok(!/ALICE-DRAFT-MARKER|ALPHA/.test(await ev(`document.documentElement.outerHTML`)) && !(await ev(`!!document.querySelector('[data-testid=doc-editor]')`)), "alice's draft and document are gone from the page");
const log1 = await stub("/__log");
ok(!log1.some((x) => x.mode === "bob" && /ALICE-DRAFT-MARKER/.test(x.body + x.url)), "nothing of the draft was sent under bob's sign-in" + JSON.stringify(log1.filter((x) => x.mode === "bob" && /ALICE-DRAFT-MARKER/.test(x.body + x.url)).map((x) => x.method + " " + x.url)));

// ---- 13. acceptance 8: nothing private is kept in the browser
await setMode("alice"); await stub("/__reset", "POST");
await openDoc();
await typeAtEnd(" PLANTED-MARKER-7731");
await click("[data-testid=doc-save]");
await until(`/^v2 · saved/.test(document.querySelector('[data-testid=doc-version]').textContent)`);
await click("[data-testid=doc-lock]");
await sleep(300);
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length,title:document.title,all:JSON.stringify(localStorage)+JSON.stringify(sessionStorage)}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0 && !/ALPHA|PLANTED/.test(keep.title + keep.all), `storage, cookies, caches, IndexedDB hold nothing; title "${keep.title}"`);
const acct = (await stub("/__log")).filter((x) => x.url.startsWith("/workbench/settings") && x.method !== "GET");
ok(acct.length > 0 && acct.every((x) => !/PLANTED|ALPHA/.test(x.body)), "the account keys written hold identifiers only");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
