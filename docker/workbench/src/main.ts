// openbrain-workbench - the process: the app (src/app.ts) plus the vault repo, the nightly
// empty-trash, the start-up reconcile and the server.
import { app, docDeps, seam } from "./app.ts";
import { config } from "./config.ts";
import { emptyDocumentsTrash, reconcileOnStart } from "./routes/documents.ts";
import { ensureVaultRepo } from "./util/vault.ts";
import { emptyTrash } from "./repositories/notes.ts";

// Make sure we can commit notes / the Changes log into the vault (best-effort).
await ensureVaultRepo();

// Nightly: empty the notes trash (hard-remove `trashed: true` notes) just before
// the viewer's daily clean rebuild, so they're gone for good ahead of the 1am
// compile. Local time; defaults to 23:55. Reschedules itself each run.
function scheduleEmptyTrash(): void {
  const hh = Math.min(23, Math.max(0, parseInt(Deno.env.get("WB_EMPTY_TRASH_HOUR") ?? "23", 10)));
  const mm = Math.min(59, Math.max(0, parseInt(Deno.env.get("WB_EMPTY_TRASH_MIN") ?? "55", 10)));
  const arm = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      try {
        const { removed } = await emptyTrash("nightly-cleanup");
        if (removed.length) console.log(`[workbench] nightly empty-trash removed ${removed.length} note(s)`);
        const docs = await emptyDocumentsTrash(docDeps);
        if (docs.removed.length) console.log(`[workbench] nightly empty-trash removed ${docs.removed.length} user document(s)`);
      } catch (e) {
        console.error("[workbench] nightly empty-trash failed:", (e as Error).message);
      }
      arm();
    }, next.getTime() - now.getTime());
  };
  arm();
}
scheduleEmptyTrash();
// D12 truth and repair: the documents listing is rebuilt from the documents tree where it drifted.
reconcileOnStart(docDeps);

Deno.serve({ port: config.port }, app.fetch);
console.log(`[workbench] listening on :${config.port} (auth=${config.workbenchKey ? "on" : "OPEN — set WORKBENCH_KEY"}, ` +
  `sign-in=${seam.oidc ? `oidc ${new URL(seam.oidc.issuer).host}` : seam.cfg.header ? "identity header" : "off (one default identity)"})`);
