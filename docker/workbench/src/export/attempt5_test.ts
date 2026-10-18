// deno test --allow-all src/export/attempt5_test.ts - rw-p6a-resolve attempt 5 (structural): the
// credential INVARIANT (credentials.ts canon / secretIn) at every door, through the REAL pandoc 3.11
// + Typst 0.15.1 where an output is rendered (the image's test stage; it runs in the build gate).
//   A5-1 (fixed)     the tester's attempt-4 shapes - `Accent T4kq9Źx2...`, the mailto with
//                    `éxample`, U+0332 - and their kin: refused FRESH (422, nothing cached),
//                    CACHED (422, no request), at the OUTPUT stage (503 credential) and typed in the
//                    NOTE (503 credential) in MD, TXT, DOCX, PDF and the Copy page
//   A5-2 (property)  N >= 2000 seeded adversarial texts holding a synthetic key or mailto (combining
//                    marks from every Mn/Mc/Me code point, default-ignorables, zero-width and bidi
//                    controls, case changes, fullwidth / mathematical / circled / super- and subscript
//                    substitutions, real tags, comments, CDATA, entities, and the declared encodings
//                    singly and nested): detected in EVERY case at the input check, the fresh and the
//                    cached route, and the output verifier over a rendered TXT and MD and a crafted
//                    DOCX part; a sample also rendered for real in all four formats
//   A5-3 (false +)   canon of 10 000 real-looking titles never holds canon of a random 32-char key
//   A5-4 (422 body)  a dead reference whose record title carries the secret: the 422 withholds it
// Imports only what attempt 4 (OB1 22637cd) already exported, so the same file is the RED there.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver, type ResolverConfig } from "./resolver.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { ExportRef } from "./repo.ts";
import { type FormatDef, render, RenderFailed, type RenderInput, type StyleDef } from "./render.ts";
import type { CslItem } from "./csl.ts";
import { fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { secretIn } from "./credentials.ts";
import { verifyDocx, verifyMarkdown, verifyText } from "./verify.ts";
import { zipEntries } from "./zip_read.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
// the tester's synthetic secrets (test-attempt4-2026-10-18.md)
const KEY = "T4kq9Zx2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc";
const MAIL = "t4-synth.ops@example.invalid";
const SECRETS = [KEY, MAIL];
const FORMATS = ["md", "txt", "docx", "pdf"];

// An INDEPENDENT reader (not credentials.ts): marks and invisibles stripped after NFKD, letters and
// digits only. It proves a fixed shape holds the secret, and that no served text does.
const reader = (t: string) =>
  t.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const leaks = (t: string) => {
  const r = reader(t);
  return r.includes(reader(KEY)) || r.includes(reader(MAIL)) || t.toLowerCase().includes(KEY.toLowerCase()) || t.toLowerCase().includes(MAIL);
};

// ── the route, with fakes for the database and the network ─────────────────────────────────────
const CLIENT = { close() {} } as unknown as Deno.HttpClient;
const cfg: ResolverConfig = {
  openalexKey: KEY, mailto: MAIL, proxyUrl: "http://proxy.invalid:8888",
  openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000,
};
type Shape = { title: string; author?: string };
function world(opts: { recordTitle?: string; dead?: boolean } = {}) {
  const cache = new Map<string, { identifier: string; csl: CslItem; via: string }[]>();
  let calls = 0;
  let shape: Shape | null = null;
  const fetch = (url: string) => {
    calls++;
    if (opts.dead || !url.includes("openalex")) return Promise.resolve(Response.json({ status: "error" }, { status: 404 }));
    const s = shape ?? { title: "A clean title" };
    return Promise.resolve(Response.json({
      title: s.title, type: "article", doi: "https://doi.org/10.5555/p6a.001", publication_date: "2021-02-01",
      authorships: [{ author: { display_name: s.author ?? "Ann Author" } }],
    }));
  };
  const refs = (): ExportRef[] => [{
    number: 1, cited_ref: fixtureId(1), reference_id: "ref-1", pinned_revision: 1, source_id: fixtureId(1), suppressed: false,
    title: opts.recordTitle ?? "Record title 1", url: "https://doi.org/10.5555/p6a.001", metadata: {}, accessed: "2026-10-01",
    cached: cache.get("ref-1") ?? [],
  }];
  let note = `# Route\n\nClaim [[source/${fixtureId(1)}|c1]].\n`;
  const deps: ExporterDeps = {
    reg: { entries: (r: string) => Promise.resolve(fxEntries(r)) },
    resolver: createResolver(cfg, { fetch, buildClient: () => CLIENT, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel: string) => Promise.resolve(rel === "notes/t/n.md" ? note : null),
    loadRefs: () => Promise.resolve(refs()),
    cache: (rid, identifier, csl, via) => {
      cache.set(rid, [...(cache.get(rid) ?? []), { identifier, csl, via }]);
      return Promise.resolve();
    },
    log: () => {},
  };
  const app = createExporter(deps);
  return {
    cache, deps, calls: () => calls,
    setShape: (s: Shape | null) => { shape = s; },
    setNote: (n: string) => { note = n; },
    get: (q: string) => app.request(`/?${q}`),
  };
}

// ── rendering helpers ─────────────────────────────────────────────────────────────────────────
const fmt = (k: string) => ({ key: k, ...fxEntries("export_formats").find((e) => e.key === k)!.definition }) as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const input = (md: string, f: string, extra: Partial<RenderInput> = {}): RenderInput =>
  ({ md, refs: fixtureRefs(1), format: fmt(f), style: style("ieee"), cslDir: CSL_DIR, wrapNone: true, ...extra });
const doc = (body: string) => `# P\n\nBody [[source/${fixtureId(1)}|s]].\n\n${body}\n`;
async function refusedCredential(i: RenderInput): Promise<string> {
  try {
    const out = await render(i);
    const t = new TextDecoder().decode(out.bytes);
    return `served 200${i.format.key === "md" || i.format.key === "txt" ? `: ${esc(t.slice(t.indexOf("[1]"), t.indexOf("[1]") + 400))}` : ""}`;
  } catch (e) {
    if (!(e instanceof RenderFailed)) throw e;
    return e.code === "credential" && !leaks(e.message) ? "credential" : `${e.code}: ${e.message.slice(0, 120)}`;
  }
}
const esc = (s: string) => [...s].map((c) => c.codePointAt(0)! > 0x7e || c.codePointAt(0)! < 0x20 ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c).join("");

// ═════ A5-1: the tester's shapes, fixed ═══════════════════════════════════════════════════════════
const every = (s: string, m: string) => [...s].map((c) => c + m).join("");
const FIXED: Record<string, Shape> = {
  key_acute_one: { title: "Accent T4kq9Źx2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc title" }, // the tester's c1
  key_acute_every: { title: `Accent ${every(KEY, "́")} title` }, // c2
  mail_acute_author: { title: "Accent mail in author", author: "t4-synth.ops@éxample.invalid" }, // c3
  mail_acute_title: { title: "Contact t4-synth.ops@éxample.invalid for data" },
  key_lowline_one: { title: "Line T4kq9Z̲x2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc title" }, // U+0332, no merged form
  key_lowline_every: { title: `Line ${every(KEY, "̲")} title` },
  key_diaeresis_x: { title: "Dots T4kq9Zẍ2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc title" }, // x + U+0308 -> U+1E8D
  key_tilde_n: { title: "Tilde T4kq9Zx2Lm7Pw3Rv8Ñs5Bd1Hf6Gj0Yc title" }, // N + U+0303 -> U+00D1
  key_cedilla_c: { title: "Cedilla T4kq9Zx2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yç title" }, // c + U+0327 -> U+00E7
  key_precomposed: { title: "Composed T4kq9Źx2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc title" }, // U+0179 written whole
  mail_precomposed: { title: "Mail", author: "t4-synth.ops@éxample.invalid" },
};

Deno.test("A5-1 (fixed): every shape holds the secret to an independent reader (so a 200 would be a leak)", () => {
  for (const [name, s] of Object.entries(FIXED)) assert(leaks(`${s.title} ${s.author ?? ""}`), name);
});

Deno.test("A5-1 (fixed) FRESH: the tester's shapes are refused in MD, TXT, DOCX and PDF - 422, nothing cached, the body without it; the Copy page 200 without it", async () => {
  for (const [name, shape] of Object.entries(FIXED)) {
    const w = world();
    w.setShape(shape);
    try {
      for (const f of FORMATS) {
        const r = await w.get(`path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 422, `${name} ${f}: ${r.status} ${esc(body.slice(0, 300))}`);
        assert(/credential-shaped/.test(body), `${name} ${f}: named: ${esc(body.slice(0, 300))}`);
        assert(!leaks(body), `${name} ${f}: the 422 body carries the secret`);
      }
      assertEquals(w.cache.size, 0, `${name}: nothing cached`);
      const c = await w.get("path=notes/t/n.md&mode=copy");
      const t = await c.text();
      assertEquals(c.status, 200, `${name} copy`);
      assert(!leaks(t), `${name} copy: carries the secret: ${esc(t.slice(0, 300))}`);
    } finally {
      w.deps.resolver.close();
    }
  }
});

Deno.test("A5-1 (fixed) CACHED: a row holding a tester's shape (as attempt 4 stored it) is refused in every format - 422 'unsafe cached record', no request; the Copy page 200 without it", async () => {
  for (const [name, shape] of Object.entries(FIXED)) {
    const w = world();
    try {
      assertEquals((await w.get("path=notes/t/n.md&format=txt")).status, 200);
      w.cache.get("ref-1")![0].csl = { type: "article-journal", title: shape.title, author: [{ literal: shape.author ?? "Ann Author" }] } as CslItem;
      const before = w.calls();
      for (const f of FORMATS) {
        const r = await w.get(`path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 422, `${name} ${f}: ${r.status} ${esc(body.slice(0, 300))}`);
        assert(/cached record carries credential-shaped text/.test(body), `${name} ${f}: named: ${esc(body.slice(0, 300))}`);
        assert(!leaks(body), `${name} ${f}: the 422 body carries the secret`);
      }
      const c = await w.get("path=notes/t/n.md&mode=copy");
      const t = await c.text();
      assertEquals(c.status, 200, `${name} copy`);
      assert(!leaks(t), `${name} copy: carries the secret: ${esc(t.slice(0, 300))}`);
      assertEquals(w.calls(), before, `${name}: no request for a cached row`);
    } finally {
      w.deps.resolver.close();
    }
  }
});

Deno.test("A5-1 (fixed) OUTPUT and NOTE: a row that slipped past both checks, or the shape typed in the note, is refused 503 credential in MD, TXT, DOCX, PDF and the Copy page", async () => {
  const bad: string[] = [];
  for (const [name, shape] of Object.entries(FIXED)) {
    const refs = fixtureRefs(1);
    refs[0].csl = { ...refs[0].csl, title: shape.title, ...(shape.author ? { author: [{ literal: shape.author }] } : {}) };
    const typed = `Typed: ${shape.title} ${shape.author ?? ""}`;
    for (const f of FORMATS) {
      const o = await refusedCredential({ ...input(doc("x"), f), refs, secrets: SECRETS });
      if (o !== "credential") bad.push(`${name} output ${f}: ${o}`);
      const n = await refusedCredential({ ...input(doc(typed), f), secrets: SECRETS });
      if (n !== "credential") bad.push(`${name} note ${f}: ${n}`);
    }
    // the Copy page of a note that types it (the route, mode=copy)
    const w = world();
    try {
      w.setNote(doc(typed));
      const c = await w.get("path=notes/t/n.md&mode=copy");
      const t = await c.text();
      if (c.status !== 503 || leaks(t)) bad.push(`${name} copy: ${c.status} ${esc(t.slice(0, 160))}`);
    } finally {
      w.deps.resolver.close();
    }
  }
  assertEquals(bad, [], bad.slice(0, 8).map(esc).join("\n"));
});

// ═════ A5-2: the property test ════════════════════════════════════════════════════════════════════
const N = Number(Deno.env.get("A5_PROPERTY_N") ?? 2000);
const SEED = Number(Deno.env.get("A5_PROPERTY_SEED") ?? 0x5a5a2026);
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// every code point of a class, scanned from the engine's own Unicode tables
function scan(re: RegExp): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (re.test(String.fromCodePoint(cp))) out.push(cp);
  }
  return out;
}
const MARKS = scan(/^[\p{Mn}\p{Mc}\p{Me}]$/u);
const IGNORABLE = scan(/^\p{Default_Ignorable_Code_Point}$/u);
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e];
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const MATH_LETTER = [0x1d400, 0x1d434, 0x1d468, 0x1d49c, 0x1d4d0, 0x1d504, 0x1d538, 0x1d56c, 0x1d5a0, 0x1d5d4, 0x1d608, 0x1d63c, 0x1d670];
const MATH_DIGIT = [0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6];
const SUP = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
const TAGS = ["<i></i>", "<b></b>", "<sup></sup>", "<sub></sub>", "<sc></sc>", '<span class="nocase"></span>', '<span style="font-variant:small-caps;"></span>', "<br/>", "<br>", "</p>", "<!-- c -->", "<!---->"];
const WORDS = "survey effects of policy on rural education outcomes evidence from panel data analysis network model".split(" ");

let markCursor = 0;
function generate(r: () => number, secret: string): { text: string; layers: string[] } {
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const layers: string[] = [];
  // 1. tokens: the secret's characters; the mailto's `@` / `.` maybe spelled out (atomic tokens)
  let toks: string[] = [...secret];
  if (secret.includes("@")) {
    toks = toks.map((c) => {
      if (c === "@" && r() < 0.6) return pick(["(at)", "[at]", "{at}", " at ", " (at) ", "%40", "&#64;", "&commat;", "＠", "&#x40;"]);
      if (c === "." && r() < 0.4) return pick(["(dot)", " dot ", " (dot) ", "&period;", "&#46;"]);
      return c;
    });
  }
  // 2. per character: substitutions (letters and digits only)
  toks = toks.map((c) => {
    if (!/^[A-Za-z0-9]$/.test(c)) return c;
    const x = r();
    if (x < 0.15) return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (x < 0.25) return String.fromCodePoint(c.codePointAt(0)! + 0xfee0); // fullwidth
    if (x < 0.35) {
      if (/[0-9]/.test(c)) return String.fromCodePoint(pick(MATH_DIGIT) + Number(c));
      const b = pick(MATH_LETTER) + (c >= "a" ? 26 + c.charCodeAt(0) - 97 : c.charCodeAt(0) - 65);
      const m = String.fromCodePoint(b);
      return m.normalize("NFKC") === c ? m : c; // a hole in a math alphabet: keep the letter
    }
    if (x < 0.42) {
      if (/[0-9]/.test(c)) return c === "0" ? "⓪" : String.fromCodePoint(0x2460 + Number(c) - 1);
      return String.fromCodePoint((c >= "a" ? 0x24d0 + c.charCodeAt(0) - 97 : 0x24b6 + c.charCodeAt(0) - 65));
    }
    if (x < 0.47 && /[0-9]/.test(c)) return r() < 0.5 ? SUP[Number(c)] : String.fromCodePoint(0x2080 + Number(c));
    if (x < 0.5 && /[0-9]/.test(c)) return c === "0" ? "⓿" : String.fromCodePoint(0x2776 + Number(c) - 1); // negative circled
    if (x < 0.55) return `&#${c.codePointAt(0)};`;
    if (x < 0.58) return `&#x${c.codePointAt(0)!.toString(16)};`;
    return c;
  });
  // 3. between and after tokens: combining marks (walking every Mn/Mc/Me code point), invisibles,
  //    bidi controls, real tags, comments; a CDATA section around one token
  const out: string[] = [];
  for (const t of toks) {
    out.push(r() < 0.04 ? `<![CDATA[${t}]]>` : t);
    const x = r();
    if (x < 0.3) {
      const k = 1 + Math.floor(r() * 3);
      for (let j = 0; j < k; j++) out.push(String.fromCodePoint(MARKS[markCursor++ % MARKS.length]));
    } else if (x < 0.38) out.push(String.fromCodePoint(pick(IGNORABLE)));
    else if (x < 0.44) out.push(String.fromCodePoint(pick(ZERO_WIDTH)));
    else if (x < 0.5) out.push(String.fromCodePoint(pick(BIDI)));
    else if (x < 0.58) out.push(pick(TAGS));
  }
  let text = `${pick(WORDS)} ${pick(WORDS)} ${out.join("")} ${pick(WORDS)}`;
  // 4. whole-text encodings, singly and nested, within the declared depths
  const budget: Record<string, number> = { percent: 3, base64: 2, hex: 2, entity: 2 };
  const nLayers = Math.floor(r() * 4); // 0..3
  const enc = new TextEncoder();
  for (let l = 0; l < nLayers; l++) {
    const kinds = Object.keys(budget).filter((k) => budget[k] > 0);
    const k = pick(kinds);
    budget[k]--;
    layers.push(k);
    if (k === "percent") {
      const p = 0.4 + r() * 0.6;
      text = [...text].map((c) => c === "%" || r() < p ? [...enc.encode(c)].map((b) => "%" + b.toString(16).padStart(2, "0")[r() < 0.5 ? "toUpperCase" : "toLowerCase"]()).join("") : c).join("");
    } else if (k === "base64") {
      const pre = pick(["", "a", "ab", "abc"]);
      let b = btoa(String.fromCharCode(...enc.encode(pre + text)));
      if (r() < 0.4) b = b.replace(/\+/g, "-").replace(/\//g, "_");
      if (r() < 0.3) b = b.replace(/=+$/, "");
      if (r() < 0.2) b = b.replace(/(.{20})/g, "$1\n");
      text = `${pick(WORDS)} ${b} ${pick(WORDS)}`;
    } else if (k === "hex") {
      const h = [...enc.encode(text)].map((x) => x.toString(16).padStart(2, "0")).join("");
      text = `${pick(WORDS)} ${r() < 0.5 ? h.toUpperCase() : h} ${pick(WORDS)}`;
    } else {
      const p = 0.5 + r() * 0.5;
      text = [...text].map((c) => c === "&" ? "&amp;" : r() < p ? (r() < 0.5 ? `&#${c.codePointAt(0)};` : `&#x${c.codePointAt(0)!.toString(16)};`) : c).join("");
    }
  }
  // 5. after a base64 / hex layer: real tags, comments or invisible characters inside the run
  if (layers.length && /base64|hex/.test(layers[layers.length - 1]) && r() < 0.5) {
    const at = 6 + Math.floor(r() * Math.max(1, text.length - 12));
    text = text.slice(0, at) + pick([...TAGS, "​", "­", "&shy;", "⁠"]) + text.slice(at);
  }
  return { text, layers };
}

// a crafted DOCX: a rendered one with one part rewritten, re-zipped (stored entries)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
function storedZip(parts: Map<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const [name, data] of parts) {
    const n = enc.encode(name);
    const crc = CRC(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    chunks.push(new Uint8Array(h.buffer), n, data);
    central.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, parts.size, true); e.setUint16(10, parts.size, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>#])/g, "\\$1");
const PLACE = "Qplaceholderzq";

async function verifierCode(v: () => unknown): Promise<string> {
  try {
    await v();
    return "served";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

Deno.test(`A5-2 (property): ${N} seeded adversarial texts (seed ${SEED}) holding the key or the mailto - detected in EVERY case at the input check, the fresh and cached route, and the output verifier (TXT, MD, a crafted DOCX part); a sample rendered for real in all four formats`, async () => {
  const r = rng(SEED);
  // rendered carriers: a real TXT, MD and DOCX whose reference title is a placeholder
  const carrier = fixtureRefs(1);
  carrier[0].csl = { ...carrier[0].csl, title: PLACE };
  const txt = new TextDecoder().decode((await render({ ...input(doc("x"), "txt"), refs: carrier, secrets: SECRETS })).bytes);
  const md = new TextDecoder().decode((await render({ ...input(doc("x"), "md"), refs: carrier, secrets: SECRETS })).bytes);
  const docxParts = await zipEntries((await render({ ...input(doc("x"), "docx"), refs: carrier, secrets: SECRETS })).bytes);
  const docXml = new TextDecoder().decode(docxParts.get("word/document.xml")!);
  assert(txt.includes(PLACE) && md.includes(PLACE) && docXml.includes(PLACE), "the carriers hold the placeholder");

  const miss: Record<string, string[]> = { input: [], fresh: [], cached: [], txt: [], md: [], docx: [], rendered: [] };
  const hit: Record<string, number> = { input: 0, fresh: 0, cached: 0, txt: 0, md: 0, docx: 0, rendered: 0, renderedGlyphs: 0 };
  const layerCount: Record<string, number> = {};
  const w = world();
  const resolver = w.deps.resolver;
  try {
    assertEquals((await w.get("path=notes/t/n.md&format=txt")).status, 200); // fills the cache row
    const row = w.cache.get("ref-1")![0];
    const clean = row.csl;
    w.cache.clear();
    for (let i = 0; i < N; i++) {
      const secret = i % 2 === 0 ? KEY : MAIL;
      const { text, layers } = generate(r, secret);
      for (const l of layers.length ? layers : ["none"]) layerCount[l] = (layerCount[l] ?? 0) + 1;
      const label = `#${i} [${layers.join(">") || "none"}] ${esc(text.slice(0, 140))}`;
      const shape: Shape = i % 4 === 1 ? { title: "Mail in author", author: text } : { title: text };
      // input check (the CSL item) - the same function judges a cached row
      const csl = { type: "article-journal", title: shape.title, ...(shape.author ? { author: [{ literal: shape.author }] } : {}) };
      if (resolver.unsafe(csl)) hit.input++; else miss.input.push(label);
      // fresh, through the route: the upstream body (carries) and its CSL item (unsafe)
      w.setShape(shape);
      const f = await w.get("path=notes/t/n.md&format=txt");
      const fb = await f.text();
      if (f.status === 422 && w.cache.size === 0 && !leaks(fb)) hit.fresh++; else miss.fresh.push(`${label} -> ${f.status} cached=${w.cache.size}`);
      w.cache.clear();
      w.setShape(null);
      // cached, through the route: the row as an earlier attempt could have stored it
      w.cache.set("ref-1", [{ ...row, csl: { ...clean, ...csl } as CslItem }]);
      const c = await w.get("path=notes/t/n.md&format=txt");
      const cb = await c.text();
      if (c.status === 422 && /cached record carries credential-shaped text/.test(cb) && !leaks(cb)) hit.cached++; else miss.cached.push(`${label} -> ${c.status}`);
      w.cache.clear();
      // the output verifier over rendered outputs carrying the text where the title was
      const t1 = await verifierCode(() => verifyText(txt.replace(PLACE, text), SECRETS));
      if (t1 === "credential") hit.txt++; else miss.txt.push(`${label} -> ${t1}`);
      const t2 = await verifierCode(() => verifyMarkdown(md.replace(PLACE, mdEscape(text)), SECRETS));
      if (t2 === "credential") hit.md++; else miss.md.push(`${label} -> ${t2}`);
      const parts = new Map(docxParts);
      parts.set("word/document.xml", new TextEncoder().encode(docXml.replace(PLACE, xmlEscape(text))));
      const t3 = await verifierCode(() => verifyDocx(storedZip(parts), SECRETS));
      if (t3 === "credential") hit.docx++; else miss.docx.push(`${label} -> ${t3}`);
      // a sample rendered for real (output stage: the row handed straight to the renderer)
      if (i % 80 === 0) {
        const refs = fixtureRefs(1);
        refs[0].csl = { ...refs[0].csl, ...csl } as CslItem;
        for (const fm of FORMATS) {
          const o = await refusedCredential({ ...input(doc("x"), fm), refs, secrets: SECRETS });
          // refused either way; a PDF whose text no installed face draws is refused 422 glyphs
          // before typesetting (nothing served) - counted apart
          if (o === "credential") hit.rendered++;
          else if (fm === "pdf" && o.startsWith("glyphs:")) hit.renderedGlyphs++;
          else miss.rendered.push(`#${i} ${fm} -> ${o} | text ${JSON.stringify(text)}`);
        }
      }
    }
  } finally {
    resolver.close();
  }
  const marksUsed = Math.min(markCursor, MARKS.length);
  console.log(`A5-2: N=${N} seed=${SEED} | input ${hit.input}/${N} | fresh ${hit.fresh}/${N} | cached ${hit.cached}/${N} | verifier txt ${hit.txt}/${N} md ${hit.md}/${N} docx ${hit.docx}/${N} | rendered ${hit.rendered}/${Math.ceil(N / 80) * 4} credential + ${hit.renderedGlyphs} PDF refused 422 glyphs`);
  console.log(`A5-2: combining marks used ${marksUsed}/${MARKS.length} (every Mn/Mc/Me code point: ${marksUsed === MARKS.length}); default-ignorables pool ${IGNORABLE.length}; layers ${JSON.stringify(layerCount)}`);
  const missed = Object.entries(miss).filter(([, v]) => v.length);
  for (const [k, v] of missed) console.log(`A5-2 MISSED at ${k}: ${v.length}; first: ${v.slice(0, 3).join(" || ")}`);
  assertEquals(marksUsed, MARKS.length, "every combining mark was inserted at least once");
  assertEquals(missed.map(([k, v]) => `${k}:${v.length}`), [], "the secret is detected in every case at every door");
});

// ═════ A5-3: false positives ══════════════════════════════════════════════════════════════════════
const TITLE_WORDS = ("a an the of in on for and with from to by at via under over between among toward " +
  "evidence effects impact analysis study review survey trial cohort panel model models modelling network networks " +
  "learning deep neural graph language large small rural urban education health policy outcomes children adults " +
  "climate change carbon emissions energy solar wind water soil crop yield protein cell gene genome expression " +
  "cancer tumour therapy immune response vaccine virus covid-19 sars-cov-2 bacterial resistance antibiotic " +
  "quantum spin lattice phase transition entropy optimisation algorithm bayesian inference causal estimation " +
  "méthodes économie société über die der und für straße naïve café résumé coöperation 量子 学习 教育 " +
  "2019 2020 2021 2022 2023 ii iii iv 3d 5g ai ml nlp gpt-4 x-ray mri ct pet rna dna crispr-cas9").split(" ");
Deno.test("A5-3 (false positives): canon of 10 000 random real-looking titles never contains canon of a random 32-character key (rate reported)", () => {
  const r = rng(SEED ^ 0x0f0f);
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let hits = 0;
  const T = 10_000;
  const t0 = performance.now();
  for (let i = 0; i < T; i++) {
    const key = Array.from({ length: 32 }, () => ALNUM[Math.floor(r() * ALNUM.length)]).join("");
    const n = 4 + Math.floor(r() * 14);
    let title = Array.from({ length: n }, () => TITLE_WORDS[Math.floor(r() * TITLE_WORDS.length)]).join(" ");
    title = title[0].toUpperCase() + title.slice(1) + (r() < 0.3 ? `: a ${TITLE_WORDS[Math.floor(r() * TITLE_WORDS.length)]} study` : "");
    if (r() < 0.1) title = `<i>${title}</i>`;
    if (secretIn(title, [key]) !== null) hits++;
  }
  console.log(`A5-3: ${hits} of ${T} titles refused for a random 32-char key (rate ${(hits / T).toExponential(2)}); ${(performance.now() - t0).toFixed(0)} ms`);
  assertEquals(hits, 0);
});

// ═════ A5-4: the 422 body ════════════════════════════════════════════════════════════════════════
Deno.test("A5-4 (422 body): a dead reference whose record title carries the configured mailto or key (as written or with a combining mark) is refused 422 with that text withheld - the body never carries it", async () => {
  for (const title of [`Contact ${MAIL} for the data`, "Contact t4-synth.ops@éxample.invalid for the data", `Key ${KEY} here`, "Key T4kq9Źx2Lm7Pw3Rv8Ns5Bd1Hf6Gj0Yc here"]) {
    const w = world({ recordTitle: title, dead: true });
    try {
      for (const f of FORMATS) {
        const r = await w.get(`path=notes/t/n.md&format=${f}`);
        const body = await r.text();
        assertEquals(r.status, 422, `${esc(title)} ${f}: ${r.status}`);
        assert(!leaks(body) && secretIn(body, SECRETS) === null, `${esc(title)} ${f}: the 422 body carries the secret: ${esc(body.slice(0, 400))}`);
        assert(/withheld/.test(body), `${esc(title)} ${f}: the reference is named as withheld`);
        assertEquals(JSON.parse(body).references[0].number, 1, "the reference is still named by its number");
      }
    } finally {
      w.deps.resolver.close();
    }
  }
  // a clean dead reference still names its title (the withholding is for the secret only)
  const w = world({ recordTitle: "An ordinary record title", dead: true });
  try {
    const body = await (await w.get("path=notes/t/n.md&format=txt")).json();
    assertEquals(body.references[0].title, "An ordinary record title");
  } finally {
    w.deps.resolver.close();
  }
});
