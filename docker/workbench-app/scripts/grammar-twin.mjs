// The grammar twin check (rwr-doc-editor). The workbench's document grammar (docker/workbench/src/documents/grammar.ts)
// has ONE twin here (src/lib/grammar.ts) so the editor and the documents API read a document the same way. They must
// be BYTE-IDENTICAL: one byte of difference fails. The lab runner (workbench/contract-test/run-workspace-tests.ps1,
// step [5c]) and test/grammar-twin.test.mjs run this; the comparison is bytes, never text (line endings count).
//   node scripts/grammar-twin.mjs [<server grammar.ts> [<app grammar.ts>]]     exit 0 identical, 1 differs, 2 unreadable
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SERVER = "../workbench/src/documents/grammar.ts";
export const TWIN = "src/lib/grammar.ts";

// null when the two are byte-identical, else a sentence naming the first difference
export function firstDifference(a, b) {
  if (a.length === b.length && a.equals(b)) return null;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `differ at byte ${i} (0x${a[i].toString(16)} against 0x${b[i].toString(16)})`;
  return `differ in length (${a.length} against ${b.length} bytes)`;
}

export function check(serverPath = SERVER, twinPath = TWIN) {
  const why = firstDifference(readFileSync(serverPath), readFileSync(twinPath));
  return why === null ? { ok: true, message: "the app's grammar copy is byte-identical to the documents API grammar" } : { ok: false, message: `${twinPath} and ${serverPath} ${why}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = check(process.argv[2] ?? SERVER, process.argv[3] ?? TWIN);
    console.log((r.ok ? "PASS " : "FAIL ") + r.message);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error("FAIL could not read the grammar files: " + e.message);
    process.exit(2);
  }
}
