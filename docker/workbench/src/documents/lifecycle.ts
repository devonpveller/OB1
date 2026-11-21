// The document lifecycle's last steps (rwr-docs-lifecycle-api): unarchive, delete forever, empty trash.
// Every operation takes the identity the seam resolved. Another user's document answers exactly like a
// document that does not exist (404, "no such document"); an admin (a real sign-in, not an
// impersonation) may delete forever another user's TRASHED document and nothing else here.
import type { Identity } from "../middleware/identity.ts";
import { DocError, documentFiles, moveTo, owned, ownedPath, removeTrashed, type DocDeps } from "./repo.ts";
import { listingRow } from "./listing.ts";
import { DOCUMENTS_ROOT, docRel, isArchived, isTrashed, liveRel, rootOf } from "./paths.ts";
import { vaultExists } from "../util/vault.ts";

// Archive's way back: the document returns to its folder (its path without the .archive part), its
// listing row, references and history come with it (a git mv, the same move restore makes).
export async function unarchiveDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (!isArchived(from)) throw new DocError("not in the archive", 400);
  return { unarchived: await moveTo(deps, from, liveRel(from), `documents: unarchive ${from}`, who) };
}

// One trashed document, gone for good. Owner or admin; refused for a document that is not in the trash
// (nothing is removed); a document of someone else's, for a caller who is not an admin, is a 404.
export async function deleteForever(deps: DocDeps, path: string, who: Identity) {
  const rel = docRel(path, who);
  let owner = who.sub;
  const foreign = !rel.startsWith(`${rootOf(who)}/`) && !(await listingOwnedBy(deps, rel, who));
  if (foreign) {
    // only a real admin sign-in (not an impersonation, which acts AS the user) reaches another user's trash
    if (!who.admin || who.impersonating) throw new DocError("no such document", 404);
    if (!(await vaultExists(rel))) throw new DocError("no such document", 404);
    owner = (await listingRow(deps.db, rel))?.owner_sub ?? "system:unowned";
  } else {
    await owned(deps.db, rel, who);
    if (!(await vaultExists(rel))) throw new DocError("no such document", 404);
  }
  if (!isTrashed(rel)) throw new DocError("only a document in the trash can be deleted forever; trash it first", 400);
  const { trail } = await removeTrashed(deps, rel, "delete_forever", { actor: who.actor, author: who.name, owner });
  return { removed: true, trail };
}

async function listingOwnedBy(deps: DocDeps, rel: string, who: Identity): Promise<boolean> {
  return (await listingRow(deps.db, rel))?.owner_sub === who.sub;
}

// The caller's own trash, emptied now - whatever the age of what is in it. Never another user's.
export async function emptyOwnTrash(deps: DocDeps, who: Identity) {
  const mine: string[] = [];
  for (const f of (await documentFiles(DOCUMENTS_ROOT)).filter(isTrashed)) {
    if (f.startsWith(`${rootOf(who)}/`) || (await listingOwnedBy(deps, f, who))) mine.push(f);
  }
  let removed = 0;
  const failed: string[] = [];
  for (const f of mine) {
    try {
      await removeTrashed(deps, f, "empty_trash", { actor: who.actor, author: who.name, owner: who.sub });
      removed++;
    } catch (e) {
      console.error(`[documents] empty trash: ${f} failed:`, (e as Error).message);
      failed.push(f);
    }
  }
  return { removed, failed: failed.length };
}
