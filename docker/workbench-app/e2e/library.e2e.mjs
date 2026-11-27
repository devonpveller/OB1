// Headless-Chromium e2e for the Library shell (rwr-lib-shell), driven over CDP. Run by run-library-e2e.ps1 inside an --internal lab
// network with the stub in library.stub.mjs (the same shared fakes the vitest suite drives). Env: APP_IP, CH (Chrome host), LAB_KEY.
// /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0, passes = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (c) passes++; else fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map(); const events = [];
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
const view = (width, height = 1000) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await view(1440);

const stub = async (p, method = "GET", body) => (await fetch(`http://stub:9000${p}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const T = (id) => `document.querySelector('[data-testid=${id}]')`;
const click = (sel) => ev(`(()=>{const e=${sel};if(!e||e.disabled)return false;e.click();return true})()`);
const read = (sel) => ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
const attr = (sel, a) => ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.getAttribute(${JSON.stringify(a)})))`).then(JSON.parse);
const keys = () => attr("[data-testid=chip]", "data-key");
const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && ((e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
  || e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))));
// the page is idle when the strip is ready, the person is known and no source chip is still being checked
const idle = async (strip = true) => {
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=avatar]') && (${strip ? `document.querySelector('[data-testid=strip][data-ready=true]') !== null && ![...document.querySelectorAll('[data-testid=chip]')].some(c=>c.getAttribute('data-state')==='checking')` : "true"})`)) break;
  }
  await sleep(200);
};
const go = async (path = "/library") => { events.length = 0; await send("Page.navigate", { url: origin + path }); await idle(path.startsWith("/library")); };
const AXE = readFileSync("/axe/axe.min.js", "utf8");
async function axe(label) {
  await ev(AXE + ";1");
  const r = await ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,160)).slice(0,4)})),pass:r.passes.length,cc:(r.passes.find(p=>p.id==='color-contrast')||{nodes:[]}).nodes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed, ${r.cc} elements checked for contrast)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
}
// nothing inside main may reach past main's own edge (the inner overflow, not only the page's width)
const inner = async (label) => { await sleep(300); return ev(`(()=>{const m=document.querySelector('[data-testid=main]');const mr=m.getBoundingClientRect();const bad=[];
  if(m.scrollWidth>m.clientWidth+1)bad.push('main scrollWidth '+m.scrollWidth+' > '+m.clientWidth);
  for(const e of m.querySelectorAll('*')){const r=e.getBoundingClientRect();if(r.width===0&&r.height===0)continue;if(r.right>mr.right+0.5||r.left<mr.left-0.5)bad.push(e.tagName+'.'+String(e.className).slice(0,30)+' '+Math.round(r.left)+'..'+Math.round(r.right)+' (main '+Math.round(mr.left)+'..'+Math.round(mr.right)+')');}
  return JSON.stringify({bad:bad.slice(0,6),page:document.documentElement.scrollWidth,vw:innerWidth});})()`).then((j) => {
  const r = JSON.parse(j);
  ok(r.bad.length === 0 && r.page <= r.vw, `no overflow inside main at ${r.vw} px (${label}): ${r.bad.length ? r.bad.join("; ") : "ok"}, page ${r.page}`);
}); };
const db = () => stub("/__db");
const posts = async (needle) => (await stub("/__log")).filter((x) => x.method === "POST" && x.url.includes(needle)).length;
const waitFor = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(f)) return true; await sleep(150); } return false; };

const D = await (async () => { await stub("/__reset", "POST"); return (await db()).ids; })();
const S = (n) => D.SRC[n - 1];
const k = (n) => "source:" + S(n);
const CPU = "documents/k-a/Hardware/cpu.md";

// ---- 1. the tabs
await setMode("alice"); await scheme("light"); await go("/library");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "Library", "the heading is Library");
ok(JSON.stringify(await read("[data-testid=library-tabs] a")) === JSON.stringify(["Discover", "For my document", "Saved", "Insights"]), "four tabs in order");
for (const [p, t, re] of [["/library", "discover", /Discover is not built yet/], ["/library/for-document", "fordoc", /For my document is not built yet/], ["/library/saved", "saved", /Saved is not built yet/], ["/library/insights", "insights", /Insights is not built yet.*phase 8/]]) {
  await go(p);
  const txt = (await read("[data-testid=panel-coming]"))[0] ?? "";
  ok(re.test(txt) && (await ev(`document.querySelectorAll('[data-testid=panel-coming] button, [data-testid=panel-coming] a, [data-testid=panel-coming] input').length`)) === 0, `${t}: says plainly it is not built yet and has nothing to press`);
}
await go("/library");
await axe("Library, light, empty strip");
await scheme("dark"); await axe("Library, dark, empty strip"); await scheme("light");

// ---- 2. acceptance 1: nine opened, the last eight stay
for (let n = 1; n <= 9; n++) await go(`/library?source=${S(n)}`);
let got = await keys();
ok(JSON.stringify(got) === JSON.stringify([9, 8, 7, 6, 5, 4, 3, 2].map(k)), `9 opened: the last 8 stay, newest first (${got.length} chips)`);
ok((await ev(`document.title`)) === "Library - Research workbench", "the page title names the screen, not the item");
let d = await db();
ok(d.accounts.alice["library.recent"].value.length === 8 && JSON.stringify(d.accounts.alice["library.recent"].value[0]) === JSON.stringify({ kind: "source", id: S(9) }), "the account holds the 8 as {kind, id} only");
// lock the oldest and open more: it stays, the oldest UNLOCKED goes instead
await click(`document.querySelector('[data-key="${k(2)}"] [data-testid=chip-menu]')`);
await click(T("act-lock")); await sleep(500);
for (const id of [S(1), S(10), S(11), S(12), D.SRC_HIDDEN, D.SRC_CUT]) await go(`/library?source=${id}`);
got = await keys();
ok(JSON.stringify(got) === JSON.stringify([D.SRC_CUT, D.SRC_HIDDEN, S(12), S(11), S(10), S(1), S(9), S(8)].map((x) => (x.startsWith("source:") ? x : "source:" + x)).concat([k(2)])), `a locked chip is never evicted: ${got.length} chips, the locked one still there`);
ok((await attr(`[data-key="${k(2)}"]`, "data-locked"))[0] === "true", "the locked chip is marked locked");

// ---- 3. acceptance 3: the strip is the account's, not the browser's
await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
await go("/library");
ok(JSON.stringify(await keys()) === JSON.stringify(got), "after clearing the browser's storage and reloading, the strip is the same");
const stor = JSON.parse(await ev(`JSON.stringify({l:Object.keys(localStorage),s:Object.keys(sessionStorage)})`));
ok(stor.l.length === 0 && stor.s.length === 0, `nothing of the strip is in localStorage or sessionStorage (${JSON.stringify(stor)})`);
ok((await send("Network.getAllCookies")).result.cookies.length === 0, "no cookie is set");

// ---- 4. acceptance 5: states instead of text
const st = async (key) => (await attr(`[data-key="${key}"]`, "data-state"))[0];
ok((await st("source:" + D.SRC_HIDDEN)) === "suppressed" && (await st("source:" + D.SRC_CUT)) === "unlinked" && (await st(k(1))) === "active", "a hidden and a cut-loose source show their state; an open one is active");
ok(!/SRC-SHARED Hidden|SRC-SHARED Cut/.test(await ev(`document.body.innerText`)), "no title of the hidden or cut-loose source is on the page");
await stub(`/__lifecycle/${S(10)}/erased`, "POST");
await go("/library");
ok((await st(k(10))) === "erased" && /Erased source/.test((await read(`[data-key="${k(10)}"] [data-testid=chip-open]`))[0]), "a source erased since shows as erased");

// ---- 5. acceptance 2: add all, to the locked document
await stub(`/__plant/alice/ui.locked_document`, "POST", { value: CPU });
await go("/library");
const want = (await keys()).filter((x) => x.startsWith("source:")).map((x) => x.slice(7)).filter((i) => ![D.SRC_HIDDEN, D.SRC_CUT, S(10)].includes(i)).sort();
ok(/ALPHA Upgrading the CPU/.test((await read("[data-testid=add-all]"))[0]), "Add all names the locked document");
await click(T("add-all"));
ok(await waitFor(`!!document.querySelector('[data-testid=add-result]')`), "Add all answers");
d = await db();
ok(JSON.stringify(d.pending.map((r) => r.source_id).sort()) === JSON.stringify(want) && d.pending.every((r) => r.path === CPU && r.added_from === "library"), `the cites that can be cited went to the locked document's to-place list (${d.pending.length}: ${want.length} wanted)`);
ok(/Added \d+ to ALPHA Upgrading the CPU/.test((await read("[data-testid=add-result]"))[0]) && (await read("[data-testid=add-not-added] li")).length === 3, "the result says what was added and lists the 3 that were not, with reasons");
await click(T("add-all")); await waitFor(`/already waiting/.test(document.querySelector('[data-testid=add-result]')?.textContent||'')`);
ok((await db()).pending.length === d.pending.length, "adding again repeats nothing (already waiting)");

// ---- 6. add all with no locked document asks which one
await stub(`/__plant/alice/ui.locked_document`, "POST", { value: null });
await stub(`/__plant/alice/library.recent`, "POST", { value: [{ kind: "source", id: S(5) }, { kind: "source", id: S(6) }] });
await go("/library");
const before = await posts("pending-refs");
await click(T("add-all"));
ok(await waitFor(`!!document.querySelector('[data-testid=picker]')`), "with no locked document, Add all opens the shared picker");
ok((await posts("pending-refs")) === before, "nothing is added while no document is chosen");
await ev(`(()=>{const i=${T("picker-q")};const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'ALPHA');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
ok(await waitFor(`document.querySelectorAll('[data-testid=picker-list] [role=option]').length>0`), "the picker lists the caller's own documents");
ok(!/BRAVO|trashed|duplicate/i.test((await read("[data-testid=picker-list] [role=option]")).join(" ")), "no other person's, trashed or archived document is offered");
await axe("the picker open for Add all");
await view(400); await inner("picker open"); await view(1440);
await click(`[...document.querySelectorAll('[data-testid=picker-list] [role=option]')].find(o=>/Upgrading the CPU/.test(o.textContent))`);
await click(T("picker-ok"));
ok(await waitFor(`/Added 2 to ALPHA Upgrading the CPU/.test(document.querySelector('[data-testid=add-result]')?.textContent||'')`), "choosing a document adds to it");
ok((await ev(`document.querySelector('[data-testid=picker]')`)) === null && (await db()).accounts.alice["ui.locked_document"].value === null, "the picker closes and no document got locked");

// ---- 7. closes, with a confirmation per target
await stub(`/__plant/alice/library.recent`, "POST", { value: [1, 2, 3, 4, 5, 6].map((n) => ({ kind: "source", id: S(n), ...(n === 3 ? { locked: true } : {}) })) });
await go("/library");
await click(`document.querySelector('[data-key="${k(4)}"] [data-testid=chip-menu]')`);
await click(T("act-close-others"));
const c = await attr("[data-testid=confirm-close]", "data-target");
ok(c[0] === k(4) && (await ev(`${T("close-all")}.disabled`)) === true && (await ev(`[...document.querySelectorAll('[data-testid=chip-menu]')].every(b=>b.disabled)`)), "the confirmation names its target; every other destructive button is off while it is open");
await view(400); await inner("a close confirmation open"); await view(1440);
await click(T("confirm-yes")); await sleep(600);
ok(JSON.stringify(await keys()) === JSON.stringify([k(3), k(4)]), "close others keeps this chip and the locked one");

// ---- 8. Home opens a source as a tab; the layout at 400 px with a very long title
await stub("/__reset", "POST"); await setMode("alice");
await stub(`/__rename/${S(11)}`, "POST", { title: "SRC-SHARED " + "LONGWORD".repeat(14) });
await go("/");
await ev(`(()=>{const i=${T("ask-input")};const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'LONGWORD');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await click(T("ask-go"));
ok(await waitFor(`!!document.querySelector('[data-testid=hit]')`), "Home's search finds the long-titled source");
await click(T("hit")); await idle(true);
ok((await ev(`location.pathname+location.search`)) === `/library?source=${S(11)}` && (await keys()).length === 1, "a hit opens the source as its own Library tab and it is in the strip");
ok(/LONGWORD/.test((await read(`[data-key="${k(11)}"] [data-testid=chip-open]`))[0]) && /LONGWORD/.test((await read("[data-testid=tab-item]"))[0]), "the chip and the tab carry the title the search returned");
for (const w of [400, 760, 1440]) { await view(w); await inner("a chip with a very long title"); }
await view(400);
await click(`document.querySelector('[data-key="${k(11)}"] [data-testid=chip-menu]')`);
await inner("a chip menu open");
await ev(`document.activeElement.blur()`);
await view(1440);
await axe("Library with an item tab, light"); await scheme("dark"); await axe("Library with an item tab, dark"); await scheme("light");
ok(!(await ev(`!!document.querySelector('select, datalist')`)), "no <select> or <datalist> on the screen");

// ---- 9. acceptance 4 and 6: two identities, no reload
await stub("/__reset", "POST"); await setMode("alice");
await stub(`/__plant/alice/ui.locked_document`, "POST", { value: CPU });
await stub(`/__plant/alice/library.recent`, "POST", { value: [{ kind: "source", id: S(1) }, { kind: "source", id: S(2) }, { kind: "source", id: S(3) }] });
await go("/library");
await click(T("add-all")); await waitFor(`!!document.querySelector('[data-testid=add-result]')`);
await click(`document.querySelector('[data-key="${k(2)}"] [data-testid=chip-menu]')`);
await click(T("act-close-others"));
ok(await ev(`!!document.querySelector('[data-testid=confirm-close]') && !!document.querySelector('[data-testid=add-result]')`), "alice has a result and a close confirmation on the page");
const bobWrites = async () => (await stub("/__log")).filter((x) => x.mode === "bob" && ["PUT", "DELETE"].includes(x.method)).length;
await setMode("bob");
ok(await waitFor(`document.querySelector('[data-testid=avatar]')?.textContent==='BB'`, 45000), "bob arrives on the page without a reload (the shell's 30 s refresh)");
await sleep(800);
const body = await ev(`document.body.innerText`);
ok(!/ALPHA|SRC-SHARED/.test(body) && (await ev(`!document.querySelector('[data-testid=confirm-close]') && !document.querySelector('[data-testid=add-result]')`)) && (await keys()).length === 0, "no chip, title, result or confirmation of alice's is on bob's page");
ok((await bobWrites()) === 0, "the switch wrote nothing");
// a private-report claim of alice's: bob opens its address
await go(`/library?claim=${D.CLAIM_PRIVATE_A}`);
const bobBody = await ev(`document.body.innerText`);
ok(!bobBody.includes(D.PRIVATE_MARKER) && (await ev(`${T("item-add")}?.disabled === true`)) && (await keys()).length === 0, "bob opening alice's private-report claim sees none of its words, cannot cite it and it is not in his strip");
ok((await bobWrites()) === 0, "bob's visit wrote nothing");

// ---- 10. no noise
ok(problems().length === 0, "no console error, warning or exception" + (problems().length ? " " + JSON.stringify(problems().slice(0, 3)) : ""));
console.log(`\n${passes} passed, ${fails} failed`);
ws.close();
process.exit(fails ? 1 : 0);
