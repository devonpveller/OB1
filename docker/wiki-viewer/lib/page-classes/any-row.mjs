// Page class "row": the last resort for a row whose page_class no other entry
// claims (a class compiled before its viewer entry landed). The row is what
// is presented (D13), so it is presented as a content page rather than
// dropped to pending. Priority 0: every specific entry resolves first.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "row",
  version: 1,
  priority: 0,
  resolve: rowBacked(() => true),
  template: contentTemplate,
};
