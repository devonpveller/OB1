// rw-p1a-render acceptance 10: a NEW page class registered by adding one
// entry file (bind-mounted into lib/page-classes/ by the test; never baked
// into the image). Its own template marks its output.
import { rowBacked, contentTemplate } from "../page-templates.mjs";

export default {
  name: "glossary",
  version: 1,
  priority: 55,
  resolve: rowBacked((row) => row.page_class === "glossary"),
  async template(ctx, deps) {
    const model = await contentTemplate(ctx, deps);
    return { ...model, articleHtml: `<p data-glossary-template="1">Glossary entry</p>${model.articleHtml}` };
  },
};
