// /workbench/export - a vault page exported with its numbered references (research-workbench P6a).
//
//   GET /workbench/export?path=<vault .md>&format=<export_formats key>&style=<citation_styles key>[&wrap=none][&mode=copy]
//   GET /workbench/export/about      the CSL attribution, the styles, the programs and their licences
// research-workbench P6b: a PDF passes the verification gate before it is served (src/export/gate.ts);
// GET /workbench/exports (routes/exports.ts) lists the caller's own runs.
//
// The route's logic is src/export/exporter.ts (dependencies injected, so the build gate drives it:
// exporter_test.ts); this file wires the live ones - the database, the registry reader, the resolver
// from the environment, the vault - and nothing else.
// `path` is the full vault-relative path, validated by the shared no-`../` validator.
import { Hono } from "hono";
import { config } from "../config.ts";
import { ownedPathParam } from "../documents/ownership.ts";
import { identityOf } from "../middleware/identity.ts";
import { pool } from "../db/pool.ts";
import { poolDb } from "../contracts/db.ts";
import { RegistryReader } from "../contracts/registry.ts";
import { ensureLegacyNote } from "../contracts/repo/references.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { createResolver, resolverConfigFromEnv } from "../export/resolver.ts";
import { cacheResolution, documentExportMarkdown, documentExportRefs, noteExportRefs, pageExportRefs } from "../export/repo.ts";
import { createExporter } from "../export/exporter.ts";
import { limitsFromEnv } from "../export/markdown.ts";
import { gateDepsFromEnv, runGate } from "../export/gate.ts";
import { visionConfigFromEnv } from "../export/vision.ts";
import { runStore } from "../export/runs.ts";

const db = poolDb(pool);
const vision = visionConfigFromEnv();
if (vision.state === "refused") console.error(`[export] the vision pass is REFUSED (${vision.code}): ${vision.reason} - every PDF export is blocked until it is fixed`);
const gate = gateDepsFromEnv(vision);
const exportApp = createExporter({
  reg: new RegistryReader(db),
  resolver: createResolver(resolverConfigFromEnv()),
  cslDir: Deno.env.get("EXPORT_CSL_DIR") || new URL("../../csl", import.meta.url).pathname,
  vaultDir: config.vault.gitDir,
  // research-workbench P2b: a user document (documents/) is exported from its file, its grammar
  // rewritten to the export's citations, at the pins it holds
  readNote: async (rel) => {
    if (!(await vaultExists(rel))) return null;
    const md = await vaultRead(rel);
    return rel.startsWith("documents/") ? await documentExportMarkdown(db, md) : md;
  },
  loadRefs: async (rel, md) => {
    if (rel.startsWith("documents/")) return await documentExportRefs(db, rel, md);
    if (!rel.startsWith("notes/")) return await pageExportRefs(db, md);
    await ensureLegacyNote(db, rel, md);
    return await noteExportRefs(db, rel);
  },
  cache: (referenceId, identifier, csl, via) => cacheResolution(db, referenceId, identifier, csl, via),
  limits: limitsFromEnv(), // EXPORT_MAX_NOTE_BYTES, EXPORT_MAX_BRACKET_DEPTH, EXPORT_MAX_DEPTH, EXPORT_MAX_LIST_DEPTH
  // research-workbench P6b: the verification gate on a `gate: true` format (the PDF) - pdftoppm, the
  // structure checks, the reference list, the required sections, the vision pass (EXPORT_VISION_*,
  // inert when blank) - and the run, recorded for the identity seam's subject (export_runs)
  gated: {
    gate: (input) => runGate(gate, input),
    runs: runStore(db),
    whoOf: async (c) => {
      const who = await identityOf(c);
      return { sub: who.sub, actor: who.actor };
    },
  },
});

// rw-p2b-workspace round 3: another user's document is never exported (checked here as well as at the gate)
export const exporter = new Hono();
exporter.use("*", ownedPathParam(db, identityOf));
exporter.route("/", exportApp);
