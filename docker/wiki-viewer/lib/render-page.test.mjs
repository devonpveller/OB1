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
