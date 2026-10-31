// /workbench/export - a vault page exported with its numbered references (research-workbench P6a).
//
//   GET /workbench/export?path=<vault .md>&format=<export_formats key>&style=<citation_styles key>[&wrap=none][&mode=copy]
//   GET /workbench/export/about      the CSL attribution, the styles, the programs and their licences
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
import { exportWithRollup } from "../contracts/repo/trust.ts";

const db = poolDb(pool);
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
    // research-workbench P3b: a research report's page carries its credibility roll-up at its head
    return rel.startsWith("documents/") ? await documentExportMarkdown(db, md) : await exportWithRollup(db, rel, md);
  },
  loadRefs: async (rel, md) => {
    if (rel.startsWith("documents/")) return await documentExportRefs(db, rel, md);
    if (!rel.startsWith("notes/")) return await pageExportRefs(db, md);
    await ensureLegacyNote(db, rel, md);
    return await noteExportRefs(db, rel);
  },
  cache: (referenceId, identifier, csl, via) => cacheResolution(db, referenceId, identifier, csl, via),
  limits: limitsFromEnv(), // EXPORT_MAX_NOTE_BYTES, EXPORT_MAX_BRACKET_DEPTH, EXPORT_MAX_DEPTH, EXPORT_MAX_LIST_DEPTH
});

// rw-p2b-workspace round 3: another user's document is never exported (checked here as well as at the gate)
export const exporter = new Hono();
exporter.use("*", ownedPathParam(db, identityOf));
exporter.route("/", exportApp);
