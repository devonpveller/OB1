// node --test lib/ - research-workbench P1b (D13 item 7): the notifications
// strip reads the P0 read endpoint (stubbed here with the endpoint's shape),
// shows the unread count, class, subject, origin and a jump link, and an
// acknowledgement moves the reader's cookie; an endpoint that does not
// answer is a strip that says so, never a missing strip.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let list = [];
let status = 200;
let seenKey = null;
let calls = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/workbench/contract/notifications") {
    calls++;
    seenKey = req.headers["x-brain-key"];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify({ notifications: list }) : "{}");
    return;
  }
  if (u.pathname === "/rest/v1/wiki_pages") { // entity id -> its page
    const id = (u.searchParams.get("frontmatter->>entity_id") || "").replace(/^eq\./, "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(id === "901" ? [{ slug: "content/person/person-ada-fixture" }] : []));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.WORKBENCH_URL = base;
process.env.WORKBENCH_KEY = "fixture-key";
process.env.OPEN_BRAIN_URL = base;
process.env.WIKI_NOTIFY_TTL_MS = "0";
const N = await import("./notifications.mjs");
test.after(() => server.close());

const n = (id, cls, subject, lastSeen, extra = {}) => ({
  id, class: cls, subject, slug: null, entity: null, origin: null, error: null,
  first_seen: lastSeen, last_seen: lastSeen, count: 1, ...extra,
});

test("the strip shows unread count, class, subject, origin, count and a jump to the page or entity", async () => {
  N._resetNotificationsForTests();
  list = [
    n("11111111-1111-4111-8111-111111111111", "structural", "compile structural failure: content/person/person-bob-fixture", "2026-10-19T10:00:02Z",
      { slug: "content/person/person-bob-fixture", entity: "902", count: 3 }),
    n("22222222-2222-4222-8222-222222222222", "transient", "LLM call failing for this task: #901", "2026-10-19T10:00:01Z", { entity: "#901", origin: "deep_research" }),
    n("33333333-3333-4333-8333-333333333333", "informational", "a new idea has been added", "2026-10-19T10:00:00Z", { entity: "idea:abc" }),
  ];
  const html = await N.stripHtml({ cookie: "", back: "/content/person/person-ada-fixture" });
  assert.equal(seenKey, "fixture-key", "the P0 endpoint is called with the workbench key");
  assert.match(html, /^<div class="wiki-notifications" data-wiki-notifications="1" data-unread="3">/);
  assert.match(html, /3 unread research notifications/);
  assert.match(html, /<li class="wn-item" data-class="structural"[^>]*><span class="wn-class">structural<\/span> <a class="wn-jump" href="\/content\/person\/person-bob-fixture">compile structural failure: content\/person\/person-bob-fixture<\/a> <span class="wn-count">x3<\/span><\/li>/);
  assert.match(html, /data-class="transient"[^>]*><span class="wn-class">transient<\/span> <a class="wn-jump" href="\/content\/person\/person-ada-fixture">LLM call failing for this task: #901<\/a> <span class="wn-origin">deep_research<\/span>/);
  assert.match(html, /href="\/__notifications#n-33333333-3333-4333-8333-333333333333">a new idea has been added/);
  assert.match(html, /href="\/__notifications\/ack\?until=2026-10-19T10%3A00%3A02.000Z&amp;back=%2Fcontent%2Fperson%2Fperson-ada-fixture">acknowledge<\/a>/);
});

test("acknowledged notifications are not unread; a newer one is", async () => {
  N._resetNotificationsForTests();
  const ack = "wiki_notif_ack=" + encodeURIComponent("2026-10-19T10:00:01.000Z");
  const html = await N.stripHtml({ cookie: `other=1; ${ack}`, back: "/" });
  assert.match(html, /data-unread="1"/);
  assert.match(html, /1 unread research notification</);
  assert.doesNotMatch(html, /LLM call failing/);
  const all = await N.stripHtml({ cookie: "wiki_notif_ack=" + encodeURIComponent("2026-10-19T11:00:00Z"), back: "/" });
  assert.match(all, /data-unread="0"/);
  assert.doesNotMatch(all, /class="wn-ack"/);
  assert.equal(N.ackOf("wiki_notif_ack=garbage"), 0);
});

test("an endpoint that does not answer is a strip that says so", async () => {
  N._resetNotificationsForTests();
  status = 503;
  const html = await N.stripHtml({ cookie: "", back: "/" });
  status = 200;
  assert.match(html, /^<div class="wiki-notifications" data-wiki-notifications="1" data-unread="unknown">/);
  assert.match(html, /Research notifications unavailable/);
});

test("subjects are escaped; the list page anchors every notification; back is same-origin only", async () => {
  N._resetNotificationsForTests();
  list = [n("44444444-4444-4444-8444-444444444444", "structural", "<script>alert(1)</script>", "2026-10-19T12:00:00Z", { error: "a<b" })];
  const html = await N.stripHtml({ cookie: "", back: "/" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const page = await N.listDocument({ cookie: "" });
  assert.match(page, /<li id="n-44444444-4444-4444-8444-444444444444" class="unread">/);
  assert.match(page, /<pre>a&lt;b<\/pre>/);
  assert.equal(N.safeBack("/content/x?y=1"), "/content/x?y=1");
  assert.equal(N.safeBack("//evil.example/"), "/");
  assert.equal(N.safeBack("https://evil.example/"), "/");
  assert.equal(N.safeBack("/a\r\nSet-Cookie: x"), "/");
});

test("the strip is fresh within the TTL: a newly posted notification is on the next load", async () => {
  N._resetNotificationsForTests();
  list = [];
  const before = calls;
  assert.match(await N.stripHtml({ cookie: "", back: "/" }), /data-unread="0"/);
  list = [n("55555555-5555-4555-8555-555555555555", "transient", "model unavailable: stub-model", "2026-10-19T13:00:00Z")];
  assert.match(await N.stripHtml({ cookie: "", back: "/" }), /data-unread="1"[\s\S]*model unavailable: stub-model/);
  assert.equal(calls - before, 2, "TTL 0: every page load reads the endpoint");
});
