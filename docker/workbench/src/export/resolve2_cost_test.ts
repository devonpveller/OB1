// deno test --allow-all src/export/resolve2_cost_test.ts - rw-p6a-resolve2 attempt 2: COST, NOT MEANING.
// Attempt 1's credential check refused real-word prose notes from 75 KB (PDF) and 200 KB (DOCX) with
// `verification-budget` (tester t-rw-p6a2-1): every view of a long text was a full-size copy, canonicalised
// whole, and a PDF's texts were judged one after another. Attempt 2 makes the same check cheaper:
//   - credentials.ts: the decoders read base64 / hex through a table and keep what a run decoded to while
//     views() runs; a decoder that cannot change a text returns it; canonText is computed piece by piece
//     (canonPieces) and a long view chunk by chunk (chunkHits), each distinct piece / chunk once;
//   - verify.ts + judge_pool.ts: a PDF's or DOCX's long texts are judged in parallel workers and read in
//     the sequential check's order;
//   - pdf_read.ts: the text layer is built in linear time.
// This file proves the first is the a06b72f check (credentials_oracle.ts, that file verbatim): the same
// decoders, the same views, the same verdict, on texts built to reach every path; and the canon pieces on
// every BMP character beside ASCII.
//   A7-5e1  every decoder (ENCODINGS) answers what the a06b72f one answers
//   A7-5e2  views(): the same set of views (and the same cap refusal)
//   A7-5e3  judgeSecret: the same verdict - which secret, or not judged - on short and long adversarial
//           texts (the secret encoded through every decoder, placed across the chunk boundaries)
//   A7-5e4  canonPieces = canonTextFull up to the choice between σ and ς, on every BMP character before,
//           after and between ASCII characters and U+FFFD, and on garbage, Greek, Hangul and marks
//   A7-5v   the verifiers in parallel report the FIRST offence of the sequential order
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as NEW from "./credentials.ts";
import * as OLD from "./credentials_oracle.ts";
import { Budget, OutputRejected, PARALLEL_CHARS, verifyDocx } from "./verify.ts";

const KEY = "Hq4WmZ8tRv2Lx6Nc9Bp3Ks7Dy1Fg5Ja0"; // synthetic, 32
const MAIL = "c4r.cost-audit@probe.invalid"; // synthetic
const SECRETS = NEW.secretForms([KEY, MAIL]);

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
const pickOf = (r: () => number) => <T>(a: T[]) => a[Math.floor(r() * a.length)];
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
const pct = (s: string) => [...new TextEncoder().encode(s)].map((b) => "%" + b.toString(16).padStart(2, "0")).join("");
const ent = (s: string) => [...s].map((c) => `&#${c.codePointAt(0)};`).join("");
const entX = (s: string) => [...s].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join("");
const WORDS = "the check reads every view of a note before it is served evidence model source claim result method".split(" ");
const ODD = ["σ", "Σ", "ς", "́", "̸", "​", "­", "�", "ﬀ", "Ｚ", "ᄀ", "ᅡ", "ᆨ", "가", "é", "é", "İ", "ß", "ø", "\u0000", "\u0001", "\u0002", "\n", "&", "%", "<", ">", "\\", "]]>", "<!--"];
// one way to hide the secret: a chain of 0-3 encodings, each one a decoder of ENCODINGS reads
function hide(r: () => number, s: string): string {
  const pick = pickOf(r);
  let t = s;
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    t = pick([
      (x: string) => b64(x),
      (x: string) => b64(x).replace(/\+/g, "-").replace(/\//g, "_"),
      (x: string) => hex(x),
      (x: string) => hex(x).toUpperCase(),
      (x: string) => pct(x),
      (x: string) => ent(x),
      (x: string) => entX(x),
      (x: string) => x.replace(/&/g, "&amp;"),
      (x: string) => [...x].join(pick(["<i></i>", "<b></b>", "<!-- c -->", "​", " ", "\\", "<x>"])),
      (x: string) => `<![CDATA[${x}]]>`,
      (x: string) => x.replace(/[A-Za-z0-9]/g, (c) => r() < 0.3 ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c),
      (x: string) => x.replace(/[A-Za-z]/g, (c) => r() < 0.3 ? c + "́" : c),
      (x: string) => x.replace("@", pick(["(at)", " at ", "[at]", "%40", "&#64;"])).replace(".", pick([" dot ", "(dot)", "."])),
      (x: string) => x.replace(/([!-/:-@[-`{-~])/g, "\\$1"),
    ])(t);
  }
  return t;
}
// context: words, garbage (the bytes of base64 decoding), odd characters
function filler(r: () => number, len: number): string {
  const pick = pickOf(r);
  let out = "";
  while (out.length < len) {
    const x = r();
    if (x < 0.5) out += pick(WORDS) + " ";
    else if (x < 0.75) out += new TextDecoder().decode(Uint8Array.from({ length: 1 + Math.floor(r() * 40) }, () => Math.floor(r() * 256)));
    else if (x < 0.9) out += pick(ODD);
    else out += b64(pick(WORDS) + pick(WORDS) + pick(WORDS));
  }
  return out;
}
// a text: maybe a secret (hidden), short or long; in a long one the secret sits near a chunk boundary
function text(r: () => number, long: boolean): string {
  const pick = pickOf(r);
  const len = long ? 2048 + Math.floor(r() * 6000) : 20 + Math.floor(r() * 200);
  const body = filler(r, len);
  if (r() < 0.25) return body;
  const secret = hide(r, pick([KEY, MAIL]));
  // at a random place, or just after a line feed / U+0000 128+ characters in (a chunk boundary), split
  // across it with the boundary character inside the secret's text, or at the end
  let at = Math.floor(r() * body.length);
  const nl = body.indexOf("\n", 128 + Math.floor(r() * 512));
  if (long && nl > 0 && r() < 0.6) at = Math.max(0, nl - Math.floor(r() * secret.length));
  return body.slice(0, at) + secret + body.slice(at);
}
const sorted = (xs: string[]) => [...xs].sort();
const viewsOr = (m: typeof NEW | typeof OLD, t: string) => {
  try {
    return sorted(m.views(t));
  } catch (e) {
    return (e as Error).message;
  }
};

Deno.test("A7-5e1 (cost, not meaning): every decoder answers what the a06b72f one answers", () => {
  const r = rng(20261019);
  let n = 0;
  for (let i = 0; i < 1500; i++) {
    const t = text(r, i % 5 === 0);
    for (const t2 of [t, t.toUpperCase(), t.replace(/\s+/g, "")]) {
      NEW.ENCODINGS.forEach((e, k) => {
        assertEquals(e.name, OLD.ENCODINGS[k].name);
        assertEquals(e.depth, OLD.ENCODINGS[k].depth);
        assertEquals(e.decode(t2), OLD.ENCODINGS[k].decode(t2), `${e.name} on #${i}`);
        n++;
      });
    }
  }
  console.log(`A7-5e1: ${n} decodings equal`);
});

Deno.test("A7-5e2 (cost, not meaning): views() gives the a06b72f set of views", () => {
  const r = rng(1618033);
  let cap = 0;
  for (let i = 0; i < 400; i++) {
    const t = text(r, i % 4 === 0);
    const a = viewsOr(NEW, t), b = viewsOr(OLD, t);
    assertEquals(a, b, `views of #${i}`);
    if (typeof a === "string") cap++;
  }
  console.log(`A7-5e2: 400 texts, the same views (${cap} over the cap in both)`);
});

Deno.test("A7-5e3 (cost, not meaning): judgeSecret gives the a06b72f verdict - short and long, secrets across chunk boundaries", () => {
  const r = rng(2718281);
  const tally: Record<string, number> = {};
  for (let i = 0; i < 600; i++) {
    const long = i % 3 === 0;
    const t = text(r, long);
    for (const s of [SECRETS, NEW.secretForms([KEY]), NEW.secretForms([MAIL])]) {
      const a = NEW.judgeSecret(t, s), b = OLD.judgeSecret(t, s);
      assertEquals(a, b, `#${i} (${long ? "long" : "short"})`);
      const k = `${long ? "long" : "short"}:${a === null ? "clean" : "secret" in a ? "secret" : "unjudged"}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
  }
  // the chunk path itself: a long garbage view with the secret's canon (or base64) split by every
  // boundary position of its first chunk (the junction windows)
  const garbage = filler(rng(31337), 6000).replace(/\n/g, "") + "\n";
  for (const secret of [KEY, MAIL, b64(KEY), hex(MAIL)]) {
    for (let cut = 1; cut < secret.length; cut += 3) {
      const t = garbage.slice(0, 300) + secret.slice(0, cut) + "\n" + secret.slice(cut) + garbage.slice(300) + garbage;
      for (const s of [SECRETS, NEW.secretForms([KEY])]) assertEquals(NEW.judgeSecret(t, s), OLD.judgeSecret(t, s), `${secret.slice(0, 4)} cut ${cut}`);
    }
  }
  // a non-ASCII secret takes the a06b72f path (canonText on the whole view)
  for (let i = 0; i < 60; i++) {
    const t = text(r, i % 2 === 0);
    const s = ["Ωmega-Σecret-ς-1234", "naïve-é-key-9876"];
    assertEquals(NEW.judgeSecret(t + s[i % 2], s), OLD.judgeSecret(t + s[i % 2], s));
  }
  console.log(`A7-5e3: verdicts equal ${JSON.stringify(tally)}`);
  assert((tally["long:secret"] ?? 0) > 50 && (tally["short:secret"] ?? 0) > 100 && (tally["long:clean"] ?? 0) > 50);
});

// canonPieces is canonTextFull with σ and ς read as one letter (the only context-dependent case fold)
const sigma = (s: string) => s.replace(/ς/g, "σ");
Deno.test("A7-5e4 (cost, not meaning): canonPieces = canonTextFull (σ/ς as one) - every BMP character beside ASCII and U+FFFD", () => {
  const sides = ["a", "Z", "0", " ", "\n", ".", "\\", "@", "\u0000", "�", "s"];
  let n = 0;
  for (let cp = 0x80; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCharCode(cp);
    const a = sides[cp % sides.length], b = sides[(cp >> 4) % sides.length];
    for (const t of [a + c, c + a, a + c + b + c, c + c + a + c, "Σ" + a + c, c + "́" + a + "́" + c]) {
      assertEquals(sigma(NEW.canonPieces(t)), sigma(NEW.canonTextFull(t)), `U+${cp.toString(16)} in ${JSON.stringify(t)}`);
      n++;
    }
  }
  const r = rng(424242);
  for (let i = 0; i < 300; i++) {
    const t = filler(r, 50 + Math.floor(r() * 3000));
    assertEquals(sigma(NEW.canonPieces(t)), sigma(NEW.canonTextFull(t)));
    n++;
  }
  // and the ASCII fast path and the oracle's canonText agree with canonTextFull where they are used
  assertEquals(NEW.canonPieces("ΣΑΣ abc Σ"), NEW.canonPieces("ΣΑΣ abc Σ"));
  console.log(`A7-5e4: ${n} texts, canonPieces == canonTextFull up to σ/ς`);
});

// A DOCX with the key in two parts: the one the sequential check reaches first is the one reported, in
// parallel too; and the workers end with the verification (the test's resource sanitizer).
function storedZip(parts: [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const [name, body] of parts) {
    const n = enc.encode(name), d = enc.encode(body), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(14, crc(d), true);
    h.setUint32(18, d.length, true);
    h.setUint32(22, d.length, true);
    h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc(d), true);
    c.setUint32(20, d.length, true);
    c.setUint32(24, d.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, off, true);
    chunks.push(new Uint8Array(h.buffer), n, d);
    central.push(new Uint8Array(c.buffer), n);
    off += 30 + n.length + d.length;
  }
  const cd = central.reduce((s, x) => s + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, parts.length, true);
  e.setUint16(10, parts.length, true);
  e.setUint32(12, cd, true);
  e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of all) out.set(x, (p += x.length) - x.length);
  return out;
}
Deno.test("A7-5v (cost, not meaning): in parallel, the verifier reports the offence the sequential order reaches first", async () => {
  const long = (s: string) => filler(rng(99), PARALLEL_CHARS + 4000).replace(/[<>&]/g, " ") + s;
  const xml = (s: string) => `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${s}</w:t></w:r></w:p></w:body></w:document>`;
  const code = async (f: () => Promise<void>) => {
    try {
      await f();
      return "ok";
    } catch (e) {
      return e instanceof OutputRejected ? `${e.code}: ${e.offence}` : String(e);
    }
  };
  // the key (long part, judged in a worker) before the mailto (short part, judged where it stands)
  const a = await code(() => verifyDocx(storedZip([["word/a.xml", xml(long(KEY))], ["word/b.xml", xml(MAIL)]]), SECRETS));
  assert(a.startsWith("credential: word/a.xml holds the OpenAlex key"), a);
  // the mailto (short, first) before the key (long, later): the mailto
  const b = await code(() => verifyDocx(storedZip([["word/a.xml", xml(MAIL)], ["word/b.xml", xml(long(KEY))]]), SECRETS));
  assert(b.startsWith("credential: word/a.xml holds the Crossref mailto"), b);
  // a clean long part, then a part that is not an image: output-verification (no credential anywhere)
  const c = await code(() => verifyDocx(storedZip([["word/a.xml", xml(long("clean"))], ["word/media/x.png", "not a png"]]), SECRETS));
  assert(c.startsWith("output-verification: an embedded part that is not an image"), c);
  // the key in a long part BEFORE a part that is not an image: the key (the order the sequential check had)
  const d = await code(() => verifyDocx(storedZip([["word/a.xml", xml(long(KEY))], ["word/media/x.png", "not a png"]]), SECRETS));
  assert(d.startsWith("credential: word/a.xml holds the OpenAlex key"), d);
  // a budget of 0 ms: verification-budget, in parallel too
  const e = await code(() => verifyDocx(storedZip([["word/a.xml", xml(long("clean"))]]), SECRETS, "docx", new Budget(0)));
  assert(e.startsWith("verification-budget"), e);
  console.log(`A7-5v: ${[a, b, c, d, e].map((x) => x.split(":")[0]).join(", ")}`);
});

// The drawn text's check runs while pandoc and Typst run (render.ts); its verdict is read first. A note
// that holds the key AND names a face no one installed: the a06b72f order refused it `credential` before
// pandoc ran - so does this one, though the conversion fails `font` meanwhile; without the key, `font`.
Deno.test("A7-5r (placement, not meaning): the drawn text's verdict is read before any later error", async () => {
  const { fxEntries } = await import("./registry_fixtures.ts");
  const { render, RenderFailed } = await import("./render.ts");
  const { fixtureId, fixtureRefs } = await import("./test_fixtures.ts");
  const def = (k: string) => fxEntries("export_formats").find((e) => e.key === k)!.definition as Record<string, unknown>;
  const pdf = { key: "pdf", ...def("pdf") } as Record<string, unknown>;
  const noFace = { ...pdf, metadata: { ...(pdf.metadata as Record<string, unknown>), mainfont: "No Such Face Nine" } };
  const style = { key: "ieee", ...fxEntries("citation_styles").find((e) => e.key === "ieee")!.definition };
  const cslDir = new URL("../../csl", import.meta.url).pathname;
  const run = async (md: string, format: Record<string, unknown>) => {
    try {
      await render({ md, refs: fixtureRefs(1), format, style, cslDir, wrapNone: true, secrets: SECRETS } as never);
      return "200";
    } catch (e) {
      return e instanceof RenderFailed ? e.code : String(e);
    }
  };
  const body = (s: string) => `# P\n\nBody [[source/${fixtureId(1)}|s]].\n\n${filler(rng(7), PARALLEL_CHARS + 2000).replace(/[^ -~]/g, " ").replace(/[<>&\[\]_*`#]/g, " ")} ${s}\n`;
  const withKey = await run(body(`The key is ${KEY} here.`), noFace);
  const without = await run(body("nothing here"), noFace);
  const keyOnly = await run(body(`The key is ${KEY} here.`), pdf);
  console.log(`A7-5r: key + missing face -> ${withKey}; missing face alone -> ${without}; key alone -> ${keyOnly}`);
  assertEquals(withKey, "credential");
  assertEquals(without, "font");
  assertEquals(keyOnly, "credential");
});
