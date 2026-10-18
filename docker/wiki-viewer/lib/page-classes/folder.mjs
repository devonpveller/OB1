// Page class "folder": a folder index (Quartz FolderPage) generated from the
// rows under the folder, with the folder's own index row as its article when
// one exists. Lowest-priority URL claim, so a real page at the same slug wins.
import { folderTemplate, indexRowPending } from "../page-templates.mjs";
import { isFolder } from "../site-index.mjs";

export default {
  name: "folder",
  version: 1,
  priority: 40,
  async resolve(req, deps) {
    const folder = req.key.replace(/(^|\/)index$/, "");
    if (!deps.site) return deps.siteUnavailable();
    if (!isFolder(deps.site, folder) && !(req.isDir && deps.site.folders.has(folder))) return null;
    const r = await deps.rowAt(folder ? `${folder}/index` : "index");
    if (!r.ok) return { unreachable: r.state };
    const pending = await indexRowPending(r.row, deps);
    return pending ? { pending, row: r.row } : { folder, indexRow: r.row };
  },
  template: folderTemplate,
};
