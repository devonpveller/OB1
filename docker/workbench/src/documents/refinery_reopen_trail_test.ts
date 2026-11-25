// deno test -A src/documents/refinery_reopen_trail_test.ts - rw-idea-reopen-trail: the refinery open (reopenRefinery) writes ONE
// 'reopened' trail line, for the owner and by the caller, with the idea id as its subject and no text - only when it really
// reopened an archived refinery. Over a fake database that records writes (the real one is ideas_integration_test.ts [RT*]).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

const vault = await Deno.makeTempDir({ prefix: "refinery-trail-vault-" });
Deno.env.set("WIKI_GIT_DIR", vault);
const { reopenRefinery } = await import("./refinery.ts");

const IDEA = "a1000000-0000-4000-8000-0000000000a1";
const who = { sub: "operator", actor: "operator", name: "Op", key: "operator" } as Identity;
const PATH = "documents/operator/ideas/x.md";

function fake(archivedAt: string | null, owner = "operator") {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/FROM public\.user_document_listings WHERE path/.test(sql)) {
        return Promise.resolve([{ id: "d1", path: PATH, title: "T", updated_at: new Date(), refinery_id: IDEA, owner_sub: owner }] as never);
      }
      if (/FROM public\.ideas i LEFT JOIN public\.refinery_state/.test(sql)) {
        return Promise.resolve([{ id: IDEA, status: archivedAt ? "archived" : "engaged", archived_at: archivedAt, archived_from: archivedAt ? "dirty" : null }] as never);
      }
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}
const deps = (db: Db) => ({ db, reg: {} as never, embed: () => Promise.resolve([]), chunk: (t: string) => [t], refetch: null, research: null });
const trail = (seen: { sql: string; args: unknown[] }[]) => seen.filter((s) => /INSERT INTO public\.user_document_trail/.test(s.sql));

Deno.test("rw-idea-reopen-trail: opening an archived refinery writes one reopened line (owner, actor, idea id)", async () => {
  const { db, seen } = fake("2026-11-01T00:00:00Z");
  const out = await reopenRefinery(deps(db), PATH, who);
  assertEquals(out.reopened, true);
  const w = trail(seen);
  assertEquals(w.length, 1);
  assertEquals(w[0].args, ["operator", "operator", IDEA]);
  assert(/'reopened'/.test(w[0].sql));
  assert(seen.indexOf(w[0]) > seen.findIndex((s) => /UPDATE public\.ideas SET status/.test(s.sql)));
});

Deno.test("rw-idea-reopen-trail: opening a refinery that was not archived writes no line (nothing reopened)", async () => {
  const { db, seen } = fake(null);
  assertEquals((await reopenRefinery(deps(db), PATH, who)).reopened, false);
  assertEquals(trail(seen).length, 0);
});

Deno.test("rw-idea-reopen-trail: another user's document is refused (404) and writes no line", async () => {
  const { db, seen } = fake("2026-11-01T00:00:00Z", "someone-else");
  let status = 0;
  try { await reopenRefinery(deps(db), PATH, who); } catch (e) { status = (e as { status?: number }).status ?? -1; }
  assertEquals(status, 404);
  assertEquals(trail(seen).length, 0);
});
