// Page class "retired": a slug in a page class that was removed on purpose
// (content/topic/* folded into notebook hubs, P2.3). Older bodies still link
// there; the reader gets an explanation and the pages that still link, never
// a pending page (nothing will ever compile it) and never a bare 404.
// WIKI_RETIRED_PREFIXES (comma-separated) extends the list.
import { retiredTemplate } from "../page-templates.mjs";

const prefixes = () => ["content/topic/", ...String(process.env.WIKI_RETIRED_PREFIXES || "")
  .split(",").map((s) => s.trim()).filter(Boolean)];

export default {
  name: "retired",
  version: 1,
  priority: 90,
  async resolve(req, deps) {
    const p = prefixes().find((x) => req.key.startsWith(x));
    if (!p) return null;
    const r = await deps.row();
    if (!r.ok) return deps.unavailable(r);
    if (r.row) return null; // a row exists after all: present it as what it is
    return { key: req.key, reason: `${p}* is a retired page class` };
  },
  template: retiredTemplate,
};
