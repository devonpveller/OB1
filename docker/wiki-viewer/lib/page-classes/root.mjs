// Page class "root": vault-root and content-root pages (index = the home page,
// content/entities, ...), compiled by the wiki-service and generate-wiki.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "root",
  version: 1,
  priority: 50,
  resolve: rowBacked((row) => row.page_class === "root"),
  template: contentTemplate,
};
