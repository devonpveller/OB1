// Page class "entity": an entity wiki page (content/<entity_type>/<slug>),
// compiled by recipes/entity-wiki/generate-wiki.mjs. Presented from its row.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "entity",
  version: 1,
  priority: 54,
  resolve: rowBacked((row) => row.page_class === "entity"),
  template: contentTemplate,
};
