// Lab stub workbench for the picker e2e (rwr-picker). One instance = ONE identity (env ID = A | B): the lab runs
// two stubs and two app containers, so "user A" and "user B" are two real, separate upstreams with planted data.
// Serves only what the picker asks: the contract search route (shared library + the caller's own held source for
// the caller's own refinery) and the lab-only own-thoughts path /workbench/__lab/mine (stands in for
// rwr-own-thoughts-search-api, which has not landed). Records every request at /__log. No dependencies.
import http from "node:http";

const ID = process.env.ID || "A";
const KEY = process.env.LAB_KEY;
const MY_REFINERY = `refinery-${ID.toLowerCase()}`;
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
const RAW = [
  { kind: "source", id: "s-alpha", title: "X299 VRM thermals under load", snippet: "VRMs reach 105 C: <<HL>>vrm<</HL>> data", state: "current", lifecycle: "active", page_class: null },
  { kind: "source", id: "s-beta", title: "Board vendor VRM power stage", snippet: "rated 165 W", state: "current", lifecycle: "active", page_class: null },
  { kind: "source", id: "s-gamma", title: "Retracted VRM forum post", snippet: "withdrawn", state: "current", lifecycle: "retracted", page_class: null },
  { kind: "claim", id: "c-1", title: "VRMs throttle under sustained all-core load", snippet: "VRMs throttle", state: "current", lifecycle: null, page_class: null },
  { kind: "claim", id: "c-2", title: "Stock coolers cannot hold a VRM at 250 W", snippet: "coolers", state: "current", lifecycle: null, page_class: null },
  { kind: "page", id: "workstation-hardware", title: "Workstation hardware (VRM section)", snippet: "pages on <<HL>>VRM<</HL>>", state: "current", lifecycle: null, page_class: "entity" },
  { kind: "page", id: "cooling", title: "Cooling and VRM thermals", snippet: "cooling", state: "current", lifecycle: null, page_class: "concept" },
  { kind: "source", id: "s-delta", title: "Noctua support reply on VRM airflow", snippet: "airflow", state: "current", lifecycle: "active", page_class: null },
];
// the contract's added hit fields (rwr-picker): topics, date, quality (0..1), cited_by (the CALLER's own documents only), author
const EXTRA = {
  "source:s-alpha": { topics: ["cooling", "vrm"], date: day(3), quality: 0.8, cited_by: ID === "A" ? 1 : 2, author: "Ada Lovelace" },
  "source:s-beta": { topics: ["vrm"], date: day(100), quality: 0.6, cited_by: 0, author: null },
  "source:s-gamma": { topics: [], date: "2024-01-01T00:00:00.000Z", quality: 0.3, cited_by: 0, author: null },
  "source:s-delta": { topics: ["airflow"], date: day(20), quality: 0.76, cited_by: 0, author: null },
  "claim:c-1": { topics: ["cooling"], date: day(10), quality: 0.9, cited_by: null, author: null },
  "claim:c-2": { topics: ["cooling"], date: day(400), quality: 0.5, cited_by: null, author: null },
  "page:workstation-hardware": { topics: ["hardware"], date: day(1), quality: null, cited_by: null, author: null },
  "page:cooling": { topics: ["cooling"], date: day(2), quality: null, cited_by: null, author: null },
};
const SHARED = RAW.map((r) => ({ ...r, ...(EXTRA[r.kind + ":" + r.id] ?? {}) }));
const HELD = { kind: "source", id: `held-${ID}`, title: `HELD-${ID} idea note on vrm`, snippet: "held", state: "held", lifecycle: "held", page_class: null, topics: [], date: day(5), quality: null, cited_by: null, author: null };
const MINE = [{ kind: "thought", id: `t-${ID}`, title: `${ID === "A" ? "A-SECRET alpha" : "B-OWN bravo"} plan thought`, snippet: "", state: "current", lifecycle: null, type: null }];
const log = [];

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__log") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(log)); }
  log.push({ method: req.method, url: req.url, keyOk: req.headers["x-brain-key"] === KEY });
  const q = (u.searchParams.get("q") || "").toLowerCase();
  // identity A's stub sends NO cache header (so the browser-side `cache: "no-store"` is what is tested); identity B's stub sends
  // the header the real route sends (so the forwarder passing it through is tested). Cacheable otherwise: a validator-less
  // answer is still kept by Chrome's HTTP cache and returned for only-if-cached.
  const send = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json", ...(ID === "B" && st === 200 ? { "cache-control": "no-store, private" } : {}) }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/workbench/contract/search") {
    let results = SHARED.filter((r) => (r.title + " " + r.snippet).toLowerCase().includes(q));
    // the route: a held source is returned only inside the CALLER's own refinery; another user's refinery scopes nothing
    if (u.searchParams.get("refinery_id") === MY_REFINERY && HELD.title.toLowerCase().includes(q)) results = results.concat([HELD]);
    return send({ query: q, kinds: [], scope: { refinery_id: null }, count: results.length, results });
  }
  if (u.pathname === "/workbench/__lab/mine") return send({ results: MINE.filter((m) => m.title.toLowerCase().includes(q)) });
  if (u.pathname === "/workbench/ping") return send({});
  send({ error: "not found" }, 404);
}).listen(9000, () => console.log(`stub ${ID} up`));
