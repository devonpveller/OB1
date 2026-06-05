// /workbench/export (P3.5 follow-up) — convert a vault note to MD/PDF/TXT/DOCX/…
// via pandoc and stream it back as a download. Read-only and local: it reads the
// note markdown from the vault and runs pandoc (no network). `path` is the FULL
// vault-relative path (e.g. notes/notebooks/<nb>/<file>.md), validated by the
// shared no-`../` validator. pandoc + weasyprint ship in the workbench image.
//
// IMPORTANT: pandoc runs with cwd in a throwaway /tmp dir — NEVER the vault —
// because its PDF engine drops transient temp files (e.g. `toPdfViaTempFile…`)
// in the cwd, and the wiki viewer watches the vault and crashes trying to emit
// a file that vanishes (ENOENT unlink). Keep all conversion scratch out of /wiki.
import { Hono } from "hono";
import { config } from "../config.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { safeJoin, safeRelPath } from "../util/paths.ts";

export const exporter = new Hono();

interface Fmt {
  to: string;
  ext: string;
  mime: string;
  extra: string[];
}
// `md` is special-cased (raw passthrough); the rest go through pandoc.
const FORMATS: Record<string, Fmt> = {
  pdf: { to: "pdf", ext: "pdf", mime: "application/pdf", extra: ["--pdf-engine=weasyprint"] },
  txt: { to: "plain", ext: "txt", mime: "text/plain; charset=utf-8", extra: [] },
  docx: {
    to: "docx",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extra: [],
  },
  html: { to: "html", ext: "html", mime: "text/html; charset=utf-8", extra: ["--standalone", "--embed-resources"] },
  odt: { to: "odt", ext: "odt", mime: "application/vnd.oasis.opendocument.text", extra: [] },
  epub: { to: "epub", ext: "epub", mime: "application/epub+zip", extra: [] },
  tex: { to: "latex", ext: "tex", mime: "application/x-tex; charset=utf-8", extra: [] },
};

exporter.get("/", async (c) => {
  const path = c.req.query("path") || "";
  const fmt = (c.req.query("format") || "pdf").toLowerCase();
  if (fmt !== "md" && !FORMATS[fmt]) return c.json({ error: `unsupported format: ${fmt}` }, 400);

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

  // Raw markdown: hand back the source file (no pandoc).
  if (fmt === "md") {
    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${base}.md"`,
      },
    });
  }

  const spec = FORMATS[fmt];
  // pandoc doesn't understand Obsidian `[[wikilinks]]` and would print them
  // literally. Convert to plain readable text: `[[target|alias]]` → alias,
  // `[[target]]` → the target's basename. (md export keeps them verbatim.)
  const pandocMd = md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t) => String(t).split("/").pop() || String(t));
  const noteDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  // Resolve relative images from both the vault root and the note's folder
  // (absolute paths — pandoc's cwd is the scratch tmp dir, not the vault).
  const resPath = [config.vault.gitDir, noteDir ? safeJoin(config.vault.gitDir, noteDir) : config.vault.gitDir]
    .join(":");

  const tmp = await Deno.makeTempDir({ prefix: "ob-export-" });
  const outFile = `${tmp}/out.${spec.ext}`;
  try {
    const args = [
      "-f",
      "markdown+yaml_metadata_block+strikeout",
      "-t",
      spec.to,
      "--resource-path",
      resPath,
      ...spec.extra,
      "-o",
      outFile,
    ];
    const child = new Deno.Command("pandoc", {
      args,
      cwd: tmp, // scratch dir — keep pandoc/weasyprint temp files OUT of the vault
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(pandocMd));
    await w.close();
    const { code, stderr } = await child.output();
    if (code !== 0) {
      return c.json(
        { error: "pandoc conversion failed", detail: new TextDecoder().decode(stderr).slice(0, 500) },
        500,
      );
    }
    const bytes = await Deno.readFile(outFile);
    return new Response(bytes, {
      headers: {
        "content-type": spec.mime,
        "content-disposition": `attachment; filename="${base}.${spec.ext}"`,
        "content-length": String(bytes.byteLength),
      },
    });
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 500);
  } finally {
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      /* ignore */
    }
  }
});
