// Headless-Chromium e2e for the Home screen (rwr-home), driven over CDP. Run by run-home-e2e.ps1 inside an
// --internal lab network with the stub in home.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
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
// open a path and wait until Home has no card still loading
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=rail]') && (!document.querySelector('[data-testid=home]') || (document.querySelectorAll('[data-testid=home] [role=status]').length===0 && !!document.querySelector('[data-testid=avatar]')))`)) break;
  }
  await sleep(200);
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
const titles = (card) => read(`[data-testid=card-${card}] .row-title`);

// ---- 1. alice: each card lists what its source read holds; no console problems; every request same-origin GET
await scheme("light"); await setMode("alice"); await go("/");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "What do you want to know?", "Home heading is the ask-box question");
ok(JSON.stringify(await titles("docs")) === JSON.stringify(["ALPHA newest draft", "ALPHA middle", "ALPHA older note"]), "Continue writing lists alice's three documents, newest edit first");
ok(JSON.stringify(await titles("research")) === JSON.stringify(["ALPHA which CPUs fit", "ALPHA finished question"]), "Research lists alice's two sessions");
ok(JSON.stringify(await titles("podcasts")) === JSON.stringify(["ALPHA digest episode", "ALPHA rendering now"]), "Podcasts lists the episode first, then the pending request (the done request once)");
ok(JSON.stringify(await titles("ideas")) === JSON.stringify(["ALPHA pantry idea"]), "Ideas lists alice's idea");
ok(/2 new sources, 682 new claims.*Shared source first/.test(await ev(`document.querySelector('[data-testid=new-counts]')?.textContent||''`)), "New in the library: 2 new sources, 1 new claim");
ok(/14292 claims backed by one source only/.test(await ev(`document.querySelector('[data-testid=claims-waiting]')?.textContent||''`)), "Claims waiting for a second source: 2");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
const rq = reqs();
ok(rq.every((r) => r.url.startsWith(origin + "/")) && rq.filter((r) => /\/workbench\//.test(r.url)).every((r) => r.method === "GET"), `every request same-origin, every read a GET (${rq.length})`);
const lg = await stub("/__log");
ok(lg.every((x) => x.keyOk && x.method === "GET"), "the stub saw only GET reads, all with the door key");
ok(lg.every((x) => !/alice|bob|nobody|u-/i.test(x.url)), "no request URL names a person");

// ---- 2. every card title opens its screen
const TITLES = [["docs", "/documents"], ["research", "/research"], ["podcasts", "/podcasts"], ["ideas", "/ideas"], ["library", "/library"], ["claims", "/library"]];
for (const [t, path] of TITLES) {
  await go("/");
  await ev(`document.querySelector('[data-testid=title-${t}]').click()`);
  await sleep(150);
  // Documents is a built screen (rwr-docs-list); the others still show their coming-in-phase state
  const o = JSON.parse(await ev(`JSON.stringify({p:location.pathname,coming:!!document.querySelector('[data-testid=coming]'),docs:!!document.querySelector('[data-testid=documents]')})`));
  ok(o.p === path && (t === "docs" ? o.docs && !o.coming : o.coming), `title "${t}" opens ${path} (${o.p}, coming-state ${o.coming}, documents ${o.docs})`);
}
await go("/");
await ev(`document.querySelector('[data-testid=card-docs] [data-testid=row-doc]').click()`); await sleep(150);
ok((await ev(`location.pathname`)) === "/documents/d/a0000000-0000-4000-8000-0000000000a2", "a document row opens /documents/d/<its opaque id> (never its path or title)");
ok(!!(await ev(`!!document.querySelector('[data-testid=document]') && !document.querySelector('[data-testid=not-found]')`)), "...and lands on the document screen (not No such screen)");
ok(!(await ev(`[...document.querySelectorAll('a[href]')].some(a => /alpha|%2F|\\.md/i.test(a.getAttribute('href')))`)), "no link on the page names a document's path or title");
await send("Page.navigate", { url: origin + "/documents/d/a0000000-0000-4000-8000-0000000000a2" }); await sleep(1500);
ok(!!(await ev(`!!document.querySelector('[data-testid=document]') && !document.querySelector('[data-testid=not-found]')`)), "...also when that URL is loaded fresh");
await go("/");
await ev(`[...document.querySelectorAll('[data-testid=ask] a')].find(a=>a.textContent==='Start research').click()`); await sleep(150);
ok((await ev(`location.pathname`)) === "/research/start", "Start research opens /research/start");

// ---- 3. the ask box: a search, results, no trace
await go("/");
await ev(`document.querySelector('[data-testid=ask-input]').focus()`);
for (const ch of "cpu") await send("Input.insertText", { text: ch });
await key("Enter", "Enter", 13);
for (let i = 0; i < 30 && !(await ev(`document.querySelectorAll('[data-testid=hit]').length`)); i++) await sleep(150);
const hits = await read("[data-testid=hit] .row-title");
ok(JSON.stringify(hits) === JSON.stringify(["Shared source about cpu", "Shared claim about cpu"]), `Enter in the ask box runs a search and lists the hits: ${JSON.stringify(hits)}`);
ok(!/<<|HL>>/.test(await ev(`document.querySelector('[data-testid=ask-results]').textContent`)), "highlight markers are stripped");
const sl = (await stub("/__log")).filter((x) => x.url.startsWith("/workbench/contract/search"));
ok(sl.length === 1 && sl[0].url === "/workbench/contract/search?q=cpu&limit=10" && sl[0].keyOk, "exactly one search read: " + (sl[0]?.url || "none"));
ok(await ev(`location.search===''&&location.pathname==='/'`), "the question is not put in the URL");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Home with search results`); }
await scheme("light");
await ev(`document.querySelector('[data-testid=hit]').click()`); await sleep(150);
ok((await ev(`location.pathname`)) === "/library", "a hit opens the Library");

// ---- 4. empty states (a subject with nothing, an empty shared library)
await setMode("nobody"); await stub("/__library/empty");
await go("/");
const empties = await read("[data-testid^=empty-]");
ok(empties.length === 6 && empties.every((t) => !t.includes("\n")), `six empty states, one line each: ${JSON.stringify(empties)}`);
ok(JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid^=empty-] a')].map(a=>a.getAttribute('href')))`)) === JSON.stringify(JSON.stringify(["/documents", "/research/start", "/podcasts", "/ideas", "/library", "/library"])), "each empty state carries its action link");
const nb = await ev(`document.querySelector('[data-testid=card-research]').textContent`);
ok(!/[0-9]/.test(nb), `Research card for a subject with nothing shows no number although another user's session came back from the read: "${nb}"`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Home, every card empty`); }
await scheme("light"); await stub("/__library/full");

// ---- 5. two identities: bob after alice, same browser
await setMode("alice"); await go("/");
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]),idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(!/alpha|alice/i.test(JSON.stringify(keep)) && keep.caches.length === 0 && keep.idb === 0 && keep.ls && JSON.stringify(keep.ls) === "{}", `nothing of alice in storage, cookies, Cache API or IndexedDB: ${JSON.stringify(keep)}`);
await setMode("bob"); await go("/");
const bodyB = await ev(`document.body.innerText`);
ok(!/ALPHA|alice|Alice/i.test(bodyB), "bob's Home shows no ALPHA item, no 'alice'");
ok(JSON.stringify(await titles("docs")) === JSON.stringify(["BRAVO plan"]) && JSON.stringify(await titles("research")) === JSON.stringify(["BRAVO own question"]), "bob sees his own document and session");
const bl = (await stub("/__log")).filter((x) => x.mode === "bob" && x.url.startsWith("/workbench/contract/sessions"));
ok(bl.length >= 1, "bob's sessions read was made (and returned alice's card, which Home does not show)");
ok(!/3 branches|2 open branches/.test(await ev(`document.querySelector('[data-testid=card-research]').textContent`)), "alice's session leaves no count or hint on bob's Research card");
ok(!/ALPHA/.test(await ev(`document.documentElement.outerHTML`)), "bob's page source holds no ALPHA text at all");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Home as bob`); }
await scheme("light");

// ---- 5a. live switch: alice has Home open, the identity changes, the shell's 30 s whoami refresh shows bob
await setMode("alice"); await go("/");
ok((await titles("docs")).some((t) => /ALPHA/.test(t)), "live switch: alice's Home is showing her documents");
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob (the shell's refresh)");
for (let i = 0; i < 20 && (await ev(`document.querySelectorAll('[data-testid=home] [role=status]').length`)) > 0; i++) await sleep(250);
ok(!/ALPHA|alice/i.test(await ev(`document.body.innerText`)) && JSON.stringify(await titles("docs")) === JSON.stringify(["BRAVO plan"]), "live switch: Home dropped alice's cards and shows bob's own, no ALPHA anywhere");
await scheme("dark"); await axe("dark Home after a live switch"); await scheme("light");
await setMode("alice");

// ---- 5b. a non-owner admin: can_act on everything and sees the text, but Home lists only what they own
await setMode("admin"); await go("/");
ok(!/ALPHA|SERVICE/.test(await ev(`document.body.innerText`)) && !!(await ev(`!!document.querySelector('[data-testid=empty-research]')`)), "admin who owns no session: Home shows no one else's session text and the Research card is empty");
ok(!/[0-9]/.test(await ev(`document.querySelector('[data-testid=card-research]').textContent`)), "admin: no count or hint on the Research card");
await scheme("dark"); await axe("dark Home as a non-owner admin"); await scheme("light");

// ---- 6. a failing read blanks one card
await setMode("broken"); await go("/");
ok((await read("[data-testid=failed-podcasts]")).length === 1 && JSON.stringify(await titles("docs")).includes("ALPHA newest draft"), "podcasts fail alone: that card says so, the others load");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Home with a failed card`); }
await scheme("light");

// ---- 7. full Home, light and dark, narrow screen, keyboard
await setMode("alice");
for (const sch of ["light", "dark"]) { await scheme(sch); await go("/"); await axe(`${sch} Home (alice, all cards)`); }
await scheme("light");
await ev(`localStorage.setItem('workbench.theme','dark')`); await go("/");
await axe("explicit dark choice on Home");
await ev(`localStorage.removeItem('workbench.theme')`);
await viewport(800, 900); await go("/");
const ov = JSON.parse(await ev(`JSON.stringify({sw:document.querySelector('main').scrollWidth,cw:document.querySelector('main').clientWidth,cols:getComputedStyle(document.querySelector('.grid3')).gridTemplateColumns.split(' ').length})`));
ok(ov.sw <= ov.cw && ov.cols === 1, `at 800px wide: no horizontal scroll (${ov.sw}/${ov.cw}), cards stack in one column (${ov.cols})`);
await axe("light Home at 800px");
await viewport(400, 800); await go("/");
const ov4 = JSON.parse(await ev(`JSON.stringify({sw:document.querySelector('main').scrollWidth,cw:document.querySelector('main').clientWidth})`));
ok(ov4.sw <= ov4.cw, `at 400px wide with a long unbroken address in a claim: no inner horizontal scroll (${ov4.sw}/${ov4.cw})`);
await axe("light Home at 400px");
await viewport(1440, 900);
await viewport(1440, 900); await go("/");
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 60; i++) {
  await key("Tab", "Tab", 9);
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,24),inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const main = stops.filter((s) => s.inMain);
for (const need of ["ask-input", "title-docs", "title-research", "title-podcasts", "title-ideas", "title-library", "title-claims"]) ok(main.some((s) => s.t === need), `Tab reaches ${need}`);
ok(main.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${main.length} Tab stops on the screen show a focus ring of at least 2px`);
// the Ask button is disabled (not focusable) until two characters are typed; then Tab from the input reaches it
await ev(`document.querySelector('[data-testid=ask-input]').focus()`);
await send("Input.insertText", { text: "cpu" });
await key("Tab", "Tab", 9);
ok((await ev(`document.activeElement.dataset.testid`)) === "ask-go", "after typing, Tab from the ask box reaches the Ask button");
// the page after all this holds nothing
const after = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme').length,ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(after.ls === 0 && after.ss === 0 && after.ck === "" && after.caches === 0 && after.idb === 0, `at the end: storage, cookies, caches, IndexedDB hold nothing: ${JSON.stringify(after)}`);
await go("/");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
