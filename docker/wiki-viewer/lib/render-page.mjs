/**
 * render-page — markdown → SAFE HTML for the DB-rendered fallback (Phase B1).
 *
 * Uses Quartz's own transitive dependencies (unified/remark/rehype family —
 * asserted resolvable at image build, see Dockerfile). PURE: string in,
 * string out; no I/O, no globals — unit-tested at image build.
 *
 * SAFETY: page bodies can contain raw HTML from ingested web sources
 * (confirmed 2026-08-25: a literal <script> survived into a built page).
 * remark-rehype WITHOUT allowDangerousHtml DROPS raw HTML nodes, so this
 * fallback path is strictly safer than the static build path.
 *
 * Wikilinks: [[target]] and [[target|label]] become plain <a href="/target">.
 * Targets are slug paths already ("content/source/<uuid>", "notes/x") — the
 * server resolves both path and basename forms (serve.mjs plannedFor), so no
 * slug re-derivation is needed here, and no shared import from the recipes
 * mount (the viewer container does not mount /recipes).
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  // allowDangerousHtml defaults false: raw HTML in the markdown is dropped,
  // never emitted. Do not "fix" this — it is the security property.
  .use(remarkRehype);

// [[target|label]] / [[target#anchor]] → markdown links BEFORE parsing, so
// remark handles escaping and nesting for us. Anchors are kept.
export function rewriteWikilinks(md) {
  return String(md ?? "").replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g,
    (_m, target, anchor, label) => {
      const t = target.trim();
      if (!t) return _m;
      const text = (label ?? t.split("/").pop()).trim() || t;
      // Encode each path segment; a bare "%" in a target must never reach an
      // href un-encoded (the URI-malformed class of failure, 2026-08-25).
      const href = "/" + t.split("/").map(encodeURIComponent).join("/") + (anchor ?? "");
      return `[${text}](${href})`;
    });
}

// PURE: markdown body (frontmatter allowed, ignored) → HTML fragment.
export function renderMarkdown(body) {
  const md = rewriteWikilinks(String(body ?? ""));
  const tree = processor.runSync(processor.parse(md));
  return toHtml(tree);
}
