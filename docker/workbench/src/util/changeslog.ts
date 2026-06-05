// Changes log (G11 / X.6). Staged mutations (retract, grounding) commit
// autonomously; the safety is VISIBILITY of effects, not a confirm gate. This
// writes a human-readable, durable record of each staged action into the
// author-owned `notes/` layer (outside the generation pool), so the user can
// understand an effect after the fact and reverse it before the compile commits.
import { vaultCommit, vaultExists, vaultRead, vaultWrite } from "./vault.ts";

export async function logChange(entry: {
  action: string;
  detail: string;
  affected?: string;
}): Promise<void> {
  // Best-effort by design (G11): the Changes log is a visibility aid, NOT
  // load-bearing for the DB mutation. A vault write/commit failure (e.g. volume
  // perms) must never break the retract/grounding that triggered it — log it
  // and move on.
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const rel = `notes/Changes/${date}.md`;
    let body: string;
    if (await vaultExists(rel)) {
      body = await vaultRead(rel);
    } else {
      body = `---\ntitle: "Changes — ${date}"\ntags: [changes, log]\n---\n\n# Changes — ${date}\n\n` +
        "_Staged-mutation log (retract / grounding). Reverse a stage before the next compile to undo it._\n\n";
    }
    body += `- **${now.toISOString()}** — ${entry.action}: ${entry.detail}` +
      (entry.affected ? ` _(affects: ${entry.affected})_` : "") + "\n";
    await vaultWrite(rel, body);
    await vaultCommit(`changes-log: ${entry.action}`).catch(() => {});
  } catch (e) {
    console.error("[workbench] changes-log write failed (non-fatal):", (e as Error).message);
  }
}
