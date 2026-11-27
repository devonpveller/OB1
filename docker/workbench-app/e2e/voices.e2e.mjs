// Headless-Chromium e2e for the Cast and voices screen (rwr-voices), driven over CDP. Run by run-voices-e2e.ps1 inside an --internal
// lab network with the stub in voices.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
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
const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 150; i++) { if (await ev(expr)) return true; await sleep(150); } return false; };
const go = async (path) => {
  events.length = 0;
  await send("Page.navigate", { url: origin + path });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && !!document.querySelector('[data-testid=voices]') && !document.querySelector('[data-testid=voices-loading],[data-testid=voices-waiting]')`)) break;
  }
  await sleep(250);
};
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
// a trusted click (a real mouse event): playing audio needs a user gesture
async function realClick(sel) {
  const r = JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return JSON.stringify({x:b.x+b.width/2,y:b.y+b.height/2})})()`));
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
}
const clickRow = (name) => ev(`[...document.querySelectorAll('[data-testid=row]')].find(r=>r.querySelector('.row-name').textContent===${JSON.stringify(name)}).click()`);
const clickText = (sel, text) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`);
const setVal = (selOrLabel, value) => ev(`(()=>{const l=[...document.querySelectorAll('.f label')].find(x=>x.querySelector('.f-label')?.textContent===${JSON.stringify(selOrLabel)});const e=l.querySelector('input,textarea');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const checkLabel = (text) => ev(`[...document.querySelectorAll('label.opt')].find(l=>l.textContent.trim()===${JSON.stringify(text)}).querySelector('input').click()`);
const tab = async (k) => { await click(`[data-testid=tab-${k}]`); await sleep(250); };
const ids = await stub("/__ids");
const state = () => stub("/__state");

// anything wider than the screen inside main: the main element itself, and every element's right edge and own scroll width
async function overflow(label) {
  const o = JSON.parse(await ev(`(()=>{const m=document.querySelector('main');const mr=m.getBoundingClientRect();const bad=[];
    for(const e of m.querySelectorAll('*')){const b=e.getBoundingClientRect();if(b.width===0&&b.height===0)continue;
      if(b.right>mr.right+1&&getComputedStyle(e).position!=='fixed')bad.push((e.getAttribute('data-testid')||e.className||e.tagName)+':'+Math.round(b.right-mr.right));
      else if(e.scrollWidth>e.clientWidth+1&&e.clientWidth>0&&e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA')bad.push('inner:'+(e.getAttribute('data-testid')||e.className||e.tagName)+':'+(e.scrollWidth-e.clientWidth));}
    return JSON.stringify({main:m.scrollWidth-m.clientWidth,doc:document.documentElement.scrollWidth-document.documentElement.clientWidth,bad:bad.slice(0,6)})})()`));
  ok(o.main <= 0 && o.doc <= 0 && o.bad.length === 0, `${label}: nothing overflows inside main at ${await ev("innerWidth")} px ${JSON.stringify(o)}`);
}

// ---- 1. alice: the lists, only her own rows, the editor of the first presenter, no console problems, the door
await scheme("light"); await setMode("alice"); await go("/cast");
ok((await ev(`document.querySelector('h1')?.textContent`)) === "Cast and voices" && (await ev(`document.title`)) === "Cast and voices - Research workbench", "the screen opens with its heading and a title that names no presenter");
const names = await read("[data-testid=row] .row-name");
ok(names.length === 4 && names[0] === "ALPHA Alex" && names.every((n) => /^ALPHA/.test(n)), `alice's four presenters are listed, none of bob's: ${JSON.stringify(names).slice(0, 160)}`);
ok(!/BRAVO|Bobbie/.test(await ev(`document.documentElement.outerHTML`)), "nothing of bob's is in the page");
ok(problems().length === 0, `no console errors/warnings/exceptions (${problems().length})` + JSON.stringify(problems().map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)));
const rq1 = reqs().filter((r) => /\/workbench\//.test(r.url));
ok(rq1.every((r) => r.url.startsWith(origin + "/") && r.method === "GET") && rq1.some((r) => /cast\/presenters\?scope=mine/.test(r.url)) && !rq1.some((r) => /scope=shared/.test(r.url)), `opening the screen made only same-origin GET reads of the caller's own scope (${rq1.length})`);
ok((await stub("/__log")).every((x) => x.keyOk), "the stub saw the door key on every request");
await clickRow("ALPHA Morgan");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Morgan'`);
ok(!(await ev(`!!document.querySelector('select, datalist')`)), "there is no select or datalist on the screen");
ok((await ev(`document.querySelector('[data-testid=pitch-note]')?.textContent`)) === "Pitch is not available on this voice engine." && (await ev(`!!document.querySelector('[data-testid=untested]')`)), "the pitch note and the Untested marker are shown");
ok(!(await ev(`/model/i.test(document.querySelector('[data-testid=editor]').innerText)`)), "no model route is offered");
for (const sch of ["light", "dark"]) { await scheme(sch); await axe(`${sch} Cast and voices, a presenter open`); }
await scheme("light");

// ---- 2. a presenter edit is what the server stores
await setVal("Tone", "warm and unhurried");
await click("[data-testid=save]");
ok(await waitFor(`!!document.querySelector('[data-testid=saved]')`), "Save says Saved");
let st = await state();
const morgan = st.presenters.find((p) => p.id === ids.morgan);
ok(morgan.tone === "warm and unhurried" && morgan.personality === "Calm and precise", "the server holds the new tone and left the other fields alone");
// the voice: a shared link is split, an own link is edited in place
await clickRow("ALPHA Sam"); await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Sam'`);
await ev(`[...document.querySelectorAll('[data-testid=voice-picker] label')].find(l=>l.textContent.trim()==='am_michael').querySelector('input').click()`);
await click("[data-testid=save]");
await waitFor(`!!document.querySelector('[data-testid=saved]')`);
st = await state();
const sam = st.presenters.find((p) => p.id === ids.sam);
ok(sam.voice_id !== ids.vShared && st.voices.find((v) => v.id === sam.voice_id).voice === "am_michael" && st.voices.find((v) => v.id === ids.vShared).voice === "af_bella" && st.presenters.find((p) => p.id === ids.alex).voice_id === ids.vShared,
  "changing the voice of a presenter that shares its voice link gives it a link of its own; the others keep theirs");

// ---- 3. the sample: a real click plays audio through the app's own door; the stub saw one POST for this voice link, in alice's name
await clickRow("ALPHA Morgan"); await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Morgan'`);
const before = (await stub("/__log")).length;
await realClick("[data-testid=sample-play]");
ok(await waitFor(`/Play again/.test(document.querySelector('[data-testid=sample-play]')?.textContent||'')`, 10000), "Play sample plays: the button says Play again once the browser is playing the sample");
const asked = (await stub("/__log")).slice(before).filter((x) => /sample/.test(x.url));
ok(asked.length === 1 && asked[0].method === "POST" && asked[0].url === `/workbench/contract/cast/voices/${ids.vMorgan}/sample` && asked[0].who === "alice", `exactly one sample request, for this voice link: ${JSON.stringify(asked)}`);
ok((await state()).samples.length === 1 && reqs().every((r) => /^http:\/\/[\d.]+:8080\//.test(r.url) || r.url.startsWith("blob:") || r.url.startsWith("data:") || r.url === "about:blank"), "the browser asked only the app's own origin (the audio itself is a blob made from the answer)");
ok(problems().length === 0, `playing the sample raised no console problem (a blocked media source would) (${problems().length})`);
await ev(`document.querySelector('[data-testid=voice-picker] input[type=radio]:not(:checked)').click()`);
ok((await ev(`document.querySelector('[data-testid=sample-play]').disabled`)) && /Save to hear/.test(await ev(`document.querySelector('[data-testid=sample-hint]')?.textContent||''`)), "an unsaved voice cannot be sampled: the button is off and says to save first");
await go("/cast"); await clickRow("ALPHA Morgan");
for (const [mode, re] of [["unset", "not set up"], ["down", "did not answer"]]) {
  await hook("sample", { mode });
  await realClick("[data-testid=sample-play]");
  ok(await waitFor(`new RegExp(${JSON.stringify(re)}).test(document.querySelector('[data-testid=sample-msg]')?.textContent||'')`), `a sample that cannot be made says why (${mode})`);
}
await hook("sample", { mode: "ok" });
async function hook(name, o = {}) { return fetch(`http://stub:9000/__hook/${name}`, { method: "POST", body: JSON.stringify(o) }).then((r) => r.json()); }

// ---- 4. teams and formats
await tab("teams"); await clickRow("ALPHA Morning team");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Morning team'`);
ok(JSON.stringify(await read("[data-testid=team-order] .seat-name")) === JSON.stringify(["ALPHA Morgan", "You", "ALPHA Sam"]), "the team shows its order with the user's seat");
await ev(`document.querySelector('[aria-label="Move You up"]').click()`);
await ev(`document.querySelector('[aria-label="Add ALPHA Alex"]').click()`);
await click("[data-testid=save]");
await waitFor(`!!document.querySelector('[data-testid=saved]')`);
st = await state();
const team = st.teams.find((t) => t.id === ids.team);
ok(JSON.stringify(team.members) === JSON.stringify([ids.morgan, ids.sam, ids.alex]) && team.user_seat === 0, "the server holds the new order and the user's seat");
await tab("formats"); await clickRow("ALPHA Daily brief");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Daily brief'`);
await checkLabel("Debate"); await checkLabel("a research run"); await setVal("Briefing", "Take sides.");
await click("[data-testid=save]");
await waitFor(`!!document.querySelector('[data-testid=saved]')`);
st = await state();
const fmt = st.formats.find((f) => f.id === ids.fmt);
ok(fmt.kind === "debate" && JSON.stringify(fmt.use_for) === JSON.stringify(["daily", "research"]) && fmt.briefing === "Take sides." && fmt.is_default === true, "the server holds the format's kind, uses and briefing");
await scheme("dark"); await axe("dark formats"); await scheme("light");

// ---- 5. a destructive confirmation belongs to one row; while it is open the other destructive buttons are off
await tab("presenters"); await clickRow("ALPHA Alex");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Alex'`);
await click("[data-testid=delete]");
ok((await ev(`document.querySelector('[data-testid=typed-confirm]')?.getAttribute('data-target')`)) === ids.alex && (await ev(`document.querySelector('[data-testid=delete]').disabled && document.querySelector('[data-testid=new]').disabled`)), "the confirmation is keyed to this presenter and the other destructive and create buttons are off while it is open");
await clickRow("ALPHA Sam");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Sam'`);
ok(!(await ev(`!!document.querySelector('[data-testid=typed-confirm]')`)) && (await state()).presenters.some((p) => p.id === ids.alex), "moving to another row drops the confirmation; nothing was deleted");

// ---- 6. nothing overflows inside main at 400 px: every tab, an editor open, the longest content
await viewport(400, 800); await go("/cast");
await overflow("400 px: presenters list");
await clickRow("ALPHA Morgan"); await sleep(300); await overflow("400 px: a presenter open");
await clickRow("ALPHA " + "Unbroken" + "x".repeat(200)); await sleep(300); await overflow("400 px: the longest presenter open");
await tab("teams"); await overflow("400 px: teams list"); await clickRow("ALPHA Morning team"); await sleep(300); await overflow("400 px: a team open");
await tab("formats"); await overflow("400 px: formats list"); await clickRow("ALPHA Daily brief"); await sleep(300); await overflow("400 px: a format open");
await scheme("dark"); await axe("dark, 400 px, a format open"); await scheme("light");
await viewport(1440, 900);

// ---- 7. two identities: bob's own cast; nothing of alice's, her rows are the one 404, her sample is refused like a missing id
await setMode("bob"); await go("/cast");
const bobRows = await read("[data-testid=row] .row-name");
const bobHtml = await ev(`document.documentElement.outerHTML`);
ok(JSON.stringify(bobRows) === JSON.stringify(["BRAVO Bobbie"]) && !/ALPHA|u-alice|Alice Lab/.test(bobHtml), "bob sees only his own presenter and no ALPHA anywhere " + JSON.stringify(bobRows) + " " + JSON.stringify((bobHtml.match(/.{40}(ALPHA|u-alice|Alice Lab).{40}/) || [""])[0]));
const probe = async (method, url) => JSON.parse(await ev(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},cache:'no-store'}).then(async r=>JSON.stringify({s:r.status,b:await r.text()}))`));
const theirs = await probe("POST", `/workbench/contract/cast/voices/${ids.vMorgan}/sample`);
const nothing = await probe("POST", `/workbench/contract/cast/voices/voice-nope/sample`);
ok(theirs.s === 404 && theirs.s === nothing.s && theirs.b === nothing.b, "alice's voice sample, asked by bob, is the same answer as a missing voice");
const p1 = await probe("GET", `/workbench/contract/cast/presenters/${ids.morgan}`), p2 = await probe("GET", `/workbench/contract/cast/presenters/presenter-nope`);
ok(p1.s === 404 && p1.b === p2.b, "alice's presenter, asked by bob, is the same answer as a missing one");
await scheme("dark"); await axe("dark, bob"); await scheme("light");

// ---- 8. a person switch without a reload: alice has an unsaved draft, a sample playing and a delete open; then bob is on the page
await setMode("alice"); await go("/cast"); await clickRow("ALPHA Morgan");
await waitFor(`document.querySelector('[data-testid=editor-name]')?.textContent==='ALPHA Morgan'`);
await setVal("Tone", "ALPHA-UNSENT-DRAFT");
await click("[data-testid=delete]");
ok(/ALPHA-UNSENT-DRAFT/.test(await ev(`document.documentElement.outerHTML`) + await ev(`[...document.querySelectorAll('input,textarea')].map(e=>e.value).join(' ')`)), "live switch: alice has an unsent draft and a delete confirmation open");
await setMode("bob");
let sw = false;
for (let i = 0; i < 80 && !sw; i++) { await sleep(500); sw = await ev(`/Bob/.test(document.querySelector('[data-testid=avatar]')?.getAttribute('aria-label')||'')`); }
ok(sw, "live switch: the top bar now says bob (the shell's refresh)");
await waitFor(`!document.querySelector('[data-testid=voices-loading]')`, 10000);
await sleep(500);
const gone = !/ALPHA|UNSENT/i.test(await ev(`document.documentElement.outerHTML + [...document.querySelectorAll('input,textarea')].map(e=>e.value).join(' ')`));
ok(gone && JSON.stringify(await read("[data-testid=row] .row-name")) === JSON.stringify(["BRAVO Bobbie"]) && !(await ev(`!!document.querySelector('[data-testid=typed-confirm]')`)), "live switch: the lists, the editor, the draft and the delete confirmation are gone; bob's own cast is shown");
await setMode("alice");

// ---- 9. nothing kept
await go("/cast");
const fin = JSON.parse(await ev(`(async()=>JSON.stringify({ls:Object.keys(localStorage).filter(k=>k!=='workbench.theme').length,ss:sessionStorage.length,ck:document.cookie,caches:(typeof caches!=='undefined'?await caches.keys():[]).length,idb:(indexedDB.databases?await indexedDB.databases():[]).length}))()`));
ok(fin.ls === 0 && fin.ss === 0 && fin.ck === "" && fin.caches === 0 && fin.idb === 0, `at the end: storage, cookies, caches, IndexedDB hold nothing but the theme: ${JSON.stringify(fin)}`);
const fromCache = events.filter((e) => e.method === "Network.responseReceived" && /\/workbench\//.test(e.params.response.url) && (e.params.response.fromDiskCache || e.params.response.fromServiceWorker));
ok(fromCache.length === 0, "no /workbench/ read was answered from the browser's cache");
const lg = await stub("/__log");
ok(lg.every((x) => x.keyOk) && lg.every((x) => !/alpha|bravo|u-alice|u-bob/i.test(x.url)), "every request carried the door key and no URL names a person or a presenter's words");

ws.close();
await fetch(`http://${CH}:9222/json/close/${tgt.id}`).catch(() => {});
console.log(fails ? `E2E FAIL (${fails})` : "E2E PASS");
process.exit(fails ? 1 : 0);
