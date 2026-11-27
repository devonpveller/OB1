// Headless-Chromium e2e for Settings > Notifications (rwr-notify-prefs), driven over CDP. Run by run-notify-e2e.ps1 inside an
// --internal lab network with the stub in notify.stub.mjs. Env: APP_IP, CH (Chrome host), LAB_KEY. /axe/axe.min.js is axe-core.
// Covers every acceptance line a person can see: a class switched off leaves MY bell and not another person's; the sign-in row is
// always on (and a refused off is not reachable from the page); the email column is disabled and nothing is sent; the choices are
// the account's (another tab with empty storage shows them) and per person (bob sees his own); nothing overflows at 400 px; axe;
// no private text in the page title or storage. Every check prints PASS/FAIL; the exit code is 1 on any failure.
import { readFileSync } from "node:fs";

const APP = process.env.APP_IP, CH = process.env.CH || "127.0.0.1";
const origin = `http://${APP}:8080`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AXE = readFileSync("/axe/axe.min.js", "utf8");

async function client(width = 1440) {
  const tgt = await (await fetch(`http://${CH}:9222/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CH}:9222`));
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  for (const m of ["Network.enable", "Page.enable", "Log.enable", "Runtime.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  const go = async (path) => {
    events.length = 0;
    await send("Page.navigate", { url: origin + path });
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (await ev(`!!document.querySelector('[data-testid=rail]') && !!document.querySelector('[data-testid=avatar]') && (!!document.querySelector('[data-testid=spanel]') || !!document.querySelector('[data-testid=settings-failed]'))`)) break;
    }
    await sleep(200);
  };
  const LAB_NOISE = /Cross-Origin-Opener-Policy header has been ignored/;
  const problems = () => events.filter((e) => !LAB_NOISE.test(JSON.stringify(e.params)) && ((e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level))
    || e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))));
  const waitFor = async (expr, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const scheme = (v) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: v }] });
  return { send, ev, go, problems, waitFor, scheme };
}
const stub = async (p, method = "GET") => (await fetch(`http://stub:9000${p}`, { method })).json();
const setMode = (m) => stub(`/__mode/${m}`, "POST");
const bell = async () => (await (await fetch("http://stub:9000/workbench/contract/notifications")).json()).notifications.map((n) => n.class);

async function axe(c, label) {
  await c.ev(AXE + ";1");
  const r = await c.ev(`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>({v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.map(n=>n.target.join(' ')+' :: '+(n.any[0]?.message||n.all[0]?.message||'').slice(0,160)).slice(0,4)})),pass:r.passes.length}))`);
  ok(r.v.length === 0, `axe ${label}: ${r.v.length} violations (${r.pass} rules passed)` + (r.v.length ? " " + JSON.stringify(r.v) : ""));
}
const text = (c, sel) => c.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? null`);
const texts = (c, sel) => c.ev(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(e=>e.textContent.trim()))`).then(JSON.parse);
const openNotifications = async (c) => { await c.ev(`document.querySelector('[data-testid=sec-user-notify]').click()`); await c.waitFor(`!!document.querySelector('[data-testid=notifications]')`); };
const row = (k) => `[data-testid="setting-${k}"]`;
const checked = (c, k) => c.ev(`document.querySelector('${row(k)} [data-testid=control]').checked`);
const disabled = (c, k) => c.ev(`document.querySelector('${row(k)} [data-testid=control]').disabled`);
const click = (c, k) => c.ev(`document.querySelector('${row(k)} [data-testid=control]').click()`);

// ---- 1. alice: the section, the rows, the email column
const A = await client();
await A.scheme("light");
await setMode("alice");
await A.go("/settings");
ok(JSON.stringify(await texts(A, "[data-testid=snav] button")) === JSON.stringify(["Start screen", "Notifications"]), "Yours sections: Start screen, Notifications");
await openNotifications(A);
ok((await text(A, "[data-testid=section-title]")) === "Notifications", "the section is called Notifications");
ok(JSON.stringify(await texts(A, "[data-testid=notifications] .s-label")) === JSON.stringify(["Events about your work", "Problems that need a fix", "The model did not perform", "Sign-in from a new device"]), "one row per kind, the sign-in row last");
ok(JSON.stringify(await texts(A, "[data-testid=email-note]")) === JSON.stringify(Array(4).fill("Needs a mail service")), "the email column says 'Needs a mail service' on every row");
ok(await A.ev(`[...document.querySelectorAll('[data-testid=email-control]')].every(e=>e.disabled&&!e.checked)`), "every email box is disabled and unchecked");
ok(await A.ev(`(()=>{document.querySelectorAll('[data-testid=email-control]').forEach(e=>e.click());return [...document.querySelectorAll('[data-testid=email-control]')].every(e=>!e.checked)})()`), "clicking an email box does nothing");
ok(!(await A.ev(`!!document.querySelector('[data-testid=notifications] select, [data-testid=notifications] datalist, [data-testid=notifications] input[type=text]')`)), "no native select, datalist or text field");
ok(await checked(A, "notify.sign_in_new_device") && await disabled(A, "notify.sign_in_new_device"), "the sign-in row is on and disabled");
ok((await text(A, `${row("notify.sign_in_new_device")} [data-testid=always-on]`)) === "Always on", "and says 'Always on'");
await click(A, "notify.sign_in_new_device");
await sleep(300);
const lg0 = await stub("/__log");
ok(!lg0.some((r) => r.method === "PUT"), "clicking the sign-in switch sent no request");
ok((await bell()).join() === "informational,structural,transient,sign_in_new_device", "alice's bell shows every kind before any choice");
await axe(A, "Notifications (alice, light)");
await A.scheme("dark");
await axe(A, "Notifications (alice, dark)");
await A.scheme("light");

// ---- 2. a switch off: saved, in alice's bell only
await click(A, "notify.informational");
ok(await A.waitFor(`document.querySelector('[data-testid="saved-notify.informational"]')?.textContent==='Saved'`), "switching 'Events about your work' off says Saved");
ok(!(await checked(A, "notify.informational")), "and the switch shows off");
ok((await bell()).join() === "structural,transient,sign_in_new_device", "alice's bell no longer shows informational events, the rest stay (sign-in included)");
await click(A, "notify.transient");
await A.waitFor(`document.querySelector('[data-testid="saved-notify.transient"]')?.textContent==='Saved'`);
ok((await bell()).join() === "structural,sign_in_new_device", "two kinds off: only structural and sign-in remain");
const store1 = await stub("/__store");
ok(store1["u-alice|notify.informational"]?.value === false && store1["u-alice|notify.informational"]?.version === 1 && !("u-alice|notify.sign_in_new_device" in store1), "the account holds false for the two kinds, and nothing for the sign-in key");

// ---- 3. another browser (a new tab with its storage cleared) shows the account's choices; nothing in browser storage
const A2 = await client();
await A2.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
await A2.go("/settings");
await openNotifications(A2);
ok(!(await checked(A2, "notify.informational")) && !(await checked(A2, "notify.transient")) && await checked(A2, "notify.structural"), "another browser shows the same choices (they live with the account)");
ok((await A.ev(`localStorage.length + sessionStorage.length`)) === 0 || !/notify/i.test(await A.ev(`JSON.stringify([localStorage, sessionStorage])`)), "no notification choice is kept in browser storage");
ok(!/notif|bell/i.test(await A.ev(`document.title`)), "the page title says nothing about notifications");

// ---- 4. bob: his own panel, alice's choices are not his, and his bell is unchanged
await setMode("bob");
const B = await client();
await B.go("/settings");
await openNotifications(B);
ok(await checked(B, "notify.informational") && await checked(B, "notify.transient") && await checked(B, "notify.structural"), "bob (nothing stored) sees every kind on");
ok((await bell()).join() === "informational,structural,transient,sign_in_new_device", "bob's bell still shows every kind");
const wireB = (await stub("/__wire")).filter((w) => w.mode === "bob").map((w) => w.body).join("\n");
ok(!/u-alice/.test(wireB) && !/"value":false/.test(wireB), "no response to bob holds alice's name or her choices");
await click(B, "notify.structural");
await B.waitFor(`document.querySelector('[data-testid="saved-notify.structural"]')?.textContent==='Saved'`);
const store2 = await stub("/__store");
ok(store2["u-alice|notify.informational"]?.value === false && store2["u-bob|notify.structural"]?.value === false && !("u-bob|notify.informational" in store2), "bob's save is bob's; alice's values were not touched");

// ---- 5. a small screen: nothing overflows inside main at 400 px
await setMode("alice");
const S = await client(400);
await S.go("/settings");
await openNotifications(S);
const over = await S.ev(`(()=>{const m=document.querySelector('[data-testid=main]');const r=m.getBoundingClientRect();return {sw:m.scrollWidth,cw:m.clientWidth,doc:document.documentElement.scrollWidth,vw:window.innerWidth,wide:[...m.querySelectorAll('*')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.right>r.right+1}).map(e=>e.tagName+'.'+e.className).slice(0,5)}})()`);
ok(over.sw <= over.cw + 1 && over.doc <= over.vw + 1 && over.wide.length === 0, `at 400 px nothing overflows main (main ${over.sw}/${over.cw}, page ${over.doc}/${over.vw}, wide: ${over.wide.join(", ") || "none"})`);
await axe(S, "Notifications (400 px)");

for (const [n, c] of [["alice", A], ["alice2", A2], ["bob", B], ["small", S]]) {
  const pr = c.problems();
  ok(pr.length === 0, `no console errors or warnings (${n})` + (pr.length ? " " + JSON.stringify(pr.slice(0, 2)) : ""));
}
// the door key never reached the browser
const lg = await stub("/__log");
// (the driver's own reads of the stub's bell, /workbench/contract/notifications, are not the page's)
ok(lg.filter((r) => !r.url.startsWith("/__") && !r.url.startsWith("/workbench/contract/notifications")).every((r) => r.keyOk), "every request the page made to the workbench carried the door key from the server, not the page");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
