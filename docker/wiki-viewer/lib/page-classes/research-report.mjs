// Page class "research-report": a source leaf whose source is a research
// synthesis (content_type research_synthesis) - the readable report with its
// collapsed evidence callout. Same row class as "source" (page_class
// "source"), resolved first because it is the narrower match.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "research-report",
  version: 1,
  priority: 60,
  resolve: rowBacked((row) => row.page_class === "source" && row.frontmatter?.content_type === "research_synthesis"),
  template: contentTemplate,
};
