// deno test --allow-all src/export/render_test.ts - the P6a export through the REAL programs:
// pandoc 3.11 --citeproc with the shipped CSL styles, Typst 0.15.1 for PDF, and poppler
// (pdftotext / pdffonts / pdftoppm, separate processes) to read the output back. Needs the image's
// test stage (pandoc, typst, fonts-noto-cjk, poppler-utils); it runs in the build gate.
import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { type FormatDef, render, RenderFailed, type RenderInput, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { cjkGlyphCheck, pdfFonts, pdfText } from "./pdf_tools.ts";
import { CJK_TEXT, cjkDocument, fixtureId, numberedDocument } from "./test_fixtures.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const input = (md: string, refs: RenderInput["refs"], f: string, s = "ieee", extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs, format: fmt(f), style: style(s), cslDir: CSL_DIR, wrapNone: true, ...extra });
const text = (b: Uint8Array) => new TextDecoder().decode(b);

// The numbered references of a rendered text: the inline markers and the list's labels, in order.
function numbering(raw: string) {
  const t = raw.replace(/\\([[\]])/g, "$1"); // markdown output escapes brackets
  const at = t.lastIndexOf("References");
  const [body, list] = [t.slice(0, at), t.slice(at)];
  return {
    inline: [...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
    listed: [...list.matchAll(/^\s*\\?\[(\d+)\\?\]/gm)].map((m) => Number(m[1])),
  };
}
const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

Deno.test("acceptance 1 (renderer): 100 references, numbered 1..100 in IEEE, in MD, TXT, PDF (Typst) and DOCX; every title listed", async () => {
  const { md, refs } = numberedDocument(100);
  for (const f of ["md", "txt"]) {
    const t = text((await render(input(md, refs, f))).bytes);
    const n = numbering(t);
    assertEquals(n.inline, seq(100), `${f}: inline markers`);
    assertEquals(n.listed, seq(100), `${f}: reference list`);
    for (let i = 1; i <= 100; i++) assert(new RegExp(`Fixture paper number ${i},?["”]`).test(t), `${f}: title ${i}`);
    assert(!/\(src-|\?\)/.test(t), `${f}: a citation rendered as its key`);
  }
  const pdf = await render(input(md, refs, "pdf"));
  const pt = (await pdfText(pdf.bytes, true)).replace(/-\n\s*/g, "");
  const n = numbering(pt.replace(/^\s*\d+\s*$/gm, ""));
  assertEquals(n.inline, seq(100), "pdf: inline markers");
  assertEquals(n.listed, seq(100), "pdf: reference list");
  const docx = await render(input(md, refs, "docx"));
  assertEquals(text(docx.bytes.slice(0, 2)), "PK", "a DOCX is a zip");
  const back = await new Deno.Command("pandoc", { args: ["-f", "docx", "-t", "plain", "--wrap=none"], stdin: "piped", stdout: "piped" }).spawn();
  const w = back.stdin.getWriter();
  await w.write(docx.bytes);
  await w.close();
  const dn = numbering(text((await back.output()).stdout));
  assertEquals([dn.inline, dn.listed], [seq(100), seq(100)], "docx: numbering");
});

Deno.test("a style is chosen from the registry: APA renders author-date, Vancouver numbers, the same references", async () => {
  const { md, refs } = numberedDocument(3);
  const apa = text((await render(input(md, refs, "txt", "apa"))).bytes);
  assertMatch(apa, /\(Author1, 2020\)/);
  assert(!/\[1\]/.test(apa));
  const van = text((await render(input(md, refs, "txt", "elsevier-vancouver"))).bytes);
  assertMatch(van, /\[1\][\s\S]*\[2\][\s\S]*\[3\]/);
  assertMatch(van, /Author1 A\. Fixture paper number 1/);
});

Deno.test("the added (uncited) references keep their numbers after the cited ones (nocite, holder order)", async () => {
  const { refs } = numberedDocument(4);
  const md = `Body cites the second [[source/${fixtureId(2)}|b]] then the first [[source/${fixtureId(1)}|a]].\n`;
  // holder numbering: 2 and 1 renumbered by first appearance is the holder's job; here the holder says 1 = id2, 2 = id1
  const held = [{ ...refs[1], number: 1 }, { ...refs[0], number: 2 }, { ...refs[2], number: 3 }, { ...refs[3], number: 4 }];
  const t = text((await render(input(md, held, "txt"))).bytes);
  assertMatch(t, /second b \[1\] then the first a \[2\]/);
  assertMatch(t, /\[1\][^\n]*number 2[\s\S]*\[2\][^\n]*number 1[\s\S]*\[3\][^\n]*number 3[\s\S]*\[4\][^\n]*number 4/);
});

Deno.test("acceptance 4: the Typst path renders CJK with real glyphs; the same page without a CJK face FAILS the check (RED)", async () => {
  const { md, refs } = cjkDocument();
  const pdf = (await render(input(md, refs, "pdf"))).bytes;
  // The control: the same document with NO CJK face available to Typst (system fonts ignored, the
  // registered main face dropped so Typst falls back to its embedded Latin faces): CJK as tofu.
  const pdfFmt = fmt("pdf");
  const { mainfont: _drop, ...noCjk } = pdfFmt.metadata as Record<string, unknown>;
  const control = { ...input(md, refs, "pdf", "ieee", { engineOpts: ["--ignore-system-fonts"] }), format: { ...pdfFmt, metadata: noCjk } };
  // attempt 3: the glyph check before Typst passes here (the faces ARE installed; Typst is told to
  // ignore them), so it is the OUTPUT verification that refuses the boxes - the RED of the .notdef scan
  const e = await assertRejects(() => render(control), RenderFailed);
  assertEquals([e.code, (e.extra as { format?: string }).format], ["output-verification", "pdf"], e.message);
  assertMatch(e.message, /\.notdef glyph/);
  console.log(`cjk notdef RED: ${e.message}`);
  const tofu = (await render({ ...control, verify: false })).bytes;
  const green = await cjkGlyphCheck(pdf, tofu, CJK_TEXT);
  assert(green.ok, `GREEN failed: ${green.reasons.join("; ")}`);
  assert((await pdfFonts(pdf)).some((f) => /Noto-?Serif-?CJK/i.test(f)), "the registered main face is the one embedded");
  console.log(`cjk: fonts ${green.fonts.join(", ")}; page differs from the tofu control by ${(green.difference * 100).toFixed(2)}%`);
  const red = await cjkGlyphCheck(tofu, tofu, CJK_TEXT);
  assert(!red.ok, "RED: a tofu page must fail the glyph check");
  assert(red.reasons.some((r) => r.includes("no CJK face")) && red.reasons.some((r) => r.includes("indistinguishable")), red.reasons.join("; "));
  console.log(`cjk RED: ${red.reasons.join("; ")}`);
});

Deno.test("a PDF font that is not installed fails the export instead of falling back", async () => {
  const { md, refs } = numberedDocument(1);
  const f = fmt("pdf");
  const bad = { ...f, metadata: { ...f.metadata, mainfont: "No Such Font P6a" } };
  await assertRejects(() => render({ ...input(md, refs, "pdf"), format: bad }), RenderFailed, "a font the format names is not installed");
});

Deno.test("acceptance 5: pandoc runs as its own process, files in and out, and Typst as pandoc's child - never in-process", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ob-shim-" });
  const log = `${dir}/calls.log`;
  try {
    for (const prog of ["pandoc", "typst"]) {
      const real = new TextDecoder().decode((await new Deno.Command("sh", { args: ["-c", `command -v ${prog}`], stdout: "piped" }).output()).stdout).trim();
      await Deno.writeTextFile(`${dir}/${prog}`, `#!/bin/sh\necho "${prog} pid=$$ ppid=$PPID args=$*" >> ${log}\nexec ${real} "$@"\n`);
      await Deno.chmod(`${dir}/${prog}`, 0o755);
    }
    const path = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${path}`);
    try {
      const { md, refs } = numberedDocument(2);
      const out = await render(input(md, refs, "pdf"));
      assertEquals(text(out.bytes.slice(0, 5)), "%PDF-");
      const calls = (await Deno.readTextFile(log)).trim().split("\n");
      console.log(calls.map((c) => c.replace(/args=.*/, (a) => a.slice(0, 160))).join("\n"));
      const p = /^pandoc pid=(\d+) ppid=(\d+) args=(.*)$/.exec(calls.find((c) => c.startsWith("pandoc"))!)!;
      const t = /^typst pid=(\d+) ppid=(\d+) args=(.*)$/.exec(calls.find((c) => c.startsWith("typst"))!)!;
      assert(Number(p[1]) !== Deno.pid && Number(p[2]) === Deno.pid, "pandoc is a child process of the workbench");
      assertEquals(Number(t[2]), Number(p[1]), "Typst is pandoc's child, not the workbench's");
      assertEquals(p[3], out.args.join(" "), "the argument list is the one the renderer built");
      assertMatch(p[3], /--metadata-file \S+\/meta\.json .*--output \S+\/out\.pdf \S+\/in\.md$/);
      assert(!/filter|json\b/.test(p[3].replace(/meta\.json|references\.json/g, "")), "no filter, no JSON AST");
    } finally {
      Deno.env.set("PATH", path);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unresolved citation is fatal with the real pandoc: its warning is caught, the key never reaches the output", async () => {
  const p = new Deno.Command("pandoc", { args: ["--citeproc", "-t", "plain"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode("Text [@nope].\n"));
  await w.close();
  const o = await p.output();
  const { fatalWarnings } = await import("./render.ts");
  assertEquals(fatalWarnings(new TextDecoder().decode(o.stderr)), ["Citeproc: citation nope not found"]);
});

Deno.test("the programs in the image are the versions the notices list (pandoc 3.11, Typst 0.15.1, poppler 25.03.0)", async () => {
  const v = async (cmd: string, args: string[]) => {
    const o = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
    return new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr);
  };
  assertMatch(await v("pandoc", ["--version"]), /^pandoc 3\.11\n/);
  assertMatch(await v("typst", ["--version"]), /^typst 0\.15\.1 /);
  assertMatch(await v("pdftoppm", ["-v"]), /pdftoppm version 25\.03\.0/);
  const notices = await Deno.readTextFile(new URL("../../THIRD-PARTY-NOTICES.md", import.meta.url));
  for (const s of ["| pandoc | 3.11 ", "| Typst | 0.15.1 ", "| poppler-utils (pdftoppm, pdftotext, pdffonts, pdfinfo) | 25.03.0 "]) assert(notices.includes(s), s);
  // the font packages, at the versions the notices list (attempt 2 adds the emoji face)
  const pkgs = await v("dpkg-query", ["-W", "-f", "${Package} ${Version}\\n", "fonts-noto-cjk", "fonts-noto-color-emoji", "fonts-dejavu-core"]);
  for (const [pkg, ver] of pkgs.trim().split("\n").map((l) => l.split(" "))) {
    assert(notices.includes(`(${pkg}) | Debian ${ver} |`), `${pkg} ${ver} is the version the notices list`);
  }
});
