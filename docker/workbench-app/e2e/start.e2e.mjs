// Headless-Chromium e2e for the Start research dialog (rwr-start-research), driven over CDP. Run by run-start-e2e.ps1
// inside an --internal lab network with the stub in start.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY.
// /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
const MARK = "PERSONAL-MARKER-7731";
const DOC_A = "documents/alice/alpha-cpu.md";
const ID_A = "c0000000-0000-4000-8000-000000000001"; // its opaque id: the only thing an address carries
const enc = encodeURIComponent;
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
const behave = (m) => stub(`/__behave/${m}`, "POST");
const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
const key = async (k, code, vk, modifiers = 0, text) => {
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
};
const tab = (shift = false) => key("Tab", "Tab", 9, shift ? 8 : 0);
const enter = () => key("Enter", "Enter", 13, 0, "\r");
const space = () => key(" ", "Space", 32, 0, " ");
const esc = () => key("Escape", "Escape", 27);
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=start-dialog]') && !document.querySelector('[data-testid=doc-checking]') && !!document.querySelector('[data-testid=avatar]')`)) break;
  }
  await sleep(200);
};
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
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const typeInto = async (sel, s) => { await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); for (const ch of s) await send("Input.insertText", { text: ch }); };
const setValue = async (sel, s) => { await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.select();})()`); await send("Input.insertText", { text: s }); };
const waitFor = async (cond, ms = 6000) => { for (let t = 0; t < ms; t += 100) { if (await ev(cond)) return true; await sleep(100); } return false; };
const previewPosts = async () => (await stub("/__log")).filter((x) => x.url === "/workbench/research/preview");
const startPosts = async () => (await stub("/__log")).filter((x) => x.url === "/workbench/research" && x.method === "POST");
const q = "Does an X299 board need a BIOS update before a Cascade Lake-X CPU will post?";
const cleaned = (s) => "clean: " + s.toLowerCase();

// ---- 1. from a document: prefilled, the amber bar, focus in the question
await scheme("light"); await setMode("alice"); await behave("ok");
await go(`/research/start?document=${ID_A}`);
ok((await text("h1")) === "Start research", "the dialog heading is Start research");
ok((await text("[data-testid=for-document-title]")) === "ALPHA Upgrading the workstation CPU", "from a document: the bar names it");
ok(/For document/.test(await text("[data-testid=for-document]") ?? "") && (await ev(`getComputedStyle(document.querySelector('[data-testid=for-document]')).backgroundColor`)) !== "rgba(0, 0, 0, 0)", "the amber For document bar is shown");
ok((await ev(`document.querySelector('[data-testid=attach-doc]').getAttribute('aria-pressed')`)) === "true", "the attach choice is A document");
ok((await ev(`document.querySelector('[data-testid=for-document-back]').getAttribute('href')`)) === "/documents/d/" + ID_A, "Back to the document goes to the document (by its id)");
ok((await ev(`document.activeElement?.dataset?.testid`)) === "start-question", "focus starts in the question box");
ok((await ev(`document.title`)) === "Start research - Research workbench", "the page title is the screen's, naming no document");
await axeBoth("Start research (from a document, empty question)");

// ---- 2. the preview follows the question (debounced); what is shown is what is sent
await typeInto("[data-testid=start-question]", q);
ok(await waitFor(`!!document.querySelector('[data-testid=leaves-question]')`), "the preview appears after the question is typed");
const pv = await previewPosts();
ok(pv.length === 1, `typing ${q.length} characters made ONE preview request (debounced): ${pv.length}`);
ok(pv[0].keyOk && pv[0].body.question === q && pv[0].body.depth === "standard" && pv[0].body.attach.path === DOC_A, "the preview body carries the question, the depth and the document path");
const shown = (await text("[data-testid=leaves-question]")).replace(/[“”]/g, "");
ok(shown === cleaned(q), `the dialog shows the cleaned question: ${shown}`);
ok(/Public pages it will read: https:\/\/example\.org\/public-board/.test(await text("[data-testid=leaves-links]")), "the public link the boundary found is listed");
ok(/Up to 2 rounds of searching, up to 40 pages read, and it stops after 10 minutes\./.test(await text("[data-testid=leaves-limits]")), "the limits of the depth are shown in words");
ok((await text("[data-testid=estimate]")) === "Standard: usually under an hour. You can steer it while it runs.", "the estimate text follows the depth");
await axeBoth("Start research with a preview");
// a change shows a new preview and Start is off meanwhile
await setValue("[data-testid=start-question]", q + " Please be brief.");
ok((await ev(`document.querySelector('[data-testid=start-go]').disabled`)) === true, "Start is off while the preview of the changed question is pending");
ok(await waitFor(`document.querySelector('[data-testid=leaves-question]')?.textContent.includes('please be brief')`), "the preview updates after the question changes");
ok(await waitFor(`document.querySelector('[data-testid=start-go]').disabled===false`), "Start is on again for the new preview");

// ---- 3. Start sends the same body plus the shown text; the job holds that text; Research opens
await click("[data-testid=depth-deep]");
ok(await waitFor(`/Up to 3 rounds/.test(document.querySelector('[data-testid=leaves-limits]')?.textContent||'')`), "choosing Deep re-previews with the deeper limits");
const lastShown = (await text("[data-testid=leaves-question]")).replace(/[“”]/g, "");
await waitFor(`document.querySelector('[data-testid=start-go]').disabled===false`);
await click("[data-testid=start-go]");
ok(await waitFor(`location.pathname==='/research'`), "Start opens Research");
const sp = await startPosts();
const pv2 = await previewPosts();
const lastPv = pv2[pv2.length - 1].body;
ok(sp.length === 1 && JSON.stringify({ ...sp[0].body, approved_question: undefined }) === JSON.stringify({ ...lastPv, approved_question: undefined }) && sp[0].body.approved_question === lastShown, "the start body equals the last preview body plus approved_question = the text shown");
const jobs = await stub("/__jobs");
ok(jobs.length === 1 && jobs[0].question === lastShown && jobs[0].depth === "deep" && jobs[0].attach.path === DOC_A && jobs[0].mode === "alice", "the created job's request is the text that was shown (deep, attached to the document)");
ok((await ev(`location.search`)) === "?run=" + jobs[0].id, "the run is named in the address Research opens with");
ok(/Research started\./.test(await text("[data-testid=toasts]")) && !/ALPHA|X299/.test(await text("[data-testid=toasts]")), "the toast says Research started and names no title and no question");

// ---- 4. the planted marker never leaves
const all = await stub("/__log");
ok(!all.some((x) => JSON.stringify(x.body ?? "").includes(MARK) || x.url.includes(MARK)), "the marker planted in the document's text is in no request body and no URL");
ok(!(await ev(`document.documentElement.outerHTML`)).includes(MARK), "...and nowhere on the page");
ok(all.every((x) => x.keyOk), "every request carried the door key (it came through the app's server)");
ok(all.filter((x) => x.url.startsWith("/workbench/")).length === all.length, "every request the app made is a /workbench/ route");

// ---- 5. attach to nothing, depth quick, the chooser (own live documents only), no idea anywhere
await go("/research/start");
ok(!(await has("[data-testid=for-document]")) && (await ev(`document.querySelector('[data-testid=attach-none]').getAttribute('aria-pressed')`)) === "true", "from + Start research: attached to nothing, no bar");
ok(!(await has("[data-testid=attach-idea]")) && !/\bidea\b.*attach|attach.*\bidea\b/i.test(await ev(`[...document.querySelectorAll('[data-testid=start-dialog] button')].map(b=>b.textContent).join(' | ')`)), "no idea is offered as an attachment");
ok(/open the idea and choose Research this/.test(await text("[data-testid=idea-hint]")), "the dialog says where an idea is researched");
await click("[data-testid=attach-doc]");
ok(await waitFor(`!!document.querySelector('[data-testid=doc-chooser]')`), "A document opens the list of the person's documents");
const choices = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=doc-choice]')].map(e=>e.textContent))`));
ok(JSON.stringify(choices) === JSON.stringify(["ALPHA Upgrading the workstation CPU", "ALPHA second note"]), `only alice's live documents are offered (not the trash): ${JSON.stringify(choices)}`);
await axeBoth("Start research with the document list open");
await ev(`document.querySelectorAll('[data-testid=doc-choice]')[1].click()`);
ok((await text("[data-testid=for-document-title]")) === "ALPHA second note", "choosing a document in the dialog puts its bar up");
await click("[data-testid=attach-none]"); await click("[data-testid=depth-quick]");
await typeInto("[data-testid=start-question]", "Which public pages cover this?");
ok(await waitFor(`!!document.querySelector('[data-testid=leaves-question]')`), "a preview for attach nothing / quick");
const pv3 = (await previewPosts()).pop().body;
ok(pv3.attach.kind === "none" && pv3.depth === "quick" && Object.keys(pv3.attach).join() === "kind", "attach nothing sends no path; depth quick");
ok((await text("[data-testid=estimate]")) === "Quick: usually a few minutes.", "the Quick estimate");

// ---- 6. refusal and failure
await behave("refuse"); await go("/research/start");
await typeInto("[data-testid=start-question]", "My private thing");
ok(await waitFor(`!!document.querySelector('[data-testid=leaves-refused]')`), "a refused preview is shown as a refusal");
ok(/no public page it could use/i.test(await text("[data-testid=leaves-refused]")) && /no_public_evidence/.test(await text("[data-testid=leaves-refused]")), "...in plain words, with the reason code");
ok((await ev(`document.querySelector('[data-testid=start-go]').disabled`)) === true, "...and Start is off");
await axeBoth("a refused preview");
await behave("fail"); await go("/research/start");
await typeInto("[data-testid=start-question]", "q");
ok(await waitFor(`!!document.querySelector('[data-testid=leaves-failed]')`) && (await ev(`document.querySelector('[data-testid=start-go]').disabled`)) === true, "a failing preview says so and Start stays off");
await axeBoth("a failed preview");
await behave("ok");

// ---- 7. two identities: bob after alice, same browser
await setMode("bob");
await go(`/research/start?document=${ID_A}`);
ok((await text("[data-testid=doc-gone]")) === "That document is not available." && !(await has("[data-testid=for-document]")), "bob opening alice's document: one plain sentence, no bar");
ok(!/ALPHA|alice|Alice/.test(await ev(`document.body.innerText`)), "bob's page shows no ALPHA text and no 'alice'");
ok(!(await ev(`document.documentElement.outerHTML`)).includes("ALPHA"), "bob's page source holds no ALPHA text at all");
await click("[data-testid=attach-doc]");
await waitFor(`!!document.querySelector('[data-testid=doc-chooser]')`);
ok(JSON.stringify(JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=doc-choice]')].map(e=>e.textContent))`))) === JSON.stringify(["BRAVO plan"]), "bob can attach only his own document");
await axeBoth("Start research as bob (alice's document asked for)");
const bobDocReads = (await stub("/__log")).filter((x) => x.mode === "bob" && /documents\/(state|file|resolve)/.test(x.url));
ok(bobDocReads.length >= 1 && bobDocReads.every((x) => x.keyOk), "bob's read of alice's document was made and answered 404 (the same as a missing one)");
// a live switch: alice's dialog is open with her question and document; the person changes; the shell's refresh shows bob
await setMode("alice");
await go(`/research/start?document=${ID_A}`);
await typeInto("[data-testid=start-question]", "ALPHA secret question");
await waitFor(`!!document.querySelector('[data-testid=leaves-question]')`);
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob");
await sleep(800);
ok((await ev(`document.querySelector('[data-testid=start-question]').value`)) === "" && !(await has("[data-testid=leaves-question]")) && !(await has("[data-testid=for-document]")), "live switch: the dialog dropped alice's question, preview and document");
ok(!/ALPHA|alice|secret/i.test(await ev(`document.body.innerText`)), "live switch: no ALPHA text, no 'alice', no 'secret' anywhere");
await axeBoth("Start research after a live switch to bob");
await setMode("alice");

// ---- 8. keyboard: Tab reaches everything, rings visible, buttons work with Enter and Space, Esc leaves
await go(`/research/start?document=${ID_A}`);
await ev(`document.activeElement.blur()`);
const stops = [];
for (let i = 0; i < 40; i++) {
  await tab();
  stops.push(JSON.parse(await ev(`(()=>{const e=document.activeElement;const cs=getComputedStyle(e);return JSON.stringify({t:e.dataset.testid||e.textContent.trim().slice(0,24),inMain:!!e.closest('main'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle,fv:e.matches(':focus-visible')})})()`)));
}
const main = stops.filter((s) => s.inMain);
for (const need of ["start-close", "start-question", "attach-none", "attach-doc", "depth-quick", "depth-standard", "depth-deep", "start-cancel"]) ok(main.some((s) => s.t === need), `Tab reaches ${need}`);
ok(main.length > 0 && main.every((s) => s.fv && s.os !== "none" && s.ow >= 2), `all ${main.length} Tab stops on the screen show a focus ring of at least 2px`);
await ev(`document.querySelector('[data-testid=depth-deep]').focus()`); await space();
ok((await ev(`document.querySelector('[data-testid=depth-deep]').getAttribute('aria-pressed')`)) === "true", "Space chooses a depth");
await ev(`document.querySelector('[data-testid=depth-quick]').focus()`); await enter();
ok((await ev(`document.querySelector('[data-testid=depth-quick]').getAttribute('aria-pressed')`)) === "true", "Enter chooses a depth");
await setValue("[data-testid=start-question]", "keyboard only");
await waitFor(`document.querySelector('[data-testid=start-go]').disabled===false`);
ok((await startPosts()).length === 1, "Enter or typing in the question never starts anything by itself");
await ev(`document.querySelector('[data-testid=start-go]').focus()`); await enter();
ok(await waitFor(`location.pathname==='/research'`), "Enter on Start starts, from the keyboard alone");
await go(`/research/start?document=${ID_A}`);
await ev(`document.querySelector('[data-testid=start-question]').focus()`); await esc();
ok(await waitFor(`location.pathname==='/documents/d/${ID_A}'`), "Esc leaves the dialog and goes back to the document it was opened for");
await go("/research/start");
await ev(`document.querySelector('[data-testid=start-question]').focus()`); await esc();
ok(await waitFor(`location.pathname==='/'`), "Esc from + Start research goes home");

// ---- 9. 400 px: nothing pushes the page (or an inner box) sideways, a long address included
await go("/research/start");
await typeInto("[data-testid=start-question]", "a long link question");
await waitFor(`!!document.querySelector('[data-testid=leaves-question]')`);
await click("[data-testid=attach-doc]"); await waitFor(`!!document.querySelector('[data-testid=doc-chooser]')`);
for (const w of [800, 400]) {
  await viewport(w, 800); await sleep(300);
  const o = JSON.parse(await ev(`JSON.stringify((()=>{const m=document.querySelector('main');const d=document.querySelector('[data-testid=start-dialog]').getBoundingClientRect();
    const wide=[...document.querySelectorAll('[data-testid=start-dialog] *')].filter(e=>{const r=e.getBoundingClientRect();return r.right>window.innerWidth+1||r.left<-1}).map(e=>e.dataset.testid||e.tagName).slice(0,5);
    const inner=[...document.querySelectorAll('[data-testid=start-dialog] *')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible').map(e=>e.dataset.testid||e.className||e.tagName).slice(0,5);
    return {msw:m.scrollWidth,mcw:m.clientWidth,bsw:document.documentElement.scrollWidth,iw:window.innerWidth,dr:d.right,wide,inner}})())`));
  ok(o.msw <= o.mcw && o.bsw <= o.iw && o.dr <= o.iw && o.wide.length === 0, `at ${w}px: no sideways push: main ${o.msw}/${o.mcw}, page ${o.bsw}/${o.iw}, dialog right edge ${o.dr}, outside the viewport: ${JSON.stringify(o.wide)}`);
  ok(o.inner.length === 0, `at ${w}px: no element inside the dialog overflows its own box: ${JSON.stringify(o.inner)}`);
}
await axeBoth("Start research at 400px");
const small = await ev(`[...document.querySelectorAll('[data-testid=start-dialog] button')].filter(b=>{const r=b.getBoundingClientRect();return r.height<24||r.width<24}).length`);
ok(small === 0, `at 400px every button is at least 24x24 CSS px (${small} smaller)`);
await viewport(1440, 900);

// ---- 10. quality of the run: no console problems, nothing kept in the browser, nothing from the cache
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => (e.params?.entry?.text || e.params?.exceptionDetails?.text) + " " + (e.params?.entry?.url || ""))));
await setMode("alice"); await go(`/research/start?document=${ID_A}`);
await typeInto("[data-testid=start-question]", "something to leave a trace");
await waitFor(`!!document.querySelector('[data-testid=leaves-question]')`);
const keep = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme'),ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(keep.ls.length === 0 && keep.ss === 0 && keep.ck === "" && keep.caches === 0 && keep.idb === 0, `storage, cookies, caches and IndexedDB hold nothing beyond workbench.theme: ${JSON.stringify(keep)}`);
ok((await ev(`location.search`)) === `?document=${ID_A}`, "the address holds the document's opaque id only: not the question, not the path");
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
