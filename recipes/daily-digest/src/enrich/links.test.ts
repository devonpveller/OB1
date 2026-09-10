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
// A stub server IS loopback, which the production host screen refuses. Rather
// than weaken the screen so the suite passes - the classic way a security
// control becomes decorative - open the door here, and let the two cases that
// ASSERT the screen delete this first so they run against the shipping default.
// This variable must never be set in production.
Deno.env.set("RESEARCH_ALLOW_PRIVATE_TARGETS", "1");

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  gatherAnchors,
  interstitialTarget,
  isPubliclyRoutableUrl,
  isResearchable,
  unwrapRedirect,
} from "./links.ts";

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

// THE BYTE CAP ITSELF, which nothing pinned until round 15 proved it: raising
// INTERSTITIAL_MAX_BYTES from 16_384 to 999_999_999 - removing the cap outright -
// left all 96 tests green, including the one above. Its 40,000 x's are VISIBLE
// TEXT, so it trips INTERSTITIAL_MAX_TEXT first and says nothing about bytes.
// That is the same misattribution round 3 corrected once already for a
// <pre><code> fixture, and it left an ANCHOR ACCEPTANCE BULLET ("no unbounded
// body read") asserted by no test at all.
//
// The padding here is inside an HTML COMMENT, so visible text stays ~0 and the
// only thing that can refuse the document is its size. The pair is the point:
// under the cap it resolves, over the cap it does not, so the refusal is the
// SIZE and not the shape.
//
// WHAT THIS CASE DOES NOT PIN, stated because an earlier version of this comment
// claimed it did ("a fix that disables either guard fails one of them" - false,
// and round 16 measured it): it pins the REFUSAL of an over-cap document, not
// the BOUNDED READ. Make the loop `while (true)` and drop the `total > maxBytes`
// return and the whole suite stayed green at 97/0 while a 64 MiB body was
// buffered whole. The anchor bullet has two halves and this case is one of them.
// The next case is the other.
Deno.test("the BYTE cap refuses a big document whose visible text is tiny", async () => {
  const other = stubServer(() => html("<html><body>should never be reached</body></html>"));
  const padded = (bytes: number) =>
    `<html><head><meta http-equiv="refresh" content="0; url=${other.base}/nope"></head>` +
    `<body><!--${"p".repeat(bytes)}--></body></html>`;
  const over = stubServer(() => html(padded(20_000)));
  const under = stubServer(() => html(padded(1_000)));
  try {
    const overUrl = `${over.base}/click/over`;
    assertEquals(await unwrapRedirect(overUrl), overUrl, "over the byte cap: not read, not followed");
    assertEquals(other.hits(), 0);
    // The control that makes the assertion above mean something. Same shape,
    // same invisible padding, under the cap - so the refusal is the SIZE and
    // not the shape.
    assertEquals(await unwrapRedirect(`${under.base}/click/under`), `${other.base}/nope`);
  } finally {
    await over.stop();
    await under.stop();
    await other.stop();
  }
});

// THE OTHER HALF OF THE ANCHOR BULLET: "a large non-interstitial page does not
// get buffered whole". Nothing asserted that until round 16, which proved it by
// removing the read bound entirely and watching the suite stay green — the
// server then wrote all 67,108,864 bytes at every chunk size, which is precisely
// the thing the bullet forbids.
//
// This asserts on the SERVER's side of the wire, because that is where "was it
// buffered whole" is observable: how many bytes did the body actually stream
// before the reader hung up? Bounded, that is the transport's readahead.
// Unbounded, it is the entire body.
//
// THE NUMBERS. Readahead is ABSOLUTE, not proportional to the body - the same
// figures whether the body is 16 MiB or 64 MiB - so the margin is bought by
// making the BODY large rather than the threshold generous.
//
// EVERY FIGURE BELOW WAS MEASURED UNDER `deno test`, which is the only harness
// whose numbers describe this case. That sentence exists because two earlier
// versions of this table were measured with `deno run` and then used to state
// what the CASE does; the two differ by exactly 4/3, deterministically, same
// commit and same machine. It made the 512 KiB row say the opposite of the
// truth. If you re-measure, measure inside a test.
//
//   bounded, at this chunk size     2.25 MiB   7.1x below the threshold
//   threshold (BODY / 4)           16.00 MiB
//   unbounded                      64.00 MiB   4x above the threshold
//
// CHUNK is pinned deliberately rather than left to a default. Under `deno test`,
// against CORRECT code, three runs each, all deterministic:
//
//    64 KiB    2.25 MiB   shipped; passes with 7.1x of room
//   512 KiB   18.00 MiB   FAILS - already over the threshold
//     1 MiB   36.00 MiB   FAILS
//     2 MiB   64.00 MiB   the whole body: at and above this, a byte count
//                         stops discriminating at all
//
// So the usable range is narrower than two earlier versions of this comment
// claimed - it ends between 64 and 512 KiB, not at 1 MiB - and the failure at
// 512 KiB is a CORRECT implementation being called wrong. Round 19 caught that;
// round 18 caught the version before it, which had the whole-body point four
// chunk sizes too high and denied that a byte count discriminates below it.
//
// The history is left here on purpose. This margin has now been stated wrongly
// three times, in three different ways, by someone with the measurements open -
// which is the argument for keeping CHUNK where it is measured and for treating
// any change to it as requiring the whole table again.
Deno.test("a large body is NOT streamed whole - the read stops early", async () => {
  const BODY_BYTES = 64 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  const chunk = new Uint8Array(CHUNK).fill(0x78); // "x"
  let written = 0;
  const srv = Deno.serve({ port: 0, onListen: () => {} }, () => {
    const body = new ReadableStream({
      pull(controller) {
        if (written >= BODY_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        written += CHUNK;
      },
    });
    return new Response(body, { headers: { "content-type": "text/html" } });
  });
  try {
    const url = `http://127.0.0.1:${srv.addr.port}/click/huge`;
    assertEquals(await unwrapRedirect(url), url, "a 64MB body is not a redirect shell");
    assert(
      written < BODY_BYTES / 4,
      `the read must stop early: server wrote ${written} of ${BODY_BYTES} bytes`,
    );
    // The byte count is the whole assertion, deliberately. A `cancel()` callback
    // on the server's stream looked like a stronger second signal: it is false
    // at this point (10/10 runs) and true one `srv.shutdown()` later (10/10), so
    // it is DETERMINISTIC - round 17 measured that, correcting this comment,
    // which had called it a runtime detail and so implied flakiness. The reason
    // not to assert it stands and is simpler than the one first given: it would
    // pin Deno's stream teardown ORDERING, not anything links.ts does.
  } finally {
    await srv.shutdown();
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

// ── 9. REGRESSIONS FROM THE FIRST TEST ROUND (2026-09-09) ────────────────────
// Every case below was found by a TESTER, not by the author, and each one failed
// on the first version of this change.

Deno.test("a bare HTML attribute is NOT a scripted redirect", () => {
  // `data-location = "..."` matched: \b sits happily after the hyphen, and the
  // pattern ran over raw HTML with no script-context awareness at all.
  const doc = `<html><head></head><body><div data-location = "https://evil.example/steal"></div></body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

Deno.test("an unrelated .location property assignment is NOT a redirect", () => {
  const doc = `<html><head><script>window.analytics.location = "https://evil.example/steal";</script></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

Deno.test("a location.replace OUTSIDE any script element is ignored", () => {
  const doc = `<html><head></head><body>location.replace("https://evil.example/steal")</body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

Deno.test("a real window.location redirect inside a script IS still followed", () => {
  const doc = `<html><head><script>window.location.replace("https://good.example/post")</script></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/post");
});

// ── 10. THE SECOND TEST ROUND (2026-09-09) ───────────────────────────────────
// A tester put the F3 regression back into link-enrich.ts's real filter and the
// whole suite stayed green: the guard asserted a hand-typed COPY of the
// expression, and link-enrich.ts is a top-level script no test can import. The
// rule now lives in isResearchable() and these assert THAT.

Deno.test("isResearchable: a marked wrapper is still researched", () => {
  const marked = {
    rawUrl: "https://one-click.example/post",
    url: "https://one-click.example/post",
    domain: "one-click.example",
    unresolvedWrapper: true,
  };
  assertEquals(isResearchable(marked), true, "the mark must not decide research");
});

Deno.test("isResearchable: a newsletter self-link is still dropped", () => {
  assertEquals(
    isResearchable({ rawUrl: "x", url: "https://nate.substack.com/p/a", domain: "nate.substack.com" }),
    false,
  );
  assertEquals(isResearchable({ rawUrl: "x", url: "https://blog.google/a", domain: "blog.google" }), true);
  assertEquals(isResearchable({ rawUrl: "x", url: "not a url", domain: "" }), false);
});

// Every inert context a tester drove the resolver from. All seven followed
// before this round; metaRefreshTarget had never been narrowed at all, and it
// runs FIRST.
// ── 15. ROUND 6 (2026-09-10) ─────────────────────────────────────────────────
// The two depth counters that skipped <template> and the inert subtrees were
// raw-string regex token counts, so they counted `</template>` / `</select>`
// occurring inside COMMENTS, ATTRIBUTE VALUES, SCRIPT BODIES and <textarea> -
// the exact contexts the surrounding scanner exists to respect. Ten inert
// documents produced a target on the REAL path, with unresolvedWrapper=false, so
// the URL entered research silently and the operator log line never fired.
// Fixing the nesting in round 3 had reintroduced the context blindness; the walk
// now owns the depth, so there is only one mechanism deciding what is inside
// what.
const R6_EVIL = "https://evil.example/pwn";
const contextBlind: Array<[string, string]> = [
  ["</template> inside a comment", `<html><body><template><!-- </template> --><script>location.replace("${R6_EVIL}")</script></template></body></html>`],
  ["</template> inside an attribute value", `<html><body><template><div title="</template>"></div><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></template></body></html>`],
  ["</template> inside a script body", `<html><body><template><script>var x="</template>";</script><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></template></body></html>`],
  ["</template> inside a textarea", `<html><body><template><textarea></template></textarea><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></template></body></html>`],
  ["</select> inside a comment", `<html><body><select><!-- </select> --><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></select></body></html>`],
  ["</svg> inside an attribute value", `<html><body><svg><g title="</svg>"></g><script>location.replace("${R6_EVIL}")</script></svg></body></html>`],
  ["</math> inside a script body", `<html><body><math><script>var y="</math>";</script><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></math></body></html>`],
  ["a nested template closed inside a comment", `<html><body><template><template><!-- </template> --></template><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></template></body></html>`],
  ["an unterminated template", `<html><body><template><meta http-equiv="refresh" content="0;url=${R6_EVIL}"></body></html>`],
  ["an unterminated select", `<html><body><select><script>location.replace("${R6_EVIL}")</script></body></html>`],
];
for (const [label, doc] of contextBlind) {
  Deno.test(`a closing tag in an inert context does not end the region: ${label}`, () => {
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null, label);
  });
}

Deno.test("template text is NOT rendered, so a shell containing one still resolves", () => {
  // The counterpart to the erasure cases: over-swallowing hides prose from the
  // guard, but under-swallowing would make a <template> count as visible text
  // and stop a genuine shell resolving. Both directions, or neither is pinned.
  const prose = "Boilerplate inside a template that a browser never renders. ".repeat(8);
  const doc = `<html><head><template>${prose}</template><meta http-equiv="refresh" content="0;url=https://good.example/p"></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/p");
});

Deno.test("a self-closing <svg/> opens no suppressed region", () => {
  const doc = `<html><head><svg/><meta http-equiv="refresh" content="0;url=https://good.example/p"></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/p");
});

Deno.test("...but <math/> is the only OTHER element that gets that exemption", () => {
  const doc = `<html><head><math/><meta http-equiv="refresh" content="0;url=https://good.example/p"></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/p");
});

// ── 16. ROUND 7 (2026-09-10) ─────────────────────────────────────────────────
// The self-closing exemption above was applied to `template` and `select` too -
// and they are HTML elements, where the parser IGNORES a trailing solidus. So
// `<select/>` DOES open a region, and treating it as self-closed meant inert
// content after one was read as LIVE and followed on the real path, unmarked.
// A regression introduced by the previous round's fix; found by checking against
// parse5 in both scripting modes rather than against a reading of the spec.
for (const el of ["select", "template"]) {
  Deno.test(`a trailing solidus on <${el}/> does NOT self-close it (meta)`, () => {
    const doc = `<html><body><${el}/><meta http-equiv="refresh" content="0;url=https://evil.example/pwn"></body></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
  });
  Deno.test(`a trailing solidus on <${el}/> does NOT self-close it (script)`, () => {
    const doc = `<html><body><${el}/><script>location.replace("https://evil.example/pwn")</script></body></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
  });
}

for (const el of ["svg", "math"]) {
  Deno.test(`a NON self-closed <${el}> still suppresses its subtree`, () => {
    const doc = `<html><body><${el}><script>location.replace("https://evil.example/pwn")</script></${el}></body></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
  });
}

// ── 14. ROUND 5 (2026-09-10) ─────────────────────────────────────────────────

Deno.test("a docker <service>.<network> name is refused", () => {
  // "Has a dot" was not enough. Docker's embedded DNS answers
  // `<service>.<network>` too, and a tester reached the exact container another
  // case asserts is refused - live 200 - by that spelling. Those network names
  // are this stack's own and are written down in CLAUDE.md.
  for (const u of [
    "http://openbrain-curator.open-brain_obnet:8000/health",
    "http://llama-cpp.ai-stack_llm-net:8080/health",
    "http://surrealdb.ai-stack_app-net:8000/sql",
    "http://openbrain-db.open-brain_obnet:5432/",
  ]) {
    assertEquals(isPubliclyRoutableUrl(u), false, `must be refused: ${u}`);
  }
});

Deno.test("...and real public hosts still pass the TLD shape rule", () => {
  // Non-vacuity: the rule above must not simply refuse everything with a hyphen.
  for (const u of [
    "https://blog.google/article",
    "https://aiandeducation.mit.edu/report/",
    "https://sub.domain.co.uk/a",
    "https://example.com./trailing-dot",
    "https://8.8.8.8/",
  ]) {
    assertEquals(isPubliclyRoutableUrl(u), true, `must be allowed: ${u}`);
  }
});

// FOUR WAYS TO ERASE THE SHELL GUARD, all found in round 5, all of which made a
// full ARTICLE resolve. The claim in the previous commit that guard and matcher
// were "incapable of disagreeing" was not yet true: TERMINAL_ELEMENTS returned
// before liveText was assigned, and the inert subtrees skipped text a browser
// renders. Text now counts wherever a browser would show it.
const r5Prose = "Real readable article prose that makes this a document. ".repeat(8);
const r5Meta = `<meta http-equiv="refresh" content="0;url=https://evil.example/pwn">`;
const guardErasures: Array<[string, string]> = [
  ["<plaintext> appended after an article", `<html><body>${r5Prose}${r5Meta}<plaintext>${r5Prose}</body></html>`],
  ["prose inside <select>", `<html><body><select>${r5Prose}</select>${r5Meta}</body></html>`],
  ["prose inside <svg><text>", `<html><body><svg><text>${r5Prose}</text></svg>${r5Meta}</body></html>`],
  ["prose inside <math><mtext>", `<html><body><math><mtext>${r5Prose}</mtext></math>${r5Meta}</body></html>`],
  ["prose inside an <iframe> fallback", `<html><body><iframe>${r5Prose}</iframe>${r5Meta}</body></html>`],
  ["prose inside <textarea>", `<html><body><textarea>${r5Prose}</textarea>${r5Meta}</body></html>`],
];
for (const [label, doc] of guardErasures) {
  Deno.test(`visible prose still counts against the guard: ${label}`, () => {
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null, label);
  });
}

// ── 13. ROUND 4 (2026-09-09) ─────────────────────────────────────────────────
// Round 4 closed the twelve, then found four more scanner bypasses, a
// one-character defeat of the host screen, and the guard/matcher disagreement
// still open for six elements.

const R4_EVIL = "https://evil.example/pwn";
const r4Bypasses: Array<[string, string]> = [
  // <plaintext> is TERMINAL - nothing after it is ever markup. The regex version
  // handled it; the scanner that replaced it dropped it. A regression, not a gap.
  ["<plaintext> then a script", `<html><body><plaintext><script>location.replace("${R4_EVIL}")</script></body></html>`],
  ["<plaintext> then a meta", `<html><body><plaintext><meta http-equiv="refresh" content="0;url=${R4_EVIL}"></body></html>`],
  // A BOGUS COMMENT runs to the next `>` - which is the meta's OWN `>`, so
  // skipping one character walked straight into it.
  ["a bogus comment <?foo swallowing a meta", `<html><body><?foo <meta http-equiv="refresh" content="0;url=${R4_EVIL}"> ?></body></html>`],
  ["a bogus comment </3 swallowing a meta", `<html><body></3 <meta http-equiv="refresh" content="0;url=${R4_EVIL}"> ></body></html>`],
  ["<math><script> (not on the foreign-content breakout list)", `<html><body><math><script>location.replace("${R4_EVIL}")</script></math></body></html>`],
  ["<meta> inside <select>", `<html><body><select><meta http-equiv="refresh" content="0;url=${R4_EVIL}"></select></body></html>`],
  ["<svg><script>", `<html><body><svg><script>location.replace("${R4_EVIL}")</script></svg></body></html>`],
];
for (const [label, doc] of r4Bypasses) {
  Deno.test(`round 4 bypass stays shut: ${label}`, () => {
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null, label);
  });
}

// THE GUARD AND THE MATCHER MUST MEASURE THE SAME DOCUMENT. extractTextFromHtml
// erases <nav>/<header>/<footer>/<aside>/<form>/<svg> before counting, so a
// document whose only text lived in one of them read as "no visible text" to the
// guard while the matcher saw a live redirect - the same disagreement the
// scanner closed for comments, still open for six elements. liveText now comes
// from the same walk that decides what is live, so they cannot disagree.
for (const el of ["nav", "header", "footer", "aside", "form"]) {
  Deno.test(`text inside <${el}> counts against the shell guard`, () => {
    const prose = "Real readable prose that makes this a document, not a shell. ".repeat(6);
    const doc = `<html><body><${el}>${prose}<meta http-equiv="refresh" content="0;url=${R4_EVIL}"></${el}></body></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
  });
}

Deno.test("the same shape with NO text still resolves", () => {
  // Non-vacuity for the five cases above: they must fail on the TEXT, not
  // because a <nav>-wrapped meta is refused outright. A meta there IS live.
  const doc = `<html><body><nav><meta http-equiv="refresh" content="0;url=https://good.example/p"></nav></body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/p");
});

Deno.test("a trailing dot does not defeat the host screen", () => {
  // ONE CHARACTER defeated every check: the root label satisfies
  // `host.includes(".")` and breaks the exact/suffix tests. `http://localhost.:PORT/`
  // was not merely allowed - a tester CONNECTED to a live loopback listener.
  for (const u of ["http://openbrain-curator.:8000/ingest", "http://localhost.:8080/", "http://localhost../", "http://127.0.0.1./"]) {
    assertEquals(isPubliclyRoutableUrl(u), false, `must be refused: ${u}`);
  }
  // A trailing dot on a PUBLIC name is still fine - the fix normalises, it does
  // not blanket-refuse.
  assertEquals(isPubliclyRoutableUrl("https://example.com./x"), true);
});

Deno.test("IPv4-mapped IPv6 is screened in BOTH spellings", () => {
  // The WHATWG parser normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a
  // dotted-form check alone never fires on a real URL - a first fix did exactly
  // that and still leaked.
  for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:192.168.1.1]/", "http://[::ffff:7f00:1]/"]) {
    assertEquals(isPubliclyRoutableUrl(u), false, `must be refused: ${u}`);
  }
  assertEquals(isPubliclyRoutableUrl("http://[::ffff:8.8.8.8]/"), true, "a mapped PUBLIC v4 is still allowed");
  assertEquals(isPubliclyRoutableUrl("https://[2606:4700::1111]/"), true, "an ordinary public v6 is allowed");
});

// ── 11. THE TWELVE BYPASSES (2026-09-09, third round) ────────────────────────
// A tester drove the resolver from twelve contexts a browser would never
// navigate the top document from. The regex that stripped inert regions was
// closing-tag-anchored and non-greedy, so every UNTERMINATED region and every
// NESTED template survived it, and it had never heard of <style>, <title>,
// <noscript> or attribute values. Five of the twelve drove the REAL path:
// unwrapRedirect followed them and gatherAnchors emitted the attacker's URL as a
// normal candidate with unresolvedWrapper=false.
//
// The fix is a scanner that fails closed, not twelve more patterns - so these
// cases exist to keep the CLASS shut, and the block after them exists to prove
// failing closed did not close the door on real interstitials.
// ── 12. WHERE A RESOLVED TARGET MAY POINT, AND THE FALLBACK LEVER ────────────
// The redirect target is the one value here chosen by the page we just fetched,
// and we then FETCH it. No JavaScript is ever executed - a string is lifted out
// of a script body and never evaluated - but where that string points is a real
// question, so it is screened.
Deno.test("a resolved target may not point at internal infrastructure", () => {
  const denied = [
    "http://openbrain-curator:8000/ingest",   // a docker service name: no dot
    "http://llama-cpp:8080/v1/chat",
    "http://surrealdb:8000/sql",
    "http://localhost:8080/",
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/",
    "http://172.16.0.5/",
    "http://192.168.1.10/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://100.64.1.2/",                       // CGNAT range - the tailnet
    "http://[::1]/",
    "http://host.docker.internal:8000/",
    "http://something.local/",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ];
  for (const u of denied) {
    assertEquals(isPubliclyRoutableUrl(u), false, `must be refused: ${u}`);
  }
  const allowed = [
    "https://blog.google/article",
    "https://aiandeducation.mit.edu/report/",
    "http://example.com/x?y=1",
    "https://8.8.8.8/",
  ];
  for (const u of allowed) {
    assertEquals(isPubliclyRoutableUrl(u), true, `must be allowed: ${u}`);
  }
});

Deno.test("an interstitial pointing at internal infrastructure is not followed", () => {
  // Run against the SHIPPING default, not the suite's loopback hatch.
  Deno.env.delete("RESEARCH_ALLOW_PRIVATE_TARGETS");
  try {
    const doc = `<html><head><meta http-equiv="refresh" content="0;url=http://openbrain-curator:8000/ingest"></head></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
    const doc2 = `<html><head><script>location.replace("http://169.254.169.254/latest/meta-data/")</script></head></html>`;
    assertEquals(interstitialTarget(doc2, "https://wrapper.example/r/1"), null);
    // ...and a PUBLIC target from the same shapes still resolves, so the case
    // is not passing because everything returns null.
    const ok = `<html><head><meta http-equiv="refresh" content="0;url=https://blog.google/a"></head></html>`;
    assertEquals(interstitialTarget(ok, "https://wrapper.example/r/1"), "https://blog.google/a");
  } finally {
    Deno.env.set("RESEARCH_ALLOW_PRIVATE_TARGETS", "1");
  }
});

Deno.test("a Location header pointing at internal infrastructure is not followed either", async () => {
  // The 3xx path is OLDER than the interstitial one and had the same unscreened
  // power all along.
  Deno.env.delete("RESEARCH_ALLOW_PRIVATE_TARGETS");
  const wrapper = stubServer(() =>
    new Response(null, { status: 302, headers: { location: "http://openbrain-db:5432/" } })
  );
  try {
    const url = `${wrapper.base}/click/evil`;
    assertEquals(await unwrapRedirect(url), url, "the hop is refused; we return the wrapper");
  } finally {
    Deno.env.set("RESEARCH_ALLOW_PRIVATE_TARGETS", "1");
    await wrapper.stop();
  }
});

Deno.test("INTERSTITIAL_FOLLOW=0 restores the pre-fix behaviour", async () => {
  const dest = stubServer(() => html("<html><body>the article</body></html>"));
  const wrapper = stubServer(() => html(substackInterstitial(`${dest.base}/p/x`)));
  const prev = Deno.env.get("INTERSTITIAL_FOLLOW");
  try {
    Deno.env.set("INTERSTITIAL_FOLLOW", "0");
    const url = `${wrapper.base}/redirect/abc?j=e`;
    assertEquals(await unwrapRedirect(url), url, "with the lever pulled, the wrapper is NOT followed");
    Deno.env.set("INTERSTITIAL_FOLLOW", "1");
    assertEquals(await unwrapRedirect(url), `${dest.base}/p/x`, "and with it restored, it is");
  } finally {
    if (prev === undefined) Deno.env.delete("INTERSTITIAL_FOLLOW");
    else Deno.env.set("INTERSTITIAL_FOLLOW", prev);
    await wrapper.stop();
    await dest.stop();
  }
});

Deno.test("the lever OFF still leaves the wrapper researchable", () => {
  // The fallback must degrade to the OLD behaviour, not to a hole: an
  // unresolved wrapper is marked, logged, and still passed to research.
  assertEquals(
    isResearchable({ rawUrl: "x", url: "https://tracker.example/ss/c/abc", domain: "tracker.example", unresolvedWrapper: true }),
    true,
  );
});

const EVIL = "https://evil.example/steal";
const bypassCases: Array<[string, string]> = [
  ["a <script> inside <noscript>", `<html><head><noscript><script>location.replace("${EVIL}")</script></noscript></head></html>`],
  ["an iframe srcdoc carrying a script", `<html><head><iframe srcdoc="&lt;script&gt;location.replace('${EVIL}')&lt;/script&gt;"></iframe></head></html>`],
  ["an iframe srcdoc carrying a meta", `<html><head><iframe srcdoc="<meta http-equiv='refresh' content='0;url=${EVIL}'>"></iframe></head></html>`],
  ["a NESTED template (script)", `<html><body><template><template><script>location.replace("${EVIL}")</script></template></template></body></html>`],
  ["a NESTED template (meta)", `<html><body><template><template><meta http-equiv="refresh" content="0;url=${EVIL}"></template></template></body></html>`],
  ["an UNCLOSED comment (script)", `<html><body><!-- <script>location.replace("${EVIL}")</script></body></html>`],
  ["an UNCLOSED comment (meta)", `<html><body><!-- <meta http-equiv="refresh" content="0;url=${EVIL}"></body></html>`],
  ["an UNCLOSED textarea", `<html><body><textarea><script>location.replace("${EVIL}")</script></body></html>`],
  ["an UNCLOSED template", `<html><body><template><meta http-equiv="refresh" content="0;url=${EVIL}"></body></html>`],
  ["a <script> inside <title>", `<html><head><title><script>location.replace("${EVIL}")</script></title></head></html>`],
  ["a <meta refresh> inside <style>", `<html><head><style><meta http-equiv="refresh" content="0;url=${EVIL}"></style></head></html>`],
  ["a <script> inside an ATTRIBUTE VALUE", `<html><body><div title="--><script>location.replace('${EVIL}')</script>"></div></body></html>`],
];
for (const [label, doc] of bypassCases) {
  Deno.test(`a browser would not navigate from this: ${label}`, () => {
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null, label);
  });
}

// Failing closed must not close the door on the real thing. Every shape here
// resolved before the scanner and must still resolve after it - the Substack
// <noscript> meta above all, since that is the document this item exists for.
const mustStillResolve: Array<[string, string]> = [
  ["the real substack <noscript> meta", `<head><noscript><META http-equiv="refresh" content="0;URL=https://good.example/post"></noscript><title>t</title></head><script>window.opener = null; location.replace("https://good.example/post")</script>`],
  ["a plain head meta", `<html><head><meta http-equiv="refresh" content="0;url=https://good.example/post"></head></html>`],
  ["type=module", `<html><head><script type="module">location.replace("https://good.example/post")</script></head></html>`],
  ["type=MODULE, upper case", `<html><head><script type="MODULE">location.replace("https://good.example/post")</script></head></html>`],
];
for (const [label, doc] of mustStillResolve) {
  Deno.test(`failing closed did not break: ${label}`, () => {
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/post", label);
  });
}

const inertCases: Array<[string, string]> = [
  ["an HTML comment (meta)", `<!-- <meta http-equiv="refresh" content="0;url=https://evil.example/x"> -->`],
  ["an HTML comment (script)", `<!-- <script>location.replace("https://evil.example/x")</script> -->`],
  ["a <template> (meta)", `<template><meta http-equiv="refresh" content="0;url=https://evil.example/x"></template>`],
  ["a <template> (script)", `<template><script>location.replace("https://evil.example/x")</script></template>`],
  ["a <textarea> (meta)", `<textarea><meta http-equiv="refresh" content="0;url=https://evil.example/x"></textarea>`],
  ["a <textarea> (script)", `<textarea><script>location.replace("https://evil.example/x")</script></textarea>`],
  ["a non-executing script type", `<script type="text/template">location.replace("https://evil.example/x")</script>`],
  ["a text/plain script", `<script type="text/plain">location.replace("https://evil.example/x")</script>`],
];
for (const [label, body] of inertCases) {
  Deno.test(`an inert context is not a redirect: ${label}`, () => {
    const doc = `<html><head></head><body>${body}</body></html>`;
    assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null, label);
  });
}

// ...and the shapes a MINIFIED interstitial actually uses, which the first
// narrowing broke: the old prefix class allowed only [;{}\s(], so a target after
// `)` or `>` stopped resolving. Attempt 1 followed both of these.
Deno.test("a redirect after an arrow function IS followed", () => {
  const doc = `<html><head><script>setTimeout(()=>location.replace("https://good.example/a"),0)</script></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/a");
});

Deno.test("a redirect after a bare if() IS followed", () => {
  const doc = `<html><head><script>if(!a)location.href="https://good.example/b"</script></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/b");
});

Deno.test("a script tag whose attribute contains > is parsed whole", () => {
  const doc = `<html><head><script data-x="a>b">location.replace("https://good.example/c")</script></head></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), "https://good.example/c");
});

Deno.test("a mostly-commented document does not look like a shell to one guard and a redirect to the other", () => {
  // The sharp case: extractTextFromHtml STRIPS comments before counting visible
  // text, so a document that is almost entirely a comment reads as shell-like.
  // The matcher must not then read inside that comment.
  const doc = `<html><head></head><body><!-- ${"filler ".repeat(200)}` +
    `<meta http-equiv="refresh" content="0;url=https://evil.example/x"> --></body></html>`;
  assertEquals(interstitialTarget(doc, "https://wrapper.example/r/1"), null);
});

Deno.test("an UNRESOLVED wrapper is marked but NOT dropped from research", async () => {
  // THE regression: marking it was right, filtering it out LOST links the
  // pre-fix code researched. isRedirectWrapper matches bare substrings against
  // the whole URL, so a genuine article whose path merely contains a tracker
  // shape goes down the unwrap branch and does not move.
  const article = stubServer(() =>
    html("<html><body>" + "A real article with real prose. ".repeat(40) + "</body></html>")
  );
  try {
    const out = await gatherAnchors([{ url: `${article.base}/ss/c/real-article`, text: "A real article" }]);
    const c = out[0];
    assert(c, "the candidate must survive gatherAnchors");
    assertEquals(c.unresolvedWrapper, true, "it is marked, because the unwrap did not move it");
    // link-enrich.ts's filter, verbatim: the mark must NOT be part of it.
    const kept = [c].filter((x) => x.domain && !x.domain.endsWith("substack.com"));
    assertEquals(kept.length, 1, "a marked candidate is still researched");
  } finally {
    await article.stop();
  }
});
