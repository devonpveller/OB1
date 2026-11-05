/**
 * Whose digest this is (rw-boundary-digest, plan 09 PD0c) - THE ONE PLACE the run's owner comes from.
 *
 * The daily digest is one mailbox's: until rw-inlet-stamp (PD2) stamps the owner on the inlet records and per-user
 * digests (PD4) run one digest per user, that owner is the workspace's default subject, WORKSPACE_DEFAULT_SUB
 * (compose passes it to openbrain-podcast as PODCAST_OWNER_SUB; blank there = the workbench's single-user default,
 * "operator"). It owns the private hand-back of every research request the digest makes (POST /research/derived) and
 * the daily episode (podcast_episodes.owner_sub, its transcript). PD2/PD4 replace THIS function; nothing else in the
 * digest names the owner.
 */
export function digestOwnerSub(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  for (const k of ["PODCAST_OWNER_SUB", "WORKSPACE_DEFAULT_SUB"]) {
    const v = (env(k) ?? "").trim();
    if (v) return v;
  }
  return "operator";
}
