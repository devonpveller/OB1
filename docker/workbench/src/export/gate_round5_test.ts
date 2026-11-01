// deno test --allow-all src/export/gate_round5_test.ts - rw-p6b-gate round 5 (operator 2026-10-31, "simpler check +
// advisory"; tester t-p6b-gate4 D15-D18). A reference entry is compared as a SKELETON (letters and digits,
// NFKC, case-folded) with the entry citeproc renders for it - equal for LTR text, an equal character multiset
// when it holds Hebrew/Arabic - and a mismatch is ADVISORY: a warning on the run, the PDF still served. The
// "real" cases render through pandoc + Typst and run the gate's Python (the image's test stage).
import { assertEquals } from "jsr:@std/assert@1";
import { frontmatterOf, type GateInput, runGate } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import { GATE_SECTION_ROWS, gatedEntries, R5_FA_ZWNJ, R5_INVISIBLE, R5_REAL36, sectionsOf } from "./gate_fixtures.ts";
import { type FormatDef, type RefItem, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { printedTitle } from "./csl.ts";
import { bibliographyEntries } from "./biborder.ts";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver } from "./resolver.ts";
import type { ExportRunInput, RunStore } from "./runs.ts";
import type { ExportRef } from "./repo.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = { key: "pdf", ...gatedEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const id = (n: number) => `f6b50000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const webRefs = (titles: string[], base = 500): RefItem[] => titles.map((t, i) => ({
  key: `src-${id(base + i)}`, number: i + 1,
  csl: { type: "webpage", title: t, URL: `https://example.org/p6b/r5-${base + i}`, accessed: { "date-parts": [[2026, 10, 31]] } } as never,
}));
const docOf = (refs: RefItem[]) => `# Findings\n\n${refs.map((r, i) => `Finding ${i + 1} is supported [[source/${r.key.slice(4)}|r${i + 1}]].`).join(" ")}\n`;
type Want = { number: number; title: string; entry?: string };
// the export's own path: the file rendered from `refs`, the expected entries from citeproc for the same items
async function gate(refs: RefItem[], s: string, mutate?: (e: Want[]) => Want[]) {
  const st = style(s);
  const pdf = (await render({ md: docOf(refs), refs, format: fmt, style: st, cslDir: CSL_DIR })).bytes;
  let want: Want[] = (await bibliographyEntries(refs, st, CSL_DIR)).map(({ item, text }) => ({ number: item.number, title: printedTitle(item.csl), entry: text }));
  if (mutate) want = mutate(want);
  const g = await runGate({ vision: OFF }, {
    pdf, format: fmt, numeric: st.citation_format === "numeric", frontmatter: frontmatterOf(""), required: sectionsOf(GATE_SECTION_ROWS), refs: want,
  } as GateInput);
  const parity = g.warnings.filter((w) => w.code === "reference-mismatch");
  return { status: g.status, blocking: g.blocking_findings.map((f) => f.code), parity, g };
}

Deno.test("D15 (real): the tester's 24 realistic titles (compound hyphens at line breaks) and all 36 export with no parity warning (APA, IEEE, Vancouver)", async () => {
  for (const [name, titles] of [["real24", R5_REAL36.slice(12)], ["real36", R5_REAL36]] as const) {
    for (const s of ["apa", "ieee", "elsevier-vancouver"]) {
      const r = await gate(webRefs([...titles]), s);
      assertEquals([name, s, r.status, r.blocking, r.parity.length], [name, s, "passed", [], 0], JSON.stringify(r.parity.slice(0, 2)));
    }
  }
});

Deno.test("D16/D17 (real): Persian ZWNJ titles and titles with soft hyphens, ZWSP, WJ, NBSP, ZWJ export with no parity warning", async () => {
  const titles = [...R5_FA_ZWNJ, ...Object.values(R5_INVISIBLE)];
  for (const t of titles) {
    for (const s of ["ieee", "apa"]) {
      const r = await gate(webRefs([t, "Gate fixture page one on layout checks"]), s);
      assertEquals([t, s, r.status, r.parity.length], [t, s, "passed", 0], JSON.stringify(r.parity));
    }
  }
});

Deno.test("round 5 (real): a real reference-list mismatch is a WARNING on a served export, never a block; layout still blocks", async () => {
  const refs = webRefs(R5_REAL36.slice(0, 4));
  const wrong = await gate(refs, "ieee", (w) => w.map((x, i) => (i === 1 ? { ...x, entry: (x.entry ?? "").replace(/air pollution/i, "noise") } : x)));
  assertEquals([wrong.status, wrong.blocking], ["passed", []]);
  assertEquals(wrong.parity.length, 1, "the mismatch is recorded");
  const extra = await gate(refs, "apa", (w) => w.slice(1));
  assertEquals([extra.status, extra.parity.length > 0], ["passed", true], "a missing/extra entry: advisory too");
});

Deno.test("round 5 (route): the export of a mismatched list is served 200, says so in a header, and the run records the warning", async () => {
  const recorded: ExportRunInput[] = [];
  const runs: RunStore = {
    record: (r) => (recorded.push(r), Promise.resolve("00000000-0000-4000-8000-000000000001")),
    list: () => Promise.resolve([]), get: () => Promise.resolve(null), file: () => Promise.resolve(null),
  };
  const deps: ExporterDeps = {
    reg: { entries: (r: string) => Promise.resolve(gatedEntries(r)) },
    resolver: createResolver({ openalexKey: "", mailto: "", proxyUrl: "", openalexBase: "http://a.stub", crossrefBase: "http://c.stub", timeoutMs: 1000 },
      { fetch: () => Promise.reject(new Error("no request")), buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel) => Promise.resolve(rel === "notes/g/n.md" ? "# N\n\nBody.\n" : null),
    loadRefs: () => Promise.resolve([] as ExportRef[]),
    cache: () => Promise.resolve(),
    render: (() => Promise.resolve({ bytes: new TextEncoder().encode("%PDF-1.7 fake"), args: [], stderr: "" })) as never,
    gated: {
      gate: () => Promise.resolve({ status: "passed", blocking_findings: [], warnings: [{ code: "reference-mismatch", detail: "entry [1] differs", stage: "references" }], checks: {} }),
      runs, whoOf: () => Promise.resolve({ sub: "user-a", actor: "user-a" }),
    },
    log: () => {},
  };
  const r = await createExporter(deps).request("/?path=notes/g/n.md&format=pdf");
  assertEquals([r.status, r.headers.get("x-export-gate"), r.headers.get("x-export-reference-parity")], [200, "passed", "mismatch"]);
  assertEquals([recorded[0].status, recorded[0].warnings.map((w) => w.code), recorded[0].file !== null], ["passed", ["reference-mismatch"], true]);
});
