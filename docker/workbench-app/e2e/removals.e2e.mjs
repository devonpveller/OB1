// Headless-Chromium e2e for Removals and trail (rwr-removals), driven over CDP. Run by run-removals-e2e.ps1 inside an
// --internal lab network with the stub in removals.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", { type: k === "Enter" ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(k === "Enter" ? { text: String.fromCharCode(13) } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const T = (id) => `document.querySelector('[data-testid=${id}]')`;
const click = (sel) => ev(`(()=>{const e=${sel};if(!e)return false;e.click();return true})()`);
const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (await ev(`!!document.querySelector('[data-testid=removals]') && document.querySelectorAll('[data-testid=removals] [role=status]').length===0 && !!document.querySelector('[data-testid=avatar]') && ![...document.querySelectorAll('[data-testid=row-erased] [data-testid=by]')].some(b=>b.textContent==='Not known')`)) break; } await sleep(150); };
const go = async (path = "/removals") => { events.length = 0; await send("Page.navigate", { url: origin + path }); await idle(); };
const tab = async (t) => { await click(T("tab-" + t)); await idle(); };
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
const rowTitles = (sec) => read(`[data-testid=sec-${sec}] li .row-title`);
const lines = () => read("[data-testid=trail-line]");
const typeInto = async (testid, text) => { await ev(`${T(testid)}.focus()`); await ev(`${T(testid)}.select()`); await key("Backspace", "Backspace", 8); if (text) await send("Input.insertText", { text }); await sleep(120); };
const posts = async () => (await stub("/__log")).filter((x) => x.method === "POST").map((x) => x.url);

// ---- 1. alice: the Removed tab
await stub("/__reset", "POST"); await setMode("alice");
await scheme("light"); await go();
ok((await ev(`document.querySelector('h1')?.textContent`)) === "Removals and trail", "the heading is Removals and trail");
ok(JSON.stringify(await rowTitles("sources")) === JSON.stringify(["Hidden source one", "Cut loose source two", "Held by private work"]), "sources by stage: hidden, cut loose, held by private work");
ok(JSON.stringify(await rowTitles("trashed")) === JSON.stringify(["ALPHA trashed memo"]) && JSON.stringify(await rowTitles("archived")) === JSON.stringify(["ALPHA archived notes"]) && JSON.stringify(await rowTitles("ideas")) === JSON.stringify(["ALPHA parked idea"]), "alice's trashed document, archived document and archived idea are listed");
ok(JSON.stringify(await rowTitles("erased")) === JSON.stringify(["Erased shared source"]) && /2 connections|1 connection/.test((await rowTitles("cut"))[0]), "an erased source with its marker, and the cut connections, are listed");
const by = await read("[data-testid=row-source] [data-testid=by]");
ok(JSON.stringify(by) === JSON.stringify(["You", "Someone else", "Someone else"]), `by: alice's own suppression says You, bob's says Someone else: ${JSON.stringify(by)}`);
ok(/2 claims, 3 text pieces; something in private work still holds it/.test((await read("[data-testid=row-source] [data-testid=depended]"))[0]), "depended on it: shared counts shown, private kinds only as a sentence");
ok(!/1 document|document_link|\b4 ref/.test(await ev(`document.body.innerText`)), "no count of a person-owned dependence kind is on the page");
const eraseButtons = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=row-source]')].map(r=>!!r.querySelector('[data-testid=erase]')))`));
ok(JSON.stringify(eraseButtons) === JSON.stringify([false, true, false]), `Erase for good is offered only on the source nothing depends on: ${JSON.stringify(eraseButtons)}`);
ok(/Erasing is not possible yet/.test((await read("[data-testid=erase-blocked]"))[0]), "a blocked source shows why erase is not possible");
ok(problems().length === 0, `no console errors/warnings (${problems().length})`);
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Removed tab`); }
await scheme("light");

// ---- 2. Show it again (source) -> a trail line with You
await click(`document.querySelector('[data-testid=row-source] [data-testid=show-again]')`); await idle(); await sleep(300);
ok(JSON.stringify(await rowTitles("sources")) === JSON.stringify(["Cut loose source two", "Held by private work"]), "Show it again: the source left the Removed list");
ok((await posts()).includes("/workbench/sources/s1/restore"), "...through POST /workbench/sources/:id/restore");
await tab("trail");
const shown = (await lines()).find((l) => /Shown again \(it had been hidden\)/.test(l));
ok(!!shown && /You/.test(shown) && !/Hidden source one/.test(shown), `...and the trail has the line with You as actor, with no invented title: ${shown}`);
await tab("removed");

// ---- 3. Erase for good: the typed word, the reason, lost and stays
await click(`document.querySelector('[data-testid=row-source] [data-testid=erase]')`); await sleep(150);
ok(/What is lost/.test(await ev(`${T("lost-stays")}.textContent`)) && /What stays/.test(await ev(`${T("lost-stays")}.textContent`)), "Erase for good shows what is lost and what stays");
await axe("light erase panel");
const dis = () => ev(`${T("typed-ok")}.disabled`);
ok((await dis()) === true, "the Erase button is disabled before anything is typed");
ok((await ev(`${T("delete-forever")}.disabled && ${T("lift")}.disabled`)) === true, "one confirmation at a time: Delete forever and Lift the marker are off while the Erase panel is open");
ok((await ev(`document.querySelectorAll('select, datalist').length`)) === 0, "no <select> or <datalist> on the screen");
for (const w of ["erase", "Erase", "ERAS", "ERASE now"]) { await typeInto("typed-input", w); ok((await dis()) === true, `typing "${w}" does not enable it`); }
ok(!(await posts()).some((u) => /erase$/.test(u)), "nothing was sent for a wrong word");
await click(T("erase-reason-credibility"));
await typeInto("typed-input", "ERASE");
ok((await dis()) === false, "typing ERASE exactly enables it");
await click(T("typed-ok")); await idle(); await sleep(300);
ok((await posts()).includes("/workbench/contract/cleanup/sources/s2/erase"), "...and sends the erase to the existing route");
ok(JSON.stringify(await rowTitles("sources")) === JSON.stringify(["Held by private work"]), "the erased source left the list");
await tab("trail");
const er = (await lines()).find((l) => /Erased for good: Cut loose source two/.test(l));
ok(!!er && /You/.test(er) && /Reason: credibility/.test(er), `the trail has the erase with You and the reason: ${er}`);
await tab("removed");

// ---- 4. Lift the marker (only the eraser sees the button)
await click(T("lift")); await sleep(150);
ok(/does not bring it back/.test(await ev(`${T("lost-stays")}.textContent`)), "Lift the marker says what it does and does not do");
await click(T("lift-ok")); await idle(); await sleep(300);
ok((await posts()).some((u) => /^\/workbench\/contract\/cleanup\/tombstones\/t\d+\/lift$/.test(u)), "Lift the marker calls the existing route");
let erasedNow = await rowTitles("erased"); for (let i = 0; i < 20 && erasedNow.includes("Cut loose source two"); i++) { await sleep(250); erasedNow = await rowTitles("erased"); } ok(!erasedNow.includes("Cut loose source two"), `erased rows now ${JSON.stringify(erasedNow)}: the lifted marker (the newest, Cut loose source two) left Erased sources and the other stays (the real lifted line has no tombstone_id column)`);
await tab("trail");
const lf = (await lines()).find((l) => /Marker lifted/.test(l));
ok(!!lf && /You/.test(lf), `the trail has Marker lifted with You: ${lf}`);
await tab("removed");

// ---- 5. Show it again for documents and ideas, and Delete forever (typed word)
await click(`document.querySelector('[data-testid=row-archived] [data-testid=show-again]')`); await idle();
await click(`document.querySelector('[data-testid=row-idea] [data-testid=show-again]')`); await idle();
const ps = await posts();
ok(ps.includes("/workbench/documents/unarchive") && ps.includes("/workbench/ideas/i1/reopen"), "archived document and archived idea: Show it again calls unarchive and ideas/:id/reopen");
await tab("trail");
const ua = (await lines()).find((l) => /Taken out of the archive/.test(l));
ok(!!ua && /You/.test(ua) && !/Removed:/.test(ua), `the trail has the unarchive line, not "Removed": ${ua}`);
await tab("removed");
await click(T("delete-forever")); await sleep(150);
await typeInto("typed-input", "delete"); ok((await dis()) === true, "Delete forever stays disabled for the wrong case");
await typeInto("typed-input", "DELETE"); await click(T("typed-ok")); await idle(); await sleep(300);
ok((await posts()).includes("/workbench/documents/delete-forever"), "Delete forever calls the existing route");
ok(JSON.stringify(await rowTitles("trashed")) === "[]", "the deleted document left the trash list");
await tab("trail");
const df = (await lines()).find((l) => /Deleted forever: memo/.test(l));
ok(!!df && /You/.test(df), `the trail has Deleted forever with You: ${df}`);

// ---- 6. the trail is read only
const tr = JSON.parse(await ev(`JSON.stringify({buttons:document.querySelectorAll('[data-testid=trail-tab] button').length, inputs:document.querySelectorAll('[data-testid=trail-tab] input:not([type=radio]), [data-testid=trail-tab] textarea, [data-testid=trail-tab] form').length, filters:document.querySelectorAll('[data-testid=trail-tab] fieldset').length})`));
ok(tr.buttons === 0 && tr.inputs === 0 && tr.filters === 3, `the trail has no button, text input or form: only its three radio filters (${JSON.stringify(tr)})`);
const before = (await stub("/__log")).length;
await click(T("f-who-me")); await sleep(200);
ok((await lines()).every((l) => /You/.test(l) && !/nightly clean-up|An administrator/.test(l)) && !(await lines()).some((l) => /Someone else/.test(l)) && (await lines()).length >= 4, "Only me narrows the trail to your own lines (and your own documents)");
ok((await stub("/__log")).length === before, "changing a filter sends nothing");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Trail tab`); }
await scheme("light");
ok(problems().length === 0, `no console errors/warnings during the whole alice run (${problems().length})`);

// ---- 7. two identities: bob in the same browser sees none of alice's rows
await stub("/__reset", "POST"); await setMode("alice"); await go();
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:{...localStorage},ss:{...sessionStorage},ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]),idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(!/ALPHA|alice/i.test(JSON.stringify(keep)) && keep.caches.length === 0 && keep.idb === 0, `nothing of alice in storage, cookies, Cache API or IndexedDB: ${JSON.stringify(keep)}`);
await setMode("bob"); await go();
ok(!/ALPHA|alice|Alice/i.test(await ev(`document.body.innerText`)), "bob's Removed tab shows no ALPHA item and no 'alice'");
ok(JSON.stringify(await rowTitles("trashed")) === JSON.stringify(["BRAVO trashed draft"]) && JSON.stringify(await rowTitles("ideas")) === JSON.stringify(["BRAVO archived idea"]), "bob sees his own trashed document and archived idea");
ok((await read("[data-testid=row-erased] [data-testid=by]"))[0] === "Someone else" && (await ev(`!!${T("lift-not-yours")}`)) && !(await ev(`!!${T("lift")}`)), "alice's marker: bob sees 'Someone else' and no Lift button");
await tab("trail");
ok(!/ALPHA|alice|Alice|u-alice/i.test(await ev(`document.body.innerText`)) && (await lines()).some((l) => /BRAVO-gone/.test(l)), "bob's Trail tab holds his own document line and nothing of alice's");
ok(!/ALPHA/.test(await ev(`document.documentElement.outerHTML`)), "bob's page source holds no ALPHA text at all");
const lg = await stub("/__log");
ok(lg.every((x) => x.keyOk), "every request carried the door key (added server-side)");
ok(lg.every((x) => !/ALPHA|alice|bob|u-/i.test(x.url)), "no request URL names a person or carries a planted marker");
await scheme("dark"); await axe("dark Trail tab as bob"); await scheme("light");

// ---- 8. a refusal for a row that is not there (gone, or not yours) reads the same, in plain words
await stub("/__reset", "POST"); await setMode("alice"); await go();
await stub("/__drop-docs", "POST"); // the world changed behind the page: alice's stale rows no longer exist
await click(`document.querySelector('[data-testid=row-trashed] [data-testid=show-again]')`); await sleep(400);
const refusal = await ev(`document.querySelector('[data-testid=row-trashed] [data-testid=row-error]')?.textContent`);
ok(refusal === "That is not there any more, so nothing was changed.", `a 404 reads as plain words: "${refusal}"`);
ok(!/SECRET|u-alice|stack|Error|not found/i.test(await ev(`document.body.innerText`)), "no server text or error detail on the page");
await axe("light Removed tab with a refusal");

// ---- 9. light/dark, narrow, keyboard
await stub("/__reset", "POST"); await setMode("alice");
for (const sch of ["light", "dark"]) { await scheme(sch); await go(); await axe(`${sch} Removed tab (alice, all sections)`); }
await scheme("light");
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false }); await go();
const ov = JSON.parse(await ev(`JSON.stringify({sw:document.querySelector('main').scrollWidth,cw:document.querySelector('main').clientWidth})`));
ok(ov.sw <= ov.cw, `at 400px wide: no inner horizontal scroll (${ov.sw}/${ov.cw})`);
await axe("light Removed tab at 400px");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await go();
// keyboard: the tabs by arrow key, the typed confirm by Enter
await ev(`${T("tab-removed")}.focus()`); await key("ArrowRight", "ArrowRight", 39); await sleep(200);
ok(await ev(`${T("trail-tab")} !== null && document.activeElement?.dataset?.testid === 'tab-trail'`), "ArrowRight moves from Removed to Trail and focuses the tab");
await tab("removed");
await click(`document.querySelector('[data-testid=row-source] [data-testid=erase]')`); await sleep(150);
ok((await ev(`document.activeElement?.tagName`)) !== "BODY", "the typed confirm is reachable (focus is in the page)");
await typeInto("typed-input", "ERASE"); await key("Enter", "Enter", 13); await idle(); await sleep(300);
ok((await posts()).some((u) => /erase$/.test(u)), "Enter in the typed field submits the confirmed erase");

console.log(fails === 0 ? "ALL PASS" : fails + " FAILED");
process.exit(fails === 0 ? 0 : 1);
