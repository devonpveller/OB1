// deno test --allow-all src/export/gate_harden_test.ts - rw-identity-harden round 4 (tester t-id-harden3 D6):
// the gate's findings and the stored run carry only fixed texts. pikepdf / qpdf exception text names the
// server's temp path (/tmp/ob-export-gate-xxxx/export.pdf); that text goes to the server log only.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runGate, type Runner } from "./gate.ts";
import type { GateInput } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import { visionConfigFromEnv } from "./vision.ts";

const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const enc = (s: string) => new TextEncoder().encode(s);
const LEAK = "/tmp/ob-export-gate-Zq81xA/export.pdf";
const fmt = { key: "pdf", metadata: {} } as never;

// pdftoppm "fails" (a non-PDF); the structure program answers what pikepdf's exception / qpdf's check say
const stub = (structure: unknown, code = 3): Runner => (cmd) =>
  Promise.resolve(cmd === "pdftoppm"
    ? { code: 1, stdout: enc(""), stderr: enc(`Syntax Error: ${LEAK}`) }
    : { code, stdout: enc(JSON.stringify(structure)), stderr: enc(`Traceback ${LEAK}`) });

const input = { pdf: enc("this is not a pdf"), format: fmt, numeric: true, frontmatter: {}, required: [], refs: [] } as unknown as GateInput;

Deno.test("D6: a structure check that cannot read the PDF blocks with a fixed text - the exception's /tmp path stays out of the result", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const g = await runGate({ vision: OFF, run: stub({ pages: 0, texts: [], error: `PdfError: ${LEAK}: can't find PDF header` }) }, input);
    assertEquals(g.status, "blocked");
    assert(g.blocking_findings.some((f) => f.code === "structure-unreadable"));
    const wire = JSON.stringify(g);
    assert(!wire.includes("/tmp"), `the result carries a server path: ${wire}`);
    assert(!wire.includes("PdfError"), `the result carries the exception text: ${wire}`);
    assert(!wire.includes("ob-export-gate"), wire);
  } finally {
    console.warn = warn;
  }
});

Deno.test("D6: qpdf's own warnings (they name the temp file) reach the run as one fixed text", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ok = { pages: 1, texts: ["Body"], lines: [[]], blocking: [], warnings: [{ code: "qpdf", detail: `${LEAK}: WARNING: xref table was reconstructed` }], tools: {} };
    const g = await runGate({ vision: OFF, run: (c, a, t) => c === "pdftoppm" ? Promise.resolve({ code: 1, stdout: enc(""), stderr: enc("") }) : stub(ok, 0)(c, a, t) }, input);
    const wire = JSON.stringify(g);
    assert(!wire.includes("/tmp") && !wire.includes("ob-export-gate") && !wire.includes("xref"), `qpdf text reached the run: ${wire}`);
    assert(g.warnings.some((w) => w.code === "qpdf"), "the qpdf warning is still recorded, as a fixed text");
  } finally {
    console.warn = warn;
  }
});

Deno.test("D7: the export vision key is refused when it equals a door or service key, compared constant time", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  const base = { EXPORT_VISION_KEY: "k-vision-0123456789", EXPORT_VISION_MODEL: "m" };
  assertEquals(visionConfigFromEnv(env({ ...base, WORKBENCH_KEY: "k-vision-0123456789" })).state, "refused");
  assertEquals(visionConfigFromEnv(env({ ...base, WORKSPACE_SERVICE_KEYS: "mcp=k-vision-0123456789" })).state, "refused");
  assertEquals(visionConfigFromEnv(env({ ...base, WORKBENCH_KEY: "other" })).state, "on");
});
