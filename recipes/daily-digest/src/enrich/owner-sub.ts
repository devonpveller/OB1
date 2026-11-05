/**
 * Whose digest this is (rw-boundary-digest, plan 09 PD0c) - THE ONE PLACE the run's owner comes from.
 *
 * The daily digest is one mailbox's: until rw-inlet-stamp (PD2) stamps the owner on the inlet records and per-user
 * digests (PD4) run one digest per user, that owner is the workspace's default subject, WORKSPACE_DEFAULT_SUB
 * (compose passes it to openbrain-podcast as PODCAST_OWNER_SUB; blank there = the workbench's single-user default,
 * "operator"). It owns the private hand-back of every research request the digest makes (POST /research/derived) and
 * the daily episode (podcast_episodes.owner_sub, its transcript), and (round 2, F6) the email sender's settings
 * reads (src/app.ts: openbrain-digest passes DIGEST_OWNER_SUB) and the Open Notebook capture (on-capture.ts). PD2/PD4
 * replace THIS function; nothing else in the recipe names the owner or carries the "operator" fallback.
 */
export function digestOwnerSub(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  // each container sets ONE of these (compose: all = WORKSPACE_DEFAULT_SUB): openbrain-digest DIGEST_OWNER_SUB,
  // openbrain-podcast PODCAST_OWNER_SUB, the capture WORKSPACE_DEFAULT_SUB
  for (const k of ["DIGEST_OWNER_SUB", "PODCAST_OWNER_SUB", "WORKSPACE_DEFAULT_SUB"]) {
    const v = (env(k) ?? "").trim();
    if (v) return v;
  }
  return "operator";
}
