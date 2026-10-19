// /workbench/export - a vault page exported with its numbered references (research-workbench P6a).
//
//   GET /workbench/export?path=<vault .md>&format=<export_formats key>&style=<citation_styles key>[&wrap=none][&mode=copy]
//   GET /workbench/export/about      the CSL attribution, the styles, the programs and their licences
//
// The route's logic is src/export/exporter.ts (dependencies injected, so the build gate drives it:
// exporter_test.ts); this file wires the live ones - the database, the registry reader, the resolver
// from the environment, the vault - and nothing else.
// `path` is the full vault-relative path, validated by the shared no-`../` validator.
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { poolDb } from "../contracts/db.ts";
import { RegistryReader } from "../contracts/registry.ts";
import { ensureLegacyNote } from "../contracts/repo/references.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { createResolver, resolverConfigFromEnv } from "../export/resolver.ts";
import { cacheResolution, noteExportRefs, pageExportRefs } from "../export/repo.ts";
import { createExporter } from "../export/exporter.ts";
import { limitsFromEnv } from "../export/markdown.ts";

const db = poolDb(pool);
export const exporter = createExporter({
  reg: new RegistryReader(db),
  resolver: createResolver(resolverConfigFromEnv()),
  cslDir: Deno.env.get("EXPORT_CSL_DIR") || new URL("../../csl", import.meta.url).pathname,
  vaultDir: config.vault.gitDir,
  readNote: async (rel) => (await vaultExists(rel)) ? await vaultRead(rel) : null,
  loadRefs: async (rel, md) => {
    if (!rel.startsWith("notes/")) return await pageExportRefs(db, md);
    await ensureLegacyNote(db, rel, md);
    return await noteExportRefs(db, rel);
  },
  cache: (referenceId, identifier, csl, via) => cacheResolution(db, referenceId, identifier, csl, via),
  limits: limitsFromEnv(), // EXPORT_MAX_NOTE_BYTES, EXPORT_MAX_BRACKET_DEPTH, EXPORT_MAX_DEPTH, EXPORT_MAX_LIST_DEPTH
});
