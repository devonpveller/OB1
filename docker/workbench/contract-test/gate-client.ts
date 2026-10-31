// The HTTP side of the P6b disposable run (rw-p6b-gate), run INSIDE a container of the workbench's
// TEST image (poppler for reading PDFs back) on the run's internal network by run-export-gate-tests.ps1.
// Never pointed at a live workbench.
//
//   req <METHOD> <url> <out-file> [<subject>] [<json-body> | @<file>]
//        X-Brain-Key from $WB_KEY, X-Test-Sub: <subject> (the lab's identity header); writes the body;
//        prints one JSON line {status, bytes, export_id, gate, type}
//   parity <panel.json> <pdf>
//        acceptance 2, written independently of the gate: the reference PANEL's list (`listed` of GET
//        /workbench/documents/references - what the panel shows and copies) against the PDF's numbered
//        reference list read back with pdftotext, position by position: the same count, the same
//        numbers, entry i holding panel title i as whole words. PARITY PASS / PARITY FAIL; exit 1 on a
//        mismatch. `parity <panel.json> <pdf> author-date`: an unnumbered (author-date) list, its entries read
//        as poppler's text blocks after "References", the position being the number (round 3, D10).
//   text <pdf>   the PDF's text (pdftotext -layout)
import { pdfText } from "/app/src/export/pdf_tools.ts";

const [mode, ...args] = Deno.args;
const key = Deno.env.get("WB_KEY") ?? "";

// RTL runs folded as the gate folds them (gate.ts bidiFold: the PDF's text is in visual order)
const bidiFold = (s: string) =>
  s.normalize("NFKC").replace(/[\p{Script=Hebrew}\p{Script=Arabic}][\p{Script=Hebrew}\p{Script=Arabic}\p{M}\s]*/gu,
    (run) => ` ${[...run.replace(/[\s\p{M}]/gu, "")].sort().join("")} `);
const words = (s: string) => ` ${bidiFold(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

if (mode === "req") {
  const [method, url, out, sub, bodyArg] = args;
  const body = bodyArg?.startsWith("@") ? await Deno.readTextFile(bodyArg.slice(1)) : bodyArg; // @file: the body from a file
  const r = await fetch(url, {
    method, redirect: "manual",
    headers: { "x-brain-key": key, ...(sub ? { "x-test-sub": sub } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body || undefined,
  });
  const bytes = new Uint8Array(await r.arrayBuffer());
  await Deno.writeFile(out, bytes);
  console.log(JSON.stringify({ status: r.status, bytes: bytes.byteLength, export_id: r.headers.get("x-export-id"), gate: r.headers.get("x-export-gate"), type: r.headers.get("content-type") }));
} else if (mode === "parity") {
  // round 2 (tester D4, coordinator ruling): parity is one entry per SOURCE in the PDF's citation order on
  // BOTH sides - the panel's `listed` (what it shows and what "Copy the list" copies) against the PDF's
  // entries, position by position: same count, entry i is panel item i (its number and its title as whole
  // words), so a duplicate, a missing entry or another order FAILS.
  const panel = JSON.parse(await Deno.readTextFile(args[0])) as { listed?: { number: number; source_id: string; title: string }[] };
  const listed = panel.listed ?? [];
  const authorDate = args[2] === "author-date";
  let at = -1;
  let entries: { n: number; text: string }[];
  if (!authorDate) {
    const text = (await pdfText(await Deno.readFile(args[1]), true)).replace(/-\n\s*/g, "");
    const lines = text.split("\n");
    lines.forEach((l: string, i: number) => { if (l.trim() === "References") at = i; });
    const region = at < 0 ? "" : lines.slice(at + 1).filter((l: string) => !/^\s*\d+\s*$/.test(l)).join("\n");
    const labels = [...region.matchAll(/^\s*\[(\d+)\]/gm)];
    entries = labels.map((m, i) => ({ n: Number(m[1]), text: region.slice(m.index!, i + 1 < labels.length ? labels[i + 1].index! : undefined) }));
  } else {
    // round 3 (D10): an author-date list is unnumbered - its entries are poppler's own text BLOCKS
    // (pdftotext -bbox-layout: one block per paragraph), read in order after the "References" block; the
    // position is the number. Independent of the gate's own line splitting.
    const dir = await Deno.makeTempDir();
    await Deno.writeFile(`${dir}/d.pdf`, await Deno.readFile(args[1]));
    const o = await new Deno.Command("pdftotext", { args: ["-bbox-layout", `${dir}/d.pdf`, `${dir}/d.html`] }).output();
    if (o.code !== 0) throw new Error("pdftotext -bbox-layout failed");
    const html = await Deno.readTextFile(`${dir}/d.html`);
    await Deno.remove(dir, { recursive: true });
    const unesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const blocks = [...html.matchAll(/<block[^>]*>([\s\S]*?)<\/block>/g)].map((b) => [...b[1].matchAll(/<word[^>]*>([\s\S]*?)<\/word>/g)].map((w) => unesc(w[1])).join(" ").replace(/-\s+/g, "-"));
    blocks.forEach((b, i) => { if (b.trim() === "References") at = i; });
    entries = (at < 0 ? [] : blocks.slice(at + 1).filter((b) => b.trim() && !/^\s*\d+\s*$/.test(b))).map((text, i) => ({ n: i + 1, text }));
  }
  const fails: string[] = [];
  if (!panel.listed) fails.push("the panel answer carries no `listed` reference list");
  if (at < 0 && listed.length) fails.push("the PDF has no References list");
  if (entries.length !== listed.length) fails.push(`the PDF lists ${entries.length} entries; the panel lists ${listed.length}`);
  for (let i = 0; i < Math.max(entries.length, listed.length); i++) {
    const p = listed[i], e = entries[i];
    if (!p || !e) continue;
    if (p.number !== e.n) fails.push(`position ${i + 1}: panel [${p.number}], PDF [${e.n}]`);
    if (!p.title || !words(e.text).includes(words(p.title))) fails.push(`position ${i + 1}: panel "${p.title}" is not PDF entry ${e.text.trim().replace(/\s+/g, " ").slice(0, 120)}`);
  }
  console.log(`panel: ${listed.map((t) => `[${t.number}] ${JSON.stringify(t.title)}`).join(", ")}`);
  console.log(`pdf:   ${entries.map((e) => JSON.stringify(e.text.trim().replace(/\s+/g, " ").slice(0, 100))).join(", ")}`);
  if (fails.length) {
    for (const f of fails) console.log(`PARITY FAIL ${f}`);
    Deno.exit(1);
  }
  console.log(`PARITY PASS ${listed.length} panel entr${listed.length === 1 ? "y" : "ies"} = ${entries.length} PDF entries, same order, one to one`);
} else if (mode === "text") {
  console.log(await pdfText(await Deno.readFile(args[0]), true));
} else {
  console.log("usage: req | parity | text");
  Deno.exit(2);
}
