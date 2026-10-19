// deno test --allow-all src/export/render_safety_test.ts - the renderer against the tester's
// attempt-1 findings (rw-p6a-resolve attempt 2), through the REAL pandoc 3.11 + Typst 0.15.1 and read
// back with poppler and the DOCX's own XML. Needs the image's test stage; it runs in the build gate.
//   ADV-5a  a note title (frontmatter) with citation, Typst and markdown syntax renders LITERALLY and
//           never fails the export; "Citeproc: citation X not found" is unreachable from user text
//   ADV-1c  raw HTML and raw-attribute blocks in a note never reach the MD, DOCX or PDF (amended A5);
//           a javascript:/data:/vbscript: link is kept as its text, never as a link
//   ADV-4b  a CSL style is hashed when it is USED: a one-byte change, a row whose file is missing, a
//           file name that leaves the style directory - each refused, naming the style + "integrity"
//   ADV-5   a character no installed face covers is refused BEFORE Typst runs (no 200 with boxes);
//           emoji render with the emoji face
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { type FormatDef, render, type RenderInput, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { pdfFonts, pdfPageSize, pdfText } from "./pdf_tools.ts";
import { docxXml } from "./zip_read.ts";
import { fixtureId, fixtureRefs } from "./test_fixtures.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const input = (md: string, f: string, extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs: fixtureRefs(1), format: fmt(f), style: style("ieee"), cslDir: CSL_DIR, wrapNone: true, ...extra });
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const cite1 = `[[source/${fixtureId(1)}|s]]`;
const pandocOut = async (b: Uint8Array, args: string[]) => {
  const p = new Deno.Command("pandoc", { args, stdin: "piped", stdout: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(b);
  await w.close();
  return text((await p.output()).stdout);
};
// standalone: the DOCX's title paragraph is printed (pandoc reads it into the metadata)
const docxPlain = (b: Uint8Array) => pandocOut(b, ["-f", "docx", "-t", "plain", "--wrap=none", "--standalone"]);
// The MD export read back by a pandoc markdown reader with raw HTML and raw attributes ON (pandoc's
// defaults): the raw nodes it would hand a writer. (A test's own check; the export never reads AST.)
const rawNodesIn = async (md: string) =>
  [...(await pandocOut(new TextEncoder().encode(md), ["-f", "markdown", "-t", "native"])).matchAll(/Raw(?:Inline|Block) \(\s*Format "(\w+)"\s*\)/g)].map((m) => m[1]);

// ── ADV-5a: the title and every user-text `@` ────────────────────────────────────────────────
const TITLE = "Title mail @me and [@you] #set page(width: 2cm) $x$ back\\slash *e* _u_ <b>x</b> -@x";
Deno.test("ADV-5a: a frontmatter title with @, [@..], #set, $x$, \\, *, _, <b> renders literally in PDF and DOCX, and every format exports", async () => {
  const md = `---\ntitle: '${TITLE}'\nauthor: "@author"\ntags: ["@tag"]\n---\n# H\n\nBody ${cite1}.\n`;
  for (const f of ["md", "txt", "docx", "pdf"]) await render(input(md, f)); // none raises
  const pdf = (await render(input(md, "pdf"))).bytes;
  const pt = (await pdfText(pdf)).replace(/\s+/g, " ");
  assert(pt.includes(TITLE), `PDF title literal: ${pt.slice(0, 200)}`);
  assertEquals((await pdfPageSize(pdf))?.width, 595.276, "A4: the title's #set page did not run");
  const dt = await docxPlain((await render(input(md, "docx"))).bytes);
  assert(dt.includes(TITLE), `DOCX title literal: ${dt.slice(0, 200)}`);
});

Deno.test("ADV-5a: no user text reaches citeproc as a citation - x_@me, \\\\@me, é@me, a list continuation, a footnote", async () => {
  const md = [
    "# Edge", "", `Under x_@me and a\\\\@two and é@three and (@four) ${cite1}.`, "",
    "- item one", "", "    continued @five in the list", "", "Note^[@six in a footnote].", "",
    "| a | b |", "|---|---|", "| @seven | x |", "",
  ].join("\n");
  const t = text((await render(input(md, "txt"))).bytes);
  for (const k of ["x_@me", "\\@two", "é@three", "(@four)", "@five", "@six", "@seven"]) assert(t.includes(k), `${k} printed literally:\n${t}`);
  assert(!/\(\w+\?\)/.test(t), "no citeproc '(key?)'");
});

// ── ADV-1c: raw HTML (amended fact A5: dropped from the MD export) ───────────────────────────
const RAW_PROBE = [
  "# Raw HTML", "",
  'Before <script>alert("XSS-INLINE")</script> after <b onclick="EVIL1()">bold</b> and',
  '<img src=x onerror="EVIL2()">.', "",
  "<div>div body</div>", "",
  "<script>", 'alert("XSS-BLOCK")', "</script>", "",
  "<!-- COMMENT-LEAK -->", "",
  '<iframe src="javascript:EVIL4()"></iframe>', "",
  '[a link](javascript:EVIL5()) and <a href="javascript:EVIL6()">anchor</a>.', "",
  "[ref link][r], [entity](jav&#x61;script:EVIL8()), [spaced]( JaVaScRiPt:EVIL9()), [data](data:text/html;base64,PHNjcmlwdD4=), [vb](vbscript:EVIL10), <javascript:EVIL11()>", "",
  "[r]: javascript:EVIL7()", "",
  `Cite s ${cite1}.`, "",
].join("\n");
const FORBIDDEN = /<script|<iframe|\bon[a-z]+\s*=|javascript:|vbscript:|data:text\/html|\{=html\}|COMMENT-LEAK/i;

Deno.test("ADV-1c: raw HTML, comments and script/data links never reach the MD, the DOCX XML or the PDF (text layer and bytes)", async () => {
  const mdOut = text((await render(input(RAW_PROBE, "md"))).bytes);
  assert(!FORBIDDEN.test(mdOut), `MD carries ${FORBIDDEN.exec(mdOut)?.[0]}:\n${mdOut}`);
  assertEquals(await rawNodesIn(mdOut), [], "a pandoc reader (raw HTML on) finds no raw node in the MD export");
  for (const keep of ["Before", "bold", "div body", "a link", "anchor", "ref link", "entity", "spaced", "data", "vb"]) assert(mdOut.includes(keep), `MD keeps the text '${keep}'`);
  const docx = (await render(input(RAW_PROBE, "docx"))).bytes;
  const xml = await docxXml(docx);
  assert(!FORBIDDEN.test(xml), `DOCX XML carries ${FORBIDDEN.exec(xml)?.[0]}`);
  const pdf = (await render(input(RAW_PROBE, "pdf"))).bytes;
  const pt = await pdfText(pdf);
  assert(!FORBIDDEN.test(pt), `PDF text carries ${FORBIDDEN.exec(pt)?.[0]}`);
  assert(!/javascript|vbscript|data:text/i.test(new TextDecoder("latin1").decode(pdf)), "no script URI in the PDF's objects (link annotations)");
  const txt = text((await render(input(RAW_PROBE, "txt"))).bytes);
  assert(!FORBIDDEN.test(txt), `TXT carries ${FORBIDDEN.exec(txt)?.[0]}`);
});

Deno.test("ADV-1c: raw-attribute blocks ({=html} {=typst} {=openxml} {=markdown}) are inert text, never passed through to a writer", async () => {
  const md = [
    "# Raw attribute", "", "Inline `<script>x</script>`{=html} and `#pagebreak()`{=typst}.", "",
    "```{=html}", '<script>alert("RAW-ATTR")</script>', "```", "",
    "```{=typst}", "#set page(width: 2cm)", "```", "",
    "```{=openxml}", "<w:p><w:r><w:t>OPENXML-INJECT</w:t></w:r></w:p>", "```", "",
    "```{=markdown}", '<script>alert("RAW-MD")</script>', "```", "",
    `Cite ${cite1}.`, "",
  ].join("\n");
  const mdOut = text((await render(input(md, "md"))).bytes);
  assertEquals(await rawNodesIn(mdOut), [], `a pandoc reader finds no raw node in the MD export:\n${mdOut}`);
  assert(!/^\s*`{3,}\s*\{=|`[^`\n]*`\{=/m.test(mdOut), `MD writes no raw-attribute syntax:\n${mdOut}`);
  assert(!/^<script/m.test(mdOut), "no raw <script> line in the MD (what is left of it is inside code)");
  const pdf = (await render(input(md, "pdf"))).bytes;
  assertEquals((await pdfPageSize(pdf))?.width, 595.276, "A4: the raw Typst did not run");
  const xml = await docxXml((await render(input(md, "docx"))).bytes);
  assert(!xml.includes("<w:t>OPENXML-INJECT</w:t>"), "the raw OpenXML was not injected into the document");
});

// ── ADV-4b: the CSL style, hashed at use ─────────────────────────────────────────────────────
Deno.test("ADV-4b: a one-byte-modified style, a row whose file is missing, and a file outside the style directory are refused at USE time", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ob-csl-" });
  try {
    const ieee = await Deno.readTextFile(`${CSL_DIR}/ieee.csl`);
    await Deno.writeTextFile(`${dir}/ieee.csl`, ieee.replace("<title>IEEE", "<title>JEEE"));
    const md = `# S\n\nCite ${cite1}.\n`;
    const e1 = await assertRejects(() => render(input(md, "txt", { cslDir: dir })), Error);
    assertMatch(e1.message, /citation style 'ieee'.*integrity/, e1.message);
    const rowOnly = { ...style("ieee"), key: "row-only", file: "row-only.csl" };
    const e2 = await assertRejects(() => render(input(md, "txt", { style: rowOnly })), Error);
    assertMatch(e2.message, /citation style 'row-only'.*integrity/, e2.message);
    const escape = { ...style("ieee"), key: "escape", file: "../csl/ieee.csl" };
    const e3 = await assertRejects(() => render(input(md, "txt", { style: escape })), Error);
    assertMatch(e3.message, /citation style 'escape'.*integrity/, e3.message);
    const noHash = { ...style("ieee"), key: "nohash", sha256: "" };
    await assertRejects(() => render(input(md, "txt", { style: noHash })), Error, "integrity");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── ADV-5: glyph coverage ────────────────────────────────────────────────────────────────────
Deno.test("ADV-5: a character no installed face covers is refused before Typst runs, naming it; emoji render with the emoji face", async () => {
  const lost = "Linear A \u{10600}\u{10601} and a private-use \u{E000}";
  const e = await assertRejects(() => render(input(`# G\n\n${lost} ${cite1}.\n`, "pdf")), Error);
  assertMatch(e.message, /no installed font covers/, e.message);
  assertMatch(e.message, /U\+10600/);
  assertMatch(e.message, /U\+E000/);
  // the same text exports to formats that do not typeset glyphs (the reader's fonts render them)
  await render(input(`# G\n\n${lost} ${cite1}.\n`, "md"));
  // the runner's mixed-script note: emoji, CJK, Hebrew and Arabic (Typst's own embedded DejaVu Sans
  // Mono covers Hebrew; the scan sees the same coverage only because fonts-dejavu-core is installed)
  const emoji = (await render(input(`# E\n\nEmoji 😀 and 🎉 with CJK 中文, Hebrew שלום and Arabic سلام ${cite1}.\n`, "pdf"))).bytes;
  const fonts = await pdfFonts(emoji);
  assert(fonts.some((f) => /Emoji/i.test(f)), `an emoji face is embedded: ${fonts.join(", ")}`);
});
