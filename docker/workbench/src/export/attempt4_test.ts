// deno test --allow-all src/export/attempt4_test.ts - rw-p6a-resolve attempt 4 (bounded round): the
// tester's attempt-3 finding (test-attempt3-2026-10-18.md ADV-4 / bar c) and near-misses N1, N3, N4, N7
// through the REAL pandoc 3.11 + Typst 0.15.1 (the image's test stage; it runs in the build gate).
//   A3-4 (wrapped)  a key or mailto between `<` and `>` - `<1 KEY>`, `< KEY and later > end`, `<KEY>`,
//                   `<<KEY>>`, `< KEY >`, `< MAILTO >` - in a title or an author: refused FRESH (422,
//                   named, nothing cached), refused CACHED (422), never served in MD, TXT, DOCX, PDF;
//                   the Copy page 200 without it; at the output stage (a row that slipped) 503 credential
//   A3-4 (N2)       transformed forms: every byte %-encoded, fullwidth, base64, the mailto with
//                   (at) / [at] / " at " / (dot) / no dot, the key without its dashes: the same
//   A4-N3           an image `../x.png` or `.hidden/x.png` (a real PNG there) is never embedded
//   A4-N4           a relative link or an anchor is rendered as its text in every format (200); a
//                   typed `<mailto:...>` holding the configured mailto is refused 503 credential
//   A4-N7           C0/C1 control characters: 422 `glyphs` before Typst, the code points named
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver, type ResolverConfig } from "./resolver.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { ExportRef } from "./repo.ts";
import { type FormatDef, render, RenderFailed, type RenderInput, type StyleDef } from "./render.ts";
import type { CslItem } from "./csl.ts";
import { fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { imageSource } from "./markdown.ts";
import { secretIn } from "./credentials.ts";
import { verifyMarkdown, verifyText } from "./verify.ts";
import { pdfText } from "./pdf_tools.ts";
import { docxXml } from "./zip_read.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const KEY = "a4synth-key-0f1e2d3c4b5a";
const MAIL = "a4-synthmail@example.invalid";
const FORMATS = ["md", "txt", "docx", "pdf"];

// ── the shapes ────────────────────────────────────────────────────────────────────────────────
const fullwidth = (s: string) => [...s].map((c) => /[a-z0-9]/i.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c).join("");
const pct = (s: string) => [...new TextEncoder().encode(s)].map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
// the tester's `<`/`>` matrix (ADV-4), for the key and the mailto
const WRAPPED: Record<string, (s: string) => string> = {
  angle_space: (s) => `Angle < ${s} > title`,
  angle_digit: (s) => `Angle <1 ${s}> title`,
  angle_later: (s) => `Unclosed < ${s} and later > end`,
  angle_tight: (s) => `Tight <${s}> title`,
  angle_double: (s) => `Double <<${s}>> title`,
};
// transformed forms (tester N2)
const TRANSFORMED: Record<string, string> = {
  key_percent: `Encoded ${pct(KEY)} title`,
  key_fullwidth: `Wide ${fullwidth(KEY)} title`,
  key_base64: `Packed ${btoa(KEY)} title`,
  key_dashless: `Bare ${KEY.replace(/-/g, "")} title`,
  mail_paren_at: `Mail ${MAIL.replace("@", "(at)")} here`,
  mail_bracket_at: `Mail ${MAIL.replace("@", "[at]")} here`,
  mail_word_at: `Mail ${MAIL.replace("@", " at ")} here`,
  mail_dot_words: `Mail ${MAIL.replace("@", " (at) ").replace(/\./g, " (dot) ")} here`,
  mail_dotless: `Mail ${MAIL.replace(/\./g, "")} here`,
  mail_percent: `Mail ${pct(MAIL)} here`,
};
const SHAPES: Record<string, { title: string; author?: string }> = {};
for (const [n, f] of Object.entries(WRAPPED)) {
  SHAPES[`${n}_key`] = { title: f(KEY) };
  SHAPES[`${n}_mail`] = { title: f(MAIL) };
}
SHAPES.author_angle_mail = { title: "Angle mail in author", author: `< ${MAIL} >` };
SHAPES.author_angle_key = { title: "Angle key in author", author: `<1 ${KEY}>` };
for (const [n, t] of Object.entries(TRANSFORMED)) SHAPES[n] = { title: t };

// Independent of credentials.ts: does an output (as text) carry either secret as written?
const leaks = (t: string) => {
  const low = t.toLowerCase().replace(/\s+/g, "");
  return low.includes(KEY) || low.includes(MAIL);
};

// ── the route, with fakes for the database and the network (exporter_test.ts's world, narrowed) ──
const CLIENT = { close() {} } as unknown as Deno.HttpClient;
const cfg: ResolverConfig = {
  openalexKey: KEY, mailto: MAIL, proxyUrl: "http://proxy.invalid:8888",
  openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000,
};
function world(shape: { title: string; author?: string } | null) {
  const cache = new Map<string, { identifier: string; csl: CslItem; via: string }[]>();
  let calls = 0;
  const fetch = (url: string) => {
    calls++;
    if (!url.includes("openalex") || !shape) {
      return Promise.resolve(url.includes("openalex")
        ? Response.json({ title: "A clean title", type: "article", doi: "https://doi.org/10.5555/p6a.001", publication_date: "2021-01-01" })
        : Response.json({ status: "error" }, { status: 404 }));
    }
    return Promise.resolve(Response.json({
      title: shape.title, type: "article", doi: "https://doi.org/10.5555/p6a.001", publication_date: "2021-02-01",
      authorships: [{ author: { display_name: shape.author ?? "Ann Author" } }],
    }));
  };
  const refs = (): ExportRef[] => [{
    number: 1, cited_ref: fixtureId(1), reference_id: "ref-1", pinned_revision: 1, source_id: fixtureId(1), suppressed: false,
    title: "Record title 1", url: "https://doi.org/10.5555/p6a.001", metadata: {}, accessed: "2026-10-01", cached: cache.get("ref-1") ?? [],
  }];
  const deps: ExporterDeps = {
    reg: { entries: (r: string) => Promise.resolve(fxEntries(r)) },
    resolver: createResolver(cfg, { fetch, buildClient: () => CLIENT, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel: string) => Promise.resolve(rel === "notes/t/n.md" ? `# Route\n\nClaim [[source/${fixtureId(1)}|c1]].\n` : null),
    loadRefs: () => Promise.resolve(refs()),
    cache: (rid, identifier, csl, via) => {
      cache.set(rid, [...(cache.get(rid) ?? []), { identifier, csl, via }]);
      return Promise.resolve();
    },
    log: () => {},
  };
  return { cache, deps, calls: () => calls };
}
const get = (deps: ExporterDeps, q: string) => createExporter(deps).request(`/?${q}`);

Deno.test("A3-4 (attempt 4): a key or mailto between < and > (and every transformed form) in an upstream title or author is refused FRESH in every format - 422 named, nothing cached, the body without it; the Copy page 200 without it", async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const w = world(shape);
    try {
      for (const f of FORMATS) {
        const r = await get(w.deps, `path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 422, `${name} ${f}: ${r.status} ${body.slice(0, 200)}`);
        assert(/credential-shaped/.test(body), `${name} ${f}: named: ${body.slice(0, 300)}`);
        assert(!leaks(body), `${name} ${f}: the 422 body carries the secret`);
      }
      assertEquals(w.cache.size, 0, `${name}: nothing cached`);
      const c = await get(w.deps, "path=notes/t/n.md&mode=copy");
      const t = await c.text();
      assertEquals(c.status, 200, `${name} copy: ${t.slice(0, 200)}`);
      assert(!leaks(t) && secretIn(t, [KEY, MAIL]) === null, `${name} copy: carries the secret: ${t.slice(0, 300)}`);
    } finally {
      w.deps.resolver.close();
    }
  }
});

Deno.test("A3-4 (attempt 4): the same record already CACHED (written by attempt 3, which accepted it) is refused in every format - 422 'unsafe cached record', no request; the Copy page 200 without it", async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const w = world(null);
    try {
      // a clean resolution fills the cache with the identifier; the row is then what attempt 3 stored
      assertEquals((await get(w.deps, "path=notes/t/n.md&format=txt")).status, 200);
      const rows = w.cache.get("ref-1")!;
      rows[0].csl = { type: "article-journal", title: shape.title, author: [{ literal: shape.author ?? "Ann Author" }] } as CslItem;
      const before = w.calls();
      for (const f of FORMATS) {
        const r = await get(w.deps, `path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 422, `${name} ${f}: ${r.status} ${body.slice(0, 200)}`);
        assert(/unsafe cached record|credential-shaped/.test(body), `${name} ${f}: named: ${body.slice(0, 300)}`);
        assert(!leaks(body), `${name} ${f}: the 422 body carries the secret`);
      }
      const c = await get(w.deps, "path=notes/t/n.md&mode=copy");
      const t = await c.text();
      assertEquals(c.status, 200, `${name} copy`);
      assert(!leaks(t) && secretIn(t, [KEY, MAIL]) === null, `${name} copy: carries the secret: ${t.slice(0, 300)}`);
      assertEquals(w.calls(), before, `${name}: no request for a cached row`);
    } finally {
      w.deps.resolver.close();
    }
  }
});

// ── the output stage: a row that slipped past both (handed straight to the renderer) ───────────
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const input = (md: string, f: string, extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs: fixtureRefs(1), format: fmt(f), style: style("ieee"), cslDir: CSL_DIR, wrapNone: true, ...extra });
const doc = (body: string) => `# P\n\nBody [[source/${fixtureId(1)}|s]].\n\n${body}\n`;
const outText = async (f: string, b: Uint8Array) =>
  f === "pdf" ? await pdfText(b) : f === "docx" ? await docxXml(b) : new TextDecoder().decode(b);

Deno.test("A3-4 (attempt 4): at the OUTPUT stage every shape is refused 503 credential in MD, TXT, DOCX and PDF - or, where the CSL clean-up removes a real tag with the secret in it, served without the secret", async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const refs = fixtureRefs(1);
    refs[0].csl = { ...refs[0].csl, title: shape.title, ...(shape.author ? { author: [{ literal: shape.author }] } : {}) };
    for (const f of FORMATS) {
      let out: Uint8Array | null = null;
      try {
        out = (await render({ ...input(doc("x"), f), refs, secrets: [KEY, MAIL] })).bytes;
      } catch (e) {
        if (!(e instanceof RenderFailed)) throw e;
        assertEquals([e.code, (e.extra as { format?: string }).format], ["credential", f], `${name} ${f}: ${e.message}`);
        assert(!leaks(e.message), `${name} ${f}: the refusal prints the secret`);
        continue;
      }
      // served: only a tight `<KEY>` / `<<KEY>>` (a REAL tag to the strict grammar, removed with its
      // name before citeproc) may be; the output then carries neither secret in any form
      assert(/angle_(tight|double)/.test(name), `${name} ${f}: served 200`);
      const t = await outText(f, out);
      assert(!leaks(t) && secretIn(t, [KEY, MAIL]) === null, `${name} ${f}: served WITH the secret`);
    }
  }
});

Deno.test("A3-4 (attempt 4): the text checks see the raw text - verifyText / verifyMarkdown refuse `< KEY >`, `< MAILTO >`, `<1 KEY>` and a typed <mailto:...> autolink (attempt 3 deleted them as tags)", async () => {
  for (const t of [`x < ${KEY} > y`, `x < ${MAIL} > y`, `x <1 ${KEY}> y`, `x < ${KEY} and later > end`, `x <<${KEY}>> y`, `<mailto:${MAIL}>`]) {
    for (const v of [() => verifyText(t, [KEY, MAIL]), () => verifyMarkdown(t.replace(/</g, "\\<").replace(/>/g, "\\>"), [KEY, MAIL])]) {
      let code = "";
      try {
        await v(); // rw-p6a-followups: judged in a worker, so the verifiers answer asynchronously
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
      }
      assertEquals(code, "credential", t);
    }
  }
  // markup alone, a lone `<`, a comparison: not a secret
  for (const t of ["a < b > c", "A <i>proper</i> title", "x <1 y>"]) assertEquals(secretIn(t, [KEY, MAIL]), null, t);
});

// ── N4: relative links and anchors; a typed mailto autolink ───────────────────────────────────
Deno.test("A4-N4: a relative link and an anchor are rendered as their TEXT in every format (200, no link target); a typed <mailto:> holding the configured mailto is refused 503 credential in every format", async () => {
  const body = "See [the other note](notes/other.md), [a part](#part), [up](../up.md) and [safe](https://example.org/s).\n\n## Part";
  for (const f of FORMATS) {
    const out = (await render({ ...input(doc(body), f), secrets: [KEY, MAIL] })).bytes;
    const t = await outText(f, out);
    for (const w of ["the other note", "a part", "up"]) assert(t.includes(w), `${f}: the text '${w}' stays`);
    assert(!/notes\/other\.md|#part\b|\.\.\/up\.md/.test(f === "pdf" ? new TextDecoder("latin1").decode(out) : t), `${f}: no relative/anchor target`);
    if (f === "md") assert(t.includes("](https://example.org/s)"), "the http link stays a link");
  }
  for (const f of FORMATS) {
    const e = await assertRejects(() => render({ ...input(doc(`Write to <mailto:${MAIL}> or [me](mailto:${MAIL}).`), f), secrets: [KEY, MAIL] }), RenderFailed);
    assertEquals([e.code, (e.extra as { format?: string }).format], ["credential", f], `${f}: ${e.message}`);
  }
  // a mailto that is not the configured one stays a link
  const md = new TextDecoder().decode((await render({ ...input(doc("Write to <mailto:someone@example.org>."), "md"), secrets: [KEY, MAIL] })).bytes);
  assert(md.includes("mailto:someone@example.org"), md);
});

// ── N3: `..` and hidden segments in an image path ──────────────────────────────────────────────
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
Deno.test("A4-N3: an image path with a `..` or a hidden segment is never embedded, even when a real PNG is there (only this guard stops it)", async () => {
  for (const p of ["../x.png", ".hidden/x.png", "img/../x.png", "img/.h/x.png", "./x.png"]) assertEquals(imageSource(p), null, p);
  assertEquals(imageSource("img/ok.png"), "local");
  const dir = await Deno.makeTempDir({ prefix: "ob-img-a4-" });
  try {
    await Deno.mkdir(`${dir}/vault/.hidden`, { recursive: true });
    await Deno.mkdir(`${dir}/vault/img`, { recursive: true });
    await Deno.writeFile(`${dir}/x.png`, PNG_1PX); // outside the resource path, reached by `..`
    await Deno.writeFile(`${dir}/vault/.hidden/x.png`, PNG_1PX); // a hidden directory inside it
    await Deno.writeFile(`${dir}/vault/img/ok.png`, PNG_1PX);
    const body = "![up](../x.png) ![hid](.hidden/x.png) ![ok](img/ok.png)";
    const out = await render(input(doc(body), "docx", { resourcePath: `${dir}/vault` }));
    const xml = await docxXml(out.bytes);
    assertEquals([...xml.matchAll(/Target="media\/[^"]+"/g)].length, 1, "exactly one embedded image: img/ok.png");
    await render(input(doc(body), "pdf", { resourcePath: `${dir}/vault` })); // and the PDF renders
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── N7: control characters ──────────────────────────────────────────────────────────────────────
Deno.test("A4-N7: C0/C1 control characters are refused by the glyph pre-check - 422 glyphs naming the code points - not by the .notdef scan (503)", async () => {
  for (const [c, cp] of [["\u0001", "U+0001"], ["\u0007", "U+0007"], ["\u001b", "U+001B"], ["\u007f", "U+007F"], ["\u0085", "U+0085"]]) {
    const e = await assertRejects(() => render(input(doc(`Text with ${c} a control.`), "pdf")), RenderFailed);
    assertEquals([e.code, (e.extra as { characters: string[] }).characters], ["glyphs", [cp]], `${cp}: ${e.message}`);
  }
  const refs = fixtureRefs(1);
  refs[0].csl.title = "Title with \u0007 bell";
  const e = await assertRejects(() => render({ ...input(doc("x"), "pdf"), refs }), RenderFailed);
  assertEquals(e.code, "glyphs", "a reference title");
  await render(input(doc("Tabs\tand\nnew lines are fine."), "pdf"));
});
