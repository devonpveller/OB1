// The export route's logic (research-workbench P6a), with its dependencies INJECTED so the build gate
// can drive it without a database or a network (exporter_test.ts; rw-p6a-resolve attempt 2: the 422
// for an unresolved reference was caught only by the disposable runner). routes/export.ts wires it.
//
//   GET /?path=<vault .md>&format=<export_formats key>&style=<citation_styles key>[&wrap=none][&mode=copy]
//   GET /about      the CSL attribution, the styles, the programs and their licences
//
// EXPORT (no mode): every numbered reference becomes a CSL-JSON item - a source with a persistent
// identifier from the metadata cached on its reference record, resolved through OpenAlex/Crossref on
// first use (resolver.ts); a source without one, as the web page or document it is. pandoc --citeproc
// renders them in the chosen CSL style into the chosen format. An export that would leave any
// reference unresolved - a dead identifier, the resolver off, a malformed identifier, a citation of
// a source that does not exist or is suppressed - is REFUSED with 422, naming every such reference;
// nothing is rendered as text in its place (acceptance 1/2). Resolutions that DID succeed on a
// refused export stay cached on their reference records (findings, attempt 2 decision B): the cache
// is a fact about the reference at its pin, not about one export; a retry after the dead reference is
// fixed sends only that reference's requests.
//
// COPY (mode=copy, PageTools "Copy page"; attempt 2 decision C): the page's text for the clipboard,
// in a format whose registry entry says `copy: true` (plain text). It never calls the resolver (no
// egress from a copy), uses what is cached or needs no resolution, and prints every reference that is
// not resolved with an explicit "UNRESOLVED (<reason>)" marker in the list, under its holder number;
// a suppressed source's title is never printed. It answers 200 inline with x-export-unresolved: <n>.
// It is not an export: no file is offered, and the download formats keep acceptance 1's rule.
//
// FAILURES the browser sees name a code, never a program's report: a RenderFailed `glyphs` /
// `citation` / `pandoc` is 422 (the document), `font` / `style-integrity` is 503 (the server: a font
// or a style the registry names is not as registered). pandoc's stderr goes to the server log.
import { Hono } from "hono";
import type { RegistryEntry } from "../contracts/registry.ts";
import { MigrationRefused } from "../contracts/repo/references.ts";
import { safeJoin, safeRelPath } from "../util/paths.ts";
import { type CslItem, recordToCsl } from "./csl.ts";
import { IdentifierError, type IdentifierKind, sourceIdentifier } from "./identifiers.ts";
import { RequestRefused, ResolutionFailed, type Resolver } from "./resolver.ts";
import type { ExportRef } from "./repo.ts";
import { citeKey, type FormatDef, type RefItem, render as realRender, RenderFailed, type StyleDef, UnnumberedCitation } from "./render.ts";
import { aboutExport } from "./about.ts";

export interface ExporterDeps {
  reg: { entries(registry: string): Promise<RegistryEntry[]> };
  resolver: Resolver;
  cslDir: string;
  vaultDir: string;
  readNote(rel: string): Promise<string | null>; // null: no such note
  loadRefs(rel: string, md: string): Promise<ExportRef[]>; // may throw MigrationRefused
  cache(referenceId: string, identifier: string, csl: CslItem, via: string): Promise<void>;
  render?: typeof realRender;
  log?: (m: string) => void;
}

export interface Unresolved {
  number: number;
  cited_ref: string;
  source_id: string | null;
  title: string | null;
  identifier: string | null;
  reason: string;
  marker: string; // the copy view's "UNRESOLVED (...)" text, from a closed vocabulary
}

const CONCURRENCY = 4;

export function kindsOf(entries: RegistryEntry[]): IdentifierKind[] {
  return entries.filter((e) => !e.retired_at).map((e) => ({ key: e.key, ...(e.definition as Omit<IdentifierKind, "key">) }));
}

// Every numbered reference -> a CSL item, or the reason it cannot be one. `offline`: never call the
// resolver (the copy view) - a reference that needs a resolution is then unresolved.
export async function referenceItems(
  deps: Pick<ExporterDeps, "resolver" | "cache">, refs: ExportRef[], kinds: IdentifierKind[], offline = false,
): Promise<{ items: RefItem[]; unresolved: Unresolved[] }> {
  const items: RefItem[] = [];
  const unresolved: Unresolved[] = [];
  const fail = (r: ExportRef, identifier: string | null, reason: string, marker: string) =>
    unresolved.push({ number: r.number, cited_ref: r.cited_ref, source_id: r.source_id, title: r.title, identifier, reason, marker });
  const queue = [...refs];
  const work = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (!r.source_id) {
        fail(r, null, "the document cites a source id that resolves to no source", "the cited source does not exist");
        continue;
      }
      if (r.suppressed) {
        fail(r, null, "the document cites a suppressed source; remove the citation to export", "suppressed source");
        continue;
      }
      let id;
      try {
        id = sourceIdentifier(kinds, r);
      } catch (e) {
        if (!(e instanceof IdentifierError)) throw e;
        fail(r, null, `the source declares a malformed identifier: ${e.message}`, "malformed identifier");
        continue;
      }
      let csl: CslItem;
      if (!id) {
        csl = recordToCsl(r);
      } else {
        const hit = r.cached.find((c) => c.identifier === id.citekey);
        if (hit && deps.resolver.unsafe(hit.csl)) {
          fail(r, id.citekey, "the cached record carries credential-shaped text (refused; delete the cached row to resolve anew)", "unsafe cached record");
          continue;
        }
        if (hit) csl = hit.csl;
        else if (offline) {
          fail(r, id.citekey, "not resolved yet (the export resolves it)", "not resolved yet");
          continue;
        } else {
          let res;
          try {
            res = await deps.resolver.resolve(id, kinds.find((k) => k.key === id.kind)!);
          } catch (e) {
            if (!(e instanceof ResolutionFailed || e instanceof RequestRefused)) throw e;
            fail(r, id.citekey, e.message, "not resolved");
            continue;
          }
          csl = res.csl;
          if (r.reference_id) await deps.cache(r.reference_id, id.citekey, csl, res.via);
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

// The copy view's item for a reference it could not resolve: the marker first, then what the record
// says (never a suppressed source's title).
function markedItem(u: Unresolved, refs: ExportRef[]): RefItem {
  const r = refs.find((x) => x.number === u.number);
  const shown = r && !r.suppressed && r.source_id ? recordToCsl(r) : null;
  const what = shown ? `: ${shown.title}` : "";
  return {
    key: citeKey(u.cited_ref), number: u.number,
    csl: { type: "document", title: `UNRESOLVED (${u.marker})${what}`, ...(shown?.URL ? { URL: shown.URL } : {}) } as CslItem,
  };
}

const formatOf = (e: RegistryEntry): FormatDef => ({ key: e.key, ...(e.definition as Omit<FormatDef, "key">) });
const styleOf = (e: RegistryEntry): StyleDef => ({ key: e.key, ...(e.definition as Omit<StyleDef, "key">) });

const STATUS_OF: Record<string, 422 | 503> = { glyphs: 422, citation: 422, pandoc: 422, font: 503, "style-integrity": 503 };

export function createExporter(deps: ExporterDeps): Hono {
  const app = new Hono();
  const render = deps.render ?? realRender;
  const log = deps.log ?? ((m: string) => console.error(m));
  const live = async (registry: string) => (await deps.reg.entries(registry)).filter((e) => !e.retired_at);

  app.get("/about", async (c) => c.json(aboutExport(await live("citation_styles"), await live("export_formats"))));

  app.get("/", async (c) => {
    const path = c.req.query("path") || "";
    const mode = (c.req.query("mode") || "").toLowerCase();
    if (mode && mode !== "copy") return c.json({ error: `unsupported mode: ${mode}` }, 400);
    const copy = mode === "copy";
    const fmtKey = c.req.query("format")?.toLowerCase();
    const noWrap = copy || (c.req.query("wrap") || "").toLowerCase() === "none"; // "Copy page": no hard wrap
    const formats = await live("export_formats");
    const fmtEntry = fmtKey ? formats.find((e) => e.key === fmtKey) : formats.find((e) => (copy ? e.definition.copy : e.definition.default) === true);
    if (!fmtEntry) return c.json({ error: fmtKey ? `unsupported format: ${fmtKey}` : `no default ${copy ? "copy" : "export"} format is registered` }, 400);
    if (copy && fmtEntry.definition.copy !== true) return c.json({ error: `format ${fmtEntry.key} is not a copy format` }, 400);
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
    const md = await deps.readNote(rel);
    if (md === null) return c.json({ error: "note not found" }, 404);
    const base = (rel.split("/").pop() || "note").replace(/\.md$/, "");

    let refs: ExportRef[];
    try {
      refs = await deps.loadRefs(rel, md);
    } catch (e) {
      if (e instanceof MigrationRefused) return c.json({ error: e.message, detail: e.detail }, 409);
      throw e;
    }
    const { items, unresolved } = await referenceItems(deps, refs, kindsOf(await live("reference_identifier_kinds")), copy);
    if (unresolved.length && !copy) {
      return c.json({
        error: `export refused: ${unresolved.length} of ${refs.length} references could not be resolved`,
        resolver: deps.resolver.status,
        references: unresolved.map(({ marker: _m, ...u }) => u),
      }, 422);
    }
    const refItems = copy ? [...items, ...unresolved.map((u) => markedItem(u, refs))].sort((a, b) => a.number - b.number) : items;

    const noteDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    // Relative images resolve from the vault root and the note's folder (absolute paths: pandoc's
    // cwd is a scratch directory, never the vault).
    const resourcePath = [deps.vaultDir, noteDir ? safeJoin(deps.vaultDir, noteDir) : deps.vaultDir].join(":");
    const format = formatOf(fmtEntry);
    try {
      const out = await render({ md, refs: refItems, format, style: styleOf(styleEntry), cslDir: deps.cslDir, wrapNone: noWrap, resourcePath });
      return new Response(out.bytes as unknown as BodyInit, {
        headers: {
          "content-type": format.mime,
          "content-disposition": copy ? "inline" : `attachment; filename="${base}.${format.ext}"`,
          "content-length": String(out.bytes.byteLength),
          "x-citation-style": styleEntry.key,
          ...(copy ? { "x-export-mode": "copy", "x-export-unresolved": String(unresolved.length) } : {}),
        },
      });
    } catch (e) {
      if (e instanceof UnnumberedCitation) return c.json({ error: e.message, references: [] }, 422);
      if (e instanceof RenderFailed) {
        if (e.detail) log(`[export] ${rel} (${format.key}, ${styleEntry.key}): ${e.code}: ${e.detail}`);
        return c.json({ error: e.message, code: e.code, ...e.extra }, STATUS_OF[e.code] ?? 422);
      }
      throw e;
    }
  });
  return app;
}
