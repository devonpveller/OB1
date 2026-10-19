// deno test --allow-net --allow-env src/export/resolver_test.ts - the resolver against the tester's
// attempt-1 findings (rw-p6a-resolve attempt 2), through a REAL proxy client and Deno's real fetch:
//   ADV-2b  a 3xx is never followed (to the other service, to a third host, with the key echoed in
//           Location); only the configured hosts are ever requested; nothing from a 3xx is used
//   ADV-2a  a failure reason shown to the browser names a reason code + "egress", never an internal
//           address or host; the detail goes to the server log, secrets masked
//   ADV-3   a 200 record carrying the key, the mailto or a URL with a query is refused (not stored,
//           not rendered)
//   ADV-2c  an identifier that fails its kind's grammar is refused before any request
// Needs no pandoc and no database (runs in the image's test gate and on a host with Deno).
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { createResolver, RequestRefused, ResolutionFailed, type Resolver, type ResolverConfig } from "./resolver.ts";
import type { Identifier, IdentifierKind } from "./identifiers.ts";
import { parseCitekey } from "./identifiers.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { type ProxyMode, startProxy } from "./test_proxy.ts";

const KINDS: IdentifierKind[] = fxEntries("reference_identifier_kinds").map((e) => ({ key: e.key, ...e.definition }) as IdentifierKind);
const kind = (k: string) => KINDS.find((x) => x.key === k)!;
const KEY = "tadvSYNTHKEY0a1b2c3d4e5f";
const MAILTO = "tadv-synthmail@example.invalid";
const cfg = (proxyUrl: string, o: Partial<ResolverConfig> = {}): ResolverConfig => ({
  openalexKey: KEY, mailto: MAILTO, proxyUrl,
  openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 5000, ...o,
});
const DOI = (n: number) => parseCitekey(KINDS, `doi:10.5555/adv.${n}`);
const SECRETS = [KEY, MAILTO, encodeURIComponent(MAILTO)];
const noSecret = (s: string) => SECRETS.every((x) => !s.includes(x));

// Every logged request went to a configured host and carried what that host requires.
function compliant(log: { host: string; query: Record<string, string>; ua: string | null }[]) {
  return log.map((r) => {
    if (r.host === "api.openalex.stub") return r.query.api_key === KEY ? "" : `OpenAlex request without the key: ${JSON.stringify(r.query)}`;
    if (r.host === "api.crossref.stub") return r.query.mailto === MAILTO && (r.ua ?? "").includes(`mailto:${MAILTO}`) ? "" : `Crossref request without the mailto: ${JSON.stringify(r.query)}`;
    return `a request to a host that is not configured: ${r.host}`;
  }).filter(Boolean);
}

// real proxy clients made inside withProxy, closed when it ends (Deno's leak sanitizer)
const made: Resolver[] = [];
const mk = (...a: Parameters<typeof createResolver>) => {
  const r = createResolver(...a);
  made.push(r);
  return r;
};

async function withProxy(mode: ProxyMode, fn: (url: string, log: ReturnType<typeof startProxy>["log"]) => Promise<void>) {
  const p = startProxy(mode);
  try {
    await fn(p.url, p.log);
  } finally {
    made.splice(0).forEach((r) => r.close());
    await p.close();
  }
}

Deno.test("ADV-2b redirects: a 3xx is a hard failure, never followed - not to the other service, not to a third host, never with the key", async () => {
  // [mode, expected requests (the resolver's own), what the failure names]
  const cases: [ProxyMode, number, RegExp][] = [
    ["crToOA", 2, /Crossref answered a redirect \(3xx\), not followed/],
    ["oaToCR", 1, /OpenAlex answered a redirect \(3xx\), not followed/],
    ["toEvil", 1, /OpenAlex answered a redirect \(3xx\), not followed/],
    ["echoLocation", 1, /OpenAlex answered a redirect \(3xx\), not followed/],
  ];
  for (const [mode, want, why] of cases) {
    await withProxy(mode, async (url, log) => {
      const r = mk(cfg(url), { log: () => {} });
      const e = await assertRejects(() => r.resolve(DOI(400), kind("doi")), ResolutionFailed);
      assertMatch(e.message, why, `${mode}: ${e.message}`);
      assert(/\bredirect\b/.test(e.message), `${mode}: reason code 'redirect'`);
      assertEquals(compliant(log), [], `${mode}: every request the proxy saw is keyed / mailto'd and to a configured host`);
      assertEquals(log.length, want, `${mode}: ${want} request(s), 0 follow-ups: ${JSON.stringify(log.map((l) => l.host + l.path))}`);
      assert(!log.some((l) => l.host === "evil.stub"), `${mode}: nothing reached the third host`);
      assert(noSecret(e.message), `${mode}: the failure text carries no secret`);
    });
  }
});

Deno.test("hosts are pinned: a request may only target the configured OpenAlex and Crossref origins (checked before send)", async () => {
  await withProxy("ok", async (url, log) => {
    const r = mk(cfg(url), { log: () => {} });
    for (const bad of [
      `http://api.openalex.stub.evil/works/x?api_key=${KEY}`,
      `http://user@api.openalex.stub/works/x?api_key=${KEY}`,
      `https://api.openalex.stub/works/x?api_key=${KEY}`,
      `http://api.openalex.stub:81/works/x?api_key=${KEY}`,
      `http://evil.stub/works/x?api_key=${KEY}`,
      `http://api.crossref.stub/works/x?api_key=${KEY}`, // the other service's host under the OpenAlex door
    ]) {
      await assertRejects(() => r.send("openalex", bad), RequestRefused, undefined, bad);
    }
    await assertRejects(() => r.send("crossref", `http://api.openalex.stub/works/x?mailto=${MAILTO}`), RequestRefused);
    assertEquals(log.length, 0, "nothing left");
  });
});

Deno.test("the door asks fetch for redirect: 'manual' on every request (a fake that follows unless told not to)", async () => {
  const calls: { url: string; redirect: string | undefined }[] = [];
  const fetch = (url: string, init: RequestInit & { client?: Deno.HttpClient }) => {
    calls.push({ url, redirect: init.redirect });
    if (init.redirect !== "manual" && calls.length === 1) { // what fetch's default ("follow") would do
      calls.push({ url: "http://api.crossref.stub/works/10.5555/adv.401", redirect: init.redirect });
      return Promise.resolve(Response.json({ message: { title: ["followed"], type: "journal-article" } }));
    }
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://api.crossref.stub/works/10.5555/adv.401" } }));
  };
  const r = createResolver(cfg("http://proxy.invalid:8888"), { fetch, buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {} });
  await assertRejects(() => r.resolve(DOI(401), kind("doi")), ResolutionFailed, "redirect");
  assertEquals(calls.map((c) => c.redirect), ["manual"], "one request, redirect manual, no follow-up");
});

Deno.test("ADV-2a: a transport failure shows a reason code + 'egress' to the browser, never an address or host; the detail goes to the server log", async () => {
  const logged: string[] = [];
  const leak = (u: string) => `error sending request from 10.249.78.9:58734 for ${u} (10.249.78.2:5432): client error (SendRequest): connection closed before message completed`;
  const r = createResolver(cfg("http://vpn:8888"), {
    fetch: (u: string) => Promise.reject(new TypeError(leak(u))),
    buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient,
    log: (m: string) => logged.push(m),
  });
  const e = await assertRejects(() => r.resolve(DOI(413), kind("doi")), ResolutionFailed);
  assertEquals(e.message, "OpenAlex request failed (egress: network error); Crossref request failed (egress: network error)");
  assert(!/\d+\.\d+\.\d+\.\d+|vpn|5432|\.stub/.test(e.message), e.message);
  assert(logged.some((l) => l.includes("connection closed before message completed")), "the detail is in the server log");
  assert(logged.every(noSecret), "the server log masks the key and the mailto");
  const t = createResolver(cfg("http://vpn:8888"), {
    fetch: () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
    buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {},
  });
  await assertRejects(() => t.resolve(DOI(414), kind("doi")), ResolutionFailed, "OpenAlex request failed (egress: timeout)");
  // a proxy URL that cannot become a client: the status (served in the 422 body) does not echo it
  const broken = createResolver(cfg("http://user:pw@10.0.0.9:8888"), { buildClient: () => { throw new Error("bad proxy http://user:pw@10.0.0.9:8888"); }, log: () => {} });
  assertEquals(broken.status.state, "refused");
  assert(!/10\.0\.0\.9|user:pw/.test(JSON.stringify(broken.status)), JSON.stringify(broken.status));
});

Deno.test("ADV-3: a 200 record carrying the key, the mailto or a URL with a query is refused - not stored, not rendered", async () => {
  await withProxy("title200", async (url, log) => {
    // OpenAlex only: its echoed record is refused, so the reference fails
    const r = mk(cfg(url, { mailto: "" }), { log: () => {} });
    const e = await assertRejects(() => r.resolve(DOI(405), kind("doi")), ResolutionFailed);
    assertMatch(e.message, /OpenAlex returned a record carrying credential-shaped text \(refused\)/);
    assert(noSecret(e.message), e.message);
    // both: a refused record is "no usable record" (findings decision 4), so Crossref's clean one is used
    const both = mk(cfg(url), { log: () => {} });
    const res = await both.resolve(DOI(405), kind("doi"));
    assertEquals(res.via, "crossref");
    assert(noSecret(JSON.stringify(res.csl)) && !both.unsafe(res.csl), JSON.stringify(res.csl));
    assertEquals(compliant(log), []);
  });
  for (const title of [`x mailto=${MAILTO}`, `see https://h.example/p?q=1`, `api_key=abc`, `T ${encodeURIComponent(MAILTO)}`]) {
    const r = createResolver(cfg("http://p.invalid:1"), {
      fetch: () => Promise.resolve(Response.json({ title, type: "article" })),
      buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {},
    });
    await assertRejects(() => r.resolve(DOI(406), kind("doi")), ResolutionFailed, "credential-shaped", title);
  }
  // an author name, not only the title
  const a = createResolver(cfg("http://p.invalid:1", { mailto: "" }), {
    fetch: () => Promise.resolve(Response.json({ title: "T", type: "article", authorships: [{ author: { display_name: `Ann ${KEY}` } }] })),
    buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {},
  });
  await assertRejects(() => a.resolve(DOI(407), kind("doi")), ResolutionFailed, "credential-shaped");
});

Deno.test("ADV-2c: an identifier that fails its kind's grammar is refused by the resolver before any request", async () => {
  let calls = 0;
  const r = createResolver(cfg("http://p.invalid:1"), {
    fetch: () => (calls++, Promise.resolve(Response.json({ title: "T", type: "article" }))),
    buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {},
  });
  const forged: Identifier = { kind: "doi", accession: "10.5555/adv.inj@evil.stub", citekey: "doi:10.5555/adv.inj@evil.stub" };
  await assertRejects(() => r.resolve(forged, kind("doi")), ResolutionFailed, "malformed");
  assertEquals(calls, 0);
});
