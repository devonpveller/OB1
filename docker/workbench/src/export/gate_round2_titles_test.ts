// deno test --allow-all src/export/gate_round2_titles_test.ts - rw-p6b-gate round 2, tester D3: the reference
// panel titles a reference with the string the exported file prints (exporter.ts listedTitle, csl.ts
// printedTitle). Pure. (Its own file: at a49bdf1 the functions do not exist, so this file is the RED.)
import { assertEquals } from "jsr:@std/assert@1";
import { printedTitle } from "./csl.ts";
import { kindsOf, listedTitle } from "./exporter.ts";
import type { ExportRef } from "./repo.ts";
import { fxEntries } from "./registry_fixtures.ts";

Deno.test("D3: the panel's title is the string the file prints - blank title -> URL, citeproc markup dropped, a cached resolution for another identifier ignored", () => {
  const kinds = kindsOf(fxEntries("reference_identifier_kinds"));
  const ref = (o: Partial<ExportRef>): ExportRef => ({
    number: 1, cited_ref: "f6b00000-0000-4000-8000-000000000009", reference_id: "r", pinned_revision: 1, source_id: "f6b00000-0000-4000-8000-000000000009",
    suppressed: false, title: "T", url: "https://example.org/p6b/x", metadata: {}, accessed: "2026-10-01", cached: [], ...o,
  });
  assertEquals(listedTitle(ref({ title: "" }), kinds), "https://example.org/p6b/x");
  assertEquals(listedTitle(ref({ title: "Gate *six* <b>bold</b> &amp; co" }), kinds), "Gate *six* bold &amp; co");
  assertEquals(listedTitle(ref({
    title: "Record title",
    cached: [{ identifier: "doi:10.9999/p6b-probe", csl: { type: "article-journal", title: "A resolved title the export never prints" } as never, via: "crossref" }],
  }), kinds), "Record title");
  const doi = ref({
    title: "Record", url: "https://doi.org/10.5555/p6a.001",
    cached: [{ identifier: "doi:10.5555/p6a.001", csl: { type: "article-journal", title: "Resolved <i>title</i> <script>x</script>" } as never, via: "openalex" }],
  });
  assertEquals(listedTitle(doi, kinds), "Resolved title x");
  assertEquals(printedTitle({ title: "a <sc>b</sc> <span class=\"nocase\">c</span>" }), "a b c");
});

