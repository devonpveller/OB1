// Headless-Chromium e2e for the Settings frame (rwr-settings-shell), driven over CDP. Run by run-settings-e2e.ps1 inside an
// --internal lab network with the stub in settings.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
// Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AXE = readFileSync("/axe/axe.min.js", "utf8");

// One browser TAB with its own event log. A second tab is "another browser": the lab clears its storage for the origin first
// and the test checks the page holds nothing, so what it shows can only have come from the account.
async function client() {
  const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const key = async (k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  const go = async (path) => {
    events.length = 0;
    await send("Page.navigate", { url: origin + path });
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && (!document.querySelector('[data-testid=settings]') || !!document.querySelector('[data-testid=spanel]') || !!document.querySelector('[data-testid=settings-failed]'))`)) break;
    }
    await sleep(200);
  };
  const reqs = () => events.filter((e) => e.method === "Network.requestWillBeSent").map((e) => ({ method: e.params.request.method, url: e.params.request.url }));
  const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
  const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && ((e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
    || e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))));
  const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
  // type into a field: focus, select all, insert, then Tab away (the field saves when you leave it)
  const type = async (sel, text) => {
    await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.select&&e.select()})()`);
    await send("Input.insertText", { text });
    await key("Tab", "Tab", 9);
  };
  const waitFor = async (expr, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
  return { send, ev, key, go, reqs, problems, scheme, type, waitFor };
}
const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");

async function axe(c, label) {
  await c.ev(AXE + ";1");
  const r = await c.ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,160)).slice(0,4)})),pass:r.passes.length,cc:(r.passes.find(p=>p.id==='color-contrast')||{nodes:[]}).nodes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed, ${r.cc} elements checked for contrast)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
}
const text = (c, sel) => c.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? null`);
const texts = (c, sel) => c.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
const section = (c, id) => c.ev(`document.querySelector('[data-testid=sec-${id}]').click()`).then(() => sleep(150));

// ---- 1. alice (not an admin): the frame, the legend, the stance, a tag on every row, no admin anything
const A = await client();
await A.scheme("light");
await setMode("alice");
await A.go("/settings");
ok((await text(A, "h1")) === "Settings", "the Settings screen opens (not a placeholder)");
ok(!(await A.ev(`!!document.querySelector('[data-testid=coming]')`)), "no 'coming in phase' state");
ok(JSON.stringify(await texts(A, "[data-testid=legend] .tag")) === JSON.stringify(["Only you", "Stays on this server", "Sent to a cloud provider", "Admin changes it for everyone"]), "the legend names the four tags");
ok(/No setting carries this tag yet/.test((await text(A, "[data-testid=legend-cloud]")) || ""), "and says no setting carries the cloud tag yet");
ok(!/cloud/i.test(await A.ev(`(()=>{const s=document.querySelector('[data-testid=stance]').cloneNode(true);s.querySelector('[data-testid=legend]').remove();return s.textContent})()`)), "the privacy stance prose says nothing about cloud");
ok(JSON.stringify(await texts(A, "[data-testid=snav] button")) === JSON.stringify(["Start screen", "My ideas", "Daily digest and podcast", "Research defaults", "Library"]), "Yours sections: Start screen, My ideas, Daily digest and podcast, Research defaults, Library");
ok((await text(A, "[data-testid=admin-heading]")) === null && !/Admin only/.test(await A.ev(`document.body.innerText`)), "no 'Admin only' section for alice");
await section(A, "user-refinery");
ok(JSON.stringify(await texts(A, "[data-testid^=setting-] [data-testid=tag]")) === JSON.stringify(["Stays on this server", "Stays on this server"]), "every row of My ideas carries its tag");
ok(!(await A.ev(`!!document.querySelector('[data-testid="setting-ui.locked_document"], [data-testid="setting-library.recent"]')`)), "the app's own state keys are not offered as a form");
// the wire, not the CSS
const lg1 = await stub("/__log");
ok(lg1.filter((x) => x.mode === "alice").every((x) => !/settings\/admin/.test(x.url)), "alice's page never asked for the shared tier");
const wire1 = (await stub("/__wire")).filter((w) => w.mode === "alice");
ok(wire1.length > 0 && wire1.every((w) => !/ADMINONLY|research\.max_fetch|curator\.|archive_destination/.test(w.body)), `no settings response sent to alice holds an admin key or label (${wire1.length} responses)`);
ok(!/ADMINONLY/.test(await A.ev(`document.documentElement.outerHTML`)), "and the page itself holds none (not even hidden)");
ok(A.problems().length === 0, `no console errors/warnings/exceptions (${A.problems().length})`);
ok(A.reqs().every((r) => r.url.startsWith(origin + "/")), "every request same-origin");

// ---- 2. save as you go: leave the field, "Saved", the account holds it
await A.type("[data-testid=setting-refinery\\.dormancy_days] [data-testid=control]", "30");
ok(await A.waitFor(`document.querySelector('[data-testid="saved-refinery.dormancy_days"]')?.textContent==='Saved'`), "a number saves when you leave the field and says 'Saved'");
const st = await stub("/__store");
ok(st["u-alice|refinery.dormancy_days"]?.value === 30 && st["u-alice|refinery.dormancy_days"]?.version === 1, `the account holds it: ${JSON.stringify(st["u-alice|refinery.dormancy_days"])}`);
await A.ev(`document.querySelector('[data-testid="setting-refinery.brainstorm"] [data-testid=control]').click()`);
ok(await A.waitFor(`document.querySelector('[data-testid="saved-refinery.brainstorm"]')?.textContent==='Saved'`), "a switch saves at once");
await A.type("[data-testid=setting-refinery\\.dormancy_days] [data-testid=control]", "9999");
ok(await A.waitFor(`!!document.querySelector('[data-testid="error-refinery.dormancy_days"]')`) && /Not saved: .*must be at most 365/.test((await text(A, '[data-testid="error-refinery.dormancy_days"]')) || ""), "a value the server refuses is shown in the server's words");
ok((await A.ev(`document.querySelector('[data-testid="setting-refinery.dormancy_days"] [data-testid=control]').value`)) === "30", "and the field goes back to what is stored");
await section(A, "user-ui");
ok((await A.ev(`document.querySelectorAll('select, datalist').length`)) === 0, "no native select or datalist on the screen (one-picker rule): the Start screen choice is a radio group");
await A.ev(`document.querySelector('[data-testid="setting-ui.start_screen"] [data-testid=control] input[value=library]').click()`);
ok(await A.waitFor(`document.querySelector('[data-testid="saved-ui.start_screen"]')?.textContent==='Saved'`), "a choice saves at once");

// ---- 3. another browser (a fresh tab with its storage cleared) shows the same values
const A2 = await client();
await A2.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
await A2.go("/settings");
ok(JSON.stringify(await A2.ev(`JSON.stringify([localStorage.length, sessionStorage.length, document.cookie])`)) === JSON.stringify(`[0,0,""]`), "the second browser holds nothing of its own");
await section(A2, "user-refinery");
ok((await A2.ev(`document.querySelector('[data-testid="setting-refinery.dormancy_days"] [data-testid=control]').value`)) === "30", "a value saved on one browser shows on another (30)");
ok((await A2.ev(`document.querySelector('[data-testid="setting-refinery.brainstorm"] [data-testid=control]').checked`)) === false, "and so does the switch (off)");
await section(A2, "user-ui");
ok((await A2.ev(`document.querySelector('[data-testid="setting-ui.start_screen"] [data-testid=control] input:checked')?.value`)) === "library", "and the choice (library)");
// a stale save from the first browser is refused, not overwritten
await section(A2, "user-refinery");
await A2.type("[data-testid=setting-refinery\\.dormancy_days] [data-testid=control]", "40");
ok(await A2.waitFor(`document.querySelector('[data-testid="saved-refinery.dormancy_days"]')?.textContent==='Saved'`), "the second browser saves 40");
await section(A, "user-refinery");
await A.type("[data-testid=setting-refinery\\.dormancy_days] [data-testid=control]", "50");
ok(await A.waitFor(`/Changed on another browser/.test(document.querySelector('[data-testid="error-refinery.dormancy_days"]')?.textContent||'')`), "a save made from a stale page is refused (nothing overwritten)");
ok(await A.waitFor(`document.querySelector('[data-testid="setting-refinery.dormancy_days"] [data-testid=control]').value==='40'`), "and the page shows the latest value (40)");

// ---- 4. bob never sees alice's values
await setMode("bob");
const B = await client();
await B.go("/settings");
await section(B, "user-refinery");
ok((await B.ev(`document.querySelector('[data-testid="setting-refinery.dormancy_days"] [data-testid=control]').value`)) === "14", "bob sees his own default (14), not alice's value");
ok(/Using the default/.test((await text(B, '[data-testid="setting-refinery.dormancy_days"]')) || ""), "and 'Using the default'");
ok((await B.ev(`document.querySelector('[data-testid="setting-refinery.brainstorm"] [data-testid=control]').checked`)) === true, "alice's switch is not bob's");
const wireB = (await stub("/__wire")).filter((w) => w.mode === "bob");
ok(wireB.length > 0 && wireB.every((w) => !/"value":(30|40|"library")|u-alice|ADMINONLY/.test(w.body)), `nothing sent to bob holds alice's values or an admin key (${wireB.length} responses)`);

// ---- 5. the admin: Admin only sections, each tagged, read through the admin route
await setMode("admin");
const D = await client();
await D.go("/settings");
ok((await text(D, "[data-testid=admin-heading]")) === "Admin only", "the admin has an 'Admin only' heading");
ok(JSON.stringify(await texts(D, "[data-testid=snav] button")) === JSON.stringify(["Start screen", "My ideas", "Daily digest and podcast", "Research defaults", "Library", "Podcast archive", "Research and curator limits"]), "and the shared sections");
await section(D, "admin-research");
ok(JSON.stringify(await texts(D, "[data-testid^=limits-] [data-testid=tag]")) === JSON.stringify(Array(3).fill("Admin changes it for everyone")), "each shared limit group (run size, judgement, curator) is tagged 'Admin changes it for everyone'");
const lgD = await stub("/__log");
ok(lgD.filter((x) => x.mode === "admin" && /settings\/admin/.test(x.url)).length >= 1, "the admin's page read the shared tier");
ok(D.problems().length === 0, `no console errors for the admin page (${D.problems().length})`);

// ---- 5b. rwr-settings-defaults: the ceiling, presets (no number input), the log, the hidden list, and the dialog's own defaults
await setMode("alice");
await A.go("/settings");
await section(A, "user-research");
ok(/Highest allowed: 80 \(the most pages one research run may read, set by an admin\)/.test((await text(A, "[data-testid=ceiling-research\\.ask_over_fetch]")) || ""), "a default with a ceiling shows the highest allowed value, in the server's words");
const reqsBefore = (await stub("/__log")).length;
await A.type("[data-testid=setting-research\\.ask_over_fetch] [data-testid=control]", "81");
ok(await A.waitFor(`/must be at most 80 \\(the most pages one research run may read, set by an admin\\)/.test(document.querySelector('[data-testid="error-research.ask_over_fetch"]')?.textContent||'')`), "a default above the admin ceiling is refused with the ceiling named");
ok((await stub("/__log")).slice(reqsBefore).every((x) => x.method !== "PUT"), "and the page sent nothing for it");
await A.type("[data-testid=setting-research\\.ask_over_fetch] [data-testid=control]", "20");
ok(await A.waitFor(`document.querySelector('[data-testid="saved-research.ask_over_fetch"]')?.textContent==='Saved'`), "a value at or under it saves");
await section(A, "user-library");
ok(JSON.stringify(await texts(A, "[data-testid^=notapplied-]")) === JSON.stringify(Array(4).fill("Kept now; applied when the Library opens.")), "every Library preference says it is kept now and applied when the Library opens");
ok(JSON.stringify(await A.ev(`JSON.stringify([...document.querySelectorAll('[data-testid=spanel] [data-key]')].map(e=>e.dataset.key))`)) === JSON.stringify(`["library.how_far_out","library.recent_size","library.clear_on_signout","library.hidden_suggestions"]`), "the Library section holds its four preferences");
ok((await text(A, "[data-testid=hidden-count]")) === "None hidden.", "hidden suggestions show a count (none hidden)");
await setMode("admin");
await D.go("/settings");
await section(D, "admin-research");
ok(await D.waitFor(`!!document.querySelector('[data-testid=limits]')`), "the admin sees the research limits as presets");
ok((await D.ev(`document.querySelectorAll('[data-testid=limits] input[type=number], [data-testid=limits] input[type=text], [data-testid=limits] select').length`)) === 0, "with no number field, text field or select: only presets");
await D.ev(`document.querySelector('[data-testid="preset-run_size-small"]').click()`);
ok(await D.waitFor(`document.querySelector('[data-testid="limits-saved-run_size"]')?.textContent==='Saved'`), "choosing a preset saves it ('Saved')");
ok(/In force: Small\./.test((await text(D, "[data-testid=limits-now-run_size]")) || ""), "and the page says which preset is in force");
await D.ev(`document.querySelector('[data-testid=log-show]').click()`);
ok(await D.waitFor(`/u-admin set .*: 80 to 24 \\(preset small\\)/.test(document.querySelector('[data-testid=log-line]')?.textContent||'')`), "the log shows who changed what, from what to what");
await setMode("alice");
await A.go("/settings");
await section(A, "user-research");
ok(/Highest allowed: 24/.test((await text(A, "[data-testid=ceiling-research\\.ask_over_fetch]")) || ""), "the person's ceiling follows the admin's preset (24)");
ok(!(await A.ev(`/ADMINONLY|Pages retrieved/.test(document.documentElement.outerHTML)`)), "and the person's page holds no admin limit");
await setMode("admin");
await D.go("/settings"); await section(D, "admin-research");
await D.ev(`document.querySelector('[data-testid="limits-reset-run_size"]').click()`);
ok(await D.waitFor(`!!document.querySelector('[data-testid="limits-confirm-run_size"]')`), "putting a group back asks first (no change is sent until the yes)");
await D.ev(`document.querySelector('[data-testid="limits-confirm-yes-run_size"]').click()`);
ok(await D.waitFor(`/In force: Standard\\./.test(document.querySelector('[data-testid=limits-now-run_size]')?.textContent||'')`), "the deployed defaults come back after one confirm");
await setMode("alice");

// ---- 6. keyboard and WCAG AA (axe), light and dark, for a person and for the admin
await setMode("alice");
await A.go("/settings");
await A.ev(`document.activeElement.blur()`);
let reachedControl = false, ring = false;
for (let i = 0; i < 60 && !reachedControl; i++) {
  await A.key("Tab", "Tab", 9);
  const s = JSON.parse(await A.ev(`(()=>{const e=document.activeElement;const r=e.closest('label.seg-o')||e;const cs=getComputedStyle(r);return JSON.stringify({c:e.dataset.testid==='control'||!!e.closest('[data-testid=control]'),ow:parseFloat(cs.outlineWidth),os:cs.outlineStyle})})()`));
  if (s.c) { reachedControl = true; ring = s.os !== "none" && s.ow >= 2; }
}
ok(reachedControl, "Tab reaches a setting's control");
ok(ring, "and it shows a focus ring of at least 2px");
for (const sch of ["light", "dark"]) {
  await A.scheme(sch); await A.go("/settings");
  await axe(A, `${sch} Settings (alice, Start screen)`);
  await section(A, "user-refinery"); await axe(A, `${sch} Settings (alice, My ideas, with a saved value and a Back to default link)`);
  await section(A, "user-digest"); await axe(A, `${sch} Settings (alice, Daily digest)`);
  await section(A, "user-research"); await axe(A, `${sch} Settings (alice, Research defaults, with the ceiling)`);
  await section(A, "user-library"); await axe(A, `${sch} Settings (alice, Library)`);
  await setMode("admin");
  await D.scheme(sch); await D.go("/settings"); await section(D, "admin-research"); await D.ev(`document.querySelector('[data-testid=log-show]')?.click()`); await sleep(200); await axe(D, `${sch} Settings (admin, Research and curator limits, presets and log)`);
  await setMode("alice");
}
await A.scheme("light");
await A.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: false });
await A.go("/settings");
ok(!(await A.ev(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`)), "at 390 px wide the page does not scroll sideways");
// 400 px: nothing inside main overflows its own box, for a person (defaults) and for the admin (presets and the log)
await A.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
const overflow = `JSON.stringify([...document.querySelectorAll('main *')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible'&&e.clientWidth>0).map(e=>e.tagName+'.'+e.className).slice(0,5))`;
for (const sec of ["user-research", "user-library", "user-digest"]) { await A.go("/settings"); await section(A, sec); ok((await A.ev(overflow)) === "[]" && !(await A.ev(`document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1`)), `400 px: no overflow inside main (${sec})`); }
await setMode("admin");
await D.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
await D.go("/settings"); await section(D, "admin-research"); await D.ev(`document.querySelector('[data-testid=log-show]')?.click()`); await sleep(200);
ok(!(await D.ev(`document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth + 1`)), "400 px: no overflow inside main (the admin's presets and log)");

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
