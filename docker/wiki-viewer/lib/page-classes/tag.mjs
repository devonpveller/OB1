// Page class "tag": a tag page (Quartz TagPage) or the tag index, generated
// from the rows' tags (frontmatter tags + inline #tags the compile extracts).
import { tagTemplate } from "../page-templates.mjs";
import { simplifySlug } from "../quartz-path.mjs";

export default {
  name: "tag",
  version: 1,
  priority: 100,
  async resolve(req, deps) {
    if (req.key !== "tags" && !req.key.startsWith("tags/")) return null;
    if (!deps.site) return deps.siteUnavailable();
    const tag = req.key === "tags" ? "/" : simplifySlug(req.key.slice("tags/".length));
    // A tags/<tag>.md page (Quartz: the tag page's description) is its article.
    const r = await deps.rowAt(tag === "/" ? "tags/index" : `tags/${tag}`);
    if (!r.ok) return { unreachable: r.state };
    return { tag, indexRow: r.row };
  },
  template: tagTemplate,
};
