// deno test --allow-all src/export/resolve2_test.ts - rw-p6a-resolve2 (the reviewer r-rw-p6a's B1 and
// B2), through the REAL pandoc 3.11 + Typst 0.15.1 where an output is rendered (the image's test stage).
//   A7-1  the part classifier (verify.ts partClass): the one rule - a raster / PDF image / font program
//         is MEDIA (raw + base64), everything else TEXT (the whole invariant); and on real outputs
//   A7-2  the budget (verify.ts VERIFY_BUDGET, declared values): its own code `verification-budget`
//         for the time and the size budget; credential bodies name the KIND, never a prefix or a length
//   A7-3  the illustrated note - a 1.5 MB PNG (the reviewer's synthetic screenshot) and a 2.5 MB JPEG
//         (seeded noise) in the vault - with the resolver CONFIGURED: 200 in DOCX and PDF at the route,
//         the verification within 10 s and 300 MB (measured in a fresh process); the same note with
//         the key in its text is refused 503 `credential` in every format, the body naming the kind
//   A7-4  more views than the cap, or a part over the budget: 503 `verification-budget` (not
//         `credential`) at the verifier and at the route, the body naming no secret material
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createExporter, type ExporterDeps, guardBody } from "./exporter.ts";
import { createResolver, type ResolverConfig } from "./resolver.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { ExportRef } from "./repo.ts";
import type { CslItem } from "./csl.ts";
import { type FormatDef, render, type RenderInput, type StyleDef } from "./render.ts";
import { fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { canonText, canonTextFull, credentialKind, judgeSecret, MAX_VIEWS, secretForms, secretIn, TooManyViews, UNJUDGED, views } from "./credentials.ts";
import { Budget, OutputRejected, partClass, verifyDocx, verifyPdf, VERIFY_BUDGET, verifyText } from "./verify.ts";
import { PdfDocument, PdfName } from "./pdf_read.ts";
import { zipEntries } from "./zip_read.ts";
import { noiseJpeg, pngWithText, screenshotPng } from "./image_fixtures.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const DENO_JSON = new URL("../../deno.json", import.meta.url).pathname;
// the tester's synthetic pair (test-attempt5-2026-10-19.md); the reviewer measured with it
const KEY = "Vb7KxzNq9M2Lc8Rw4Ts6Hp1Gd5Yf0Ja3";
const MAIL = "t5b.relay-ops@exemplar.invalid";
const SECRETS = secretForms([KEY, MAIL]); // as the resolver hands them to the renderer
// no secret material in a body: neither secret, nor attempt 6's mask (`Vb...32 characters`), nor a length
const namesNoSecret = (body: string) =>
  !body.includes(KEY) && !body.toLowerCase().includes(MAIL.toLowerCase()) && !/\.\.\.\s*\d+ characters/.test(body) &&
  !body.includes(`${KEY.slice(0, 2)}...`) && !body.includes(`${MAIL.slice(0, 2)}...`) && !/\b(32|30) characters\b/.test(body);

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const PNG = await screenshotPng(); // about 1.5 MB
const JPG = noiseJpeg(); // about 2.5 MB
const illustrated = (extra = "") =>
  `# Illustrated\n\nClaim [[source/${fixtureId(1)}|c1]].\n\n![a screenshot](img/shot.png)\n\n![noise](img/noise.jpg)\n${extra}`;
// the reviewer's measured text that is over the views cap (no secret in it)
const OVER_CAP = "Notes: a b ＡＢ <i>x</i> &amp;amp;amp;amp;amp; %2525252541 \\\\* &lt;b&gt;y&lt;/b&gt; QUJDREVGR0hJSktMTU5PUA== <u>z</u> &amp;lt;s&amp;gt;w&amp;lt;/s&amp;gt;";

async function vaultWithImages(): Promise<string> {
  const vault = await Deno.makeTempDir({ prefix: "ob-p6a2-vault-" });
  await Deno.mkdir(`${vault}/notes/t/img`, { recursive: true });
  await Deno.writeFile(`${vault}/notes/t/img/shot.png`, PNG);
  await Deno.writeFile(`${vault}/notes/t/img/noise.jpg`, JPG);
  return vault;
}

// the route with the resolver CONFIGURED (a fake upstream through a fake proxy client; no network)
const CLIENT = { close() {} } as unknown as Deno.HttpClient;
function world(vault: string, note: string, render_?: ExporterDeps["render"]) {
  const cfg: ResolverConfig = {
    openalexKey: KEY, mailto: MAIL, proxyUrl: "http://proxy.invalid:8888",
    openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000,
  };
  const fetch = (url: string) =>
    Promise.resolve(url.includes("openalex")
      ? Response.json({ title: "A clean title", type: "article", doi: "https://doi.org/10.5555/p6a.001", publication_date: "2021-02-01", authorships: [{ author: { display_name: "Ann Author" } }] })
      : Response.json({ status: "error" }, { status: 404 }));
  const cache = new Map<string, { identifier: string; csl: CslItem; via: string }[]>();
  const refs = (): ExportRef[] => [{
    number: 1, cited_ref: fixtureId(1), reference_id: "ref-1", pinned_revision: 1, source_id: fixtureId(1), suppressed: false,
    title: "Record title 1", url: "https://doi.org/10.5555/p6a.001", metadata: {}, accessed: "2026-10-01", cached: cache.get("ref-1") ?? [],
  }];
  const deps: ExporterDeps = {
    reg: { entries: (r: string) => Promise.resolve(fxEntries(r)) },
    resolver: createResolver(cfg, { fetch, buildClient: () => CLIENT, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: vault,
    readNote: (rel: string) => Promise.resolve(rel === "notes/t/n.md" ? note : null),
    loadRefs: () => Promise.resolve(refs()),
    cache: (rid, identifier, csl, via) => {
      cache.set(rid, [...(cache.get(rid) ?? []), { identifier, csl, via }]);
      return Promise.resolve();
    },
    log: () => {},
    ...(render_ ? { render: render_ } : {}),
  };
  assert(deps.resolver.secrets.length >= 2, "the resolver is configured");
  const app = createExporter(deps);
  return (q: string) => app.request(`/?${q}`);
}
const input = (md: string, f: string, extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs: fixtureRefs(1), format: fmt(f), style: style("ieee"), cslDir: CSL_DIR, wrapNone: true, ...extra });

async function rejection(f: () => unknown): Promise<OutputRejected> {
  try {
    await f();
  } catch (e) {
    if (e instanceof OutputRejected) return e;
    throw e;
  }
  throw new Error("not rejected");
}

// ═════ A7-1: the part classifier ══════════════════════════════════════════════════════════════
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const JPEG_HEAD = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const TEXT = new TextEncoder().encode("env OPENALEX_API_KEY=x\n");
const dict = (o: Record<string, unknown>) => new Map(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && v.startsWith("/") ? new PdfName(v.slice(1)) : v])) as Map<string, never>;

Deno.test("A7-1: the part classifier - a raster in word/media, a PDF image or font program is MEDIA; every other part is TEXT", () => {
  const docx: [string, Uint8Array, string][] = [
    ["word/media/rId20.png", PNG_1PX, "media"],
    ["word/media/rId21.jpg", JPEG_HEAD, "media"],
    ["word/media/leak.png", TEXT, "text"], // a disguised file: not a raster
    ["word/document.xml", TEXT, "text"],
    ["word/_rels/document.xml.rels", TEXT, "text"],
    ["docProps/core.xml", TEXT, "text"],
    ["word/embeddings/x.png", PNG_1PX, "text"], // a raster outside word/media
    ["[Content_Types].xml", TEXT, "text"],
  ];
  for (const [name, bytes, want] of docx) assertEquals(partClass({ in: "docx", name, bytes }), want, name);
  const pdf: [Record<string, unknown>, boolean, string][] = [
    [{ Type: "/XObject", Subtype: "/Image", Filter: "/DCTDecode" }, false, "media"],
    [{ Type: "/XObject", Subtype: "/Image", Filter: "/FlateDecode" }, false, "media"],
    [{ Length: 10 }, true, "media"], // named by a font descriptor
    [{ Subtype: "/CIDFontType0C", Length: 10 }, false, "media"],
    [{ Subtype: "/OpenType" }, false, "media"],
    [{ Length1: 10, Length: 10 }, false, "media"],
    [{ Length: 10 }, false, "text"], // a content stream
    [{ Type: "/XObject", Subtype: "/Form" }, false, "text"],
    [{ Type: "/ObjStm", N: 3, First: 10 }, false, "text"],
    [{ Type: "/Metadata", Subtype: "/XML" }, false, "text"],
    [{ Type: "/CMap" }, false, "text"],
  ];
  for (const [d, fontProgram, want] of pdf) assertEquals(partClass({ in: "pdf", dict: dict(d), fontProgram }), want, JSON.stringify(d));
});

Deno.test("A7-1 (real outputs): in the illustrated note's DOCX and PDF the two images (and the PDF's fonts) are media; every XML part and content stream is text", async () => {
  const vault = await vaultWithImages();
  try {
    const docx = await render(input(illustrated(), "docx", { resourcePath: `${vault}/notes/t`, verify: false }));
    const parts = await zipEntries(docx.bytes);
    const cls = [...parts].map(([name, bytes]) => [name, partClass({ in: "docx", name, bytes })]);
    const media = cls.filter(([, c]) => c === "media").map(([n]) => n);
    assertEquals(media.length, 2, `two media parts: ${JSON.stringify(cls)}`);
    assert(media.every((n) => /^word\/media\//.test(n)), JSON.stringify(media));
    assert(cls.filter(([n]) => /\.(xml|rels)$/.test(n)).every(([, c]) => c === "text"), JSON.stringify(cls));
    const pdf = await render(input(illustrated(), "pdf", { resourcePath: `${vault}/notes/t`, verify: false }));
    const doc = await PdfDocument.read(pdf.bytes);
    const fontFiles = new Set<number>();
    for (const o of doc.objects.values()) {
      if (o.value instanceof Map && (o.value.get("Type") as PdfName | undefined)?.name === "FontDescriptor") {
        for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
          const r = o.value.get(k) as { num?: number } | undefined;
          if (r?.num !== undefined) fontFiles.add(r.num);
        }
      }
    }
    const rows = [...doc.objects].filter(([, o]) => o.stream).map(([num, o]) => {
      const d = (o.value instanceof Map ? o.value : new Map()) as Map<string, never>;
      return { num, size: o.stream!.length, sub: (d.get("Subtype") as PdfName | undefined)?.name ?? "", font: fontFiles.has(num), cls: partClass({ in: "pdf", dict: d, fontProgram: fontFiles.has(num) }) };
    });
    console.log(`A7-1: DOCX ${parts.size} parts, media ${JSON.stringify(media)} | PDF ${rows.length} streams: ${JSON.stringify(rows.map((r) => `${r.num}:${r.cls}${r.sub ? "/" + r.sub : ""}${r.font ? "/font" : ""}:${r.size}`))}`);
    const images = rows.filter((r) => r.sub === "Image");
    assert(images.length >= 2 && images.every((r) => r.cls === "media"), "both images are media streams");
    assert(images.reduce((n, r) => n + r.size, 0) > 3_000_000, "the image streams are the big ones (the PNG inflated, the JPEG raw)");
    assert(fontFiles.size > 0 && rows.filter((r) => r.font).every((r) => r.cls === "media"), "the font programs are media");
    assert(rows.filter((r) => r.cls === "text").every((r) => r.size < 1_000_000), "no text stream is big");
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// ═════ A7-2: the budget, its own code; bodies name the kind ════════════════════════════════════
Deno.test("A7-2: the declared budget - 15 s of judging and 4 Mi characters per text, per export", () => {
  assertEquals(VERIFY_BUDGET, { ms: 15_000, textChars: 4 * 1024 * 1024 });
  assertEquals(MAX_VIEWS, 512);
});

Deno.test("A7-2: out of time, or a text over the size budget, is 503 verification-budget, never credential - the body names no secret material", async () => {
  // the time budget: none left (the first decoding is past the deadline)
  const t = await rejection(() => verifyText("A plain paragraph with nothing in it at all.", SECRETS, "txt", new Budget(0)));
  assertEquals(t.code, "verification-budget", t.message);
  assert(namesNoSecret(t.message), t.message);
  // even a text that holds the key: not judged in time is not a finding either way (never a 200)
  const k = await rejection(() => verifyText(`x &#${KEY.charCodeAt(0)}; ${[...KEY].map((c) => `&#${c.charCodeAt(0)};`).join("")}`, SECRETS, "txt", new Budget(0)));
  assert(k.code === "verification-budget" || k.code === "credential", k.message);
  assert(namesNoSecret(k.message), k.message);
  // the size budget
  const s = await rejection(() => verifyText("word ".repeat(400), SECRETS, "txt", new Budget(15_000, 1000)));
  assertEquals(s.code, "verification-budget", s.message);
  assert(/2000 characters long; one text may be 1000/.test(s.message) && namesNoSecret(s.message), s.message);
  // the budget counts only the checks' own time: idle time between them is not spent
  const b = new Budget(400);
  await new Promise((r) => setTimeout(r, 600));
  await verifyText("A plain paragraph.", SECRETS, "txt", b);
  await verifyText("Another plain paragraph.", SECRETS, "txt", b);
});

Deno.test("A7-2 (cost, not meaning): canonText's ASCII fast path equals the full canon on every ASCII text", () => {
  const all = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)).join("");
  const samples = [all, all.split("").reverse().join(""), KEY, MAIL, `api_key=${KEY}&mailto=${MAIL}`, "A < B > c \[at\] (dot) &#64; %40 QUJD"];
  let x = 12345;
  for (let k = 0; k < 500; k++) {
    let t = "";
    for (let i = 0; i < 64; i++) t += all[(x = (Math.imul(x, 1103515245) + 12345) >>> 0) % 128];
    samples.push(t);
  }
  for (const t of samples) assertEquals(canonText(t), canonTextFull(t), JSON.stringify(t));
});

Deno.test("A7-2: a credential refusal names the KIND (the OpenAlex key / the Crossref mailto), never its first characters or its length", async () => {
  assertEquals(credentialKind(KEY), "the OpenAlex key");
  assertEquals(credentialKind(MAIL), "the Crossref mailto");
  assertEquals(credentialKind(encodeURIComponent(MAIL)), "the Crossref mailto");
  const a = await rejection(() => verifyText(`the key ${KEY} here`, SECRETS));
  assertEquals([a.code, /the OpenAlex key/.test(a.message)], ["credential", true], a.message);
  const m = await rejection(() => verifyText(`write to ${MAIL}`, SECRETS));
  assertEquals([m.code, /the Crossref mailto/.test(m.message)], ["credential", true], m.message);
  for (const e of [a, m]) assert(namesNoSecret(e.message), e.message);
});

Deno.test("A7-2: a media part is still judged raw and as base64 - a real PNG carrying the key in a text chunk, as written or base64, is refused credential", async () => {
  const vault = await Deno.makeTempDir({ prefix: "ob-p6a2-png-" });
  try {
    for (const payload of [KEY, btoa(KEY), btoa(`x${MAIL}`)]) {
      await Deno.writeFile(`${vault}/k.png`, pngWithText(PNG_1PX, "Comment", payload));
      const out = await render(input(`# K\n\nBody [[source/${fixtureId(1)}|s]].\n\n![k](k.png)\n`, "docx", { resourcePath: vault, verify: false }));
      const e = await rejection(() => verifyDocx(out.bytes, SECRETS));
      assertEquals(e.code, "credential", `${payload.slice(0, 6)}: ${e.message}`);
      assert(/word\/media\//.test(e.message) && namesNoSecret(e.message), e.message);
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// ═════ A7-3: the illustrated note, resolver configured ═══════════════════════════════════════
// the verification of a rendered output in a FRESH process: wall time, verdict, peak RSS added (VmHWM)
async function verifyInFreshProcess(file: string, pandocTo: string, f: string) {
  const script = `${file}.verify.ts`;
  await Deno.writeTextFile(script, `
import { verifyOutput } from ${JSON.stringify(new URL("./verify.ts", import.meta.url).href)};
const hwm = () => { try { return Number(/VmHWM:\\s+(\\d+)/.exec(Deno.readTextFileSync("/proc/self/status"))![1]) / 1024; } catch { return NaN; } };
const bytes = Deno.readFileSync(${JSON.stringify(file)});
const before = hwm(), t0 = performance.now();
let verdict = "ok";
try { await verifyOutput(${JSON.stringify(pandocTo)}, ${JSON.stringify(f)}, bytes, ${JSON.stringify(SECRETS)}); } catch (e) { verdict = (e as { code?: string }).code ?? String(e); }
console.log(JSON.stringify({ ms: performance.now() - t0, mb: hwm() - before, verdict }));
`);
  const o = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--config", DENO_JSON, script], stdout: "piped", stderr: "piped" }).output();
  const out = new TextDecoder().decode(o.stdout).trim();
  assert(o.code === 0 && out, `the measuring process failed: ${new TextDecoder().decode(o.stderr).slice(0, 600)}`);
  return JSON.parse(out.split("\n").pop()!) as { ms: number; mb: number; verdict: string };
}

Deno.test("A7-3: a note with a 1.5 MB PNG and a 2.5 MB JPEG, resolver configured, exports to DOCX and PDF with 200; the verification takes <= 10 s and <= 300 MB", async () => {
  const vault = await vaultWithImages();
  try {
    assert(PNG.length > 1_400_000 && PNG.length < 1_600_000 && JPG.length > 2_400_000 && JPG.length < 2_700_000, `${PNG.length} / ${JPG.length}`);
    const get = world(vault, illustrated());
    for (const f of ["docx", "pdf"]) {
      const t0 = performance.now();
      const r = await get(`path=notes/t/n.md&format=${f}`);
      const body = new Uint8Array(await r.arrayBuffer());
      const ms = performance.now() - t0;
      assertEquals(r.status, 200, `${f}: ${r.status} ${new TextDecoder().decode(body.slice(0, 400))}`);
      assert(body.length > 3_500_000, `${f}: the images are in it (${body.length} B)`);
      const file = `${vault}/out.${f}`;
      await Deno.writeFile(file, body);
      const m = await verifyInFreshProcess(file, fmt(f).pandoc_to, f);
      console.log(`A7-3: ${f} ${body.length} B: route 200 in ${(ms / 1000).toFixed(2)} s (render + verification) | the verification alone, fresh process: ${(m.ms / 1000).toFixed(2)} s, peak RSS added ${Number.isNaN(m.mb) ? "n/a (no /proc)" : `${m.mb.toFixed(0)} MB`}, ${m.verdict}`);
      assertEquals(m.verdict, "ok");
      assert(m.ms <= 10_000, `${f}: the verification took ${m.ms} ms`);
      assert(Number.isNaN(m.mb) || m.mb <= 300, `${f}: the verification added ${m.mb} MB`);
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("A7-3: the same note with the synthetic key (or the mailto) written in its text is refused 503 credential in every format - the body names the kind only", async () => {
  const vault = await vaultWithImages();
  try {
    for (const [what, line, kind] of [["key", `The key is ${KEY} here.`, "the OpenAlex key"], ["mailto", `Write to ${MAIL} now.`, "the Crossref mailto"]]) {
      const get = world(vault, illustrated(`\n${line}\n`));
      for (const f of ["md", "txt", "docx", "pdf"]) {
        const r = await get(`path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 503, `${what} ${f}: ${r.status} ${body.slice(0, 300)}`);
        const j = JSON.parse(body);
        assertEquals(j.code, "credential", `${what} ${f}: ${body.slice(0, 300)}`);
        assert(body.includes(kind), `${what} ${f}: the body names ${kind}: ${body.slice(0, 300)}`);
        assert(namesNoSecret(body), `${what} ${f}: ${body.slice(0, 300)}`);
      }
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// ═════ A7-4: over the cap / the budget -> 503 verification-budget ═══════════════════════════════
Deno.test("A7-4: a text over the views cap is NOT JUDGED - judgeSecret answers unjudged, secretIn fails closed with UNJUDGED (no secret), the verifier answers verification-budget", async () => {
  let over = false;
  try {
    views(OVER_CAP);
  } catch (e) {
    over = e instanceof TooManyViews;
  }
  assert(over, "the fixture text has more views than the cap");
  assertEquals(judgeSecret(OVER_CAP, SECRETS), { unjudged: `more than ${MAX_VIEWS} views` });
  assertEquals(secretIn(OVER_CAP, SECRETS), UNJUDGED);
  assert(!SECRETS.includes(UNJUDGED));
  const e = await rejection(() => verifyText(OVER_CAP, SECRETS));
  assertEquals(e.code, "verification-budget", e.message);
  assert(/more than 512 views/.test(e.message) && namesNoSecret(e.message), e.message);
  // the error body guard: a body it cannot judge is 503 verification-budget, not credential
  const g = guardBody({ error: OVER_CAP }, 422, SECRETS);
  assertEquals([g.status, g.body.code], [503, "verification-budget"]);
  assertEquals(guardBody({ error: `x ${KEY}` }, 422, SECRETS).body.code, "credential");
  // inert (no secrets): nothing to judge, nothing refused
  await verifyText(OVER_CAP, []);
});

Deno.test("A7-4 (route): the over-cap text in a note is 503 verification-budget (not credential) in every format that keeps it; a part over the size budget is 503 verification-budget; no body names secret material", async () => {
  const vault = await vaultWithImages();
  try {
    const get = world(vault, `# Cap\n\nClaim [[source/${fixtureId(1)}|c1]].\n\n${OVER_CAP}\n`);
    const seen: string[] = [];
    for (const f of ["md", "txt", "docx", "pdf"]) {
      const r = await get(`path=notes/t/n.md&format=${f}`);
      const body = r.status === 200 ? "" : await r.text();
      seen.push(`${f} ${r.status} ${body ? JSON.parse(body).code : ""}`);
      assert(r.status === 200 || r.status === 503, `${f}: ${r.status} ${body.slice(0, 200)}`);
      if (r.status === 503) {
        assertEquals(JSON.parse(body).code, "verification-budget", `${f}: ${body.slice(0, 300)}`);
        assert(namesNoSecret(body), body);
      }
    }
    console.log(`A7-4 (route, over-cap text): ${seen.join(" | ")}`);
    assert(seen.some((s) => / 503 verification-budget$/.test(s)), "at least one format keeps the over-cap text");
    // the size budget at the route (a smaller budget handed to the real renderer): the DOCX's
    // document.xml and the PDF's content are TEXT parts longer than 1000 characters
    const small = world(vault, illustrated(), (i) => render({ ...i, verifyBudget: { ms: 15_000, textChars: 1000 } }));
    for (const f of ["docx", "pdf"]) {
      const r = await small(`path=notes/t/n.md&format=${f}`);
      const body = await r.text();
      assertEquals([r.status, JSON.parse(body).code], [503, "verification-budget"], `${f}: ${body.slice(0, 300)}`);
      assert(namesNoSecret(body), body);
    }
    // and the time budget at the route
    const none = world(vault, illustrated(), (i) => render({ ...i, verifyBudget: { ms: 0, textChars: VERIFY_BUDGET.textChars } }));
    const r = await none(`path=notes/t/n.md&format=pdf`);
    const body = await r.text();
    assertEquals([r.status, JSON.parse(body).code], [503, "verification-budget"], body.slice(0, 300));
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});

// The verifiers alone on the big parts, under the default budget (no exception = judged clean)
Deno.test("A7-3 (verifiers): verifyDocx and verifyPdf judge the illustrated outputs clean with the secrets configured", async () => {
  const vault = await vaultWithImages();
  try {
    for (const [f, v] of [["docx", verifyDocx], ["pdf", verifyPdf]] as const) {
      const out = await render(input(illustrated(), f, { resourcePath: `${vault}/notes/t`, verify: false }));
      const t0 = performance.now();
      await v(out.bytes, SECRETS);
      console.log(`A7-3 (verifiers): ${f} ${out.bytes.length} B judged clean in ${(performance.now() - t0).toFixed(0)} ms (in-process)`);
    }
  } finally {
    await Deno.remove(vault, { recursive: true });
  }
});
