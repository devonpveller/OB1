// deno test --allow-all src/export/render_verify_test.ts - rw-p6a-resolve attempt 3: the tester's
// attempt-2 bypasses (test-attempt2-2026-10-18.md ADV-3, ADV-4, ADV-5, near-misses 1-6) through the
// REAL pandoc 3.11 + Typst 0.15.1. Needs the image's test stage (poppler reads PDFs back); it runs in
// the build gate.
//   A3-1  the link-shape matrix (the tester's five shapes, attributes and more): no unsafe target in
//         the MD (re-read by the parser AND by pandoc to HTML), the DOCX relationships, the PDF
//         actions; no attribute reaches a reader
//   A3-2  the OUTPUT verification on its own (the cleaning bypassed: pandoc run directly on the
//         hostile note, or a hand-made PDF): every format's offence is found
//   A3-3  glyphs in code, fences, math, headings, image alt, link text/title, reference titles: 422
//         before Typst; what Typst draws is checked for .notdef boxes
//   A3-4  a credential split by each empty citeproc tag (and by invisible characters): refused at the
//         record, and refused at the output (503 credential) when a cached row carries it
//   A3-5  limits: size, bracket depth, tree depth, list depth (422 too-complex, fast); pandoc's
//         wall clock (stopped, with its children)
//   A3-6  a style symlink and a style outside the directory; a writer the verification cannot read
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { type FormatDef, prepareDocument, render, RenderFailed, type RenderInput, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { pdfText } from "./pdf_tools.ts";
import { docxXml } from "./zip_read.ts";
import { fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { markdownOffence, safeTarget } from "./markdown.ts";
import { OutputRejected, verifyDocx, verifyMarkdown, verifyOutput, verifyPdf, verifyText } from "./verify.ts";
import { createResolver } from "./resolver.ts";
import { renderSafeCsl } from "./csl.ts";
import { PdfDocument } from "./pdf_read.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const input = (md: string, f: string, extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs: fixtureRefs(1), format: fmt(f), style: style("ieee"), cslDir: CSL_DIR, wrapNone: true, ...extra });
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const cite1 = `[[source/${fixtureId(1)}|s]]`;
const doc = (body: string) => `# P\n\nBody ${cite1}.\n\n${body}\n`;
const pandoc = async (stdin: Uint8Array, args: string[]) => {
  const p = new Deno.Command("pandoc", { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(stdin);
  await w.close();
  const o = await p.output();
  return o.stdout;
};
// pandoc run DIRECTLY on a note (no cleaning): what attempt 2's input defences let through
const rawRender = async (md: string, to: string, ext: string) => {
  const dir = await Deno.makeTempDir({ prefix: "ob-raw-" });
  try {
    await Deno.writeTextFile(`${dir}/in.md`, md);
    const args = ["-f", "markdown", "-t", to, ...(to === "pdf" ? ["--pdf-engine", "typst"] : []), "-o", `${dir}/out.${ext}`, `${dir}/in.md`];
    const o = await new Deno.Command("pandoc", { args, cwd: dir, stdout: "piped", stderr: "piped" }).output();
    assertEquals(o.code, 0, new TextDecoder().decode(o.stderr));
    return await Deno.readFile(`${dir}/out.${ext}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};
const rejects = async (f: () => Promise<unknown> | unknown, code: string, re: RegExp) => {
  let err: unknown;
  try {
    await f();
  } catch (e) {
    err = e;
  }
  assert(err instanceof OutputRejected || err instanceof RenderFailed, `expected a rejection (${code}), got ${err}`);
  assertEquals((err as OutputRejected).code, code, (err as Error).message);
  assertMatch((err as Error).message, re);
  return err as Error;
};

// ── A3-1: the link-shape matrix ──────────────────────────────────────────────────────────────────
const SHAPES: Record<string, string> = {
  // the tester's five (ADV-4) and the attribute
  multiline_label: "[click\nme](javascript:EVILMULTI())",
  codespan_label: "[`code`](javascript:EVILCODE())",
  nested_parens: "[x](javascript:EVILNEST((1)))",
  refdef_nextline: "[ref]:\n    javascript:EVILREFDEF()\n\nsee [ref].",
  nl_dest: "[x](\njavascript:EVILNLDEST())",
  link_attr: '[ok](http://example.com){onclick="EVILLATTR()"}',
  // and the neighbours
  img_attr: '![alt](http://example.com/a.png){onerror="EVILIATTR()"}',
  code_attr: '`c`{onclick="EVILC()"} and `x`{=html}',
  heading_attr: '## Head {#h onclick="EVILH()"}',
  fence_attr: '```{.x onclick="EVILF()"}\ncode\n```',
  span_attr: '[sp]{onclick="EVILSP()"}',
  div_attr: '::: {onclick="EVILDV()"}\ninside\n:::',
  html_div: '<div onclick="EVILDIV()">div text</div>',
  html_a: '<a href="javascript:EVILA()">a</a>',
  footnote_link: "Note^[[f](javascript:EVILFOOT())] and a GFM note[^1].\n\n[^1]: [g](javascript:EVILGFM())",
  table_link: "| a | b |\n|---|---|\n| [t](javascript:EVILTABLE()) | x |",
  shortcut_ref: "[EVILSC]\n\n[EVILSC]: javascript:EVILSHORT()",
  refdef_angle: "[r3]: <javascript:EVILRA()>\n\n[r3]",
  refdef_title: '[r2]: javascript:EVILRT() "title"\n\n[r2]',
  angle_dest: "[x](<javascript:EVILANGLE()>)",
  entity_scheme: "[e](jav&#x61;script:EVILENT()) [t](java&Tab;script:EVILTAB())",
  autolink: "<javascript:EVILAUTO()> <vbscript:EVILVB()>",
  data_link: "[d](data:text/html;base64,PHNjcmlwdD4=) ![i](data:image/svg+xml;base64,PHN2Zz4=)",
  file_link: "[f](file:///etc/passwd)",
  math_space: "$ [m](javascript:EVILMATH()) $",
  display_math_blank: "$$\n[dm](javascript:EVILDM())\n\nx\n$$",
  nested_link_in_image: "![[in](javascript:EVILIMG())](http://example.com/a.png)",
  emphasis_link: "*[em](javascript:EVILEM())* **[st](javascript:EVILST())**",
  blockquote_list: "> - [q](javascript:EVILQ())\n>   1. [r](javascript:EVILR())",
  text_scheme: "plain javascript:alert(1), java\u200bscript:x, data:text/html,x and file:///etc/passwd",
  link_title_q: '[t](http://example.com "x\\" onclick=\\"EVILT()")',
};
const SCRIPTY = /javascript:|vbscript:|data:text|file:\/\//i;

Deno.test("A3-1: the link-shape matrix - no unsafe target, attribute or raw node in the MD, DOCX or PDF; the MD re-read by pandoc to HTML carries no href to a script and no on* attribute", async () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const md = text((await render(input(doc(body), "md"))).bytes);
    assertEquals(markdownOffence(md), null, `${name}: the MD re-read by the parser`);
    const html = text(await pandoc(new TextEncoder().encode(md), ["-f", "markdown", "-t", "html"]));
    assert(!/href="(?!https?:|mailto:|#)[^"]*"|src="(?!https?:|data:image\/(png|jpe?g|gif|webp))[^"]*"/i.test(html.replace(/src="a\.png"|href="#[^"]*"/g, "")), `${name}: pandoc's HTML of the MD links somewhere unsafe:\n${html}`);
    assert(!/<[^>]*\son[a-z]+=/i.test(html),`${name}: pandoc's HTML of the MD carries an on* attribute:\n${html}`);
    assert(!SCRIPTY.test(html.replace(/javascript\[:\]|vbscript\[:\]|data\[:\]|file\[:\]/gi, "")), `${name}: pandoc's HTML of the MD carries ${SCRIPTY.exec(html)?.[0]}`);
    const xml = await docxXml((await render(input(doc(body), "docx"))).bytes);
    for (const m of xml.matchAll(/Target="([^"]*)"\s+TargetMode="External"/g)) assert(/^(https?:|mailto:)/.test(m[1]), `${name}: DOCX hyperlink to ${m[1]}`);
    assert(!/Target="(?:javascript|vbscript|data|file):/i.test(xml), `${name}: DOCX relationship`);
    const pdf = (await render(input(doc(body), "pdf"))).bytes;
    const pdoc = await PdfDocument.read(pdf);
    for (const a of pdoc.actions()) assert(a.kind === "URI" && /^(https?:|mailto:)/.test(a.target ?? ""), `${name}: PDF action ${a.kind} ${a.target}`);
    assert(!/\/URI\s*\((?!https?:|mailto:)/.test(new TextDecoder("latin1").decode(pdf)), `${name}: PDF /URI`);
    const t = text((await render(input(doc(body), "txt"))).bytes);
    assert(!/javascript:|vbscript:|data:text|file:\/\//i.test(t), `${name}: TXT carries a scheme`);
  }
});

Deno.test("A3-1: the text of a dropped link stays, an autolink to a script says '(link removed)', a safe link stays a link", async () => {
  const md = text((await render(input(doc("[click\nme](javascript:X()) [`code`](javascript:Y()) <javascript:Z()> [ok](https://example.org/ok) <https://example.org/auto>"), "md"))).bytes);
  for (const keep of ["click me", "`code`", "(link removed)", "[ok](https://example.org/ok)", "<https://example.org/auto>"]) assert(md.includes(keep), `keeps ${keep}:\n${md}`);
  // the target rule itself
  for (const bad of ["javascript:x", " JaVa\tScript:x", "jav&#x61;script:x", "java&colon;x:", "vbscript:x", "data:text/html,x", "file:///x", "x:y", "a&b", "a\\b", "https://e.org/javascript:x"]) assert(!safeTarget(bad), bad);
  for (const ok of ["https://e.org/a?b=c", "http://e.org", "mailto:a@b.org", "#frag", "dir/file.md", "../up.png", ""]) assert(safeTarget(ok), ok);
  assert(safeTarget("data:image/png;base64,iVBORw0=", true) && !safeTarget("data:image/svg+xml;base64,PHN2Zz4=", true));
  // a line of colons from the note or from a reference title, wrapped to a line start by the MD
  // writer: never a fenced div for a reader (three colons never stand together in text)
  const refs = fixtureRefs(1);
  refs[0].csl.title = `${"word ".repeat(14)}::: {onclick="EVILREFDIV()"} tail`;
  const wrapped = text((await render({ ...input(doc(`${"word ".repeat(13)}::: {onclick="EVILDIV()"} tail`), "md"), refs, wrapNone: false })).bytes);
  assertEquals(markdownOffence(wrapped), null, wrapped);
  const html = text(await pandoc(new TextEncoder().encode(wrapped), ["-f", "markdown", "-t", "html"]));
  assert(!/<div[^>]*onclick/i.test(html) && !/<[^>]*\son[a-z]+=/i.test(html), html);
});

// ── A3-2: the output verification on its own ─────────────────────────────────────────────────────
Deno.test("A3-2: with the cleaning bypassed (pandoc on the raw note), every format's output verification refuses what attempt 2 served", async () => {
  // MD: a javascript: link and a link attribute, as pandoc's own markdown writer writes them
  const mdLink = await rawRender("[click\nme](javascript:EVILMULTI())\n", "markdown", "md");
  await rejects(() => verifyMarkdown(text(mdLink), []), "output-verification", /a link to 'javascript:EVILMULTI\(\)'/);
  const mdAttr = await rawRender('[ok](http://example.com){onclick="EVILLATTR()"}\n', "markdown", "md");
  await rejects(() => verifyMarkdown(text(mdAttr), []), "output-verification", /an attribute block '\{onclick/);
  const mdDiv = await rawRender('::: {onclick="EVILDV()"}\ninside\n:::\n', "markdown", "md");
  await rejects(() => verifyMarkdown(text(mdDiv), []), "output-verification", /a fenced div/);
  const mdHead = await rawRender('# H {onclick="EVILH()"}\n', "markdown", "md");
  await rejects(() => verifyMarkdown(text(mdHead), []), "output-verification", /a heading attribute block/);
  await rejects(() => verifyMarkdown("Text <span onclick=\"x\">s</span>\n", []), "output-verification", /raw HTML/);
  await rejects(() => verifyMarkdown("```{=html}\n<script>x</script>\n```\n", []), "output-verification", /a code block attribute/);
  await rejects(() => verifyMarkdown("A raw \\input{/etc/passwd} command\n", []), "output-verification", /a raw TeX command/);
  // DOCX: the relationship
  const docx = await rawRender("[`code`](javascript:EVILCODE())\n", "docx", "docx");
  await rejects(() => verifyDocx(docx, []), "output-verification", /a hyperlink to 'javascript:EVILCODE\(\)'/);
  // PDF: the URI action, then the box (the tester's code-span case, no glyph pre-check in the way)
  const pdf = await rawRender("[x](javascript:EVILNEST((1)))\n", "pdf", "pdf");
  await rejects(() => verifyPdf(pdf, []), "output-verification", /a URI action to 'javascript:EVILNEST\(\(1\)\)'/);
  const tofu = await rawRender("Code `$\u{10600}$` here and math $\u{10600}$ there.\n", "pdf", "pdf");
  const e = await rejects(() => verifyPdf(tofu, []), "output-verification", /\.notdef glyph/);
  console.log(`A3-2 tofu RED: ${e.message}`);
  // TXT: an unsafe-scheme string in the text
  await rejects(() => verifyText("see javascript:alert(1) here", []), "output-verification", /unsafe-scheme string/);
  await rejects(() => verifyText("see java\u200bscript:alert(1) here", []), "output-verification", /unsafe-scheme string/);
  // an unknown writer is refused
  await rejects(() => verifyOutput("html5", "html", new Uint8Array(), []), "output-verification", /a writer \('html5'\) the export cannot verify/);
});

const minimalPdf = (extraCatalog: string, objects: string[]) => new TextEncoder().encode([
  "%PDF-1.7",
  `1 0 obj << /Type /Catalog /Pages 2 0 R ${extraCatalog} >> endobj`,
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Annots [5 0 R] >> endobj",
  ...objects,
  "trailer << /Root 1 0 R >>", "%%EOF", "",
].join("\n"));

Deno.test("A3-2: a PDF action other than a link (JavaScript, an open action, Launch, a hex-encoded javascript: URI, additional actions) is refused", async () => {
  await rejects(() => verifyPdf(minimalPdf("/OpenAction 4 0 R", ["4 0 obj << /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >> endobj", "5 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 1 1] >> endobj"]), []), "output-verification", /'(OpenAction|JavaScript|JS)' action/);
  await rejects(() => verifyPdf(minimalPdf("", ["5 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /Launch /F (calc.exe) >> >> endobj"]), []), "output-verification", /'Launch' action/);
  const hex = [..."javascript:EVILHEX()"].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  await rejects(() => verifyPdf(minimalPdf("", [`5 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI <${hex}> >> >> endobj`]), []), "output-verification", /a URI action to 'javascript:EVILHEX\(\)'/);
  await rejects(() => verifyPdf(minimalPdf("", ["5 0 obj << /Type /Annot /Subtype /Widget /Rect [0 0 1 1] /AA << /E << /S /URI /URI (https://example.org) >> >> >> endobj"]), []), "output-verification", /'AA' action/);
  await rejects(() => verifyPdf(new TextEncoder().encode("not a pdf"), []), "output-verification", /cannot be read back/);
  // a clean one passes
  await verifyPdf(minimalPdf("", ["5 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /Type /Action /S /URI /URI (https://example.org/ok) >> >> endobj"]), []);
});

// ── A3-3: glyphs on the parsed text, then the PDF ────────────────────────────────────────────────
const L = "\u{10600}"; // Linear A: no installed face covers it
Deno.test("A3-3: an uncovered character in a code span, a fence, inline and display math, a heading code span, an image alt, a link text and title, a reference title: 422 glyphs before Typst", async () => {
  const cases: Record<string, string> = {
    code_span: "Code `$" + L + "$` here.", code_and_math: "Code `$" + L + "$` here and math $" + L + "$ there.",
    fence: "```\n$" + L + "$ in a fence\n```", math_inline: `Math $${L}$ there.`, display_math: `$$\n${L}\n$$`,
    heading_code: "## Head `" + L + "`", image_alt: `![$${L}$](missing.png)`, link_text: `[${L}](http://example.com)`,
    link_title: `[t](http://example.com "${L}")`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const e = await assertRejects(() => render(input(doc(body), "pdf")), RenderFailed);
    assertEquals([e.code, (e.extra as { characters: string[] }).characters], ["glyphs", ["U+10600"]], `${name}: ${e.message}`);
  }
  const refs = fixtureRefs(1);
  refs[0].csl.title = `Ref title ${L}`;
  const e = await assertRejects(() => render({ ...input(doc("x"), "pdf"), refs }), RenderFailed);
  assertEquals(e.code, "glyphs", "a reference title");
  // covered text in code and math renders, and its PDF holds no box (the verification ran: no throw)
  for (const ok of ["Code `😀 中文 שלום` here.", "Math $\\alpha + 中$ there.", "```\nfence 😀 中文\n```"]) {
    const pdf = (await render(input(doc(ok), "pdf"))).bytes;
    assertEquals((await (await PdfDocument.read(pdf)).glyphs()).notdef, [], ok);
  }
});

// ── A3-4: a credential split by an empty tag ─────────────────────────────────────────────────────
const KEY = "a3synthkey0a1b2c3d4e5f6";
const MAIL = "a3-synthmail@example.invalid";
const SPLITS: Record<string, (s: string) => string> = {
  i: (s) => `${s.slice(0, 6)}<i></i>${s.slice(6)}`,
  b: (s) => `${s.slice(0, 5)}<b></b>${s.slice(5)}`,
  sc: (s) => `${s.slice(0, 4)}<sc></sc>${s.slice(4)}`,
  nocase: (s) => `${s.slice(0, 3)}<span class="nocase"></span>${s.slice(3)}`,
  smallcaps: (s) => `${s.slice(0, 3)}<span style="font-variant:small-caps;"></span>${s.slice(3)}`,
  sup: (s) => `${s.slice(0, 3)}<sup></sup>${s.slice(3)}`,
  sub: (s) => `${s.slice(0, 3)}<sub></sub>${s.slice(3)}`,
  nested: (s) => `${s.slice(0, 3)}<i><b></b></i>${s.slice(3)}`,
  spaced: (s) => `${s.slice(0, 3)}<i> </i>${s.slice(3)}`,
  entity: (s) => `${s.slice(0, 3)}&#${s.charCodeAt(3)};${s.slice(4)}`,
  soft_hyphen: (s) => `${s.slice(0, 3)}\u00ad${s.slice(3)}`,
  zero_width: (s) => `${s.slice(0, 3)}\u200b${s.slice(3)}`,
  unclosed: (s) => `${s.slice(0, 3)}<i>${s.slice(3)}`,
};
Deno.test("A3-4: a record whose title holds the key or the mailto split by each empty citeproc tag (and entities, invisible characters) is unsafe - never cached, never rendered", () => {
  const r = createResolver({ openalexKey: KEY, mailto: MAIL, proxyUrl: "http://proxy.invalid:8888", openalexBase: "http://a.stub", crossrefBase: "http://c.stub", timeoutMs: 1000 }, { buildClient: () => ({ close() {} }) as never });
  try {
    for (const [name, split] of Object.entries(SPLITS)) {
      assert(r.unsafe({ type: "article", title: `Split ${split(KEY)} here` }), `${name}: the key`);
      assert(r.unsafe({ type: "article", title: `Split ${split(MAIL)} here` }), `${name}: the mailto`);
      assert(r.unsafe({ type: "article", title: "t", author: [{ literal: split(KEY) }] }), `${name}: an author`);
    }
    assert(r.unsafe({ type: "article", title: KEY.slice(0, 8), "container-title": KEY.slice(8) }), "split across two fields");
    assert(r.unsafe({ type: "article", title: "x api_key<i></i>=1" }), "an assignment split by a tag");
    assert(!r.unsafe({ type: "article", title: "A <i>proper</i> title with <sc>Small Caps</sc>" }), "markup alone is not unsafe");
  } finally {
    r.close();
  }
});

Deno.test("A3-4: a cached row holding a split key (written before attempt 3, so unsafe() never saw it) is refused at the OUTPUT in every format: 503 credential, nothing served", async () => {
  for (const [name, split] of Object.entries({ i: SPLITS.i, sc: SPLITS.sc, nocase: SPLITS.nocase })) {
    const refs = fixtureRefs(1);
    refs[0].csl.title = `Split ${split(KEY)} and ${SPLITS.b(MAIL)}`;
    // the empty tags are gone before citeproc sees them (renderSafeCsl), so the key would print
    assert(!String(renderSafeCsl(refs[0].csl).title).includes("<"), `${name}: empty tags removed`);
    for (const f of ["md", "txt", "docx", "pdf"]) {
      const e = await assertRejects(() => render({ ...input(doc("x"), f), refs, secrets: [KEY, MAIL] }), RenderFailed);
      assertEquals([e.code, (e.extra as { format: string }).format], ["credential", f], `${name} ${f}: ${e.message}`);
      assert(!e.message.includes(KEY) && !e.message.includes(MAIL), "the refusal does not print the secret");
    }
  }
  // the note's own text carrying the key (an HTML tag between its halves, which the cleaning drops)
  const e = await assertRejects(() => render({ ...input(doc(`My ${KEY.slice(0, 5)}<b></b>${KEY.slice(5)} note`), "txt"), secrets: [KEY] }), RenderFailed);
  assertEquals(e.code, "credential");
});

// ── A3-5: limits ──────────────────────────────────────────────────────────────────────────────────
Deno.test("A3-5: past a limit the export is refused 422 too-complex, naming the limit, before pandoc runs (fast)", async () => {
  const cases: [string, string, RegExp][] = [
    ["brackets", "[".repeat(20_000) + "x" + "]".repeat(20_000), /bracket nesting depth/],
    ["deep list", "- ".repeat(3000) + "x", /nesting depth|list nesting depth/],
    ["indented list", Array.from({ length: 200 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"), /nesting depth|list indentation in columns/],
    ["deep quote", ">".repeat(500) + " x", /nesting depth/],
    ["size", "word ".repeat(250_000), /size in bytes/],
    // the parser's quadratic shapes (attempt 3's own probe: 25 KB of `*a` took it 9 s)
    ["delimiters", "*a".repeat(20_000), /emphasis delimiters in one paragraph/],
    ["strikethrough", "~~a".repeat(5_000), /emphasis delimiters in one paragraph/],
    ["flat brackets", "[a] ".repeat(2_000), /brackets in one paragraph/],
  ];
  for (const [name, body, re] of cases) {
    const t0 = performance.now();
    const e = await assertRejects(() => render(input(doc(body), "pdf")), RenderFailed);
    const ms = performance.now() - t0;
    assertEquals(e.code, "too-complex", `${name}: ${e.message}`);
    assertMatch(e.message, re);
    assert(ms < 15_000, `${name}: refused in ${Math.round(ms)} ms`);
    console.log(`A3-5 ${name}: ${e.message} (${Math.round(ms)} ms)`);
  }
  // under the limits a nested document renders, and a paragraph citing 400 sources is not "brackets"
  await render(input(doc("- a\n  - b\n    - c\n\n> > quoted [[x]] [with [nested [brackets]]]"), "pdf"));
  prepareDocument(doc(Array.from({ length: 400 }, () => cite1).join(" ")), fixtureRefs(1), fmt("md"));
});

Deno.test("A3-5: the parser runs in a worker with its own time: past it the worker is terminated, 422 too-complex - the workbench's thread never waits on it", async () => {
  const body = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with *some* _markup_ and [a link](https://example.org/${i}).`).join("\n\n");
  const e = await assertRejects(() => render({ ...input(doc(body), "md"), parseTimeoutMs: 1 }), RenderFailed);
  assertEquals(e.code, "too-complex", e.message);
  assertMatch(e.message, /the parser's time/);
  // meanwhile the thread was free: a timer fired while the worker ran
  let ticks = 0;
  const t = setInterval(() => ticks++, 5);
  await render(input(doc(body), "md"));
  clearInterval(t);
  assert(ticks > 0, "the event loop ran while the worker parsed");
});

Deno.test("A3-5: pandoc's wall clock: a render past its time is stopped with every process it started, 422 too-complex", async () => {
  const before = pandocs();
  const e = await assertRejects(() => render({ ...input(doc("x"), "pdf"), timeoutMs: 1 }), RenderFailed);
  assertEquals(e.code, "too-complex", e.message);
  assertMatch(e.message, /within 0 s \(pandoc was stopped\)|within 1 s|pandoc was stopped/);
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(pandocs().filter((p) => !before.includes(p)), [], "no pandoc or typst process is left");
});
function pandocs(): number[] {
  const out: number[] = [];
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      const comm = Deno.readTextFileSync(`/proc/${e.name}/comm`).trim();
      if (comm === "pandoc" || comm === "typst") out.push(Number(e.name));
    } catch { /* gone */ }
  }
  return out;
}

// ── A3-6: the style file and the writer ──────────────────────────────────────────────────────────
Deno.test("A3-6: a style that is a symlink (inside or pointing outside the style directory) is refused, even with the right bytes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ob-csl-a3-" });
  const outside = await Deno.makeTempDir({ prefix: "ob-out-a3-" });
  try {
    await Deno.copyFile(`${CSL_DIR}/ieee.csl`, `${dir}/real.csl`);
    await Deno.copyFile(`${CSL_DIR}/ieee.csl`, `${outside}/ieee.csl`);
    await Deno.symlink(`${dir}/real.csl`, `${dir}/ieee.csl`);
    const e1 = await assertRejects(() => render(input(doc("x"), "txt", { cslDir: dir })), RenderFailed);
    assertEquals(e1.code, "style-integrity");
    assertMatch(e1.message, /not a regular file/);
    await Deno.remove(`${dir}/ieee.csl`);
    await Deno.symlink(`${outside}/ieee.csl`, `${dir}/ieee.csl`);
    const e2 = await assertRejects(() => render(input(doc("x"), "txt", { cslDir: dir })), RenderFailed);
    assertEquals(e2.code, "style-integrity");
    await Deno.remove(`${dir}/ieee.csl`);
    await Deno.copyFile(`${CSL_DIR}/ieee.csl`, `${dir}/ieee.csl`);
    await render(input(doc("x"), "txt", { cslDir: dir })); // a regular copy is fine
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("A3-6 (near-miss 6): a format row whose writer the verification cannot read (html5, rst) or a PDF through another engine is refused 503 format, before pandoc", async () => {
  for (const row of [
    { key: "html", pandoc_to: "html5", ext: "html", mime: "text/html" },
    { key: "rst", pandoc_to: "rst", ext: "rst", mime: "text/x-rst" },
    { key: "pdfw", pandoc_to: "pdf", ext: "pdf", mime: "application/pdf", engine: "weasyprint" },
  ]) {
    const e = await assertRejects(() => render({ ...input(doc("x"), "txt"), format: row as FormatDef }), RenderFailed);
    assertEquals(e.code, "format", `${row.key}: ${e.message}`);
  }
});

Deno.test("A3: the cleaned pandoc input (prepareDocument) holds no link but the safe ones, no raw HTML and no attribute block", () => {
  for (const [name, body] of Object.entries(SHAPES)) {
    const p = prepareDocument(doc(body), fixtureRefs(1), fmt("md"));
    assertEquals(markdownOffence(p.markdown.replaceAll(`[@src-${fixtureId(1)}]`, "")), null, `${name}:\n${p.markdown}`);
  }
});

// ── A3-13: an image cannot make pandoc read a local file or fetch a URL (found in attempt 3) ─────
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
Deno.test("A3-13: an image path outside the resource path, a hidden or non-image file, or an http(s) image never makes pandoc read the file or fetch the URL; a local PNG still embeds", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ob-img-a3-" });
  try {
    await Deno.mkdir(`${dir}/img`);
    await Deno.writeFile(`${dir}/img/ok.png`, PNG_1PX);
    await Deno.writeTextFile(`${dir}/notes.txt`, "NOT-AN-IMAGE-A3");
    const body = "![ok](img/ok.png) ![p](../../../../../../etc/passwd) ![q](/etc/hostname) ![e](/proc/self/environ) " +
      "![g](.git/config) ![t](%2e%2e/%2e%2e/etc/passwd) ![n](notes.txt) ![s](img/../notes.txt) ![r](http://img.example.invalid/a.png)";
    for (const f of ["docx", "pdf"]) {
      const out = await render(input(doc(body), f, { resourcePath: dir }));
      assert(!/Could not fetch|fetch resource/i.test(out.stderr), `${f}: pandoc tried to fetch: ${out.stderr.slice(0, 300)}`);
      assert(!/root:x:0|NOT-AN-IMAGE-A3/.test(new TextDecoder("latin1").decode(out.bytes)), `${f}: a local file was embedded`);
      if (f === "docx") {
        const xml = await docxXml(out.bytes);
        assertEquals([...xml.matchAll(/Target="media\/[^"]+"/g)].length, 1, "exactly one embedded image: the PNG");
        assertMatch(xml, /Target="http:\/\/img\.example\.invalid\/a\.png" TargetMode="External"/, "the remote image is a hyperlink");
      }
    }
    // the cleaning bypassed: pandoc embeds the file, and the output verification refuses it
    await Deno.writeTextFile(`${dir}/in.md`, "![q](/etc/hostname)\n");
    const o = await new Deno.Command("pandoc", { args: ["-f", "markdown", "-t", "docx", "-o", `${dir}/raw.docx`, `${dir}/in.md`], cwd: dir, stdout: "piped", stderr: "piped" }).output();
    assertEquals(o.code, 0);
    await rejects(() => verifyDocx(Deno.readFileSync(`${dir}/raw.docx`), []), "output-verification", /an embedded part that is not an image/);
    await Deno.writeTextFile(`${dir}/leak.png`, `env OPENALEX_API_KEY=${KEY}\n`);
    await Deno.writeTextFile(`${dir}/in.md`, "![k](leak.png)\n");
    await new Deno.Command("pandoc", { args: ["-f", "markdown", "-t", "docx", "-o", `${dir}/raw2.docx`, `${dir}/in.md`], cwd: dir, stdout: "piped", stderr: "piped" }).output();
    await rejects(() => verifyDocx(Deno.readFileSync(`${dir}/raw2.docx`), [KEY]), "credential", /media/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A3-13: pandoc runs with a clean environment - the workbench's variables (the key, the mailto, the database password) never reach it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ob-env-a3-" });
  const path = Deno.env.get("PATH") ?? "";
  try {
    const real = new TextDecoder().decode((await new Deno.Command("sh", { args: ["-c", "command -v pandoc"], stdout: "piped" }).output()).stdout).trim();
    await Deno.writeTextFile(`${dir}/pandoc`, `#!/bin/sh\nenv > ${dir}/env.log\nexec ${real} "$@"\n`);
    await Deno.chmod(`${dir}/pandoc`, 0o755);
    Deno.env.set("PATH", `${dir}:${path}`);
    Deno.env.set("OPENALEX_API_KEY", KEY);
    Deno.env.set("CROSSREF_MAILTO", MAIL);
    await render(input(doc("x"), "txt"));
    const env = await Deno.readTextFile(`${dir}/env.log`);
    assert(!env.includes(KEY) && !env.includes(MAIL) && !/OPENALEX|CROSSREF|PGPASSWORD|DB_PASS/i.test(env), env);
    assertMatch(env, /^PATH=/m);
  } finally {
    Deno.env.set("PATH", path);
    Deno.env.delete("OPENALEX_API_KEY");
    Deno.env.delete("CROSSREF_MAILTO");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A3: the PDF text layer reader sees what pdftotext sees (the credential check reads it)", async () => {
  const pdf = (await render(input(doc("A sentence with Ünïcødé, 中文 and 😀 for the reader."), "pdf"))).bytes;
  const mine = (await (await PdfDocument.read(pdf)).glyphs()).text.replace(/\s+/g, "");
  const poppler = (await pdfText(pdf)).replace(/\s+/g, "");
  for (const w of ["Asentencewith", "Ünïcødé", "中文", "forthereader"]) {
    assert(mine.includes(w) && poppler.includes(w), `${w}: mine ${mine.slice(0, 120)} / poppler ${poppler.slice(0, 120)}`);
  }
});
