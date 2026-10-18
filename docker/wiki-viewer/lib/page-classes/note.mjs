// Page class "note": the LEGACY Quartz note class (notes/..., and the AI notes
// inside a notebook folder). Never a user document (D12: user documents are
// P2b's and never a wiki page). The row is written by the workbench at save.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "note",
  version: 1,
  priority: 50,
  resolve: rowBacked((row) => row.page_class === "note"),
  template: contentTemplate,
};
