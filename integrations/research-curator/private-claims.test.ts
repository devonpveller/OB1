// deno test private-claims.test.ts - rw-private-report-claims-fix round 2: the curator never names / describes a shared
// thread from a report that restates a private-report claim (the database decides; fail closed).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { restatesPrivateClaim, threadTextFor } from "./private-claims.ts";

const SECRET = "The kappa result held for forty participants";
const db = (fail?: string) => async (_sql: string, args: unknown[]) => {
  if (fail) throw Object.assign(new Error("x"), { fields: { code: fail } });
  return [{ shows: String(args[0]).includes(SECRET) }];
};

Deno.test("a report restating a private claim mints a thread with no description; the name stays unless it carries it", async () => {
  assertEquals(await threadTextFor(db(), "Solar roofs", "A thread about solar roofs", `Findings. ${SECRET}.`), { name: "Solar roofs", description: "" });
  assertEquals(await threadTextFor(db(), `On ${SECRET}`, "x", "y"), { name: "Research thread", description: "" });
  assertEquals(await threadTextFor(db(), "Solar roofs", "A thread about solar roofs", "Nothing private."), { name: "Solar roofs", description: "A thread about solar roofs" });
});
Deno.test("fail closed: an error counts as restating, except 42883 (slot 570 absent)", async () => {
  assertEquals(await restatesPrivateClaim(db("42501"), "anything"), true);
  assertEquals(await restatesPrivateClaim(db("08006"), "anything"), true);
  assertEquals(await restatesPrivateClaim(db("42883"), "anything"), false);
  assertEquals(await restatesPrivateClaim(db(), ""), false);
});
