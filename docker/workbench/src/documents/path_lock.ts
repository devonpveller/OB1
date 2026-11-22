// A per-path lock for the irreversible document operations (rwr-docs-lifecycle-api round 2, F1/F2): the
// workbench is one process, so removals of the SAME vault path (delete forever, empty trash, the nightly)
// and the moves that take a document out of that path (restore, unarchive, trash, archive, move) are run
// one after another. Whoever runs second looks at the file again under the lock, so a document that was
// removed or restored a moment ago is seen as gone / alive, never half of both.
// git takes one lock on the vault's index: the git step of every removal and move runs through this one key, so
// two different documents never fight over it (taken INSIDE a path's lock, never the other way round)
export const VAULT_GIT = "\u0000vault-git";

const tails = new Map<string, Promise<unknown>>();

export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(path, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(path) === tail) tails.delete(path);
  }
}
