// Page class "source": a source leaf (content/source/<uuid>), compiled by
// recipes/_shared/source-leaf.mjs (entity-wiki + notebook synthesis).
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "source",
  version: 1,
  priority: 51,
  resolve: rowBacked((row) => row.page_class === "source"),
  template: contentTemplate,
};
