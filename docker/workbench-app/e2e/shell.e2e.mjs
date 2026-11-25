// Headless-Chromium e2e for the shell (rwr-shell-nav), driven over CDP. Run by run-e2e.ps1 inside an
// --internal lab network. Env: APP_IP, CH (Chrome host, default 127.0.0.1), LAB_KEY. /axe/axe.min.js is axe-core.
// Every check prints PASS/FAIL; the exit code is the number of failures (0 = pass).
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1", KEY = process.env.LAB_KEY || "";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MENU = [
  ["/", "Home", 0], ["/research", "Research", 3], ["/chat", "Chat", 4], ["/documents", "Documents", null], ["/ideas", "Ideas", null],
  ["/podcasts", "Podcasts", 3], ["/library", "Library", 2], ["/imports", "Imports", null], ["/removals", "Removals and trail", 5],
  ["/cleanup", "Cleanup", 5], ["/settings", "Settings", 6],
];
const ALL = [...MENU, ["/what-moved-where", "What moved where", null]];

const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map(); const events = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
await send("Network.setCacheDisabled", { cacheDisabled: false });

const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 40; i++) { await sleep(150); if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=count-research], [data-testid=avatar]')`)) break; }
  await sleep(200);
};
const reqs = () => events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => ({ method: e.params.request.method, url: e.params.request.url, type: e.params.type }));
// The lab serves plain http on an IP, so Chrome logs that the COOP header it ignores needs https: a property of the lab, not of the app.
const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) || e.method === "Runtime.exceptionThrown"
  || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)));

const AXE = readFileSync("/axe/axe.min.js", "utf8");
async function axe(label) {
  await ev(AXE + ";1");
  const r = await ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,120)).slice(0,4)})),pass:r.passes.length,cc:(r.passes.find(p=>p.id==='color-contrast')||{nodes:[]}).nodes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed, ${r.cc} elements checked for contrast)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
  return r;
}

// ---- 1. every route, opened directly and by clicking its menu entry: never blank, plain phase message, no errors
await setMode("alice");
await scheme("light");
for (const [path, label, phase] of ALL.filter((a) => a[0] !== "/")) { // Home, Documents and Imports are real screens (phase null: no placeholder): home.e2e.mjs, docs.e2e.mjs, imports.e2e.mjs
  await go(path);
  const s = await ev(`JSON.stringify({h1:document.querySelector('h1')?.textContent, coming:document.querySelector('[data-testid=coming]')?.textContent||null, len:document.querySelector('main').innerText.trim().length, cur:document.querySelector('[aria-current=page]')?.textContent?.replace(/\\d+ \\w+( \\w+)?$/,'').trim(), title:document.title})`);
  const o = JSON.parse(s);
  ok(o.h1 === label && o.len > 20, `route ${path}: heading "${o.h1}", ${o.len} characters of content`);
  if (phase !== null) ok(o.coming === `This screen is coming in phase ${phase}.`, `route ${path}: "${o.coming}"`);
  ok(problems().length === 0, `route ${path}: ${problems().length} console errors/warnings/exceptions` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text || e.params?.type)));
  ok(reqs().every((r) => r.url.startsWith(origin + "/")), `route ${path}: every request same-origin (${reqs().length})`);
}
await go("/");
for (const [path, label] of ALL.slice(1)) {
  await ev(`[...document.querySelectorAll('nav a')].find(a=>a.getAttribute('href')==='${path}').click()`);
  await sleep(100);
  const o = JSON.parse(await ev(`JSON.stringify({p:location.pathname,h1:document.querySelector('h1')?.textContent,cur:document.querySelector('nav [aria-current=page]')?.getAttribute('href')})`));
  ok(o.p === path && o.h1 === label && o.cur === path, `click ${label}: URL ${o.p}, heading "${o.h1}", current item ${o.cur}`);
}
await go("/deep/unknown/path");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "No such screen", "an unknown path says so (not blank)");
await go("/documents/abc"); // an old path-form address: resolved (a 404 here) and replaced by the id form of nothing
ok((await ev(`location.pathname`)) === "/documents/d/none" || await (async () => { for (let i = 0; i < 20 && (await ev(`location.pathname`)) !== "/documents/d/none"; i++) await sleep(150); return (await ev(`location.pathname`)) === "/documents/d/none"; })(), "an old /documents/<path> address is replaced by /documents/d/none (the path is not kept in the address)");
for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('[data-testid=doc-gone]')`)); i++) await sleep(150);
ok((await ev(`!!document.querySelector('[data-testid=document]') && !document.querySelector('[data-testid=not-found]')`)), "a deep link /documents/abc opens the document screen (which says there is no such document), not No such screen");

// ---- 2. counts equal the stub's fixture (alice: 2 sessions, 1 retry job of 3, 3 sources + 1 candidate with evidence)
await go("/research"); // not Home: Home makes its own reads
let c = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid^=count-]')].map(e=>[e.dataset.testid,e.textContent]))`));
ok(JSON.stringify(c) === JSON.stringify([["count-research", "2 running"], ["count-imports", "1 failed"], ["count-cleanup", "4 to review"]]), `counts as the reads: ${JSON.stringify(c)}`);
const lg = await stub("/__log");
const seenPaths = [...new Set(lg.map((x) => x.url.split("?")[0]))].sort();
const SIX = ["/workbench/auth/me", "/workbench/contract/cleanup/reopen-candidates", "/workbench/contract/cleanup/sources", "/workbench/contract/sessions", "/workbench/intake/jobs", "/workbench/workspace/whoami"];
// the stub's log also holds the Home visits earlier in this run (Home's own reads are checked in home.e2e.mjs)
ok(SIX.every((x) => seenPaths.includes(x)) && lg.every((x) => x.method === "GET" && x.keyOk), `the stub saw the shell's 6 GET reads, all with the door key: ${seenPaths.join(", ")}`);
ok(["/workbench/settings", "/workbench/documents/file", "/workbench/documents/state"].every((x) => seenPaths.includes(x)), `and the account's reads (settings, then the locked document's state and title) are in the log too`);
// the exact set: bar Home's own named reads (checked in home.e2e.mjs), the shell and the account read nothing beyond the
// six and the account's three (settings, the locked document's file and state)
const HOME_READS = ["/workbench/contract/documents", "/workbench/documents/folders", "/workbench/contract/ideas", "/workbench/contract/library/recent", "/workbench/contract/library/waiting-claims", "/workbench/contract/podcasts", "/workbench/contract/podcasts/requests", "/workbench/contract/search"];
const shellReads = seenPaths.filter((p) => !HOME_READS.includes(p));
ok(shellReads.join() === [...SIX, "/workbench/documents/file", "/workbench/documents/resolve", "/workbench/documents/state", "/workbench/settings"].sort().join(), `exactly those: the shell and the account read only the six and the four (the opaque id's resolve read is the deep link's): ${shellReads.join(", ")}`);

// ---- 3. Ctrl+K opens, Esc closes, over every screen (real key events)
for (const [path] of ALL) {
  await go(path);
  await key("k", "KeyK", 75, 2);
  await sleep(120);
  const open = await ev(`JSON.stringify({d:!!document.querySelector('[role=dialog]'),f:document.activeElement?.dataset?.testid,items:document.querySelectorAll('[role=dialog] li, [role=dialog] [role=option]').length})`);
  const o = JSON.parse(open);
  await key("Escape", "Escape", 27);
  await sleep(120);
  const closed = await ev(`!document.querySelector('[role=dialog]')`);
  ok(o.d && o.f === "search-close" && o.items === 0 && closed, `Ctrl+K on ${path}: opens (focus in it, empty), Esc closes`);
}

// ---- 4. keyboard: Tab reaches every menu item, each with a visible focus ring
await go("/");
await ev(`document.body.focus(); document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 40; i++) {
  await key("Tab", "Tab", 9);
  const s = await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,30),href:e.getAttribute('href'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`);
  stops.push(JSON.parse(s));
  if (stops.at(-1).t === "theme") break;
}
const navHrefs = MENU.map((m) => m[0]).concat("/what-moved-where");
const reached = navHrefs.filter((h) => stops.some((s) => s.href === h));
ok(reached.length === navHrefs.length, `Tab reaches all ${navHrefs.length} menu items (${reached.length}); order: ${stops.map((s) => s.t).join(" > ")}`);
const noRing = stops.filter((s) => !(s.fv && s.os !== "none" && s.ow >= 2));
ok(noRing.length === 0, `every stop on the way (${stops.length}) shows a focus ring of at least 2px` + (noRing.length ? " missing: " + JSON.stringify(noRing) : ""));
await scheme("dark");
await go("/");
await ev(`document.activeElement.blur()`);
let ringDark = 0, n = 0;
for (let i = 0; i < 40; i++) { await key("Tab", "Tab", 9); const s = JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||'',os:cs.outlineStyle,ow:parseFloat(cs.outlineWidth),c:cs.outlineColor,bg:getComputedStyle(document.body).backgroundColor})})()`)); n++; if (s.os !== "none" && s.ow >= 2) ringDark++; if (s.t === "theme") break; }
ok(ringDark === n, `dark: ${ringDark} of ${n} Tab stops show a focus ring`);

// ---- 5. WCAG AA contrast and the rest of axe, light and dark, on every screen, the overlay and the banner
for (const sch of ["light", "dark"]) {
  await scheme(sch);
  await setMode("alice");
  for (const [path] of ALL) { await go(path); await axe(`${sch} ${path}`); }
  await go("/");
  await key("k", "KeyK", 75, 2); await sleep(150);
  await axe(`${sch} with the Ctrl+K overlay open`);
  await key("Escape", "Escape", 27);
  await setMode("default");
  await go("/");
  ok(await ev(`!!document.querySelector('[data-testid=default-banner]')`), `${sch}: the default-subject banner shows`);
  await axe(`${sch} with the default-subject banner`);
  await setMode("alice");
}
// explicit choice (data-theme) beats the system: dark chosen while the system says light
await scheme("light");
await go("/");
await ev(`localStorage.setItem('workbench.theme','dark')`);
await go("/");
ok((await ev(`document.documentElement.getAttribute('data-theme')`)) === "dark", "an explicit dark choice is applied on load");
await axe("explicit dark (system light)");
await ev(`localStorage.removeItem('workbench.theme')`);

// ---- 6. the default-subject banner: shown for the default identity, hidden when signed in
await scheme("light");
await setMode("default"); await go("/");
ok(await ev(`!!document.querySelector('[data-testid=default-banner]')`), "default identity: banner shown");
ok(/Sign-in is not switched on/.test(await ev(`document.querySelector('[data-testid=default-banner]').textContent`)), "banner says sign-in is not switched on");
await setMode("alice"); await go("/");
ok(await ev(`!document.querySelector('[data-testid=default-banner]')`), "signed-in identity: banner hidden");

// ---- 7. own data only: alice, then bob on the same browser; nothing kept
await setMode("alice"); await go("/");
const a = JSON.parse(await ev(`JSON.stringify({av:document.querySelector('[data-testid=avatar]')?.textContent,lbl:document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')})`));
ok(a.av === "AL" && a.lbl === "Signed in as Alice Lab", `alice's avatar: ${JSON.stringify(a)}`);
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]),idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(!/alice|u-alice|Lab/i.test(JSON.stringify(keep)) && keep.caches.length === 0 && keep.idb === 0, `nothing of alice in storage, cookies, Cache API or IndexedDB: ${JSON.stringify(keep)}`);
await setMode("bob"); await go("/");
const b = JSON.parse(await ev(`JSON.stringify({av:document.querySelector('[data-testid=avatar]')?.textContent,body:document.body.innerText,c:[...document.querySelectorAll('[data-testid^=count-]')].map(e=>e.textContent)})`));
ok(b.av === "BB" && !/Alice/.test(b.body) && JSON.stringify(b.c) === JSON.stringify(["0 running", "2 failed", "7 to review"]), `bob sees his own avatar and counts, none of alice's: ${JSON.stringify({ av: b.av, c: b.c })}`);
const heads = await stub("/__log");
ok(heads.every((x) => !/alice|bob|operator|subject|user/i.test(x.url)), "no request URL names a person (the server decides who is asking)");
// the HTTP cache must not have kept a read
await go("/research");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
const wbReqs = events.filter((e) => e.method === "Network.requestWillBeSent" && /\/workbench\//.test(e.params.request.url));
ok(wbReqs.length === 7, `each page load reads the six shell endpoints and the account (/workbench/settings) fresh (${wbReqs.length})`);

// ---- 8. the theme button cycles
await scheme("light"); await go("/");
const t = [];
for (let i = 0; i < 3; i++) { await ev(`document.querySelector('[data-testid=theme]').click()`); await sleep(100); t.push(await ev(`String(document.documentElement.getAttribute('data-theme'))`)); }
ok(JSON.stringify(t) === JSON.stringify(["light", "dark", "null"]), `theme cycle: ${t.join(",")}`);

// ---- 9. round 2 (tester findings): own sessions only, header-mode banner, click-inside overlay, inert, narrow widths
const vp = (width, height, dsf = 1) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false });
await scheme("light"); await vp(1440, 900);
await setMode("bob"); await go("/");
ok((await ev(`document.querySelector('[data-testid=count-research]')?.textContent`)) === "0 running", "F1: bob owns no session; three others run: Research shows 0 running, not 3");
await setMode("header"); await go("/");
ok(await ev(`!!document.querySelector('[data-testid=default-banner]')`), "F2: header mode with no identity header (kind default): banner shown");
await setMode("alice"); await go("/");
await key("k", "KeyK", 75, 2); await sleep(120);
await ev(`document.querySelector('.overlay-empty').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
await ev(`document.activeElement.blur()`);
await key("Tab", "Tab", 9, 8); await sleep(80);
ok(await ev(`!!document.querySelector('[role=dialog]').contains(document.activeElement)`), "F3: after a click inside the overlay, Shift+Tab stays inside it");
ok(await ev(`document.querySelector('[data-testid=page]').hasAttribute('inert')`), "F3: the page behind the overlay is inert");
await ev(`document.activeElement.blur()`);
await key("Escape", "Escape", 27); await sleep(120);
ok(await ev(`!document.querySelector('[role=dialog]') && !document.querySelector('[data-testid=page]').hasAttribute('inert')`), "F3: Esc closes it from anywhere in it; the page is live again");
for (const [w, h, dsf, label] of [[400, 800, 1, "400px"], [640, 450, 2, "zoom 200%"], [320, 640, 1, "320px"]]) {
  await vp(w, h, dsf); await setMode("alice"); await go("/");
  const m = JSON.parse(await ev(`JSON.stringify((()=>{const d=document.documentElement; const clip=[...document.querySelectorAll('.nav .count')].filter(e=>{const b=e.getBoundingClientRect(),r=e.closest('.rail').getBoundingClientRect();return b.right>r.right+0.5||b.left<r.left-0.5}).map(e=>e.textContent); const sb=document.querySelector('[data-testid=search-box]').getBoundingClientRect(); const rail=document.querySelector('.rail'); return {sw:d.scrollWidth,cw:d.clientWidth,clip,searchW:Math.round(sb.width),railX:rail.scrollWidth>rail.clientWidth+1,counts:document.querySelectorAll('.nav .count').length}})())`));
  ok(m.sw <= m.cw && m.clip.length === 0 && !m.railX && m.searchW >= 150 && m.counts === 3, `F5 ${label}: no sideways page scroll (${m.sw}/${m.cw}), counts not clipped (${m.clip.join(",") || "none"}), rail does not scroll sideways, search box ${m.searchW}px, ${m.counts} counts`);
}
await vp(1440, 900);

// ---- 10. rwr-ui-state-keys: the locked document lives in the ACCOUNT (the stub's alice has one stored)
await setMode("alice"); await go("/");
for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('[data-testid=lock-chip]')`)); i++) await sleep(150);
ok((await ev(`document.querySelector('[data-testid=lock-chip]')?.textContent || ''`)).includes("Alice plan"), "the shell shows the locked document read from the account at start (title read from the document)");
const keep2 = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie}))()`));
ok(!/plan|documents\//i.test(JSON.stringify(keep2)), `the locked document is not kept in the browser: ${JSON.stringify(keep2)}`);
await setMode("bob"); await go("/");
await sleep(500);
ok(await ev(`!document.querySelector('[data-testid=lock-chip]') && !/Alice plan/.test(document.body.innerText)`), "bob, same browser, sees no lock and nothing of alice's");
await setMode("alice"); await go("/");
for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('[data-testid=lock-chip]')`)); i++) await sleep(150);
await ev(`document.querySelector('[data-testid=lock-unlock]').click()`);
await sleep(600);
const acc = await stub("/__account/alice");
ok(!("ui.locked_document" in acc), "Unlock removes the lock from the account (a versioned DELETE)");
const del = (await stub("/__log")).filter((x) => x.method === "DELETE");
ok(del.length === 1 && /\?version=1$/.test(del[0].url), `the Unlock carried the version it had read: ${JSON.stringify(del.map((d) => d.url))}`);
await ev(`document.querySelector('[data-testid=toast-undo]').click()`);
await sleep(600);
const acc2 = await stub("/__account/alice");
ok(acc2["ui.locked_document"]?.value === "documents/k-7f3a/plan.md" && acc2["ui.locked_document"].version === 3, `Undo re-locks the same document with the next version: ${JSON.stringify(acc2)}`);

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
void KEY;
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
