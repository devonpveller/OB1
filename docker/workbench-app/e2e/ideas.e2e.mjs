// Headless-Chromium e2e for the Ideas screen (rwr-ideas), driven over CDP. Run by run-ideas-e2e.ps1 inside an
// --internal lab network with the stub in ideas.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
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
const read = (sel) => ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
// open a path and wait until the Ideas screen has finished loading (or the page, for any other path)
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && !document.querySelector('[data-testid=ideas-loading],[data-testid=idea-loading],[data-testid=ideas-waiting]')`)) break;
  }
  await sleep(200);
};
const ids = await stub("/__ids");
const rowTitles = () => read("[data-testid=idea-row] .idea-pick-title");
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const clickRow = (title) => ev(`[...document.querySelectorAll('[data-testid=idea-row]')].find(r=>r.querySelector('.idea-pick-title').textContent===${JSON.stringify(title)}).click()`);
const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 150; i++) { if (await ev(expr)) return true; await sleep(150); } return false; };
const hook = (name, o = {}) => fetch(`http://stub:9000/__hook/${name}`, { method: "POST", body: JSON.stringify(o) }).then((r) => r.json());
const idState = (id) => stub(`/__state/${id}`);
const A_TITLES = ["ALPHA Move the wiki to the cluster", "ALPHA Plan the CPU upgrade"];

// ---- 1. alice: the list by state, every idea private, the first idea open; no console problems; the door
await scheme("light"); await setMode("alice"); await go("/ideas");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "Ideas" && (await ev(`document.title`)) === "Ideas - Research workbench", "the Ideas screen opens with its heading and a title that names no idea");
const groups = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid^=group-] h2')].map(h=>h.textContent))`));
ok(JSON.stringify(groups) === JSON.stringify(["New · 1", "Refining · 2", "Archived · 1"]), `the list is grouped by state: ${JSON.stringify(groups)}`);
ok((await rowTitles()).length === 4 && (await rowTitles())[0] === A_TITLES[0], "alice's four ideas are listed, none of bob's");
ok((await read("[data-testid=idea-row] .meta")).every((t) => /private to you/.test(t)), "every idea row says it is private to you");
ok((await ev(`document.querySelector('[data-testid=idea-private]')?.textContent`)) === "private to you", "the open idea says private to you");
ok(!/Discuss it|Refine it in chat/.test(await ev(`document.body.innerText`)), "Discuss it and Refine it in chat are not shown");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
const rq1 = reqs().filter((r) => /\/workbench\//.test(r.url));
ok(rq1.every((r) => r.url.startsWith(origin + "/") && r.method === "GET"), `opening the screen made only same-origin GET reads (${rq1.length})`);
ok((await stub("/__log")).every((x) => x.keyOk), "the stub saw the door key on every request");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Ideas, first idea open`); }
await scheme("light");

// ---- 2. the open idea: wording, from, when, what belongs to it, how it changed
await clickRow("ALPHA Plan the CPU upgrade");
await waitFor(`document.querySelector('[data-testid=idea-title]')?.textContent==='ALPHA Plan the CPU upgrade'`);
const view = await ev(`document.querySelector('[data-testid=idea-view]').innerText`);
ok(/researched/.test(view) && /captured 14 days ago · from a thought you captured/.test(view), "state, when and from are shown");
const mem = await read("[data-testid=belongs] [data-testid=mem]");
ok(mem.length === 4 && /^Research/.test(mem[0]) && /Which LGA2066/.test(mem[0]), `what belongs to it: ${JSON.stringify(mem)}`);
const revs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=rev]')].map(r=>[r.dataset.revision,r.dataset.runId||null]))`));
ok(JSON.stringify(revs) === JSON.stringify([["2", null], ["1", "job-old"]]), `how it changed: ${JSON.stringify(revs)}`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Ideas, an idea with members and revisions`); }
await scheme("light");

// ---- 3. Revise (by keyboard), earlier runs stay with their wording
await ev(`document.querySelector('[data-testid=act-revise]').focus()`);
await key("Enter", "Enter", 13);
ok(await waitFor(`document.activeElement?.dataset?.testid==='revise-text'`), "Revise opens the form with the cursor in the wording");
await send("Input.insertText", { text: " ALPHA and also check the cooler" });
await axe("light Ideas with the Revise form open"); await scheme("dark"); await axe("dark Ideas with the Revise form open"); await scheme("light");
await ev(`document.querySelector('[data-testid=revise-save]').focus()`);
await key("Enter", "Enter", 13);
ok(await waitFor(`document.querySelectorAll('[data-testid=rev]').length===3`), "Save adds a third revision to the log");
const st = await idState(ids.cpu);
ok(JSON.stringify(st.revisions.map((r) => [r.revision, r.research_job_id])) === JSON.stringify([[1, "job-old"], [2, null], [3, null]]), "server side: the run still belongs to revision 1; revisions 2 and 3 have none (by id)");
ok(JSON.stringify(JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=rev]')].map(r=>[r.dataset.revision,r.dataset.runId||null]))`))) === JSON.stringify([["3", null], ["2", null], ["1", "job-old"]]), "the screen agrees: the old run hangs on its own wording");
const toastText = await ev(`document.querySelector('[data-testid=toasts]').textContent`);
ok(/Saved as revision 3/.test(toastText), `a toast says so: "${toastText}"`);
const focusAt = await ev(`(()=>{const e=document.activeElement;return (e&&(e.dataset.testid||e.tagName))+' disabled='+(e&&e.disabled)})()`);
ok(/^act-revise/.test(focusAt), `the cursor is back on Revise: ${focusAt}`);
if (process.env.ONLY === "revise") { console.log(fails ? "E2E FAIL (partial)" : "E2E PASS (partial)"); process.exit(fails ? 1 : 0); }
await hook("form-run", { id: ids.cpu, query: "the question for the third wording" });
await clickRow("ALPHA Move the wiki to the cluster"); await clickRow("ALPHA Plan the CPU upgrade");
await waitFor(`document.querySelectorAll('[data-testid=rev]').length===3`);
ok(JSON.stringify(JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=rev]')].map(r=>[r.dataset.revision,!!r.dataset.runId]))`))) === JSON.stringify([["3", true], ["2", false], ["1", true]]), "the boundary's run for the new wording joins revision 3 only");

// ---- 4. Research this idea: the idea's own research-now, never Start research
const before = (await stub("/__log")).length;
await click("[data-testid=act-research]");
ok(await waitFor(`document.querySelector('[data-testid=research-state]')?.dataset.state`), "Research this idea shows the state of the request");
const after = (await stub("/__log")).slice(before);
const posts = after.filter((x) => x.method === "POST").map((x) => x.url);
ok(JSON.stringify(posts) === JSON.stringify([`/workbench/ideas/${ids.cpu}/research-now`]), `exactly one write: ${JSON.stringify(posts)}`);
ok(!after.some((x) => /^\/workbench\/research(\/|\?|$)/.test(x.url)) && (await ev(`location.pathname`)) === "/ideas", "no call to /workbench/research and the screen did not leave Ideas");

// ---- 5. Archive, then Reopen, by keyboard and with Undo
const wasState = (await idState(ids.cpu)).status;
await ev(`document.querySelector('[data-testid=act-archive]').focus()`);
await key("Enter", "Enter", 13);
ok(await waitFor(`!!document.querySelector('[data-testid=act-reopen]')`), "Archive: the idea shows Reopen");
ok((await idState(ids.cpu)).status === "archived", "server side: archived");
ok(/Archived · 2/.test(await ev(`document.querySelector('[data-testid=group-archived] h2').textContent`)), "it moved to Archived");
ok(await ev(`document.querySelector('[data-testid=act-research]').disabled && document.querySelector('[data-testid=act-revise]').disabled`), "while archived, Research and Revise are off");
ok(!/Plan the CPU|ALPHA/.test(await ev(`document.querySelector('[data-testid=toasts]').textContent`)), "the toast carries none of the idea's words");
await axe("light Ideas, an archived idea"); await scheme("dark"); await axe("dark Ideas, an archived idea"); await scheme("light");
await click("[data-testid=toast-undo]");
ok(await waitFor(`!!document.querySelector('[data-testid=act-archive]')`), "Undo reopened it");
ok((await idState(ids.cpu)).status === wasState, "server side: back in the state it was archived from");
await click("[data-testid=act-archive]"); await waitFor(`!!document.querySelector('[data-testid=act-reopen]')`);
await click("[data-testid=act-reopen]"); await waitFor(`!!document.querySelector('[data-testid=act-archive]')`);
const back = await idState(ids.cpu);
ok(back.status === wasState && back.revisions.length === 3 && back.summary.includes("check the cooler"), "Reopen brings it back exactly as it was: same state, same wording, same revisions");

// ---- 6. the owner's review of a research question
await hook("await-owner", { id: ids.cpu, candidate: "Which CPUs fit this board?", failing: ["Acme"] });
await clickRow("ALPHA Move the wiki to the cluster"); await clickRow("ALPHA Plan the CPU upgrade");
ok(await waitFor(`!!document.querySelector('[data-testid=review-question]')`), "a request that waits for its owner shows the question to edit");
await axe("light Ideas with the owner's review"); await scheme("dark"); await axe("dark Ideas with the owner's review"); await scheme("light");
await click("[data-testid=review-private]");
ok(await waitFor(`document.querySelector('[data-testid=research-state]')?.dataset.state==='queued'`), "Run it privately queues it");

// ---- 7. no tab stop without a focus ring; every control reachable by keyboard
await go("/ideas");
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 50; i++) {
  await key("Tab", "Tab", 9);
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,24),inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const mainStops = stops.filter((s) => s.inMain);
for (const need of ["idea-row", "act-research", "act-document", "act-revise", "act-archive"]) ok(mainStops.some((s) => s.t === need), `Tab reaches ${need}`);
ok(mainStops.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${mainStops.length} Tab stops on the screen show a focus ring of at least 2px`);

// ---- 8. narrow screens: nothing scrolls sideways, nothing sticks out, with a 220-character unbroken title
await clickRow("ALPHA Unbroken" + "x".repeat(220));
await waitFor(`/Unbroken/.test(document.querySelector('[data-testid=idea-title]')?.textContent||'')`);
for (const w of [800, 400]) {
  await viewport(w, 900); await sleep(300);
  const o = JSON.parse(await ev(`(()=>{const m=document.querySelector('main');const r=m.getBoundingClientRect();const bad=[...m.querySelectorAll('*')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>r.right+1||b.left<r.left-1)}).map(e=>(e.dataset.testid||e.className||e.tagName).toString().slice(0,40));return JSON.stringify({sw:m.scrollWidth,cw:m.clientWidth,bad:bad.slice(0,6),dw:document.documentElement.scrollWidth,vw:innerWidth})})()`));
  ok(o.sw <= o.cw && o.bad.length === 0 && o.dw <= o.vw, `at ${w}px: no horizontal scroll (${o.sw}/${o.cw}), no element outside the screen ${JSON.stringify(o.bad)}`);
  await axe(`light Ideas at ${w}px`);
  await scheme("dark"); await axe(`dark Ideas at ${w}px`); await scheme("light");
}
await ev(`document.querySelector('[data-testid=act-revise]').click()`);
await sleep(200);
const ov = JSON.parse(await ev(`(()=>{const m=document.querySelector('main');const r=m.getBoundingClientRect();const bad=[...m.querySelectorAll('*')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>r.right+1}).length;return JSON.stringify({bad,sw:m.scrollWidth,cw:m.clientWidth})})()`));
ok(ov.bad === 0 && ov.sw <= ov.cw, `at 400px with the Revise form open: nothing sticks out (${JSON.stringify(ov)})`);
await viewport(1440, 900);

// ---- 9. empty state and a failed read
await setMode("nobody"); await go("/ideas");
ok(!!(await ev(`!!document.querySelector('[data-testid=ideas-empty]')`)) && !(await ev(`!!document.querySelector('[data-testid=ideas-failed]')`)), "a person with no ideas sees an empty state, not an error");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Ideas, empty`); }
await scheme("light");
await setMode("alice"); await hook("fail-list", { on: true }); await go("/ideas");
ok(!!(await ev(`!!document.querySelector('[data-testid=ideas-failed]')`)), "a failing read says so, with Try again");
await axe("light Ideas, failed read");
await hook("fail-list", { on: false });

// ---- 10. two identities: bob after alice, same browser
await setMode("alice"); await go("/ideas");
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]),idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(!/alpha|alice|ideas/i.test(JSON.stringify(keep)) && keep.caches.length === 0 && keep.idb === 0, `nothing of alice in storage, cookies, Cache API or IndexedDB: ${JSON.stringify(keep)}`);
const aliceStatus = (await idState(ids.cpu)).status;
await setMode("bob"); await go("/ideas");
ok(JSON.stringify(await rowTitles()) === JSON.stringify(["BRAVO Bob's idea"]), "bob sees only his own idea");
ok(!/ALPHA|alice|Alice|Move the wiki|CPU upgrade|weekly podcast|Unbroken/.test(await ev(`document.documentElement.outerHTML`)), "bob's page source holds nothing of alice's: no marker, no title, no count");
const probe = JSON.parse(await ev(`(async()=>{const get=async(id)=>{const r=await fetch('/workbench/contract/ideas/'+id);return [r.status,await r.text()]};const post=async(id,v)=>{const r=await fetch('/workbench/ideas/'+id+'/'+v,{method:'POST',headers:{'content-type':'application/json'},body:'{"summary":"x"}'});return [r.status,await r.text()]};
  const miss='a1000000-0000-4000-8000-0000000000ff';const out={};out.get=[await get(${JSON.stringify(ids.cpu)}),await get(miss)];for(const v of ['edit','research-now','archive','reopen'])out[v]=[await post(${JSON.stringify(ids.cpu)},v),await post(miss,v)];return JSON.stringify(out)})()`));
ok(Object.values(probe).every(([a, b]) => a[0] === 404 && a[0] === b[0] && a[1] === b[1]), "bob asking for alice's idea (read, edit, research now, archive, reopen) gets the answer a missing idea gets");
ok((await idState(ids.cpu)).status === aliceStatus, "bob's calls changed nothing of alice's");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Ideas as bob`); }
await scheme("light");

// ---- 11. live switch: alice has a half-typed revision open, the identity changes, the shell's refresh shows bob
await setMode("alice"); await go("/ideas");
// alice archives an idea (its Undo toast is held by focus, as a keyboard user would), then types an unsent revision on another
await click("[data-testid=act-archive]");
ok(await waitFor(`!!document.querySelector('[data-testid=toast-undo]')`), "live switch: alice's archive toast with its Undo is up");
await ev(`document.querySelector('[data-testid=toast-undo]').focus()`);
const wikiId = ids.wiki, logBefore = (await stub("/__log")).length;
await clickRow("ALPHA Plan the CPU upgrade");
await click("[data-testid=act-revise]");
await send("Input.insertText", { text: " ALPHA-UNSENT-DRAFT" });
ok(/ALPHA-UNSENT-DRAFT/.test(await ev(`document.querySelector('[data-testid=revise-text]')?.value||''`)), "live switch: alice has an unsent revision typed");
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob (the shell's refresh)");
await waitFor(`!document.querySelector('[data-testid=ideas-loading]')`, 10000);
ok(!/ALPHA|alice|UNSENT/i.test(await ev(`document.documentElement.outerHTML`)) && JSON.stringify(await rowTitles()) === JSON.stringify(["BRAVO Bob's idea"]) && !(await ev(`!!document.querySelector('[data-testid=revise-form]')`)), "live switch: the list, the open idea and the unsent draft are gone; bob's own idea is shown, no ALPHA anywhere");
// the Undo toast of alice's archive, still on screen after the switch, does nothing for bob
const undoLeft = await ev(`!!document.querySelector('[data-testid=toast-undo]')`);
if (undoLeft) await click("[data-testid=toast-undo]");
await sleep(600);
const afterSwitch = (await stub("/__log")).slice(logBefore).filter((x) => x.who === "bob");
ok(!afterSwitch.some((x) => x.method === "POST"), `live switch: the Undo of alice's archive made no write for bob (${undoLeft ? "clicked" : "toast already gone"})`);
ok((await idState(wikiId)).status === "archived", "live switch: alice's idea stays archived");
await scheme("dark"); await axe("dark Ideas after a live switch"); await scheme("light");
await setMode("alice");

// ---- 12. nothing kept
await go("/ideas");
const fin = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme').length,ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(fin.ls === 0 && fin.ss === 0 && fin.ck === "" && fin.caches === 0 && fin.idb === 0, `at the end: storage, cookies, caches, IndexedDB hold nothing: ${JSON.stringify(fin)}`);
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
const lgAll = await stub("/__log");
ok(lgAll.every((x) => x.keyOk) && lgAll.every((x) => !/alpha|bravo|u-alice|u-bob/i.test(x.url)), "every request carried the door key and no URL names a person or an idea's words");

// ---- 13. a document link is /documents/d/<id> (rwr-doc-opaque-urls): Create a document, then follow Open its document
// (run last: the document screen's own reads name the document by path, which the check above is about the Ideas screen's own requests)
await setMode("alice"); await go("/ideas");
await clickRow("ALPHA Plan the CPU upgrade");
await waitFor(`document.querySelector('[data-testid=idea-title]')?.textContent==='ALPHA Plan the CPU upgrade'`);
const OPAQUE = "^/documents/d/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const LEAKRE = "u-alice|alpha|plan-the|cpu|[.]md|%2F|documents/u";
await click("[data-testid=act-document]");
ok(await waitFor(`new RegExp(${JSON.stringify(OPAQUE)}).test(location.pathname)`), "Create a document: the address becomes /documents/d/<id>");
ok(!(await ev(`new RegExp(${JSON.stringify(LEAKRE)}, 'i').test(decodeURIComponent(location.pathname + location.search + location.hash))`)), "Create a document: the address holds no owner key, title word, slug or .md");
await go("/ideas"); await clickRow("ALPHA Plan the CPU upgrade");
ok(await waitFor(`document.querySelector('[data-testid=act-document]')?.tagName==='A' && !!document.querySelector('[data-testid=belongs] a[href^="/documents/"]')`), "an idea with a document shows Open its document as a link, and the document under what belongs to it");
const docLinks = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('a[href^="/documents"]')].map(a=>a.getAttribute('href')))`));
ok(docLinks.length === 2 && docLinks.every((h) => new RegExp(OPAQUE).test(h)) && docLinks[0] === docLinks[1], `both document links are /documents/d/<id>: ${JSON.stringify(docLinks)}`);
await click("[data-testid=act-document]");
ok(await waitFor(`location.pathname===${JSON.stringify(docLinks[0])}`), "following Open its document lands on /documents/d/<id>");
ok(!(await ev(`new RegExp(${JSON.stringify(LEAKRE)}, 'i').test(decodeURIComponent(location.pathname))`)), "the address after following the link names no person, idea word or file");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
