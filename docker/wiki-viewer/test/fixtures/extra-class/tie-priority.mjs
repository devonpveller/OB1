// rw-p1a-render attempt 2 (tester A7): an entry whose priority TIES a
// built-in's (entity@54). A tie would be decided by spelling: loading fails.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "tied",
  version: 1,
  priority: 54,
  resolve: rowBacked((row) => row.page_class === "tied"),
  template: contentTemplate,
};
