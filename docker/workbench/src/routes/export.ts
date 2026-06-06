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
import { query } from "../db/pool.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";
import { safeJoin, safeRelPath } from "../util/paths.ts";

export const exporter = new Hono();

// Academic numbered-citation rewrite for export. Turns each `[[…source/<uuid>…|
// alias]]` in the body into an inline marker `alias [N]` (or just `[N]`), numbered
// by first appearance, and emits a matching numbered "## References" list — so the
// export reads like a modern paper (Vancouver/IEEE-style). Frontmatter `sources:`
// that aren't cited inline are appended to References after the cited ones. Origin
// is dropped — the References list is just the citations. Non-source wikilinks
// degrade to their alias text. Returns the citation-rewritten markdown.
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const SOURCE_LINK_RE = /\[\[([^\]|]*?source\/([0-9a-fA-F-]{36}))(?:\|([^\]]+))?\]\]/g;
async function applyCitations(md: string): Promise<string> {
  const order: string[] = [];
  const numFor = new Map<string, number>();
  const enrol = (u: string) => {
    if (UUID_RE.test(u) && !numFor.has(u)) {
      order.push(u);
      numFor.set(u, order.length);
    }
  };
  // 1) number cited source links by first appearance
  let m: RegExpExecArray | null;
  SOURCE_LINK_RE.lastIndex = 0;
  while ((m = SOURCE_LINK_RE.exec(md))) enrol(m[2]);
  // 2) then deliberately-added (frontmatter) sources, appended
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const sm = fmMatch[1].match(/^sources:\s*\[([^\]]*)\]\s*$/m);
    if (sm) sm[1].split(",").forEach((s) => enrol(s.trim().replace(/^["']|["']$/g, "")));
  }

  // 3) replace cited links inline with `alias [N]` / `[N]`
  let out = md.replace(SOURCE_LINK_RE, (_full, _target, uuid, alias) => {
    const n = numFor.get(uuid);
    const label = (alias || "").trim();
    return label ? `${label} [${n}]` : `[${n}]`;
  });
  // 4) non-source wikilinks → alias text / basename
  out = out
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t) => String(t).split("/").pop() || String(t));

  // 5) numbered References list matching the [N] markers
  if (order.length) {
    const rows = await query<{ id: string; title: string; url: string }>(
      `SELECT id::text AS id, title, url FROM public.sources WHERE id = ANY($1::uuid[])`,
      [order],
    ).catch(() => []);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = order
      .map((u) => {
        const r = byId.get(u);
        if (!r) return null;
        const title = (r.title || "Untitled source").replace(/\n/g, " ");
        return `[${numFor.get(u)}] ${title}${r.url ? `. <${r.url}>` : "."}`;
      })
      .filter(Boolean);
    if (lines.length) out += "\n\n## References\n\n" + lines.join("\n\n");
  }
  return out;
}

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
  // wrap=none → no hard line-wrapping (used by "Copy page" so pasted text flows).
  const noWrap = (c.req.query("wrap") || "").toLowerCase() === "none";
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
  // Rewrite citations to numbered [N] markers + a matching ## References list,
  // and degrade non-source wikilinks to plain text (pandoc can't read [[…]]).
  const pandocMd = await applyCitations(md);
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
      ...(noWrap ? ["--wrap=none"] : []),
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
