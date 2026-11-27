// Headless-Chromium e2e for Settings > Appearance (rwr-appearance), driven over CDP. Run by run-appearance-e2e.ps1 inside an
// --internal lab network with the stub in appearance.stub.mjs (the shared fake: appearance-fake.mjs). Env: APP_IP, CH (Chrome
// host), LAB_KEY. /axe/axe.min.js is axe-core. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AXE = readFileSync("/axe/axe.min.js", "utf8");

// One browser TAB with its own event log.
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
    await sleep(300);
  };
  const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
  const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && ((e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
    || e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))));
  const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
  // type into a field: focus, select all, insert text
  const type = async (sel, text) => {
    await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.select&&e.select()})()`);
    await send("Input.insertText", { text });
  };
  const waitFor = async (expr, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
  return { send, ev, key, go, problems, scheme, type, waitFor };
}

const text = (c, sel) => c.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? null`);
const texts = (c, sel) => c.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
const attrs = (c) => c.ev(`JSON.stringify(["data-theme","data-accent","data-density","data-text-size"].map(a=>document.documentElement.getAttribute(a)))`).then(JSON.parse);
const radio = (c, name) => c.ev(`(()=>{const l=[...document.querySelectorAll('[data-testid=appearance] label.seg-o')].find(x=>x.textContent.trim()===${JSON.stringify(name)});if(!l)return false;l.querySelector('input').click();return true})()`);
const pickR = async (c, name) => { const r = await radio(c, name); await sleep(300); return r; };
const button = (c, label) => c.ev(`(()=>{const b=[...document.querySelectorAll('[data-testid=appearance] button')].find(b=>b.textContent==='${label}');if(!b)return false;b.click();return true})()`);
const stub = async (p, method = "GET", body) => (await fetch(`http://stub:9000${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const storeOf = async (sub, key) => (await stub("/__store"))[`${sub}|${key}`]?.value;
const bg = (c) => c.ev(`getComputedStyle(document.body).backgroundColor`);
const isDarkBg = (s) => { const m = /rgb\((\d+), (\d+), (\d+)/.exec(s); return !!m && Number(m[1]) < 80 && Number(m[2]) < 80 && Number(m[3]) < 80; };
const btnBg = (c) => c.ev(`getComputedStyle(document.querySelector('.ap-p-primary')).backgroundColor`);
const openAppearance = async (c) => { await c.go("/settings"); await c.waitFor(`!!document.querySelector('[data-testid=appearance]')`); };

async function axe(c, label) {
  await c.ev(AXE + ";1");
  const r = await c.ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,160)).slice(0,4)})),pass:r.passes.length,cc:(r.passes.find(p=>p.id==='color-contrast')||{nodes:[]}).nodes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed, ${r.cc} elements checked for contrast)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
}
// nothing inside <main> sticks out sideways: the page does not scroll, main does not, and no descendant's box passes main's edge
async function noOverflow(c, label) {
  const r = await c.ev(`(()=>{const m=document.querySelector('main');const R=m.getBoundingClientRect();const bad=[];
    for(const e of m.querySelectorAll('*')){const b=e.getBoundingClientRect();if(b.width&&(b.right>R.right+1||b.left<R.left-1))bad.push(e.className+':'+Math.round(b.right-R.right));if(e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=='visible')bad.push('inner-scroll '+e.className)}
    return JSON.stringify({page:document.documentElement.scrollWidth-document.documentElement.clientWidth,main:m.scrollWidth-m.clientWidth,bad:bad.slice(0,6)})})()`);
  const o = JSON.parse(r);
  ok(o.page <= 1 && o.main <= 1 && o.bad.length === 0, `${label}: no sideways overflow in the page, in main, or inside it (${r})`);
}

// ---- 1. alice, light device: the section, built of radio groups, the preview and the privacy tags
const A = await client();
await A.scheme("light");
await setMode("alice");
await openAppearance(A);
ok((await text(A, "[data-testid=section-title]")) === "Appearance", "Settings > Appearance is there (not a placeholder)");
ok(!(await A.ev(`!!document.querySelector('select, datalist')`)), "no <select> and no <datalist> anywhere on the page");
ok((await A.ev(`document.querySelectorAll('[data-testid=appearance] [role=radiogroup]').length`)) >= 4, "theme, accent, density and text size are radio groups");
ok((await texts(A, "[data-testid=appearance] [data-testid^=setting-ui] [data-testid=tag]")).every((t) => t === "Only you") , "each appearance row carries its 'Only you' tag");
ok(/Upgrading the workstation CPU/.test(await text(A, "[data-testid=ap-preview]")), "a live preview is shown");
ok(!(await A.ev(`/Appearance|private/i.test(document.title)`)), "the page title carries no setting name");
const t0 = await btnBg(A);

// ---- 2. a choice applies at once and is saved to the account; a second browser (storage cleared) shows the same
ok(await pickR(A, "Dark"), "choose Dark"); await pickR(A, "Indigo"); await pickR(A, "Compact"); await pickR(A, "16 px");
ok(JSON.stringify(await attrs(A)) === JSON.stringify(["dark", "indigo", "compact", "16"]), "applied at once: data-theme, data-accent, data-density, data-text-size");
ok((await btnBg(A)) !== t0, "the preview's filled button changed colour with the accent");
ok(JSON.stringify([await storeOf("u-alice", "ui.theme"), await storeOf("u-alice", "ui.accent"), await storeOf("u-alice", "ui.density"), await storeOf("u-alice", "ui.text_size")]) === JSON.stringify(["dark", "indigo", "compact", "16"]), "and saved to the account");
const B2 = await client();
await B2.scheme("light");
await B2.ev(`(()=>{try{localStorage.clear();sessionStorage.clear()}catch(e){}})()`);
await B2.go("/settings"); await B2.waitFor(`document.documentElement.getAttribute('data-accent')==='indigo'`);
ok(JSON.stringify(await attrs(B2)) === JSON.stringify(["dark", "indigo", "compact", "16"]), "a second browser with empty storage shows the same (the account holds it)");
ok((await B2.ev(`JSON.stringify(Object.keys(localStorage))`)) === `["workbench.theme"]` && (await B2.ev(`sessionStorage.length`)) === 0, "the only thing the browser keeps is workbench.theme (the first-paint cache)");

// ---- 3. the two theme modes: an explicit choice wins over the device, System follows it (bob: nothing stored)
await setMode("bob");
const C = await client();
await C.scheme("dark"); await openAppearance(C);
ok((await attrs(C))[0] === null && isDarkBg(await bg(C)), `System + a dark device: the page is dark (${await bg(C)})`);
await pickR(C, "Light");
ok((await attrs(C))[0] === "light" && !isDarkBg(await bg(C)), `explicit Light wins over a dark device (${await bg(C)})`);
await pickR(C, "System");
ok((await attrs(C))[0] === null && isDarkBg(await bg(C)), "back to System: the dark device decides again");
await C.scheme("light");
await sleep(200);
ok(!isDarkBg(await bg(C)), "System + a light device: the page is light");
await C.scheme("dark");
await pickR(C, "Dark");
await C.scheme("light"); await sleep(200);
ok((await attrs(C))[0] === "dark" && isDarkBg(await bg(C)), "explicit Dark wins over a light device");
await button(C, "Workbench default"); await sleep(400);
await setMode("alice");

// ---- 4. AA in the browser: axe for every accent, light and dark (explicit), and system on a dark device
const D = await client();
for (const theme of ["Light", "Dark"]) {
  await D.scheme(theme === "Light" ? "light" : "dark");
  await openAppearance(D);
  await pickR(D, theme);
  for (const acc of ["Teal", "Indigo", "Amber", "Rose", "Slate"]) {
    await pickR(D, acc);
    await axe(D, `${theme} + ${acc} (Appearance)`);
  }
}
await D.scheme("dark"); await openAppearance(D); await pickR(D, "System"); await pickR(D, "Teal"); await axe(D, "system on a dark device + Teal");

// ---- 5. saved themes: save, apply, the cap of ten, delete
const S = await client();
await S.scheme("light"); await openAppearance(S);
const nameBox = `[data-testid=appearance] input[type=text]`;
const save = async (name) => { await S.type(nameBox, name); await button(S, "Save as theme"); await sleep(300); };
await pickR(S, "Slate"); await pickR(S, "15 px");
await save("Night reading");
ok(JSON.stringify(await texts(S, "[data-testid=saved-theme] .ap-name")) === JSON.stringify(["Night reading"]), "a saved theme is listed");
await pickR(S, "Rose"); await pickR(S, "14 px (default)");
await S.ev(`document.querySelector('[aria-label="Apply Night reading"]').click()`); await sleep(600);
ok((await attrs(S))[1] === "slate" && (await attrs(S))[3] === "15", "Apply puts its choices back");
for (let i = 2; i <= 10; i++) await save("Theme " + i);
ok(/10 of 10/.test(await text(S, "[data-testid=ap-count]")), "ten themes are kept");
ok(await S.ev(`[...document.querySelectorAll('[data-testid=appearance] button')].find(b=>b.textContent==='Save as theme').disabled`), "the eleventh cannot be saved: the button is off");
ok(/You can keep 10 saved themes/.test(await text(S, "[data-testid=appearance]")), "and the page says why");
const w = await stub("/__wire");
ok(!w.some((x) => x.method === "PUT" && x.url.endsWith("ui.saved_themes") && x.status === 400), "the page never sent an eleventh theme");
await axe(S, "light + ten saved themes");
await S.ev(`document.querySelector('[aria-label="Delete Theme 2"]').click()`); await sleep(500);
ok(/9 of 10/.test(await text(S, "[data-testid=ap-count]")), "delete makes room");

// ---- 6. Workbench default
await button(S, "Workbench default"); await sleep(800);
ok(JSON.stringify(await attrs(S)) === JSON.stringify([null, null, null, null]), "Workbench default: every data attribute is gone");
ok((await storeOf("u-alice", "ui.theme")) === undefined && (await storeOf("u-alice", "ui.accent")) === undefined && (await storeOf("u-alice", "ui.density")) === undefined && (await storeOf("u-alice", "ui.text_size")) === undefined, "and every stored choice is deleted from the account");
ok(Array.isArray(await storeOf("u-alice", "ui.saved_themes")) && (await storeOf("u-alice", "ui.saved_themes")).length === 9, "the saved themes stay");

// ---- 7. two people: bob never sees alice's themes or choices
await setMode("bob");
const Bb = await client();
await Bb.scheme("light"); await openAppearance(Bb);
ok(!/Night reading|Theme 3/.test(await Bb.ev(`document.body.innerText`)), "bob's page names none of alice's saved themes");
ok(JSON.stringify(await attrs(Bb)) === JSON.stringify([null, null, null, null]), "bob sees the defaults");
const bobWire = (await stub("/__wire")).filter((x) => x.sub === "u-bob").map((x) => x.body).join("\n");
ok(!/Night reading|Theme 3/.test(bobWire), "and no answer sent to bob holds one");
await setMode("alice");

// ---- 8. odd and unknown stored values, and storage that throws
await stub("/__plant/u-alice/ui.theme", "POST", "sepia");
await stub("/__plant/u-alice/ui.accent", "POST", 12);
await stub("/__plant/u-alice/ui.saved_themes", "POST", [{ name: "Old", theme: "dark", accent: "magenta", density: "compact", text_size: "18" }, "junk"]);
const E = await client();
await E.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{const t=()=>{throw new DOMException('denied','SecurityError')};for(const m of ['getItem','setItem','removeItem','clear'])Storage.prototype[m]=t;})()` });
await E.scheme("light"); await openAppearance(E);
ok((await attrs(E)).every((x) => x === null), "a stored theme that no longer exists, a number accent and a throwing storage: the defaults, the page loads");
ok(JSON.stringify(await texts(E, "[data-testid=saved-theme] .ap-name")) === JSON.stringify(["Old"]), "a saved theme with a gone accent is still listed");
await pickR(E, "Dark");
ok((await attrs(E))[0] === "dark", "and a choice still applies for the page");
ok(E.problems().length === 0, "no console error or warning with storage throwing: " + JSON.stringify(E.problems().slice(0, 2)));

// ---- 9. 400 px: nothing inside main overflows (the page, main, and inner boxes)
const M = await client();
await M.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
await M.scheme("light"); await openAppearance(M);
await noOverflow(M, "400 px, light");
for (const f of ["Dark", "Compact", "18 px"]) await pickR(M, f);
await noOverflow(M, "400 px, dark, compact, 18 px, saved themes listed");
await axe(M, "400 px dark (Appearance)");

ok(A.problems().length === 0 && D.problems().length === 0 && S.problems().length === 0, "no console error or warning in the browser tabs");
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
