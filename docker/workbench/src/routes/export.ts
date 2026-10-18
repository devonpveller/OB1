// /workbench/export - a vault page exported with its numbered references (research-workbench P6a).
//
//   GET /workbench/export?path=<vault .md>&format=<export_formats key>&style=<citation_styles key>[&wrap=none]
//   GET /workbench/export/about      the CSL attribution, the styles, the programs and their licences
//
// Every numbered reference becomes a CSL-JSON item: a source with a persistent identifier (DOI,
// arXiv, PubMed, PMC, OpenAlex id) from the metadata cached on its reference record, resolved through
// OpenAlex/Crossref on first use (src/export/resolver.ts); a source without one, as the web page or
// document it is. pandoc --citeproc renders them in the chosen CSL style (numbered by default) into
// the chosen format; a PDF is typeset by Typst. An export that would leave any reference unresolved
// - a dead identifier, the resolver off, a citation of a source that does not exist or is suppressed
// - is REFUSED with 422, naming every such reference; nothing is rendered as text in its place.
// `path` is the full vault-relative path, validated by the shared no-`../` validator.
import { Hono } from "hono";
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { type Db, poolDb } from "../contracts/db.ts";
import { RegistryReader, type RegistryEntry } from "../contracts/registry.ts";
import { ensureLegacyNote, MigrationRefused } from "../contracts/repo/references.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { safeJoin, safeRelPath } from "../util/paths.ts";
import { type CslItem, recordToCsl } from "../export/csl.ts";
import { IdentifierError, type IdentifierKind, sourceIdentifier } from "../export/identifiers.ts";
import { createResolver, RequestRefused, ResolutionFailed, type Resolver, resolverConfigFromEnv } from "../export/resolver.ts";
import { cacheResolution, type ExportRef, noteExportRefs, pageExportRefs } from "../export/repo.ts";
import { citeKey, type FormatDef, type RefItem, render, RenderFailed, type StyleDef, UnnumberedCitation } from "../export/render.ts";
import { aboutExport } from "../export/about.ts";

export interface ExporterDeps {
  db: Db;
  reg: RegistryReader;
  resolver: Resolver;
  cslDir: string;
  vaultDir: string;
}

export interface Unresolved {
  number: number;
  cited_ref: string;
  source_id: string | null;
  title: string | null;
  identifier: string | null;
  reason: string;
}

const CONCURRENCY = 4;

function kindsOf(entries: RegistryEntry[]): IdentifierKind[] {
  return entries.filter((e) => !e.retired_at).map((e) => ({ key: e.key, ...(e.definition as Omit<IdentifierKind, "key">) }));
}

// Every numbered reference -> a CSL item, or the reason it cannot be one.
export async function referenceItems(
  deps: Pick<ExporterDeps, "db" | "resolver">, refs: ExportRef[], kinds: IdentifierKind[],
): Promise<{ items: RefItem[]; unresolved: Unresolved[] }> {
  const items: RefItem[] = [];
  const unresolved: Unresolved[] = [];
  const fail = (r: ExportRef, identifier: string | null, reason: string) =>
    unresolved.push({ number: r.number, cited_ref: r.cited_ref, source_id: r.source_id, title: r.title, identifier, reason });
  const queue = [...refs];
  const work = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (!r.source_id) {
        fail(r, null, "the document cites a source id that resolves to no source");
        continue;
      }
      if (r.suppressed) {
        fail(r, null, "the document cites a suppressed source; remove the citation to export");
        continue;
      }
      let id;
      try {
        id = sourceIdentifier(kinds, r);
      } catch (e) {
        if (!(e instanceof IdentifierError)) throw e;
        fail(r, null, `the source declares a malformed identifier: ${e.message}`);
        continue;
      }
      let csl: CslItem;
      if (!id) {
        csl = recordToCsl(r);
      } else {
        const hit = r.cached.find((c) => c.identifier === id.citekey);
        if (hit) csl = hit.csl;
        else {
          let res;
          try {
            res = await deps.resolver.resolve(id, kinds.find((k) => k.key === id.kind)!);
          } catch (e) {
            if (!(e instanceof ResolutionFailed || e instanceof RequestRefused)) throw e;
            fail(r, id.citekey, e.message);
            continue;
          }
          csl = res.csl;
          if (r.reference_id) await cacheResolution(deps.db, r.reference_id, id.citekey, csl, res.via);
        }
      }
      items.push({ key: citeKey(r.cited_ref), number: r.number, csl });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  items.sort((a, b) => a.number - b.number);
  unresolved.sort((a, b) => a.number - b.number);
  return { items, unresolved };
}

function formatOf(e: RegistryEntry): FormatDef {
  return { key: e.key, ...(e.definition as Omit<FormatDef, "key">) };
}

function styleOf(e: RegistryEntry): StyleDef {
  return { key: e.key, ...(e.definition as Omit<StyleDef, "key">) };
}

export function createExporter(deps: ExporterDeps): Hono {
  const app = new Hono();
  const live = async (registry: string) => (await deps.reg.entries(registry)).filter((e) => !e.retired_at);

  app.get("/about", async (c) => c.json(aboutExport(await live("citation_styles"), await live("export_formats"))));

  app.get("/", async (c) => {
    const path = c.req.query("path") || "";
    const fmtKey = c.req.query("format")?.toLowerCase();
    const noWrap = (c.req.query("wrap") || "").toLowerCase() === "none"; // "Copy page": no hard wrap
    const formats = await live("export_formats");
    const fmtEntry = fmtKey ? formats.find((e) => e.key === fmtKey) : formats.find((e) => e.definition.default === true);
    if (!fmtEntry) return c.json({ error: fmtKey ? `unsupported format: ${fmtKey}` : "no default export format is registered" }, 400);
    const styles = await live("citation_styles");
    const styleKey = c.req.query("style");
    const styleEntry = styleKey ? styles.find((e) => e.key === styleKey) : styles.find((e) => e.definition.default === true);
    if (!styleEntry) return c.json({ error: styleKey ? `unsupported citation style: ${styleKey}` : "no default citation style is registered" }, 400);

    let rel: string;
    try {
      rel = safeRelPath(path);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
    if (!rel.endsWith(".md")) return c.json({ error: "only .md notes can be exported" }, 400);
    if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
    const md = await vaultRead(rel);
    const base = (rel.split("/").pop() || "note").replace(/\.md$/, "");

    let refs: ExportRef[];
    try {
      if (rel.startsWith("notes/")) {
        await ensureLegacyNote(deps.db, rel, md);
        refs = await noteExportRefs(deps.db, rel);
      } else refs = await pageExportRefs(deps.db, md);
    } catch (e) {
      if (e instanceof MigrationRefused) return c.json({ error: e.message, detail: e.detail }, 409);
      throw e;
    }
    const { items, unresolved } = await referenceItems(deps, refs, kindsOf(await live("reference_identifier_kinds")));
    if (unresolved.length) {
      return c.json({
        error: `export refused: ${unresolved.length} of ${refs.length} references could not be resolved`,
        resolver: deps.resolver.status,
        references: unresolved,
      }, 422);
    }

    const noteDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    // Relative images resolve from the vault root and the note's folder (absolute paths: pandoc's
    // cwd is a scratch directory, never the vault).
    const resourcePath = [deps.vaultDir, noteDir ? safeJoin(deps.vaultDir, noteDir) : deps.vaultDir].join(":");
    const format = formatOf(fmtEntry);
    try {
      const out = await render({ md, refs: items, format, style: styleOf(styleEntry), cslDir: deps.cslDir, wrapNone: noWrap, resourcePath });
      return new Response(out.bytes as unknown as BodyInit, {
        headers: {
          "content-type": format.mime,
          "content-disposition": `attachment; filename="${base}.${format.ext}"`,
          "content-length": String(out.bytes.byteLength),
          "x-citation-style": styleEntry.key,
        },
      });
    } catch (e) {
      if (e instanceof UnnumberedCitation) return c.json({ error: e.message, references: [] }, 422);
      if (e instanceof RenderFailed) return c.json({ error: e.message, detail: e.detail }, 500);
      throw e;
    }
  });
  return app;
}

const db = poolDb(pool);
export const exporter = createExporter({
  db,
  reg: new RegistryReader(db),
  resolver: createResolver(resolverConfigFromEnv()),
  cslDir: Deno.env.get("EXPORT_CSL_DIR") || new URL("../../csl", import.meta.url).pathname,
  vaultDir: config.vault.gitDir,
});

