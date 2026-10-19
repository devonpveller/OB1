// Page class "notebooks-index": the notebooks MOC (content/notebooks/index,
// written by synthesize-notebooks), presented as Quartz presents a folder
// index that has content: the index row as the article over the folder
// listing. Resolved before the generic folder listing.
import { folderTemplate, indexRowPending } from "../page-templates.mjs";

const FOLDER = "content/notebooks";

export default {
  name: "notebooks-index",
  version: 1,
  priority: 80,
  async resolve(req, deps) {
    if (req.key !== FOLDER && req.key !== `${FOLDER}/index`) return null;
    const r = await deps.rowAt(`${FOLDER}/index`);
    if (!r.ok) return deps.unavailable(r);
    if (!r.row) return null; // no index row yet: the generic folder listing (or pending) answers
    const pending = await indexRowPending(r.row, deps);
    return pending ? { pending, row: r.row } : { folder: FOLDER, indexRow: r.row };
  },
  template: folderTemplate,
};
