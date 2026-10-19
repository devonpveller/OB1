// Page class "thought": a thought leaf (content/thought/<id>), compiled by
// generate-wiki's leaf emitter for every thought an entity page cites.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "thought",
  version: 1,
  priority: 50,
  resolve: rowBacked((row) => row.page_class === "thought"),
  template: contentTemplate,
};
