// deno test src/contracts/private_report_claims_dossier_test.ts - rw-private-report-claims round 2 (tester F2): the idea
// dossier reads the owner's private-report claims on their own, and fails closed (none, no 500) when slot 570's read is
// absent (42883: not applied / reverted) or refused (42501); any other error is still the dossier's.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { Db } from "./db.ts";
import { ownPrivateReportClaims } from "./repo/ideas.ts";

function fakeDb(fail: string | null): { db: Db; log: string[] } {
  const log: string[] = [];
  const db: Db = {
    query: <T>(sql: string): Promise<T[]> => {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("private_report_claims_of_idea")) {
        if (fail) return Promise.reject(Object.assign(new Error("db"), { fields: { code: fail } }));
        return Promise.resolve([{ id: "c1", text: "a claim", confidence: 0 }] as unknown as T[]);
      }
      return Promise.resolve([]);
    },
    tx: (fn) => fn(db),
  };
  return { db, log };
}

Deno.test("the owner's private-report claims: read in a savepoint, returned", async () => {
  const { db, log } = fakeDb(null);
  assertEquals((await ownPrivateReportClaims(db, "00000000-0000-0000-0000-000000000001", "sub-b")).map((c) => c.id), ["c1"]);
  assertEquals(log[0], "SAVEPOINT prc_own");
  assertEquals(log.at(-1), "RELEASE SAVEPOINT prc_own");
});

for (const code of ["42883", "42501"]) {
  Deno.test(`the owner's private-report claims: ${code} (slot 570 absent / refused) -> none, the savepoint rolled back, no throw`, async () => {
    const { db, log } = fakeDb(code);
    assertEquals(await ownPrivateReportClaims(db, "00000000-0000-0000-0000-000000000001", "sub-b"), []);
    assertEquals(log.at(-1), "ROLLBACK TO SAVEPOINT");
  });
}

Deno.test("the owner's private-report claims: any other error is the dossier's", async () => {
  const { db } = fakeDb("57014");
  await assertRejects(() => ownPrivateReportClaims(db, "00000000-0000-0000-0000-000000000001", "sub-b"));
});
