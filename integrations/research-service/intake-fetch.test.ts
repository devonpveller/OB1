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
function fakeWeb(routes: Record<string, () => Response>) {
  const calls: { url: string; client: unknown; redirect: unknown }[] = [];
  const raw = (url: string, init: Init = {}) => {
    calls.push({ url, client: init.client, redirect: init.redirect });
    const h = routes[url];
    return Promise.resolve(h ? h() : new Response("nope", { status: 404 }));
  };
  return { calls, fetch: proxiedFetch(raw, CLIENT) };
}
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

Deno.test("the declared intake content types are web page, PDF and YouTube transcript", () => {
  assertEquals([...INTAKE_CONTENT_TYPES], ["web_article", "pdf", "youtube_transcript"]);
});

Deno.test("a fetch that is not the proxy-bound one is refused before anything leaves", async () => {
  await assertRejects(() => intakeFetch("https://example.org/a", { fetch: ((u: string) => fetch(u)) as never }), Error, "proxy");
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
  const r = await intakeFetch("https://example.org/a", { fetch: w.fetch });
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
  const e = await assertRejects(() => intakeFetch("https://example.org/r", { fetch: w.fetch }), IntakeRefused);
  assertEquals(e.code, "refused_target");
  assertEquals(w.calls.map((c) => c.url), ["https://example.org/r"]);
});

Deno.test("a public redirect is followed by this service (each hop through the proxy) and recorded", async () => {
  const w = fakeWeb({
    "https://example.org/r": () => new Response(null, { status: 301, headers: { location: "/final" } }),
    "https://example.org/final": html("<title>Final</title><p>final body text here</p>"),
  });
  const r = await intakeFetch("https://example.org/r", { fetch: w.fetch });
  assertEquals([r.final_url, r.redirects], ["https://example.org/final", ["https://example.org/final"]]);
  assert(w.calls.every((c) => c.client === CLIENT));
});

Deno.test("a PDF comes back as its bytes (the workbench's extractor reads it), within the cap", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n% a tiny pdf\n");
  const w = fakeWeb({ "https://example.org/p.pdf": () => new Response(pdf, { headers: { "content-type": "application/pdf" } }) });
  const r = await intakeFetch("https://example.org/p.pdf", { fetch: w.fetch });
  assertEquals(r.content_type, "pdf");
  assertEquals(atob(r.bytes_b64!), "%PDF-1.4\n% a tiny pdf\n");
  const big = fakeWeb({ "https://example.org/big.pdf": () => new Response(new Uint8Array(64), { headers: { "content-type": "application/pdf" } }) });
  const e = await assertRejects(() => intakeFetch("https://example.org/big.pdf", { fetch: big.fetch, maxBytes: 16 }), IntakeRefused);
  assertEquals(e.code, "too_large");
});

Deno.test("another media type is refused (not one of the declared three)", async () => {
  const w = fakeWeb({ "https://example.org/x.zip": () => new Response("PK", { headers: { "content-type": "application/zip" } }) });
  const e = await assertRejects(() => intakeFetch("https://example.org/x.zip", { fetch: w.fetch }), IntakeRefused);
  assertEquals(e.code, "unsupported_type");
});

Deno.test("an upstream error status is a fixed code, never the page's body", async () => {
  const w = fakeWeb({ "https://example.org/gone": html("<p>secret error page</p>", 500) });
  const e = await assertRejects(() => intakeFetch("https://example.org/gone", { fetch: w.fetch }), IntakeRefused);
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
  const r = await intakeFetch("https://youtu.be/dQw4w9WgXcQ", { fetch: w.fetch });
  assertEquals([r.content_type, r.title], ["youtube_transcript", "Pure tones and motion sickness"]);
  assertEquals(r.text, "a one minute tone at 100 Hz");
  assert(w.calls.every((c) => c.client === CLIENT));
});

Deno.test("YouTube without captions, or a caption host that is not YouTube's, is refused", async () => {
  const none = fakeWeb({ "https://www.youtube.com/watch?v=dQw4w9WgXcQ": html(`<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"t"}};</script>`) });
  assertEquals((await assertRejects(() => intakeFetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: none.fetch }), IntakeRefused)).code, "no_transcript");
  const player = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "http://169.254.169.254/x", languageCode: "en" }] } } };
  const evil = fakeWeb({ "https://www.youtube.com/watch?v=dQw4w9WgXcQ": html(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`) });
  assertEquals((await assertRejects(() => intakeFetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { fetch: evil.fetch }), IntakeRefused)).code, "no_transcript");
  assertEquals(evil.calls.length, 1);
});

Deno.test("a declared type the link is not is refused, never coerced", async () => {
  const w = fakeWeb({ "https://example.org/a": html("<p>page</p>") });
  assertEquals((await assertRejects(() => intakeFetch("https://example.org/a", { fetch: w.fetch }, "youtube_transcript"), IntakeRefused)).code, "type_mismatch");
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
