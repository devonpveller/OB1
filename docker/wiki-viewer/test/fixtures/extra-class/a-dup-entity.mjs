// rw-p1a-render attempt 2 (tester A7): an entry file that REUSES a built-in's
// name. Loading must fail loud (the viewer does not start); it must never
// silently replace the built-in entity class.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "entity",
  version: 2,
  priority: 57,
  resolve: rowBacked((row) => row.page_class === "entity"),
  async template(ctx, deps) {
    const model = await contentTemplate(ctx, deps);
    return { ...model, articleHtml: `<p data-dup-entity="1"></p>${model.articleHtml}` };
  },
};
