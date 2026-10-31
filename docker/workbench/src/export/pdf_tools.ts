// Reading a rendered PDF back, for the export's tests (research-workbench P6a). poppler-utils is
// GPL: pdftotext, pdffonts, pdfinfo and pdftoppm run here as SEPARATE PROCESSES over files, never
// linked (D9). These readers are the tests'; since P6b poppler is also in the runtime image, where only the
// verification gate (gate.ts) runs pdftoppm.

async function run(cmd: string, args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "piped" }).output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${new TextDecoder().decode(stderr).slice(0, 500)}`);
  return new TextDecoder().decode(stdout);
}

async function withFile<T>(pdf: Uint8Array, fn: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "ob-pdfcheck-" });
  try {
    await Deno.writeFile(`${dir}/doc.pdf`, pdf);
    return await fn(`${dir}/doc.pdf`, dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

export const pdfText = (pdf: Uint8Array, layout = false) =>
  withFile(pdf, (p) => run("pdftotext", [...(layout ? ["-layout"] : []), "-enc", "UTF-8", p, "-"]));

export const pdfFonts = (pdf: Uint8Array) =>
  withFile(pdf, async (p) =>
    (await run("pdffonts", [p])).split("\n").slice(2).map((l) => l.split(/\s+/)[0]).filter(Boolean));

export const pdfPages = (pdf: Uint8Array) =>
  withFile(pdf, async (p) => Number(/^Pages:\s+(\d+)/m.exec(await run("pdfinfo", [p]))?.[1] ?? NaN));

// Page 1's size in points (pdfinfo "Page size: W x H pts").
export const pdfPageSize = (pdf: Uint8Array) =>
  withFile(pdf, async (p) => {
    const m = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(await run("pdfinfo", [p]));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  });

export interface Raster {
  width: number;
  height: number;
  pixels: Uint8Array; // 8-bit grey, row-major
}

// pdftoppm -gray: one binary PGM (P5) per page.
export const pdfRaster = (pdf: Uint8Array, page = 1, dpi = 100) =>
  withFile(pdf, async (p, dir) => {
    await run("pdftoppm", ["-gray", "-r", String(dpi), "-f", String(page), "-l", String(page), p, `${dir}/page`]);
    const name = [...Deno.readDirSync(dir)].map((e) => e.name).find((n) => n.endsWith(".pgm"));
    if (!name) throw new Error("pdftoppm wrote no page");
    return parsePgm(await Deno.readFile(`${dir}/${name}`));
  });

export function parsePgm(b: Uint8Array): Raster {
  // header: P5 <ws> width <ws> height <ws> maxval <single ws> data
  let i = 0;
  const tok = () => {
    while (/\s/.test(String.fromCharCode(b[i]))) i++;
    let s = "";
    while (!/\s/.test(String.fromCharCode(b[i]))) s += String.fromCharCode(b[i++]);
    return s;
  };
  if (tok() !== "P5") throw new Error("not a binary PGM");
  const width = Number(tok());
  const height = Number(tok());
  if (Number(tok()) !== 255) throw new Error("PGM maxval is not 255");
  i++;
  return { width, height, pixels: b.subarray(i, i + width * height) };
}

// The share of pixels whose grey level differs by more than `tol` (the two pages same size).
export function rasterDifference(a: Raster, b: Raster, tol = 32): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0;
  for (let k = 0; k < a.pixels.length; k++) if (Math.abs(a.pixels[k] - b.pixels[k]) > tol) n++;
  return n / a.pixels.length;
}

export const inkShare = (r: Raster) => r.pixels.reduce((n, v) => n + (v < 128 ? 1 : 0), 0) / r.pixels.length;

// Acceptance 4: a PDF renders CJK text with real glyphs. Three properties, all required:
//   (1) the text layer carries the CJK fixture text (nothing dropped);
//   (2) a CJK face is embedded (pdffonts);
//   (3) the page differs visibly from the same document rendered WITHOUT any CJK face (Typst
//       --ignore-system-fonts: every CJK character becomes the same .notdef box) - so a page of
//       tofu cannot pass, whatever its text layer says.
export async function cjkGlyphCheck(pdf: Uint8Array, tofuControl: Uint8Array, expected: string) {
  const reasons: string[] = [];
  const text = (await pdfText(pdf)).replace(/\s+/g, "");
  if (!text.includes(expected.replace(/\s+/g, ""))) reasons.push("the text layer lacks the CJK fixture text");
  const fonts = await pdfFonts(pdf);
  if (!fonts.some((f) => /CJK/i.test(f))) reasons.push(`no CJK face is embedded (fonts: ${fonts.join(", ")})`);
  const [a, b] = [await pdfRaster(pdf), await pdfRaster(tofuControl)];
  const diff = rasterDifference(a, b);
  if (diff < 0.005) reasons.push(`the page is indistinguishable from the no-CJK-font control (difference ${(diff * 100).toFixed(3)}%)`);
  return { ok: reasons.length === 0, reasons, fonts, difference: diff, ink: inkShare(a), controlInk: inkShare(b) };
}
