// Glyph coverage before typesetting (rw-p6a-resolve attempt 2, tester ADV-5: two emoji rendered as
// tofu boxes and the export still answered 200). Typst falls back through EVERY font it can see for a
// character its main face lacks, and draws a .notdef box when none has it - silently. So before a PDF
// is typeset, every character of the text is looked up in the character maps (OpenType `cmap`) of the
// installed faces; a character no face covers refuses the export (422, naming the characters) and
// nothing is drawn. PURE file reading: no fontconfig, no program run, nothing linked.
//
// The faces are the ones Typst sees: the system font directories (and TYPST_FONT_PATHS). Typst's own
// embedded faces (Libertinus Serif, New Computer Modern, DejaVu Sans Mono) cover Latin, Greek,
// Cyrillic and math, all of which the installed Noto Serif CJK / DejaVu faces cover too; math spans
// are not checked here (Typst sets them in its embedded New Computer Modern Math).
// cmap subtables read: format 4 (BMP) and format 12 (full range); format 13 (many-to-one "last
// resort" maps) is deliberately not read - it claims every character and draws boxes.

export const FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts"];

async function* fontFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* fontFiles(p);
    else if ((e.isFile || e.isSymlink) && /\.(ttf|otf|ttc|otc)$/i.test(e.name)) yield p;
  }
}

async function readAt(f: Deno.FsFile, offset: number, length: number): Promise<DataView> {
  await f.seek(offset, Deno.SeekMode.Start);
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = await f.read(buf.subarray(got));
    if (n === null) break;
    got += n;
  }
  return new DataView(buf.buffer, 0, got);
}

const COVER_BYTES = 0x110000 >> 3;
const mark = (bits: Uint8Array, c: number) => {
  if (c >= 0 && c < 0x110000) bits[c >> 3] |= 1 << (c & 7);
};
export const covered = (bits: Uint8Array, c: number) => (bits[c >> 3] & (1 << (c & 7))) !== 0;

// One face (an offset table at `at`): its cmap's best Unicode subtable, marked into `bits`.
async function readFace(f: Deno.FsFile, at: number, bits: Uint8Array) {
  const head = await readAt(f, at, 12);
  if (head.byteLength < 12) return;
  const numTables = head.getUint16(4);
  const dir = await readAt(f, at + 12, numTables * 16);
  let cmapOff = -1, cmapLen = 0;
  for (let i = 0; i < numTables && (i + 1) * 16 <= dir.byteLength; i++) {
    const tag = String.fromCharCode(dir.getUint8(i * 16), dir.getUint8(i * 16 + 1), dir.getUint8(i * 16 + 2), dir.getUint8(i * 16 + 3));
    if (tag === "cmap") {
      cmapOff = dir.getUint32(i * 16 + 8);
      cmapLen = dir.getUint32(i * 16 + 12);
    }
  }
  if (cmapOff < 0 || cmapLen < 4 || cmapLen > 64 * 1024 * 1024) return;
  const cm = await readAt(f, cmapOff, cmapLen);
  const n = cm.getUint16(2);
  const subs: { pid: number; eid: number; off: number; fmt: number }[] = [];
  for (let i = 0; i < n && 4 + i * 8 + 8 <= cm.byteLength; i++) {
    const off = cm.getUint32(4 + i * 8 + 4);
    if (off + 2 > cm.byteLength) continue;
    subs.push({ pid: cm.getUint16(4 + i * 8), eid: cm.getUint16(4 + i * 8 + 2), off, fmt: cm.getUint16(off) });
  }
  const unicode = (s: { pid: number; eid: number }) => s.pid === 0 || (s.pid === 3 && (s.eid === 1 || s.eid === 10));
  for (const s of subs.filter(unicode)) {
    if (s.fmt === 12) {
      const groups = cm.getUint32(s.off + 12);
      for (let g = 0; g < groups && s.off + 16 + g * 12 + 12 <= cm.byteLength; g++) {
        const p = s.off + 16 + g * 12;
        const start = cm.getUint32(p), end = cm.getUint32(p + 4), glyph = cm.getUint32(p + 8);
        for (let c = start; c <= end && c < 0x110000; c++) if (glyph + (c - start) !== 0) mark(bits, c);
      }
    } else if (s.fmt === 4) {
      const segX2 = cm.getUint16(s.off + 6);
      const ends = s.off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let k = 0; k < segX2 / 2 && ranges + k * 2 + 2 <= cm.byteLength; k++) {
        const end = cm.getUint16(ends + k * 2), start = cm.getUint16(starts + k * 2);
        const delta = cm.getInt16(deltas + k * 2), ro = cm.getUint16(ranges + k * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (ro === 0) glyph = (c + delta) & 0xffff;
          else {
            const gp = ranges + k * 2 + ro + (c - start) * 2;
            if (gp + 2 > cm.byteLength) continue;
            glyph = cm.getUint16(gp);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) mark(bits, c);
        }
      }
    }
  }
}

// The union of what every installed face covers, as a bitmap over U+0000..U+10FFFF.
export async function installedCoverage(dirs: string[] = fontDirs()): Promise<{ bits: Uint8Array; faces: number }> {
  const bits = new Uint8Array(COVER_BYTES);
  let faces = 0;
  for (const d of dirs) {
    for await (const p of fontFiles(d)) {
      let f: Deno.FsFile | null = null;
      try {
        f = await Deno.open(p, { read: true });
        const h = await readAt(f, 0, 12);
        if (h.byteLength < 12) continue;
        const tag = h.getUint32(0);
        if (tag === 0x74746366) { // 'ttcf': a collection
          const count = h.getUint32(8);
          const offs = await readAt(f, 12, Math.min(count, 256) * 4);
          for (let i = 0; i * 4 + 4 <= offs.byteLength; i++) {
            await readFace(f, offs.getUint32(i * 4), bits);
            faces++;
          }
        } else if (tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565) { // TrueType, 'OTTO', 'true'
          await readFace(f, 0, bits);
          faces++;
        }
      } catch {
        // an unreadable font file covers nothing
      } finally {
        f?.close();
      }
    }
  }
  return { bits, faces };
}

export const fontDirs = () => [...FONT_DIRS, ...(Deno.env.get("TYPST_FONT_PATHS") ?? "").split(":").filter(Boolean)];

let cache: Promise<{ bits: Uint8Array; faces: number }> | null = null;
export const coverage = () => (cache ??= installedCoverage());

// Characters that draw nothing on their own (joiners, variation selectors, tags, the BOM, controls):
// never a box, so never a reason to refuse.
const IGNORABLE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8]|[\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;

// Math spans ($..$, $$..$$) are typeset by Typst's embedded math face, not checked here.
export const withoutMath = (md: string) => md.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/(^|[^\\$])\$(?=\S)([^$\n]*?\S)\$(?![0-9])/g, "$1 ");

// The distinct characters of `text` no installed face covers, in order of first appearance.
export async function uncovered(text: string, bits?: Uint8Array): Promise<number[]> {
  const b = bits ?? (await coverage()).bits;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || seen.has(c) || IGNORABLE.test(ch)) continue;
    seen.add(c);
    if (!covered(b, c)) out.push(c);
  }
  return out;
}

export const describe = (cps: number[]) =>
  cps.slice(0, 20).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`).join(", ") + (cps.length > 20 ? ` and ${cps.length - 20} more` : "");
