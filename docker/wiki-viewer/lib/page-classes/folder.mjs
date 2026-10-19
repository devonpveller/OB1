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
    let r = await deps.rowAt(folder ? `${folder}/index` : "index");
    if (!r.ok) return deps.unavailable(r);
    // Quartz FolderPage: a page named like the folder ("up.md" beside "up/")
    // is the folder page's content when the folder has no index page (its
    // computeFolderInfo maps every page whose simple slug is the folder;
    // index.md sorts after up.md, so index.md wins when both exist).
    if (!r.row && folder) {
      const own = await deps.rowAt(folder);
      if (!own.ok) return deps.unavailable(own);
      if (own.row) r = own;
    }
    const pending = await indexRowPending(r.row, deps);
    return pending ? { pending, row: r.row } : { folder, indexRow: r.row };
  },
  template: folderTemplate,
};
