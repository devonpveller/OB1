// node --test lib/  - image-build gate for the live renderer's markdown
// pipeline (research-workbench P1a: the Quartz transform set, ported).
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, renderMarkdown, ofmTextTransform } from "./render-page.mjs";
import { basenameIndex } from "./quartz-path.mjs";

const ctx = (slug = "content/person/person-x", slugs = []) => ({ slug, byBase: basenameIndex(slugs) });

test("GFM: headings, lists, tables (wrapped like a built page), code, task lists", async () => {
  const html = await renderMarkdown("# H1\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n`code`\n\n- [x] done\n", ctx());
  assert.ok(html.includes('<h1 id="h1">H1'), html);
  assert.ok(html.includes("<li>a</li>"));
  assert.ok(html.includes('<div class="table-container"><table>'), "Quartz's htmlToJsx wraps tables");
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes('<input type="checkbox" checked disabled/>'), html);
});

test("wikilinks resolve with Quartz's 'shortest' strategy: relative href, data-slug, alias class", async () => {
  const slugs = ["content/person/person-ada", "content/tool/tool-x"];
  const html = await renderMarkdown("see [[content/person/person-ada|Ada]] and [[tool-x#Usage]]", ctx("content/person/person-x", slugs));
  assert.ok(html.includes('<a href="../../content/person/person-ada" class="internal alias" data-slug="content/person/person-ada">Ada</a>'), html);
  assert.ok(html.includes('href="../../content/tool/tool-x#usage"'), html);
});

test("a bare % in a wikilink target never reaches an href un-encoded", async () => {
  const html = await renderMarkdown("bad [[content/tool/50% off]]", ctx());
  assert.ok(!/href="[^"]*%(?![0-9A-Fa-f]{2})/.test(html), html);
});

test("SECURITY: raw HTML from source content is dropped, not executed", async () => {
  const html = await renderMarkdown('before <script>alert(1)</script> <img src=x onerror="x()"> <div onclick="y()">z</div> after\n\n<iframe src="https://e.invalid/t"></iframe>\n', ctx());
  assert.ok(!html.includes("<script"), "script tag must not survive");
  assert.ok(!html.includes("onerror"), "event handler must not survive");
  assert.ok(!html.includes("onclick"), "event handler must not survive");
  assert.ok(!html.includes("<iframe"), "iframe must not survive");
  assert.ok(html.includes("before") && html.includes("after"), "surrounding text survives");
});

test("SECURITY: transform-generated HTML escapes what it interpolates (highlight, callout title)", async () => {
  const html = await renderMarkdown('==a < b & "c"== and ==<img src=x onerror=a()>==\n\n> [!note] <b onclick=z()>t</b>\n> body\n', ctx());
  assert.ok(!html.includes("onerror"), html);
  assert.ok(!html.includes("onclick"), html);
  assert.ok(html.includes('<span class="text-highlight">a &lt; b &amp; &quot;c&quot;</span>'), html);
});

test("Obsidian callouts, foldable callouts, highlights, comments", async () => {
  const html = await renderMarkdown("> [!warning]- Folded\n> inside\n\n==hi==\n\n%% secret %%\n", ctx());
  assert.ok(html.includes('class="callout warning is-collapsible is-collapsed" data-callout="warning"'), html);
  assert.ok(html.includes('<span class="text-highlight">hi</span>'));
  assert.ok(!html.includes("secret"), "comments never render");
});

test("math (katex), mermaid, footnotes, syntax highlighting", async () => {
  const out = await renderPage("$E=mc^2$\n\n```mermaid\ngraph TD\n A-->B\n```\n\nRef.[^1]\n\n[^1]: Note.\n\n```js\nconst a = 1;\n```\n", ctx());
  assert.ok(out.html.includes('<span class="katex">'), "inline math rendered by katex");
  assert.ok(out.html.includes('class="mermaid"') && out.html.includes('id="mermaid-container"'), "mermaid block + Quartz's container");
  assert.ok(out.hasMermaid);
  assert.ok(out.html.includes('data-footnotes') && out.html.includes('data-footnote-ref'), "GFM footnotes");
  assert.ok(out.html.includes("data-rehype-pretty-code-figure"), "rehype-pretty-code (shiki) highlighting");
});

test("TOC entries, inline #tags (slugged, collected), reading time, text", async () => {
  const out = await renderPage("# Top\n\n## A part\n\ntext #my-tag and #123\n\n### Sub\n", ctx());
  assert.deepEqual(out.toc.map((e) => [e.depth, e.slug]), [[0, "top"], [1, "a-part"], [2, "sub"]]);
  assert.deepEqual(out.inlineTags, ["my-tag"], "numeric-only #123 is not a tag (Quartz)");
  assert.ok(out.html.includes('href="../../tags/my-tag" class="tag-link internal alias"') || out.html.includes("tag-link"), out.html);
  assert.equal(out.readingMinutes, 1);
  assert.ok(out.text.includes("A part"));
});

test("external links get Quartz's external class + icon; anchors stay intra-document", async () => {
  const html = await renderMarkdown("[x](https://example.invalid/a) and [y](#here)", ctx());
  assert.ok(html.includes('class="external"') && html.includes('class="external-icon"'), html);
  assert.ok(html.includes('href="#here" class="internal alias"'), html);
});

test("frontmatter is not rendered; CRLF and empty bodies are fine", async () => {
  const html = await renderMarkdown("---\r\ntitle: X\r\n---\r\n\r\nbody\r\n", ctx());
  assert.ok(!html.includes("title: X"));
  assert.ok(html.includes("body"));
  assert.equal(typeof (await renderMarkdown("", ctx())), "string");
  assert.equal(typeof (await renderMarkdown(null, ctx())), "string");
});

test("ofmTextTransform: comments stripped, callout title gets its own line", () => {
  assert.equal(ofmTextTransform("a %%x%% b"), "a  b");
  assert.ok(ofmTextTransform("> [!note] T\n> body").startsWith("> [!note] T\n> \n"));
});

// rw-p1a-render attempt 2, finding F-T1: the tester's injection probe (A4),
// verbatim. No script-capable URL scheme may survive into any URL attribute,
// and no raw element or on* handler either (the first property, re-checked
// through every transform).
const PROBE = [
  "# Injection probe",
  "",
  "Plain link [jl](javascript:alert(101)) and image ![ji](javascript:alert(102)) and data [dl](data:text/html,<script>alert(103)</script>).",
  "",
  "Raw: <img src=x onerror=alert(104)> <svg onload=alert(105)></svg> <script>alert(106)</script>",
  "",
  "<div onclick=\"alert(107)\">block</div>",
  "",
  "Wikilink [[javascript:alert(108)|wl]] and [[foo\" onmouseover=\"alert(109)]] and [[x<img src=y onerror=alert(110)>]].",
  "",
  "Embed ![[javascript:alert(111).png]] and ![[evil\" onerror=\"alert(112).pdf]] and ![[q\" onload=\"alert(113)]].",
  "",
  "Highlight ==<img src=x onerror=alert(114)>== and tag #<img",
  "",
  "Autolink <https://ex.invalid/\" onmouseover=\"alert(115)> and titled [t](https://ex.invalid \"a\\\" onmouseover=\\\"alert(116)\").",
  "",
  "> [!note] Title <img src=x onerror=alert(117)> `<script>alert(118)</script>`",
  "> body",
  "",
  "> [!warning|<script>alert(119)</script>\" onmouseover=\"alert(120)]- meta",
  "> folded",
  "",
  "Math $\\href{javascript:alert(121)}{m}$ and $\\htmlClass{x\" onmouseover=\"alert(122)}{y}$ and $$\\url{javascript:alert(123)}$$",
  "",
  "```mermaid",
  "%%{init: {\"securityLevel\": \"loose\"}}%%",
  "graph TD",
  "  A[<img src=x onerror=alert(124)>] --> B",
  "  click A callback \"alert(125)\"",
  "  click B \"javascript:alert(126)\"",
  "```",
  "",
  "Footnote[^<img src=x onerror=alert(127)>] and [^ok].",
  "",
  "[^<img src=x onerror=alert(127)>]: fn <script>alert(128)</script>",
  "[^ok]: fine",
  "",
  "## Second heading <img src=x onerror=alert(129)>",
  "",
  "Block ref ^\"onmouseover=alert(130)",
  "",
  "![yt](https://www.youtube.com/watch?v=aaaaaaaaaaa\"onload=\"alert(131))",
  "",
  "Obfuscated [o1](JaVaScRiPt:alert(132)) [o2](java&#x09;script:alert(133)) [o3](vbscript:msgbox(134)) [o4](%20javascript:alert(135)).",
].join("\n");

test("SECURITY (F-T1): no javascript:/vbscript:/data: URL survives in any attribute - the tester's probe", async () => {
  const html = await renderMarkdown(PROBE, ctx("content/source/00000000-0000-4000-8000-000000000003", ["content/person/foo"]));
  // Parsed, as a browser would (a regex over the markup also matches inside
  // escaped attribute VALUES, e.g. a title or the mermaid data-clipboard).
  const { fromHtml } = await import("hast-util-from-html");
  const { visit } = await import("unist-util-visit");
  const bad = [];
  const handlers = [];
  const scripts = [];
  visit(fromHtml(html, { fragment: true }), "element", (n) => {
    if (n.tagName === "script") scripts.push(n);
    for (const [k, v] of Object.entries(n.properties || {})) {
      if (/^on/i.test(k)) handlers.push(`${n.tagName}.${k}`);
      if (["href", "src", "poster", "cite", "action", "formAction", "xLinkHref", "data", "background"].includes(k) &&
          /^(?:javascript|vbscript|data):/i.test(String(v).replace(/[\x00-\x20]/g, ""))) bad.push(`${n.tagName}.${k}=${v}`);
    }
  });
  assert.deepEqual(bad, [], `unsafe URL attributes: ${bad.join(" | ")}`);
  assert.equal(scripts.length, 0, "no script element");
  assert.deepEqual(handlers, [], "no on* handler attribute");
  // the refused links keep their text, unlinked
  for (const t of ["jl", "dl", "wl", "o1", "o3"]) assert.ok(new RegExp(`>${t}<|\\b${t}\\b`).test(html), `text of ${t} kept`);
  assert.ok(!/<a [^>]*>jl<\/a>/.test(html), "the javascript: link is not an anchor");
});

test("SECURITY (F-T1): safe links are untouched; a raster data: image is allowed, an svg data: image and a data: link are not", async () => {
  const { isUnsafeUrl } = await import("./render-page.mjs");
  assert.equal(isUnsafeUrl("java\tscript:alert(1)"), true);
  assert.equal(isUnsafeUrl(" JAVASCRIPT:alert(1)"), true);
  assert.equal(isUnsafeUrl("vbscript:x"), true);
  assert.equal(isUnsafeUrl("data:text/html,x"), true);
  assert.equal(isUnsafeUrl("data:image/png;base64,AAAA", { image: true }), false);
  assert.equal(isUnsafeUrl("data:image/svg+xml,<svg onload=x>", { image: true }), true);
  assert.equal(isUnsafeUrl("data:image/png;base64,AAAA"), true, "a data: href is refused even for a raster type");
  assert.equal(isUnsafeUrl("https://example.invalid/a"), false);
  assert.equal(isUnsafeUrl("../../content/x"), false);
  const html = await renderMarkdown("[ok](https://example.invalid/a) and [rel](../x) and ![img](data:image/png;base64,AAAA)", ctx());
  assert.ok(html.includes('href="https://example.invalid/a"'), html);
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'), html);
});
