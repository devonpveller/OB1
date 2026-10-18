// Page class "notebook-hub": one notebook's hub (content/notebooks/<s>/<s>),
// compiled by recipes/wiki-synthesis/scripts/synthesize-notebooks.mjs. Its row
// carries page_class "note" (the compile rule for content/notebooks/), so it
// is told apart by its slug shape and resolved before "note".
import { rowBacked, contentTemplate } from "../page-templates.mjs";

const HUB = /^content\/notebooks\/([^/]+)\/\1$/;

export default {
  name: "notebook-hub",
  version: 1,
  priority: 60,
  resolve: rowBacked((row) => HUB.test(row.slug)),
  template: contentTemplate,
};
