// rw-p8a1-core round 3 (reviewer RF1): an admin's read of the trail can carry another user's (or an ownerless
// tree's) leads, so it is one of the job reads the seam audits.
import { assert } from "jsr:@std/assert@1";
import { JOB_READS } from "../middleware/identity.ts";

Deno.test("JOB_READS: the trail is an audited job read, beside sessions, jobs and timeline", () => {
  for (const p of ["/workbench/contract/trail", "/workbench/contract/sessions/x", "/workbench/contract/jobs", "/workbench/contract/timeline"]) {
    assert(JOB_READS.test(p), p);
  }
  assert(!JOB_READS.test("/workbench/contract/trailer"), "a prefix is not a match");
});
