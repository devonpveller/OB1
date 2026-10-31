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
//        mismatch.
//   text <pdf>   the PDF's text (pdftotext -layout)
import { pdfText } from "/app/src/export/pdf_tools.ts";

const [mode, ...args] = Deno.args;
const key = Deno.env.get("WB_KEY") ?? "";

const words = (s: string) => ` ${s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

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
  const text = (await pdfText(await Deno.readFile(args[1]), true)).replace(/-\n\s*/g, "");
  const lines = text.split("\n");
  let at = -1;
  lines.forEach((l, i) => { if (l.trim() === "References") at = i; });
  const region = at < 0 ? "" : lines.slice(at + 1).filter((l) => !/^\s*\d+\s*$/.test(l)).join("\n");
  const labels = [...region.matchAll(/^\s*\[(\d+)\]/gm)];
  const entries = labels.map((m, i) => ({ n: Number(m[1]), text: region.slice(m.index!, i + 1 < labels.length ? labels[i + 1].index! : undefined) }));
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
