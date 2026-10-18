// deno test src/export/parity_fixture.ts - the WeasyPrint parity fixture (research-workbench P6a
// acceptance 6). Runs ONLY in the image's parity stage (`docker build --target parity`), where
// WeasyPrint is installed; the runtime image has no WeasyPrint.
//
// The same document - headings, paragraphs, a list, twelve numbered references, no math - goes
// through the Typst path (the PDF format entry, as the export renders it) and through the retired
// WeasyPrint path (pandoc --pdf-engine=weasyprint, given the same page by CSS). The checked
// properties - page count, text content, reference numbering, heading order - must match. With
// PARITY_OUT set, the two PDFs and the properties are written there for the evidence.
import { assert } from "jsr:@std/assert@1";
import { type FormatDef, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { compareParity, parityProperties, weasyprintFallbackCss, weasyprintFormat } from "./parity.ts";
import { PARITY_HEADINGS, parityDocument } from "./test_fixtures.ts";

Deno.test("acceptance 6: the parity fixture renders the same through Typst and the WeasyPrint fallback", async () => {
  const pdf = { key: "pdf", ...fxEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
  const style = { key: "ieee", ...fxEntries("citation_styles").find((e) => e.key === "ieee")!.definition } as StyleDef;
  const cslDir = new URL("../../csl", import.meta.url).pathname;
  const { md, refs } = parityDocument();
  const dir = await Deno.makeTempDir({ prefix: "ob-parity-" });
  try {
    await Deno.writeTextFile(`${dir}/fallback.css`, weasyprintFallbackCss(pdf));
    const typst = (await render({ md, refs, format: pdf, style, cslDir })).bytes;
    // verify: false - WeasyPrint is the RETIRED engine (parity stage only); the output verification
    // and its writer allow-list cover what the export ships (Typst)
    const weasy = (await render({ md, refs, format: weasyprintFormat(pdf, `${dir}/fallback.css`), style, cslDir, verify: false })).bytes;
    const [a, b] = [await parityProperties(typst, PARITY_HEADINGS), await parityProperties(weasy, PARITY_HEADINGS)];
    const verdict = compareParity(a, b, PARITY_HEADINGS);
    const summary = {
      verdict: verdict.ok ? "PASS" : "FAIL", diffs: verdict.diffs,
      typst: { pages: a.pages, text_chars: a.text.length, numbering: a.numbering, headings: a.headings },
      weasyprint: { pages: b.pages, text_chars: b.text.length, numbering: b.numbering, headings: b.headings },
    };
    console.log(JSON.stringify(summary, null, 1));
    const out = Deno.env.get("PARITY_OUT");
    if (out) {
      await Deno.writeFile(`${out}/parity-typst.pdf`, typst);
      await Deno.writeFile(`${out}/parity-weasyprint.pdf`, weasy);
      await Deno.writeTextFile(`${out}/parity-result.json`, JSON.stringify(summary, null, 2));
    }
    assert(verdict.ok, verdict.diffs.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("acceptance 6 RED: the checker catches a real difference - the pre-P6a WeasyPrint call (no page geometry) and a dropped reference", async () => {
  const pdf = { key: "pdf", ...fxEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
  const style = { key: "ieee", ...fxEntries("citation_styles").find((e) => e.key === "ieee")!.definition } as StyleDef;
  const cslDir = new URL("../../csl", import.meta.url).pathname;
  const { md, refs } = parityDocument();
  const typst = await parityProperties((await render({ md, refs, format: pdf, style, cslDir })).bytes, PARITY_HEADINGS);
  // the deployed path before P6a: pandoc --pdf-engine=weasyprint with pandoc's default HTML page
  const legacy = { ...pdf, key: "pdf-legacy", engine: "weasyprint", metadata: {} };
  const old = await parityProperties((await render({ md, refs, format: legacy, style, cslDir, verify: false })).bytes, PARITY_HEADINGS);
  const v1 = compareParity(typst, old, PARITY_HEADINGS);
  console.log(`RED legacy WeasyPrint call: ${v1.ok ? "PASS (unexpected)" : "FAIL"}: ${v1.diffs.join(" / ").slice(0, 300)}`);
  assert(!v1.ok, "the pre-P6a WeasyPrint call must not pass the parity check");
  const fewer = { ...typst, numbering: typst.numbering.filter((n) => n !== "7") };
  const v2 = compareParity(typst, fewer, PARITY_HEADINGS);
  assert(!v2.ok && v2.diffs.some((d) => d.startsWith("reference numbering")), "a dropped reference must fail the numbering check");
});
