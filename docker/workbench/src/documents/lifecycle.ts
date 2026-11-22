// The document lifecycle's last steps (rwr-docs-lifecycle-api): unarchive, delete forever, empty trash.
// Every operation takes the identity the seam resolved. Another user's document answers exactly like a
// document that does not exist (404, "no such document"); an admin (a real sign-in, not an
// impersonation) may delete forever another user's TRASHED document and nothing else here.
import type { Identity } from "../middleware/identity.ts";
import { DocError, documentFiles, moveTo, owned, ownedPath, ownerOfDirectory, removeTrashed, type DocDeps } from "./repo.ts";
import { listingRow } from "./listing.ts";
import { DOCUMENTS_ROOT, docRel, isArchived, isTrashed, liveRel, rootOf } from "./paths.ts";
import { vaultExists } from "../util/vault.ts";
import { audit } from "../identity/store.ts";

// Archive's way back: the document returns to its folder (its path without the .archive part), its
// listing row, references and history come with it (a git mv, the same move restore makes).
export async function unarchiveDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (!isArchived(from)) throw new DocError("not in the archive", 400);
  return { unarchived: await moveTo(deps, from, liveRel(from), `documents: unarchive ${from}`, who) };
}

// One trashed document, gone for good. Owner or admin; refused for a document that is not in the trash
// (nothing is removed); a document of someone else's, for a caller who is not an admin, is a 404. The
// removal runs under the path's lock and writes its trail line only after the file is really gone, so two
// callers racing on one document get one removal and one 404 (rwr-docs-lifecycle-api round 2).
export async function deleteForever(deps: DocDeps, path: string, who: Identity) {
  const rel = docRel(path, who);
  let owner = who.sub;
  const foreign = !rel.startsWith(`${rootOf(who)}/`) && !(await listingOwnedBy(deps, rel, who));
  if (foreign) {
    // only a real admin sign-in (not an impersonation, which acts AS the user) reaches another user's trash
    if (!who.admin || who.impersonating) throw new DocError("no such document", 404);
    if (!(await vaultExists(rel))) throw new DocError("no such document", 404);
    // whose it is: the listing row's owner, else the user whose directory key it sits under (the same
    // resolution the nightly makes) - the audit subject and the owner's trail line both name that user (R2)
    owner = (await listingRow(deps.db, rel))?.owner_sub ?? (await ownerOfDirectory(deps.db, rel));
    if (!isTrashed(rel)) throw new DocError("only a document in the trash can be deleted forever; trash it first", 400);
    // recorded BEFORE it runs, as every admin act on someone else's data is (admin_audit): a request that
    // cannot be recorded does not run
    await audit(deps.db, {
      actor_sub: who.actor, subject_sub: owner, action: "request", method: "POST",
      route: "/workbench/documents/delete-forever", reason: "admin delete forever of another user's trashed document",
    });
  } else {
    await owned(deps.db, rel, who);
    if (!(await vaultExists(rel))) throw new DocError("no such document", 404);
  }
  if (!isTrashed(rel)) throw new DocError("only a document in the trash can be deleted forever; trash it first", 400);
  const r = await removeTrashed(deps, rel, "delete_forever", { actor: who.actor, author: who.name, owner });
  if (!r.removed) throw new DocError("no such document", 404); // someone removed or restored it a moment ago
  return { removed: true, trail: r.trail };
}

async function listingOwnedBy(deps: DocDeps, rel: string, who: Identity): Promise<boolean> {
  return (await listingRow(deps.db, rel))?.owner_sub === who.sub;
}

// Is this trashed file the caller's: it sits in their own directory and no listing row names someone
// else, or it is a legacy (pre-P2b) file whose listing row names them - the same test delete forever applies.
async function isMine(deps: DocDeps, f: string, who: Identity): Promise<boolean> {
  const row = await listingRow(deps.db, f);
  if (f.startsWith(`${rootOf(who)}/`)) return !row || row.owner_sub === who.sub;
  return row?.owner_sub === who.sub;
}

// The caller's own trash, emptied now - whatever the age of what is in it. Never another user's.
export async function emptyOwnTrash(deps: DocDeps, who: Identity) {
  const mine: string[] = [];
  for (const f of (await documentFiles(DOCUMENTS_ROOT)).filter(isTrashed)) if (await isMine(deps, f, who)) mine.push(f);
  let removed = 0;
  const failed: string[] = [];
  for (const f of mine) {
    try {
      // a file restored or removed since the walk is "gone": not counted, no trail line
      if ((await removeTrashed(deps, f, "empty_trash", { actor: who.actor, author: who.name, owner: who.sub })).removed) removed++;
    } catch (e) {
      console.error(`[documents] empty trash: ${f} failed:`, (e as Error).message);
      failed.push(f);
    }
  }
  return { removed, failed: failed.length };
}
