// Regression tests for redirect resolution (2026-09-09).
//
// WHY THESE EXIST: around 2026-09-06 Substack replaced the 302 on its
// /redirect/<uuid> endpoint with a 200 carrying a tiny HTML shell that bounces
// the browser on via <noscript> meta-refresh + location.replace. unwrapRedirect
// only followed a `Location` header, so every wrapper "resolved" to substack.com
// and link-enrich's newsletter-self-link filter then dropped it. The daily
// digest researched ZERO external articles for three days and every log line
// stayed green: `0 ext link(s), 0 selected + body-fallback` on every email.
//
// The properties that keep it from recurring:
//   1. a redirect shell is followed like any other hop, for ANY host;
//   2. a real article is never mistaken for one, whatever its scripts contain;
//   3. hop accounting still terminates;
//   4. a wrapper that could NOT be resolved is distinguishable from a genuine
//      self-link instead of vanishing through the same filter.
//
// Run: deno test --allow-net --allow-env src/enrich/links.test.ts

// Opt OUT of the Tor/VPN egress before links.ts lazily builds its client: these
// tests talk to a loopback stub, and the default proxy would fail closed.
Deno.env.set("FETCH_PROXY_URL", "");

import { assert, assertEquals } from "jsr:@std/assert@1";
import { gatherAnchors, interstitialTarget, unwrapRedirect } from "./links.ts";

type Handler = (req: Request, hit: number) => Response | Promise<Response>;

/** Stub origin. Returns the base url, a hit counter, the paths seen and a stopper. */
function stubServer(handler: Handler) {
  let hits = 0;
  const paths: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      hits++;
      paths.push(new URL(req.url).pathname + new URL(req.url).search);
      return handler(req, hits);
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    base: `http://127.0.0.1:${port}`,
    paths,
    hits: () => hits,
    async stop() {
      ac.abort();
      await server.finished.catch(() => {});
    },
  };
}

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

/** The real Substack interstitial shape, captured live 2026-09-09 from
 *  https://substack.com/redirect/40874a4f-3ed1-44f8-82bd-1ea1c10c30b4?j=e —
 *  entity-encoded &#38; in the meta target, bare & in the script target, and a
 *  Cloudflare beacon stanza trailing it. Not simplified: the encoding quirks
 *  are exactly what a hand-written fixture would have smoothed away. */
function substackInterstitial(dest: string): string {
  const entityDest = dest.replace(/&/g, "&#38;");
  return `<head><noscript><META http-equiv="refresh" content="0;URL=${entityDest}"></noscript>` +
    `<title>${entityDest}</title></head>` +
    `<script>window.opener = null; location.replace("${dest}")</script>` +
    `<script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);` +
    `if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'a384cc55aa94fb1a',` +
    `t:'MTc4ODk0MjI4Mw=='};";b.getElementsByTagName('head')[0].appendChild(d)}}})();</script>`;
}

// ── 1. THE REGRESSION: a 200 interstitial is a redirect ──────────────────────
// Fails on the pre-2026-09-09 code, which returned the wrapper URL itself.
Deno.test("unwrapRedirect follows a 200 meta-refresh/location.replace shell", async () => {
  const dest = stubServer(() => html("<html><body>" + "the article. ".repeat(200) + "</body></html>"));
  const wrapper = stubServer(() => html(substackInterstitial(`${dest.base}/p/the-post?utm_source=substack&utm_medium=email`)));
  try {
    const out = await unwrapRedirect(`${wrapper.base}/redirect/40874a4f-3ed1?j=e`);
    assertEquals(out, `${dest.base}/p/the-post?utm_source=substack&utm_medium=email`);
  } finally {
    await wrapper.stop();
    await dest.stop();
  }
});

// ── 2. GENERAL, not substack-specific ────────────────────────────────────────
// A fix that special-cases substack.com passes test 1 and fails this one.
Deno.test("interstitial resolution is host-agnostic", async () => {
  const dest = stubServer(() => html("<html><body>elsewhere</body></html>"));
  const wrapper = stubServer(() =>
    html(`<html><head><meta http-equiv="refresh" content="0; url=${dest.base}/story"></head><body></body></html>`)
  );
  try {
    // Nothing in this URL or body mentions substack.
    const out = await unwrapRedirect(`${wrapper.base}/click/abc123`);
    assertEquals(out, `${dest.base}/story`);
  } finally {
    await wrapper.stop();
    await dest.stop();
  }
});

Deno.test("a scripted location.href shell in a bare document also resolves", async () => {
  const dest = stubServer(() => html("<html><body>arrived</body></html>"));
  const wrapper = stubServer(() => html(`<html><head><script>window.location.href = "${dest.base}/x"</script></head></html>`));
  try {
    assertEquals(await unwrapRedirect(`${wrapper.base}/trk/1`), `${dest.base}/x`);
  } finally {
    await wrapper.stop();
    await dest.stop();
  }
});

// ── 3. A REAL ARTICLE IS NOT A REDIRECT ──────────────────────────────────────
Deno.test("an article containing location.replace is NOT followed", async () => {
  const other = stubServer(() => html("<html><body>should never be reached</body></html>"));
  const article = stubServer(() =>
    html(
      `<html><head><title>How redirects work</title></head><body>` +
        `<h1>How redirects work</h1>` +
        `<p>${"A long article about client-side navigation. ".repeat(40)}</p>` +
        `<pre><code>location.replace("${other.base}/gotcha")</code></pre>` +
        `<p>${"More prose so this is unmistakably a document with content. ".repeat(40)}</p>` +
        `</body></html>`,
    )
  );
  try {
    const url = `${article.base}/links.example/post`;
    assertEquals(await unwrapRedirect(url), url);
    assertEquals(other.hits(), 0, "the article's code sample must not be followed");
  } finally {
    await article.stop();
    await other.stop();
  }
});

Deno.test("a TIMED meta refresh is a page to read, not a redirect", () => {
  const doc = `<html><head><meta http-equiv="refresh" content="5; url=https://example.com/next"></head><body></body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

// ── 4. BOUNDED READ ──────────────────────────────────────────────────────────
Deno.test("a large page with a head meta-refresh is not treated as a shell", async () => {
  const other = stubServer(() => html("<html><body>should never be reached</body></html>"));
  const big = stubServer(() =>
    html(
      `<html><head><meta http-equiv="refresh" content="0; url=${other.base}/nope"></head><body>` +
        "x".repeat(40_000) + `</body></html>`,
    )
  );
  try {
    const url = `${big.base}/click/big`;
    assertEquals(await unwrapRedirect(url), url, "too big to be a redirect shell");
    assertEquals(other.hits(), 0);
  } finally {
    await big.stop();
    await other.stop();
  }
});

Deno.test("a non-HTML body is never parsed as a shell", async () => {
  const srv = stubServer(() =>
    new Response("%PDF-1.4 location.replace(\"https://example.com/x\")", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })
  );
  try {
    const url = `${srv.base}/click/doc`;
    assertEquals(await unwrapRedirect(url), url);
  } finally {
    await srv.stop();
  }
});

// ── 5. HOP ACCOUNTING TERMINATES ─────────────────────────────────────────────
Deno.test("a chain of interstitials stops at maxHops", async () => {
  // Every hop points at the next one; the chain never ends.
  const srv = stubServer((req) => {
    const n = Number(new URL(req.url).searchParams.get("n") ?? "0");
    return html(`<html><head><meta http-equiv="refresh" content="0; url=/click?n=${n + 1}"></head></html>`);
  });
  try {
    const out = await unwrapRedirect(`${srv.base}/click?n=0`, { maxHops: 3 });
    assertEquals(srv.hits(), 3, "must not exceed the hop cap");
    assertEquals(out, `${srv.base}/click?n=3`, "returns the furthest point reached");
  } finally {
    await srv.stop();
  }
});

Deno.test("a shell that refreshes to ITSELF terminates immediately", async () => {
  let self = "";
  const srv = stubServer(() => html(`<html><head><meta http-equiv="refresh" content="0; url=${self}"></head></html>`));
  self = `${srv.base}/click/loop`;
  try {
    assertEquals(await unwrapRedirect(self, { maxHops: 5 }), self);
    assertEquals(srv.hits(), 1, "a self-refresh is not a hop");
  } finally {
    await srv.stop();
  }
});

// ── 6. A 3xx STILL WORKS (guard against breaking the path that was fine) ─────
Deno.test("a plain 302 chain still resolves", async () => {
  const dest = stubServer(() => html("<html><body>done</body></html>"));
  const wrapper = stubServer((_req, hit) =>
    hit === 1
      ? new Response(null, { status: 302, headers: { location: "/second" } })
      : new Response(null, { status: 301, headers: { location: `${dest.base}/final` } })
  );
  try {
    assertEquals(await unwrapRedirect(`${wrapper.base}/click/first`), `${dest.base}/final`);
  } finally {
    await wrapper.stop();
    await dest.stop();
  }
});

// ── 7. UNRESOLVED WRAPPER IS DISTINGUISHABLE FROM A SELF-LINK ────────────────
Deno.test("an unresolvable wrapper is MARKED, a resolved one is not", async () => {
  const dest = stubServer(() => html("<html><body>real destination</body></html>"));
  // `/ss/c/` is a real tracker-wrapper shape (sparkpost/hubspot) and one that
  // isRedirectWrapper recognises, so gatherAnchors actually attempts an unwrap.
  // Deliberately NOT a substack URL: the marking must not be substack-specific.
  // /ss/c/good answers with a shell; /ss/c/bad answers with a content-bearing
  // page, so the unwrap cannot move it - the shape a hardened tracker presents.
  const wrapper = stubServer((req) =>
    new URL(req.url).pathname.startsWith("/ss/c/good")
      ? html(substackInterstitial(`${dest.base}/p/real`))
      : html("<html><body>" + "not a shell, just a page with words. ".repeat(30) + "</body></html>")
  );
  try {
    const out = await gatherAnchors([
      { url: `${wrapper.base}/ss/c/good?j=e`, text: "The good one" },
      { url: `${wrapper.base}/ss/c/bad?j=e`, text: "The opaque one" },
    ]);
    const good = out.find((c) => c.text === "The good one");
    const bad = out.find((c) => c.text === "The opaque one");
    assert(good, "resolved candidate should survive");
    assert(bad, "unresolved candidate should survive as a marked candidate");
    assertEquals(good!.url, `${dest.base}/p/real`);
    assertEquals(good!.unresolvedWrapper, undefined, "a resolved wrapper is not marked");
    assertEquals(bad!.unresolvedWrapper, true, "an unmoved wrapper IS marked");
    assertEquals(bad!.url, `${wrapper.base}/ss/c/bad?j=e`);
  } finally {
    await wrapper.stop();
    await dest.stop();
  }
});

// ── 8. PARSING EDGES (pure, no network) ──────────────────────────────────────
Deno.test("interstitialTarget decodes entities and resolves relative targets", () => {
  const doc = `<head><noscript><META http-equiv="refresh" content="0;URL=/p/x?a=1&#38;b=2"></noscript></head>`;
  assertEquals(
    interstitialTarget(doc, "https://wrapper.example/redirect/1"),
    "https://wrapper.example/p/x?a=1&b=2",
  );
});

Deno.test("interstitialTarget refuses a non-http scheme", () => {
  const doc = `<head><meta http-equiv="refresh" content="0;url=javascript:alert(1)"></head>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

Deno.test("interstitialTarget ignores a document with visible content", () => {
  const doc = `<html><head><meta http-equiv="refresh" content="0;url=https://example.com/x"></head>` +
    `<body>${"Real readable prose that makes this a document. ".repeat(20)}</body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});
