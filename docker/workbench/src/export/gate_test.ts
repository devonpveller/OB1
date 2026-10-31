// deno test --allow-all src/export/gate_test.ts - the export verification gate (research-workbench P6b,
// rw-p6b-gate). The pure parts (reference parity, required sections, the vision pass's routing and
// schema) run anywhere; the "real" cases render through pandoc + Typst and run pdftoppm and the
// gate's Python (pikepdf + pdfplumber) - the image's test stage, where the build gate runs this file.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { frontmatterOf, frontmatterValues, type GateInput, lengthPt, PDFTOPPM, referenceParity, requiredSections, runGate, type Runner, runProgram, textArea } from "./gate.ts";
import { MAX_IMAGES_PER_CALL, parseVisionAnswer, type VisionConfig, visionConfigFromEnv, visionPass, visionRequest } from "./vision.ts";
import { CLEAN_TABLE_MD, CLIPPED_TABLE_MD, GATE_SECTION_ROWS, gatedEntries, reportMd, sectionsOf } from "./gate_fixtures.ts";
import { type FormatDef, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { fixtureRefs, numberedDocument } from "./test_fixtures.ts";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver } from "./resolver.ts";
import type { ExportRunInput, RunStore } from "./runs.ts";
import type { ExportRef } from "./repo.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = (k: string) => ({ key: k, ...gatedEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const SECTIONS = sectionsOf(GATE_SECTION_ROWS);
const pdfOf = async (md: string, refs = fixtureRefs(0), s = "ieee") =>
  (await render({ md, refs, format: fmt("pdf"), style: style(s), cslDir: CSL_DIR })).bytes;
const input = (pdf: Uint8Array, o: Partial<GateInput> = {}): GateInput =>
  ({ pdf, format: fmt("pdf"), refs: [], numeric: true, frontmatter: "", required: SECTIONS, ...o });
const codes = (fs: { code: string }[]) => [...new Set(fs.map((f) => f.code))].sort();

// ── pure ──────────────────────────────────────────────────────────────────────────────────────────

Deno.test("reference parity: one-to-one in number order passes; a missing, extra, reordered or renamed entry is reference-mismatch", () => {
  const texts = ["Body [1] and [2].\n1", "References\n[1] A. Author, “Alpha study of signals,” J. Fix., 2020.\n[2] B. Author, “Beta re-\nview,” 2021.\n2"];
  const refs = [{ number: 1, title: "Alpha study of signals" }, { number: 2, title: "Beta review" }];
  assertEquals(referenceParity(texts, refs, true), [], "the hyphenated line break is not a difference");
  assertEquals(codes(referenceParity(texts, refs.slice(0, 1), true)), ["reference-mismatch"], "an entry the document does not hold");
  assertEquals(codes(referenceParity(texts, [...refs, { number: 3, title: "Gamma" }], true)), ["reference-mismatch"], "a reference missing from the file");
  assertEquals(codes(referenceParity(texts, [refs[0], { number: 2, title: "Beta reviews of everything" }], true)), ["reference-mismatch"], "a different title");
  assertEquals(codes(referenceParity(texts, [{ number: 1, title: "Beta review" }, { number: 2, title: "Alpha study of signals" }], true)), ["reference-mismatch"], "the same titles in another order");
  assertEquals(codes(referenceParity(["no list here"], refs, true)), ["reference-mismatch"], "no reference list at all");
  assertEquals(referenceParity(["Body only."], [], true), [], "no references, none listed");
  // author-date: titles each exactly once; "number 1" is not found inside "number 10"
  const apa = ["References\nAuthor1, A. (2020). Fixture paper number 10. J.\nAuthor2, A. (2020). Fixture paper number 2. J."];
  assertEquals(referenceParity(apa, [{ number: 1, title: "Fixture paper number 10" }, { number: 2, title: "Fixture paper number 2" }], false), []);
  assertEquals(codes(referenceParity(apa, [{ number: 1, title: "Fixture paper number 1" }, { number: 2, title: "Fixture paper number 2" }, { number: 3, title: "Fixture paper number 10" }], false)), ["reference-mismatch"]);
  // with the line layout: entries by hanging indent, counted
  const lines = [{ text: "References", x0: 71 }, { text: "Author1, A. (2020). Fixture paper number 10.", x0: 71 }, { text: "Journal of Fixtures.", x0: 85 },
    { text: "Author2, A. (2020). Fixture paper number 2.", x0: 71 }, { text: "2", x0: 290 }];
  const two = [{ number: 1, title: "Fixture paper number 10" }, { number: 2, title: "Fixture paper number 2" }];
  assertEquals(referenceParity(apa, two, false, lines), []);
  assertEquals(codes(referenceParity(apa, two.slice(0, 1), false, lines)), ["reference-mismatch"], "an extra entry");
  assertEquals(codes(referenceParity(apa, [{ number: 1, title: "Fixture paper number 1" }, two[1]], false, lines)), ["reference-mismatch"], "number 1 is not number 10");
});

Deno.test("required sections: a research report must carry the roll-up heading and the weights; other pages are not asked", () => {
  const fm = frontmatterOf(reportMd(true));
  assertEquals(frontmatterValues(fm, "content_type"), ["research_synthesis"]);
  const withIt = ["Findings\nReport credibility\nReport credibility 0.72\nClaim kind Weight\nThe claim-kind weights used: empirical 1.0"];
  assertEquals(requiredSections(withIt, SECTIONS, fm, "pdf"), []);
  const without = ["Findings\nNotes\nNothing further."];
  assertEquals(codes(requiredSections(without, SECTIONS, fm, "pdf")), ["required-section-missing"], "a report without the roll-up FAILS");
  assertEquals(codes(requiredSections(["Report credibility\n0.72 and nothing else"], SECTIONS, fm, "pdf")), ["required-section-missing"], "the roll-up without its weights (a bare number) FAILS");
  assertEquals(requiredSections(without, SECTIONS, frontmatterOf(reportMd(false, "note")), "pdf"), [], "not a report: no roll-up asked");
  assertEquals(requiredSections(without, SECTIONS, "", "pdf"), [], "no frontmatter: no roll-up asked");
  assertEquals(requiredSections(without, SECTIONS, fm, "docx"), [], "a format the row does not name");
  assertEquals(frontmatterValues("content_type: [a, research_synthesis]", "content_type"), ["a", "research_synthesis"]);
  assertEquals(frontmatterValues("content_type:\n  - research_synthesis\nx: 1", "content_type"), ["research_synthesis"]);
});

Deno.test("the text area comes from the format's margins (Typst lengths in points)", () => {
  assertEquals(Math.round(lengthPt("2.5cm")! * 100) / 100, 70.87);
  assertEquals(lengthPt("1in"), 72);
  assertEquals(lengthPt("bogus"), null);
  const ta = textArea(fmt("pdf").metadata);
  assertEquals([Math.round(ta.left), Math.round(ta.right)], [71, 71]);
});

Deno.test("acceptance 3: the vision pass goes to the LiteLLM alias under the export's own key; a direct or shared-key route is refused before any request", async () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(visionConfigFromEnv(env({})).state, "off", "shipped inert: no key, no model");
  assertEquals(visionConfigFromEnv(env({ EXPORT_VISION_KEY: "sk-x" })).state, "off", "a key without a model");
  const on = visionConfigFromEnv(env({ EXPORT_VISION_KEY: "sk-export", EXPORT_VISION_MODEL: "vision-model" }));
  assertEquals([on.state, on.url], ["on", "http://llama-cpp:8080/v1"], "the default URL is the gateway alias");
  for (const url of ["http://llama-cpp-upstream:8080/v1", "http://10.0.0.5:8080/v1", "http://llm-queue:8080/v1", "http://llama-cpp.evil:8080/v1",
    "http://u:p@llama-cpp:8080/v1", "file:///etc/passwd", "not a url", "http://llama-cpp-embed:8080/v1"]) {
    const c = visionConfigFromEnv(env({ EXPORT_VISION_KEY: "sk-export", EXPORT_VISION_MODEL: "m", EXPORT_VISION_URL: url }));
    assertEquals([c.state, c.code], ["refused", "vision-misrouted"], url);
  }
  for (const other of ["EMBEDDING_API_KEY", "WORKBENCH_KEY", "WORKSPACE_DOOR_KEY", "RESEARCH_SCORER_KEY", "RESEARCH_WORKSPACE_KEY"]) {
    const c = visionConfigFromEnv(env({ EXPORT_VISION_KEY: "sk-shared", EXPORT_VISION_MODEL: "m", [other]: "sk-shared" }));
    assertEquals([c.state, c.code], ["refused", "vision-key-shared"], other);
  }
  // the request: the alias, the export's bearer, at most 20 images a call, a redirect not followed
  const seen: { url: string; auth: string; images: number; redirect: string }[] = [];
  const fake = (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization, images: body.messages[1].content.length - 1, redirect: String(init.redirect) });
    return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ blocking_findings: [], warnings: [{ page: 2, issue: "tight spacing" }] }) } }] }));
  };
  const pages = Array.from({ length: 25 }, (_, i) => ({ page: i + 1, png: new Uint8Array([137, 80, 78, 71, i]) }));
  const r = await visionPass(on, pages, fake);
  assertEquals(seen.map((s) => [s.url, s.auth, s.images, s.redirect]), [
    ["http://llama-cpp:8080/v1/chat/completions", "Bearer sk-export", MAX_IMAGES_PER_CALL, "manual"],
    ["http://llama-cpp:8080/v1/chat/completions", "Bearer sk-export", 5, "manual"],
  ]);
  assertEquals([r.blocking.length, codes(r.warnings)], [0, ["vision-warning"]]);
  // refused / off: no request at all
  seen.length = 0;
  const refused = visionConfigFromEnv(env({ EXPORT_VISION_KEY: "sk-export", EXPORT_VISION_MODEL: "m", EXPORT_VISION_URL: "http://llama-cpp-upstream:8080/v1" }));
  assertEquals(codes((await visionPass(refused, pages, fake)).blocking), ["vision-misrouted"]);
  assertEquals(codes((await visionPass(OFF, pages, fake)).warnings), ["vision-not-configured"]);
  assertEquals(seen.length, 0, "a refused or inert pass sends nothing");
  const req = visionRequest(on, pages.slice(0, 1));
  assertMatch(String(req.init.body), /"response_format":\{"type":"json_schema"/);
});

Deno.test("the vision pass fails closed: a non-200, no answer, or an answer outside the schema blocks", async () => {
  const on: VisionConfig = { state: "on", url: "http://llama-cpp:8080/v1", key: "sk-export", model: "m", timeoutMs: 200 };
  const pages = [{ page: 1, png: new Uint8Array([1]) }];
  const answer = (content: unknown, status = 200) => () => Promise.resolve(Response.json({ choices: [{ message: { content } }] }, { status }));
  assertEquals(codes((await visionPass(on, pages, answer("{}", 503))).blocking), ["vision-unavailable"]);
  assertEquals(codes((await visionPass(on, pages, () => Promise.reject(new TypeError("refused")))).blocking), ["vision-unavailable"]);
  assertEquals(codes((await visionPass(on, pages, (_u, i) => new Promise((_r, j) => i.signal!.addEventListener("abort", () => j(new DOMException("t", "AbortError")))))).blocking), ["vision-unavailable"]);
  for (const bad of ["not json", JSON.stringify({ blocking_findings: [] }), JSON.stringify({ blocking_findings: [], warnings: [], verdict: "pass" }),
    JSON.stringify({ blocking_findings: [{ page: "1", issue: "x" }], warnings: [] }), JSON.stringify({ blocking_findings: [{ page: 1, issue: "" }], warnings: [] }), 42]) {
    assertEquals(codes((await visionPass(on, pages, answer(bad))).blocking), ["vision-unreadable"], String(bad));
  }
  const blocked = await visionPass(on, pages, answer(JSON.stringify({ blocking_findings: [{ page: 1, issue: "the table is cut off at the right edge" }], warnings: [] })));
  assertEquals(blocked.blocking.map((f) => [f.code, f.page, f.detail]), [["vision", 1, "the table is cut off at the right edge"]]);
  assertEquals(parseVisionAnswer({ choices: [{ message: { content: "```json\n{\"blocking_findings\":[],\"warnings\":[]}\n```" } }] }, [1]), { blocking: [], warnings: [] });
});

// ── real programs (the image's test stage) ─────────────────────────────────────────────────────────

Deno.test("acceptance 1 (real): the clipped-table fixture is BLOCKED and the clean fixture PASSES - pdftoppm, pikepdf/pdfplumber, references, sections", async () => {
  const clipped = await runGate({ vision: OFF }, input(await pdfOf(CLIPPED_TABLE_MD)));
  console.log(`clipped: ${clipped.status} ${JSON.stringify(clipped.blocking_findings.map((f) => [f.code, f.page, f.detail]))}`);
  assertEquals(clipped.status, "blocked", "a passed clipped fixture FAILS");
  assert(clipped.blocking_findings.some((f) => f.code === "overflow" && f.page === 1), "the table runs out of the text area");
  const clean = await runGate({ vision: OFF }, input(await pdfOf(CLEAN_TABLE_MD)));
  console.log(`clean: ${clean.status} ${JSON.stringify(clean.blocking_findings)} warnings ${JSON.stringify(codes(clean.warnings))}`);
  assertEquals(clean.status, "passed", "a blocked clean fixture FAILS");
  assertEquals(codes(clean.warnings), ["vision-not-configured"]);
  assertEquals((clean.checks.rasterise as { pages: number }).pages, 1, "pdftoppm rendered the page");
  const tools = (clean.checks.structure as { tools: Record<string, string> }).tools;
  assertEquals([tools.pikepdf, tools.pdfplumber], ["10.17.0", "0.11.10"], "the pinned pikepdf and pdfplumber ran");
});

Deno.test("acceptance 2 (real): the PDF's reference list matches the numbered references one-to-one; a dropped, extra or renamed one blocks", async () => {
  const { md, refs } = numberedDocument(12);
  const pdf = await pdfOf(md, refs);
  const want = refs.map((r) => ({ number: r.number, title: String(r.csl.title) }));
  assertEquals((await runGate({ vision: OFF }, input(pdf, { refs: want }))).blocking_findings, []);
  for (const [why, wrong] of [
    ["one fewer", want.slice(0, 11)], ["one more", [...want, { number: 13, title: "Fixture paper number 13" }]],
    ["renamed", want.map((r) => r.number === 5 ? { ...r, title: "Some other paper entirely" } : r)],
  ] as const) {
    const g = await runGate({ vision: OFF }, input(pdf, { refs: [...wrong] }));
    assertEquals([g.status, codes(g.blocking_findings)], ["blocked", ["reference-mismatch"]], why);
  }
  // author-date (APA): the titles, each exactly once
  const apa = await pdfOf(md, refs, "apa");
  assertEquals((await runGate({ vision: OFF }, input(apa, { refs: want, numeric: false }))).blocking_findings, []);
  assertEquals(codes((await runGate({ vision: OFF }, input(apa, { refs: want.slice(1), numeric: false }))).blocking_findings), ["reference-mismatch"], "author-date: an extra entry (the entries are counted by the hanging indent)");
  assertEquals(codes((await runGate({ vision: OFF }, input(apa, { refs: [...want, { number: 13, title: "Fixture paper number 13" }], numeric: false }))).blocking_findings), ["reference-mismatch"], "author-date: a missing one");
});

Deno.test("acceptance 5 (real): a research report's export without the roll-up section is BLOCKED; with it, it passes", async () => {
  const on = await runGate({ vision: OFF }, input(await pdfOf(reportMd(true)), { frontmatter: frontmatterOf(reportMd(true)) }));
  assertEquals([on.status, on.blocking_findings], ["passed", []]);
  assertEquals(on.checks.sections, ["credibility-rollup"]);
  const off = await runGate({ vision: OFF }, input(await pdfOf(reportMd(false)), { frontmatter: frontmatterOf(reportMd(false)) }));
  assertEquals([off.status, codes(off.blocking_findings)], ["blocked", ["required-section-missing"]]);
});

Deno.test("acceptance 4 (real): pdftoppm runs as a separate program over files; nothing links or imports poppler", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const spy: Runner = (cmd, args, t) => (calls.push({ cmd, args }), runProgram(cmd, args, t));
  await runGate({ vision: OFF, run: spy }, input(await pdfOf(CLEAN_TABLE_MD)));
  assertEquals(calls[0].cmd, PDFTOPPM, "the rasteriser is the pdftoppm program");
  assert(calls[0].args.some((a) => a.endsWith("/export.pdf")) && calls[0].args.includes("-png"), "over a file, out to files");
  assert(calls[1].cmd.endsWith("/python") && calls[1].args[0] === "-I", "the structure checks are their own isolated Python process");
  // no poppler binding anywhere: the workbench source, the gate's Python, the gate's environment
  const root = new URL("../../", import.meta.url).pathname;
  const banned = /\b(?:pdf2image|python-poppler|popplerqt|poppler(?:_|-)?(?:cpp|glib)|libpoppler|Deno\.dlopen|ctypes|cffi\.FFI)\b|from\s+poppler|import\s+poppler/;
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) walk(p);
      else if (/\.(ts|py)$/.test(e.name) && !e.name.endsWith("_test.ts")) {
        if (banned.test(Deno.readTextFileSync(p))) hits.push(p);
      }
    }
  };
  walk(`${root}src`);
  walk(`${root}gate`);
  assertEquals(hits, [], "a poppler binding, a dlopen or an FFI in the workbench source or the gate's Python");
  const env = "/opt/export-gate";
  const found = (await new Deno.Command("find", { args: [env, "-iname", "*poppler*"], stdout: "piped" }).output());
  assertEquals(new TextDecoder().decode(found.stdout).trim(), "", "no poppler library or package in the gate's Python environment");
});

// ── the route (exporter.ts) with a fake gate and run store ───────────────────────────────────────────

function routeWorld(gateImpl?: (i: GateInput) => Promise<import("./gate.ts").GateResult>) {
  const recorded: ExportRunInput[] = [];
  const gateCalls: GateInput[] = [];
  const renders: unknown[] = [];
  const runs: RunStore = {
    record: (r) => (recorded.push(r), Promise.resolve(`00000000-0000-4000-8000-00000000000${recorded.length}`)),
    list: () => Promise.resolve([]), get: () => Promise.resolve(null), file: () => Promise.resolve(null),
  };
  const PDF = new TextEncoder().encode("%PDF-1.7 fake");
  const deps = (o: Partial<ExporterDeps> = {}): ExporterDeps => ({
    reg: { entries: (r: string) => Promise.resolve(gatedEntries(r)) },
    resolver: createResolver({ openalexKey: "", mailto: "", proxyUrl: "", openalexBase: "http://a.stub", crossrefBase: "http://c.stub", timeoutMs: 1000 },
      { fetch: () => Promise.reject(new Error("no request")), buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel) => Promise.resolve(rel === "notes/g/report.md" ? reportMd(true) : null),
    loadRefs: () => Promise.resolve([] as ExportRef[]),
    cache: () => Promise.resolve(),
    render: ((i: unknown) => (renders.push(i), Promise.resolve({ bytes: PDF, args: [], stderr: "" }))) as never,
    gated: {
      gate: (i) => (gateCalls.push(i), gateImpl ? gateImpl(i) : Promise.resolve({ status: "passed", blocking_findings: [], warnings: [], checks: {} })),
      runs, whoOf: () => Promise.resolve({ sub: "user-a", actor: "user-a" }),
    },
    log: () => {},
    ...o,
  });
  return { recorded, gateCalls, renders, deps, PDF };
}

Deno.test("the route: a passed PDF is served with its run id, recorded for the caller's subject with its file", async () => {
  const w = routeWorld();
  const r = await createExporter(w.deps()).request("/?path=notes/g/report.md&format=pdf");
  assertEquals(r.status, 200);
  assertEquals([r.headers.get("x-export-gate"), r.headers.get("x-export-id")], ["passed", "00000000-0000-4000-8000-000000000001"]);
  assertEquals(new Uint8Array(await r.arrayBuffer()), w.PDF);
  assertEquals(w.recorded.map((x) => [x.owner_sub, x.path, x.format, x.status, x.file?.byteLength]), [["user-a", "notes/g/report.md", "pdf", "passed", w.PDF.byteLength]]);
  assertEquals(w.gateCalls[0].frontmatter.includes("content_type: research_synthesis"), true, "the page's frontmatter reaches the gate");
  assertEquals(w.gateCalls[0].required.map((s) => s.key), ["credibility-rollup"], "the required sections come from the registry");
  // a format without the gate flag never meets the gate
  assertEquals((await createExporter(w.deps()).request("/?path=notes/g/report.md&format=md")).status, 200);
  assertEquals(w.gateCalls.length, 1);
});

Deno.test("the route: a blocked PDF is NEVER served - 422 layout-gate with the findings; the run is recorded without a file", async () => {
  const w = routeWorld(() => Promise.resolve({ status: "blocked", blocking_findings: [{ code: "overflow", page: 1, detail: "x" }], warnings: [], checks: {} }));
  const r = await createExporter(w.deps()).request("/?path=notes/g/report.md&format=pdf");
  assertEquals(r.status, 422);
  const b = await r.json();
  assertEquals([b.code, b.export_id, b.blocking_findings[0].code], ["layout-gate", "00000000-0000-4000-8000-000000000001", "overflow"]);
  assertEquals([w.recorded[0].status, w.recorded[0].file], ["blocked", null]);
});

Deno.test("the route fails closed: a gated format with no gate wired is 503 and nothing renders; a gate that throws blocks", async () => {
  const w = routeWorld(() => Promise.reject(new Error("boom")));
  const none = await createExporter(w.deps({ gated: undefined })).request("/?path=notes/g/report.md&format=pdf");
  assertEquals([none.status, (await none.json()).code, w.renders.length], [503, "gate", 0]);
  const r = await createExporter(w.deps()).request("/?path=notes/g/report.md&format=pdf");
  assertEquals([r.status, (await r.json()).blocking_findings[0].code], [422, "gate-error"]);
  assertEquals(w.recorded[0].status, "blocked");
});

Deno.test("init-export-gate.sql seeds exactly the fixture rows the gate tests use (when the migration is reachable)", async () => {
  let sql: string;
  try {
    sql = await Deno.readTextFile(new URL("../../../init-export-gate.sql", import.meta.url));
  } catch {
    return; // inside the image: the migration is outside the build context
  }
  const m = /\('export_required_sections', 'credibility-rollup', '([^']+)',\s*'(\{[^']+\})'\)/.exec(sql);
  assert(m, "the roll-up row");
  assertEquals([m[1], JSON.parse(m[2])], [GATE_SECTION_ROWS[0].label, GATE_SECTION_ROWS[0].definition]);
  assertMatch(sql, /SET definition = definition \|\| '\{"gate":true\}'::jsonb\s+WHERE registry = 'export_formats' AND key = 'pdf'/);
});

Deno.test("author-date entries: split by the paragraph gap, a page break continuing an entry when the last line ran full", async () => {
  const { splitEntries } = await import("./gate.ts");
  const L = (page: number, top: number, text: string, x1 = 500) => ({ page, top, bottom: top + 11, x0: 70.9, x1, text });
  // Typst: no hanging indent; 4 pt between an entry's lines, 10 pt between entries
  const lines = [L(1, 100, "Author1, A. (2020). Fixture paper number 1. Journal of Fixtures, 1, 1-"), L(1, 115, "org/10.5555/p6a.001", 160),
    L(1, 136, "Author2, A. (2020). Fixture paper number 2. Journal"), L(2, 70, "of Fixtures, 2.", 150), L(2, 91, "Author3, A. (2020). Fixture paper number 3.", 300)];
  assertEquals(splitEntries(lines).length, 3, "a full last line on page 1 continues on page 2");
  const shortEnd = lines.map((l, i) => i === 2 ? { ...l, x1: 300 } : l);
  assertEquals(splitEntries(shortEnd).length, 4, "a short last line ends the entry before the page break");
});
