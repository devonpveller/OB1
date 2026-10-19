// Reading a produced PDF back, at RUNTIME (rw-p6a-resolve attempt 3: the output verification). PURE
// TypeScript over the bytes: no poppler (GPL, test stage only), no program run, nothing linked.
//
// What it reads: every indirect object (and the objects inside object streams), parsed into values;
// the Flate-encoded streams inflated; each page's content streams (and the form XObjects they draw)
// interpreted far enough to know which font draws which character codes. From that:
//   - actions(): every action and link target - URI actions with their URIs, and any other action
//     type, JavaScript, a launch, an open action, additional actions, an embedded file;
//   - text(): the text layer through each font's ToUnicode map, plus every string in the document's
//     dictionaries (outline titles, link contents, the info dictionary) and the XMP metadata;
//   - notdef(): the glyphs drawn with code 0 in a composite (Type0, Identity) font - the .notdef box
//     Typst draws when no face has the character (the tester's code-span and math boxes).
// A PDF this cannot read is not "clean": the caller fails closed.

export type PdfValue = number | boolean | null | string | PdfName | PdfRef | PdfString | PdfValue[] | PdfDict;
export class PdfName {
  constructor(public name: string) {}
}
export class PdfRef {
  constructor(public num: number, public gen: number) {}
}
export class PdfString {
  constructor(public bytes: Uint8Array) {}
  get latin1() {
    return String.fromCharCode(...this.bytes);
  }
  // PDFDocEncoding (Latin-1 here, close enough for a check) or UTF-16BE with its BOM
  get text() {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
    return this.latin1;
  }
}
export type PdfDict = Map<string, PdfValue>;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

// A tokenizer + parser over PDF object syntax (also content streams: operators come back as bare
// strings).
class Lexer {
  i = 0;
  constructor(public b: Uint8Array, start = 0, public end = b.length) {
    this.i = start;
  }
  skip() {
    const b = this.b;
    while (this.i < this.end) {
      if (WS.has(b[this.i])) this.i++;
      else if (b[this.i] === 0x25) { // comment
        while (this.i < this.end && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++;
      } else break;
    }
  }
  eof() {
    this.skip();
    return this.i >= this.end;
  }
  // one value; a bare keyword (operator, `obj`, `R`, `stream`) comes back as a string
  value(depth = 0): PdfValue {
    if (depth > 200) throw new Error("PDF nesting too deep");
    this.skip();
    const b = this.b;
    const c = b[this.i];
    if (c === 0x2f) { // name
      let j = this.i + 1;
      while (j < this.end && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
      const raw = String.fromCharCode(...b.subarray(this.i + 1, j)).replace(/#([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
      this.i = j;
      return new PdfName(raw);
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c && b[this.i + 1] === 0x3c) { // dict
      this.i += 2;
      const d: PdfDict = new Map();
      for (;;) {
        this.skip();
        if (this.i >= this.end) throw new Error("unterminated dictionary");
        if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) {
          this.i += 2;
          return d;
        }
        const k = this.value(depth + 1);
        if (!(k instanceof PdfName)) throw new Error("dictionary key is not a name");
        d.set(k.name, this.ref(this.value(depth + 1)));
      }
    }
    if (c === 0x3c) { // hex string
      const close = b.indexOf(0x3e, this.i);
      if (close < 0 || close > this.end) throw new Error("unterminated hex string");
      const hex = String.fromCharCode(...b.subarray(this.i + 1, close)).replace(/[^0-9a-fA-F]/g, "");
      const h = hex.length % 2 ? hex + "0" : hex;
      const out = new Uint8Array(h.length / 2);
      for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16);
      this.i = close + 1;
      return new PdfString(out);
    }
    if (c === 0x5b) { // array
      this.i++;
      const a: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.i >= this.end) throw new Error("unterminated array");
        if (b[this.i] === 0x5d) {
          this.i++;
          return a;
        }
        a.push(this.value(depth + 1));
        this.collapseRef(a);
      }
    }
    if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.i++;
      return String.fromCharCode(c);
    }
    let j = this.i;
    while (j < this.end && !WS.has(b[j]) && !DELIM.has(b[j])) j++;
    if (j === this.i) j++;
    const tok = String.fromCharCode(...b.subarray(this.i, j));
    this.i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    return tok; // a keyword or an operator
  }
  // `n g R` inside an array: three values -> one reference
  collapseRef(a: PdfValue[]) {
    const n = a.length;
    if (n >= 3 && a[n - 1] === "R" && typeof a[n - 2] === "number" && typeof a[n - 3] === "number") {
      a.splice(n - 3, 3, new PdfRef(a[n - 3] as number, a[n - 2] as number));
    }
  }
  // a dict value that is `n g R`: read ahead
  ref(v: PdfValue): PdfValue {
    if (typeof v !== "number") return v;
    const save = this.i;
    const g = this.value();
    if (typeof g === "number") {
      const r = this.value();
      if (r === "R") return new PdfRef(v, g);
    }
    this.i = save;
    return v;
  }
  literal(): PdfString {
    const b = this.b;
    let i = this.i + 1, depth = 1;
    const out: number[] = [];
    while (i < this.end) {
      const c = b[i];
      if (c === 0x5c) {
        const n = b[i + 1];
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (n in map) {
          out.push(map[n]);
          i += 2;
        } else if (n >= 0x30 && n <= 0x37) {
          let k = i + 1, v = 0, d = 0;
          while (d < 3 && b[k] >= 0x30 && b[k] <= 0x37) {
            v = v * 8 + (b[k] - 0x30);
            k++;
            d++;
          }
          out.push(v & 0xff);
          i = k;
        } else if (n === 0x0d || n === 0x0a) {
          i += 2;
          if (n === 0x0d && b[i] === 0x0a) i++;
        } else {
          out.push(n);
          i += 2;
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
      i++;
    }
    if (depth !== 0) throw new Error("unterminated string");
    this.i = i + 1;
    return new PdfString(new Uint8Array(out));
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export interface PdfObject {
  value: PdfValue;
  stream?: Uint8Array; // decoded (Flate inflated; other filters left as they are)
  filtered?: boolean; // a filter this reader does not decode
}

const name = (v: PdfValue | undefined) => (v instanceof PdfName ? v.name : undefined);

export class PdfDocument {
  objects = new Map<number, PdfObject>();
  private constructor(public bytes: Uint8Array) {}

  static async read(bytes: Uint8Array): Promise<PdfDocument> {
    const doc = new PdfDocument(bytes);
    const s = new TextDecoder("latin1").decode(bytes);
    if (!s.startsWith("%PDF-")) throw new Error("not a PDF");
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const lx = new Lexer(bytes, m.index + m[0].length);
      let value: PdfValue;
      try {
        value = lx.value();
      } catch {
        continue; // "n g obj" inside binary data, not an object
      }
      const obj: PdfObject = { value };
      lx.skip();
      if (value instanceof Map && s.startsWith("stream", lx.i)) {
        let ds = lx.i + 6;
        if (bytes[ds] === 0x0d) ds++;
        if (bytes[ds] === 0x0a) ds++;
        const lenV = value.get("Length");
        let len = typeof lenV === "number" ? lenV : -1;
        if (len < 0 || ds + len > bytes.length) len = s.indexOf("endstream", ds) - ds;
        const raw = bytes.subarray(ds, ds + Math.max(0, len));
        const filters = [value.get("Filter")].flat().map((f) => name(f as PdfValue)).filter(Boolean);
        if (filters.length === 0) obj.stream = raw;
        else if (filters.length === 1 && filters[0] === "FlateDecode") obj.stream = await inflate(raw);
        else {
          obj.stream = raw;
          obj.filtered = true;
        }
        re.lastIndex = ds + Math.max(0, len);
      } else re.lastIndex = lx.i;
      doc.objects.set(Number(m[1]), obj);
    }
    // object streams: their objects too
    for (const o of [...doc.objects.values()]) {
      const d = o.value instanceof Map ? o.value : null;
      if (!d || name(d.get("Type")) !== "ObjStm" || !o.stream || o.filtered) continue;
      const n = Number(d.get("N")), first = Number(d.get("First"));
      const head = new Lexer(o.stream, 0, first);
      const pairs: [number, number][] = [];
      for (let k = 0; k < n; k++) pairs.push([Number(head.value()), Number(head.value())]);
      for (const [num, off] of pairs) {
        try {
          doc.objects.set(num, { value: new Lexer(o.stream, first + off).value() });
        } catch { /* skipped */ }
      }
    }
    if (doc.objects.size === 0) throw new Error("no objects");
    return doc;
  }

  get(v: PdfValue | undefined): PdfValue | undefined {
    let x = v;
    for (let k = 0; k < 16 && x instanceof PdfRef; k++) x = this.objects.get(x.num)?.value;
    return x;
  }
  dict(v: PdfValue | undefined): PdfDict | undefined {
    const x = this.get(v);
    return x instanceof Map ? x : undefined;
  }

  // Every value in every object, recursively, with the dictionary key it sits under.
  *walk(): Generator<{ key: string | null; value: PdfValue; parent: PdfDict | null }> {
    const stack: { key: string | null; value: PdfValue; parent: PdfDict | null }[] = [...this.objects.values()].map((o) => ({ key: null, value: o.value, parent: null }));
    while (stack.length) {
      const e = stack.pop()!;
      yield e;
      if (e.value instanceof Map) for (const [k, v] of e.value) stack.push({ key: k, value: v, parent: e.value });
      else if (Array.isArray(e.value)) for (const v of e.value) stack.push({ key: e.key, value: v, parent: e.parent });
    }
  }

  // Every action and every link target the document carries.
  actions(): { kind: string; target?: string }[] {
    const out: { kind: string; target?: string }[] = [];
    for (const { key, value, parent } of this.walk()) {
      if (key && ["JS", "JavaScript", "OpenAction", "AA", "Launch", "EmbeddedFile", "EmbeddedFiles", "RichMedia", "SubmitForm", "ImportData"].includes(key)) {
        out.push({ kind: key });
      }
      // an action: a dictionary of /Type /Action, or the value of /A, /Next, /OpenAction or an /AA entry
      const isAction = value instanceof Map && value.has("S") &&
        (name(value.get("Type")) === "Action" || (key !== null && ["A", "Next", "OpenAction", "PA"].includes(key))); // (an /AA is refused as such)
      if (value instanceof Map && isAction) {
        const s = name(value.get("S")) ?? "?";
        if (s === "URI") {
          const u = this.get(value.get("URI"));
          out.push({ kind: "URI", target: u instanceof PdfString ? u.latin1 : String(u) });
        } else out.push({ kind: s });
      }
      if (key === "URI" && parent && !parent.has("S")) {
        const u = this.get(value);
        out.push({ kind: "URI", target: u instanceof PdfString ? u.latin1 : String(u) });
      }
    }
    return out;
  }

  // Every string in the dictionaries (titles, link contents, the info dictionary) and the XMP text.
  dictStrings(): string[] {
    const out: string[] = [];
    for (const { value } of this.walk()) if (value instanceof PdfString) out.push(value.text);
    for (const o of this.objects.values()) {
      const d = o.value instanceof Map ? o.value : null;
      if (d && name(d.get("Type")) === "Metadata" && o.stream) out.push(new TextDecoder().decode(o.stream));
    }
    return out;
  }

  // The pages, in order.
  pages(): PdfDict[] {
    const out: PdfDict[] = [];
    const seen = new Set<PdfDict>();
    const root = this.dict([...this.objects.values()].map((o) => o.value).find((v) => v instanceof Map && name(v.get("Type")) === "Catalog") ?? undefined);
    const visit = (v: PdfValue | undefined, inherited: PdfValue | undefined, depth: number) => {
      const d = this.dict(v);
      if (!d || seen.has(d) || depth > 64) return;
      seen.add(d);
      const res = d.get("Resources") ?? inherited;
      if (name(d.get("Type")) === "Pages") for (const k of (this.get(d.get("Kids")) as PdfValue[]) ?? []) visit(k, res, depth + 1);
      else {
        if (!d.has("Resources") && res) d.set("Resources", res);
        out.push(d);
      }
    };
    if (root) visit(root.get("Pages"), undefined, 0);
    if (!out.length) { // no page tree found: every page object
      for (const o of this.objects.values()) if (o.value instanceof Map && name(o.value.get("Type")) === "Page") out.push(o.value);
    }
    return out;
  }

  // The text layer and the .notdef glyphs, page by page through the content streams. `body` is the
  // same layer without the page furniture: a text object (BT .. ET) that is only a page number. A run of
  // text that crosses a page break has the footer's number inside it in `text` (attempt 6: a base64 run
  // split by the page number `1` hid the key from the decoders - property text seed 123456789 #1920).
  async glyphs(): Promise<{ text: string; body: string; notdef: { font: string; count: number }[] }> {
    let text = "";
    const furniture: [number, number][] = [];
    let objStart = -1;
    // rw-p6a-resolve2 attempt 2 (cost): what was added to `text` since the open BT, kept apart - the ET
    // test read text.slice(objStart), which flattens the whole layer built so far at every ET (quadratic
    // in the layer: 2.3 s for a 400 KB note). The same string: while a text object is open, every addition
    // goes to both.
    let obj = "";
    const add = (s: string) => {
      text += s;
      if (objStart >= 0) obj += s;
    };
    const notdef = new Map<string, number>();
    const fontCache = new Map<PdfDict, { two: boolean; map: Map<number, string>; label: string }>();
    const fontOf = (fd: PdfDict) => {
      let f = fontCache.get(fd);
      if (f) return f;
      const sub = name(fd.get("Subtype"));
      const two = sub === "Type0";
      const map = new Map<number, string>();
      const tu = fd.get("ToUnicode");
      const tuObj = tu instanceof PdfRef ? this.objects.get(tu.num) : undefined;
      if (tuObj?.stream) parseCMap(new TextDecoder("latin1").decode(tuObj.stream), map);
      f = { two, map, label: name(fd.get("BaseFont")) ?? sub ?? "font" };
      fontCache.set(fd, f);
      return f;
    };
    const run = (data: Uint8Array, resources: PdfDict | undefined, depth: number) => {
      if (depth > 16) throw new Error("form XObjects nest too deep");
      const fonts = this.dict(resources?.get("Font"));
      const xobjects = this.dict(resources?.get("XObject"));
      const lx = new Lexer(data);
      const ops: PdfValue[] = [];
      let font: ReturnType<typeof fontOf> | null = null;
      const show = (s: PdfValue) => {
        if (!(s instanceof PdfString) || !font) return;
        const b = s.bytes;
        if (font.two) {
          for (let k = 0; k + 1 < b.length; k += 2) {
            const code = (b[k] << 8) | b[k + 1];
            if (code === 0) notdef.set(font.label, (notdef.get(font.label) ?? 0) + 1);
            add(font.map.get(code) ?? "");
          }
        } else for (const c of b) add(font.map.get(c) ?? String.fromCharCode(c));
      };
      while (!lx.eof()) {
        const v = lx.value();
        if (typeof v === "string") {
          const op = v;
          if (op === "BI") { // inline image: skip its data to EI
            const s = new TextDecoder("latin1").decode(data);
            const e = s.indexOf("EI", lx.i);
            lx.i = e < 0 ? data.length : e + 2;
          } else if (op === "Tf") {
            const fd = this.dict(fonts?.get(name(ops[ops.length - 2]) ?? ""));
            font = fd ? fontOf(fd) : null;
          } else if (op === "Tj" || op === "'") show(ops[ops.length - 1]);
          else if (op === '"') show(ops[ops.length - 1]);
          else if (op === "TJ") for (const x of (ops[ops.length - 1] as PdfValue[]) ?? []) show(x);
          else if (op === "Do") {
            const ref = xobjects?.get(name(ops[ops.length - 1]) ?? "");
            const xo = ref instanceof PdfRef ? this.objects.get(ref.num) : undefined;
            const xd = xo?.value instanceof Map ? xo.value : null;
            if (xd && name(xd.get("Subtype")) === "Form" && xo?.stream) {
              if (xo.filtered) throw new Error("a form XObject with a filter this reader does not decode");
              run(xo.stream, this.dict(xd.get("Resources")) ?? resources, depth + 1);
            }
          } else if (op === "BT") {
            objStart = text.length;
            obj = "";
          } else if (op === "ET") {
            if (objStart >= 0 && /^\s*\d{1,6}\s*$/.test(obj)) furniture.push([objStart, text.length]);
            objStart = -1;
            obj = "";
            add(" ");
          }
          ops.length = 0;
        } else ops.push(v);
      }
    };
    for (const p of this.pages()) {
      const res = this.dict(p.get("Resources"));
      const cs = p.get("Contents");
      const list = cs instanceof PdfRef && Array.isArray(this.get(cs)) ? this.get(cs) as PdfValue[] : Array.isArray(cs) ? cs : [cs];
      for (const c of list) {
        const o = c instanceof PdfRef ? this.objects.get(c.num) : undefined;
        if (!o?.stream) continue;
        if (o.filtered) throw new Error("a content stream with a filter this reader does not decode");
        run(o.stream, res, 0);
      }
      add("\n");
    }
    let body = "";
    let at = 0;
    for (const [a, b] of furniture) {
      body += text.slice(at, a);
      at = b;
    }
    body += text.slice(at);
    return { text, body, notdef: [...notdef].map(([font, count]) => ({ font, count })) };
  }
}

// A ToUnicode CMap: bfchar and bfrange entries -> code -> text.
export function parseCMap(s: string, map: Map<number, string>) {
  const hex = (h: string) => parseInt(h, 16);
  const utf16 = (h: string) => {
    const units: number[] = [];
    for (let k = 0; k + 3 < h.length; k += 4) units.push(parseInt(h.slice(k, k + 4), 16));
    if (h.length === 2) units.push(parseInt(h, 16));
    return String.fromCharCode(...units);
  };
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hex(m[1]), utf16(m[2]));
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = hex(m[1]), hi = Math.min(hex(m[2]), hex(m[1]) + 65535);
      if (m[4] !== undefined) {
        const base = m[4];
        for (let c = lo; c <= hi; c++) {
          const last = parseInt(base.slice(-4) || "0", 16) + (c - lo);
          map.set(c, utf16(base.slice(0, -4) + last.toString(16).padStart(4, "0")));
        }
      } else {
        const items = [...(m[5] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]);
        items.forEach((h, k) => map.set(lo + k, utf16(h)));
      }
    }
  }
}
