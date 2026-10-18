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
    // A page declares this slug as its alias: Quartz writes its AliasRedirects
    // page here, so the alias class serves that redirect (rw-p1a-render
    // attempt 4, tester AT3-3: built = the redirect, live was the retired page).
    if (deps.site?.aliases?.has(req.key)) return null;
    return { key: req.key, reason: `${p}* is a retired page class` };
  },
  template: retiredTemplate,
};
