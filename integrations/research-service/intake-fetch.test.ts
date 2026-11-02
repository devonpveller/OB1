/** rw-p5a-intake: the research service's proxy-bound fetch for a user's add (POST /intake/fetch).
 *
 *  One fetch path for every inlet (the panel's general and contextual adds, the OWUI inlet): the
 *  workbench asks this service, which fetches through its FETCH_PROXY_URL client - the same egress as
 *  the page fetcher and the scholarly resolver (proxiedFetch), never a bare fetch. The three declared
 *  content types are a web page, a PDF and a YouTube transcript. A user-supplied URL is judged before
 *  any byte leaves (http/https only, no credentials, no private / loopback / link-local / internal
 *  address or name), redirects are never followed by the client and every hop is judged again.
 *  Run: deno test intake-fetch.test.ts */
import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { INTAKE_CONTENT_TYPES, IntakeRefused, intakeFetch, intakeTarget, youtubeId } from "./intake-fetch.ts";
import { proxiedFetch } from "./scholarly.ts";

type Init = RequestInit & { client?: unknown };
const CLIENT = { proxy: "http://vpn:8888" };
// the resolver the fetch judges every hop's name with (round 2, tester T-F2): public by default
const PUBLIC_IP = "93.184.215.14";
function fakeWeb(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}) {
  const calls: { url: string; client: unknown; redirect: unknown }[] = [];
  const resolved: string[] = [];
  const resolve = (host: string) => {
    resolved.push(host);
    return Promise.resolve(dns[host] ?? [PUBLIC_IP]);
  };
  const raw = (url: string, init: Init = {}) => {
    calls.push({ url, client: init.client, redirect: init.redirect });
    const h = routes[url];
    return Promise.resolve(h ? h() : new Response("nope", { status: 404 }));
  };
  return { calls, resolved, resolve, fetch: proxiedFetch(raw, CLIENT) };
}
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

Deno.test("the declared intake content types are web page, PDF and YouTube transcript", () => {
  assertEquals([...INTAKE_CONTENT_TYPES], ["web_article", "pdf", "youtube_transcript"]);
});

Deno.test("a fetch that is not the proxy-bound one is refused before anything leaves", async () => {
  await assertRejects(() => intakeFetch("https://example.org/a", { fetch: ((u: string) => fetch(u)) as never, resolve: () => Promise.resolve(["93.184.215.14"]) }), Error, "proxy");
});

Deno.test("the target is judged before any byte leaves", () => {
  for (const bad of ["ftp://example.org/x", "https://user:pw@example.org/", "http://127.0.0.1/", "http://10.1.2.3/",
    "http://172.18.0.5:8000/", "http://192.168.1.20/", "http://169.254.169.254/latest/meta-data", "http://[::1]/",
    "http://100.64.0.1/", "http://localhost:8080/", "http://openbrain-db:5432/", "http://vpn.internal/", "http://box.local/", "not a url"]) {
    const t = intakeTarget(bad);
    assert(!t.ok, `refused: ${bad}`);
  }
  assert(intakeTarget("https://www.ncbi.nlm.nih.gov/pubmed/40128952").ok);
});

Deno.test("a web page: one proxied GET, its text and title, the egress recorded", async () => {
  const w = fakeWeb({ "https://example.org/a": html("<html><head><title>Tone study</title></head><body><p>A pure tone at 100 Hz eased motion sickness.</p></body></html>") });
  const r = await intakeFetch("https://example.org/a", { fetch: w.fetch, resolve: w.resolve });
  assertEquals([r.content_type, r.title, r.final_url, r.egress], ["web_article", "Tone study", "https://example.org/a", "proxy"]);
  assert(r.text!.includes("100 Hz eased motion sickness"));
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].client, CLIENT);
  assertEquals(w.calls[0].redirect, "manual");
});

Deno.test("a redirect is judged hop by hop: a public page 302 to an internal address is refused", async () => {
  const w = fakeWeb({
    "https://example.org/r": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8000/admin" } }),
  });
  const e = await assertRejects(() => intakeFetch("https://example.org/r", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
  assertEquals(e.code, "refused_target");
  assertEquals(w.calls.map((c) => c.url), ["https://example.org/r"]);
});

Deno.test("a public redirect is followed by this service (each hop through the proxy) and recorded", async () => {
  const w = fakeWeb({
    "https://example.org/r": () => new Response(null, { status: 301, headers: { location: "/final" } }),
    "https://example.org/final": html("<title>Final</title><p>final body text here</p>"),
  });
  const r = await intakeFetch("https://example.org/r", { fetch: w.fetch, resolve: w.resolve });
  assertEquals([r.final_url, r.redirects], ["https://example.org/final", ["https://example.org/final"]]);
  assert(w.calls.every((c) => c.client === CLIENT));
});

Deno.test("a PDF comes back as its bytes (the workbench's extractor reads it), within the cap", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n% a tiny pdf\n");
  const w = fakeWeb({ "https://example.org/p.pdf": () => new Response(pdf, { headers: { "content-type": "application/pdf" } }) });
  const r = await intakeFetch("https://example.org/p.pdf", { fetch: w.fetch, resolve: w.resolve });
  assertEquals(r.content_type, "pdf");
  assertEquals(atob(r.bytes_b64!), "%PDF-1.4\n% a tiny pdf\n");
  const big = fakeWeb({ "https://example.org/big.pdf": () => new Response(new Uint8Array(64), { headers: { "content-type": "application/pdf" } }) });
  const e = await assertRejects(() => intakeFetch("https://example.org/big.pdf", { fetch: big.fetch, resolve: big.resolve, maxBytes: 16 }), IntakeRefused);
  assertEquals(e.code, "too_large");
});

Deno.test("another media type is refused (not one of the declared three)", async () => {
  const w = fakeWeb({ "https://example.org/x.zip": () => new Response("PK", { headers: { "content-type": "application/zip" } }) });
  const e = await assertRejects(() => intakeFetch("https://example.org/x.zip", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
  assertEquals(e.code, "unsupported_type");
});

Deno.test("an upstream error status is a fixed code, never the page's body", async () => {
  const w = fakeWeb({ "https://example.org/gone": html("<p>secret error page</p>", 500) });
  const e = await assertRejects(() => intakeFetch("https://example.org/gone", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
  assertEquals(e.code, "upstream_status");
  assert(!e.message.includes("secret"));
});

Deno.test("YouTube: the video id from every link shape, nothing else", () => {
  assertEquals(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assertEquals(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assertEquals(youtubeId("https://m.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assertEquals(youtubeId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assertEquals(youtubeId("https://example.org/watch?v=dQw4w9WgXcQ"), null);
  assertEquals(youtubeId("https://www.youtube.com/watch?v=bad"), null);
});

Deno.test("YouTube transcript: the watch page's caption track, fetched through the proxy, as text", async () => {
  const player = {
    videoDetails: { title: "Pure tones and motion sickness" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=de", languageCode: "de" },
      { baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en", languageCode: "en" },
    ] } },
  };
  const w = fakeWeb({
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ": html(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var x=1;</script>`),
    "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&fmt=json3": () =>
      Response.json({ events: [{ segs: [{ utf8: "a one minute tone" }] }, { segs: [{ utf8: "\n" }] }, { segs: [{ utf8: "at 100 Hz" }] }] }),
  });
  const r = await intakeFetch("https://youtu.be/dQw4w9WgXcQ", { fetch: w.fetch, resolve: w.resolve });
  assertEquals([r.content_type, r.title], ["youtube_transcript", "Pure tones and motion sickness"]);
  assertEquals(r.text, "a one minute tone at 100 Hz");
  assert(w.calls.every((c) => c.client === CLIENT));
});

Deno.test("YouTube without captions, or a caption host that is not YouTube's, is refused", async () => {
  const none = fakeWeb({ "https://www.youtube.com/watch?v=dQw4w9WgXcQ": html(`<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"t"}};</script>`) });
  assertEquals((await assertRejects(() => intakeFetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: none.fetch, resolve: none.resolve }), IntakeRefused)).code, "no_transcript");
  const player = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "http://169.254.169.254/x", languageCode: "en" }] } } };
  const evil = fakeWeb({ "https://www.youtube.com/watch?v=dQw4w9WgXcQ": html(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`) });
  assertEquals((await assertRejects(() => intakeFetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: evil.fetch, resolve: evil.resolve }), IntakeRefused)).code, "no_transcript");
  assertEquals(evil.calls.length, 1);
});

Deno.test("a declared type the link is not is refused, never coerced", async () => {
  const w = fakeWeb({ "https://example.org/a": html("<p>page</p>") });
  assertEquals((await assertRejects(() => intakeFetch("https://example.org/a", { fetch: w.fetch, resolve: w.resolve }, "youtube_transcript"), IntakeRefused)).code, "type_mismatch");
  assertThrows(() => { throw new IntakeRefused("x", "y"); });
});

Deno.test("only the workspace's caller key may ask for an intake fetch; the route is wired to the proxy-bound fetch", async () => {
  const { mayIntakeFetch } = await import("./intake-fetch.ts");
  assertEquals(mayIntakeFetch({ name: "workspace", origin: "workspace", key: "k".repeat(16), shared: false }), true);
  assertEquals(mayIntakeFetch({ name: "owui-tool", origin: "owui", key: "k".repeat(16), shared: false }), false);
  assertEquals(mayIntakeFetch({ name: "shared-key", origin: "manual", key: "k".repeat(16), shared: true }), false);
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const route = src.slice(src.indexOf('url.pathname === "/intake/fetch"'));
  assert(route.length > 0 && src.includes('url.pathname === "/intake/fetch"'), "index.ts serves POST /intake/fetch");
  const handler = route.slice(0, route.indexOf("\n  }\n"));
  assert(handler.includes("intakeFetch(") && handler.includes("intakeProxiedFetch"), "the route calls intakeFetch with the proxy-bound fetch");
  assert(!/\bfetch\(\s*body/.test(handler), "no bare fetch of the body's url in the route");
});

// ── round 2 (tester T-F2): names that resolve to an internal address ─────────────────────────────
Deno.test("round 2: a wildcard-DNS name (nip.io, sslip.io, localtest.me, ...) is refused by name, before any lookup or fetch", async () => {
  for (const u of ["http://127.0.0.1.nip.io/", "http://192-168-192-6.nip.io:8080/healthz", "http://10.0.0.5.sslip.io/", "http://a.b.sslip.io/",
    "http://localtest.me/", "http://anything.localtest.me/", "http://lvh.me/", "http://x.xip.io/", "http://1u.ms/", "http://x.traefik.me/"]) {
    assert(!intakeTarget(u).ok, `refused by name: ${u}`);
    const w = fakeWeb({ [u]: html("<p>internal</p>") });
    const e = await assertRejects(() => intakeFetch(u, { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
    assertEquals([e.code, w.calls.length, w.resolved.length], ["refused_target", 0, 0], u);
  }
});

Deno.test("round 2: every name is resolved and every answer judged - a private, loopback, link-local, CGNAT or mixed answer is refused, nothing fetched", async () => {
  for (const [name, answer] of [["rebind.example.com", ["10.0.0.5"]], ["lo.example.com", ["127.0.0.1"]], ["meta.example.com", ["169.254.169.254"]],
    ["cg.example.com", ["100.64.1.1"]], ["docker.example.com", ["172.18.0.5"]], ["lan.example.com", ["192.168.1.20"]],
    ["mixed.example.com", ["93.184.215.14", "10.0.0.5"]], ["v6lo.example.com", ["::1"]], ["v6ula.example.com", ["fd00::5"]],
    ["v6ll.example.com", ["fe80::1"]], ["v6mapped.example.com", ["::ffff:10.0.0.5"]], ["v6nat64.example.com", ["64:ff9b::a00:5"]],
    ["none.example.com", []]] as [string, string[]][]) {
    const u = `https://${name}/page`;
    const w = fakeWeb({ [u]: html("<p>internal</p>") }, { [name]: answer });
    const e = await assertRejects(() => intakeFetch(u, { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
    assertEquals([e.code, w.calls.length], ["refused_target", 0], `${name} -> ${answer.join(",")}`);
  }
});

Deno.test("round 2: a redirect hop is resolved and judged the same way - a public page 302 to a name that resolves privately is refused", async () => {
  const w = fakeWeb({
    "https://example.org/r": () => new Response(null, { status: 302, headers: { location: "https://rebind.example.com/admin" } }),
    "https://rebind.example.com/admin": html("<p>internal</p>"),
  }, { "rebind.example.com": ["10.0.0.5"] });
  const e = await assertRejects(() => intakeFetch("https://example.org/r", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
  assertEquals([e.code, w.calls.map((c) => c.url), w.resolved], ["refused_target", ["https://example.org/r"], ["example.org", "rebind.example.com"]]);
  const nip = fakeWeb({ "https://example.org/r": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1.nip.io/" } }) });
  assertEquals((await assertRejects(() => intakeFetch("https://example.org/r", { fetch: nip.fetch, resolve: nip.resolve }), IntakeRefused)).code, "refused_target");
  assertEquals(nip.calls.length, 1);
});

Deno.test("round 2: no resolver, no fetch (the guard is never skipped)", async () => {
  const w = fakeWeb({ "https://example.org/a": html("<p>x</p>") });
  await assertRejects(() => intakeFetch("https://example.org/a", { fetch: w.fetch } as never), Error, "resolver");
  assertEquals(w.calls.length, 0);
});

Deno.test("round 2: the DoH resolver asks A and AAAA over the proxy-bound fetch (RFC 8484 wire format) and reads every answer", async () => {
  const { dohResolver, dnsQuery } = await import("./intake-fetch.ts");
  const asked: { url: string; client: unknown; accept: string | null }[] = [];
  const answer = (q: Uint8Array, type: number) => {
    // header: id, flags (response, RD, RA), qd=1, an=1; the question copied; one answer pointing at it
    const head = new Uint8Array([q[0], q[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    const question = q.subarray(12);
    const rdata = type === 1 ? new Uint8Array([10, 0, 0, 5]) : new Uint8Array([0x20, 1, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const rr = new Uint8Array([0xc0, 12, 0, type, 0, 1, 0, 0, 0, 60, 0, rdata.length, ...rdata]);
    return new Uint8Array([...head, ...question, ...rr]);
  };
  const raw = (url: string, init: RequestInit & { client?: unknown } = {}) => {
    asked.push({ url, client: init.client, accept: new Headers(init.headers).get("accept") });
    const b64 = new URL(url).searchParams.get("dns")!.replace(/-/g, "+").replace(/_/g, "/");
    const q = Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0));
    const type = q[q.length - 3];
    return Promise.resolve(new Response(answer(q, type), { headers: { "content-type": "application/dns-message" } }));
  };
  const r = dohResolver(proxiedFetch(raw, CLIENT), "https://dns.mullvad.net/dns-query");
  assertEquals((await r("rebind.example.com")).sort(), ["10.0.0.5", "2001:db8::1"]);
  assertEquals(asked.length, 2);
  assert(asked.every((a) => a.client === CLIENT && a.accept === "application/dns-message" && a.url.startsWith("https://dns.mullvad.net/dns-query?dns=")));
  assertEquals(dnsQuery("example.org", 1).length, 12 + 13 + 4);
});

// ── round 3 (reviewer R1): ports and the gate's remaining internal suffixes ─────────────────────────
Deno.test("round 3: only ports 80 and 443; .localdomain, .private and .ts.net are internal names", async () => {
  for (const u of ["http://example.org:8080/", "https://example.org:8443/", "http://example.org:22/", "http://example.org:5432/x",
    "http://box.localdomain/", "http://db.private/", "http://node.tail1234.ts.net/", "http://a.b.ts.net:443/"]) {
    assert(!intakeTarget(u).ok, `refused: ${u}`);
  }
  for (const u of ["http://example.org/", "https://example.org/", "http://example.org:80/", "https://example.org:443/a"]) {
    assert(intakeTarget(u).ok, `allowed: ${u}`);
  }
  const w = fakeWeb({
    "https://example.org/r": () => new Response(null, { status: 302, headers: { location: "https://example.org:8443/admin" } }),
  });
  assertEquals((await assertRejects(() => intakeFetch("https://example.org/r", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused)).code, "refused_target");
  assertEquals(w.calls.length, 1, "the hop to another port is never fetched");
});

// ── round 4 (reviewer N1): more than one trailing dot, or an empty label, never slips a name past the guard ─────
Deno.test("round 4: every trailing dot is stripped and an empty label refused (x.ts.net.., box.private.., localhost.., 127.0.0.1.nip.io..)", async () => {
  for (const u of ["http://x.ts.net../", "http://box.private../", "http://localhost../", "http://127.0.0.1.nip.io../",
    "http://x.ts.net.../", "http://a..example.org/", "http://.example.org/"]) {
    assert(!intakeTarget(u).ok, `refused: ${u}`);
    const w = fakeWeb({ [u]: html("<p>internal</p>") });
    const e = await assertRejects(() => intakeFetch(u, { fetch: w.fetch, resolve: w.resolve }), IntakeRefused);
    assertEquals([e.code, w.calls.length, w.resolved.length], ["refused_target", 0, 0], u);
  }
  assert(intakeTarget("https://example.org./a").ok, "one trailing dot on a public name is still that name");
  for (const loc of ["http://x.ts.net../", "http://127.0.0.1.nip.io../", "http://localhost../"]) {
    const w = fakeWeb({ "https://example.org/r": () => new Response(null, { status: 302, headers: { location: loc } }) });
    assertEquals((await assertRejects(() => intakeFetch("https://example.org/r", { fetch: w.fetch, resolve: w.resolve }), IntakeRefused)).code, "refused_target", loc);
    assertEquals([w.calls.length, w.resolved], [1, ["example.org"]], `${loc}: the hop is neither resolved nor fetched`);
  }
});
