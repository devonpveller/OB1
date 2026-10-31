// The HTTP side of the P6b disposable run (rw-p6b-gate), run INSIDE a container of the workbench's
// TEST image (poppler for reading PDFs back) on the run's internal network by run-export-gate-tests.ps1.
// Never pointed at a live workbench.
//
//   req <METHOD> <url> <out-file> [<subject>] [<json-body> | @<file>]
//        X-Brain-Key from $WB_KEY, X-Test-Sub: <subject> (the lab's identity header); writes the body;
//        prints one JSON line {status, bytes, export_id, gate, type}
//   parity <panel.json> <pdf>
//        acceptance 2, written independently of the gate: the reference PANEL's list (GET
//        /workbench/documents/references, one entry per source - the export folds a source's references
//        into one) against the PDF's reference list read back with pdftotext. One-to-one: as many
//        entries as panel sources, every panel title (whole words, case and punctuation aside) in
//        exactly one entry. Prints PARITY PASS / PARITY FAIL lines; exit 1 on a mismatch.
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
  const panel = JSON.parse(await Deno.readTextFile(args[0])) as { references: { source_id: string; title: string }[] };
  const seen = new Map<string, string>();
  for (const r of panel.references) if (!seen.has(r.source_id)) seen.set(r.source_id, r.title);
  const text = (await pdfText(await Deno.readFile(args[1]), true)).replace(/-\n\s*/g, "");
  const lines = text.split("\n");
  let at = -1;
  lines.forEach((l, i) => { if (l.trim() === "References") at = i; });
  const region = at < 0 ? "" : lines.slice(at + 1).filter((l) => !/^\s*\d+\s*$/.test(l)).join("\n");
  const labels = [...region.matchAll(/^\s*\[(\d+)\]/gm)];
  const entries = labels.map((m, i) => region.slice(m.index!, i + 1 < labels.length ? labels[i + 1].index! : undefined));
  const fails: string[] = [];
  if (at < 0) fails.push("the PDF has no References list");
  if (entries.length !== seen.size) fails.push(`the PDF lists ${entries.length} entries; the panel shows ${seen.size} source(s)`);
  for (const [sid, title] of seen) {
    const n = entries.filter((e) => words(e).includes(words(title))).length;
    if (n !== 1) fails.push(`panel "${title}" (${sid}) is in ${n} PDF entries`);
  }
  for (const e of entries) {
    if (![...seen.values()].some((t) => words(e).includes(words(t)))) fails.push(`PDF entry not on the panel: ${e.trim().replace(/\s+/g, " ").slice(0, 140)}`);
  }
  console.log(`panel: ${[...seen.values()].map((t) => JSON.stringify(t)).join(", ")}`);
  console.log(`pdf:   ${entries.map((e) => JSON.stringify(e.trim().replace(/\s+/g, " ").slice(0, 100))).join(", ")}`);
  if (fails.length) {
    for (const f of fails) console.log(`PARITY FAIL ${f}`);
    Deno.exit(1);
  }
  console.log(`PARITY PASS ${seen.size} panel source(s) = ${entries.length} PDF entries, one to one`);
} else if (mode === "text") {
  console.log(await pdfText(await Deno.readFile(args[0]), true));
} else {
  console.log("usage: req | parity | text");
  Deno.exit(2);
}
