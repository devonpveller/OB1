// Realistic raster fixtures for the export's tests (rw-p6a-resolve2, the reviewer's B1). The export
// vault's own images are 70-byte PNGs, so no suite ever verified an output holding an image of a real
// size. Generated here, seeded, at test time (no binary is committed):
//   screenshotPng  the reviewer's synthetic 1200x800 "screenshot" (flat panels with text-like noise,
//                  gradients, a noisy photo-like third), PNG-encoded: about 1.5 MB;
//   noiseJpeg      a baseline (SOF0) greyscale JPEG of seeded noise: a real JPEG (DQT, SOF0, DHT,
//                  SOS, Huffman-coded DCT blocks), about 2.5 MB at the default size.
// Compressed image data is near-random, which is what made the verifier's full invariant slow.

function xorshift(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x & 255;
  };
}

async function zlib(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (const b of p) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [be32(data.length), t, data, be32(crc32([t, data]))];
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// The reviewer's screenshot (journal/evidence/rw-p6a-resolve/review-r-rw-p6a/views_deflate.ts), as a PNG.
export async function screenshotPng(w = 1200, h = 800, seed = 12345): Promise<Uint8Array> {
  const r = xorshift(seed);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3); // filter byte 0 (None)
    for (let c = 0; c < w; c++) {
      const i = row + 1 + c * 3;
      if (c < w / 3) {
        raw[i] = 240, raw[i + 1] = 240, raw[i + 2] = 245;
        if ((y % 18) < 10 && (r() & 3) === 0) raw[i] = raw[i + 1] = raw[i + 2] = 30;
      } else if (c < 2 * w / 3) {
        raw[i] = (c + y) & 255, raw[i + 1] = (c * 2) & 255, raw[i + 2] = y & 255;
      } else {
        raw[i] = (128 + (r() >> 2)) & 255, raw[i + 1] = (100 + (r() >> 2)) & 255, raw[i + 2] = (90 + (r() >> 3)) & 255;
      }
    }
  }
  const ihdr = concat([be32(w), be32(h), Uint8Array.of(8, 2, 0, 0, 0)]); // 8-bit RGB
  return concat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), ...chunk("IHDR", ihdr), ...chunk("IDAT", await zlib(raw)), ...chunk("IEND", new Uint8Array())]);
}

// ── a baseline greyscale JPEG encoder (ITU T.81 sequential DCT, one component, 8-bit) ────────────
// The Huffman tables are canonical and uniform (every DC category 0-11 a 4-bit code, every AC symbol
// - EOB, ZRL and run/size 0-15/1-10 - an 8-bit code): valid tables any decoder reads; the file is
// larger than an optimised one, which is what a noise fixture wants.
const ZIGZAG = (() => {
  const z: number[] = [];
  for (let s = 0; s < 15; s++) {
    const cells: number[] = [];
    for (let y = 0; y < 8; y++) { const x = s - y; if (x >= 0 && x < 8) cells.push(y * 8 + x); }
    z.push(...(s % 2 === 0 ? cells.reverse() : cells)); // 0, 1, 8, 16, 9, 2, ...
  }
  return z;
})();
const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)));
const C = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);

export function noiseJpeg(w = 1440, h = 1280, q = 6, seed = 271828): Uint8Array {
  const r = xorshift(seed);
  const px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = r();
  const out: number[] = [];
  const marker = (m: number, body: number[]) => out.push(0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  out.push(0xff, 0xd8);
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
  marker(0xdb, [0, ...new Array(64).fill(q)]); // one flat quantisation table
  marker(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const dcSyms = Array.from({ length: 12 }, (_, i) => i);
  const acSyms = [0x00, 0xf0];
  for (let run = 0; run < 16; run++) for (let size = 1; size <= 10; size++) acSyms.push((run << 4) | size);
  const counts = (len: number, n: number) => Array.from({ length: 16 }, (_, i) => (i + 1 === len ? n : 0));
  marker(0xc4, [0x00, ...counts(4, dcSyms.length), ...dcSyms, 0x10, ...counts(8, acSyms.length), ...acSyms]);
  marker(0xda, [1, 1, 0x00, 0, 63, 0]);
  // canonical codes: consecutive values at one length
  const dcCode = new Map(dcSyms.map((s, i) => [s, i]));
  const acCode = new Map(acSyms.map((s, i) => [s, i]));
  let acc = 0, nbits = 0;
  const put = (v: number, n: number) => {
    for (let k = n - 1; k >= 0; k--) {
      acc = (acc << 1) | ((v >> k) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0, nbits = 0;
      }
    }
  };
  const category = (v: number) => (v === 0 ? 0 : 32 - Math.clz32(Math.abs(v)));
  const bits = (v: number, s: number) => (v >= 0 ? v : v + (1 << s) - 1);
  let pred = 0;
  const blk = new Float64Array(64), coef = new Int32Array(64);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = px[Math.min(by + y, h - 1) * w + Math.min(bx + x, w - 1)] - 128;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * COS[u][x] * COS[v][y];
          coef[v * 8 + u] = Math.round((0.25 * C(u) * C(v) * s) / q);
        }
      }
      const dc = coef[0], diff = dc - pred;
      pred = dc;
      const ds = category(diff);
      put(dcCode.get(ds)!, 4);
      if (ds) put(bits(diff, ds), ds);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const c = coef[ZIGZAG[k]];
        if (c === 0) { run++; continue; }
        while (run > 15) { put(acCode.get(0xf0)!, 8); run -= 16; }
        const s = Math.min(category(c), 10);
        const cv = Math.max(-1023, Math.min(1023, c));
        put(acCode.get((run << 4) | s)!, 8);
        put(bits(cv, s), s);
        run = 0;
      }
      if (run) put(acCode.get(0x00)!, 8);
    }
  }
  if (nbits) put(0x7f, 8 - nbits); // pad with 1 bits
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

// A PNG with a tEXt chunk (keyword, text) put before its IEND: still a real PNG (valid CRCs).
export function pngWithText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const iend = png.length - 12;
  return concat([png.slice(0, iend), ...chunk("tEXt", new TextEncoder().encode(`${keyword}\0${text}`)), png.slice(iend)]);
}
