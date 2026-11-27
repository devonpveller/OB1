// Headless-Chromium e2e for Cleanup (rwr-cleanup), driven over CDP. Run by run-cleanup-e2e.ps1 inside an --internal lab network
// with the stub in cleanup.stub.mjs (documents, flags and Cleanup back ends are the fakes the vitest suite drives). Env: APP_IP,
// CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";
import { uid } from "./docs-fake.mjs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = "PRIVATE-FLAG-NOTE-7788";
const PUNCT = "documents/k-a/Notes+[v2];100%.md";

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
await viewport(1440, 1000);

const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: k === "Enter" ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(k === "Enter" ? { text: String.fromCharCode(13) } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const T = (id) => `[data-testid=${id}]`;
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const texts = (sel) => ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
const until = async (x, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(x)) return true; await sleep(150); } return false; };
const settled = `!!document.querySelector('[data-testid=cleanup]') && !!document.querySelector('[data-testid=avatar]') && document.querySelectorAll('[data-testid=cleanup] [role=status]').length===0`;
const go = async (path = "/cleanup") => { events.length = 0; await send("Page.navigate", { url: origin + path }); await until(settled); await sleep(250); };
const tab = async (t) => { await click(T("tab-" + t)); await until(`document.querySelector('[data-testid=tab-${t}]')?.getAttribute('aria-selected')==='true' && document.querySelectorAll('[data-testid=cleanup] [role=status]').length===0`); await sleep(250); };
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
// anything inside <main> wider than its box: the inner overflow, not only the page's
const overflowing = () => ev(`(()=>{const m=document.querySelector('main'); const mr=m.getBoundingClientRect(); const bad=[]; if(m.scrollWidth>m.clientWidth) bad.push('main '+m.scrollWidth+'/'+m.clientWidth); for(const e of m.querySelectorAll('*')){ const cs=getComputedStyle(e); if(cs.display==='none'||cs.position==='fixed') continue; if(e.scrollWidth>e.clientWidth+1 && cs.overflowX==='visible' && e.clientWidth>0) bad.push(e.tagName+'.'+e.className+' '+e.scrollWidth+'/'+e.clientWidth); const r=e.getBoundingClientRect(); if(r.width>0 && r.right>mr.right+1) bad.push('right '+e.tagName+'.'+e.className+' '+Math.round(r.right)); } return JSON.stringify(bad.slice(0,6))})()`).then(JSON.parse);
const typeInto = async (sel, s) => { await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select();})()`); await key("Backspace", "Backspace", 8); if (s) await send("Input.insertText", { text: s }); await sleep(120); };
const log = () => stub("/__log");
const writes = async () => (await log()).filter((x) => x.method !== "GET");
const db = () => stub("/__db");

await stub("/__reset", "POST"); await setMode("alice"); await scheme("light");

// ---- 1. the screen, the four tabs, the empty Suggestions tab
await go();
ok((await text("h1")) === "Cleanup", "the heading is Cleanup");
ok(JSON.stringify(await texts("[role=tab]")) === JSON.stringify(["Suggestions", "Flagged by you", "Ready to erase", "Worth reopening"]), "four tabs in the plan's order");
ok(/No suggestions yet/.test(await text(T("empty"))), "Suggestions is empty and says why (the scan is a later item)");
ok(problems().length === 0, `no console errors/warnings (${problems().length})`);
await axeBoth("Suggestions tab");

// ---- 2. Flagged by you: alice's two flags, reason words from the registry, links back that open the document
await tab("flagged");
ok((await count(T("card-flag"))) === 2 && (await text(T("count"))) === "2", "alice's two flags are listed, count 2");
ok(JSON.stringify((await texts(T("flag-reason"))).sort()) === JSON.stringify(["Duplicate", "Wrong claim"]), "the reasons read as words (from the registry)");
ok(/Only you and admins can see it/.test(await text(T("fact-affects"))), "each says what it affects: nothing, and who can see it");
await until(`[...document.querySelectorAll('[data-testid=fact-where]')].every(e=>e.textContent!=='Looking...')`);
const hrefs = await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=flag-link]')].map(a=>a.getAttribute('href')))`).then(JSON.parse);
ok(hrefs.length === 2 && hrefs.includes("/documents/d/" + uid(PUNCT)) && hrefs.every((h) => /^\/documents\/d\/[0-9a-f-]{36}$/.test(h)), `links back are opaque ids, never a path: ${JSON.stringify(hrefs)}`);
await axeBoth("Flagged by you tab");
await click(T("flag-link")); await until(`location.pathname.startsWith('/documents/d/')`);
ok(await ev(`location.pathname.startsWith('/documents/d/')`), "the link opens the flagged document in the app");
await go("/cleanup"); await tab("flagged");

// ---- 3. take a flag back from the list; a triple click sends one request
await ev(`(()=>{const b=document.querySelector('[data-testid=withdraw]'); b.click(); b.click(); b.click();})()`);
await until(`document.querySelectorAll('[data-testid=card-flag]').length===1`); await sleep(300);
const pat = (await writes()).filter((x) => x.method === "PATCH");
ok(pat.length === 1 && /^\/workbench\/contract\/flags\/[0-9a-f-]{36}$/.test(pat[0].url) && pat[0].body === '{"state":"withdrawn"}', `a triple click took one flag back with one PATCH: ${JSON.stringify(pat.map((p) => [p.url, p.body]))}`);
ok(!(await log()).some((x) => /scope=all/.test(x.url)), "the screen never asks for everyone's flags (scope=all)");

// ---- 4. Ready to erase: facts, one confirmation at a time, typed word keyed per target
await tab("ready");
ok((await count(T("card-ready"))) === 3, "three sources are ready to erase (the still-used one is not offered)");
ok(!/still used/.test(await ev(`document.body.innerText`)), "the hidden, still-connected source is not listed here");
ok(/Apply to all uses one reason for the whole batch/.test(await text(T("one-reason-note"))), "the tab says apply-all uses one reason for the whole batch");
await click(T("erase")); await sleep(150);
ok((await ev(`document.querySelector('[data-testid=apply-all]').disabled`)) === true && (await ev(`[...document.querySelectorAll('[data-testid=erase]')].every(b=>b.disabled)`)), "one confirmation at a time: Apply to all and every other Erase are off while one panel is open");
ok((await count("select, datalist, [role=listbox], [role=option]")) === 0, "no <select>, <datalist> or listbox on the screen");
await typeInto(T("typed-input"), "ERASE");
ok((await ev(`document.querySelector('[data-testid=typed-input]').value`)) === "ERASE", "ERASE typed on the first source");
await click(T("typed-cancel")); await sleep(100);
await ev(`document.querySelectorAll('[data-testid=erase]')[1].click()`); await sleep(150);
ok((await ev(`document.querySelector('[data-testid=typed-input]').value`)) === "" && (await ev(`document.querySelector('[data-testid=typed-ok]').disabled`)) === true, "the typed word did not carry to the next source");
await axeBoth("Ready to erase with an erase panel open");
await click(T("typed-cancel")); await sleep(100);

// ---- 5. Apply to all: one reason for the batch, said on the screen
await click(T("apply-all")); await sleep(150);
await click(T("batch-reason-credibility")); await sleep(100);
ok(/All 3 sources are erased with this one reason: It was not credible enough/.test(await text(T("batch-says"))), "the panel says all three get this one reason");
await axeBoth("Ready to erase with the apply-all panel open");
await typeInto(T("typed-input"), "ERASE"); await click(T("typed-ok"));
await until(`!!document.querySelector('[data-testid=batch-result]')`); await sleep(300);
const proc = (await writes()).filter((x) => /process-all/.test(x.url));
const pb = proc.length ? JSON.parse(proc[0].body) : {};
ok(proc.length === 1 && pb.reason_type === "credibility" && pb.source_ids.length === 3 && Object.keys(pb).length === 2, `ONE process-all call, one reason, three ids: ${proc.map((p) => p.body).join("")}`);
ok((await text(T("batch-result"))) === "Erased 3 of 3 with one reason for the whole batch: It was not credible enough.", "the result repeats: one reason for the whole batch");
ok(/Nothing is waiting to be erased/.test(await text(T("empty"))), "the list is empty afterwards");

// ---- 6. Worth reopening: review one at a time with a summary, "Not again for this"
await tab("reopen");
ok((await count(T("card-reopen"))) === 2, "two erased sources are worth reopening");
ok(/attaches the earlier debunking/.test(await text(T("fact-affects"))), "what reopening affects is stated");
await click(T("review-start")); await sleep(200);
ok((await text(T("review-progress"))) === "1 of 2", "Review one at a time starts at 1 of 2");
await axeBoth("Review one at a time");
await click(T("dismiss")); await until(`document.querySelector('[data-testid=review-progress]')?.textContent==='2 of 2'`); await sleep(200);
await click(T("review-skip")); await until(`!!document.querySelector('[data-testid=review-summary]')`);
ok(/You decided on 1 of 2 items; 1 was left as it was/.test(await text(T("review-counts"))), `the review ends with a summary: ${await text(T("review-counts"))}`);
ok((await texts(`${T("review-log")} li`)).length === 2, "...listing each step");
await axeBoth("the review summary");
await click(T("review-close")); await sleep(300);
ok((await count(T("card-reopen"))) === 1, "the dismissed one is gone from the list");
const dj = await db();
ok(dj.dismissals.length === 1 && dj.dismissals[0].kind === "reopen_candidate" && dj.dismissals[0].owner_sub === "u-alice", "the dismissal is alice's own row");

// ---- 7. it stays dismissed after a reload, and other people still see it
await go("/cleanup"); await tab("reopen");
ok((await count(T("card-reopen"))) === 1, "after a reload the dismissed one does not return");
await setMode("bob"); await go("/cleanup"); await tab("reopen");
ok((await count(T("card-reopen"))) === 2, "for bob it still shows (the dismissal is alice's alone)");
await tab("flagged");
ok((await count(T("card-flag"))) === 1 && !new RegExp(MARK + "|ALPHA").test(await ev(`document.body.innerText`)), "bob's Flagged tab holds only bob's flag; nothing of alice's");
ok(!new RegExp(MARK + "|ALPHA|u-alice").test(await ev(`document.documentElement.outerHTML`)), "bob's page source holds no marker of alice's");
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie,t:document.title,caches:(typeof caches!=='undefined'?await caches.keys():[]),idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(!/SRC-SHARED|ALPHA|BRAVO|alice|bob|Bob/i.test(JSON.stringify(keep)) && keep.caches.length === 0 && keep.idb === 0, `nothing private in storage, cookies, caches, IndexedDB or the page title: ${JSON.stringify(keep)}`);
const lg = await log();
ok(lg.every((x) => x.keyOk) && lg.every((x) => !/u-|alice|bob|ALPHA|PRIVATE/i.test(x.url)), "every request carried the door key and none names a person or carries a marker");
await setMode("alice");

// ---- 8. six reasons: the words come from the registry, nothing is listed in the app
await stub("/__reset", "POST"); await stub("/__six", "POST"); await go("/cleanup"); await tab("flagged");
const six = await texts(T("flag-reason"));
ok(six.includes("Outdated") && six.includes("Broken link") && six.includes("Wrong claim") && six.includes("Duplicate") && six.length === 4, `reasons added to the registry read as words, with no change to the app: ${JSON.stringify(six)}`);

// ---- 9. narrow screens: nothing overflows at 400 px, on every tab, also inside
await viewport(400, 800);
for (const t of ["suggestions", "flagged", "ready", "reopen"]) {
  await stub("/__reset", "POST"); await go("/cleanup"); await tab(t);
  const bad = await overflowing();
  ok(bad.length === 0, `400 px, ${t} tab: nothing overflows ${JSON.stringify(bad)}`);
}
await tab("ready"); await click(T("apply-all")); await sleep(200);
const bad2 = await overflowing(); ok(bad2.length === 0, `400 px, apply-all panel open: nothing overflows ${JSON.stringify(bad2)}`);
await axe("light 400px apply-all panel");
await viewport(1440, 1000);

// ---- 10. keyboard
await stub("/__reset", "POST"); await go("/cleanup");
await ev(`document.querySelector('[data-testid=tab-suggestions]').focus()`); await key("ArrowRight", "ArrowRight", 39); await sleep(200);
ok(await ev(`document.activeElement?.dataset?.testid === 'tab-flagged' && document.querySelector('[data-testid=tab-flagged]').getAttribute('aria-selected')==='true'`), "ArrowRight moves to the next tab and focuses it");
await tab("ready"); await click(T("erase")); await sleep(150);
await typeInto(T("typed-input"), "ERASE"); await key("Enter", "Enter", 13); await until(`document.querySelectorAll('[data-testid=card-ready]').length===2`); await sleep(300);
ok((await writes()).some((x) => /\/erase$/.test(x.url)), "Enter in the typed field submits the confirmed erase");
ok(problems().length === 0, `no console errors/warnings during the run (${problems().length})`);

console.log(fails === 0 ? "ALL PASS" : fails + " FAILED");
process.exit(fails === 0 ? 0 : 1);
