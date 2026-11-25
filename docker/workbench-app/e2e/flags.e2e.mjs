// Headless-Chromium e2e for "Flag for cleanup" (rwr-flag-buttons), driven over CDP. Run by run-flags-e2e.ps1 inside an
// --internal lab network with the stub in flags.stub.mjs (the documents back end is docs-fake.mjs and the flags back end is
// flags-fake.mjs, which copy the server's routes and repo code). Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is
// axe-core. Every check prints PASS/FAIL; exit 1 on any failure.
// The flag is made from alice's CPU document (open in the writing surface) on the reference its citation [1] pins and on that
// reference's source. A claim and a source screen are not in this app yet (phases 2 and 5): the same component is unit tested there.
import { readFileSync } from "node:fs";
import { uid, REF_A, SRC_A } from "./docs-fake.mjs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
// a check that is EXPECTED to fail today for a reason that is not this item's: XFAIL does not count; if it passes, that is a FAIL
// (the marker is stale: remove it). Name the item that fixes it.
const xfail = (c, m, item) => { console.log(c ? `FAIL unexpected pass, remove the xfail (${item} landed?): ${m}` : `XFAIL (until ${item}) ${m}`); if (c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CPU = "documents/k-a/Hardware/cpu.md";
const BRAVO = "documents/k-b/bravo.md";
const OLD = "documents/k-a/Old notes/cpu.md";
const MARK = "PRIVATE-NOTE-MARKER-5521";
const MARK2 = "DRAFT-MARKER-8842";
const H = (p) => "/documents/d/" + uid(p);

const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map(); const events = [];
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); return; }
  events.push(d);
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
const key = async (k, vk) => {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk });
};
const esc = () => key("Escape", 27);
// a key that types a character (Enter, Space) needs its text, or the page sees a raw key and no click
const typed = async (k, vk, text) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: vk, text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: vk });
};
const until = async (x, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(x)) return true; await sleep(150); } return false; };
const settled = `!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && document.querySelectorAll('main [role=status]').length===0`;
const go = async (path) => { events.length = 0; await send("Page.navigate", { url: origin + path }); await until(settled); await sleep(200); };
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
const mouse = async (sel) => {
  const r = JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()`) || "null");
  if (!r) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  return true;
};
const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const has = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const typeInto = async (sel, s) => { await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await send("Input.insertText", { text: s }); };
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
// anything inside <main> wider than its box (the editor's own scroller excepted): the inner overflow at a narrow width
const overflowing = () => ev(`(()=>{const m=document.querySelector('main'); const bad=[]; for(const e of m.querySelectorAll('*')){ if(e.closest('.cm-editor')) continue; const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') continue; if(e.scrollWidth>e.clientWidth+1) bad.push(e.tagName+'.'+String(e.className).slice(0,40)+' '+e.scrollWidth+'>'+e.clientWidth); } if(m.scrollWidth>m.clientWidth+1) bad.push('main '+m.scrollWidth+'>'+m.clientWidth); if(document.documentElement.scrollWidth>document.documentElement.clientWidth+1) bad.push('page '+document.documentElement.scrollWidth+'>'+document.documentElement.clientWidth); return bad.slice(0,8)})()`);
const db = () => stub("/__db");
const asApp = async (path, method = "GET", body) => ev(`fetch(${JSON.stringify(path)}, {method:${JSON.stringify(method)}, headers:${body ? '{"content-type":"application/json"}' : "{}"}, body:${body ? JSON.stringify(JSON.stringify(body)) : "undefined"}, cache:"no-store"}).then(async r=>({status:r.status, body: await r.text()}))`);
const openDoc = async (p = CPU) => { await go(H(p)); return until(`!!document.querySelector('[data-testid=doc-editor] .cm-content') && /^v\\d/.test(document.querySelector('[data-testid=doc-version]')?.textContent||'')`); };
const openChip = async (n = 0) => {
  await ev(`document.querySelectorAll('[data-testid=doc-editor] button.ws-chip')[${n}].scrollIntoView()`);
  const r = JSON.parse(await ev(`(()=>{const b=document.querySelectorAll('[data-testid=doc-editor] button.ws-chip')[${n}].getBoundingClientRect(); return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  return until(`!!document.querySelector('[data-testid=drawer-body]')`);
};
const flagBtn = (kind) => `[data-testid=drawer-flags] [data-item-kind=${kind}] [data-testid=flag-open]`;

await stub("/__reset", "POST");
await scheme("light");
await setMode("alice");

// ---- 1. the drawer of a citation offers the two flags; the dialog states the promise and the four reasons
ok(await openDoc(), "alice's document opens in the writing surface");
const itemsBefore = JSON.stringify((await db()).items);
const refsBefore = JSON.stringify((await db()).refs);
ok(await openChip(0), "clicking citation [1] opens the source drawer");
ok(await has(flagBtn("reference")) && await has(flagBtn("source")), "the drawer offers Flag this reference and Flag this source");
ok((await text(flagBtn("reference"))) === "Flag this reference" && (await text(flagBtn("source"))) === "Flag this source", "...with those words");
await click(flagBtn("reference"));
ok(await has("[data-testid=flag-dialog]"), "the dialog opens");
ok(/Nothing changes until it is decided\./.test(await text("[data-testid=flag-promise]")), "the dialog says: Nothing changes until it is decided.");
ok(/Only you and admins can see your flag\./.test(await text("[data-testid=flag-promise]")), "...and who can see the flag");
const reasons = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=flag-reasons] input[type=radio]')].map(i=>[i.value, i.closest('label').textContent, i.checked]))`));
ok(JSON.stringify(reasons) === JSON.stringify([["wrong_claim", "Wrong claim", false], ["low_quality", "Low quality", false], ["duplicate", "Duplicate", false], ["other", "Other", false]]), `the reason picker is exactly: Wrong claim, Low quality, Duplicate, Other (none chosen): ${JSON.stringify(reasons.map((r) => r[1]))}`);
ok(await ev(`document.querySelector('[data-testid=flag-send]').disabled`) === true, "Flag it is off until a reason is chosen");
ok(!(await has("select, datalist, [role=listbox], [role=combobox]")), "no select, datalist or listbox on the page");
ok((await ev(`document.activeElement?.closest('[data-testid=flag-dialog]') !== null`)) === true, "focus is inside the dialog");
ok((await ev(`document.title`)) === "Document - Research workbench", "the page title is the screen's, naming no document or source");
await axeBoth("flag dialog open in the drawer");
// ---- Escape closes the dialog only
await esc();
ok(!(await has("[data-testid=flag-dialog]")) && await has("[data-testid=source-drawer]"), "Escape closes the dialog and leaves the drawer");
ok((await ev(`document.activeElement?.dataset?.testid`)) === "flag-open", "focus returns to the Flag button");
ok((await stub("/__log")).filter((x) => x.url.startsWith("/workbench/contract/flags") && x.method === "POST").length === 0, "nothing was sent by opening and closing it");

// ---- 2. at 400 px nothing inside main overflows, dialog open with a long note
await viewport(400, 800);
await click(flagBtn("reference"));
await click("[data-testid=flag-reason-low_quality]");
await typeInto("[data-testid=flag-note]", "x".repeat(300) + " https://example.org/" + "a".repeat(200));
const ovf = await overflowing();
ok(ovf.length === 0, `400 px, dialog open with a long note: nothing in main overflows ${JSON.stringify(ovf)}`);
ok(await ev(`(()=>{const d=document.querySelector('[data-testid=flag-dialog]').getBoundingClientRect(); return d.left>=0 && d.right<=innerWidth})()`), "...and the dialog lies inside the 400 px window");
await axeBoth("flag dialog at 400 px");
await click("[data-testid=flag-cancel]");
await viewport(1440, 900);

// ---- 3. a flag: the body, the toast, the done line; the item is unchanged
await click(flagBtn("reference"));
await click("[data-testid=flag-reason-wrong_claim]");
await typeInto("[data-testid=flag-note]", `thin and repeated ${MARK}`);
await click("[data-testid=flag-send]");
ok(await until(`!!document.querySelector('[data-testid=flag-done]')`), "Flag it: the flag is made and the button gives way to a line");
const mine = (await stub("/__db")).flags;
ok(mine.length === 1 && mine[0].owner_sub === "u-alice" && mine[0].item_kind === "reference" && mine[0].item_id === REF_A && mine[0].reason === "wrong_claim" && mine[0].note === `thin and repeated ${MARK}` && mine[0].from_kind === "document" && mine[0].from_ref === CPU && mine[0].state === "open", `one flag on the server, as alice's, for the reference from this document: ${JSON.stringify(mine.map((f) => [f.item_kind, f.reason, f.from_kind, f.from_ref]))}`);
ok(/Flagged for cleanup\. It is under Cleanup, Flagged by you\./.test(await text("[data-testid=toasts]")) && !/ALPHA|SRC|thin and repeated/.test(await text("[data-testid=toasts]")), "the toast says so and names no title and no note");
ok((await db()).items && JSON.stringify((await db()).items) === itemsBefore && JSON.stringify((await db()).refs) === refsBefore, "the flagged reference, its source and every shared item are byte-identical afterwards");
ok(await ev(`document.querySelector('[data-testid=drawer-quote]').textContent`) === "the LGA2066 socket takes a 165 W part" && await ev(`document.querySelector('[data-testid=drawer-title]').textContent`) === "SRC-ALPHA Socket guide", "the drawer still shows the same pinned words and title");
const wr = (await stub("/__log")).filter((x) => x.method !== "GET" && !x.url.startsWith("/workbench/settings"));
ok(wr.length === 1 && wr[0].method === "POST" && wr[0].url === "/workbench/contract/flags", `the only write the page made was the flag: ${JSON.stringify(wr.map((x) => x.method + " " + x.url))}`);
ok(!(await has(flagBtn("reference"))) && await has(flagBtn("source")), "the reference's button gave way (no second flag); the source's is still offered");
// the source of the same reference, from the same document
await click(flagBtn("source"));
await click("[data-testid=flag-reason-duplicate]");
await click("[data-testid=flag-send]");
ok(await until(`document.querySelectorAll('[data-testid=flag-done]').length===2`), "the source is flagged too");
const mine2 = (await stub("/__db")).flags;
ok(mine2.length === 2 && mine2.some((f) => f.item_kind === "source" && f.item_id === SRC_A && f.reason === "duplicate" && f.from_ref === CPU && f.note === ""), "its flag is a source flag from the same document, with no note");
// the flagged state survives closing the drawer and opening the citation again (same person, same document)
await click("[data-testid=drawer-close]");
ok(await until(`!document.querySelector('[data-testid=source-drawer]')`), "the drawer closes");
await openChip(0);
ok((await ev(`document.querySelectorAll('[data-testid=drawer-flags] [data-testid=flag-done]').length`)) === 2 && !(await has("[data-testid=drawer-flags] [data-testid=flag-open]")), "reopening the citation shows both as flagged, with no Flag button (no second flag from this page)");
ok((await db()).flags.length === 2, "...and no request was made for it: still two flags on the server");
// the link back and the link to Cleanup
ok((await ev(`document.querySelector('[data-testid=flag-cleanup-link]').getAttribute('href')`)) === "/cleanup", "the done line links to Cleanup");
// what Cleanup > Flagged by you reads: alice's own two flags, each with the document it came from
const aliceList = JSON.parse((await asApp("/workbench/contract/flags")).body);
ok(aliceList.total === 2 && aliceList.flags.length === 2 && aliceList.flags.every((f) => f.from.kind === "document" && f.from.ref === CPU && f.flagged_by === null), "alice's own list (what Flagged by you reads) holds both, each with `from` = the document, and no flagged_by");
// the link back: the harness page (built only with FLAG_HARNESS=1) lists the caller's own flags with the link `flagBackLink` builds
await go("/flag-harness.html");
ok(await until(`!!document.querySelector('[data-testid=harness-total]')`), "the flags list (Flagged by you's read) loads");
ok((await text("[data-testid=harness-total]")) === "2" && (await ev(`document.querySelectorAll('[data-testid=harness-row]').length`)) === 2, "it lists alice's two flags");
const hrefs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=harness-backlink]')].map(a=>a.getAttribute('href')))`));
ok(hrefs.length === 2 && hrefs.every((h) => h === H(CPU)), `each flag carries the link back built by flagBackLink: ${JSON.stringify(hrefs)}`);
ok(!hrefs.some((h) => /cpu|Hardware|\.md|ALPHA/i.test(h)), "...which names no path, folder, file or title");
await click("[data-testid=harness-backlink]");
ok(await until(`location.pathname===${JSON.stringify(H(CPU))} && !!document.querySelector('[data-testid=doc-editor] .cm-content')`), "following that link opens the document the flag was made from");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));

// ---- 4. nothing private on a shared surface: the planted marker
const all = await stub("/__log");
const hits = all.filter((x) => (x.body || "").includes(MARK) || x.url.includes(MARK));
ok(hits.length === 1 && hits[0].method === "POST" && hits[0].url === "/workbench/contract/flags", `the note's marker is in ONE request: the flag POST (${hits.length})`);
const dbDump = JSON.stringify(await db());
ok((dbDump.match(new RegExp(MARK, "g")) ?? []).length === 1 && JSON.stringify((await db()).flags[0]).includes(MARK), "...and in ONE place on the server: the flag row's note (not in any document, reference, source or item)");
ok(!(await ev(`document.documentElement.outerHTML`)).includes(MARK), "...and nowhere on the page");
ok(await ev(`JSON.stringify(Object.keys(localStorage).concat(Object.keys(sessionStorage)))`) === JSON.stringify([]) || (await ev(`JSON.stringify(Object.keys(localStorage).concat(Object.keys(sessionStorage)))`)) === JSON.stringify(["workbench.theme"]), `the browser keeps nothing but the theme: ${await ev(`JSON.stringify(Object.keys(localStorage).concat(Object.keys(sessionStorage)))`)}`);
ok(await ev(`(async()=>{const d=await indexedDB.databases(); return d.length})()`) === 0 && !(await ev(`document.cookie`)), "no IndexedDB database and no cookie");
ok(all.every((x) => x.keyOk), "every request reached the stub with the door key (it came through the app's server)");

// ---- 5. two identities: bob (and an admin) against alice's flags
await setMode("bob");
await go("/documents");
const bobList = await asApp("/workbench/contract/flags");
ok(bobList.status === 200 && JSON.parse(bobList.body).total === 0 && JSON.parse(bobList.body).flags.length === 0, `bob's own list is empty and its total is 0, not alice's 2: ${bobList.body}`);
const aliceFlag = mine2[0].id;
const missing = await asApp("/workbench/contract/flags/f1a90000-0000-4000-8000-0000000000ff");
const foreign = await asApp(`/workbench/contract/flags/${aliceFlag}`);
ok(foreign.status === 404 && foreign.body === missing.body && missing.status === 404, `bob reading alice's flag by id is the same answer as a missing flag: ${foreign.status} ${foreign.body}`);
const foreignEdit = await asApp(`/workbench/contract/flags/${aliceFlag}`, "PATCH", { state: "withdrawn" });
ok(foreignEdit.status === 404 && foreignEdit.body === missing.body && (await db()).flags.every((f) => f.state === "open"), "bob taking alice's flag back is that same answer and changes nothing");
const bobAll = await asApp("/workbench/contract/flags?scope=all");
ok(bobAll.status === 403 && !/alice|u-alice|wrong_claim|thin|PRIVATE|total|flags/.test(bobAll.body), `bob asking for everyone's flags is refused, naming nothing: ${bobAll.body}`);
const bobFrom = await asApp("/workbench/contract/flags", "POST", { item_kind: "claim", item_id: "c1000000-0000-4000-8000-0000000000a1", reason: "other", from: { kind: "document", ref: CPU } });
const bobMissingItem = await asApp("/workbench/contract/flags", "POST", { item_kind: "claim", item_id: "c1000000-0000-4000-8000-0000000000ee", reason: "other", from: { kind: "document", ref: BRAVO } });
ok(bobFrom.status === 404 && bobMissingItem.status === 404, `bob flagging from alice's document, and flagging an item that is missing, are both refused as not found (${bobFrom.status}, ${bobMissingItem.status}) and no flag was made: ${(await db()).flags.length === 2}`);
// bob opens his own document: no trace of alice, and his own flag is his
ok(await openDoc(BRAVO), "bob's own document opens");
ok(await openChip(0), "bob opens the citation of the shared reference");
ok(await has(flagBtn("reference")) && await has(flagBtn("source")), "bob is offered both flags: a button is not a sign that alice flagged (the shared items carry no flag state)");
const html = await ev(`document.documentElement.outerHTML`);
ok(!html.includes(MARK) && !/u-alice|Alice|thin and repeated|wrong_claim/.test(html), "bob's page holds none of alice's note, name or flag");
await click(flagBtn("reference"));
await click("[data-testid=flag-reason-other]");
await click("[data-testid=flag-send]");
ok(await until(`!!document.querySelector('[data-testid=flag-done]')`), "bob flags the same reference: his own flag");
const bobMine = JSON.parse((await asApp("/workbench/contract/flags")).body);
ok(bobMine.total === 1 && bobMine.flags[0].reason === "other" && bobMine.flags[0].from.ref === BRAVO, "bob's list: one flag, his, from his document");
await go("/flag-harness.html");
await until(`!!document.querySelector('[data-testid=harness-total]')`);
ok((await text("[data-testid=harness-total]")) === "1" && JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-testid=harness-backlink]')].map(a=>a.getAttribute('href')))`)).join() === H(BRAVO), "bob's flags list holds exactly his one flag, linking to his own document");
await setMode("alice");
await go("/documents");
const aliceAgain = JSON.parse((await asApp("/workbench/contract/flags")).body);
ok(aliceAgain.total === 2 && !JSON.stringify(aliceAgain).includes("bravo") && !JSON.stringify(aliceAgain).includes("u-bob"), "alice still sees exactly her two: bob's flag is not counted or shown");
// an admin sees everyone's with who flagged them; a non-admin cannot ask
await stub("/__admin/bob", "POST");
await setMode("bob");
await go("/documents");
const adminAll = JSON.parse((await asApp("/workbench/contract/flags?scope=all")).body);
ok(adminAll.total === 3 && adminAll.flags.every((f) => typeof f.flagged_by === "string") && new Set(adminAll.flags.map((f) => f.flagged_by)).size === 2, "an admin's scope=all holds all 3 flags, each with who flagged it");
const adminOne = JSON.parse((await asApp(`/workbench/contract/flags/${aliceFlag}`)).body);
ok(adminOne.id === aliceFlag && adminOne.flagged_by === "u-alice" && adminOne.from.ref === CPU, "an admin reads alice's flag by id, with its origin");
ok(JSON.parse((await asApp("/workbench/contract/flags")).body).total === 1, "...while the admin's own list stays his own");
await stub("/__admin/none", "POST");
await setMode("alice");
ok((await asApp("/workbench/contract/flags?scope=all")).status === 403, "alice (not an admin) is refused scope=all");

// ---- 6. failures are told in fixed words; a retry works; nothing of the server's text is shown
await stub("/__reset", "POST");
await setMode("alice");
await openDoc(); await openChip(0);
await stub("/__behave/fail", "POST");
await click(flagBtn("reference"));
await click("[data-testid=flag-reason-other]");
await click("[data-testid=flag-send]");
ok(await until(`!!document.querySelector('[data-testid=flag-problem]')`), "a 500 shows a problem line");
ok((await text("[data-testid=flag-problem]")) === "The flag could not be sent. Nothing was flagged. Try again." && !(await ev(`document.body.textContent`)).includes("internal"), "...in fixed words, with none of the server's text");
ok((await db()).flags.length === 0 && await has("[data-testid=flag-dialog]") && await ev(`document.querySelector('[data-testid=flag-reason-other]').checked`), "nothing was flagged and the dialog keeps the person's choice");
await click("[data-testid=flag-send]");
ok(await until(`!!document.querySelector('[data-testid=flag-done]')`) && (await db()).flags.length === 1, "Try again (Flag it again) makes the flag once");

// ---- 7. a different person on the page, no reload: the dialog, its draft and its toast are gone
await stub("/__reset", "POST");
await setMode("alice");
await openDoc(); await openChip(0);
await click(flagBtn("source"));
await click("[data-testid=flag-reason-duplicate]");
await typeInto("[data-testid=flag-note]", MARK2);
ok(await ev(`document.querySelector('[data-testid=flag-note]').value`) === MARK2, "alice has a draft in an open dialog");
await setMode("bob"); // the shell reads whoami again on its own timer (30 s); no reload
ok(await until(`!document.querySelector('[data-testid=flag-dialog]') && !document.querySelector('[data-testid=doc-editor]')`, 330), "when the person on the page changes, the dialog and the document are gone (no reload)");
ok(!(await ev(`document.documentElement.outerHTML`)).includes(MARK2), "alice's draft is nowhere on the page");
const after = await stub("/__log");
ok(after.filter((x) => x.method === "POST" && x.url === "/workbench/contract/flags").length === 0 && (await db()).flags.length === 0, "nothing was sent for the draft: no flag was made");
ok(!after.some((x) => (x.body || "").includes(MARK2)), "the draft text reached no request at all");
ok(await ev(`document.querySelectorAll('[data-testid=toast]').length`) === 0, "no toast of the first person is left on the page");

// ---- 8. keyboard: Tab reaches the button and the radios, Enter sends
await stub("/__reset", "POST");
await setMode("alice");
await openDoc(); await openChip(0);
await ev(`document.querySelector(${JSON.stringify(flagBtn("reference"))}).focus()`);
await typed("Enter", 13, "\r");
ok(await has("[data-testid=flag-dialog]"), "Enter on the button opens the dialog");
await ev(`document.querySelector('[data-testid=flag-reason-wrong_claim]').focus()`);
await typed(" ", 32, " ");
ok((await ev(`document.querySelector('input[type=radio]:checked')?.value`)) === "wrong_claim", "Space chooses the focused reason");
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
ok((await ev(`document.querySelector('input[type=radio]:checked')?.value`)) === "low_quality", "the arrow keys move the choice to the next reason");
await ev(`document.querySelector('[data-testid=flag-send]').focus()`);
await typed("Enter", 13, "\r");
ok(await until(`!!document.querySelector('[data-testid=flag-done]')`) && (await db()).flags.length === 1 && (await db()).flags[0].reason === "low_quality", "Enter on Flag it sends the flag from the keyboard");

// ---- 9. EXPECTED TO FAIL until the server item rw-doc-path-spaces lands: a document in a folder with a space
await stub("/__reset", "POST");
await setMode("alice");
ok(await openDoc(OLD), "alice's document in the folder 'Old notes' opens");
await openChip(0);
await click(flagBtn("reference"));
await click("[data-testid=flag-reason-other]");
await click("[data-testid=flag-send]");
await sleep(1500);
const spaced = (await db()).flags.length === 1 && (await has("[data-testid=flag-done]"));
const shownSpaced = await text("[data-testid=flag-problem]");
xfail(spaced, "a reference can be flagged from a document in a folder with a space (the real route reads from.ref with documentPathsIn, which stops at the space, and answers 400)", "rw-doc-path-spaces");
ok(spaced || (/The flag was not accepted/.test(shownSpaced ?? "") && (await db()).flags.length === 0), `today the person is told it was not accepted and nothing is made: ${shownSpaced}`);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
