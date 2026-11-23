// Headless-Chromium e2e for the Documents screen (rwr-docs-list), driven over CDP. Run by run-docs-e2e.ps1 inside an
// --internal lab network with the stub in docs.stub.mjs (the documents back end is docs-fake.mjs). Env: APP_IP, CH
// (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; exit 1 on any failure.
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
const until = async (x, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(x)) return true; await sleep(150); } return false; };
const settled = `!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && document.querySelectorAll('main [role=status]').length===0`;
const go = async (path) => { events.length = 0; await send("Page.navigate", { url: origin + path }); await until(settled); await sleep(200); };
const reload = async () => { events.length = 0; await send("Page.reload", { ignoreCache: false }); await sleep(300); await until(settled); await sleep(200); };
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
const rowSel = (title) => `[...document.querySelectorAll('[data-testid=doc-row]')].find(r=>r.querySelector('[data-testid=doc-title]').textContent===${JSON.stringify(title)})`;
const inRow = (title, tid) => ev(`(()=>{const r=${rowSel(title)}; const e=r&&r.querySelector('[data-testid=${tid}]'); if(!e) return false; e.click(); return true;})()`);
const rows = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=doc-row] [data-testid=doc-title]')].map(e=>e.textContent))`));
const tab = async (t) => { await click(`[data-testid=tab-${t}]`); await sleep(150); };
const typeIn = async (sel, text) => { await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await send("Input.insertText", { text }); await sleep(80); };
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
const H = (p) => "/documents/" + encodeURIComponent(p);
const CPU = "documents/k-a/Hardware/cpu.md";

await stub("/__reset", "POST");
await scheme("light");

// ---- 1. the list: rows, folder counts, linked to; reads only, same origin, door key, no console problem
await setMode("alice"); await go("/documents");
ok(JSON.stringify(await rows()) === JSON.stringify(["ALPHA Upgrading the CPU", "ALPHA One gateway", "ALPHA Untitled draft"]), "Active lists alice's three active documents, newest edit first");
const folders = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=folders] button')].map(b=>b.textContent))`));
ok(JSON.stringify(folders) === JSON.stringify(["All documents3", "Hardware1", "Recipes0", "Stack1", "Unfiled1"]), `folders with counts: ${JSON.stringify(folders)}`);
ok(/2 sources · 1 idea/.test(await ev(`${rowSel("ALPHA Upgrading the CPU")}.textContent`)), "linked to: 2 sources · 1 idea");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
ok(reqs().every((r) => r.url.startsWith(origin + "/")), "every request same-origin");
ok((await stub("/__log")).every((x) => x.keyOk), "every request reached the stub with the door key (injected server-side)");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Documents, Active`); }
await scheme("light");

// ---- 2. acceptance 1: a title always opens the document: click, Close, click again, reload, reload on the document
let opened = 0;
for (let i = 0; i < 3; i++) {
  await inRow("ALPHA Upgrading the CPU", "doc-title");
  if (await until(`(document.querySelector('[data-testid=doc-editor] .cm-content')?.textContent||'').includes('ALPHA body of the CPU plan')`, 40) && (await ev("location.pathname")) === H(CPU)) opened++;
  await click("[data-testid=doc-close]");
  await until(`location.pathname==='/documents' && document.querySelectorAll('[data-testid=doc-row]').length===3`);
}
ok(opened === 3, `title -> document -> Close -> title, three times: opened ${opened}/3`);
await reload();
await inRow("ALPHA Upgrading the CPU", "doc-title");
ok(await until(`(document.querySelector('[data-testid=doc-editor] .cm-content')?.textContent||'').includes('ALPHA body')`), "after a reload of Documents the title still opens the document");
await reload();
ok(await until(`(document.querySelector('[data-testid=doc-editor] .cm-content')?.textContent||'').includes('ALPHA body')`), "a reload ON the document's URL opens it again");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} document screen (active)`); }
await scheme("light");
await go(H(CPU));
ok((await ev(`document.querySelector('[data-testid=doc-slot]')?.getAttribute('href')`)) === H(CPU), "the opened document is the Last document in the menu, and its link opens it");

// ---- 3. acceptance 2: archived opens read-only with Unarchive
await go("/documents"); await tab("archived");
ok(JSON.stringify(await rows()) === JSON.stringify(["ALPHA Old wiki plan"]), "Archived lists the archived document");
await inRow("ALPHA Old wiki plan", "doc-title");
await until(`!!document.querySelector('[data-testid=doc-archived]')`);
const ed = JSON.parse(await ev(`JSON.stringify({n:document.querySelectorAll('main input, main textarea, main select, main [contenteditable]').length, ce:document.querySelector('[data-testid=doc-body]').isContentEditable, txt:document.querySelector('[data-testid=doc-body]').textContent})`));
ok(ed.n === 0 && ed.ce === false && ed.txt === "ALPHA archived text.", `archived: the text, and no input / text area / editable region (${JSON.stringify(ed)})`);
// try to type into it anyway
await ev(`document.querySelector('[data-testid=doc-body]').focus()`); await send("Input.insertText", { text: "EDITED" });
ok(!(await ev(`document.querySelector('main').textContent.includes('EDITED')`)), "typing on the archived document changes nothing");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} archived document`); }
await scheme("light");
await click("[data-testid=doc-unarchive]");
ok(await until(`location.pathname===${JSON.stringify(H("documents/k-a/Stack/old-wiki.md"))} && document.querySelector('[data-testid=document]')?.dataset.docState==='active'`), "Unarchive: back in its folder (Stack), opened there");

// ---- 4. acceptance 3: trashed: no link, goes by itself in 28 days, its URL does not open it
await go("/documents"); await tab("trash");
const tr = JSON.parse(await ev(`(()=>{const r=${rowSel("ALPHA CPU duplicate")};return JSON.stringify({a:!!r.querySelector('[data-testid=doc-title]').closest('a'),links:r.querySelectorAll('a').length,when:r.querySelector('[data-testid=doc-when]').textContent})})()`));
ok(!tr.a && tr.links === 0 && /goes by itself in 28 days/.test(tr.when), `trashed row: no link, "${tr.when}"`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Documents, Trash`); }
await scheme("light");
await stub("/__reset", "POST"); await setMode("alice");
await go(H("documents/k-a/.trash/Hardware/dup.md"));
await until(`!!document.querySelector('[data-testid=doc-trashed]')`);
ok(/opens only after you restore it; it goes by itself in 28 days/.test(await ev(`document.querySelector('[data-testid=doc-trashed]').textContent`)) && !(await ev(`!!document.querySelector('[data-testid=doc-body]')`)), "the trashed document's URL does not open it and says when it goes");
ok(!(await stub("/__log")).some((x) => x.url.startsWith("/workbench/documents/file")), "its text was never read");
await click("[data-testid=doc-restore]");
ok(await until(`(document.querySelector('[data-testid=doc-editor] .cm-content')?.textContent||'')==='ALPHA trashed text.'`), "after Restore it opens");

// ---- 5. acceptance 4: Delete forever: typed DELETE, Lost / Stays
await stub("/__reset", "POST"); await setMode("alice");
await go("/documents"); await tab("trash");
await inRow("ALPHA CPU duplicate", "act-delete");
const ask = JSON.parse(await ev(`JSON.stringify({q:document.querySelector('[data-testid=delete-ask] h2')?.textContent,lost:document.querySelector('[data-testid=lost]')?.textContent,stays:document.querySelector('[data-testid=stays]')?.textContent,dis:document.querySelector('[data-testid=typed-ok]').disabled})`));
ok(/Delete "ALPHA CPU duplicate" forever\?/.test(ask.q) && ask.lost && ask.stays && ask.dis, `the question, Lost and Stays shown, button off: ${JSON.stringify(ask)}`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Delete forever confirmation`); }
await scheme("light");
await typeIn("[data-testid=typed-input]", "delete");
ok(await ev(`document.querySelector('[data-testid=typed-ok]').disabled`), "lower-case 'delete' leaves it off");
await key("Enter", "Enter", 13); await sleep(200);
ok(!(await stub("/__log")).some((x) => x.url.includes("delete-forever")), "Enter with the wrong word sends nothing");
await ev(`(()=>{const i=document.querySelector('[data-testid=typed-input]');i.select();})()`);
await send("Input.insertText", { text: "DELETE" }); await sleep(100);
ok(!(await ev(`document.querySelector('[data-testid=typed-ok]').disabled`)), "DELETE turns it on");
// review R1: with A's word typed, the other destructive buttons are off and pressing them changes nothing
const r1 = JSON.parse(await ev(`(()=>{const e=document.querySelector('[data-testid=empty-trash]');const rs=document.querySelector('[data-testid=act-restore]');const before={e:e.disabled,r:rs.disabled};e.click();
  const a=document.querySelector('[data-testid=delete-ask]');return JSON.stringify({...before,q:a&&a.querySelector('h2').textContent,typed:a&&a.querySelector('[data-testid=typed-input]').value});})()`));
ok(r1.e && r1.r && /ALPHA CPU duplicate/.test(r1.q || "") && r1.typed === "DELETE", `with DELETE typed, Empty the trash and Restore are off; clicking Empty the trash does not take over the armed confirmation (${JSON.stringify(r1)})`);
ok(!(await stub("/__log")).some((x) => x.url.includes("empty-trash")), "...and no empty-trash request left");
await click("[data-testid=typed-ok]");
await until(`/Deleted forever: 1 document/.test(document.querySelector('[data-testid=toasts]')?.textContent||'')`);
const d1 = await db();
ok(!d1.docs.some((d) => d.path === "documents/k-a/.trash/Hardware/dup.md") && d1.trail.length === 1 && d1.trail[0].kind === "delete_forever", "the document is gone, one trail line");
const sentDel = (await stub("/__log")).filter((x) => x.url.includes("delete-forever")).map((x) => JSON.parse(x.body));
ok(sentDel.length === 1 && sentDel[0].confirm === true, `one request, confirm: true (${JSON.stringify(sentDel)})`);

// ---- 6. acceptance 5: Empty the trash: typed, only alice's
await stub("/__reset", "POST"); await setMode("alice");
await go("/documents"); await tab("trash");
await click("[data-testid=empty-trash]");
ok(/Empty the trash: delete 1 document forever\?/.test(await ev(`document.querySelector('[data-testid=delete-ask] h2').textContent`)) && await ev(`document.querySelector('[data-testid=typed-ok]').disabled`), "Empty the trash asks, button off");
await typeIn("[data-testid=typed-input]", "DELETE");
await click("[data-testid=typed-ok]");
await until(`/Deleted forever: 1 document/.test(document.querySelector('[data-testid=toasts]')?.textContent||'')`);
const d2 = await db();
ok(!d2.docs.some((d) => d.owner === "u-alice" && d.path.includes("/.trash/")) && d2.docs.some((d) => d.path === "documents/k-b/.trash/bravo-old.md"), "alice's trash is empty; bob's trashed document is still there");
ok(JSON.stringify((await stub("/__log")).filter((x) => x.url.includes("empty-trash")).map((x) => JSON.parse(x.body))) === JSON.stringify([{ confirm: true }]), "the request names no path and no person: {confirm: true}");

// ---- 7. acceptance 6: Undo after archive and after trash
for (const [act, back] of [["act-archive", "unarchive"], ["act-trash", "restore"]]) {
  await stub("/__reset", "POST"); await setMode("alice");
  await go("/documents");
  const h0 = (await db()).docs.find((d) => d.path === CPU).history;
  await inRow("ALPHA Upgrading the CPU", act);
  await until(`!document.querySelector('[data-testid=doc-row] [href*="cpu.md"]') && !!document.querySelector('[data-testid=toast-undo]')`);
  await click("[data-testid=toast-undo]");
  await until(`!!${rowSel("ALPHA Upgrading the CPU")}`);
  const after = (await db()).docs.find((d) => d.path === CPU);
  const folder = await ev(`${rowSel("ALPHA Upgrading the CPU")}?.querySelectorAll('td')[1].textContent`);
  ok(after && folder === "Hardware" && JSON.stringify(after.history.slice(0, h0.length)) === JSON.stringify(h0) && after.history.length === h0.length + 2,
    `${act} then Undo (${back}): back in Active, folder ${folder}, history kept (${after?.history.length} lines)`);
}

// ---- 8. acceptance 7: two identities
await stub("/__reset", "POST"); await setMode("alice"); await go("/documents");
await setMode("bob"); await go("/documents");
ok(JSON.stringify(await rows()) === JSON.stringify(["BRAVO plan"]), "bob lists only his own document");
for (const t of ["active", "archived", "trash"]) {
  await tab(t);
  const html = await ev(`document.documentElement.outerHTML`);
  ok(!/ALPHA|k-a|u-alice|Hardware|Recipes/.test(html), `bob's ${t} tab: no ALPHA title, folder, key or subject anywhere in the page source`);
}
await tab("active");
const bf = await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=folders] button')].map(b=>b.textContent))`);
ok(bf === JSON.stringify(["All documents1", "Unfiled1"]), `bob's folders and counts are his own: ${bf}`);
const seen = [];
for (const p of [CPU, "documents/k-a/.trash/Hardware/dup.md", "documents/k-b/no-such.md"]) {
  await go(H(p)); await until(`!!document.querySelector('[data-testid=doc-gone]')`);
  seen.push(await ev(`document.querySelector('main').innerText`));
}
ok(seen.length === 3 && new Set(seen).size === 1 && !/ALPHA/.test(seen[0]), `bob opening alice's document (live or trashed) sees exactly what a missing document shows: ${JSON.stringify(seen[0])}`);
const bobPosts = (await stub("/__log")).filter((x) => x.mode === "bob" && x.method !== "GET" && !x.url.startsWith("/workbench/settings"));
ok(bobPosts.length === 0, "bob's visit made no change request");
await scheme("dark"); await axe("dark Documents as bob"); await scheme("light");
await setMode("alice");

// ---- 8b. a change of person WITHOUT a reload (the shell's 30 s whoami refresh) with alice's toast up and held
await stub("/__reset", "POST"); await setMode("alice"); await go("/documents");
await inRow("ALPHA One gateway", "act-archive");
await until(`/Archived "ALPHA One gateway"/.test(document.querySelector('[data-testid=toasts]')?.textContent||'')`);
await ev(`document.querySelector('[data-testid=toast-undo]').focus()`); // focus holds the toast (its 8 s timer stops)
await setMode("bob");
const switched = await until(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`, 280);
await until(`document.querySelectorAll('[data-testid=doc-row]').length===1`);
const sw = JSON.parse(await ev(`JSON.stringify({toasts:document.querySelectorAll('[data-testid=toast]').length,alpha:/ALPHA/.test(document.documentElement.outerHTML),rows:[...document.querySelectorAll('[data-testid=doc-title]')].map(e=>e.textContent)})`));
ok(switched && sw.toasts === 0 && !sw.alpha && JSON.stringify(sw.rows) === JSON.stringify(["BRAVO plan"]),
  `live switch alice -> bob (no reload) with alice's toast held by focus: toast gone, no ALPHA in the page, bob's rows (${JSON.stringify(sw)})`);
await setMode("alice");

// ---- 9. acceptance 8: nothing kept in the browser; no cached /workbench read
await go("/documents");
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length,title:document.title}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0 && !/ALPHA/.test(keep.title), `storage, cookies, caches, IndexedDB hold nothing; title "${keep.title}"`);
await go(H(CPU));
ok(!/ALPHA/.test(await ev("document.title")), "the document screen's page title names no document");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");

// ---- 10. + Folder and + New document
await go("/documents");
await click("[data-testid=new-folder]"); await typeIn("[data-testid=folder-name]", "Reading"); await click("[data-testid=folder-ok]");
ok(await until(`[...document.querySelectorAll('[data-testid=folder]')].some(b=>b.textContent==='Reading0')`), "+ Folder adds Reading (0)");
await click("[data-testid=new-doc]"); await typeIn("[data-testid=doc-name]", "ALPHA fresh notes"); await click("[data-testid=doc-ok]");
ok(await until(`location.pathname===${JSON.stringify(H("documents/k-a/Reading/alpha-fresh-notes.md"))} && document.querySelector('h1')?.textContent==='ALPHA fresh notes'`), "+ New document makes it in the selected folder and opens it");

// ---- 11. keyboard and narrow screens
await go("/documents");
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 60; i++) {
  await key("Tab", "Tab", 9);
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||'',inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const main = stops.filter((s) => s.inMain);
for (const need of ["new-folder", "new-doc", "folder-all", "tab-active", "tab-trash", "doc-title", "act-open", "act-archive", "act-trash"]) ok(main.some((s) => s.t === need), `Tab reaches ${need}`);
ok(main.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${main.length} Tab stops on the screen show a focus ring of at least 2px`);
// Reflow (WCAG 1.4.10): neither the page nor the screen's own scroll container (main) scrolls sideways, and NO
// element inside main reaches past main's right edge - except inside the table's own scroll box (.docs-scroll,
// which may scroll; the box itself must fit). Checked on every tab and with the confirmation open.
for (const w of [800, 400]) {
  await viewport(w, 900);
  for (const step of ["active", "trash", "confirm"]) {
    await go("/documents");
    if (step !== "active") await tab("trash");
    if (step === "confirm") await click("[data-testid=empty-trash]");
    const o = JSON.parse(await ev(`(()=>{const m=document.querySelector('main');const mr=m.getBoundingClientRect().right;const de=document.documentElement;
      const wide=[...m.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>mr+1&&!(e.parentElement&&e.parentElement.closest('.docs-scroll'));})
        .slice(0,6).map(e=>(e.dataset.testid||e.className||e.tagName)+':'+Math.round(e.getBoundingClientRect().right)+'>'+Math.round(mr));
      return JSON.stringify({dsw:de.scrollWidth,dcw:de.clientWidth,msw:m.scrollWidth,mcw:m.clientWidth,wide});})()`));
    ok(o.dsw <= o.dcw && o.msw <= o.mcw && o.wide.length === 0,
      `at ${w}px (${step}): no sideways scroll of the page (${o.dsw}/${o.dcw}) or of main (${o.msw}/${o.mcw}); nothing in main past its edge ${JSON.stringify(o.wide)}`);
    if (step === "trash") {
      const vis = JSON.parse(await ev(`JSON.stringify(['empty-trash'].map(t=>{const e=document.querySelector('[data-testid='+t+']');const r=e.getBoundingClientRect();return r.left>=0&&r.right<=document.documentElement.clientWidth;}))`));
      ok(vis.every(Boolean), `at ${w}px: Empty the trash is on screen without scrolling sideways`);
    }
  }
  await axe(`light Documents at ${w}px`);
}
await viewport(1440, 900);

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
